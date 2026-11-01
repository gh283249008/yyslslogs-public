'use strict';
// Static reconstruction, not a live attribution rule. See resistance-formula-review.json.
const MODEL='yysls-ZD_QX_DMG-physical-resistance-20261018-v1';
const {baselinePenetration,getAttributionBasis}=require('./version-baseline.cjs');
const finite=(n,label)=>{if(typeof n!=='number'||!Number.isFinite(n))throw Error('missing_or_invalid_'+label);return n;};
function exactInteger(v){if(v&&typeof v==='object'&&typeof v.int64Decimal==='string')v=v.int64Decimal;if(typeof v==='bigint')return v;if(typeof v==='string'&&/^-?\d+$/.test(v))return BigInt(v);if(typeof v==='number'&&Number.isSafeInteger(v))return BigInt(v);throw Error('exact_64bit_integer_required');}
function decodeSaltedFloat64(encoded,salt){
 const value=exactInteger(encoded),key=exactInteger(salt);
 if(value<-(1n<<63n)||value>=(1n<<64n)||key<-(1n<<63n)||key>=(1n<<64n))throw Error('integer_outside_64_bits');
 if(value===0n)return 0; // explicit native rm_salt zero special case
 const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(BigInt.asUintN(64,value^key));
 return finite(bytes.readDoubleLE(),'decoded_float');
}
function resistanceSignal(attacker,target){
 const rdc=finite(target?.W_ATK_PEN_RDC,'target_W_ATK_PEN_RDC');
 const pen=finite(attacker?.W_ATK_PEN,'attacker_W_ATK_PEN');
 const cr=finite(target?.CORRECTABLE_W_ATK_PEN_RDC,'target_CORRECTABLE_W_ATK_PEN_RDC');
 const cp=finite(attacker?.CORRECTABLE_W_ATK_PEN,'attacker_CORRECTABLE_W_ATK_PEN');
 const correction=finite(target?.ATK_PEN_CORRECT_PARA,'target_ATK_PEN_CORRECT_PARA');
 if(correction<=0)throw Error('invalid_target_correction_parameter');
 return finite(rdc-pen+(cr-cp)/correction,'resistance_signal');
}
function physicalResistanceMultiplier(signal){
 const s=finite(signal,'resistance_signal');
 // Same branches as PC199..232. Rational form avoids cancellation at high resistance.
 return finite(s<0?1-s/200:s>75?25/(s+25):1-s/100,'resistance_multiplier');
}
function reconstructRemoval(input={}){
 try{
  const {attacker,targetWithEffect,flatResistanceReduction,physicalDamageWithEffect,otherDamageWithEffect,resource}=input;
  if(resource!=='HP')throw Error('physical_HP_only');
  const reduction=finite(flatResistanceReduction,'flat_resistance_reduction');
  if(reduction<0)throw Error('negative_resistance_reduction');
  const physical=finite(physicalDamageWithEffect,'physical_damage_component'),other=finite(otherDamageWithEffect,'other_damage_component');
  if(physical<0||other<0)throw Error('negative_damage_component');
  const estimated=input.penetrationBasis==='version-baseline';
  if(input.penetrationBasis!==undefined&&!estimated&&input.penetrationBasis!=='observed')throw Error('unknown_penetration_basis');
  // The user-approved effective baseline replaces private penetration and its
  // corrections in this model; do not silently add unknown correction fields.
  const withSignal=estimated?finite(targetWithEffect?.W_ATK_PEN_RDC,'target_W_ATK_PEN_RDC')-baselinePenetration('physical'):resistanceSignal(attacker,targetWithEffect),withoutSignal=withSignal+reduction;
  const withMultiplier=physicalResistanceMultiplier(withSignal),withoutMultiplier=physicalResistanceMultiplier(withoutSignal);
  const gain=physical*(1-withoutMultiplier/withMultiplier),total=physical+other;
  return {status:estimated?'version-baseline-estimate':'static-counterfactual',...(estimated?{attributionBasis:getAttributionBasis()}:{}),model:MODEL,resource,withSignal,withoutSignal,withMultiplier,withoutMultiplier,physicalDamageWithEffect:physical,physicalDamageWithoutEffect:physical-gain,otherDamageWithEffect:other,totalDamageWithEffect:total,totalDamageWithoutEffect:total-gain,addedDamage:gain,observedDamageFraction:total?gain/total:0,
   liveAttributionEnabled:false,limits:[estimated?'Effective penetration uses the user-approved version baseline, not measured player attributes.':'Input must be the effective hit-time attribute snapshot, not bare base stats.','Applies to the isolated physical component in ordinary/critical/bash/glancing ZD_QX_DMG branches; not all HP or true damage. Final rounding, clamps and shields must be accounted for separately.','Other effects, exact hit clocks, provider ownership and snapshot provenance still require independent validation.']};
 }catch(error){return {status:'unavailable',model:MODEL,addedDamage:null,reasons:[error.message],liveAttributionEnabled:false};}
}
function reconstructCombinedRemoval(input={}){
 try{
  const effects=input.flatResistanceEffects;
  if(!Array.isArray(effects)||!effects.length)throw Error('explicit_resistance_effects_required');
  const seen=new Set();let total=0;
  for(const effect of effects){
   if(!effect||typeof effect.effectId!=='string'||!effect.effectId||seen.has(effect.effectId))throw Error('unique_effect_ids_required');
   seen.add(effect.effectId);const reduction=finite(effect.reduction,'effect_resistance_reduction');
   if(reduction<0)throw Error('negative_resistance_reduction');total+=reduction;
  }
  finite(total,'combined_resistance_reduction');
  const result=reconstructRemoval({...input,flatResistanceReduction:total});
  return {...result,combinedEffects:effects.map(e=>({effectId:e.effectId,reduction:e.reduction})),allocation:null,
   combinationPolicy:'Evaluate the shared resistance pool once with all selected reductions removed. Individual marginal ratios are not independent multipliers.'};
 }catch(error){return {status:'unavailable',model:MODEL,addedDamage:null,reasons:[error.message],liveAttributionEnabled:false};}
}
module.exports={MODEL,decodeSaltedFloat64,resistanceSignal,physicalResistanceMultiplier,reconstructRemoval,reconstructCombinedRemoval};
