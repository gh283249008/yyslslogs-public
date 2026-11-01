'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
function runtimePaths(base=root){
 const packaged=fs.existsSync(path.join(base,'runtime'));
 return {
  python:packaged?path.join(base,'runtime/python/python.exe'):(process.env.YYSLS_PYTHON||'python.exe'),
  tshark:packaged?path.join(base,'runtime/wireshark/tshark.exe'):(process.env.YYSLS_TSHARK||path.join(process.env.ProgramFiles||'C:\\Program Files','Wireshark/tshark.exe')),
  node:process.execPath,powershell,packaged
 };
}
function childEnv(){
 // The installed application's Electron supplies Node to all collector children.
 // Never inherit a different Python installation or write caches into the install.
 const env={...process.env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};
 env.PSModulePath=path.join(path.dirname(powershell),'Modules')+';'+path.join(process.env.ProgramFiles||'C:\\Program Files','WindowsPowerShell/Modules');
 delete env.PYTHONHOME;delete env.PYTHONPATH;delete env.NODE_OPTIONS;
 if(process.versions.electron)env.ELECTRON_RUN_AS_NODE='1';
 return env;
}
function powershellScriptArgs(file,args=[]){
 const registry=require('../config/platform-scripts.json');
 const entry=Object.values(registry.scripts).find(s=>path.resolve(root,s.file)===path.resolve(file));
 if(registry.schemaVersion!==1||!entry||!Array.isArray(args)||args.length<entry.minArgs||args.length>entry.maxArgs||args.some(a=>typeof a!=='string'||a.includes('\0')))throw Error('Unregistered platform script or invalid arguments');
 // Pass bundled source as a command: no per-user script policy or profile
 // configuration is required. Quote arguments as data, including Chinese paths.
 const quote=value=>"'"+String(value).replace(/'/g,"''")+"'";
 // Encoded scriptblocks do not inherit automatic script-path variables.
 // Bundled scripts use these tokens as expressions (never inside strings).
 const source=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').replace(/\$PSScriptRoot\b/g,()=>quote(path.dirname(file))).replace(/\$PSCommandPath\b/g,()=>quote(path.resolve(file)));
 const command='& {\n'+source+'\n} '+args.map(quote).join(' ');
 return ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')];
}
function run(exe,args,{input='',timeout=20000,env=childEnv(),cwd=root}={}){
 return new Promise((resolve,reject)=>{
  let stdout='',stderr='',settled=false;
  const p=spawn(exe,args,{cwd,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  const finish=(error)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(stdout);};
  const timer=setTimeout(()=>{p.kill();finish(Error('运行环境检查超时：'+path.basename(exe)));},timeout);
  p.stdout.on('data',b=>{stdout+=b;if(stdout.length>4*1024*1024){p.kill();finish(Error('子进程输出过大'));}});
  p.stderr.on('data',b=>{stderr=(stderr+b).slice(-8000);});
  p.on('error',finish);p.on('close',code=>finish(code===0?null:Error(stderr.trim()||`${path.basename(exe)} 退出 ${code}`)));
  p.stdin.on('error',()=>{});p.stdin.end(input);
 });
}
async function capturePermissions(){
 const script="$p=Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\npcap\\Parameters' -ErrorAction SilentlyContinue; $a=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); @{adminOnly=($p.AdminOnly -eq 1);elevated=$a}|ConvertTo-Json -Compress";
 try{return JSON.parse(await run(powershell,['-NoProfile','-NonInteractive','-Command',script]));}
 catch{return {adminOnly:null,elevated:null};}
}
async function checkRuntime({paths=runtimePaths(),runCommand=run,exists=fs.existsSync,permissions=capturePermissions}={}){
 const checks=[];
 for(const [id,exe,args,input] of [
  ['python',paths.python,['-B','-X','utf8','-c','import sys,ctypes,zlib,hashlib,json; print(json.dumps({"version":sys.version,"bits":64 if sys.maxsize>2**32 else 32}))'],''],
  ['schema',paths.python,['-B','-X','utf8',path.join(__dirname,'p1-live-proto.py')],''],
  ['tshark',paths.tshark,['--version'],''],
  ['powershell',powershell,['-NoProfile','-NonInteractive','-Command','[Console]::Write($PSVersionTable.PSVersion.ToString())'],'']
 ]){
  try{const output=await runCommand(exe,args,{input});checks.push({id,ok:true,detail:output.trim().split(/\r?\n/)[0]});}
  catch(e){checks.push({id,ok:false,detail:e.message});}
 }
 let capture;
 const access=await permissions();
 if(access.adminOnly===true&&access.elevated===false){
  capture={ok:false,reason:'administrator-required',needsElevation:true,detail:'Npcap 已设置为仅管理员可用。请以管理员权限重新启动采集器。'};
 }else try{
  const output=await runCommand(paths.tshark,['-D']);
  const interfaces=output.split(/\r?\n/).filter(l=>l.includes('\\Device\\NPF_'));
  capture={ok:interfaces.length>0,reason:interfaces.length?'ready':'no-capture-interface',interfaces:interfaces.length};
 }catch(e){capture={ok:false,reason:'capture-unavailable',detail:e.message};}
 const driverPresent=exists(path.join(process.env.SystemRoot||'C:\\Windows','System32/Npcap/wpcap.dll'));
 return {ok:checks.every(c=>c.ok)&&capture.ok,portableRuntime:checks.every(c=>c.ok),driverPresent,capture,checks};
}
module.exports={runtimePaths,childEnv,run,checkRuntime,powershellScriptArgs,capturePermissions};
if(require.main===module)checkRuntime().then(result=>{console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:2;}).catch(e=>{console.error(e);process.exitCode=1;});
