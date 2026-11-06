'use strict';
const {isIP}=require('node:net');
const loopback=address=>isIP(address)===4&&address.startsWith('127.');
const validPort=port=>Number.isInteger(port)&&port>0&&port<=65535;
function endpoint(e){if(!e||isIP(e.address)!==4||!validPort(e.port))throw Error('Invalid game endpoint');return e;}
const sameFlow=(a,b)=>['clientAddress','clientPort','serverAddress','serverPort'].every(k=>a[k]===b[k]);
function candidates(m,readiness){
 const result=[];
 if(readiness.transportProtocol==='KCP'){
  const remote=endpoint(readiness.remoteEndpoint);
  for(const e of m.udpEndpoints||[]){
   endpoint({address:e.clientAddress,port:e.clientPort});
   for(const f of m.flows||[])if(loopback(f.serverAddress)&&loopback(f.clientAddress)&&(e.clientAddress==='0.0.0.0'||e.clientAddress===f.clientAddress)){
    endpoint({address:f.serverAddress,port:f.serverPort});
    result.push({transport:'kcp',interface:'\\Device\\NPF_Loopback',endpoint:e,remote,envelope:'uu-ipv4',relay:{address:f.serverAddress,port:f.serverPort,clientAddress:f.clientAddress}});
   }
   for(const r of m.udpRoutes||[])if(r.endpoint.clientAddress===e.clientAddress&&r.endpoint.clientPort===e.clientPort)
    result.push({transport:'kcp',interface:r.interface,endpoint:e,remote,envelope:'direct'});
  }
 }else{
  for(const flow of m.flows||[]){
   endpoint({address:flow.serverAddress,port:flow.serverPort});endpoint({address:flow.clientAddress,port:flow.clientPort});
   const devices=[...new Set((m.interfaceSelection||[]).filter(r=>sameFlow(r.flow,flow)).map(r=>r.interface))];
   if(devices.length===1)result.push({transport:'tcp',flow,interface:devices[0]});
  }
 }
 return [...new Map(result.map(c=>[JSON.stringify(c),c])).values()];
}
function captureFilter(c){
 if(c.transport==='tcp'){const f=c.flow;endpoint({address:f.serverAddress,port:f.serverPort});endpoint({address:f.clientAddress,port:f.clientPort});return `tcp and src host ${f.serverAddress} and src port ${f.serverPort} and dst host ${f.clientAddress} and dst port ${f.clientPort}`;}
 const r=endpoint(c.remote),e=endpoint({address:c.endpoint.clientAddress,port:c.endpoint.clientPort});
 if(c.envelope==='uu-ipv4'){
  const p=endpoint(c.relay);if(!loopback(p.address)||!loopback(c.relay.clientAddress))throw Error('Relay must be a game-owned loopback peer');
  const ip=Buffer.from(r.address.split('.').map(Number)).readUInt32BE().toString(16);
  return `udp and src host ${p.address} and src port ${p.port} and dst host ${c.relay.clientAddress} and dst port ${e.port} and udp[8:4] = 0 and udp[12:4] = 0x${ip} and udp[16:2] = ${r.port}`;
 }
 if(c.envelope!=='direct')throw Error('Unsupported UDP envelope');
 return `udp and src host ${r.address} and src port ${r.port} and dst port ${e.port}`+(e.address==='0.0.0.0'?'':` and dst host ${e.address}`);
}
function packetMatches(p,c){return p.iface===0&&p.envelope===c.envelope&&p.dport===c.endpoint.clientPort&&(c.endpoint.clientAddress==='0.0.0.0'||p.dst===c.endpoint.clientAddress)&&
 (c.envelope==='direct'?p.src===c.remote.address&&p.sport===c.remote.port:p.src===c.relay.address&&p.sport===c.relay.port&&p.dst===c.relay.clientAddress);}
function stillBound(m,c){return c.transport==='kcp'?(m.udpEndpoints||[]).some(e=>e.clientAddress===c.bindingUdpEndpoint.clientAddress&&e.clientPort===c.bindingUdpEndpoint.clientPort):(m.flows||[]).some(f=>sameFlow(f,c.flow));}
// Direct game routes retain priority. Loopback and newly admitted web ports
// are compatibility fallbacks, even if a previous session used one of them.
function candidateTier(c){
 if(c.transport==='kcp')return c.envelope==='direct'?0:2;
 return loopback(c.flow.serverAddress)?2:[80,443].includes(c.flow.serverPort)?1:0;
}
function candidateKey(c){return JSON.stringify([c.transport,c.interface.toLowerCase(),c.transport==='tcp'?[c.flow.clientAddress,c.flow.clientPort,c.flow.serverAddress,c.flow.serverPort]:[c.envelope,c.endpoint.clientAddress,c.endpoint.clientPort,c.remote.address,c.remote.port,c.relay?.address,c.relay?.port,c.relay?.clientAddress]]);}
function matchesHint(c,h,m,build){
 if(!h||h.pid!==m.pid||h.processStartUtc!==m.processStartUtc||h.clientBuildSha256!==build||h.processPath?.toLowerCase()!==m.modulePath?.toLowerCase()||h.captureInterface?.toLowerCase()!==c.interface.toLowerCase()||(h.transport||'tcp')!==c.transport)return false;
 if(c.transport==='tcp')return sameFlow(c.flow,h.flow||{});
 return h.bindingUdpEndpoint?.clientAddress===c.endpoint.clientAddress&&h.bindingUdpEndpoint?.clientPort===c.endpoint.clientPort&&h.kcp?.envelope===c.envelope&&h.kcp.remoteEndpoint?.address===c.remote.address&&h.kcp.remoteEndpoint?.port===c.remote.port&&(c.envelope!=='uu-ipv4'||h.flow?.serverAddress===c.relay.address&&h.flow?.serverPort===c.relay.port&&h.flow?.clientAddress===c.relay.clientAddress);
}
class CandidateSelector{
 constructor(){this.context=null;this.pending=[];this.seen=new Set();this.attempts=new Map();}
 next(list,context,preferred=null){
  if(context!==this.context){this.context=context;this.pending=[];this.seen.clear();this.attempts.clear();}
  const current=new Map(list.map(c=>[candidateKey(c),c]));
  this.pending=this.pending.filter(key=>current.has(key));
  for(const key of [...this.attempts.keys()])if(!current.has(key))this.attempts.delete(key);
  for(const key of [...this.seen])if(!current.has(key))this.seen.delete(key);
  const queued=new Set(this.pending);
  const additions=[...current.keys()].filter(k=>!queued.has(k)&&!this.seen.has(k)).sort();
  this.pending.push(...additions);
  if(!this.pending.length){this.seen.clear();this.pending=[...current.keys()].sort();}
  // Stable within each tier, independent of the OS enumeration order. A new
  // direct route takes precedence, but an already-tried route cannot starve
  // the remaining candidates in this round.
  this.pending.sort((a,b)=>candidateTier(current.get(a))-candidateTier(current.get(b))||(a===preferred?-1:b===preferred?1:0));
  const key=this.pending.shift();if(!key)return null;
  this.seen.add(key);const attempts=(this.attempts.get(key)||0)+1;this.attempts.set(key,attempts);
  return {candidate:current.get(key),attempts,preferred:key===preferred,tier:candidateTier(current.get(key))};
 }
}
module.exports={candidates,captureFilter,packetMatches,stillBound,candidateKey,candidateTier,matchesHint,CandidateSelector};
