'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {calculateRdpsSnapshot,getRdpsValidationStatus}=require('../tools/p1-rdps-runtime.cjs');
const {applySimpleEstimate}=require('./simple-attribution-feed.cjs');
class AttributionFeed {
 constructor(latestPath){this.dir=path.dirname(latestPath);this.key=null;this.cached=null;this.lastGood=null;}
 retainCalculated(view,result){
  const c=view.encounter,s=view.snapshot;
  const anchor=c?.encounterClock?.startObservedAt||c?.firstObservedAt;
  const observedAt=Date.parse(c?.lastObservedAt);
  const key=c&&s?.source?.sessionId&&anchor?JSON.stringify([s.source.sessionId,s.source.mode,c.id,c.npcNo,anchor,c.encounterClock?.identityContext?.spaceHash]):null;
  if(!key||this.lastGood?.key!==key)this.lastGood=null;
  if(!key||!Number.isFinite(observedAt))return {view,result};
  if(['available','estimated'].includes(result.status)&&c.actors.length&&c.actors.every(a=>['rdps','dpsGiven','dpsTaken'].every(k=>Number.isFinite(a[k])))){
   this.lastGood={key,observedAt,sequence:s.sequence,result:structuredClone(result),mechanics:structuredClone(c.mechanics||[]),rows:new Map(c.actors.map(a=>[a.idHash,{damage:a.damage,mechanicDamage:a.mechanicDamage||0,rdps:a.rdps,dpsGiven:a.dpsGiven,dpsTaken:a.dpsTaken}]))};
   return {view,result};
  }
  const cached=this.lastGood;
  if(!cached)return {view,result};
  // Hold only a previously checked result for this exact encounter. Never use
  // a newer ledger version or carry values across a reset/roster change.
  if(observedAt<cached.observedAt||(Number.isFinite(s.sequence)&&Number.isFinite(cached.sequence)&&s.sequence<cached.sequence)||c.actors.length!==cached.rows.size||c.actors.some(a=>!cached.rows.has(a.idHash)||a.damage<cached.rows.get(a.idHash).damage)){
   this.lastGood=null;return {view,result};
  }
  const pendingReasons=result.reasons||[];
  result={...cached.result,retained:true,updating:true,retainedThroughObservedAt:new Date(cached.observedAt).toISOString(),pendingReasons};
  view={...view,encounter:{...c,attribution:result.status,mechanics:structuredClone(cached.mechanics),actors:c.actors.map(a=>{const prior=cached.rows.get(a.idHash);return {...a,mechanicDamage:prior.mechanicDamage,rdps:prior.rdps,dpsGiven:prior.dpsGiven,dpsTaken:prior.dpsTaken};})}};
  return {view,result};
 }
 poll(view){
  if(view.encounter)view={...view,encounter:{...view.encounter,attribution:'unavailable',mechanics:[],actors:view.encounter.actors.map(a=>({...a,rdps:null,dpsGiven:null,dpsTaken:null}))}};
  let result=getRdpsValidationStatus(),diagnostics=null;
  const progressFile=path.join(this.dir,'attribution-validation.json');
  try{if(fs.existsSync(progressFile)&&fs.statSync(progressFile).size<1024*1024){const p=JSON.parse(fs.readFileSync(progressFile,'utf8'));if(p.source?.sessionId&&p.source.sessionId===view.snapshot?.source?.sessionId)result={...result,observations:p.observations,observedAt:p.publishedAt};}}catch{}
  const file=path.join(this.dir,'attribution-input.json');
  try{
   if(fs.existsSync(file)){
    const stat=fs.statSync(file);if(stat.size>32*1024*1024)throw Error('attribution_input_too_large');
    const bytes=fs.readFileSync(file),key=crypto.createHash('sha256').update(bytes).digest('hex');if(key!==this.key){this.cached=JSON.parse(bytes.toString('utf8'));this.key=key;}
    const input=this.cached,c=view.encounter,s=view.snapshot;
    if(!c||typeof s?.source?.sessionId!=='string'||!s.source.sessionId||!c.id||!Number.isInteger(c.npcNo)||!input||input.source?.sessionId!==s.source.sessionId||input.encounterId!==c.id||input.npcNo!==c.npcNo)throw Error('attribution_encounter_mismatch');
    if(input.provenance?.kind!=='observed')throw Error('live_input_must_be_observed');
    result=calculateRdpsSnapshot(input);
    if(result.status==='available'){
     const start=Date.parse(c.encounterClock?.startObservedAt),expectedTargets=c.validatedTargetIds;
     if(!Number.isFinite(start)||!Number.isFinite(c.durationSeconds)||c.durationSeconds<=0||!Number.isFinite(input.window.startMs)||!Number.isFinite(input.window.endMs)||input.window.startMs!==start||Math.abs(input.window.endMs-(start+c.durationSeconds*1000))>1||!Array.isArray(expectedTargets)||!expectedTargets.length||JSON.stringify([...expectedTargets].sort())!==JSON.stringify([...input.window.targetIds].sort()))throw Error('attribution_window_or_target_scope_unverified');
     const byId=new Map(result.actors.map(a=>[a.id,a]));
     if(input.resource!=='HP'||result.actors.length!==c.actors.length||Math.abs(result.durationSeconds-c.durationSeconds)>0.001||c.actors.some(a=>!Number.isFinite(a.damage)||!byId.has(a.idHash)||Math.abs(byId.get(a.idHash).damage-a.damage)>0.01))throw Error('attribution_damage_or_duration_mismatch');
     const fresh=s?.health?.session==='valid'&&!s.health.gap&&!view.transportStale;
     if(s.source.mode==='live'&&!fresh)throw Error('attribution_transport_invalid');
     view={...view,encounter:{...c,attribution:'available',actors:c.actors.map(a=>({...a,rdps:byId.get(a.idHash).rdps,dpsGiven:byId.get(a.idHash).dpsGiven,dpsTaken:byId.get(a.idHash).dpsTaken}))}};
    }
   }
  }catch(e){result={...getRdpsValidationStatus(),status:'unavailable',reasons:[e.message]};}
  if(result.status!=='available')try{const estimate=applySimpleEstimate(view,this.dir);if(estimate){view={...view,encounter:estimate.encounter};result=estimate.result;}}catch(e){result={...result,status:'unavailable',reasons:[e.message]};}
  ({view,result}=this.retainCalculated(view,result));
  const diagnosticFile=path.join(this.dir,'buff-coverage.json');
  try{if(fs.existsSync(diagnosticFile)&&fs.statSync(diagnosticFile).size<1024*1024){const d=JSON.parse(fs.readFileSync(diagnosticFile,'utf8'));if(d.source?.sessionId&&d.source.sessionId===view.snapshot?.source?.sessionId)diagnostics=d;}}catch{}
  return {...view,attribution:result,buffDiagnostics:diagnostics,encounter:view.encounter?{...view.encounter,attributionValidation:result}:null};
 }
}
module.exports={AttributionFeed};
