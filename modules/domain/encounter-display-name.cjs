'use strict';
// Presentation only: this resolver must never establish targetBoss attribution.
const {resolveEncounterIdentity}=require('./encounter-catalog.cjs');
const {normalizeGameData}=require('./game-data-version.cjs');
const data=require('../../config/encounter-display-names.json');
const schemas=require('../../config/schema-profiles.json');
const {difficultyName}=require('./encounter-difficulty.cjs');
const fields=['dungeonSid','dungeonGameId','statisticNpcNo','npcTemplateNo','customValueId','serialId','dungeonSerialId'];
function validateDisplayNames(value){
 if(value?.schemaVersion!==1||value.legacyWithoutMarker!=='existing-catalog-only'||!value.profiles||Array.isArray(value.profiles))throw Error('invalid_encounter_display_names');
 for(const [hash,p] of Object.entries(value.profiles)){
  if(!/^[a-f0-9]{64}$/.test(hash)||!Array.isArray(p.schemaProfileIds)||!p.schemaProfileIds.length||p.schemaProfileIds.some(id=>!schemas.profiles[id])||!Array.isArray(p.entries))throw Error('invalid_encounter_display_profile');
  const keys=new Set();for(const e of p.entries){const key=JSON.stringify(fields.map(k=>e.match?.[k]));if(typeof e.bossName!=='string'||!e.bossName.trim()||e.bossName.length>128||fields.some(k=>!Object.hasOwn(e.match||{},k)||(k==='customValueId'&&e.match[k]===null?false:!Number.isSafeInteger(e.match[k])||e.match[k]<0))||keys.has(key))throw Error('invalid_encounter_display_entry');if(e.difficulty&&(!['normal','challenge'].includes(e.difficulty.mode)||!['normal','race-basic','race-challenge'].includes(e.difficulty.variant)||e.difficulty.basis!=='version-bound-client-dungeon-mode'))throw Error('invalid_encounter_display_difficulty');keys.add(key);}
 }
 return true;
}
validateDisplayNames(data);
function resolveEncounterDisplayIdentity(context,statisticNpcNo,gameData){
 const existing=resolveEncounterIdentity(context,statisticNpcNo);if(existing)return existing;
 const marker=normalizeGameData(gameData),profile=marker?.manifestSha256&&data.profiles[marker.manifestSha256];
 if(!profile||!context||!profile.schemaProfileIds.some(id=>schemas.profiles[id].count===context.preset)||!Array.isArray(context.npcs))return null;
 const matches=[];
 for(const e of profile.entries){const m=e.match;if(context.dungeonSid!==m.dungeonSid||context.dungeonGameId!==m.dungeonGameId||statisticNpcNo!==m.statisticNpcNo)continue;
  for(const npc of context.npcs)if(['npcTemplateNo','customValueId','serialId','dungeonSerialId'].every(k=>k==='customValueId'&&m[k]===null?!Object.hasOwn(npc,k):npc[k]===m[k]))matches.push({bossName:difficultyName(e.bossName,e.difficulty),difficulty:e.difficulty||null,dungeonName:null,nameSource:'version-bound-client-billboard-locale',nameSourceLabel:'Boss名称来自对应版本客户端名称表',displayOnly:true,displayActorHash:npc.actorHash});
 }
 return matches.length===1?matches[0]:null;
}
module.exports={resolveEncounterDisplayIdentity,validateDisplayNames};
