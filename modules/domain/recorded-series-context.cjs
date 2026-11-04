'use strict';
const {normalDamageEligible,calcpointClass,calcpointHasTag}=require('./personal-buff-baselines.cjs');
const clear=e=>/clear|leave|aoi|gap/.test(e.kind||'');
const key=e=>[e.targetActorHash,e.bag,e.buffInstanceHash].join(':');
const validOrdinal=e=>Number.isSafeInteger(e.transportRecordOrdinal)&&e.transportRecordOrdinal>=0;
const signature=rows=>JSON.stringify(rows.map(b=>[key(b),b.buffNo,b.sourceActorHash,b.rawStartTimestamp,b.duration]).sort());

// Marker + original hit establish a generation snapshot. Future ticks never
// query current modifiers. These remain modeled outputs, not observed hits.
class RecordedSeriesContext{
 constructor(policy){this.policy=policy;this.events=[];this.overflow=false;this.ids=new Set([policy?.buffNo,policy?.prerequisiteBuffNo]);for(const [id,r]of Object.entries(policy?.seriesModels??{})){this.ids.add(Number(id));this.ids.add(r.markerBuffNo);}}
 observe(e){
  if(!Object.keys(this.policy?.seriesModels??{}).length||!this.ids.has(e.buffNo)&&!clear(e))return;
  if(!validOrdinal(e)||!Number.isFinite(Date.parse(e.observedAt))||this.events.length>=(this.policy.maxContextEvents??100000)||e.transportRecordOrdinal<(this.events.at(-1)?.transportRecordOrdinal??0)){this.overflow=true;return;}
  this.events.push(e);
 }
 stateAt(target,record,time){
  const active=new Map();
  for(const e of this.events){if(e.transportRecordOrdinal>record)break;
   if(clear(e)){if(!e.targetActorHash||e.targetActorHash===target)active.clear();continue;}
   if(e.targetActorHash!==target)continue;
   const k=key(e),old=active.get(k);
   // A complete, explicitly refreshed stage buff establishes its new owner.
   // Comparing both generation endpoints still rejects switches during pairing.
   const stageRefresh=[this.policy.buffNo,this.policy.prerequisiteBuffNo].includes(e.buffNo)&&e.kind==='update'&&e.completeFields&&e.sourceIdPresent&&e.sourceActorHash&&e.changes?.fromid&&Number.isFinite(e.rawStartTimestamp)&&e.changes?.start_ts===e.rawStartTimestamp;
   if(!e.buffInstanceHash||e.kind==='remove_candidate'||e.sourceChanged&&!stageRefresh||!['apply_candidate','snapshot','update','field_patch'].includes(e.kind)||!(e.durationSeconds>0)){active.delete(k);continue;}
   const refresh=!old||old.b.rawStartTimestamp!==e.rawStartTimestamp||old.b.duration!==e.duration;
   active.set(k,{b:e,expiry:refresh?Date.parse(e.observedAt)+e.durationSeconds*1000:old.expiry});
  }
  return [...active.values()].filter(v=>v.expiry>time).map(v=>v.b);
 }
 groups(current){
  const groups=new Map();if(this.overflow)return groups;
  for(const [id,rule]of Object.entries(this.policy.seriesModels??{})){
   const markers=this.events.filter(e=>e.buffNo===rule.markerBuffNo&&e.kind==='apply_candidate'&&!e.initial&&e.sourceActorHash&&e.targetActorHash&&Date.parse(e.observedAt)>=current.startMs&&Date.parse(e.observedAt)<=current.endMs);
   for(const marker of markers){
    const source=marker.targetActorHash,target=marker.sourceActorHash,groupKey=[source,target,rule.skillId].join(':');
    if(!groups.has(groupKey))groups.set(groupKey,{source,target,rule,windows:[],outputs:[],unknown:false});const g=groups.get(groupKey);
    const near=current.hits.filter(h=>h.sourceActorHash===source&&h.targetActorHash===target&&validOrdinal(h)&&Math.abs(h.transportRecordOrdinal-marker.transportRecordOrdinal)<=rule.maxRecordDistance&&h.timestampMs===Date.parse(marker.observedAt));
    let unknown=false;const hits=near.filter(h=>{const preset=h.hitInput?.schemaPreset,normal=normalDamageEligible(h.rawCalcpointId,preset),cls=calcpointClass(h.rawCalcpointId,preset),tag=calcpointHasTag(h.rawCalcpointId,rule.excludedCalcpointTag,preset);if(normal===null||cls===null||tag===null){unknown=true;return false;}return normal&&cls===rule.calcpointClass&&!tag;});
    if(unknown||hits.length!==1||marker.durationSeconds!==rule.markerDurationSeconds){g.unknown=true;continue;}
    const h=hits[0],at=h.timestampMs,lo=Math.min(marker.transportRecordOrdinal,h.transportRecordOrdinal),hi=Math.max(marker.transportRecordOrdinal,h.transportRecordOrdinal),before=this.stateAt(target,lo,at),after=this.stateAt(target,hi,at);
    if(this.events.some(e=>e.transportRecordOrdinal>=lo&&e.transportRecordOrdinal<=hi&&clear(e)&&(!e.targetActorHash||[source,target].includes(e.targetActorHash)))||signature(before)!==signature(after)){g.unknown=true;continue;}
    const recorder=before.filter(b=>b.buffNo===Number(id)&&b.sourceActorHash===source),bu=before.filter(b=>b.buffNo===this.policy.buffNo),li=before.filter(b=>b.buffNo===this.policy.prerequisiteBuffNo);
    if(recorder.length!==1||bu.length>1||li.length>1||bu.length===1&&!bu[0].sourceActorHash){g.unknown=true;continue;}
    const covered=bu.length===1&&li.length===1,provider=covered?bu[0].sourceActorHash:null;
    if(g.outputs.some(o=>o.origins[0]===h)){g.unknown=true;continue;}
    const ratio=rule.ratio/rule.ticks;
    g.outputs.push({origins:[h],amount:h.amount*ratio*(covered?1+this.policy.rate:1),ratio,count:rule.ticks,at,provider,covered,maxDelayMs:rule.tickIntervalMs*rule.ticks+this.policy.maxGapDelayMs,generationRecord:h.transportRecordOrdinal,bounds:{cause:'generation-marker-snapshot',markerRecord:marker.transportRecordOrdinal,originRecord:h.transportRecordOrdinal,ticks:rule.ticks,tickIntervalMs:rule.tickIntervalMs}});
   }
  }
  return groups;
 }
}
module.exports={RecordedSeriesContext};
