'use strict';
const {app,BrowserWindow,ipcMain,globalShortcut,Tray,Menu,nativeImage,shell,dialog,net}=require('electron');
const fs=require('fs'),path=require('path'),http=require('http');
// Small transparent overlays should not compete with the game for GPU rendering.
app.disableHardwareAcceleration();
const {CombatModel,toKagerou}=require('./combat-model.cjs');
const {SnapshotFeed}=require('./snapshot-feed.cjs');
const {AttributionFeed}=require('./attribution-feed.cjs');
const {BuffMonitorFeed}=require('./buff-monitor-feed.cjs');
const {ServiceLifecycle}=require('./service-lifecycle.cjs');
const {runtimePaths,childEnv,checkRuntime}=require('../tools/p2-runtime.cjs');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'vendor/kagerou/dist');
const startupCheck=process.argv.includes('--verify-startup');
const liveCheck=process.argv.includes('--verify-live'),checks=process.argv.includes('--verify-ui')||liveCheck||startupCheck;
// Rejected instances must not write shared state or initialize services.
if(!checks&&!app.requestSingleInstanceLock()){app.quit();return;}
app.on('before-quit',()=>{app.isQuitting=true;});
const defaultDataRoot=path.join(app.getPath('appData'),'YyslsLogs');
const dataRoot=process.env.YYSLS_DATA_ROOT||defaultDataRoot;
if(startupCheck&&(!process.env.YYSLS_DATA_ROOT||path.resolve(dataRoot).toLowerCase()===path.resolve(defaultDataRoot).toLowerCase()))throw Error('--verify-startup requires a separate YYSLS_DATA_ROOT');
if(startupCheck&&(process.argv.includes('--live-file')||process.argv.includes('--replay')))throw Error('--verify-startup must exercise the live service startup');
if(startupCheck&&fs.existsSync(path.join(dataRoot,'service.json')))throw Error('--verify-startup requires an unused data root; existing service state must not be disturbed');
fs.mkdirSync(dataRoot,{recursive:true});
if(startupCheck){
 const isolatedUserData=path.join(dataRoot,'electron-user-data');fs.mkdirSync(isolatedUserData,{recursive:true});
 app.setPath('userData',isolatedUserData);app.setPath('sessionData',isolatedUserData);
}
const arg=n=>{let i=process.argv.indexOf(n);return i<0?null:process.argv[i+1];};
let activeTest=null;try{activeTest=JSON.parse(fs.readFileSync(path.join(root,'evidence/p1/active-test.json')));}catch{}
let latest=path.resolve(arg('--live-file')||path.join(dataRoot,'waiting/latest.json'));
if(!arg('--live-file')){fs.mkdirSync(path.dirname(latest),{recursive:true});fs.writeFileSync(latest,JSON.stringify({schemaVersion:1,source:{mode:'live',sessionId:'waiting'},observedAt:null,publishedAt:new Date().toISOString(),actors:[],sequence:0,npcNo:null,timeCostSeconds:0,health:{status:'starting',session:'pending',gap:false,stale:true}}));}
const labelsFile=arg('--labels-file'),actorLabels=labelsFile?JSON.parse(fs.readFileSync(path.resolve(labelsFile))):{};
let attributionFeed=new AttributionFeed(latest),service=null,serviceState={message:'等待启动'},lastServiceSource=null;
const serviceLifecycle=new ServiceLifecycle();
let checkingRuntime=false,setupTimer=null;
const diagnosticRoot=path.join(dataRoot,'diagnostics');
let win,buffWin,tray,server,model=new CombatModel(),feed=new SnapshotFeed(latest),buffFeed=new BuffMonitorFeed(latest),mode=process.argv.includes('--replay')?'replay':'live',locked=false,buffLocked=false,lastText='',replayTimer,replayIndex=0,replayRows=[],lastView=null;
function mainWindowAlive(){return !app.isQuitting&&win&&!win.isDestroyed();}
function showMainWindow(){if(mainWindowAlive()){if(win.isMinimized())win.restore();win.show();}}
app.on('second-instance',()=>{if(mainWindowAlive()){showMainWindow();win.focus();}});
function payload(){return {mode,locked,labelsFromScreenshot:mode==='replay'&&!!labelsFile,...lastView,service:{...serviceState},data:lastView?toKagerou(lastView,mode==='replay'?actorLabels:{}):null};}
function buffPayload(){return {...buffFeed.poll(),locked:buffLocked};}
function send(){if(win&&!win.isDestroyed()&&(checks||win.isVisible()))win.webContents.send('state',payload());if(buffWin&&!buffWin.isDestroyed()){const state=buffPayload();if(checks||buffWin.isVisible())buffWin.webContents.send('buff-state',state);}}
function toggleLock(){if(!mainWindowAlive())return;locked=!locked;win.setIgnoreMouseEvents(locked,{forward:true});send();}
function toggleBuffLock(){buffLocked=!buffLocked;if(buffWin&&!buffWin.isDestroyed())buffWin.setIgnoreMouseEvents(buffLocked,{forward:true});send();}
function toggleBuffWindow(){if(!buffWin||buffWin.isDestroyed())return;if(buffWin.isVisible())buffWin.hide();else buffWin.showInactive();updateTray();}
function setSource(file){latest=file;model=new CombatModel();feed=new SnapshotFeed(latest);buffFeed=new BuffMonitorFeed(latest);attributionFeed=new AttributionFeed(latest);lastView=null;clearInterval(replayTimer);mode='live';send();}
function historyMenu(){
 const entries=[];const sessions=path.join(dataRoot,'sessions');
 if(fs.existsSync(sessions))for(const session of fs.readdirSync(sessions)){const dir=path.join(sessions,session,'capture','battles');if(!fs.existsSync(dir))continue;for(const id of fs.readdirSync(dir)){try{const b=JSON.parse(fs.readFileSync(path.join(dir,id,'battle.json')));entries.push({label:new Date(b.clock.startObservedAt).toLocaleString('zh-CN')+' · '+(require('../modules/domain/encounter-display-name.cjs').resolveEncounterDisplayIdentity(b.clock.identityContext,b.statistics.npcNo,b.source?.gameData)?.bossName||'Boss '+b.statistics.npcNo),at:b.clock.startObservedAt,file:path.join(dir,id,'latest.json')});}catch{}}}
 entries.sort((a,b)=>b.at.localeCompare(a.at));
 const items=entries.slice(0,20).map(e=>({label:e.label,click:()=>setSource(e.file)}));
 const sample=path.join(root,'sample/latest.json');if(fs.existsSync(sample))items.push({label:'演示：已保存战斗记录',click:()=>setSource(sample)});
 return items.length?items:[{label:'暂无已保存战斗',enabled:false}];
}
function restartElevated(){
 const exe=process.execPath.replace(/'/g,"''");
 require('child_process').spawn('powershell.exe',['-NoProfile','-Command',`Wait-Process -Id ${process.pid} -Timeout 15 -ErrorAction SilentlyContinue; Start-Process -FilePath '${exe}' -Verb RunAs -WindowStyle Hidden`],{windowsHide:true,detached:true,stdio:'ignore'}).unref();
 app.quit();
}
function updateTray(){send();if(!tray)return;tray.setToolTip(('燕云 Logs · '+serviceState.message).slice(0,120));tray.setContextMenu(Menu.buildFromTemplate([
 {label:'显示悬浮窗',click:showMainWindow},{label:'锁定 / 鼠标穿透 (Ctrl+Shift+F8)',click:toggleLock},
 {label:buffWin?.isVisible()?'隐藏 Buff 提示窗':'显示 Buff 提示窗',click:toggleBuffWindow},{label:'锁定 Buff 提示窗 / 鼠标穿透',type:'checkbox',checked:buffLocked,click:toggleBuffLock},
 {label:'实时采集',click:()=>{lastServiceSource=null;if(serviceState.latestPath)setSource(serviceState.latestPath);else setSource(path.join(dataRoot,'waiting/latest.json'));}},
 {label:'本地战斗记录',submenu:historyMenu()},{label:'打开记录文件夹',click:()=>shell.openPath(dataRoot)},
 {label:'状态与版本',click:()=>dialog.showMessageBox(win,{type:'info',title:'燕云 Logs',message:serviceState.message,detail:'版本 '+app.getVersion()+'\n'+(serviceState.detail||'')+'\n记录目录：'+dataRoot+'\nrDPS 为简化估算。未知个人增益和未支持条件不会冒充完整归因。'})},
 {label:'检查采集环境 / 安装驱动',click:()=>prepareCapture(true,true)},
 {label:'以管理员权限重新启动',click:restartElevated},
 {label:'退出',click:()=>app.quit()}]));}
function switchMode(next){
  mode=next;clearInterval(replayTimer);model=new CombatModel();feed=new SnapshotFeed(latest);lastView=null;lastText='';
  if(mode==='replay'){
    const sampleFile=arg('--sample-file');
    const stats=sampleFile?fs.readFileSync(path.resolve(sampleFile),'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse):JSON.parse(fs.readFileSync(path.join(root,'evidence/p0/runtime-rpc-analysis/after-exit-final/statistics-verified.json'))).stats;
    replayRows=stats;replayIndex=Math.max(0,stats.findIndex(x=>x.actors.some(a=>a.damage>0))-1);
    replayTimer=setInterval(()=>{
      const r=replayRows[replayIndex++];if(!r){clearInterval(replayTimer);return;}
      const s=r.schemaVersion===1?{...r,source:{...r.source,mode:'replay'},health:{...r.health,status:'healthy',session:'recorded',stale:false,gap:false}}:{schemaVersion:1,source:{mode:'replay',sessionId:'boss-20261018-0237'},observedAt:new Date(1792262212000+replayIndex*1000).toISOString(),
        health:{status:'healthy',gap:false,stale:false,session:'valid'},npcNo:r.npc_no,timeCostSeconds:r.time_cost,
        actors:r.actors.map(a=>({idHash:a.actorHash,damage:a.damage,heal:a.heal,absorbDmg:a.absorb_dmg}))};
      lastView=model.ingest(s);send();
      // Freeze the validated end response instead of replaying four idle minutes.
      if(r.time_cost>0)clearInterval(replayTimer);
    },checks?15:sampleFile?40:1000);
  } else send();
}
function action(a){if(a==='lock')toggleLock();else if(a==='toggle-buff-lock')toggleBuffLock();else if(a==='toggle-buff-window')toggleBuffWindow();else if(a==='hide')win.hide();else if(a==='quit')app.quit();else if(['live','replay'].includes(a))switchMode(a);}
function serviceDiagnostics(event){
 try{
  fs.mkdirSync(diagnosticRoot,{recursive:true});
  const record={at:new Date().toISOString(),event,mainPid:process.pid,mainExecutable:process.execPath,servicePid:service?.pid??serviceLifecycle.snapshot()?.pid??null,serviceLaunchId:serviceLifecycle.snapshot()?.launchId??null,lifecycle:serviceLifecycle.snapshot(),state:serviceState};
  const file=path.join(diagnosticRoot,'service-lifecycle.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify(record,null,2));fs.renameSync(file+'.tmp',file);
 }catch(e){console.error('Service diagnostics:',e.message);}
}
function startService(){
 if(app.isQuitting||service)return;
 clearInterval(setupTimer);setupTimer=null;
 const launchId=serviceLifecycle.begin();lastServiceSource=null;
 serviceState={status:'starting',message:'正在启动采集服务',detail:'正在等待本次采集服务确认启动。',launchId};updateTray();
 let child;
 try{
  child=require('child_process').spawn(runtimePaths().node,[path.join(root,'tools/p2-session-service.cjs'),'--data',dataRoot,'--launch-id',launchId,'--parent-pid',String(process.pid)],{cwd:dataRoot,env:childEnv(),windowsHide:true,stdio:['ignore','ignore','pipe']});
 }catch(e){
  serviceLifecycle.finish(launchId,{error:e.message});serviceState={status:'error',message:'采集服务未能启动',detail:e.message,launchId};serviceDiagnostics('spawn-error');updateTray();return;
 }
 service=child;serviceLifecycle.bindPid(launchId,child.pid);serviceDiagnostics('spawn');
 child.stderr.on('data',b=>{try{fs.appendFileSync(path.join(dataRoot,'service-errors.log'),b);}catch(e){console.error('Service stderr log:',e.message);}});
 child.on('error',e=>{
  if(!serviceLifecycle.finish(launchId,{error:e.message}))return;
  if(service===child)service=null;
  serviceState={status:'error',message:'采集服务未能启动',detail:e.message,pid:child.pid,launchId};serviceDiagnostics('spawn-error');updateTray();
 });
 child.on('exit',(code,signal)=>{
  if(!serviceLifecycle.finish(launchId,{code,signal}))return;
  if(service===child)service=null;
  serviceState={status:'stopped',message:'采集服务已停止',detail:`退出码：${code??'无'}${signal?'，信号：'+signal:''}。可从托盘重新检查采集环境。`,pid:child.pid,launchId};serviceDiagnostics('exit');updateTray();
 });
}
async function prepareCapture(interactive=false,announce=false){
 if(app.isQuitting||checkingRuntime)return;checkingRuntime=true;
 try{
  const result=await checkRuntime();
  if(app.isQuitting)return;
  fs.mkdirSync(diagnosticRoot,{recursive:true});fs.writeFileSync(path.join(diagnosticRoot,'environment.json'),JSON.stringify(result,null,2));
  if(result.ok){
   if(!service)await require('./service-handoff.cjs').handoffService(dataRoot,{onWaiting:()=>{serviceState={message:'正在切换采集服务',detail:'正在保存并结束上一次采集，完成后自动启动。'};updateTray();send();}});
   startService();if(announce)await dialog.showMessageBox(win,{type:'info',message:'采集环境已就绪',detail:'无需安装 Node、Python 或 Wireshark，也无需设置游戏路径和网卡。'});return;
  }
  const driverMissing=result.portableRuntime&&!result.driverPresent;
  serviceState={message:driverMissing?'首次使用：需要安装采集驱动':result.capture.needsElevation?'采集需要管理员权限':'采集环境需要处理',detail:driverMissing?'点击托盘“检查采集环境 / 安装驱动”，安装一次 Npcap 即可。':result.checks.filter(c=>!c.ok).map(c=>c.id+'：'+c.detail).join('\n')||result.capture.detail||'未找到可用网卡；请确认网卡已启用，或以管理员权限重新启动。'};
  updateTray();
  if(!setupTimer)setupTimer=setInterval(()=>prepareCapture(false),15000);
  if(!interactive)return;
  if(result.portableRuntime&&result.capture.needsElevation){
   const choice=await dialog.showMessageBox(win,{type:'info',message:serviceState.message,detail:serviceState.detail,buttons:['以管理员权限重新启动','稍后'],defaultId:0,cancelId:1});
   if(choice.response===0)restartElevated();return;
  }
  if(!driverMissing){await dialog.showMessageBox(win,{type:'warning',message:serviceState.message,detail:serviceState.detail});return;}
  const {downloadInstaller,officialPage}=require('./capture-setup.cjs');
  const choice=await dialog.showMessageBox(win,{type:'info',title:'首次使用',message:'安装一次采集驱动即可开始使用',detail:'程序会从 Npcap 官网下载安装程序。按安装器默认选项完成安装，并确认 Windows 权限提示；完成后这里会自动继续。\nNode、Python 和采集工具已包含在程序中。',buttons:['下载并安装','打开官网','稍后'],defaultId:0,cancelId:2});
  if(choice.response===1){await shell.openExternal(officialPage);return;}
  if(choice.response!==0)return;
  serviceState={message:'正在下载采集驱动',detail:'正在从 Npcap 官网下载并验证数字签名。'};updateTray();
  const installer=await downloadInstaller(dataRoot,(url,options)=>net.fetch(url,options));
  const error=await shell.openPath(installer);if(error)throw Error(error);
  serviceState={message:'等待驱动安装完成',detail:'按安装器默认选项完成安装后，程序会自动继续。'};updateTray();
 }catch(e){
  serviceState={message:'环境准备未完成',detail:e.message};updateTray();
  if(interactive){
   const choice=await dialog.showMessageBox(win,{type:'warning',message:'环境准备未完成',detail:e.message+'\n可打开官网下载 Npcap，按默认选项安装后程序会自动继续。',buttons:['打开驱动官网','关闭'],defaultId:0,cancelId:1});
   if(choice.response===0)await shell.openExternal('https://npcap.com/#download');
  }
 }finally{checkingRuntime=false;}
}
app.whenReady().then(async()=>{
  server=http.createServer((req,res)=>{
    let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
    if(!pathname.startsWith('/kagerou/')){res.writeHead(404).end();return;}
    let file=path.resolve(dist,pathname.slice('/kagerou/'.length));
    if(file!==dist&&!file.startsWith(dist+path.sep)){res.writeHead(403).end();return;}
    try{if(fs.statSync(file).isDirectory())file=path.join(file,'index.html');const data=fs.readFileSync(file);
      res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.png':'image/png','.json':'application/json'})[path.extname(file)]||'application/octet-stream');
      res.setHeader('Content-Security-Policy',"default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'");res.end(data);
    }catch{res.writeHead(404).end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(checks?0:17862,'127.0.0.1',resolve);});const origin=`http://127.0.0.1:${server.address().port}`;
  const prefs=path.join(dataRoot,'window.json');let bounds={width:730,height:380,x:80,y:100};try{bounds={...bounds,...JSON.parse(fs.readFileSync(fs.existsSync(prefs)?prefs:path.join(app.getPath('userData'),'window.json')))};}catch{}
  const buffPrefs=path.join(dataRoot,'buff-window.json');let buffBounds={width:250,height:104,x:830,y:100};try{buffBounds={...buffBounds,...JSON.parse(fs.readFileSync(buffPrefs))};}catch{}
  win=new BrowserWindow({...bounds,minWidth:460,minHeight:180,frame:false,transparent:true,alwaysOnTop:true,show:!checks,icon:path.join(__dirname,'assets/logo.png'),backgroundColor:'#00000000',title:'燕云 Logs · Kagerou',
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),backgroundThrottling:!checks,contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.setAlwaysOnTop(true,'screen-saver');
  win.on('show',send);
  buffWin=new BrowserWindow({...buffBounds,width:478,height:150,minWidth:120,minHeight:88,maxWidth:520,maxHeight:180,frame:false,transparent:true,resizable:false,alwaysOnTop:true,show:!checks,skipTaskbar:true,focusable:true,icon:path.join(__dirname,'assets/logo.png'),backgroundColor:'#00000000',title:'燕云 Logs · Buff 提示',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  buffWin.setAlwaysOnTop(true,'screen-saver');
  buffWin.on('show',send);
  buffWin.on('close',event=>{if(!app.isQuitting){event.preventDefault();buffWin.hide();}});
  buffWin.on('move',()=>{try{fs.mkdirSync(path.dirname(buffPrefs),{recursive:true});fs.writeFileSync(buffPrefs,JSON.stringify(buffWin.getBounds()));}catch{}});
  win.webContents.setWindowOpenHandler(({url})=>url.startsWith(origin+'/kagerou/config/')?{action:'allow',overrideBrowserWindowOptions:{width:900,height:700,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}}}:{action:'deny'});
  win.webContents.on('will-navigate',(e,url)=>{if(!url.startsWith(origin+'/kagerou/'))e.preventDefault();});
  win.on('close',()=>{if(checks)return;try{fs.mkdirSync(path.dirname(prefs),{recursive:true});fs.writeFileSync(prefs,JSON.stringify(win.getBounds()));}catch{}});
  // The companion window outlives the main window; window-all-closed is insufficient.
  win.on('closed',()=>{if(!app.isQuitting)app.quit();});
  ipcMain.on('ready',e=>{if(mainWindowAlive()&&e.sender===win.webContents)send();});
  ipcMain.on('buff-ready',e=>{if(e.sender===buffWin.webContents)send();});
  ipcMain.on('command',(e,a)=>{if(mainWindowAlive()&&(e.sender===win.webContents||(!buffWin.isDestroyed()&&e.sender===buffWin.webContents)))action(a);});
  const pixels=Buffer.alloc(16*16*4);for(let p=0;p<pixels.length;p+=4){pixels[p]=0xda;pixels[p+1]=0xc6;pixels[p+2]=0x26;pixels[p+3]=255;}
  const icon=fs.existsSync(path.join(__dirname,'assets/logo.png'))?nativeImage.createFromPath(path.join(__dirname,'assets/logo.png')).resize({width:32,height:32}):nativeImage.createFromBitmap(pixels,{width:16,height:16});
  tray=new Tray(icon.isEmpty()?nativeImage.createEmpty():icon);tray.setToolTip('燕云 Logs · Ctrl+Shift+F8锁定 · Ctrl+Shift+F9显示');
  updateTray();tray.on('right-click',updateTray);
  tray.on('double-click',showMainWindow);
  const shortcuts={'CommandOrControl+Shift+F8':toggleLock,'CommandOrControl+Shift+F9':()=>{if(mainWindowAlive()){if(win.isVisible())win.hide();else showMainWindow();}},'CommandOrControl+Shift+F10':()=>app.quit()};
  const shortcutResults=checks?{verification:'not registered'}:Object.fromEntries(Object.entries(shortcuts).map(([k,v])=>[k,globalShortcut.register(k,v)]));
  await Promise.all([win.loadURL(origin+'/kagerou/overlay/'),buffWin.loadURL(origin+'/kagerou/buff-monitor.html')]);switchMode(mode);
  if(startupCheck||(!checks&&!arg('--live-file'))){
   await prepareCapture(!startupCheck);
  }
  const poll=setInterval(()=>{
    if(service){
      try{
        const s=JSON.parse(fs.readFileSync(path.join(dataRoot,'service.json')));
        if(serviceLifecycle.accept(s)){
          if(JSON.stringify(s)!==JSON.stringify(serviceState)){serviceState=s;serviceDiagnostics('status');updateTray();}
          if(s.latestPath&&s.latestPath!==lastServiceSource){lastServiceSource=s.latestPath;setSource(s.latestPath);}
        }
      }catch{}
      if(serviceLifecycle.checkStartupTimeout()){
        serviceState={status:'error',message:'采集服务启动超时',detail:'15 秒内未收到本次采集服务的启动确认。请在托盘查看状态；错误记录位于记录目录的 service-errors.log。',pid:service.pid,launchId:serviceLifecycle.snapshot().launchId};
        serviceDiagnostics('handshake-timeout');updateTray();
      }
    }
    if(mode!=='live'){send();return;}
    try{lastView=attributionFeed.poll(feed.poll(model));send();
    }catch(e){lastView={...lastView,transportStale:true,inputError:e.code==='ENOENT'?'等待采集器':e.message};send();}
  },250);
  let stopping=false;
  app.on('before-quit',event=>{
    app.isQuitting=true;
    clearInterval(setupTimer);
    if(service&&service.exitCode===null&&!stopping){event.preventDefault();stopping=true;fs.writeFileSync(path.join(dataRoot,'stop'),'');const timer=setTimeout(()=>app.quit(),5000);service.once('exit',()=>{clearTimeout(timer);app.quit();});return;}
    clearInterval(poll);clearInterval(replayTimer);server.close();globalShortcut.unregisterAll();
  });
  if(process.argv.includes('--diagnostics')){
    let busy=false;
    const diagnosticTimer=setInterval(async()=>{if(busy||win.isDestroyed())return;busy=true;try{
      const ui=await win.webContents.executeJavaScript('({text:document.body.innerText,rows:document.querySelectorAll("#table > li").length,errors:window.__yyslsErrors||[]})');
      const record={at:new Date().toISOString(),pid:process.pid,mainPid:process.pid,servicePid:service?.pid??null,serviceLaunchId:serviceLifecycle.snapshot()?.launchId??null,service:serviceState,mode,latest,visible:win.isVisible(),alwaysOnTop:win.isAlwaysOnTop(),locked,buffWindow:{visible:buffWin?.isVisible()??false,alwaysOnTop:buffWin?.isAlwaysOnTop()??false,locked:buffLocked,bounds:buffWin?.getBounds()??null},...ui};
      const file=path.join(diagnosticRoot,'runtime-health.json');fs.writeFileSync(file+'.tmp',JSON.stringify(record,null,2));fs.renameSync(file+'.tmp',file);
      fs.appendFileSync(path.join(path.dirname(latest),'overlay-observations.jsonl'),JSON.stringify(record)+'\n');
    }catch(e){console.error('Overlay diagnostics:',e.message);}finally{busy=false;}},2000);
    app.on('before-quit',()=>clearInterval(diagnosticTimer));
  }
  fs.mkdirSync(diagnosticRoot,{recursive:true});
  fs.writeFileSync(path.join(diagnosticRoot,`${checks?'verification-launch':'launch'}.json`),JSON.stringify({pid:process.pid,mainPid:process.pid,servicePid:service?.pid??null,serviceLaunchId:serviceLifecycle.snapshot()?.launchId??null,origin,latest,mode,shortcutResults,at:new Date().toISOString()},null,2));
  if(startupCheck){
    const report={at:new Date().toISOString(),scope:'Actual hidden Electron GUI → environment check → child service handshake → rendered status → owned service stop. No combat or replay validation.',mainPid:process.pid,dataRoot,origin,environment:null,passed:false};
    const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    try{
      report.environment=JSON.parse(fs.readFileSync(path.join(diagnosticRoot,'environment.json')));
      const deadline=Date.now()+17000;
      while(service&&serviceLifecycle.snapshot()?.handshakeAt===null&&Date.now()<deadline)await wait(100);
      clearInterval(poll);clearInterval(setupTimer);setupTimer=null;
      send();await wait(300);
      const lifecycle=serviceLifecycle.snapshot();
      report.lifecycle=lifecycle;report.service={...serviceState};
      report.ui=await win.webContents.executeJavaScript('({title:document.querySelector("#history-time")?.textContent,detail:document.querySelector("nav")?.title,debugPanelHidden:getComputedStyle(document.querySelector("#yysls-panel")).display==="none",errors:window.__yyslsErrors||[]})');
      report.windowHidden=!win.isVisible();
      report.identityMatched=!!lifecycle&&lifecycle.handshakeAt!==null&&report.service.pid===lifecycle.pid&&report.service.launchId===lifecycle.launchId;
      report.statusRendered=report.ui.title===report.service.message;
      report.passed=report.environment.ok&&report.identityMatched&&report.statusRendered&&report.windowHidden&&report.ui.debugPanelHidden&&report.ui.errors.length===0;
    }catch(e){report.error=e.stack;report.passed=false;}
    finally{
      clearInterval(poll);clearInterval(setupTimer);
      const child=service,identity=serviceLifecycle.snapshot();
      report.shutdown={requestedAt:new Date().toISOString(),servicePid:child?.pid??identity?.pid??null,launchId:identity?.launchId??null,stopped:!child};
      if(child){
        // This data root and child belong only to this verification invocation.
        fs.writeFileSync(path.join(dataRoot,'stop'),'');
        let exited=child.exitCode!==null||child.signalCode!==null;
        const onExit=()=>{exited=true;};child.once('exit',onExit);
        const deadline=Date.now()+30000;
        while(!exited&&Date.now()<deadline)await wait(100);
        if(!exited){
          report.shutdown.forcedStop=true;report.passed=false;child.kill();
          const forcedDeadline=Date.now()+3000;while(!exited&&Date.now()<forcedDeadline)await wait(100);
        }
        child.removeListener('exit',onExit);
        report.shutdown.stopped=exited;report.shutdown.exitCode=child.exitCode;report.shutdown.signal=child.signalCode;
        if(!exited)report.passed=false;
      }
      report.shutdown.completedAt=new Date().toISOString();
      fs.writeFileSync(path.join(diagnosticRoot,'startup-verification.json'),JSON.stringify(report,null,2));
      app.exit(report.passed?0:1);
    }
  }else if(checks){
    setTimeout(async()=>{try{const state=await win.webContents.executeJavaScript('({schoolColors:[...document.querySelectorAll("#table > li")].map(x=>({name:x.querySelector(".flex-column-i-name").textContent,nameColor:x.querySelector(".flex-column-i-name").style.color,gaugeColor:x.querySelector(".gauge").style.backgroundColor})),hiddenTransferColumns:!document.querySelector("#header .flex-column-yysls-given,#header .flex-column-yysls-taken"),text:document.body.innerText,debugPanelHidden:getComputedStyle(document.querySelector("#yysls-panel")).display==="none",rows:document.querySelectorAll("#table > li").length,errors:window.__yyslsErrors||[],footerValue:document.querySelector("#rdps").textContent,footerLabel:document.querySelector(".footer-rdps > small").textContent})');
      const pic=await win.webContents.capturePage();fs.writeFileSync(path.join(diagnosticRoot,`${liveCheck?'live-path':'replay'}.png`),pic.toPNG());
      const buffState=await buffWin.webContents.executeJavaScript('({text:document.body.innerText,empty:document.querySelector("#empty").style.display!=="none",errors:window.__yyslsErrors||[]})');
      clearInterval(poll);
      const monitorPreview=await buffWin.webContents.executeJavaScript(`(()=>{state={locked:false,buffs:[{name:'烁鼓',variant:'+12% 攻击',remainingSeconds:8,durationSeconds:12},{name:'增伤·霖',variant:'+24% 增伤',remainingSeconds:12,durationSeconds:24},{name:'崩解',variant:'5 层',remainingSeconds:4.5,durationSeconds:5},{name:'血祭',phase:'active',variant:'+25% 独立增伤',remainingSeconds:10,durationSeconds:18}]};receivedAt=Date.now();render();const n=document.getElementById('xueji');return {synthetic:true,text:n.innerText,visible:getComputedStyle(n).display!=='none',fits:n.getBoundingClientRect().right<=innerWidth};})()`);
      fs.writeFileSync(path.join(diagnosticRoot,'buff-preview.json'),JSON.stringify(monitorPreview,null,2));
      if(!monitorPreview.visible||!monitorPreview.fits||!monitorPreview.text.includes('+25% 独立增伤'))process.exitCode=1;
      await new Promise(r=>setTimeout(r,300));
      const buffPic=await buffWin.webContents.capturePage();fs.writeFileSync(path.join(diagnosticRoot,'buff-monitor.png'),buffPic.toPNG());
      const lockedMonitor=await buffWin.webContents.executeJavaScript(`(()=>{state.locked=true;render();const panel=getComputedStyle(document.getElementById('panel'));return {background:panel.backgroundColor,border:panel.borderTopColor,shadow:panel.boxShadow,buffsVisible:document.querySelectorAll('.buff:not(.hidden)').length};})()`);
      await new Promise(r=>setTimeout(r,150));
      fs.writeFileSync(path.join(diagnosticRoot,'buff-monitor-locked.png'),(await buffWin.webContents.capturePage()).toPNG());
      const emptyMonitor=await buffWin.webContents.executeJavaScript(`(()=>{state.buffs=[];render();const hidden=getComputedStyle(document.getElementById('empty')).visibility==='hidden';state.locked=false;render();return {lockedEmptyHidden:hidden,unlockedEmptyVisible:getComputedStyle(document.getElementById('empty')).visibility==='visible',unlockedBackground:getComputedStyle(document.getElementById('panel')).backgroundColor};})()`);
      const monitorLockPassed=lockedMonitor.background==='rgba(0, 0, 0, 0)'&&lockedMonitor.border==='rgba(0, 0, 0, 0)'&&lockedMonitor.shadow==='none'&&lockedMonitor.buffsVisible===4&&emptyMonitor.lockedEmptyHidden&&emptyMonitor.unlockedEmptyVisible&&emptyMonitor.unlockedBackground!=='rgba(0, 0, 0, 0)';
      fs.writeFileSync(path.join(diagnosticRoot,'buff-monitor-lock.json'),JSON.stringify({passed:monitorLockPassed,syntheticUiOnly:true,lockedMonitor,emptyMonitor},null,2));
      if(!monitorLockPassed)process.exitCode=1;
      const mechanicFixture=structuredClone(toKagerou(lastView));
      mechanicFixture.Encounter.title='界面测试（合成数据）';
      const mechanicActor=Object.values(mechanicFixture.Combatant)[0];mechanicActor.encdps=mechanicActor.damage/mechanicFixture.Encounter.DURATION;
      mechanicFixture.Combatant['mechanic:xueji']={name:'血祭',Job:'',yyslsMechanic:true,yyslsSchoolColor:'#bd5a76',damage:0,encdps:0,'damage%':'0',yyslsRdps:2500/mechanicFixture.Encounter.DURATION};
      await win.webContents.executeJavaScript(`window.hist.push(${JSON.stringify(mechanicFixture)});window.renderer.update()`);
      const mechanicPreview=await win.webContents.executeJavaScript('({text:document.querySelector("#table").innerText,errors:window.__yyslsErrors||[]})');
      await new Promise(r=>setTimeout(r,300));
      fs.writeFileSync(path.join(diagnosticRoot,'xueji-rd-preview.png'),(await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript('document.querySelectorAll(".tabs span")[1].click()');
      const mechanicQiHidden=await win.webContents.executeJavaScript('!document.querySelector("#table").innerText.includes("血祭")');
      fs.writeFileSync(path.join(diagnosticRoot,'xueji-rd-preview.json'),JSON.stringify({syntheticUiOnly:true,...mechanicPreview,mechanicQiHidden},null,2));
      if(!mechanicPreview.text.includes('血祭')||!mechanicQiHidden||mechanicPreview.errors.length||mechanicPreview.text.includes('NaN'))process.exitCode=1;
      await win.webContents.executeJavaScript(`window.hist.push(${JSON.stringify(toKagerou(lastView))});window.renderer.update()`);
      await win.webContents.executeJavaScript('document.querySelectorAll(".tabs span")[1].click()');
      const qiState=await win.webContents.executeJavaScript('({text:document.body.innerText,tab:window.renderer.current,headers:document.querySelector("#header").innerText,rows:document.querySelectorAll("#table > li").length,errors:window.__yyslsErrors||[]})');
      await new Promise(r=>setTimeout(r,200));
      const qiPic=await win.webContents.capturePage();fs.writeFileSync(path.join(diagnosticRoot,'qi-page.png'),qiPic.toPNG());
      // UI-only numbers never enter the capture/model or a visible game overlay.
      const uiFixture=structuredClone(toKagerou(lastView)),template=Object.values(uiFixture.Combatant)[0];
      uiFixture.Combatant={ui_low:{...template,name:'界面验证-低值',yyslsQiDamage:10,yyslsQiDps:1},ui_high:{...template,name:'界面验证-高值',yyslsQiDamage:1000,yyslsQiDps:100},ui_unknown:{...template,name:'界面验证-未知',yyslsQiDamage:'—',yyslsQiDps:'—'}};
      uiFixture.Encounter.yyslsQiDps=101;
      await win.webContents.executeJavaScript(`window.hist.push(${JSON.stringify(uiFixture)});window.renderer.update()`);
      const qiNumeric=await win.webContents.executeJavaScript('({names:[...document.querySelectorAll("#table .flex-column-i-name")].map(x=>x.textContent),text:document.querySelector("#table").innerText,footer:document.querySelector("#rdps").textContent,gauges:[...document.querySelectorAll("#table .gauge")].map(x=>x.style.width)})');
      await win.webContents.executeJavaScript(`window.hist.push(${JSON.stringify(toKagerou(lastView))});window.renderer.update()`);
      await win.webContents.executeJavaScript('document.querySelectorAll(".tabs span")[0].click()');
      await win.webContents.executeJavaScript('document.querySelector("[data-host=lock]").click()');await new Promise(r=>setTimeout(r,100));const lockCommandVerified=locked;
      await win.webContents.executeJavaScript('document.querySelector("[data-host=lock]").click()');await new Promise(r=>setTimeout(r,100));
      fs.writeFileSync(path.join(diagnosticRoot,`${liveCheck?'live-path-verification':'ui-verification'}.json`),JSON.stringify({...state,buffState,qiState,qiNumeric:{syntheticUiOnly:true,...qiNumeric},lockCommandVerified,model:lastView},null,2));
      const expected=lastView?.encounter?.actors||[];
      if(!/^[\d,.]+$/.test(state.footerValue)||!state.debugPanelHidden||(lastView?.snapshot?.source?.mode==='replay'&&!state.text.includes('回放')))process.exitCode=1;
      if(!state.hiddenTransferColumns||state.schoolColors.some(x=>x.nameColor!=='rgb(255, 255, 255)'||!x.gaugeColor))process.exitCode=1;
      if(!expected.length||state.rows!==Object.keys(toKagerou(lastView).Combatant).length||state.errors.length||buffState.errors.length||!buffState.empty||qiState.errors.length||!qiState.headers.includes('真气输出')||qiState.rows!==expected.length||qiNumeric.names[0]!=='界面验证-高值'||qiNumeric.names[2]!=='界面验证-未知'||!qiNumeric.text.includes('1,000')||qiNumeric.footer!=='101'||qiNumeric.gauges.some(x=>x.includes('NaN'))||!lockCommandVerified||locked)process.exitCode=1;
    }catch(e){fs.writeFileSync(path.join(diagnosticRoot,'verification-error.txt'),e.stack);process.exitCode=1;}finally{app.exit(process.exitCode||0);}},7000);
  }
});
app.on('window-all-closed',()=>app.quit());
