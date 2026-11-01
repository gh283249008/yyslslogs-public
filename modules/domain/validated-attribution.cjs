'use strict';
// Counterfactual arithmetic over validated, normalized hit snapshots. The default
// registry is deliberately static-only: raw network notifications cannot opt in.
const deepFreeze=o=>{Object.freeze(o);for(const v of Object.values(o))if(v&&typeof v==='object'&&!Object.isFrozen(v))deepFreeze(v);return o;};
const DEFAULT=deepFreeze(structuredClone(require('../../evidence/p1/rdps-rules/runtime-registry.json')));
const {getAttributionBasis}=require('./version-baseline.cjs');
const {reconstructRemoval,reconstructCombinedRemoval}=require('./physical-resistance.cjs');
// Counterfactual preparation uses the selected version baseline; this does not
// turn incomplete observed events into validated full-party attribution.
function prepareResistanceCounterfactual(input){
 const args={...input,penetrationBasis:'version-baseline'};
 return Object.hasOwn(args,'flatResistanceEffects')?reconstructCombinedRemoval(args):reconstructRemoval(args);
}
const GATES=['damageEventsComplete','buffStatesComplete','partyComplete','targetScopeComplete','hitClockValidated','snapshotValidated','sourceOwnershipValidated','mutexValidated','personalBaselineComplete','counterfactualModelValidated'];
const finite=n=>typeof n==='number'&&Number.isFinite(n),str=s=>typeof s==='string'&&s.length>0;
const sortedJson=o=>Array.isArray(o)?o.map(sortedJson):o&&typeof o==='object'?Object.fromEntries(Object.keys(o).sort().map(k=>[k,sortedJson(o[k])])):o;
const canonical=o=>JSON.stringify(sortedJson(o));
function poolContext(pools){return canonical((Array.isArray(pools)?pools:[]).map(p=>{if(!p||typeof p!=='object')return p;const {stage,...context}=p;return {...context,effects:Array.isArray(p.effects)?[...p.effects].sort((a,b)=>String(a?.effectId).localeCompare(String(b?.effectId))):p.effects};}).sort((a,b)=>String(a?.id).localeCompare(String(b?.id))));}
function normalizedValues(value,seen=new Set(),depth=0){
 if(depth>64||['bigint','symbol','function'].includes(typeof value))return false;
 if(!value||typeof value!=='object')return true;
 if(seen.has(value)||(!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value))))return false;
 seen.add(value);const valid=Object.values(value).every(v=>normalizedValues(v,seen,depth+1));seen.delete(value);return valid;
}
function getRdpsValidationStatus(coverage={},registry=DEFAULT){
 coverage=coverage||{};
 const reasons=GATES.filter(k=>coverage[k]!==true).map(k=>'missing_'+k);
 if(registry.liveEnabled!==true||registry.validation!=='validated')reasons.push('registry_not_live_validated');
 if(Object.values(registry.rules||{}).some(r=>r.selectedForAttribution&&(r.liveEnabled!==true||r.validation!=='validated')))reasons.push('selected_rules_not_live_validated');
 return {status:reasons.length?'unavailable':'ready',registryId:registry.id,attributionBasis:getAttributionBasis(),reasons,rdps:null,dpsGiven:null,dpsTaken:null};
}
function calculateRdpsSnapshot(input,{registry=DEFAULT}={}){
 const synthetic=input?.provenance?.kind==='synthetic';
 const reasons=GATES.filter(k=>input?.coverage?.[k]!==true).map(k=>'missing_'+k);
 const fail=()=>({status:'unavailable',registryId:registry.id,resource:['HP','zhenqi'].includes(input?.resource)?input.resource:null,rdps:null,dpsGiven:null,dpsTaken:null,actors:null,ledger:[],reasons:[...new Set(reasons)]});
 if(!normalizedValues(input)){reasons.push('non_normalized_snapshot_value');return fail();}
 if(!synthetic&&(registry.liveEnabled!==true||registry.validation!=='validated'))reasons.push('registry_not_live_validated');
 if(!synthetic&&(!str(input?.gameBuild)||input.gameBuild!==registry.buildFingerprint))reasons.push('game_build_mismatch');
 if(!str(input?.provenance?.source)||!['synthetic','observed'].includes(input?.provenance?.kind))reasons.push('provenance_missing');
 if(!['HP','zhenqi'].includes(input?.resource))reasons.push('unknown_resource');
 const window=input?.window||{},actors=input?.actors||[],events=input?.events||[];
 if(!finite(window.startMs)||!finite(window.endMs)||window.endMs<=window.startMs)reasons.push('invalid_window');
 if(!Array.isArray(actors)||!actors.length||actors.some(a=>!str(a))||new Set(actors).size!==actors.length)reasons.push('invalid_actors');
 if(!Array.isArray(window.targetIds)||!window.targetIds.length||window.targetIds.some(id=>!str(id))||new Set(window.targetIds).size!==window.targetIds.length)reasons.push('missing_or_invalid_targets');
 if(!Array.isArray(input?.events))reasons.push('missing_events');
 if(reasons.length)return fail();
 const party=new Set(actors),targets=new Set(window.targetIds),ids=new Set(),prepared=[],recordedGroups=new Map();
 for(const hit of events){
  if(!hit||!str(hit.id)||ids.has(hit.id)){reasons.push('duplicate_or_missing_hit_id');continue;}ids.add(hit.id);
  if(!party.has(hit.sourceId)||!targets.has(hit.targetId)||!str(hit.abilityId))reasons.push('invalid_hit_actor_target_or_skill');
  if(hit.resource!==input.resource)reasons.push('mixed_resources');
  if(!finite(hit.amount)||hit.amount<0)reasons.push('invalid_damage');
  if(!finite(hit.timestampMs)||hit.timestampMs<window.startMs||hit.timestampMs>=window.endMs)reasons.push('invalid_hit_time');
  const recorded=hit.kind==='recorded-component',origin=hit.origin,derivation=hit.derivation;
  if(recorded){
   // These are proven components of ONE separately observed output, never
   // inferred explosions from buff removal or a settlement residual.
   if(!origin||!str(origin.eventId)||!finite(origin.timestampMs)||origin.timestampMs<window.startMs||origin.timestampMs>hit.timestampMs||!finite(origin.amount)||origin.amount<0||origin.sourceId!==hit.sourceId||origin.targetId!==hit.targetId||origin.resource!==hit.resource||origin.validated!==true||!str(origin.evidence))reasons.push('unresolved_recorded_origin');
   if(!derivation||!str(derivation.eventId)||!finite(derivation.amount)||derivation.amount<0||!finite(derivation.ratio)||derivation.ratio<0||!finite(derivation.recordedMultiplier)||derivation.recordedMultiplier<=0||derivation.outputObserved!==true||derivation.lineageValidated!==true||derivation.componentsComplete!==true||derivation.linearFinalProcessingValidated!==true||!str(derivation.evidence))reasons.push('unresolved_recorded_derivation');
   else{
    const expected=origin?.amount*derivation.ratio*derivation.recordedMultiplier;
    if(!finite(expected)||Math.abs(expected-hit.amount)>1e-8*Math.max(1,Math.abs(expected)))reasons.push('recorded_component_amount_mismatch');
    const identity=JSON.stringify([hit.sourceId,hit.targetId,hit.abilityId,hit.resource,hit.timestampMs,derivation.amount,derivation.ratio,derivation.recordedMultiplier,derivation.evidence]);
    const group=recordedGroups.get(derivation.eventId)||{identity,amount:derivation.amount,sum:0,origins:new Set()};
    if(group.identity!==identity)reasons.push('inconsistent_recorded_output');
    if(group.origins.has(origin?.eventId))reasons.push('duplicate_recorded_origin');
    group.origins.add(origin?.eventId);group.sum+=hit.amount;recordedGroups.set(derivation.eventId,group);
   }
  }else if(hit.kind!=='direct'&&!(hit.kind==='dot'&&hit.snapshotResolved===true))reasons.push('unresolved_dot_or_hit_kind');
  if(hit.effectsComplete!==true||hit.poolsComplete!==true)reasons.push('incomplete_hit_context');
  if(!Array.isArray(hit.pools)){reasons.push('missing_pools');continue;}
  const buckets=[],poolIds=new Set(),effectIds=new Set();let recordedMultiplier=1;
  for(const pool of hit.pools){
   if(!pool||!str(pool.id)||poolIds.has(pool.id)){reasons.push('invalid_or_duplicate_pool');continue;}poolIds.add(pool.id);
   let effectTime=hit.timestampMs;
   if(recorded){
    if(!['origin','recorded'].includes(pool.stage))reasons.push('missing_recorded_pool_stage');
    if(pool.stage==='origin')effectTime=origin?.timestampMs;
   }else if(pool.stage!==undefined)reasons.push('stage_on_non_recorded_hit');
   // baseline includes all unlisted personal/out-of-credit-scope effects after
   // condition/stat transforms. Explicit pool.effects are NOT already included:
   // self/context-only entries below are added exactly once. Never default to 1.
   if(!finite(pool.baseline)||pool.baseline<=0||pool.resolved!==true||!str(pool.evidence))reasons.push('unresolved_baseline_or_pool');
   if(!Array.isArray(pool.effects)){reasons.push('missing_pool_effects');continue;}
   const external=[];let baseline=pool.baseline;
   for(const e of pool.effects){
    const effectKey=recorded?JSON.stringify([pool.stage,e?.effectId]):e?.effectId;
    if(!e||!str(e.effectId)||effectIds.has(effectKey)){reasons.push('duplicate_or_missing_effect');continue;}effectIds.add(effectKey);
    const rule=str(e.ruleId)&&Object.hasOwn(registry.rules,e.ruleId)?registry.rules[e.ruleId]:null;
    if(!rule){reasons.push('unknown_rule');continue;}
    if(rule.validation!==(synthetic?'synthetic':'validated'))reasons.push('rule_not_validated');
    if(!Array.isArray(rule.resources)||!rule.resources.includes(input.resource))reasons.push('rule_resource_mismatch');
    if(!synthetic&&rule.liveEnabled!==true)reasons.push('rule_not_live_enabled');
    if(!synthetic&&rule.gameBuild!==input.gameBuild)reasons.push('rule_game_build_mismatch');
    if(!synthetic&&(!str(rule.transformModel)||!str(e.transformEvidence)||!str(rule.evidence)))reasons.push('validated_transform_evidence_missing');
    if(!finite(e.increment)||e.increment<0||e.conditionsResolved!==true||e.ownershipVerified!==true||e.mutexResolved!==true)reasons.push('unresolved_effect_transform_or_ownership');
    if(!party.has(e.providerId))reasons.push('unknown_provider');
    if(!finite(effectTime)||!finite(e.startMs)||!finite(e.endMs)||e.startMs>effectTime||e.endMs<=effectTime)reasons.push('inactive_or_unknown_effect_interval');
    const holder=rule.placement==='source-buff'?hit.sourceId:rule.placement==='target-debuff'?hit.targetId:null;
    if(!holder||e.holderId!==holder)reasons.push('wrong_effect_holder');
    if(e.stacks!==undefined&&(!Number.isInteger(e.stacks)||e.stacks<1||(rule.tableMaxStacks&&e.stacks>rule.tableMaxStacks)))reasons.push('invalid_stacks');
    if(rule.tableMaxStacks>1&&!Number.isInteger(e.stacks))reasons.push('stack_count_missing');
    if(rule.beneficiaryScope==='provider-only'&&e.providerId!==hit.sourceId){reasons.push('source_only_effect_on_other_attacker');continue;}
    if(!['provider-only','all-matching-attackers','allies-of-provider','explicit-recipients'].includes(rule.beneficiaryScope))reasons.push('unresolved_beneficiary_scope');
    if(rule.beneficiaryScope==='explicit-recipients'&&(!Array.isArray(e.recipientIds)||!e.recipientIds.includes(hit.sourceId)))reasons.push('recipient_not_proven');
    if(e.providerId===hit.sourceId||rule.selectedForAttribution!==true||rule.contextOnly===true)baseline+=e.increment;
    else external.push(e);
   }
   const externalSum=external.reduce((n,e)=>n+e.increment,0);
   if(recorded&&pool.stage==='recorded')recordedMultiplier*=baseline+externalSum;
   buckets.push({id:pool.id,stage:pool.stage,effectTime,baseline,external,externalSum,logGain:Math.log1p(externalSum/baseline)});
  }
  if(recorded&&(!finite(recordedMultiplier)||Math.abs(recordedMultiplier-derivation?.recordedMultiplier)>1e-10*Math.max(1,recordedMultiplier)))reasons.push('recorded_stage_multiplier_mismatch');
  prepared.push({hit,buckets});
 }
 for(const [eventId,g] of recordedGroups){
  if(ids.has(eventId))reasons.push('recorded_output_counted_twice');
  if(!finite(g.sum)||Math.abs(g.sum-g.amount)>1e-8*Math.max(1,g.amount))reasons.push('recorded_output_amount_mismatch');
 }
 const originalEvents=new Map(prepared.map(({hit})=>[hit.id,hit])),originClaims=new Map(),recordedContexts=new Map();
 for(const {hit} of prepared)if(hit.kind==='recorded-component'&&hit.origin){
  const original=originalEvents.get(hit.origin.eventId);
  if(original&&(original.kind==='recorded-component'||['timestampMs','amount','sourceId','targetId','resource'].some(k=>original[k]!==hit.origin[k])))reasons.push('recorded_origin_conflicts_with_observed_event');
  const originPools=poolContext(hit.pools.filter(p=>p?.stage==='origin'));
  if(original&&poolContext(original.pools)!==originPools)reasons.push('recorded_origin_pool_conflict');
  const originClaim=canonical({origin:hit.origin,pools:originPools});
  if(originClaims.has(hit.origin.eventId)&&originClaims.get(hit.origin.eventId)!==originClaim)reasons.push('inconsistent_recorded_origin_context');
  originClaims.set(hit.origin.eventId,originClaim);
  const outputId=hit.derivation?.eventId,recordedContext=poolContext(hit.pools.filter(p=>p?.stage==='recorded'));
  if(recordedContexts.has(outputId)&&recordedContexts.get(outputId)!==recordedContext)reasons.push('inconsistent_recorded_stage_context');
  recordedContexts.set(outputId,recordedContext);
  if(recordedGroups.has(hit.origin.eventId))reasons.push('recursive_recorded_origin');
 }
 if(reasons.length)return fail();
 const totals=new Map(actors.map(id=>[id,{id,damage:0,externalGain:0,externalGiven:0}])),ledger=[];
 for(const {hit,buckets} of prepared){
  const actor=totals.get(hit.sourceId);actor.damage+=hit.amount;
  const logTotal=buckets.reduce((n,b)=>n+b.logGain,0),gain=hit.amount*(-Math.expm1(-logTotal));actor.externalGain+=gain;
  for(const bucket of buckets)for(const effect of bucket.external){
   const creditedDamage=logTotal===0||bucket.externalSum===0?0:gain*(bucket.logGain/logTotal)*(effect.increment/bucket.externalSum);
   totals.get(effect.providerId).externalGiven+=creditedDamage;
   ledger.push({eventId:hit.kind==='recorded-component'?hit.derivation.eventId:hit.id,...(hit.kind==='recorded-component'?{componentId:hit.id,originEventId:hit.origin.eventId,stage:bucket.stage,contextTimestampMs:bucket.effectTime}:{}),timestampMs:hit.timestampMs,resource:input.resource,abilityId:hit.abilityId,targetId:hit.targetId,providerId:effect.providerId,beneficiaryId:hit.sourceId,effectId:effect.effectId,ruleId:effect.ruleId,poolId:bucket.id,creditedDamage});
  }
 }
 const durationSeconds=(window.endMs-window.startMs)/1000;
 const resultActors=[...totals.values()].map(a=>({...a,dps:a.damage/durationSeconds,rdps:(a.damage-a.externalGain+a.externalGiven)/durationSeconds,dpsGiven:a.externalGiven/durationSeconds,dpsTaken:a.externalGain/durationSeconds}));
 if(resultActors.some(a=>Object.values(a).some(v=>typeof v==='number'&&!finite(v)))){reasons.push('numeric_overflow');return fail();}
 const totalGiven=resultActors.reduce((n,a)=>n+a.dpsGiven,0),totalTaken=resultActors.reduce((n,a)=>n+a.dpsTaken,0),partyDps=resultActors.reduce((n,a)=>n+a.dps,0),totalRdps=resultActors.reduce((n,a)=>n+a.rdps,0);
 const transfers=new Map();for(const l of ledger){const key=JSON.stringify([l.providerId,l.beneficiaryId,l.ruleId]);const t=transfers.get(key)||{providerId:l.providerId,beneficiaryId:l.beneficiaryId,ruleId:l.ruleId,creditedDamage:0};t.creditedDamage+=l.creditedDamage;transfers.set(key,t);}
 return {status:synthetic?'synthetic':'available',resource:input.resource,registryId:registry.id,durationSeconds,actors:resultActors,ledger,transfers:[...transfers.values()].map(t=>({...t,dps:t.creditedDamage/durationSeconds})),totalGiven,totalTaken,partyDps,totalRdps,givenTakenConservationError:totalGiven-totalTaken,rdpsConservationError:totalRdps-partyDps,reasons:[]};
}
module.exports={GATES,getRdpsValidationStatus,calculateRdpsSnapshot,prepareResistanceCounterfactual};
