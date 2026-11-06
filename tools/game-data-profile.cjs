'use strict';
// Read the selected game's existing HD manifest only. No process, network or shell access.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function manifestPath(exe){
 const full=path.resolve(exe);
 if(!/[\\/]Engine[\\/]Binaries[\\/]Win64rh?[\\/]yysls\.exe$/i.test(full))throw Error('unsupported_game_install_layout');
 const root=path.resolve(path.dirname(full),'../../..');
 return {root,file:path.join(root,'LocalData','Patch','HD','v2','MANIFEST')};
}
function readGameDataProfile(exe){
 try{
  const {root,file}=manifestPath(exe),realRoot=fs.realpathSync(root),realFile=fs.realpathSync(file);
  if(!realFile.toLowerCase().startsWith((realRoot+path.sep).toLowerCase()))throw Error('game_manifest_outside_install');
  const before=fs.statSync(realFile,{bigint:true});
  if(!before.isFile()||before.size<=0n||before.size>8n*1024n*1024n)throw Error('invalid_game_manifest_size');
  const bytes=fs.readFileSync(realFile),after=fs.statSync(realFile,{bigint:true});
  if(BigInt(bytes.length)!==before.size||['dev','ino','size','mtimeNs','ctimeNs'].some(k=>before[k]!==after[k]))throw Error('game_manifest_changed_during_read');
  return Object.freeze({manifestSha256:crypto.createHash('sha256').update(bytes).digest('hex')});
 }catch{return Object.freeze({manifestSha256:null});}
}
function assertSameGameData(before,after){
 if(before.manifestSha256!==after.manifestSha256)throw Error('初始化期间游戏数据补丁发生变化，请等待重新初始化');
}
module.exports={manifestPath,readGameDataProfile,assertSameGameData};
