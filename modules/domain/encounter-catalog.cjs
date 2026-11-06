const fs=require('fs'),path=require('path');
const catalog=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../evidence/p1/encounter-retest/scoped-catalog.json'),'utf8'));
const schemas=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../config/schema-profiles.json'),'utf8'));
const validatedPresets=new Set(Object.values(schemas.profiles).map(p=>p.count));
function resolveEncounterIdentity(context,statisticNpcNo){
 if(!context||!validatedPresets.has(context.preset)||!Array.isArray(context.npcs))return null;
 const matches=[];
 for(const entry of catalog.entries){const m=entry.match;
  if(context.dungeonSid!==m.dungeonSid||context.dungeonGameId!==m.dungeonGameId||statisticNpcNo!==m.statisticNpcNo)continue;
  for(const npc of context.npcs){if(['npcTemplateNo','customValueId','serialId','dungeonSerialId'].every(k=>npc[k]===m[k]))matches.push({bossName:entry.bossName,dungeonName:entry.dungeonName,bossActorHash:npc.actorHash,spaceHash:context.spaceHash,nameSource:entry.nameSource,nameSourceLabel:'Boss名称来自已验证样本映射',identityMatch:{...m}});}
 }
 return matches.length===1?matches[0]:null;
}
module.exports={resolveEncounterIdentity};
