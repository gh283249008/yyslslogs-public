'use strict';
// Offline only: stream the finished session, never turn on live TCP analysis.
const fs=require('fs'),path=require('path'),readline=require('readline'),crypto=require('crypto');
const {isLiveFieldCount}=require('./p1-capture-profile.cjs');
const bool=v=>v==='True'||v==='1';
const distance=(a,b)=>(a-b)|0;
function options(hex){
 const b=Buffer.from((hex||'').replaceAll(':',''),'hex'),r={sack:[]};
 for(let i=0;i<b.length;){const k=b[i];if(k===0)break;if(k===1){i++;continue;}const n=b[i+1];if(!n||n<2||i+n>b.length){r.malformed=true;break;}
  if(k===3&&n===3)r.windowScale=b[i+2];
  if(k===8&&n===10)r.timestamps={value:b.readUInt32BE(i+2),echo:b.readUInt32BE(i+6)};
  if(k===5&&n>=10&&(n-2)%8===0)for(let j=i+2;j<i+n;j+=8)r.sack.push([b.readUInt32BE(j),b.readUInt32BE(j+4)]);
  i+=n;
 }return r;
}
async function analyze(dir){
 const manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8')),flow=manifest.flow;
 if(manifest.transportFormat?.transport==='kcp')throw Error('This diagnostic analyzes TCP ACK/window evidence; KCP recordings require KCP sequence analysis');
 const state=()=>({packets:0,payloadPackets:0,bytes:0,ackProgress:0,overlapOrReordered:0,sackPackets:0,lastAck:null,lastWindow:null,zeroWindow:null,lastPayload:null,high:null});
 const sides={client:state(),server:state()},episodes=[],zeros=[],ackStalls=[],hash=crypto.createHash('sha256');let first=null,last=null,rows=0,extended=0,invalid=0,omitted=0;
 const keep=(array,row)=>{if(array.length<10000)array.push(row);else omitted++;};
 const input=fs.createReadStream(path.join(dir,'transport.private.tsv'));input.on('data',b=>hash.update(b));
 for await(const line of readline.createInterface({input,crlfDelay:Infinity})){
  if(!line.trim())continue;const a=line.split('\t');if(!isLiveFieldCount(a.length)){invalid++;continue;}
  const role=a[3]===flow.serverAddress&&+a[4]===flow.serverPort&&a[5]===flow.clientAddress&&+a[6]===flow.clientPort?'server':a[3]===flow.clientAddress&&+a[4]===flow.clientPort&&a[5]===flow.serverAddress&&+a[6]===flow.serverPort?'client':null;
  if(!role){invalid++;continue;}const t=+a[1]*1000,len=+a[8],seq=+a[7],s=sides[role],other=sides[role==='server'?'client':'server'];if(!Number.isFinite(t)){invalid++;continue;}
  first??=t;last=t;rows++;s.packets++;
  if(a.length===21){extended++;const ack=a[13]===''?null:+a[13],window=a[15]===''?null:+a[15],o=options(a[16]);if(o.sack.length)s.sackPackets++;
   if(bool(a[14])&&ack!==null){
    if(s.lastAck&&distance(ack,s.lastAck.value)>0){const duration=t-s.lastAck.at;
     if(duration>=1000&&s.lastAck.pendingObserved)keep(ackStalls,{receiver:role,start:new Date(s.lastAck.at).toISOString(),end:new Date(t).toISOString(),durationMs:duration,ackFrom:s.lastAck.value,ackTo:ack,duplicateAcks:s.lastAck.repeated,sackPackets:s.sackPackets-s.lastAck.sackStart,basis:'ACK progression paused while sender data beyond ACK was captured; delay/loss/receiver/capture ambiguity remains'});
     s.ackProgress++;s.lastAck={value:ack,at:t,repeated:0,sackStart:s.sackPackets,pendingObserved:other.high!==null&&distance(other.high,ack)>0};
    }else if(!s.lastAck)s.lastAck={value:ack,at:t,repeated:0,sackStart:s.sackPackets,pendingObserved:other.high!==null&&distance(other.high,ack)>0};
    else if(ack===s.lastAck.value){s.lastAck.repeated++;if(other.high!==null&&distance(other.high,ack)>0)s.lastAck.pendingObserved=true;}
   }
   if(window!==null){s.lastWindow=window;if(window===0&&!s.zeroWindow)s.zeroWindow={receiver:role,start:new Date(t).toISOString(),startMs:t};if(window>0&&s.zeroWindow){keep(zeros,{...s.zeroWindow,end:new Date(t).toISOString(),durationMs:t-s.zeroWindow.startMs,basis:'Observed zero advertised receive window; identifies the receiver endpoint, not the cause of its backpressure'});s.zeroWindow=null;}}
  }
  if(len>0){
   if(s.lastPayload&&t-s.lastPayload.at>=1000){const p=s.lastPayload;keep(episodes,{sender:role,start:new Date(p.at).toISOString(),end:new Date(t).toISOString(),durationMs:t-p.at,firstFrame:p.frame,resumeFrame:+a[0],sameDirectionControlPackets:s.packets-p.packets-1,oppositePayloadPackets:other.payloadPackets-p.otherPayloadPackets,oppositeAckProgress:other.ackProgress-p.otherAckProgress,receiverWindowAtStart:p.receiverWindow,receiverWindowAtResume:other.lastWindow,receiverZeroWindowAtStart:p.receiverZero,receiverAckAtResume:other.lastAck?.value??null,overlapOrReorderedDelta:s.overlapOrReordered-p.overlaps,classification:p.receiverZero?'receiver-advertised-zero-window-at-start':'payload-silence-location-unresolved'});}
   if(s.high!==null&&distance(seq,s.high)<0)s.overlapOrReordered++;
   const end=(seq+len)>>>0;if(s.high===null||distance(end,s.high)>0)s.high=end;
   if(other.lastAck&&distance(s.high,other.lastAck.value)>0){if(!other.lastAck.pendingObserved)other.lastAck.at=t;other.lastAck.pendingObserved=true;}
   s.payloadPackets++;s.bytes+=len;s.lastPayload={at:t,frame:+a[0],packets:s.packets,otherPayloadPackets:other.payloadPackets,otherAckProgress:other.ackProgress,receiverWindow:other.lastWindow,receiverZero:!!other.zeroWindow,overlaps:s.overlapOrReordered};
  }
 }
 for(const s of Object.values(sides))if(s.zeroWindow)keep(zeros,{...s.zeroWindow,end:null,durationMs:last-s.zeroWindow.startMs,openAtEnd:true});
 const optional=async name=>{const f=path.join(dir,name);if(!fs.existsSync(f))return {available:false,rows:[]};const r=[];for await(const l of readline.createInterface({input:fs.createReadStream(f),crlfDelay:Infinity})){try{if(l&&r.length<100000)r.push(JSON.parse(l));}catch{invalid++;}}return {available:true,rows:r};};
 const telemetry=await optional('network-health.jsonl'),markers=await optional('network-markers.jsonl');
 const evidence={schemaVersion:1,sessionId:manifest.sessionId,sourceFile:path.join(dir,'transport.private.tsv'),sha256:hash.digest('hex'),startedAt:first===null?null:new Date(first).toISOString(),endedAt:last===null?null:new Date(last).toISOString(),rows,extendedRows:extended,invalidRows:invalid,omittedEvents:omitted,counts:Object.fromEntries(Object.entries(sides).map(([role,s])=>[role,{packets:s.packets,payloadPackets:s.payloadPackets,bytes:s.bytes,overlapOrReordered:s.overlapOrReordered,sackPackets:s.sackPackets}])),payloadSilences:episodes,zeroWindows:zeros,ackProgressStalls:ackStalls,telemetry,markers,
  limits:['Capture timestamps are not game RTT or server event timestamps.','One capture point cannot distinguish the remote host from intervening network loss, nor fully exclude local capture loss.','Zero window identifies the advertising receiver; it does not prove which application or driver caused it.','Overlap/reordering is not a measured retransmission or packet loss rate.','Raw window is retained; nonzero scaled window is unknown without the handshake. All raw TCP options remain in the source TSV.','Missing OS/drop/telemetry evidence is unknown, never zero. System TCP counts include other applications.','Capture and schema child CPU are sampled; dumpcap/kernel driver CPU is not separately attributed.','Diagnosis does not infer game 999ms from silence; user markers are reports, not measured RTT.']};
 return evidence;
}
module.exports={analyze,options,distance};
if(require.main===module){const [dir,out]=process.argv.slice(2);if(!dir||!out)throw Error('Usage: analyze-network-diagnostics.cjs CAPTURE_DIR NEW_REPORT_JSON');if(fs.existsSync(path.join(dir,'collector.json'))&&!fs.existsSync(path.join(dir,'completion.json')))throw Error('Stop collection before offline analysis');analyze(path.resolve(dir)).then(r=>{fs.writeFileSync(out,JSON.stringify(r,null,2),{flag:'wx'});console.log(JSON.stringify({output:out,rows:r.rows,extendedRows:r.extendedRows,payloadSilences:r.payloadSilences.length,zeroWindows:r.zeroWindows.length,ackProgressStalls:r.ackProgressStalls.length}));}).catch(e=>{console.error(e.message);process.exitCode=1;});}
