'use strict';
// Explicit user-selected approximation. Never presented as the game's exact
// damage formula; the original validated-counterfactual calculator is unchanged.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {ACTIVE_PROFILE}=require('./version-baseline.cjs');
const {physicalResistanceMultiplier:F}=require('./physical-resistance.cjs');
const file=path.resolve(__dirname,'../../config/rdps-simple-v1.json'),bytes=fs.readFileSync(file),POLICY=JSON.parse(bytes);
const policySha256=crypto.createHash('sha256').update(bytes).digest('hex');
const registry=require('../../evidence/p1/rdps-rules/runtime-registry.json');
const personalBuffs=require('./personal-buff-baselines.cjs');
const kungfuChannels=require('./kungfu-channel.cjs');
if(POLICY.personalBuffBaseline?.sha256!==personalBuffs.sha256)throw Error('personal_buff_policy_hash_mismatch');
if(POLICY.kungfuAttributeChannels?.sha256!==kungfuChannels.sha256)throw Error('kungfu_channel_policy_hash_mismatch');
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const time=e=>Date.parse(e.observedAt);

module.exports={ACTIVE_PROFILE,F,POLICY,policySha256,registry,personalBuffs,kungfuChannels,finite,time};
