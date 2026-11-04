'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const bytes=fs.readFileSync(path.join(__dirname,'../../config/personal-buff-baselines.json'));
const DATA=JSON.parse(bytes),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
const hasPersonalRule=buffNo=>Object.hasOwn(DATA.rules,buffNo);
const hasSourceBoundStacks=buffNo=>DATA.rules[buffNo]?.sourceBound===true&&DATA.rules[buffNo].maxStacks>1;
const contextIds=new Set(),absenceIds=new Set(),ownAbsenceIds=new Set();
function collectContext(c){for(const key of ['sourceBuffs','targetBuffs'])for(const r of c[key]||[])contextIds.add(r.buffNo);for(const id of c.sourceOwnBuffsAbsent||[]){contextIds.add(id);ownAbsenceIds.add(id);}for(const id of c.sourceBuffsAbsent||[]){contextIds.add(id);absenceIds.add(id);}for(const key of ['all','any'])for(const node of c[key]||[])collectContext(node);}
for(const rules of [DATA.rules,...Object.values(DATA.schemaProfiles||{}).map(p=>p.ruleOverrides||{})])for(const rule of Object.values(rules))for(const part of rule.components||[rule])collectContext(part.condition||{});
const hasContextRule=buffNo=>contextIds.has(buffNo);
const versionedRules=new Set(DATA.versionedRuleIds||[]),versionedCalcpoints=new Set(Object.values(DATA.schemaProfiles||{}).flatMap(p=>Object.keys(p.calcpointOverrides||{})));
function calcpointRecord(id,schemaPreset){
 if(versionedCalcpoints.has(String(id))){const profile=DATA.schemaProfiles?.[schemaPreset];return profile?(profile.calcpointOverrides?.[id]??DATA.calcpoints[id]??null):null;}
 return DATA.calcpoints[id]??null;
}
function matchesCondition(c,rawCalcpointId,rawSkillId,context){
 const profile=DATA.schemaProfiles?.[context.schemaPreset],cp=calcpointRecord(rawCalcpointId,context.schemaPreset);
 const skillClass=DATA.schemaProfiles?(profile?.skillClassesBasis==='legacy-table'?DATA.skillClasses?.[rawSkillId]:profile?.skillClasses?.[rawSkillId]):DATA.skillClasses?.[rawSkillId];
 const checks=[
  [c.archerWeakpoint,context.damageFlags,v=>Number.isSafeInteger(v)&&v>=0&&(DATA.hitConditions?.archerWeakpointFlags||[]).length>0&&DATA.hitConditions.archerWeakpointFlags.every(mask=>(v&mask)===mask)],
  [c.sourceShield,context.sourceAttributes?.totalShieldValue,v=>Number.isFinite(v)&&v>0],
  [c.targetShield,context.targetAttributes?.totalShieldValue,v=>Number.isFinite(v)&&v>0],
  [c.targetFlying,context.targetAttributes?.flying,v=>v===true],
  [c.targetControlled,context.targetAttributes?.controlled,v=>v===true],
  [c.targetBeHit,context.targetAttributes?.beHit,v=>v===true],
  [c.sourceResourceMin,context.sourceAttributes?.combatResources?.[c.sourceResourceMin?.code],v=>Number.isFinite(v)&&v>=c.sourceResourceMin.value],
  [c.targetPlayer,DATA.combatMode==='pve-only'?false:null,v=>v===true],
  [c.targetNonBossMonster,context.targetAttributes?.isBoss===true?false:context.targetAttributes?.isMonster===true&&context.targetAttributes?.isBoss===false?true:null,v=>v===true],
  [c.sourceCritThreshold,context.sourceAttributes?.finalEffectiveCritProbability,v=>Number.isFinite(v)&&v>=0&&v<=1&&(c.sourceCritThreshold>0?v*100<c.sourceCritThreshold:v*100>=-c.sourceCritThreshold)],
  [c.unresolvedPredicate,null,()=>false],
  [c.hitResult,context.hitResult,v=>v===c.hitResult],
  [c.sourceSelfShield,context.sourceAttributes?.selfShieldValue,v=>Number.isFinite(v)&&v>0],
  [c.sourceHpPercent,context.sourceAttributes?.hpPercent,v=>Number.isFinite(v)&&v>=0&&v<=100&&v<=c.sourceHpPercent.maxInclusive&&(c.sourceHpPercent.minExclusive===undefined||v>c.sourceHpPercent.minExclusive)],
  [c.targetQiPercent,context.targetWeak===true?0:context.targetAttributes?.qiPercent,v=>Number.isFinite(v)&&v>=0&&v<=100&&(c.targetQiPercent>0?v<c.targetQiPercent:v>-c.targetQiPercent)],
  [c.damageType,cp?.[0],v=>v===c.damageType],
  [c.calcpointClassAny,cp?.[1],v=>c.calcpointClassAny.includes(v)],
  [c.calcpointType,cp?.[2],v=>v===c.calcpointType],
  [c.calcpointTagsAny,cp?.[3],v=>Array.isArray(v)&&v.some(t=>c.calcpointTagsAny.includes(t))],
  [c.calcpointTagsNone,cp?.[3],v=>Array.isArray(v)&&!v.some(t=>c.calcpointTagsNone.includes(t))],
  [c.pveTarget,DATA.combatMode==='pve-only'?true:null,v=>v===true],
  [c.targetBoss,context.targetAttributes?.isBoss,v=>v===true],
  [c.targetWeak,context.targetWeak,v=>v===c.targetWeak],
  [c.sourceKungfuAny,context.currentKungfu,v=>c.sourceKungfuAny.includes(v)],
  [c.sourceSchoolAny,context.currentKungfu==null?context.encounterSchool?.liupaiId:null,v=>c.sourceSchoolAny.includes(v)],
  [c.targetHpPercent,context.targetAttributes?.hpPercent,v=>Number.isFinite(v)&&v>=0&&v<=100&&v<=c.targetHpPercent.maxInclusive&&(c.targetHpPercent.minExclusive===undefined||v>c.targetHpPercent.minExclusive)],
  [c.calcpointIds,rawCalcpointId,v=>c.calcpointIds.includes(v)],
  [c.skillIds,rawSkillId,v=>c.skillIds.includes(v)],
  [c.skillClasses,skillClass,v=>c.skillClasses.includes(v)],
  [c.targetNpcTemplateAny,context.targetAttributes?.npcTemplateNo,v=>c.targetNpcTemplateAny.includes(v)],
  [c.targetObservedNpc,Number.isSafeInteger(context.targetAttributes?.npcTemplateNo)&&context.targetAttributes.npcTemplateNo>0?true:null,v=>v===true]
 ].filter(([required])=>required!==undefined);
 if(checks.some(([,v,test])=>v!==null&&v!==undefined&&!test(v)))return false;
 const values=checks.map(([,v])=>v===null||v===undefined?null:true);
 for(const buffNo of c.sourceOwnBuffsAbsent||[]){
  const relevant=context.effects.filter(e=>e.targetActorHash===context.sourceActorHash&&e.buffNo===buffNo);
  values.push(relevant.some(e=>e.sourceActorHash===context.sourceActorHash)?false:relevant.some(e=>!e.sourceActorHash)?null:context.sourceAttributes?.absentOwnPersonalBuffs?.includes(buffNo)?true:null);
 }
 for(const buffNo of c.sourceBuffsAbsent||[]){
  const active=context.effects.some(e=>e.targetActorHash===context.sourceActorHash&&e.buffNo===buffNo);
  values.push(active?false:context.sourceAbsentBuffs?.includes(buffNo)?true:null);
 }
 for(const [key,holder]of [['sourceBuffs',context.sourceActorHash],['targetBuffs',context.targetActorHash]])for(const required of c[key]||[]){
  const match=context.effects.some(e=>e.targetActorHash===holder&&e.buffNo===required.buffNo&&
   (!required.sourceBound||e.sourceActorHash===context.sourceActorHash)&&
   (required.minStacks===undefined||Number.isInteger(e.charge_level)&&e.charge_level>=required.minStacks));
  // A positive matching observation is sufficient. Missing state is unknown,
  // never proof that a Buff is absent or owned by somebody else.
  values.push(match?true:null);
 }
 for(const node of c.all||[])values.push(matchesCondition(node,rawCalcpointId,rawSkillId,context));
 if(c.any){const branch=c.any.map(node=>matchesCondition(node,rawCalcpointId,rawSkillId,context));values.push(branch.includes(true)?true:branch.includes(null)?null:false);}
 return values.includes(false)?false:values.includes(null)?null:true;
}
function observedPersonalBaseline({effects,excludedBaselineBuffNos=new Set(),sourceActorHash,targetActorHash=null,targetAttributes={},sourceAttributes={},targetWeak=null,currentKungfu=null,encounterSchool=null,sourceAbsentBuffs=[],schemaPreset=null,rawCalcpointId,rawSkillId,damageFlags=null}){
 const resultCode=Number.isSafeInteger(damageFlags)&&damageFlags>=0?Math.floor(damageFlags/16777216):null;
 const hitResult=({0:'normal',1:'abrasion',2:'bash',4:'crit',8:'critHeal',16:'evade'})[resultCode]??null;
 const totals={critical:{forcedCritProbability:0,physicalDamage:0,bashDamage:0,addedCritProbability:0,directCritProbability:0,directBashProbability:0},damage:0,attack:0,attackByChannel:{physical:0,A:0,B:0,C:0,D:0,E:0},separate:0,archer:0,preDamageMultiplier:1,penetration:{physical:0,A:0,B:0,C:0,D:0,E:0},typedDamage:{physical:0,A:0,B:0,C:0,D:0,E:0}},entries=[],issues=[],seen=new Set(),groups=new Map();
 for(const e of effects){
  if(!DATA.rules[e.buffNo]||excludedBaselineBuffNos.has(e.buffNo))continue;
  const profile=DATA.schemaProfiles?.[schemaPreset];
  if(versionedRules.has(e.buffNo)&&!profile){issues.push('personal_buff_schema_unknown:'+e.buffNo);continue;}
  const rule=profile?.ruleOverrides?.[e.buffNo]??DATA.rules[e.buffNo];
  const holder=rule.holder==='target'?targetActorHash:sourceActorHash;
  if(!holder||e.targetActorHash!==holder)continue;
  if(rule.sourceBound&&e.sourceActorHash!==sourceActorHash){if(!e.sourceActorHash)issues.push('personal_buff_source_unknown:'+e.buffNo);continue;}
  if(e.ambiguousStackOwner){issues.push('personal_buff_stack_owner_unknown:'+e.buffNo);continue;}
  const key=String(e.buffNo)+':'+e.targetActorHash+':'+(e.buffInstanceHash??'');
  if(seen.has(key))continue;seen.add(key);
  if(!rule.levels.includes(e.level)){issues.push('personal_buff_level_unknown:'+e.buffNo);continue;}
  const stacks=rule.maxStacks===1?1:e.charge_level;
  if(!Number.isInteger(stacks)||stacks<1||stacks>rule.maxStacks){issues.push('personal_buff_stacks_unknown:'+e.buffNo);continue;}
  for(const [index,part]of (rule.components||[rule]).entries()){
   const c=part.condition||{},eligible=matchesCondition(c,rawCalcpointId,rawSkillId,{effects,sourceActorHash,targetActorHash,targetAttributes,sourceAttributes,targetWeak,currentKungfu,encounterSchool,sourceAbsentBuffs,schemaPreset,hitResult,damageFlags});
   if(eligible===false)continue;
   if(eligible===null){issues.push('personal_buff_hit_condition_unknown:'+e.buffNo);continue;}
   if(rule.partialBaseline)issues.push('personal_buff_partial_baseline:'+e.buffNo);
   let rate=part.rate*(part.scaleByStacks===false?1:stacks);
   if(part.dynamicMagnitude==='effective-bash-capped'){
    const probability=sourceAttributes.finalEffectiveBashProbability;
    if(!Number.isFinite(probability)||probability<0||probability>1){issues.push('personal_buff_dynamic_attribute_unknown:'+e.buffNo);continue;}
    rate=Math.sign(rate)*Math.min(Math.abs(rate),probability);
   }
   const entry={buffNo:e.buffNo,name:rule.name,pool:part.pool,rate,stacks,level:e.level,sourceActorHash:e.sourceActorHash??null,
    ...(rule.holder?{holder:rule.holder,targetActorHash:e.targetActorHash,sourceBound:!!rule.sourceBound}:{}),
    ...(rule.classification?{classification:rule.classification}:{}),
    ...(part.conditionPolicy?{conditionPolicy:part.conditionPolicy}:{}),
    ...(['penetration','typedDamage','critical','skillFormula'].includes(part.pool)?{channel:part.channel}:{}),
    ...(part.magnitudeBasis?{magnitudeBasis:part.magnitudeBasis}:{}),
    ...(part.pool==='attack'&&part.attackChannels?{attackChannels:part.attackChannels}:{}),
    ...(c.pveTarget?{targetBasis:'authorized-pve-only-assumption'}:{}),
    conditionBasis:c.all||c.any||c.sourceBuffs||c.targetBuffs||c.targetNpcTemplateAny||c.targetObservedNpc?'decoded-conditions-and-observed-context':c.skillClasses||c.skillIds?'decoded-skill-table':Object.keys(c).some(k=>k!=='resourceCode')?'decoded-calcpoint-table':'observed-buff-table',
    ...(rule.components?{component:index,passiveId:part.passiveId??null}:{})};
   if(rule.mutexFamily){const key=rule.mutexFamily+':'+part.pool+':'+(part.channel||''),old=groups.get(key);if(!old||rate>old.rate)groups.set(key,entry);}
   else entries.push(entry);
  }
 }
 entries.push(...groups.values());
 for(const entry of entries){if(entry.pool==='preDamage'){totals.preDamageMultiplier*=1+entry.rate;}else if(entry.pool==='skillFormula'){totals.skillFormula??={physicalPower:0,attributePower:0,numericalRatio:0};totals.skillFormula[entry.channel]+=entry.rate;}else if(['penetration','typedDamage','critical'].includes(entry.pool))totals[entry.pool][entry.channel]=entry.channel==='forcedCritProbability'?Math.max(totals[entry.pool][entry.channel],entry.rate):totals[entry.pool][entry.channel]+entry.rate;else totals[entry.pool]+=entry.rate;
  if(entry.pool==='attack')for(const channel of entry.attackChannels??[])totals.attackByChannel[channel]+=entry.rate;
 }
 return {...totals,entries,issues,complete:false};
}
// cond_attack=[1,0,0]: normal damage type only; the zero class/type
// predicates are wildcards. Missing table rows remain unknown.
function normalDamageEligible(rawCalcpointId,schemaPreset=null){
 const value=calcpointRecord(rawCalcpointId,schemaPreset)?.[0];
 return typeof value==='number'?value===1:null;
}
function calcpointType(rawCalcpointId,schemaPreset=null){return calcpointRecord(rawCalcpointId,schemaPreset)?.[2]??null;}
function calcpointClass(rawCalcpointId,schemaPreset=null){return calcpointRecord(rawCalcpointId,schemaPreset)?.[1]??null;}
function calcpointHasTag(rawCalcpointId,tag,schemaPreset=null){const tags=calcpointRecord(rawCalcpointId,schemaPreset)?.[3];return Array.isArray(tags)?tags.includes(tag):null;}
module.exports={hasPersonalRule,hasSourceBoundStacks,hasContextRule,hasOwnAbsenceRule:id=>ownAbsenceIds.has(id),hasAbsenceRule:id=>absenceIds.has(id),observedPersonalBaseline,normalDamageEligible,calcpointType,calcpointClass,calcpointHasTag,sha256};
