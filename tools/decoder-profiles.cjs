'use strict';
// A profile is data signed by the release maintainer. Never load remote scripts or paths.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const channel=require('../config/decoder-channel.json');
const limit=3*1024*1024,sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const digest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const root=path.resolve(__dirname,'..');
const descriptors=['common.proto','client_gate.proto'];
function protocol(base=root){return descriptors.map(n=>sha(fs.readFileSync(path.join(base,'evidence/p0/runtime-rpc-analysis',n+'.descriptor.bin'))));}
function verify(envelope,image,base=root,key=channel.publicKey){
 if(!digest(image)||typeof envelope?.payload!=='string'||envelope.payload.length>8192||typeof envelope.signature!=='string'||!crypto.verify(null,Buffer.from(envelope.payload),key,Buffer.from(envelope.signature,'base64')))throw Error('解码配置签名无效');
 const p=JSON.parse(envelope.payload);
 if(p.format!==1||!['yysls-034','yysls-034-typed'].includes(p.decoderABI) ||p.imageSha256!==image||!/^[-a-z0-9]{1,80}$/.test(p.id)||JSON.stringify(p.descriptors)!==JSON.stringify(protocol(base)))throw Error('解码配置与客户端或协议不符');
 if(p.decoderABI==='yysls-034-typed'){
  const type=p.rpcHandlerType;
  if(!Number.isInteger(type?.expected)||type.expected<1||type.expected>65535||!/^0x[0-9a-f]{1,8}$/.test(type.registeredRva)||Number(type.registeredRva)<4096)throw Error('无效的连接对象类型配置');
 }else if(p.rpcHandlerType!==undefined)throw Error('连接对象类型需要新版读取器');
 for(const k of ['luaRootRva','wrapperVtableRva','rc4VtableRva'])if(!/^0x[0-9a-f]{1,8}$/.test(p.stateOffsets?.[k])||Number(p.stateOffsets[k])<4096)throw Error('解码位置无效');
 if(!digest(p.schema?.sha256)||!Number.isSafeInteger(p.schema.count)||p.schema.count<1||p.schema.count>100000||!/^[-a-z0-9]{1,80}$/.test(p.schema.id))throw Error('字段字典配置无效');
 const local=JSON.parse(fs.readFileSync(path.join(base,'config/schema-profiles.json'))).profiles[p.schema.id];
 if(local&&local.count===p.schema.count&&local.sha256===p.schema.sha256){p.dictionary=fs.readFileSync(path.join(base,local.file));}
 else if(!local&&typeof envelope.dictionary==='string'&&envelope.dictionary.length<=limit){p.dictionary=Buffer.from(envelope.dictionary,'base64');}
 else throw Error('字段字典不匹配');
 if(sha(p.dictionary)!==p.schema.sha256)throw Error('字段字典哈希不匹配');
 return p;
}
async function download(image){
 const res=await fetch(channel.baseUrl+image+'.json',{signal:AbortSignal.timeout(10000),redirect:'error'});
 if(res.status===404)return null;if(!res.ok)throw Error('配置服务 HTTP '+res.status);
 let n=0;const parts=[];for await(const chunk of res.body){n+=chunk.length;if(n>limit)throw Error('解码配置过大');parts.push(chunk);}
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
class ProfileResolver{
 constructor(data,{get=download,check=verify,now=Date.now}={}){Object.assign(this,{dir:path.join(data,'decoder-profiles'),get,check,now});}
 async resolve(image){
  if(!digest(image))throw Error('客户端指纹无效');
  const file=path.join(this.dir,image+'.json');
  if(fs.existsSync(file)){try{const envelope=JSON.parse(fs.readFileSync(file));return {profile:this.check(envelope,image),envelope};}catch{/* Do not use corrupt or untrusted cache. */}}
  if(this.last===image&&this.next>this.now())return null;
  this.last=image;this.next=this.now()+5*60*1000;
  const envelope=await this.get(image);if(!envelope)return null;
  const profile=this.check(envelope,image);fs.mkdirSync(this.dir,{recursive:true});
  const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(envelope),{flag:'wx'});fs.renameSync(tmp,file);
  return {profile,envelope};
 }
}
module.exports={ProfileResolver,verify,protocol,sha};
