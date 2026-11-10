'use strict';
// Keep the one passive capture alive from cipher alignment through decoding.
// The disk journal is the handoff queue; early roster/AOI packets are not lost.
const fs=require('node:fs'),{spawn}=require('node:child_process');
const {captureArgs}=require('./p1-capture-profile.cjs');
const {setWorkerPriority}=require('./p1-process-priority.cjs');
async function captureTcpHandoff({tshark,device,filter,log,snapshot,closing=()=>false,idleTimeoutMs=5000,snapshotDelayMs=6000,initializationMs=18000,startCapture=spawn}){
 if(typeof device!=='string'||!device.startsWith('\\Device\\NPF_'))throw Error('Exactly one Npcap interface is required');
 const fd=fs.openSync(log,'wx+');let fileOpen=true,bytes=0,offset=0,partial='',payloadPackets=0,payloadBytes=0,stderr='';
 let failure=null,captureClosed=false,stopRequested=false,target=null,targetGone=false,direct=false,waitingDrain=false,pumping=false,attached=false,cancellation=null,capture;
 try{capture=startCapture(tshark,captureArgs([device],filter),{windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(e){fs.closeSync(fd);throw e;}
 const closeFile=()=>{if(fileOpen){fs.closeSync(fd);fileOpen=false;}};
 const record=()=>fs.writeFileSync(log+'.capture.json',JSON.stringify({payloadPackets,payloadBytes,bytes,handedOff:attached,continuousCapture:true,reasonCode:failure?.code||null,stderr},null,2));
 const completed=new Promise(resolve=>capture.once('close',code=>{captureClosed=true;if(!stopRequested){failure??=Error(stderr||'TCP capture stopped before its owner requested stop: '+code);if(target?.connected)target.send({type:'tcp-capture-error',message:failure.message},()=>{});}if(target&&!targetGone)pump();else{closeFile();record();}resolve(code);}));
 const stop=()=>{if(stopRequested)return;stopRequested=true;clearInterval(cancellation);capture.kill();capture.stdout.resume();};
 const fail=error=>{failure??=error;if(target?.connected)target.send({type:'tcp-capture-error',message:error.message},()=>{});stop();};
 capture.once('spawn',()=>setWorkerPriority(capture.pid,'capture'));
 capture.on('error',fail);capture.stderr.on('data',b=>{stderr=(stderr+b).slice(-16384);});
 function pump(){
  if(!target||targetGone||pumping||waitingDrain||target.stdin.destroyed)return;
  pumping=true;
  try{
   const began=performance.now();
   while(!direct&&offset<bytes&&!waitingDrain&&performance.now()-began<8){
    const b=Buffer.alloc(Math.min(65536,bytes-offset)),n=fs.readSync(fd,b,0,b.length,offset);if(n<=0)throw Error('TCP handoff journal made no progress');offset+=n;
    if(!target.stdin.write(b.subarray(0,n)))waitingDrain=true;
   }
   if(!direct&&offset===bytes&&!waitingDrain){direct=true;closeFile();record();}
   if(captureClosed&&direct)target.stdin.end();
   else if(!direct&&!waitingDrain)setImmediate(pump);
  }catch(e){fail(e);}finally{pumping=false;}
 }
 capture.stdout.on('data',chunk=>{try{
  if(targetGone)return;
  if(direct){if(!target.stdin.write(chunk)){waitingDrain=true;capture.stdout.pause();}return;}
  let at=0;while(at<chunk.length){const n=fs.writeSync(fd,chunk,at,chunk.length-at);if(n<=0)throw Error('TCP initialization journal made no progress');at+=n;bytes+=n;}
  // Count payloads only for candidate readiness, never infer player identities here.
  if(!attached){partial+=chunk.toString('utf8');const rows=partial.split('\n');partial=rows.pop();if(partial.length>16*1024*1024)throw Error('TCP initialization packet line exceeds limit');
   for(const line of rows){const a=line.trimEnd().split('\t'),length=Number(a[8]),hex=a[12]||'';if(a.length===13&&Number.isSafeInteger(length)&&length>0&&hex.length===length*2&&/^[a-f0-9]+$/i.test(hex)){payloadPackets++;payloadBytes+=length;}}
  }
  pump();
 }catch(e){fail(e);}});
 const check=()=>{if(closing())throw Object.assign(Error('采集已停止'),{code:'capture-stopped'});if(failure)throw failure;if(captureClosed)throw Error('TCP initialization capture ended');};
 const started=Date.now();cancellation=setInterval(()=>{try{check();}catch(e){fail(e);}},200);
 const wait=async ms=>{const until=Date.now()+ms;while(Date.now()<until){await new Promise(r=>setTimeout(r,Math.min(100,until-Date.now())));check();}};
 const idle=setTimeout(()=>{if(!payloadBytes)fail(Object.assign(Error('当前候选连接没有收到有效数据，继续检查其他连接'),{code:'candidate-no-data'}));},idleTimeoutMs);
 try{
  await wait(snapshotDelayMs);await snapshot();check();await wait(Math.max(0,initializationMs-(Date.now()-started)));check();
  if(!payloadBytes)throw Object.assign(Error('当前候选连接没有收到有效数据，继续检查其他连接'),{code:'candidate-no-data'});
  // The caller can synchronously read this stable prefix for alignment while the
  // same capture continues appending later packets for the eventual handoff.
  const alignmentBytes=bytes;record();
  return {payloadBytes,payloadPackets,alignmentBytes,stop,attach(child){
   check();if(attached)throw Error('TCP capture already attached');if(!child?.stdin?.writable)throw Error('TCP pipeline input is not writable');
   attached=true;target=child;clearInterval(cancellation);cancellation=null;partial='';
   const detach=()=>{targetGone=true;stop();if(captureClosed){closeFile();record();}};
   child.once('exit',detach);child.on('message',m=>{if(m?.type==='stop-tcp-capture')stop();});
   child.stdin.on('error',detach);child.stdin.on('drain',()=>{waitingDrain=false;if(direct){capture.stdout.resume();if(captureClosed)pump();}else pump();});pump();
  }};
 }catch(e){fail(e);await completed;throw e;}finally{clearTimeout(idle);if(failure){clearInterval(cancellation);closeFile();}}
}
module.exports={captureTcpHandoff};
