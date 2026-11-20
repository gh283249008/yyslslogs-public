function updateSelection(){const n=document.querySelectorAll('[data-id]:checked').length;document.getElementById('selection-count').textContent=n?'已选 '+n+' 个会话':'未选择';}
const $=id=>document.getElementById(id);let busy=false;
async function refresh(){const data=await generator.scan();$('source-path').textContent=data.root;$('source-path').title=data.root;$('output-path').textContent=data.output;$('output-path').title=data.output;$('list').replaceChildren();
 const days=[...new Set(data.sessions.map(s=>s.date))];for(const day of days){const section=document.createElement('section'),label=document.createElement('label'),all=document.createElement('input');all.type='checkbox';label.append(all,day);const count=document.createElement('span');count.className='day-count';count.textContent=data.sessions.filter(s=>s.date===day).length+' 个会话';label.append(count);section.append(label);
  for(const s of data.sessions.filter(s=>s.date===day)){const row=document.createElement('label');row.className='row';const box=document.createElement('input');box.type='checkbox';box.dataset.id=s.id;box.onchange=()=>{const boxes=[...section.querySelectorAll('[data-id]')];all.checked=boxes.every(b=>b.checked);all.indeterminate=!all.checked&&boxes.some(b=>b.checked);updateSelection();};const info=document.createElement('div'),time=document.createElement('div'),id=document.createElement('div'),tag=document.createElement('span');info.className='session-info';time.className='session-time';time.textContent=s.time+' 开始的会话';id.className='session-id';id.textContent=s.label;id.title=s.label;tag.className='session-tag'+(s.interrupted?' interrupted':'');tag.textContent=s.statisticsOnly?'仅结算统计':s.interrupted?'可恢复打包':'记录完整';info.append(time,id);row.append(box,info,tag);section.append(row);}
  all.onchange=()=>{all.indeterminate=false;section.querySelectorAll('[data-id]').forEach(box=>box.checked=all.checked);updateSelection();};$('list').append(section);
 }if(!days.length)$('list').textContent='没有找到记录。请选择包含各会话文件夹的 sessions 目录。';updateSelection();}
for(const [id,kind]of [['source','source'],['destination','output']])$(id).onclick=async()=>{await generator.choose(kind);await refresh();};
$('refresh').onclick=refresh;$('open').onclick=()=>generator.open();
$('generate').onclick=async()=>{if(busy)return;const ids=[...document.querySelectorAll('[data-id]:checked')].map(e=>e.dataset.id);if(!ids.length){$('status').textContent='请勾选需要生成的日期或会话。';return;}busy=true;document.querySelectorAll('button,input').forEach(e=>e.disabled=true);try{const results=await generator.generate(ids);for(const r of results)if(r.ok)addPackage(r.path);$('status').textContent=results.map(r=>r.ok?'已生成：'+r.path+'（'+(r.bytes/1024**2).toFixed(1)+' MiB）'+(r.warnings.length?'\n已跳过未写完的末尾记录：'+r.warnings.map(w=>w.file).join('、'):''):'失败：'+r.session+'\n'+r.error).join('\n\n');$('progress').value=100;}catch(e){$('status').textContent=e.message;}finally{busy=false;document.querySelectorAll('button,input').forEach(e=>e.disabled=false);syncUpload();}};
generator.progress(p=>{$('progress').value=p.done/p.total*100;$('status').textContent=p.session+'\n正在压缩 '+p.done+'/'+p.total+' · '+p.file;});refresh().catch(e=>$('status').textContent=e.message);

let loggedIn=false,uploading=false;
function addPackage(file){
 let option=[...$('packages').options].find(o=>o.value===file);
 if(!option){option=document.createElement('option');option.value=file;option.textContent=file.split(/[\\\\/]/).pop();$('packages').append(option);}
 option.selected=true;syncUpload();
}
$('packages').onchange=syncUpload;
function syncUpload(){$('upload').disabled=!loggedIn||uploading||![...$('packages').selectedOptions].some(o=>o.value);$('stop-upload').disabled=!uploading;$('logout').disabled=!loggedIn||uploading;$('login').disabled=loggedIn||uploading;$('login-fields').hidden=loggedIn;for(const id of ['generate','source','destination','refresh','select-package'])$(id).disabled=busy||uploading;}
$('login').onclick=async()=>{try{$('login').disabled=true;const u=await generator.login($('username').value,$('password').value);loggedIn=true;$('account').textContent='已登录：'+u.username;await refreshTasks();}catch(e){$('account').textContent=e.message;}finally{$('password').value='';syncUpload();}};
$('logout').onclick=async()=>{try{await generator.logout();}catch(e){$('upload-status').textContent=e.message;}loggedIn=false;$('account').textContent='未登录';$('task-panel').hidden=true;syncUpload();};
$('select-package').onclick=async()=>{const files=await generator.selectPackage();for(const file of files||[])addPackage(file);};
generator.batchResult(result=>{
 const o=[...$('packages').options].find(o=>o.value===result.file);
 if(!o)return;
 const name=result.file.split(/[\\\\/]/).pop();
 o.selected=result.status!=='complete';
 o.textContent=name+' · '+(result.status==='complete'?'报告编号：'+result.id:result.status==='failed'?result.error:'待上传');
});
$('upload').onclick=async()=>{
 const files=[...$('packages').selectedOptions].map(o=>o.value).filter(Boolean);
 if(!files.length||uploading)return;
 uploading=true;$('packages').disabled=true;syncUpload();
 try{
   const results=await generator.batch(files);
   $('transfer-label').textContent='本次上传结束';
   $('upload-status').textContent=results.map(r=>r.file.split(/[\\\\/]/).pop()+' · '+(r.status==='complete'?'报告编号：'+r.id:r.status==='failed'?r.error:'待上传')).join('\n');
 }catch(e){$('upload-status').textContent=friendlyError(e);}
 finally{uploading=false;$('packages').disabled=false;syncUpload();await refreshTasks();}
};
$('stop-upload').onclick=()=>{generator.stopUpload();$('upload-status').textContent='正在停止并清理…';};
generator.uploadProgress(p=>{$('transfer-label').textContent=p.stage==='committing'?'服务器校验中':p.stage==='complete'?'上传完成':'正在上传';$('transfer-percent').textContent=(p.done/p.total*100).toFixed(0)+'%';$('transfer-size').textContent=(p.done/1024**2).toFixed(1)+' / '+(p.total/1024**2).toFixed(1)+' MiB';$('transfer-speed').textContent=p.speed?(p.speed/1024**2).toFixed(2)+' MiB/s':'— MiB/s';if(p.stage==='committing')$('stop-upload').disabled=true;$('upload-progress').value=p.done/p.total*100;$('upload-status').textContent=p.stage==='committing'?'上传已收齐，服务器正在校验和分析…':p.stage==='complete'?'上传完成':'服务器已收到 '+(p.done/p.total*100).toFixed(0)+'% · '+(p.speed/1024**2).toFixed(2)+' MiB/s';});

$('password').addEventListener('keydown',e=>{if(e.key==='Enter'&&!$('login').disabled)$('login').click();});

function friendlyError(e){return e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');}
async function refreshTasks(){if(!loggedIn)return;$('task-panel').hidden=false;try{const tasks=await generator.tasks();$('task-list').replaceChildren();if(!tasks.length){$('task-list').textContent='暂无未完成的上传任务';return;}for(const t of tasks){const row=document.createElement('div');row.className='task-row';const label=document.createElement('span');label.textContent=new Date(t.created).toLocaleString('zh-CN')+' · '+(t.bytes/1024**2).toFixed(1)+' MiB · '+(t.status==='committing'?'分析中':'待完成');const cancel=document.createElement('button');cancel.className='text-button';cancel.textContent='取消并清理';cancel.disabled=uploading||t.status==='committing';cancel.onclick=async()=>{cancel.disabled=true;try{const r=await generator.cancelTask(t.id);if(r.cancelled)$('upload-status').textContent='旧任务已清理，可以重新点击上传。';}catch(e){$('upload-status').textContent=friendlyError(e);}finally{await refreshTasks();}};row.append(label,cancel);$('task-list').append(row);}}catch(e){$('task-list').textContent=friendlyError(e);}}
$('refresh-tasks').onclick=refreshTasks;
