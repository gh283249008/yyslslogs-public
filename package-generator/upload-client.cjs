'use strict';
const fs=require('node:fs'),https=require('node:https'),crypto=require('node:crypto');
const config=require('./upload-client.json');
async function inspectPackage(file){
 const {analysisFile}=await import('../modules/contracts/import-format.mjs');
 const h=await fs.promises.open(file,'r');try{
  const stat=await h.stat(),prefix=Buffer.alloc(12);await h.read(prefix,0,12,0);
  if(prefix.subarray(0,8).toString()!=='YYLOGS1\n')throw Error('不是有效的 yylogs 压缩包');
  const length=prefix.readUInt32LE(8);if(length>2*1024**2||12+length>stat.size)throw Error('压缩包清单无效');
  const header=Buffer.alloc(length);await h.read(header,0,length,12);const m=JSON.parse(header);
  if(m.format!=='yysls-upload'||m.version!==1||!Array.isArray(m.files)||m.files.length>20000)throw Error('压缩包版本无效');
  let bytes=0;const names=new Set();for(const f of m.files){if(!analysisFile(f.path)||names.has(f.path.toLowerCase())||f.encoding!=='gzip'||!Number.isSafeInteger(f.size)||f.size<0||!Number.isSafeInteger(f.rawSize)||f.rawSize<0||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('压缩包文件清单无效');names.add(f.path.toLowerCase());bytes+=f.size;}
  if(!names.has('battles/index.jsonl')||bytes+12+length!==stat.size)throw Error('压缩包不完整');
  return {files:m.files,offset:12+length,bytes,stat,fingerprint:crypto.createHash('sha256').update(header).digest('hex')};
 }finally{await h.close();}
}
class UploadClient{
 constructor(stateFile,{request}={}){this.stateFile=stateFile;this.agent=new https.Agent({keepAlive:true,maxSockets:6});this.cookie='';this.csrf='';this.user=null;this.active=false;this.requests=new Set();this.request=request||this.http.bind(this);}
 http(route,method='GET',body){let current;const promise=new Promise((resolve,reject)=>{
  const bytes=body===undefined?null:Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body));
  const req=https.request(config.origin+route,{method,agent:this.agent,headers:{origin:config.origin,'content-type':Buffer.isBuffer(body)?'application/octet-stream':'application/json',...(bytes?{'content-length':bytes.length}:{}),...(this.cookie?{cookie:this.cookie,'x-csrf-token':this.csrf}:{})}},res=>{
   let data='',size=0;res.on('data',c=>{size+=c.length;if(size>2*1024**2)res.destroy(Error('响应过大'));else data+=c;});res.on('error',reject);res.on('end',()=>{try{const value=JSON.parse(data);if(res.statusCode<200||res.statusCode>=300)throw Object.assign(Error(value.error||'HTTP '+res.statusCode),{status:res.statusCode});if(res.headers['set-cookie'])this.cookie=res.headers['set-cookie'][0].split(';')[0];resolve(value);}catch(e){reject(e);}});
  });current=req;this.requests.add(req);req.on('close',()=>this.requests.delete(req));req.on('error',reject);req.setTimeout(config.requestTimeoutMs,()=>req.destroy(Error('网络请求超时')));req.end(bytes);
 });promise.abort=()=>current?.destroy();return promise;}
 async login(username,password){if(this.active)throw Error('请先停止上传');if(this.user)await this.logout();const r=await this.request('/api/auth/login','POST',{username,password});this.csrf=r.csrf;this.user=r.user;return r.user;}
 async logout(){if(this.active)throw Error('请先停止上传');try{if(this.user)await this.request('/api/auth/logout','POST',{});}finally{this.cookie='';this.csrf='';this.user=null;}}
 async tasks(){if(!this.user)throw Error('请先登录');const r=await this.request('/api/imports');return r.uploads.filter(t=>['uploading','committing'].includes(t.status));}
 async cancelTask(id){if(this.active)throw Error('请先停止当前上传');const task=(await this.tasks()).find(t=>t.id===id);if(!task)throw Error('任务已结束，请刷新');if(task.status==='committing')throw Error('服务器正在分析，请等待完成');await this.request('/api/imports/'+id,'DELETE');const state=this.load();for(const key of Object.keys(state))if(key.startsWith(this.user.id+':')&&state[key]===id)delete state[key];this.save(state);return {cancelled:true};}
 load(){try{return JSON.parse(fs.readFileSync(this.stateFile));}catch{return {};}}
 save(state){fs.mkdirSync(require('node:path').dirname(this.stateFile),{recursive:true});fs.writeFileSync(this.stateFile+'.tmp',JSON.stringify(state));fs.renameSync(this.stateFile+'.tmp',this.stateFile);}
 stop(){if(this.committing)return;this.stopped=true;for(const r of this.requests)r.destroy(Error('已停止上传'));}
 async upload(file,progress=()=>{}){
  if(!this.user)throw Error('请先登录');if(this.active)throw Error('已有上传任务');this.active=true;this.stopped=false;let job,key,state,poll,h;
  try{
   const pack=await inspectPackage(file);h=await fs.promises.open(file,'r');const check=await h.stat();if(check.size!==pack.stat.size||check.mtimeMs!==pack.stat.mtimeMs)throw Error('压缩包发生变化，请重新选择');
   state=this.load();key=this.user.id+':'+pack.fingerprint;
   if(state[key]){try{job=await this.request('/api/imports/'+state[key]);}catch(e){if(e.status!==404&&e.status!==403)throw e;}}
   if(!job||!['uploading','committing','complete'].includes(job.status)){try{job=await this.request('/api/imports','POST',{transport:'chunks-v1',files:pack.files});}catch(e){if(e.status===409&&/现有上传/.test(e.message))throw Error('账号有未完成的上传任务。请在下方“账号上传任务”中查看，取消不再需要的任务后重试。');throw e;}job.status=job.status||'uploading';state[key]=job.id;this.save(state);}
   const start=performance.now(),received=new Set(job.chunks||[]),size=job.chunkBytes,initial=[...received].reduce((n,i)=>n+Math.min(size,pack.bytes-i*size),0);
   const emit=stage=>{const done=[...received].reduce((n,i)=>n+Math.min(size,pack.bytes-i*size),0);progress({stage,done,total:pack.bytes,speed:(done-initial)/Math.max(1,(performance.now()-start)/1000)});};
   if(job.status==='uploading'){
    if(!Number.isSafeInteger(size)||size<1||size>8*1024**2)throw Error('服务器分块设置无效');
    const waiting=new Map();let polling=false;poll=setInterval(async()=>{if(polling||this.stopped)return;polling=true;try{const r=await this.request('/api/imports/'+job.id);for(const i of r.chunks||[])if(!received.has(i)){received.add(i);waiting.get(i)?.();}emit('uploading');}catch{}finally{polling=false;}},config.pollMs);
    let cursor=0,failure;const count=Math.ceil(pack.bytes/size);emit('uploading');
    await Promise.all(Array.from({length:config.concurrency},async()=>{while(!failure&&!this.stopped){const i=cursor++;if(i>=count)return;if(received.has(i))continue;try{
     const bytes=Buffer.alloc(Math.min(size,pack.bytes-i*size));const read=await h.read(bytes,0,bytes.length,pack.offset+i*size);if(read.bytesRead!==bytes.length)throw Error('压缩包读取不完整');
     for(let attempt=0;attempt<config.attempts;attempt++){if(this.stopped)throw Error('已停止上传');try{
      const request=this.request('/api/imports/'+job.id+'/chunks/'+i,'PUT',bytes);try{await Promise.race([request,new Promise(resolve=>waiting.set(i,resolve))]);}finally{request.abort?.();}waiting.delete(i);received.add(i);emit('uploading');break;
     }catch(e){waiting.delete(i);if(attempt===config.attempts-1||[400,401,403,413].includes(e.status))throw e;const r=await this.request('/api/imports/'+job.id);if(r.chunks?.includes(i)){received.add(i);break;}}}
    }catch(e){failure=e;}}}));clearInterval(poll);if(failure)throw failure;if(this.stopped)throw Error('已停止上传');
    const after=await h.stat();if(after.size!==pack.stat.size||after.mtimeMs!==pack.stat.mtimeMs)throw Error('压缩包发生变化');
    this.committing=true;await this.request('/api/imports/'+job.id+'/commit','POST',{});job.status='committing';
   }
   this.committing=job.status==='committing';emit('committing');while(job.status==='committing'){if(this.stopped)throw Error('已停止上传');await new Promise(r=>setTimeout(r,1000));job=await this.request('/api/imports/'+job.id);}
   if(job.status!=='complete')throw Error(job.error||'服务器解析失败');delete state[key];this.save(state);progress({stage:'complete',done:pack.bytes,total:pack.bytes,speed:0,id:job.id});return {id:job.code||job.id,url:config.origin+'/?report='+encodeURIComponent(job.id)};
  }catch(e){if(this.stopped&&job){try{await this.request('/api/imports/'+job.id,'DELETE');delete state[key];this.save(state);}catch{throw Error('已停止。服务器清理未确认，重新登录后可重试，服务器会清理过期暂存。');}}throw e;
  }finally{clearInterval(poll);if(h)await h.close();this.active=false;this.committing=false;}
 }
}
module.exports={UploadClient,inspectPackage};
