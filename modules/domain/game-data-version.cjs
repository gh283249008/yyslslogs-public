'use strict';
// Immutable business-data identity. No clock inference or file-system lookup at hit time.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const file=path.join(__dirname,'../../config/game-data-profiles.json'),bytes=fs.readFileSync(file),DATA=JSON.parse(bytes);
const sha256=crypto.createHash('sha256').update(bytes).digest('hex');
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function validate(data){
 if(data?.schemaVersion!==1||data.legacyWithoutMarker!=='preserve-existing-policy'||!Array.isArray(data.versionedRuleIds)||!data.versionedRuleIds.length||new Set(data.versionedRuleIds).size!==data.versionedRuleIds.length||data.versionedRuleIds.some(id=>typeof id!=='string'||!/^\d+$/.test(id))||!data.profiles||Array.isArray(data.profiles))throw Error('invalid_game_data_profiles');
 for(const [hash,p]of Object.entries(data.profiles)){
  if(!hex(hash)||typeof p?.id!=='string'||!p.id||!p.ruleOverrides||Object.keys(p.ruleOverrides).length!==data.versionedRuleIds.length)throw Error('invalid_game_data_profile');
  for(const id of data.versionedRuleIds){const r=p.ruleOverrides[id];if(!r||Object.keys(r).length!==1||!Number.isFinite(r.defensePerStack)||r.defensePerStack<=0||r.defensePerStack>=1)throw Error('invalid_game_data_rule_override');}
 }
 return true;
}
validate(DATA);
function validatePolicy(policy){
 if(policy.gameDataProfiles?.file!=='config/game-data-profiles.json'||policy.gameDataProfiles?.sha256!==sha256)throw Error('game_data_policy_hash_mismatch');
 for(const id of DATA.versionedRuleIds)if(!Number.isFinite(policy.rules?.[id]?.defensePerStack))throw Error('game_data_rule_missing_legacy_definition');
}
function normalizeGameData(value){
 if(value===undefined)return undefined;
 const valid=value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&Object.hasOwn(value,'manifestSha256')&&hex(value.manifestSha256);
 return Object.freeze({manifestSha256:valid?value.manifestSha256:null});
}
function gameDataKey(value){const v=normalizeGameData(value);return v===undefined?'legacy-unversioned':v.manifestSha256||'explicit-unknown';}
function createSessionSource(mode,sessionId,value){const gameData=normalizeGameData(value);return Object.freeze({mode,sessionId,...(gameData!==undefined?{gameData}:{})});}
function resolveRule(rule,id,gameData){
 if(!DATA.versionedRuleIds.includes(String(id))||gameData===undefined)return rule;
 const marker=normalizeGameData(gameData),profile=marker.manifestSha256&&DATA.profiles[marker.manifestSha256];
 return profile?{...rule,...profile.ruleOverrides[id]}:null;
}
function assertSameGameData(sources){
 if(!sources.length)return;
 const first=sources[0],key=gameDataKey(first?.gameData);
 if(key==='legacy-unversioned'&&sources.every(s=>gameDataKey(s?.gameData)===key))return;
 if(!first?.sessionId||sources.some(s=>s?.sessionId!==first.sessionId||gameDataKey(s?.gameData)!==key))throw Error('inconsistent_session_game_data');
}
module.exports={sha256,validate,validatePolicy,normalizeGameData,gameDataKey,createSessionSource,resolveRule,assertSameGameData};
