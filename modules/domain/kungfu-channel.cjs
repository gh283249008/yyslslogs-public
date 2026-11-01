'use strict';
// School channel is a user-authorized whole-HP approximation, not measured
// elemental damage composition and never evidence for current-kungfu bonuses.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const bytes=fs.readFileSync(path.join(__dirname,'../../config/kungfu-attribute-channels.json'));
const DATA=JSON.parse(bytes),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
const valid=id=>Number.isSafeInteger(id)&&id>0;
function resolveKungfuChannel({rawSkillId=null,rawCalcpointId=null,currentKungfu=null}={}){
 const candidates=[valid(rawSkillId)?DATA.bySkill?.[rawSkillId]:null,valid(rawCalcpointId)?DATA.byCalcpoint?.[rawCalcpointId]:null].filter(Boolean);
 if(candidates.length){
  const ids=[...new Set(candidates.flatMap(x=>x.kungfuIds).filter(id=>!DATA.placeholderKungfuIds.includes(id)))];
  const rows=ids.map(id=>DATA.byKungfu[id]);
  const channels=new Set(rows.map(r=>r?.channel));
  if(rows.length&&rows.every(r=>r&&/^[A-E]$/.test(r.channel))&&channels.size===1)
   return {channel:rows[0].channel,attributeName:rows[0].attributeName,basis:'captured-skill-school',kungfuIds:ids,rawSkillId,rawCalcpointId};
  return {channel:null,basis:'ambiguous-skill-school',kungfuIds:ids,rawSkillId,rawCalcpointId};
 }
 const row=valid(currentKungfu)?DATA.byKungfu?.[currentKungfu]:null;
 if(row&&/^[A-E]$/.test(row.channel))return {channel:row.channel,attributeName:row.attributeName,basis:'observed-current-kungfu',kungfuIds:[currentKungfu]};
 return {channel:null,basis:'unknown-school',kungfuIds:[]};
}
function resolveEncounterSchool(input={}){
 const channel=resolveKungfuChannel(input);
 if(!channel.channel)return null;
 const ids=[...new Set(channel.kungfuIds.map(id=>DATA.byKungfu[id]?.liupaiId))];
 if(ids.length!==1||!DATA.byLiupai[ids[0]])return null;
 return {...DATA.byLiupai[ids[0]],basis:'fixed-encounter-school',kungfuIds:channel.kungfuIds};
}
module.exports={resolveKungfuChannel,resolveEncounterSchool,sha256};
