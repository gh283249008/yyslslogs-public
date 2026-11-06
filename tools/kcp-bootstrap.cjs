'use strict';
// One passive capture stays open across state alignment and pipeline handoff.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline'),{spawn}=require('node:child_process');
const {parseRow,assemble}=require('../modules/acquisition/kcp-stream.cjs');
const {captureFilter,packetMatches}=require('../modules/acquisition/connection-candidates.cjs');
const {udpCaptureArgs}=require('../modules/acquisition/capture-profile.cjs');
const {setWorkerPriority}=require('./p1-process-priority.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const route=p=>JSON.stringify([p.src,p.sport,p.dst,p.dport,p.envelope,p.segments[0].conversation]);
async function bootstrapKcp({m,recovery,candidate,boot,python,tshark,node,run,profile,approved,data,closing,readStateInput,startCapture=spawn}){
 const dir=path.join(boot,'kcp');fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'module.json'),JSON.stringify(m));
 const filter=captureFilter(candidate),log=path.join(dir,'capture.private.tsv');
 const evidence=fs.openSync(log,'a');let evidenceOpen=true,buffer=[],bytes=0,failed=null,stopped=false,target=null,selected=null;
 const capture=startCapture(tshark,udpCaptureArgs(candidate.interface,filter),{windowsHide:true,stdio:['ignore','pipe','pipe']});
 capture.once('spawn',()=>setWorkerPriority(capture.pid,'capture'));
 const lines=readline.createInterface({input:capture.stdout});
 const stop=()=>{if(stopped)return;stopped=true;capture.kill();capture.stdout.resume();if(evidenceOpen){fs.closeSync(evidence);evidenceOpen=false;}};
 const fail=e=>{failed=e;if(target?.connected)target.send({type:'kcp-capture-error',message:e.message},()=>{});stop();};
 capture.on('error',fail);
 capture.on('close',code=>{if(!stopped)fail(Error('KCP capture stopped: '+code));if(target&&!target.stdin.destroyed)target.stdin.end();});
 capture.stderr.on('data',b=>fs.appendFileSync(path.join(dir,'capture.stderr.txt'),b));
 lines.on('line',line=>{try{
  if(failed)return;
  const packet=parseRow(line,recovery.remoteEndpoint,candidate.envelope);if(!packetMatches(packet,candidate))throw Error('KCP capture escaped selected endpoint');
  if(target){if(!target.stdin.write(line+'\n'))capture.stdout.pause();return;}
  if(stopped)return;
  bytes+=Buffer.byteLength(line)+1;if(bytes>32*1024*1024)throw Error('KCP initialization buffer exceeds limit');
  fs.writeSync(evidence,line+'\n');buffer.push({line,packet});
 }catch(e){fail(e);}});
 const check=()=>{if(closing())throw Error('采集已停止');if(failed)throw failed;};
 const wait=async ms=>{for(let n=0;n<ms;n+=200){await new Promise(r=>setTimeout(r,200));check();}};
 try{
  await wait(6000);
  await run(python,['-B','-X','utf8',path.join(__dirname,'p2-read-state.py'),dir],{input:readStateInput});check();
  const state=JSON.parse(fs.readFileSync(path.join(dir,'rpc-state-recovery.json')));
  if(state.status!=='snapshot-ready'||state.clientBuildSha256!==profile.imageSha256||state.transportProtocol!=='KCP'||JSON.stringify(state.remoteEndpoint)!==JSON.stringify(recovery.remoteEndpoint))throw Error('初始化期间 KCP 连接改变');
  await wait(6000);
  const groups=new Map();for(const row of buffer){const key=route(row.packet);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row.packet);}
  const answers=[];let ordinal=0;
  for(const [key,packets] of groups){try{
   const stream=assemble(packets),stamp=Date.parse(state.snapshotAtUtc)/1000;
   const before=stream.rows.filter(r=>r.time<stamp-3),after=stream.rows.filter(r=>r.time<=stamp+3);if(stream.rows.length<3||!after.length)continue;
   const folder=path.join(dir,'candidate-'+ ++ordinal);fs.mkdirSync(folder);
   const cipherFile=path.join(folder,'cipher.private.bin');fs.writeFileSync(cipherFile,stream.cipher);
   const first=packets[0],flow={serverAddress:first.src,serverPort:first.sport,clientAddress:first.dst,clientPort:first.dport};
   const align={stateFile:state.stateObject,expectedVtable:state.expectedVtable,cipherFile,minCursor:before.at(-1)?.end||0,maxCursor:after.at(-1).end,maxPrefix:4096,python,outDir:path.join(folder,'aligned'),metadata:{pid:m.pid,flow,transport:'kcp',remoteEndpoint:state.remoteEndpoint,kcpConversation:stream.conversation,kcpFirstSequence:stream.firstSequence,gaps:0,overlapsVerified:true,captureStartTcpSequence:0}};
   const file=path.join(folder,'align.private.json');fs.writeFileSync(file,JSON.stringify(align));
   await run(node,[path.join(__dirname,'align-rc4-late-state.cjs'),file],{timeout:120000});check();
   const report=path.join(align.outDir,'report.json'),r=JSON.parse(fs.readFileSync(report));if(!r.unique||!r.roundTrip)continue;
   answers.push({key,config:{identityCacheFile:path.join(data,'identity-cache.json'),clientBuildSha256:profile.imageSha256,...(approved?{decoderEnvelope:approved.envelope}:{}),pid:m.pid,processStartUtc:m.processStartUtc,processPath:m.modulePath,transport:'kcp',flow,captureInterface:candidate.interface,python,tshark,serverEncryptedOrigin:0,bindingUdpEndpoint:candidate.endpoint,kcp:{conversation:stream.conversation,firstSequence:stream.firstSequence,envelope:first.envelope,remoteEndpoint:state.remoteEndpoint},initialStateFile:path.join(align.outDir,r.anchor.stateFile),initialStateSha256:r.anchor.stateSha256,cipherStateKind:'validated-midstream',cipherAnchorReport:report,cipherAnchorReportSha256:sha(fs.readFileSync(report)),gapTimeoutMs:3000,knownAcquisitionGaps:[{kind:'joined-existing-session',note:'Earlier combat is unavailable.'}]}});
  }catch(e){fs.appendFileSync(path.join(dir,'alignment-errors.log'),e.message+'\n');}}
  check();if(answers.length!==1)throw Error(answers.length?'KCP 有多个协议校验结果，未选择连接':'KCP 尚未得到唯一通过协议校验的状态，记录已保留');
  const answer=answers[0];selected=answer.key;
  return {config:answer.config,stop,attach(child){
   check();target=child;child.once('exit',stop);child.on('message',m=>{if(m?.type==='stop-kcp-capture')stop();});
   child.stdin.on('error',stop);child.stdin.on('drain',()=>capture.stdout.resume());
   const initial=buffer.filter(r=>route(r.packet)===selected).map(r=>r.line).join('\n')+'\n';buffer=[];bytes=0;
   if(evidenceOpen){fs.closeSync(evidence);evidenceOpen=false;}
   if(!child.stdin.write(initial))capture.stdout.pause();
  }};
 }catch(e){stop();throw e;}
}
module.exports={bootstrapKcp};
