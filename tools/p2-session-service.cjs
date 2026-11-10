'use strict';
// Local-only orchestration: read-only state snapshot + passive capture + unique
// framing/schema alignment. No injected code, game writes or replay-as-live.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process');
const {runtimePaths,childEnv,powershellScriptArgs}=require('./p2-runtime.cjs');
const {setWorkerPriority}=require('./p1-process-priority.cjs');
setWorkerPriority();
const dataIndex=process.argv.indexOf('--data');
if(dataIndex<0||!process.argv[dataIndex+1])throw Error('Expected --data DIRECTORY');
const root=path.resolve(__dirname,'..'),data=path.resolve(process.argv[dataIndex+1]);
const launchIndex=process.argv.indexOf('--launch-id'),launchId=launchIndex>=0?process.argv[launchIndex+1]:null;
Object.assign(process.env,childEnv());
const wait=ms=>new Promise(r=>setTimeout(r,ms)),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
fs.mkdirSync(data,{recursive:true});const stopFile=path.join(data,'stop');if(fs.existsSync(stopFile))fs.unlinkSync(stopFile);
const {python,tshark,powershell}=runtimePaths();
const publisher=new (require('./p1-snapshot-publisher.cjs').SnapshotPublisher)();
const node=process.execPath;let current=null,latestPath=null;
function status(message,detail=''){const value={at:new Date().toISOString(),pid:process.pid,launchId,message,detail,latestPath};const f=path.join(data,'service.json');publisher.write(f,value);}
function run(exe,args,{input=null,timeout=60000}={}){return new Promise((resolve,reject)=>{let stdout='',stderr='';const p=spawn(exe,args,{cwd:root,windowsHide:true,stdio:['pipe','pipe','pipe']});const timer=setTimeout(()=>p.kill(),timeout);p.stdout.on('data',b=>{stdout+=b;if(stdout.length>16*1024*1024)p.kill();});p.stderr.on('data',b=>stderr+=b);p.on('error',reject);p.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(stderr.slice(-1500)||'子进程退出 '+code));else resolve(stdout);});p.stdin.end(input);});}
async function discover(bound=null,remote=null){const args=bound?[String(bound.pid),bound.processStartUtc,...(remote?[remote.address,String(remote.port)]:[])]:[];return JSON.parse((await run(powershell,powershellScriptArgs(path.join(__dirname,'../scripts/windows/p2-discover.ps1'),args))).replace(/^\uFEFF/,''));}
const key=m=>JSON.stringify([m.pid,m.processStartUtc,m.flows]);
const {readGameDataProfile,assertSameGameData}=require('./game-data-profile.cjs');
const resolver=new (require('./decoder-profiles.cjs').ProfileResolver)(data);let waitingHash=null,lastImage=null;
const routing=require('../modules/acquisition/connection-candidates.cjs'),selector=new routing.CandidateSelector();
const {loadRoutingHint,routingHint}=require('./connection-history.cjs');let lastConnection=loadRoutingHint(data);
async function bootstrap(m){
 if(!m.flows?.length&&!m.udpEndpoints?.length)throw Object.assign(Error(m.connectionCounts?.ipv6?'当前仅发现 IPv6 连接，尚不支持该传输路径':'尚无角色连接，进入角色后自动等待初始化'),{code:'connection-not-ready'});
 const catalog=require('./config-contract.cjs').load('config/client-build.json',root);
 const st=fs.statSync(m.modulePath,{bigint:true}),stamp=[m.pid,m.processStartUtc,m.modulePath,st.ino,st.size,st.ctimeNs,st.mtimeNs].join('|');
 const imageSha256=lastImage?.stamp===stamp?lastImage.hash:sha(fs.readFileSync(m.modulePath));lastImage={stamp,hash:imageSha256};
 let approved=null,profile=[catalog,...(catalog.profiles||[])].find(p=>p.imageSha256===imageSha256);
 if(!profile){let reason='尚无已验证的解码配置';try{approved=await resolver.resolve(imageSha256);}catch(e){reason=e.message;}profile=approved?.profile;
  if(!profile){const detail=reason+'；客户端 SHA-256：'+imageSha256+'。将自动检查更新。';status('等待版本适配',detail);if(waitingHash!==imageSha256){fs.appendFileSync(path.join(data,'service-errors.log'),new Date().toISOString()+' '+detail+'\n');waitingHash=imageSha256;}await wait(15000);return;}
 }
 waitingHash=null;
 const gameData=readGameDataProfile(m.modulePath);
 const readStateInput=JSON.stringify(approved?{id:profile.id,imageSha256,stateOffsets:profile.stateOffsets,rpcHandlerType:profile.rpcHandlerType}:null);
 const probe=path.join(data,'connection-check');fs.mkdirSync(probe,{recursive:true});fs.writeFileSync(path.join(probe,'module.json'),JSON.stringify(m));
 await run(python,['-B','-X','utf8',path.join(__dirname,'p2-read-state.py'),probe,'--check-connection'],{input:readStateInput});
 const readiness=JSON.parse(fs.readFileSync(path.join(probe,'rpc-state-recovery.json')));
 if(readiness.status!=='connection-ready')throw Object.assign(Error(readiness.reason||'连接结构校验未通过'),{code:readiness.reasonCode});
 if(readiness.clientBuildSha256!==imageSha256)throw Error('初始化期间客户端文件发生变化');
 if(readiness.transportProtocol==='KCP'){const next=await discover(m,readiness.remoteEndpoint);if(next.status!=='running')throw Error(next.error||'KCP 游戏绑定已失效');m=next;}
 const candidates=routing.candidates(m,readiness);
 if(!candidates.length)throw Error('已发现游戏连接，但无法唯一选定对应网卡或 UDP 端点；未启动全网卡采集');
 const preferred=candidates.find(c=>routing.matchesHint(c,lastConnection,m,imageSha256));
 const selection=selector.next(candidates,JSON.stringify([m.pid,m.processStartUtc,imageSha256,readiness.transportProtocol,readiness.remoteEndpoint]),preferred?routing.candidateKey(preferred):null),candidate=selection.candidate;
 // Validate exactly one discovered flow on its bound route per initialization.
 m={...m,interfaces:[candidate.interface],...(candidate.transport==='tcp'?{flows:[candidate.flow]}:{})};
 if(m.interfaces?.length!==1)throw Error('游戏网卡不唯一');
 const session=path.join(data,'sessions',new Date().toISOString().replace(/[:.]/g,'-')+'-'+m.pid),boot=path.join(session,'initialization');fs.mkdirSync(boot,{recursive:true});fs.writeFileSync(path.join(boot,'module.json'),JSON.stringify(m));
 fs.writeFileSync(path.join(boot,'connection-selection.json'),JSON.stringify({candidates:candidates.length,tier:selection.tier,attempts:selection.attempts,previouslyValidated:selection.preferred,ordering:'direct before compatibility fallback; stable candidate rounds'},null,2));
 status('正在初始化当前登录会话',`发现 ${candidates.length} 条候选连接，优先核对普通直连，再检查加速器转发；请等待采集已就绪。`);
 const list=await run(tshark,['-D']);const available=list.split(/\r?\n/).map(l=>l.match(/^\d+\. (\\Device\\NPF_\S+)/)?.[1]).filter(Boolean);
 const interfaces=m.interfaces.filter(i=>available.some(a=>a.toLowerCase()===i.toLowerCase()));if(!interfaces.length)throw Error('没有可用抓包网卡，请检查 Npcap');
 if(fs.existsSync(stopFile))throw Error('采集已停止');
 if(candidate.transport==='kcp'){
  status('正在初始化 KCP 游戏连接',candidate.envelope==='uu-ipv4'?'已发现游戏的本地加速器转发，正在校验协议':'正在校验游戏 UDP/KCP 连接');
  const bridge=await require('./kcp-bootstrap.cjs').bootstrapKcp({m,recovery:readiness,candidate,boot,python,tshark,node,run,profile,approved,data,readStateInput,closing:()=>fs.existsSync(stopFile)});
  try{await launchPipeline(m,session,{...bridge.config,gameData},bridge);}catch(e){bridge.stop();throw e;}return;
 }
 const filter='tcp and ('+m.flows.map(f=>`(src host ${f.serverAddress} and src port ${f.serverPort} and dst host ${f.clientAddress} and dst port ${f.clientPort})`).join(' or ')+')';
 const log=path.join(boot,'capture.private.tsv');
 const bridge=await require('./tcp-initialization-capture.cjs').captureTcpInitialization({keepOpen:true,tshark,device:interfaces[0],filter,log,closing:()=>fs.existsSync(stopFile),idleTimeoutMs:selection.preferred||selection.attempts>1?18000:5000,snapshot:()=>run(python,['-B','-X','utf8',path.join(__dirname,'p2-read-state.py'),boot],{input:readStateInput})});
 try{
 const recovery=JSON.parse(fs.readFileSync(path.join(boot,'rpc-state-recovery.json')));if(recovery.status!=='snapshot-ready')throw Error('解码状态尚未准备好：'+recovery.reason);
 if(recovery.clientBuildSha256!==imageSha256)throw Error('初始化期间客户端文件发生变化');
 if(recovery.transportProtocol==='KCP')throw Error('初始化期间游戏已切换为 KCP，等待重新选择连接');
 const initialBytes=Buffer.alloc(bridge.alignmentBytes),initialFd=fs.openSync(log,'r');try{if(fs.readSync(initialFd,initialBytes,0,initialBytes.length,0)!==initialBytes.length)throw Error('Initialization journal truncated');}finally{fs.closeSync(initialFd);}
 const initialText=initialBytes.toString('utf8');const rows=initialText.slice(0,initialText.lastIndexOf('\n')+1).trim().split(/\r?\n/).filter(Boolean).map(l=>{const a=l.split('\t');return{time:+a[1],iface:+a[2],src:a[3],sport:+a[4],dst:a[5],dport:+a[6],seq:+a[7],len:+a[8],data:Buffer.from(a[12]||'','hex')};}).filter(r=>r.len&&r.data.length===r.len);
 const groups=new Map();for(const r of rows){const k=JSON.stringify([r.iface,r.src,r.sport,r.dst,r.dport]);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
 let config=null,attempt=0;
 for(const group of groups.values()){
  try{
   group.sort((a,b)=>a.seq-b.seq||a.time-b.time);const first=group[0],origin=first.seq;let end=origin,bytes=Buffer.alloc(0),duplicates=0;
   for(const r of group){if(r.seq>end)throw Error('TCP gap');const overlap=Math.min(end-r.seq,r.data.length);if(overlap&&!bytes.subarray(r.seq-origin,r.seq-origin+overlap).equals(r.data.subarray(0,overlap)))throw Error('Conflicting overlap');duplicates+=overlap;bytes=Buffer.concat([bytes,r.data.subarray(overlap)]);end+=r.data.length-overlap;}
   if(bytes.length<64)continue;const at=Date.parse(recovery.snapshotAtUtc)/1000;const before=group.filter(r=>r.time<at-3),after=group.filter(r=>r.time<=at+3);if(!after.length)continue;
   const minCursor=before.length?Math.max(...before.map(r=>r.seq+r.data.length))-origin:0,maxCursor=Math.max(...after.map(r=>r.seq+r.data.length))-origin;
   const dir=path.join(boot,'candidate-'+(++attempt));fs.mkdirSync(dir);const cipherFile=path.join(dir,'cipher.private.bin');fs.writeFileSync(cipherFile,bytes);
   const flow={serverAddress:first.src,serverPort:first.sport,clientAddress:first.dst,clientPort:first.dport};const align={stateFile:recovery.stateObject,expectedVtable:recovery.expectedVtable,cipherFile,minCursor,maxCursor,maxPrefix:256,python,outDir:path.join(dir,'aligned'),metadata:{pid:m.pid,flow,gaps:0,overlapsVerified:true,captureStartTcpSequence:origin,duplicateBytes:duplicates,sourceTsvSha256:sha(initialBytes),sourceTsvBytes:initialBytes.length,snapshotAtUtc:recovery.snapshotAtUtc,interface:interfaces[first.iface]}};
   const alignFile=path.join(dir,'align.private.json');fs.writeFileSync(alignFile,JSON.stringify(align));await run(node,[path.join(__dirname,'align-rc4-late-state.cjs'),alignFile],{timeout:120000});
   const report=path.join(align.outDir,'report.json'),r=JSON.parse(fs.readFileSync(report));if(!r.unique||!r.roundTrip)continue;
   config={identityCacheFile:path.join(data,'identity-cache.json'),clientBuildSha256:profile.imageSha256,...(approved?{decoderEnvelope:approved.envelope}:{}),pid:m.pid,processStartUtc:m.processStartUtc,processPath:m.modulePath,flow,captureInterface:interfaces[first.iface],python,tshark,serverEncryptedOrigin:origin,initialStateFile:path.join(align.outDir,r.anchor.stateFile),initialStateSha256:r.anchor.stateSha256,cipherStateKind:'validated-midstream',cipherAnchorReport:report,cipherAnchorReportSha256:sha(fs.readFileSync(report)),gapTimeoutMs:3000,knownAcquisitionGaps:[{kind:'joined-existing-session',note:'Initialization is not a claim that earlier combat was captured.'}]};break;
  }catch(e){fs.appendFileSync(path.join(boot,'alignment-errors.log'),e.message+'\n');}
 }
 if(!config)throw Object.assign(Error(!rows.length?'候选连接没有有效载荷，继续检查其他连接':!attempt?'候选连接的数据不足以校验游戏协议，继续检查其他连接':'当前候选连接未通过游戏协议校验，继续检查其他连接；证据已保留'),{code:attempt?'candidate-protocol-mismatch':'candidate-insufficient-data'});
 await launchPipeline(m,session,{...config,gameData,captureHandoff:'tcp'},bridge);
 }catch(e){bridge.stop();throw e;}
}
async function launchPipeline(m,session,config,bridge=null){
 assertSameGameData(config.gameData,readGameDataProfile(m.modulePath));
 const now=await discover(m);if(now.status!=='running'||now.pid!==m.pid||now.processStartUtc!==m.processStartUtc||!require('../modules/acquisition/connection-candidates.cjs').stillBound(now,config))throw Error('初始化期间游戏连接改变');
 if(fs.existsSync(stopFile))throw Error('采集已停止');
 lastConnection=routingHint(config);publisher.write(path.join(data,'validated-connection.json'),lastConnection);
 const configFile=path.join(session,'session.private.json');fs.writeFileSync(configFile,JSON.stringify(config));const out=path.join(session,'capture');
 const child=spawn(node,[path.join(__dirname,'p1-live-pipeline.cjs'),'--config',configFile,'--out',out,'--duration','43200'],{cwd:root,windowsHide:true,stdio:bridge?['pipe','ignore','pipe','ipc']:['ignore','ignore','pipe']});child.stderr.on('data',b=>fs.appendFileSync(path.join(session,'pipeline-errors.log'),b));child.on('error',e=>{bridge?.stop();status('采集启动失败',e.message);});
 try{bridge?.attach(child);}catch(e){child.stdin?.end();child.kill();throw e;}
 current={child,out,key:key(m)};latestPath=path.join(out,'latest.json');status('采集启动中','已验证当前会话解码状态。');
}
(async()=>{
 status('等待游戏启动','启动游戏并进入角色后自动初始化。');
 while(!fs.existsSync(stopFile)){
  try{
   if(current){if(current.child.exitCode!==null||current.child.signalCode!==null){status('正在恢复采集','采集进程已退出；历史数据保留');current=null;await wait(1000);continue;}const complete=path.join(current.out,'completion.json');if(fs.existsSync(complete)){const c=JSON.parse(fs.readFileSync(complete));status('正在恢复采集',c.status);current=null;await wait(10000);continue;}
    const health=path.join(current.out,'health.json');if(fs.existsSync(health)){const h=JSON.parse(fs.readFileSync(health));status(h.session==='valid'?'采集已就绪':'正在校验会话',h.reason||'');}await wait(2000);continue;}
   const m=await discover();if(m.status==='waiting-game'){status('等待游戏启动');await wait(4000);continue;}if(m.status!=='running')throw Error(m.error||m.status);await bootstrap(m);
  }catch(e){if(fs.existsSync(stopFile))break;
   if(e.code==='connection-not-ready'){latestPath=null;status('等待进入角色',e.message);await wait(5000);}
   else if(e.code?.startsWith('candidate-')){latestPath=null;status('正在寻找游戏数据连接',e.message);fs.appendFileSync(path.join(data,'connection-attempts.log'),new Date().toISOString()+' '+e.code+' '+e.message+'\n');await wait(250);}
   else{status('等待采集恢复',e.message);fs.appendFileSync(path.join(data,'service-errors.log'),new Date().toISOString()+' '+e.stack+'\n');await wait(15000);}
  }
 }
 if(current){for(let i=0;i<175&&current.child.exitCode===null&&current.child.signalCode===null;i++){if(fs.existsSync(current.out))fs.writeFileSync(path.join(current.out,'stop'),'');await wait(200);}}
 status('采集已停止','本地记录已保留。');await publisher.close();
})().catch(e=>{status('采集服务错误',e.message);process.exitCode=1;});
