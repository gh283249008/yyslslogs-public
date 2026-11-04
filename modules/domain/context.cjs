'use strict';
// Explicit user-selected approximation. Never presented as the game's exact
// damage formula; the original validated-counterfactual calculator is unchanged.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {ACTIVE_PROFILE}=require('./version-baseline.cjs');
const {physicalResistanceMultiplier:F}=require('./physical-resistance.cjs');
const file=path.resolve(__dirname,'../../config/rdps-simple-v1.json'),bytes=fs.readFileSync(file),POLICY=JSON.parse(bytes);
const policySha256=crypto.createHash('sha256').update(bytes).digest('hex');
if(POLICY.defenseModel!=='linear-damage-gain-per-defense-point-v1'||typeof POLICY.defenseDamageGainPerPoint!=='number'||!Number.isFinite(POLICY.defenseDamageGainPerPoint)||POLICY.defenseDamageGainPerPoint<=0||POLICY.defenseDamageGainPerPoint>=1)throw Error('invalid_defense_model');
const registry=require('../../evidence/p1/rdps-rules/runtime-registry.json');
const personalBuffs=require('./personal-buff-baselines.cjs');
const kungfuChannels=require('./kungfu-channel.cjs');
const compositionBytes=fs.readFileSync(path.resolve(__dirname,'../../config/rd-damage-composition.json'));
const damageComposition=JSON.parse(compositionBytes);
const compositionSha256=crypto.createHash('sha256').update(compositionBytes).digest('hex');
const attackBytes=fs.readFileSync(path.resolve(__dirname,'../../config/attack-source-weights.json'));
const attackWeights=JSON.parse(attackBytes);
const attackSha256=crypto.createHash('sha256').update(attackBytes).digest('hex');
if(POLICY.personalBuffBaseline?.sha256!==personalBuffs.sha256)throw Error('personal_buff_policy_hash_mismatch');
if(POLICY.kungfuAttributeChannels?.sha256!==kungfuChannels.sha256)throw Error('kungfu_channel_policy_hash_mismatch');
if(POLICY.damageComposition?.sha256!==compositionSha256)throw Error('damage_composition_policy_hash_mismatch');
if(POLICY.attackSourceWeights?.sha256!==attackSha256)throw Error('attack_source_weights_policy_hash_mismatch');
const schoolIds=Object.keys(require('../../config/kungfu-attribute-channels.json').byLiupai);
for(const [id,rule]of Object.entries(POLICY.rules))if(rule.family==='attack'){
 const attrs=registry.rules[id]?.coefficientFacts?.attributes;
 if(!Array.isArray(attrs))throw Error('missing_attack_channel_evidence:'+id);
 const expected=[...(attrs.some(a=>/^MIN_W_ATK_RATE$|^MAX_W_ATK_RATE$/.test(a))?['physical']:[]),...(attrs.some(a=>/^MIN_PRO_ATK_[A-E]_RATE$|^MAX_PRO_ATK_[A-E]_RATE$/.test(a))?['attribute']:[])];
 if(!expected.length||JSON.stringify(rule.attackChannels)!==JSON.stringify(expected))throw Error('attack_channel_evidence_mismatch:'+id);
}
if(schoolIds.length!==Object.keys(damageComposition.byLiupai||{}).length||schoolIds.some(id=>{
 const row=damageComposition.byLiupai[id];
 return !row||!Number.isFinite(row.physical)||!Number.isFinite(row.attribute)||row.physical<0||row.attribute<0||Math.abs(row.physical+row.attribute-1)>1e-12;
}))throw Error('invalid_damage_composition');
if(schoolIds.length!==Object.keys(attackWeights.byLiupai||{}).length||schoolIds.some(id=>{
 const row=attackWeights.byLiupai[id];
 return !row||!Number.isFinite(row.physical)||!Number.isFinite(row.attribute)||!Number.isFinite(row.reportedAttribute)||row.physical<0||row.attribute<0||row.physical>1||row.attribute>1;
}))throw Error('invalid_attack_source_weights');
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const time=e=>Date.parse(e.observedAt);

module.exports={ACTIVE_PROFILE,F,POLICY,policySha256,registry,personalBuffs,kungfuChannels,damageComposition,attackWeights,finite,time};
