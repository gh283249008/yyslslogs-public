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
 if(file==='config/encounter-display-names.json')require('../domain/encounter-display-name.cjs').validateDisplayNames(value);
 if(file==='yanyun-logs/config/activity.json'){
  demand(Number.isSafeInteger(value.hitWindowMs)&&value.hitWindowMs>0&&value.hitWindowMs<=1000,'activity hit window');
  const ids=new Set(),pairs=new Set();
  for(const r of value.rules){
   demand(object(r)&&typeof r.id==='string'&&r.id.length>0&&!ids.has(r.id),'activity rule identity');ids.add(r.id);
   demand(Number.isSafeInteger(r.buffNo)&&r.buffNo>0&&Number.isSafeInteger(r.sourceSkillId)&&r.sourceSkillId>0,'activity state identity');
   const pair=r.buffNo+':'+r.sourceSkillId;demand(!pairs.has(pair),'duplicate activity state');pairs.add(pair);
   demand(Array.isArray(r.hitSkillIds)&&r.hitSkillIds.length>0&&new Set(r.hitSkillIds).size===r.hitSkillIds.length&&r.hitSkillIds.every(n=>Number.isSafeInteger(n)&&n>0),'activity hit skills');
  }
 }
 if(file==='yanyun-logs/config/cloud.json'||file==='deploy/cloud/cloud-small-server.json'){
  for(const key of Object.keys(schema.required))demand(Number.isSafeInteger(value[key])&&value[key]>0,'cloud limit '+key);
  demand(value.uploadBytes<=8*1024**3&&value.uploadBytes<=value.accountBytes&&value.accountBytes<=value.storageBytes,'cloud upload quota');
 }
 if(file==='config/attribution-baselines.json'){
  demand(Object.hasOwn(value.profiles,value.activeProfileId),'missing active baseline');
  for(const p of Object.values(value.profiles))for(const key of ['physicalPenetration','attributePenetration'])demand(typeof p[key]==='number'&&Number.isFinite(p[key])&&p[key]>=0,'invalid '+key);
 }
 if(file==='config/personal-buff-baselines.json'){
  demand(value.attackBaselineMode===undefined||value.attackBaselineMode==='per-channel-original-credit-post-weight-v1','personal attack baseline mode');
  demand(value.combatMode===undefined||value.combatMode==='pve-only','personal combat scope');
  if(value.hitConditions!==undefined)demand(object(value.hitConditions)&&JSON.stringify(value.hitConditions.archerWeakpointFlags)==='[1024,2048]','personal archer flags');
  const positive=n=>Number.isSafeInteger(n)&&n>0;
  const list=a=>Array.isArray(a)&&a.length>0&&a.every(positive)&&new Set(a).size===a.length;
  for(const [id,r]of Object.entries(value.rules)){
   demand(/^\d+$/.test(id)&&typeof r.name==='string'&&positive(r.maxStacks)&&list(r.levels)&&/^[a-f0-9]{64}$/.test(r.rowSha256),'personal rule identity');
   demand(r.mutexFamily===undefined||positive(r.mutexFamily),'personal exclusive family');
   demand(r.partialBaseline===undefined||r.partialBaseline===true,'personal partial baseline');
   demand(r.holder===undefined||['source','target'].includes(r.holder),'personal effect holder');
   demand(r.sourceBound===undefined||r.holder==='target'&&typeof r.sourceBound==='boolean','personal source binding');
   demand(r.classification===undefined||['副本机制增伤','副本机制减伤'].includes(r.classification),'personal classification');
   const parts=r.components??[r];demand(Array.isArray(parts)&&parts.length>0,'personal components');
   for(const p of parts){
    demand(object(p)&&['damage','attack','separate','penetration','typedDamage','critical','skillFormula','archer','preDamage'].includes(p.pool)&&Number.isFinite(p.rate),'personal coefficient');
    demand(r.classification==='副本机制减伤'?p.pool==='separate'&&p.rate<0&&p.rate>-1:p.rate>0||(p.pool==='critical'&&p.channel==='directBashProbability'&&p.dynamicMagnitude==='effective-bash-capped'&&p.rate===-.12),'personal coefficient sign and pool');
    demand(p.dynamicMagnitude===undefined||p.dynamicMagnitude==='effective-bash-capped'&&p.pool==='critical'&&['directCritProbability','directBashProbability'].includes(p.channel)&&Math.abs(p.rate)===.12,'personal dynamic probability');
    demand(p.pool==='skillFormula'?['physicalPower','attributePower','numericalRatio'].includes(p.channel):p.pool==='critical'?['forcedCritProbability','physicalDamage','bashDamage','addedCritProbability','directCritProbability','directBashProbability'].includes(p.channel):['penetration','typedDamage'].includes(p.pool)?['physical','A','B','C','D','E'].includes(p.channel):p.channel===undefined,'personal penetration channel');
    demand(p.magnitudeBasis===undefined||p.magnitudeBasis==='authorized-dynamic-maximum','personal magnitude basis');
    demand(p.scaleByStacks===undefined||typeof p.scaleByStacks==='boolean','personal stack policy');
    demand(p.attackChannels===undefined||(p.pool==='attack'&&Array.isArray(p.attackChannels)&&p.attackChannels.length>0&&new Set(p.attackChannels).size===p.attackChannels.length&&p.attackChannels.every(c=>['physical','A','B','C','D','E'].includes(c))),'personal attack channels');
    if(value.attackBaselineMode&&p.pool==='attack')demand(p.attackChannels!==undefined,'personal attack channels required');
    demand(p.conditionPolicy===undefined||p.conditionPolicy==='authorized-martial-skill-estimate','personal condition estimate');
    function condition(c,depth=0){demand(object(c)&&depth<8,'personal condition');
    for(const [key,v]of Object.entries(c)){
     if(key==='resourceCode')demand(v===10,'personal HP resource');
     else if(key==='targetObservedNpc')demand(v===true,'personal positive observed state');
     else if(key==='pveTarget')demand(v===true&&value.combatMode==='pve-only','personal PVE assumption');
     else if(key==='targetBoss'||key==='targetWeak')demand(v===true,'personal positive target state');
     else if(key==='damageType'||key==='calcpointType')demand(positive(v),'personal hit type');
     else if(key==='all'||key==='any'){demand(Array.isArray(v)&&v.length>0&&v.length<=32,'personal condition group');v.forEach(n=>condition(n,depth+1));}
     else if(key==='sourceBuffs'||key==='targetBuffs')demand(Array.isArray(v)&&v.length>0&&v.every(r=>object(r)&&positive(r.buffNo)&&typeof r.sourceBound==='boolean'&&(r.minStacks===undefined||positive(r.minStacks))),'personal observed Buff condition');
     else if(key==='sourceBuffsAbsent')demand(list(v),'personal explicit absent Buff condition');
     else if(key==='unresolvedPredicate')demand(typeof v==='string'&&v.length>0&&v.length<200,'personal unresolved predicate');
     else if(key==='hitResult')demand(['crit','bash'].includes(v),'personal observed hit result');
     else if(key==='targetPlayer'||key==='targetNonBossMonster')demand(v===true,'personal entity classification');
     else if(['sourceShield','targetShield','targetFlying','targetControlled','targetBeHit','archerWeakpoint'].includes(key))demand(v===true,'personal direct state');
     else if(key==='sourceOwnBuffsAbsent')demand(list(v),'personal own absent state');
     else if(key==='sourceResourceMin')demand(object(v)&&Object.keys(v).length===2&&v.code===53&&v.value===1,'personal source resource');
     else if(key==='sourceSelfShield')demand(v===true,'personal self shield');
     else if(key==='sourceCritThreshold')demand(v===75||v===-75,'personal critical threshold');
     else if(key==='targetQiPercent')demand(Number.isFinite(v)&&v!==0&&Math.abs(v)<=100,'personal qi threshold');
     else if(key==='targetHpPercent'||key==='sourceHpPercent')demand(object(v)&&Object.keys(v).every(k=>['minExclusive','maxInclusive'].includes(k))&&Number.isFinite(v.maxInclusive)&&v.maxInclusive>=0&&v.maxInclusive<=100&&(v.minExclusive===undefined||Number.isFinite(v.minExclusive)&&v.minExclusive>=0&&v.minExclusive<v.maxInclusive),'personal observed health range');
     else {demand(['calcpointClassAny','calcpointTagsAny','calcpointTagsNone','calcpointIds','skillIds','skillClasses','targetNpcTemplateAny','sourceKungfuAny','sourceSchoolAny'].includes(key)&&list(v),'personal predicate');
      if(key==='skillClasses')demand(object(value.skillClasses),'personal skill dictionary');}
    }
    }condition(p.condition);
   }
  }
  if(value.skillClasses!==undefined)demand(object(value.skillClasses)&&Object.entries(value.skillClasses).every(([id,n])=>/^\d+$/.test(id)&&Number.isSafeInteger(n)&&n>=0),'personal skill classes');
  if(value.schemaProfiles!==undefined){
   demand(object(value.schemaProfiles)&&list(value.versionedRuleIds)&&value.versionedRuleIds.every(id=>Object.hasOwn(value.rules,id)),'personal schema variants');
   for(const [preset,p]of Object.entries(value.schemaProfiles)){
    demand(/^\d+$/.test(preset)&&positive(Number(preset))&&object(p)&&object(p.ruleOverrides)&&object(p.calcpointOverrides)&&['legacy-table','unverified'].includes(p.skillClassesBasis),'personal schema profile');
    demand(Object.keys(p.ruleOverrides).every(id=>value.versionedRuleIds.includes(Number(id))),'personal schema rule binding');
    validate(file,{...value,rules:p.ruleOverrides,schemaProfiles:undefined,versionedRuleIds:undefined});
    for(const [id,t]of Object.entries(p.calcpointOverrides))demand(/^\d+$/.test(id)&&Array.isArray(t)&&t.length===4&&t.slice(0,3).every(v=>v===null||Number.isSafeInteger(v)&&v>=0)&&Array.isArray(t[3])&&t[3].every(v=>Number.isSafeInteger(v)&&v>=0),'personal schema calcpoint');
    if(p.skillClassesBasis==='unverified')demand(object(p.skillClasses)&&Object.keys(p.skillClasses).length===0,'unverified skill classes must stay empty');
   }
  }
 }
 if(file==='config/client-build.json'){
  const seen=new Set();for(const p of [value,...value.profiles]){demand(typeof p.id==='string'&&/^[a-f0-9]{64}$/.test(p.imageSha256)&&!seen.has(p.imageSha256),'client identity');seen.add(p.imageSha256);for(const k of ['luaRootRva','wrapperVtableRva','rc4VtableRva'])demand(/^0x[0-9a-f]+$/i.test(p.stateOffsets?.[k]),'client offset '+k);}
 }
 if(file==='config/schema-profiles.json'){
  demand(Object.hasOwn(value.profiles,value.legacyReplayProfileId),'legacy profile');
  for(const [sha,id] of Object.entries(value.byClientSha256))demand(/^[a-f0-9]{64}$/.test(sha)&&Object.hasOwn(value.profiles,id),'client schema binding');
  for(const [data,bindings] of Object.entries(value.byGameDataSha256||{})){
   demand(/^[a-f0-9]{64}$/.test(data)&&object(bindings)&&Object.keys(bindings).length>0,'game data schema binding');
   for(const [client,id] of Object.entries(bindings))demand(Object.hasOwn(value.byClientSha256,client)&&Object.hasOwn(value.profiles,id),'client data schema profile');
  }
  for(const p of Object.values(value.profiles)){demand(Number.isInteger(p.count)&&p.count>0&&/^[a-f0-9]{64}$/.test(p.sha256),'schema dictionary metadata');localPath(root,p.file);}
 }
 if(file==='config/rdps-simple-v1.json'){
  for(const [id,r]of Object.entries(value.rules||{}))if(r.pool==='separate'||r.attributePenetration!==undefined||r.replacesPersonalBaseline!==undefined||r.requiresNormalDamage!==undefined){
   demand(id==='200200'&&r.holder==='target'&&r.family==='qi-imbalance'&&r.pool==='separate'&&r.rate===.1&&r.requiresWeak===true&&r.requiresNormalDamage===true&&r.replacesPersonalBaseline===true&&JSON.stringify(r.levels)==='[1]','qi imbalance independent attribution');
   demand(object(r.attributePenetration)&&r.attributePenetration.channel==='A'&&r.attributePenetration.points===20&&Object.keys(r.attributePenetration).length===2,'qi imbalance authorized penetration');
   const personal=JSON.parse(fs.readFileSync(path.join(root,'config/personal-buff-baselines.json'),'utf8')).rules[id];
   demand(personal?.holder==='target'&&personal.maxStacks===1&&JSON.stringify(personal.levels)==='[1]'&&personal.components?.length===2,'qi imbalance personal replacement identity');
   demand(personal.components.every(p=>p.scaleByStacks===false&&p.condition?.damageType===1&&p.condition.targetWeak===true&&Object.keys(p.condition).length===2),'qi imbalance shared gates');
   demand(personal.components[0].pool==='separate'&&personal.components[0].rate===r.rate&&personal.components[1].pool==='penetration'&&personal.components[1].channel==='A'&&personal.components[1].rate===20,'qi imbalance personal replacement coefficients');
  }
  if(value.recordedDamage){
   const p=value.recordedDamage;
   demand(p.id&&typeof p.enabled==='boolean'&&Number.isInteger(p.buffNo)&&Number.isInteger(p.prerequisiteBuffNo),'recorded identity');
   demand(Number.isFinite(p.rate)&&p.rate>0&&p.rate<=1,'recorded rate');
   demand(Number.isInteger(p.maxGapDelayMs)&&p.maxGapDelayMs>0&&p.maxGapDelayMs<=2000&&Number.isInteger(p.maxWindows)&&p.maxWindows>0&&p.maxWindows<=10000,'recorded bounds');
   demand(p.maxContextEvents===undefined||Number.isInteger(p.maxContextEvents)&&p.maxContextEvents>0&&p.maxContextEvents<=100000,'recorded context bound');
   demand(p.requiredValidation==='server-total-count-min-max-and-unique-exact-residual'&&object(p.models),'recorded validation');
   if(p.partition!==undefined)demand(object(p.partition)&&typeof p.partition.enabled==='boolean'&&p.partition.mode==='observed-self-or-roster-hits'&&p.partition.requireWholeFightClosure===true&&Number.isInteger(p.partition.maxExcludedHits)&&p.partition.maxExcludedHits>0&&p.partition.maxExcludedHits<=100000,'recorded residual partition evidence');
   if(p.wholeSource!==undefined)demand(object(p.wholeSource)&&typeof p.wholeSource.enabled==='boolean'&&p.wholeSource.mode==='single-validated-model-complete-source'&&Array.isArray(p.wholeSource.skillIds)&&p.wholeSource.skillIds.length===1&&p.wholeSource.skillIds[0]==='23700043'&&Object.values(p.models).some(m=>m.skillId==='23700043')&&Number.isSafeInteger(p.wholeSource.maxOrigins)&&p.wholeSource.maxOrigins>0&&p.wholeSource.maxOrigins<=100000,'recorded complete source evidence');
   if(p.wholeSource?.retainObservedExcluded!==undefined)demand(typeof p.wholeSource.retainObservedExcluded==='boolean'&&(!p.wholeSource.retainObservedExcluded||p.partition?.enabled===true),'recorded complete source excluded evidence');
   if(p.pendingMembership!==undefined)demand(object(p.pendingMembership)&&typeof p.pendingMembership.enabled==='boolean'&&p.pendingMembership.mode==='independent-ordinary-skill-settlement'&&Number.isSafeInteger(p.pendingMembership.maxHits)&&p.pendingMembership.maxHits>0&&p.pendingMembership.maxHits<=100000&&Number.isSafeInteger(p.pendingMembership.maxPendingHits)&&p.pendingMembership.maxPendingHits>0&&p.pendingMembership.maxPendingHits<=10000,'settled hit membership evidence');
   if(p.seriesModels!==undefined){
    demand(object(p.seriesModels),'recorded series models');
    const skills=new Set(Object.values(p.models).map(m=>m.skillId)),markers=new Set();
    for(const [id,m]of Object.entries(p.seriesModels)){
     demand(/^\d+$/.test(id)&&!Object.hasOwn(p.models,id)&&/^\d+$/.test(m.skillId)&&!skills.has(m.skillId),'recorded series identity');skills.add(m.skillId);
     demand(Number.isFinite(m.ratio)&&m.ratio>0&&m.ratio<=1&&Number.isSafeInteger(m.ticks)&&m.ticks>0&&m.ticks<=3&&Number.isSafeInteger(m.tickIntervalMs)&&m.tickIntervalMs>0&&m.tickIntervalMs*m.ticks<=3000,'recorded series bounds');
     demand(Number.isSafeInteger(m.markerBuffNo)&&m.markerBuffNo>0&&!markers.has(m.markerBuffNo)&&m.markerBuffNo!==Number(id)&&Number.isFinite(m.markerDurationSeconds)&&m.markerDurationSeconds>0,'recorded series marker');markers.add(m.markerBuffNo);
     demand(Number.isSafeInteger(m.calcpointClass)&&m.calcpointClass>0&&Number.isSafeInteger(m.excludedCalcpointTag)&&m.excludedCalcpointTag>0&&m.maxRecordDistance===1,'recorded series eligibility');
    }
   }
   for(const [id,m]of Object.entries(p.models)){
    demand(/^\d+$/.test(id)&&/^\d+$/.test(m.skillId)&&Number.isFinite(m.ratio)&&m.ratio>0&&m.ratio<=1,'recorded model');
    const modes=[m.calcpointTag!==undefined,m.normalDamageOnly!==undefined,m.calcpointIds!==undefined];
    demand(modes.filter(Boolean).length===1,'recorded hit eligibility mode');
    if(m.calcpointTag!==undefined)demand(Number.isSafeInteger(m.calcpointTag)&&m.calcpointTag>0,'recorded calcpoint tag');
    if(m.normalDamageOnly!==undefined)demand(m.normalDamageOnly===true,'recorded normal branch');
    if(m.excludedCalcpointTag!==undefined)demand(m.normalDamageOnly===true&&Number.isSafeInteger(m.excludedCalcpointTag)&&m.excludedCalcpointTag>0,'recorded excluded calcpoint tag');
    if(m.calcpointIds!==undefined)demand(Array.isArray(m.calcpointIds)&&m.calcpointIds.length>0&&m.calcpointIds.every(n=>Number.isSafeInteger(n)&&n>0)&&new Set(m.calcpointIds).size===m.calcpointIds.length&&m.rejectBoundaryHits===true,'recorded exact calcpoints and boundary evidence');
    if(m.rejectBoundaryHits!==undefined)demand(typeof m.rejectBoundaryHits==='boolean','recorded boundary rejection');
    if(m.prestart!==undefined)demand(object(m.prestart)&&typeof m.prestart.enabled==='boolean'&&m.prestart.mode==='complete-in-battle-origins'&&Number.isSafeInteger(m.prestart.maxOriginsPerWindow)&&m.prestart.maxOriginsPerWindow>0&&m.prestart.maxOriginsPerWindow<=10000&&id==='10270252'&&m.calcpointTag===1121&&!m.starts&&!m.includeRemove&&!m.rejectBoundaryHits,'recorded prestart evidence');
    if(m.normalDamageOnly)demand(Array.isArray(m.requiredSourceBuffs)&&m.requiredSourceBuffs.length>0&&Array.isArray(m.starts)&&m.starts.length>0,'recorded branch evidence');
    if(m.requiredSourceBuffs!==undefined)demand(Array.isArray(m.requiredSourceBuffs)&&m.requiredSourceBuffs.length>0&&m.requiredSourceBuffs.every(n=>Number.isInteger(n)&&n>0)&&new Set(m.requiredSourceBuffs).size===m.requiredSourceBuffs.length,'recorded source conditions');
    if(m.includeRemove!==undefined)demand(typeof m.includeRemove==='boolean','recorded remove boundary');
    if(m.starts!==undefined){
     demand(Array.isArray(m.starts)&&m.starts.length>0&&Array.isArray(m.requiredSourceBuffs),'recorded starts');
     for(const s of m.starts){
      demand(Number.isInteger(s.buffNo)&&s.buffNo>0&&['before','after'].includes(s.order)&&typeof s.cause==='string'&&s.cause.length>0&&typeof s.includeApply==='boolean','recorded predecessor');
      demand(s.durationSeconds===undefined||Number.isFinite(s.durationSeconds)&&s.durationSeconds>0,'recorded predecessor duration');
      demand(s.removalStacks===undefined||Number.isInteger(s.removalStacks)&&s.removalStacks>0,'recorded predecessor stacks');
      demand(s.requireParentRemoval===undefined||typeof s.requireParentRemoval==='boolean','recorded parent removal');
     }
     demand(new Set(m.starts.map(s=>s.buffNo)).size===m.starts.length,'recorded ambiguous starts');
    }
   }
  }
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
