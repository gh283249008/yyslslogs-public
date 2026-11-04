const fs=require('fs'),path=require('path');
const catalog=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../evidence/p1/encounter-retest/scoped-catalog.json'),'utf8'));
const schemas=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../../config/schema-profiles.json'),'utf8'));
const validatedPresets=new Set(Object.values(schemas.profiles).map(p=>p.count));
const crypto=require('node:crypto'),channel=require('../../config/decoder-channel.json');let last=null;
function approved(preset,proof){if(!proof||typeof proof.payload!=='string'||proof.payload.length>8192||typeof proof.signature!=='string'||proof.signature.length!==88)return false;
 if(last?.payload===proof.payload&&last.signature===proof.signature)return last.preset===preset;
 try{if(!crypto.verify(null,Buffer.from(proof.payload),channel.publicKey,Buffer.from(proof.signature,'base64')))return false;const p=JSON.parse(proof.payload);if(p.format!==1||!['yysls-034','yysls-034-typed'].includes(p.decoderABI)||p.schema.count!==preset)return false;last={payload:proof.payload,signature:proof.signature,preset};return true;}catch{return false;}}
function resolveEncounterIdentity(context,statisticNpcNo){
 if(!context||(!validatedPresets.has(context.preset)&&!approved(context.preset,context.decoderProof))||!Array.isArray(context.npcs))return null;
 const matches=[];
 for(const entry of catalog.entries){const m=entry.match;
  if(context.dungeonSid!==m.dungeonSid||context.dungeonGameId!==m.dungeonGameId||statisticNpcNo!==m.statisticNpcNo)continue;
  for(const npc of context.npcs){if(['npcTemplateNo','customValueId','serialId','dungeonSerialId'].every(k=>npc[k]===m[k]))matches.push({bossName:entry.bossName,dungeonName:entry.dungeonName,bossActorHash:npc.actorHash,spaceHash:context.spaceHash,nameSource:entry.nameSource,nameSourceLabel:'Boss名称来自已验证样本映射',identityMatch:{...m}});}
 }
 return matches.length===1?matches[0]:null;
}
module.exports={resolveEncounterIdentity};
