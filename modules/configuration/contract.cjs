'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const catalog=require('../../config/catalog.json');
const root=path.resolve(__dirname,'../..');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const demand=(ok,message)=>{if(!ok)throw Error('Invalid configuration: '+message);};
function localPath(base,file){
 demand(typeof file==='string'&&!path.isAbsolute(file),'relative path required');
 const result=path.resolve(base,file),relative=path.relative(base,result);
 demand(relative!==''&&!relative.startsWith('..')&&!path.isAbsolute(relative),'path leaves root');return result;
}
function validate(file,value){
 const schema=catalog.entries[file];demand(schema,'unregistered '+file);demand(object(value),file+' must be object');
 if(schema.schemaVersion!==null)demand(value.schemaVersion===schema.schemaVersion,file+' unsupported version');
 for(const [key,type] of Object.entries(schema.required))demand(type==='array'?Array.isArray(value[key]):type==='object'?object(value[key]):typeof value[key]===type,file+'.'+key);
 if(file==='yanyun-logs/config/cloud.json'||file==='deploy/cloud/cloud-small-server.json'){
  for(const key of Object.keys(schema.required))demand(Number.isSafeInteger(value[key])&&value[key]>0,'cloud limit '+key);
  demand(value.uploadBytes<=8*1024**3&&value.uploadBytes<=value.accountBytes&&value.accountBytes<=value.storageBytes,'cloud upload quota');
 }
 if(file==='config/attribution-baselines.json'){
  demand(Object.hasOwn(value.profiles,value.activeProfileId),'missing active baseline');
  for(const p of Object.values(value.profiles))for(const key of ['physicalPenetration','attributePenetration'])demand(typeof p[key]==='number'&&Number.isFinite(p[key])&&p[key]>=0,'invalid '+key);
 }
 if(file==='config/client-build.json'){
  const seen=new Set();for(const p of [value,...value.profiles]){demand(typeof p.id==='string'&&/^[a-f0-9]{64}$/.test(p.imageSha256)&&!seen.has(p.imageSha256),'client identity');seen.add(p.imageSha256);for(const k of ['luaRootRva','wrapperVtableRva','rc4VtableRva'])demand(/^0x[0-9a-f]+$/i.test(p.stateOffsets?.[k]),'client offset '+k);}
 }
 if(file==='config/schema-profiles.json'){
  demand(Object.hasOwn(value.profiles,value.legacyReplayProfileId),'legacy profile');
  for(const [sha,id] of Object.entries(value.byClientSha256))demand(/^[a-f0-9]{64}$/.test(sha)&&Object.hasOwn(value.profiles,id),'client schema binding');
  for(const p of Object.values(value.profiles)){demand(Number.isInteger(p.count)&&p.count>0&&/^[a-f0-9]{64}$/.test(p.sha256),'schema dictionary metadata');localPath(root,p.file);}
 }
 if(file==='config/rdps-simple-v1.json'){
  demand(value.resource==='HP','attribution resource');for(const [id,r] of Object.entries(value.rules)){demand(/^\d+$/.test(id)&&object(r),'rule identity');if(r.rate!==undefined)demand(Number.isFinite(r.rate)&&r.rate>=0,'rule rate');if(r.maxStacks!==undefined)demand(Number.isInteger(r.maxStacks)&&r.maxStacks>0,'rule stacks');}
  for(const [id,r] of Object.entries(value.rules))if(r.creditProviderId){
   demand(r.creditProviderId.startsWith('mechanic:')&&value.mechanicProviders?.[r.creditProviderId]?.ruleIds?.includes(id),'mechanic provider mapping');
   demand((r.requiresResourceSuccess===true&&Number.isInteger(r.resourceChangeResource))||
    (r.activation==='observed-buff'&&r.requiresResourceSuccess===undefined&&r.resourceChangeResource===undefined&&r.pool==='damage'&&r.maxStacks===1),'mechanic activation condition');
  }
  for(const [hash,ids] of Object.entries(value.compatibleWithoutRules??{}))demand(/^[a-f0-9]{64}$/.test(hash)&&Array.isArray(ids)&&ids.length>0&&new Set(ids).size===ids.length&&ids.every(id=>value.rules[id]?.activation==='observed-buff'),'compatible attribution revision');
 }
 if(file==='config/overlay-buffs.json'){
  demand(new Set(value.slots).size===value.slots.length&&value.slots.every(s=>typeof s==='string'),'buff slots');
  for(const [id,b] of Object.entries(value.buffs))demand(/^\d+$/.test(id)&&value.slots.includes(b.slot)&&typeof b.name==='string'&&typeof b.variant==='string','buff monitor entry');
 }
 if(file==='config/runtime-io.json'){
  for(const [key,max] of Object.entries({rawReadChunkBytes:1048576,rawLineLimitBytes:16777216,pumpBudgetMs:50,pumpIntervalMs:1000,maxPendingProto:4096,ledgerFlushIntervalMs:5000,ledgerFlushBytes:1048576}))demand(Number.isSafeInteger(value[key])&&value[key]>0&&value[key]<=max,'runtime IO limit '+key);
  demand(value.rawReadChunkBytes<=value.rawLineLimitBytes,'read chunk exceeds line bound');
 }
 if(file==='config/worker-protocol.json'){
  demand(Number.isSafeInteger(value.maxBatchJobs)&&value.maxBatchJobs>=1&&value.maxBatchJobs<=128,'worker batch jobs');
  demand(Number.isSafeInteger(value.maxBatchBytes)&&value.maxBatchBytes>=1024&&value.maxBatchBytes<=1048576,'worker batch bytes');
 }
 return value;
}
function load(file,base=root){return validate(file,JSON.parse(fs.readFileSync(localPath(base,file),'utf8').replace(/^\uFEFF/,'')));}
function validateAll(base=root){
 demand(catalog.schemaVersion===1,'catalog version');const values=Object.fromEntries(Object.keys(catalog.entries).map(file=>[file,load(file,base)]));
 const schemas=values['config/schema-profiles.json'],clients=values['config/client-build.json'];
 for(const client of [clients,...clients.profiles])demand(Object.hasOwn(schemas.byClientSha256,client.imageSha256),'client without schema');
 for(const p of Object.values(schemas.profiles))demand(crypto.createHash('sha256').update(fs.readFileSync(localPath(base,p.file))).digest('hex')===p.sha256,'dictionary digest');
 return Object.keys(values);
}
function distribution(product,base=root){
 const cfg=JSON.parse(fs.readFileSync(path.join(base,'config/distributions.json'),'utf8'));
 demand(cfg.schemaVersion===1&&['desktop','analyzer'].includes(product),'distribution version/product');const d=cfg[product];
 for(const key of ['entries','data']){demand(Array.isArray(d?.[key])&&new Set(d[key]).size===d[key].length,'distribution '+key);for(const file of d[key])demand(fs.existsSync(localPath(base,file)),'missing distribution file '+file);}
 return d;
}
module.exports={validate,load,validateAll,localPath,distribution};
if(require.main===module)console.log(JSON.stringify({passed:true,configs:validateAll(),products:['desktop','analyzer'].map(p=>({product:p,...distribution(p)}))}));
