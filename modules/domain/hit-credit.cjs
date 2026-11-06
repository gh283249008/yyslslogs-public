'use strict';
const {ACTIVE_PROFILE,F,POLICY,policySha256,registry,personalBuffs,kungfuChannels,damageComposition,attackWeights,finite,time}=require('./context.cjs');
const gameDataVersions=require('./game-data-version.cjs');
gameDataVersions.validatePolicy(POLICY);
function simpleHitCredit({gameData,amount,sourceActorHash,targetActorHash,effects,targetAttributes={},sourceAttributes={},sourceAbsentBuffs=[],currentKungfu=null,targetWeak=null,personalDamageBonus=null,conditionalDamageEligible=null,rawCalcpointId=null,rawSkillId=null,encounterSchool=null,schemaPreset=null,damageFlags=null}){
 if(!finite(amount)||amount<0||!Array.isArray(effects))throw Error('invalid_simple_hit');
 if(conditionalDamageEligible===null)conditionalDamageEligible=personalBuffs.normalDamageEligible(rawCalcpointId,schemaPreset);
 const issues=[],chosen=new Map();
 // Explicit user policy: a concrete liupai cannot change during this fight.
 // This remains separate from the actually observed currentKungfu field.
 const fixedSchool=POLICY.fixedEncounterSchool?.enabled&&encounterSchool?.basis==='fixed-encounter-school'?encounterSchool:null;
 const school=fixedSchool||kungfuChannels.resolveEncounterSchool({rawSkillId,rawCalcpointId,currentKungfu});
 const composition=school?damageComposition.byLiupai[school.liupaiId]:null;
 const attackWeight=school?attackWeights.byLiupai[school.liupaiId]:null;
 for(const effect of effects){
  const baseRule=POLICY.rules[effect.buffNo];if(!baseRule)continue;
  if(effect.targetActorHash!==(baseRule.holder==='source'?sourceActorHash:targetActorHash))continue;
  const rule=gameDataVersions.resolveRule(baseRule,effect.buffNo,gameData);
  if(!rule){issues.push('game_data_version_unknown:'+effect.buffNo);continue;}
  if(rule.levels&&!rule.levels.includes(effect.level)){issues.push('unknown_level:'+effect.buffNo);continue;}
  if(rule.requiresNormalDamage){const eligible=personalBuffs.normalDamageEligible(rawCalcpointId,schemaPreset);if(eligible!==true){if(eligible===null)issues.push('normal_damage_unknown:'+effect.buffNo);continue;}}
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
 // A selected shared effect owns both its self baseline and external credit.
 // Remove its personal copy only after provider/level/type/weak gates pass.
 // Unknown or ambiguous providers keep the observed personal denominator.
 const replaced=new Set(active.filter(e=>e.rule.replacesPersonalBaseline).map(e=>e.buffNo));
 const observedPersonal=personalBuffs.observedPersonalBaseline({effects,excludedBaselineBuffNos:replaced,sourceActorHash,targetActorHash,targetAttributes,sourceAttributes,targetWeak,currentKungfu,encounterSchool:fixedSchool,sourceAbsentBuffs,schemaPreset,rawCalcpointId,rawSkillId,damageFlags});
 issues.push(...observedPersonal.issues);
 // An explicit complete aggregate already contains these personal SUM buffs.
 // Otherwise retain the observed subset while declaring the remainder unknown.
 if(!personalBaselineKnown){personalDamageBonus=observedPersonal.damage;issues.push('personal_damage_bonus_unobserved');}
 const pools=[],resistance=[],attributeResistance=[],defense=[],damagePool=[],attackPool=[],separatePool=[];
 if(observedPersonal.archer>0)pools.push({id:'archer',baseline:1+observedPersonal.archer,externalSum:0,logGain:0,entries:[]});
 if(observedPersonal.preDamageMultiplier>1)pools.push({id:'pre-damage',baseline:observedPersonal.preDamageMultiplier,externalSum:0,logGain:0,entries:[]});
 // W_ATK_SCALE/PRO_ATK_*_SCALE snapshots are separate damage-side factors.
 // No external rule currently removes one: retain it in both counterfactuals.
 for(const [channel,rate]of Object.entries(observedPersonal.typedDamage))if(rate>0)pools.push({id:'typed-damage-'+channel,baseline:1+rate,externalSum:0,logGain:0,entries:[]});
 // SKCALC power / SKILL numerical adjustments are distinct from AA attack.
 // Retain both sides without inventing channel shares or doubling the gain.
 for(const [channel,rate]of Object.entries(observedPersonal.skillFormula||{}))if(rate>0)pools.push({id:'skill-formula-'+channel,baseline:1+rate,externalSum:0,logGain:0,entries:[]});
 const entry=(e,weight)=>({providerId:e.sourceActorHash,beneficiaryId:sourceActorHash,ruleId:String(e.buffNo),effectId:e.buffInstanceHash,name:e.rule.name,weight});
 for(const e of active){
  const r=e.rule;
  let rate=r.rate;
  if(r.dotRatePerStack){
   rate=0;
   const kind=personalBuffs.calcpointType(rawCalcpointId,schemaPreset);
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
  if(r.attributePenetration){
   if(!school)issues.push('penetration_school_composition_unknown');
   else if(school.channel===r.attributePenetration.channel)attributeResistance.push({e,reduction:r.attributePenetration.points,syntheticPenetration:true});
  }
  if(r.pool==='separate'){separatePool.push({e,reduction:rate});continue;}
  if(r.pool==='damage'){if(rate>0)damagePool.push({e,reduction:rate});continue;}
  if(r.family==='attack'){attackPool.push({e,reduction:rate});continue;}
  if(r.resistancePerStack||r.fullStackResistance){const reduction=(r.resistancePerStack||0)*e.stacks+(e.stacks===r.maxStacks?r.fullStackResistance||0:0);if(reduction)resistance.push({e,reduction});}
  if(r.defensePerStack)defense.push({e,reduction:r.defensePerStack*e.stacks});
  if(r.rate&&e.sourceActorHash!==sourceActorHash){
   pools.push({id:r.family,baseline:1,externalSum:rate,logGain:Math.log1p(rate),entries:[entry(e,1)]});
  }
 }
 // Shared independent damage adds to the existing positive/negative personal
 // independent pool. It never enters SUM and never multiplies raw damage.
 if(separatePool.length||observedPersonal.entries.some(e=>e.pool==='separate')){
  const external=separatePool.filter(x=>x.e.sourceActorHash!==sourceActorHash);
  const externalSum=external.reduce((n,x)=>n+x.reduction,0);
  const baseline=1+observedPersonal.separate+separatePool.filter(x=>x.e.sourceActorHash===sourceActorHash).reduce((n,x)=>n+x.reduction,0);
  if(baseline>0)pools.push({id:'separate-damage',baseline,externalSum,logGain:Math.log1p(externalSum/baseline),entries:external.map(x=>entry(x.e,x.reduction/externalSum))});
  else issues.push('personal_separate_baseline_nonpositive');
 }
 const externalDamage=damagePool.filter(x=>x.e.sourceActorHash!==sourceActorHash),externalRate=externalDamage.reduce((s,x)=>s+x.reduction,0),selfRate=damagePool.filter(x=>x.e.sourceActorHash===sourceActorHash).reduce((s,x)=>s+x.reduction,0);
 if(externalRate){const baseline=1+personalDamageBonus+selfRate;pools.push({id:'damage',baseline,externalSum:externalRate,logGain:Math.log1p(externalRate/baseline),entries:externalDamage.map(x=>entry(x.e,x.reduction/externalRate))});}
 const externalAttack=attackPool.filter(x=>x.e.sourceActorHash!==sourceActorHash),attackRate=externalAttack.reduce((s,x)=>s+x.reduction,0);
 if(attackRate){
  if(!attackWeight)issues.push('attack_school_composition_unknown');
  else {
   const baseline=1+observedPersonal.attack+attackPool.filter(x=>x.e.sourceActorHash===sourceActorHash).reduce((s,x)=>s+x.reduction,0);
   const components={};let creditWeight=0;
   for(const channel of ['physical','attribute']){
    const externalSum=externalAttack.filter(x=>x.e.rule.attackChannels.includes(channel)).reduce((s,x)=>s+x.reduction,0);
    const originalFraction=externalSum/attackRate,share=attackWeight[channel];
    const attributeChannel=channel==='physical'?'physical':school.channel;
    const personalBaseline=observedPersonal.attackByChannel[attributeChannel];
    if(externalSum&&!finite(personalBaseline))throw Error('personal_attack_channel_unknown');
    const selfBaseline=attackPool.filter(x=>x.e.sourceActorHash===sourceActorHash&&x.e.rule.attackChannels.includes(channel)).reduce((s,x)=>s+x.reduction,0);
    const channelBaseline=1+(personalBaseline??0)+selfBaseline;
    components[channel]={baseline:channelBaseline,personalBaseline:personalBaseline??0,selfBaseline,attributeChannel,externalSum,originalFraction,share,logGain:externalSum?Math.log1p(externalSum/channelBaseline):0};
    creditWeight+=originalFraction*share;
   }
   pools.push({id:'attack',baseline,externalSum:attackRate,logGain:Math.log1p(attackRate/baseline),creditWeight,components,entries:externalAttack.map(x=>entry(x.e,x.reduction/attackRate))});
  }
 }
 function sharedPool(items,kind){
  const external=items.filter(x=>x.e.sourceActorHash!==sourceActorHash);if(!external.length)return;
  if(kind==='resistance'&&!composition){issues.push('penetration_school_composition_unknown');return;}
  const all=items.reduce((s,x)=>s+x.reduction,0),ext=external.reduce((s,x)=>s+x.reduction,0);
  let multiplier;
  if(kind==='resistance'){
   if(!finite(targetAttributes.baseResistance)){issues.push('missing_base_resistance');return;}
   // Personal penetration is retained on both sides of external removal.
   const signal=targetAttributes.baseResistance-all-ACTIVE_PROFILE.physicalPenetration-observedPersonal.penetration.physical;
   multiplier=F(signal)/F(signal+ext);
  }else{
   const d=targetAttributes.baseDefense;
   if(!finite(d)||d<=0||all>=1){issues.push('missing_or_invalid_base_defense');return;}
   // Each point of W_DEF removed adds the configured amount to the damage
   // coefficient. Keep self and other reductions in both counterfactuals.
   const perPoint=POLICY.defenseDamageGainPerPoint;
   const withEffect=1+d*all*perPoint,withoutExternal=1+d*(all-ext)*perPoint;
   multiplier=withEffect/withoutExternal;
  }
  pools.push({id:kind,logGain:Math.log(multiplier),entries:external.map(x=>entry(x.e,x.reduction/ext))});
 }
 sharedPool(resistance,'resistance');sharedPool(defense,'defense');
 const propertyExternal=attributeResistance.filter(x=>x.e.sourceActorHash!==sourceActorHash);
 if(propertyExternal.length){
  if(!composition)issues.push('penetration_school_composition_unknown');
  else if(!school.channel)issues.push('juren_school_channel_unknown');
  else {
  const channels=[school.channel];
  const values=channels.map(k=>targetAttributes.attributeResistanceWithEffects?.[k]);
  if(!values.every(finite))for(const x of propertyExternal)issues.push('missing_attribute_resistance:'+x.e.buffNo);
  else {
   const externalSum=propertyExternal.reduce((s,x)=>s+x.reduction,0);
   // Observed PRO_DEF already contains real resistance reductions (Juren).
   // Authorized damage-coefficient conversion is NOT present in that field:
   // subtract its self+external points once, then remove only external points.
   const syntheticPenetration=attributeResistance.filter(x=>x.syntheticPenetration).reduce((n,x)=>n+x.reduction,0);
   const multipliers=values.map((v,i)=>{const signal=v-ACTIVE_PROFILE.attributePenetration-observedPersonal.penetration[channels[i]]-syntheticPenetration;return F(signal)/F(signal+externalSum);});
   const multiplier=Math.min(...multipliers),selected=multipliers.indexOf(multiplier);
   pools.push({id:'attribute-resistance',baseline:values[selected],externalSum,channelPolicy:'skill-school-observed-resistance',selectedChannel:channels[selected],school,logGain:Math.log(multiplier),entries:propertyExternal.map(x=>entry(x.e,x.reduction/externalSum))});
  }
  }
 }
 // Keep v43's reference ledger for non-attack pools and recorded-origin
 // compatibility. Attack now evaluates its personal denominator per channel,
 // then weights that channel's ORIGINAL pool credit, never the baseline.
 // The attack family selects one active effect before this point: each active
 // channel has the same external rate; unsupported channels receive no credit.
 const logGain=pools.reduce((sum,p)=>sum+p.logGain,0);
 const unweightedGain=amount*(-Math.expm1(-logGain));
 const weight=p=>p.id==='attack'?p.creditWeight:p.id==='resistance'?composition.physical:p.id==='attribute-resistance'?composition.attribute:1;
 const poolCredit=new Map(pools.map(p=>[p,logGain?unweightedGain*p.logGain/logGain*weight(p):0]));
 for(const p of pools)if(p.id==='attack'){
  const otherLogGain=pools.filter(other=>other!==p).reduce((sum,other)=>sum+other.logGain,0);
  let channelTotal=0;
  for(const c of Object.values(p.components)){
   const totalLogGain=otherLogGain+c.logGain;
   c.otherLogGain=otherLogGain;
   c.effectiveMultiplier=Math.exp(c.logGain);
   c.unweightedCreditedDamage=totalLogGain?amount*(-Math.expm1(-totalLogGain))*c.logGain/totalLogGain:0;
   c.creditedDamage=c.unweightedCreditedDamage*c.share;
   channelTotal+=c.creditedDamage;
  }
  poolCredit.set(p,channelTotal);
 }
 const gain=[...poolCredit.values()].reduce((sum,n)=>sum+n,0);
 const credit=pools.flatMap(p=>p.entries.map(e=>({...e,poolId:p.id,creditedDamage:poolCredit.get(p)*e.weight})));
 const credited=credit.reduce((s,e)=>s+e.creditedDamage,0),conservationError=credited-gain;
 if(!finite(gain)||gain<0||gain>amount||credit.some(e=>!finite(e.creditedDamage)||e.creditedDamage<0)||Math.abs(conservationError)>1e-9*Math.max(1,amount))throw Error('invalid_simple_allocation');
 return {status:'estimated',gain,credit,issues:[...new Set(issues)],allocation:{policy:POLICY.allocationPolicy,personalBaselineKnown,personalDamageBonus,observedPersonalBaseline:observedPersonal,selfDamageBonus:selfRate,damageWithoutExternal:amount-gain,conservationError,unweightedGain,damageComposition:composition?{liupaiId:school.liupaiId,liupaiName:composition.liupaiName,physical:composition.physical,attribute:composition.attribute,basis:damageComposition.id}:null,attackSourceWeights:attackWeight?{physical:attackWeight.physical,attribute:attackWeight.attribute,basis:attackWeights.id}:null,pools:pools.map(p=>({id:p.id,baseline:p.baseline,externalSum:p.externalSum,...(p.components?{components:p.components}:{}),...(p.channelPolicy?{channelPolicy:p.channelPolicy,selectedChannel:p.selectedChannel,school:p.school}:{}),effectiveMultiplier:Math.exp(p.logGain),logWeight:logGain?p.logGain/logGain:0,creditWeight:weight(p),unweightedCreditedDamage:logGain?unweightedGain*p.logGain/logGain:0,creditedDamage:poolCredit.get(p)}))}};
}

module.exports={POLICY,policySha256,simpleHitCredit};
