'use strict';
const {ACTIVE_PROFILE,F,POLICY,policySha256,registry,personalBuffs,kungfuChannels,finite,time}=require('./context.cjs');
function simpleHitCredit({amount,sourceActorHash,targetActorHash,effects,targetAttributes={},currentKungfu=null,targetWeak=null,personalDamageBonus=null,conditionalDamageEligible=null,rawCalcpointId=null,rawSkillId=null,encounterSchool=null}){
 if(!finite(amount)||amount<0||!Array.isArray(effects))throw Error('invalid_simple_hit');
 if(conditionalDamageEligible===null)conditionalDamageEligible=personalBuffs.normalDamageEligible(rawCalcpointId);
 const issues=[],chosen=new Map();
 // Explicit user policy: a concrete liupai cannot change during this fight.
 // This remains separate from the actually observed currentKungfu field.
 const fixedSchool=POLICY.fixedEncounterSchool?.enabled&&encounterSchool?.basis==='fixed-encounter-school'?encounterSchool:null;
 for(const effect of effects){
  const rule=POLICY.rules[effect.buffNo];if(!rule)continue;
  if(effect.targetActorHash!==(rule.holder==='source'?sourceActorHash:targetActorHash))continue;
  if(rule.requiresResourceSuccess&&effect.resourceChangeSuccess!==true){if(effect.resourceChangeSuccess!==false)issues.push('resource_success_unknown:'+effect.buffNo);continue;}
  const stacks=rule.maxStacks?effect.charge_level:1;
  if(!Number.isInteger(stacks)||stacks<1||stacks>(rule.maxStacks||1)){issues.push('unknown_stacks:'+effect.buffNo);continue;}
  if(effect.ambiguousStackOwner){issues.push('ambiguous_stack_owner:'+effect.buffNo);continue;}
  const e={...effect,sourceActorHash:rule.creditProviderId||effect.sourceActorHash,rule,stacks};
  const old=chosen.get(rule.family);
  // Strongest active member wins. Equal, different sources are ambiguous, not
  // guessed as last-applier; report the family as skipped on this hit.
  const score=(rule.priority||0)*100+(rule.rate||rule.resistancePerStack*stacks||rule.defensePerStack*stacks||0);
  if(!old||score>old.score)chosen.set(rule.family,{score,e,ambiguous:false});
  else if(score===old.score&&e.sourceActorHash!==old.e.sourceActorHash)old.ambiguous=true;
 }
 if(chosen.get('attack')?.e.rule.providerOnly&&chosen.get('attack').e.sourceActorHash!==sourceActorHash)issues.push('source_only_attack_variant');
 const active=[];
 for(const {e,ambiguous} of chosen.values()){
  if(ambiguous){issues.push('ambiguous_provider:'+e.rule.family);continue;}
  if(!e.sourceActorHash){issues.push('missing_provider:'+e.rule.family);continue;}
  if(e.rule.providerOnly&&e.sourceActorHash!==sourceActorHash){issues.push('provider_only:'+e.buffNo);continue;}
  if(e.rule.requiresWeak&&targetWeak!==true){if(targetWeak===null)issues.push('target_weak_unknown:'+e.buffNo);continue;}
  active.push(e);
 }
 const personalBaselineKnown=personalDamageBonus!==null;
 if(personalBaselineKnown&&(!finite(personalDamageBonus)||personalDamageBonus<0))throw Error('invalid_personal_damage_bonus');
 // This is the additional personal SUM, excluding the explicit self effects below.
 // Missing is an approximation input, never an observed zero.
 const observedPersonal=personalBuffs.observedPersonalBaseline({effects,sourceActorHash,rawCalcpointId});
 issues.push(...observedPersonal.issues);
 // An explicit complete aggregate already contains these personal SUM buffs.
 // Otherwise retain the observed subset while declaring the remainder unknown.
 if(!personalBaselineKnown){personalDamageBonus=observedPersonal.damage;issues.push('personal_damage_bonus_unobserved');}
 const pools=[],resistance=[],attributeResistance=[],defense=[],damagePool=[],attackPool=[];
 const entry=(e,weight)=>({providerId:e.sourceActorHash,beneficiaryId:sourceActorHash,ruleId:String(e.buffNo),effectId:e.buffInstanceHash,name:e.rule.name,weight});
 for(const e of active){
  const r=e.rule;
  let rate=r.rate;
  if(r.dotRatePerStack){
   rate=0;
   const kind=personalBuffs.calcpointType(rawCalcpointId);
   if(conditionalDamageEligible===true&&kind===2){
    rate=r.dotRatePerStack*e.stacks;
    if(r.dotConditionalRatePerStack){
     const matches=currentKungfu!==null?r.kungfu.includes(currentKungfu):fixedSchool?(r.conditionalSchoolIds||[]).includes(fixedSchool.liupaiId):null;
     if(matches){rate+=r.dotConditionalRatePerStack*e.stacks;if(currentKungfu===null)issues.push('conditional_extra_fixed_school:'+e.buffNo);}
     else if(matches===null)issues.push('conditional_extra_not_applied:'+e.buffNo);
    }
   }else if(conditionalDamageEligible===true&&kind===1&&rawCalcpointId===r.specialCalcpointId)rate=r.specialRatePerStack*e.stacks;
   else if(conditionalDamageEligible===null||kind===null)issues.push('jingshen_damage_condition_unknown:'+e.buffNo);
  }
  if(r.conditionalRate){
   const matches=currentKungfu!==null?r.kungfu.includes(currentKungfu):fixedSchool?(r.conditionalSchoolIds||[]).includes(fixedSchool.liupaiId):null;
   const eligibility=conditionalDamageEligible===null&&fixedSchool&&POLICY.fixedEncounterSchool.unknownHpDamageType==='normal-damage-estimate'?true:conditionalDamageEligible;
   if(matches===true&&eligibility===true){rate+=r.conditionalRate;if(currentKungfu===null)issues.push('conditional_extra_fixed_school:'+e.buffNo);if(conditionalDamageEligible===null)issues.push('conditional_extra_hp_type_estimate:'+e.buffNo);}
   else if(matches===null||(matches&&eligibility===null))issues.push('conditional_extra_not_applied:'+e.buffNo);
  }
  // Juren has two independent components: target property resistance and a
  // conditional SUM bonus. Collect both; the SUM branch must not hide resistance.
  if(r.attributeResistanceReduction)attributeResistance.push({e,reduction:r.attributeResistanceReduction});
  if(r.pool==='damage'){if(rate>0)damagePool.push({e,reduction:rate});continue;}
  if(r.family==='attack'){attackPool.push({e,reduction:rate});continue;}
  if(r.resistancePerStack||r.fullStackResistance){const reduction=(r.resistancePerStack||0)*e.stacks+(e.stacks===r.maxStacks?r.fullStackResistance||0:0);if(reduction)resistance.push({e,reduction});}
  if(r.defensePerStack)defense.push({e,reduction:r.defensePerStack*e.stacks});
  if(r.rate&&e.sourceActorHash!==sourceActorHash){
   pools.push({id:r.family,baseline:1,externalSum:rate,logGain:Math.log1p(rate),entries:[entry(e,1)]});
  }
 }
 const externalDamage=damagePool.filter(x=>x.e.sourceActorHash!==sourceActorHash),externalRate=externalDamage.reduce((s,x)=>s+x.reduction,0),selfRate=damagePool.filter(x=>x.e.sourceActorHash===sourceActorHash).reduce((s,x)=>s+x.reduction,0);
 if(externalRate){const baseline=1+personalDamageBonus+selfRate;pools.push({id:'damage',baseline,externalSum:externalRate,logGain:Math.log1p(externalRate/baseline),entries:externalDamage.map(x=>entry(x.e,x.reduction/externalRate))});}
 const externalAttack=attackPool.filter(x=>x.e.sourceActorHash!==sourceActorHash),attackRate=externalAttack.reduce((s,x)=>s+x.reduction,0);
 if(attackRate){const baseline=1+observedPersonal.attack+attackPool.filter(x=>x.e.sourceActorHash===sourceActorHash).reduce((s,x)=>s+x.reduction,0);pools.push({id:'attack',baseline,externalSum:attackRate,logGain:Math.log1p(attackRate/baseline),entries:externalAttack.map(x=>entry(x.e,x.reduction/attackRate))});}
 function sharedPool(items,kind){
  const external=items.filter(x=>x.e.sourceActorHash!==sourceActorHash);if(!external.length)return;
  const all=items.reduce((s,x)=>s+x.reduction,0),ext=external.reduce((s,x)=>s+x.reduction,0);
  let multiplier;
  if(kind==='resistance'){
   if(!finite(targetAttributes.baseResistance)){issues.push('missing_base_resistance');return;}
   const signal=targetAttributes.baseResistance-all-ACTIVE_PROFILE.physicalPenetration;
   multiplier=F(signal)/F(signal+ext);
  }else{
   const d=targetAttributes.baseDefense;
   if(!finite(d)||d<=0||all>=1){issues.push('missing_or_invalid_base_defense');return;}
   multiplier=(d*(1-all+ext))/(d*(1-all));
  }
  pools.push({id:kind,logGain:Math.log(multiplier),entries:external.map(x=>entry(x.e,x.reduction/ext))});
 }
 sharedPool(resistance,'resistance');sharedPool(defense,'defense');
 const propertyExternal=attributeResistance.filter(x=>x.e.sourceActorHash!==sourceActorHash);
 if(propertyExternal.length){
  const school=fixedSchool?{channel:fixedSchool.channel,attributeName:fixedSchool.attributeName,basis:fixedSchool.basis,liupaiId:fixedSchool.liupaiId,kungfuIds:fixedSchool.kungfuIds}:kungfuChannels.resolveKungfuChannel({rawSkillId,rawCalcpointId,currentKungfu});
  const channels=school.channel?[school.channel]:['A','B','C','D','E'];
  const values=channels.map(k=>targetAttributes.attributeResistanceWithEffects?.[k]);
  // A known school uses only its observed resistance. Unknown schools retain
  // the v6 conservative fallback, requiring all five actual observations.
  if(!school.channel)issues.push('juren_school_unknown_conservative_fallback');
  if(!values.every(finite))issues.push('missing_attribute_resistance:200176');
  else {
   const externalSum=propertyExternal.reduce((s,x)=>s+x.reduction,0);
   const multipliers=values.map(v=>{const signal=v-ACTIVE_PROFILE.attributePenetration;return F(signal)/F(signal+externalSum);});
   const multiplier=Math.min(...multipliers),selected=multipliers.indexOf(multiplier);
   pools.push({id:'attribute-resistance',baseline:values[selected],externalSum,channelPolicy:school.channel?'skill-school-observed-resistance':'minimum-observed-gain-across-five',selectedChannel:channels[selected],school,logGain:Math.log(multiplier),entries:propertyExternal.map(x=>entry(x.e,x.reduction/externalSum))});
   if(!school.channel&&!values.every(v=>Math.abs(v-values[0])<1e-9))issues.push('juren_attribute_channel_conservative_minimum');
   issues.push('juren_whole_hp_resistance_estimate');
  }
 }
 const logGain=pools.reduce((s,p)=>s+p.logGain,0),gain=amount*(-Math.expm1(-logGain));
 const credit=pools.flatMap(p=>p.entries.map(e=>({...e,poolId:p.id,creditedDamage:logGain?gain*p.logGain/logGain*e.weight:0})));
 const credited=credit.reduce((s,e)=>s+e.creditedDamage,0),conservationError=credited-gain;
 if(!finite(gain)||gain<0||gain>amount||credit.some(e=>!finite(e.creditedDamage)||e.creditedDamage<0)||Math.abs(conservationError)>1e-9*Math.max(1,amount))throw Error('invalid_simple_allocation');
 return {status:'estimated',gain,credit,issues:[...new Set(issues)],allocation:{policy:POLICY.allocationPolicy,personalBaselineKnown,personalDamageBonus,observedPersonalBaseline:observedPersonal,selfDamageBonus:selfRate,damageWithoutExternal:amount-gain,conservationError,pools:pools.map(p=>({id:p.id,baseline:p.baseline,externalSum:p.externalSum,...(p.channelPolicy?{channelPolicy:p.channelPolicy,selectedChannel:p.selectedChannel,school:p.school}:{}),effectiveMultiplier:Math.exp(p.logGain),logWeight:logGain?p.logGain/logGain:0,creditedDamage:logGain?gain*p.logGain/logGain:0}))}};
}

module.exports={POLICY,policySha256,simpleHitCredit};
