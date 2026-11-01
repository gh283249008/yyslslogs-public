'use strict';
// Auxiliary number-tip notifications, deliberately separate from Behit/DPS.
// Handler registers damage/fromer_id/skill_id, but direct_damage sends only
// damage/fromer_id (behit_base main/14). Never invent the missing skill ID.
const crypto=require('crypto'),{decode}=require('@msgpack/msgpack');
const {normalizeSyncEnvelopes}=require('./p1-rdps-damage-batch.cjs');
const HARM=1480632566,HEAL=880462235;
function integerId(v){
 if(typeof v==='bigint')return v.toString();
 if(typeof v==='number'&&Number.isSafeInteger(v))return String(v);
 throw Error('Number-tip skill ID must be an exact integer');
}
function sourceHash(v){
 if(v===null||v===undefined||v==='')return null;
 if(typeof v!=='string'&&!(v instanceof Uint8Array))throw Error('Number-tip source ID must be bytes/string');
 return crypto.createHash('sha256').update(typeof v==='string'?Buffer.from(v):v).digest('hex').slice(0,16);
}
function hpTextEvidenceFromAreaSync(bytes,targetActorHash,methodIndex){
 const events=[],rejected=[];
 let envelopes;try{envelopes=normalizeSyncEnvelopes(bytes,methodIndex);}catch(error){return {events,rejected:[{syncId:null,syncSubIndex:null,reason:'Invalid sync carrier: '+error.message}]};}
 for(const item of envelopes){
  if(![HARM,HEAL].includes(item.syncId))continue;
  try{
   const args=decode(item.innerBytes,{rawStrings:true,useBigInt64:true});
   if(!Array.isArray(args)||![2,3].includes(args.length)||typeof args[0]!=='number'||!Number.isFinite(args[0])||args[0]<0)throw Error('Invalid number-tip payload');
   let reason=null;if(item.extraBytes?.length){const extra=decode(item.extraBytes,{useBigInt64:true});if(Number.isSafeInteger(extra?.reason))reason=extra.reason;}
   events.push({schemaVersion:1,kind:item.syncId===HARM?'hp-harm-number-tip':'hp-heal-number-tip',sourceActorHash:sourceHash(args[1]),targetActorHash,amount:args[0],rawSkillId:args.length===3?integerId(args[2]):null,skillIdPresent:args.length===3,argumentCount:args.length,reason,syncId:item.syncId,syncSubIndex:item.batchIndex,envelopeMethod:methodIndex,resource:'hp',fullDamageEvent:false,attributionReady:false,includeInDps:false,recipientCoverage:'Direct damage to ordinary NPC is source-client-only; captured recipient does not imply team coverage',semanticEvidence:'Exact shipped SyncHarmtext registration and behit_base direct_damage two-argument sender; display notification only, execution clock/damage flags/deduplication versus Behit not validated'});
  }catch(error){rejected.push({syncId:item.syncId,syncSubIndex:item.batchIndex,reason:error.message});}
 }
 return {events,rejected};
}
module.exports={hpTextEvidenceFromAreaSync,HARM,HEAL};
