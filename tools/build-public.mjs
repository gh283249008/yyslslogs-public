import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';import {rcedit} from 'rcedit';import {nativeClosure} from './desktop-package-lib.mjs';
const name=process.argv[2]||'YyslsLogs-0.3.3-public';if(!/^YyslsLogs-0\.3\.3-[a-z0-9-]+$/.test(name))throw Error('Invalid release name');
const root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'release',name),resources=path.join(out,'resources');
if(fs.existsSync(out))throw Error('Use a fresh release directory');
const python=process.env.YYSLS_BUILD_PYTHON,wireshark=process.env.YYSLS_BUILD_WIRESHARK;
if(!python||!wireshark)throw Error('Set YYSLS_BUILD_PYTHON and YYSLS_BUILD_WIRESHARK');
const copy=(from,to)=>{fs.mkdirSync(path.dirname(to),{recursive:true});fs.cpSync(from,to,{recursive:true,filter:p=>!p.split(/[\\/]/).includes('node_modules')&&!p.split(/[\\/]/).includes('__pycache__')});};
fs.cpSync(path.join(root,'app/node_modules/electron/dist'),out,{recursive:true,filter:p=>!p.endsWith('default_app.asar')});
fs.renameSync(path.join(out,'electron.exe'),path.join(out,'燕云 Logs.exe'));
for(const name of ['app','modules','tools','config','scripts','evidence','package-generator','vendor'])copy(path.join(root,name),path.join(resources,name));
const msg=path.join(root,'tools/node_modules/@msgpack/msgpack');for(const file of ['package.json','LICENSE','dist.cjs']){const dest=path.join(resources,'tools/node_modules/@msgpack/msgpack',file);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.cpSync(path.join(msg,file),dest,{recursive:true});}
execFileSync(path.join(python,'python.exe'),[path.join(root,'tools/package-python-runtime.py'),python,path.join(resources,'runtime/python')],{windowsHide:true,stdio:'inherit'});
const deps=nativeClosure(wireshark,['tshark.exe','dumpcap.exe']);for(const file of [...deps.files,'COPYING.txt','README.txt'])copy(path.join(wireshark,file),path.join(resources,'runtime/wireshark',file));
for(const file of ['vcruntime140.dll','vcruntime140_1.dll'])copy(path.join(python,file),path.join(resources,'runtime/wireshark',file));copy(path.join(process.env.SystemRoot,'System32/msvcp140.dll'),path.join(resources,'runtime/wireshark/msvcp140.dll'));
await rcedit(path.join(out,'燕云 Logs.exe'),{icon:path.join(root,'app/assets/logo.ico'),'file-version':'0.3.3','product-version':'0.3.3','requested-execution-level':'asInvoker'});
fs.copyFileSync(path.join(out,'燕云 Logs.exe'),path.join(out,'yylogs上传器.exe'));await rcedit(path.join(out,'yylogs上传器.exe'),{icon:path.join(root,'package-generator/logo.ico'),'version-string':{ProductName:'燕云LOGS',FileDescription:'燕云LOGS 记录与上传',OriginalFilename:'yylogs上传器.exe'}});
for(const file of ['使用说明.txt','THIRD-PARTY.txt','LICENSE'])copy(path.join(root,file),path.join(out,file));
console.log(out);
