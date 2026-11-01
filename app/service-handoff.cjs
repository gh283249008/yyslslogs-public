'use strict';
const fs=require('node:fs'),path=require('node:path');
// Cooperatively stop an orphaned collector from this exact data directory.
// Never terminate a PID from a status file: it may have been reused.
async function handoffService(dataRoot,{io=fs,alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}},wait=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,timeoutMs=30000,onWaiting=()=>{}}={}){
 const file=path.join(dataRoot,'service.json');
 let previous;try{previous=JSON.parse(io.readFileSync(file,'utf8'));}catch{return;}
 if(!Number.isSafeInteger(previous.pid)||previous.pid<=0||typeof previous.launchId!=='string'||!previous.launchId||previous.message==='采集已停止'||!alive(previous.pid))return;
 const age=now()-Date.parse(previous.at);
 if(!Number.isFinite(age)||age<0||age>120000)return;
 onWaiting(previous);
 io.writeFileSync(path.join(dataRoot,'stop'),'');
 const deadline=now()+timeoutMs;
 while(now()<deadline){
  if(!alive(previous.pid))return;
  let current;try{current=JSON.parse(io.readFileSync(file,'utf8'));}catch{}
  if(current?.pid===previous.pid&&current.launchId===previous.launchId&&current.message==='采集已停止')return;
  if(current?.launchId&&current.launchId!==previous.launchId)throw Error('采集服务已由另一个程序接管，请关闭重复窗口后重试。');
  await wait(200);
 }
 throw Error('旧采集服务尚未停止；已保留记录，暂不启动重复采集。');
}
module.exports={handoffService};
