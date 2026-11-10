'use strict';
const fs=require('node:fs'),readline=require('node:readline'),{spawn}=require('node:child_process');
const {finished}=require('node:stream/promises');
const {captureArgs}=require('./p1-capture-profile.cjs'),{setWorkerPriority}=require('./p1-process-priority.cjs');
const noData=()=>Object.assign(Error('当前候选连接没有收到有效数据，继续检查其他连接'),{code:'candidate-no-data'});
async function captureTcpInitialization({keepOpen=false,tshark,device,filter,log,snapshot,closing=()=>false,idleTimeoutMs=5000,snapshotDelayMs=6000,startCapture=spawn}){
 if(keepOpen)return require('./tcp-capture-handoff.cjs').captureTcpHandoff({tshark,device,filter,log,snapshot,closing,idleTimeoutMs,snapshotDelayMs,startCapture});
 if(typeof device!=='string'||!device.startsWith('\\Device\\NPF_'))throw Error('Exactly one Npcap interface is required');
 const capture=startCapture(tshark,captureArgs([device],filter,18),{windowsHide:true,stdio:['ignore','pipe','pipe']});
 const output=fs.createWriteStream(log,{flags:'wx'});capture.stdout.pipe(output);
 let problem=null,stderr='',payloadBytes=0,payloadPackets=0,closed=false,timer;
 const stop=error=>{problem??=error;capture.kill();};
 const completed=new Promise(resolve=>capture.once('close',code=>{closed=true;resolve(code);}));
 capture.once('spawn',()=>setWorkerPriority(capture.pid,'capture'));
 capture.on('error',e=>{problem??=e;});capture.stderr.on('data',b=>{stderr=(stderr+b).slice(-16384);});
 output.on('error',e=>stop(e));
 const lines=readline.createInterface({input:capture.stdout,crlfDelay:Infinity});
 lines.on('line',line=>{const a=line.split('\t'),length=Number(a[8]),hex=a[12]||'';
  if(a.length===13&&Number.isSafeInteger(length)&&length>0&&hex.length===length*2&&/^[a-f0-9]+$/i.test(hex)){payloadPackets++;payloadBytes+=length;}
 });
 const done=Promise.all([completed,finished(output)]).then(([code])=>{if(problem)throw problem;if(code!==0)throw Error(stderr||'TCP capture exited '+code);if(!payloadBytes)throw noData();});done.catch(()=>{});
 const idle=setTimeout(()=>{if(!payloadBytes&&!closed)stop(noData());},idleTimeoutMs);
 const cancellation=setInterval(()=>{if(closing()&&!closed)stop(Object.assign(Error('采集已停止'),{code:'capture-stopped'}));},200);
 try{
  const beforeSnapshot=await Promise.race([done.then(()=>false),new Promise(resolve=>{timer=setTimeout(()=>resolve(true),snapshotDelayMs);})]);
  if(!beforeSnapshot)throw Object.assign(Error('候选连接在解码状态采样前已结束'),{code:'candidate-insufficient-data'});
  await snapshot();await done;return {payloadBytes,payloadPackets};
 }finally{
  clearTimeout(timer);clearTimeout(idle);clearInterval(cancellation);
  if(!closed)capture.kill();await completed;await finished(output).catch(()=>{});lines.close();
  fs.writeFileSync(log+'.capture.json',JSON.stringify({payloadPackets,payloadBytes,reasonCode:problem?.code||null,stderr},null,2));
 }
}
module.exports={captureTcpInitialization};
