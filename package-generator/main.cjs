const {app,BrowserWindow,ipcMain,dialog,shell}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const {scanSessions}=require('./sessions.cjs');
const {createUploadPackage}=require('../modules/storage/upload-package.cjs');
const {UploadClient}=require('./upload-client.cjs');
let win,busy=false,root,output,sessions=[],client;const packages=new Set();
app.whenReady().then(()=>{
 root=path.join(app.getPath('appData'),'YyslsLogs/sessions');output=app.isPackaged?path.dirname(process.execPath):path.resolve(__dirname,'..');
 if(process.argv.includes('--verify-generator')){root=process.env.YYSLS_GENERATOR_TEST_ROOT||root;output=process.env.YYSLS_GENERATOR_TEST_OUTPUT||output;}
 client=new UploadClient(path.join(app.getPath('userData'),'upload-resume.json'));
 if(process.argv.includes('--verify-generator')&&process.env.YYSLS_UPLOAD_TEST_ORIGIN){
  const origin=process.env.YYSLS_UPLOAD_TEST_ORIGIN;if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error('Test origin must be loopback');
  client.stateFile=path.join(output,'test-resume.json');client.request=async(route,method='GET',body)=>{const r=await fetch(origin+route,{method,headers:{origin,'content-type':'application/json',...(client.cookie?{cookie:client.cookie,'x-csrf-token':client.csrf}:{})},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error),{status:r.status});if(r.headers.get('set-cookie'))client.cookie=r.headers.get('set-cookie').split(';')[0];return v;};
 }
 win=new BrowserWindow({width:1120,height:900,minWidth:820,minHeight:650,autoHideMenuBar:true,title:'燕云LOGS',icon:path.join(__dirname,'logo.png'),backgroundColor:'#101214',show:!process.argv.includes('--verify-generator'),webPreferences:{backgroundThrottling:false,offscreen:process.argv.includes('--verify-generator'),preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 const listen=(name,fn)=>ipcMain.handle(name,(event,...args)=>{if(event.sender!==win.webContents)throw Error('Invalid sender');return fn(...args);});
 listen('scan',()=>{sessions=scanSessions(root);return {root,output,sessions:sessions.map(({capture,...s})=>s)};});
 listen('choose',async kind=>{if(busy||client.active)return null;const r=await dialog.showOpenDialog(win,{title:kind==='source'?'选择 sessions 记录目录':'选择压缩包保存目录',properties:['openDirectory']});if(!r.canceled){if(kind==='source')root=r.filePaths[0];else output=r.filePaths[0];}return true;});
 listen('generate',async ids=>{
  if(busy||client.active)throw Error('正在生成，请稍候。');if(!Array.isArray(ids)||!ids.length)throw Error('请先勾选日期或会话。');
  const chosen=ids.map(id=>sessions.find(s=>s.id===id));if(chosen.some(s=>!s)||new Set(ids).size!==ids.length)throw Error('选择无效，请刷新列表。');
  busy=true;const results=[];
  try{for(const s of chosen){try{let destination=path.join(output,s.id+'.yylogs');if(fs.existsSync(destination))destination=path.join(output,s.id+'-'+Date.now()+'.yylogs');const {manifest,...result}=await createUploadPackage(s.capture,destination,{recoverTail:true,onProgress:p=>win.webContents.send('progress',{session:s.id,...p})});packages.add(result.path);results.push({session:s.id,ok:true,...result});}catch(e){results.push({session:s.id,ok:false,error:e.message});}}return results;}finally{busy=false;}
 });
 listen('login',(username,password)=>client.login(String(username),String(password)));
 listen('upload-tasks',()=>client.tasks());
 listen('cancel-task',async id=>{const task=(await client.tasks()).find(t=>t.id===id);if(!task)throw Error('任务已结束，请刷新');if(task.status==='committing')throw Error('服务器正在分析，请等待完成');const answer=await dialog.showMessageBox(win,{type:'question',buttons:['保留任务','取消并清理'],defaultId:0,cancelId:0,message:'取消这项未完成的上传？',detail:new Date(task.created).toLocaleString('zh-CN')+' · '+(task.bytes/1024**2).toFixed(1)+' MiB\n只删除此任务的上传暂存，不删除本地文件或已完成报告。'});if(answer.response!==1)return {cancelled:false};return client.cancelTask(id);});
 listen('logout',()=>client.logout());
 listen('select-package',async()=>{if(busy||client.active)return null;const r=await dialog.showOpenDialog(win,{title:'选择 yylogs 压缩包',defaultPath:output,filters:[{name:'yylogs 压缩包',extensions:['yylogs']}],properties:['openFile']});if(r.canceled)return null;packages.add(r.filePaths[0]);return r.filePaths[0];});
 listen('upload',file=>{if(busy||!packages.has(file))throw Error('请先生成或选择压缩包');return client.upload(file,p=>win.webContents.send('upload-progress',p));});
 listen('stop-upload',()=>client.stop());
 listen('open-output',()=>shell.openPath(output));
 win.on('close',event=>{if(busy||client.active){event.preventDefault();dialog.showMessageBox(win,{message:'任务正在进行，请等待生成完成，或先点击停止上传。'});}});
 win.loadFile(path.join(__dirname,'index.html'));
 if(process.argv.includes('--verify-generator'))win.webContents.once('did-finish-load',async()=>{try{
  for(let n=0;n<100&&!await win.webContents.executeJavaScript("document.querySelector('[data-id]')!==null");n++)await new Promise(r=>setTimeout(r,50));
  await new Promise(r=>setTimeout(r,200));fs.writeFileSync(path.join(output,'workbench-initial.png'),(await win.webContents.capturePage()).toPNG());
  const selected=await win.webContents.executeJavaScript("(()=>{document.querySelectorAll('section > label:first-child > input').forEach(e=>e.click());document.querySelectorAll('[data-id]')[2].click();const n=document.querySelectorAll('[data-id]:checked').length;document.querySelector('#generate').click();return n;})()");if(selected!==2)throw Error('Date/session selection failed');
  let done=false;for(let n=0;n<600;n++){done=await win.webContents.executeJavaScript("document.querySelector('#status').textContent.includes('已生成：')");if(done)break;await new Promise(r=>setTimeout(r,50));}if(!done)throw Error('Generation failed');while(await win.webContents.executeJavaScript("document.querySelector('#generate').disabled"))await new Promise(r=>setTimeout(r,50));if(fs.readdirSync(output).filter(f=>f.endsWith('.yylogs')).length!==selected)throw Error('Wrong generated count');
  if(process.env.YYSLS_UPLOAD_TEST_ORIGIN){
   await win.webContents.executeJavaScript("document.querySelector('#username').value='qa_gui';document.querySelector('#password').value='synthetic-gui-password';document.querySelector('#login').click();");
   for(let n=0;n<200&&!await win.webContents.executeJavaScript("document.querySelector('#account').textContent.startsWith('已登录：')");n++)await new Promise(r=>setTimeout(r,50));
   for(let n=0;n<200&&await win.webContents.executeJavaScript("document.querySelector('#upload').disabled");n++)await new Promise(r=>setTimeout(r,50));
   if(await win.webContents.executeJavaScript("document.querySelector('#upload').disabled"))throw Error('Login or generated package selection failed');
   await win.webContents.executeJavaScript("document.querySelector('#upload').click();window.scrollTo(0,0);");
   for(let n=0;n<600&&!await win.webContents.executeJavaScript("document.querySelector('#upload-status').textContent.includes('报告编号：')");n++)await new Promise(r=>setTimeout(r,50));
   if(!await win.webContents.executeJavaScript("document.querySelector('#upload-status').textContent.includes('报告编号：')"))throw Error('GUI upload failed');
   await win.webContents.executeJavaScript("document.querySelector('#upload-status').scrollIntoView();");
  }
  await win.webContents.executeJavaScript('window.scrollTo(0,0)');await new Promise(r=>setTimeout(r,300));
  fs.writeFileSync(path.join(output,'generator.png'),(await win.webContents.capturePage()).toPNG());console.log(JSON.stringify({passed:true,hidden:!win.isVisible(),selected}));app.exit(0);
 }catch(e){console.error(e);app.exit(1);}});
});
app.on('window-all-closed',()=>app.quit());
