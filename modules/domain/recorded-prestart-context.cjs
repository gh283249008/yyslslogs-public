'use strict';
const {calcpointHasTag}=require('./personal-buff-baselines.cjs');
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const key=h=>[h.transportRecordOrdinal,h.sequence??h.hitInput?.sequence].join(':');

// An observed recorder can precede the encounter signal. Admit it only when
// every eligible raw hit was actually admitted to this exact encounter.
// No time tolerance, pending-hit promotion, or cross-battle credit is inferred.
class RecordedPrestartContext {
 constructor(policy){this.windows=new WeakMap();this.encounters=new WeakMap();this.limit=policy?.maxContextEvents??100000;this.count=0;this.overflow=false;}
 token(current){if(!current)return null;if(!this.encounters.has(current))this.encounters.set(current,{});return this.encounters.get(current);}
 begin(apply,rule){if(rule.prestart?.enabled)this.windows.set(apply,{rule,events:[],keys:new Set(),invalid:false});}
 observe(e,active,current,included,schemaPreset=current?.schemaPreset){
  for(const apply of active){
   const state=this.windows.get(apply);if(!state||e.sourceActorHash!==apply.sourceActorHash||e.targetActorHash!==apply.targetActorHash)continue;
   const n=e.transportRecordOrdinal,t=Date.parse(e.observedAt);
   if(!valid(n)||n<apply.transportRecordOrdinal){state.invalid=true;continue;}
   if(n===apply.transportRecordOrdinal)continue; // direct-window excludes apply
   const eligible=calcpointHasTag(e.rawCalcpointId,state.rule.calcpointTag,schemaPreset);
   if(eligible===false||e.amount===0)continue;
   const k=key(e),last=state.events.at(-1);
   if(this.count>=this.limit){this.overflow=true;continue;}
   if(eligible!==true||!valid(e.sequence)||!Number.isFinite(t)||t<Date.parse(apply.observedAt)||!Number.isFinite(e.amount)||e.amount<=0||state.keys.has(k)||n<(last?.record??0)||t<(last?.time??-Infinity)||state.events.length>=state.rule.prestart.maxOriginsPerWindow){state.invalid=true;continue;}
   this.count++;state.keys.add(k);state.events.push({key:k,record:n,time:t,amount:e.amount,calcpoint:e.rawCalcpointId,schemaPreset:schemaPreset??null,encounter:included?this.token(current):null});
  }
 }
 verify(window,current,origins){
  const state=this.windows.get(window.apply),events=state?.events,token=this.token(current);
  if(this.overflow||!state||state.invalid||!events.length||events.length!==origins.length||!Number.isFinite(current.startMs)||!Number.isFinite(current.endMs))return null;
  const index=new Map();for(const h of origins){const k=key(h);if(index.has(k))return null;index.set(k,h);}
  for(const e of events){const h=index.get(e.key);if(e.encounter!==token||e.time<current.startMs||e.time>current.endMs||e.record>=window.remove.transportRecordOrdinal||!h||h.amount!==e.amount||h.rawCalcpointId!==e.calcpoint||(h.hitInput?.schemaPreset??null)!==e.schemaPreset||h.timestampMs!==e.time||h.sourceActorHash!==window.apply.sourceActorHash||h.targetActorHash!==window.apply.targetActorHash)return null;}
  return {basis:'complete-observed-origins-in-same-encounter',originals:events.length,applyRecord:window.apply.transportRecordOrdinal};
 }
}
module.exports={RecordedPrestartContext};
