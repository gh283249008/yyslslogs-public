'use strict';
// Reconstructs rDPS credit for damage the server counted but we never received
// as a per-hit notification (e.g. delayed/self-only burst effects such as
// "醉杀状态"). Never invents hit timing, skill identity or exact amounts for
// any single swing; only the per-second server-counted total is real.
//
// Legacy interpolation retained for historical verification only.
// Production uses reconstructGapJump (user-approved 2026-10-23).
// Historical method (user-approved 2026-10-20):
// 1. Per-second ledger of server cumulative damage vs captured-hit damage
//    (both already observed data, see p1-simple-rdps observeStatistic/current.hits).
// 2. Differences use the same reception cutoff for both streams. A later
//    decrease retracts the most recent unmatched gap (late notifications).
//    Amounts are observed differences; their placement is a reception-clock
//    approximation, NOT a proven server execution time.
// 3. Buff coverage for that second comes from the buff interval ledger
//    (buff-events derived intervals), which is captured independently of
//    per-hit notifications. Missing buff observations remain a limitation.
// 4. If a buff's [start,end] interval only partially overlaps the gap second,
//    the overlap fraction is applied by linear time interpolation within that
//    one second only (never across multiple seconds) to decide how much of
//    the missing amount that buff's window covers. This is the explicitly
//    approved linear-interpolation fallback, scoped to sub-second boundaries.
// 5. Use the SAME simpleHitCredit math. Unknown skill conditions stay unknown;
//    no synthetic hit or guessed skill is inserted.
const {simpleHitCredit}=require('./hit-credit.cjs');
const finite=n=>typeof n==='number'&&Number.isFinite(n);

const atOrBefore=(hit,tick)=>Number.isInteger(hit.transportRecordOrdinal)&&Number.isInteger(tick.transportRecordOrdinal)
 ? hit.transportRecordOrdinal<=tick.transportRecordOrdinal : hit.timestampMs<=tick.t;

// Reconcile reception-time cumulative residuals. Negative residuals (hits
// ahead of statistics) never become gaps; late hits retract recent estimates.
// The first observation has no lower boundary and remains explicitly untimed.
function gapWindows(history,hits,actorId){
 let captured=0,index=0,residual=0,previous=null;
 const windows=[];
 for(const tick of history){
  while(index<hits.length&&atOrBefore(hits[index],tick))captured+=hits[index++].amount;
  const server=tick.actors.get(actorId);if(!finite(server))continue;
  const next=Math.max(0,server-captured),change=next-residual;
  if(change>1e-7)windows.push({fromMs:previous?.t??null,toMs:tick.t,missing:change,...(tick.jump?{jump:tick.jump,previousJump:previous?.jump,transportRecordOrdinal:tick.transportRecordOrdinal}: {})});
  else if(change<0){
   let retract=-change;
   while(retract>1e-7&&windows.length){
    const last=windows.at(-1),take=Math.min(last.missing,retract);
    last.missing-=take;retract-=take;if(last.missing<1e-7)windows.pop();
   }
  }
  if(!previous||server!==previous.actors.get(actorId))previous=tick;residual=next;
 }
 return windows.filter(w=>w.missing>0.01);
}

// buffIntervals: [{targetActorHash, buffNo, buffInstanceHash, sourceActorHash, startMs, endMs, charge_level}]
// Built by the caller from buff-events.jsonl (apply_candidate/update/snapshot -> remove_candidate spans).
// This module does not read files; it is pure reconstruction logic, testable in isolation.

function overlapFraction(buff, secStartMs, secEndMs){
 const from=Math.max(buff.startMs, secStartMs), to=Math.min(buff.endMs, secEndMs);
 if(to<=from)return 0;
 return (to-from)/(secEndMs-secStartMs);
}

// Returns buffs active during [secStartMs,secEndMs] with their coverage fraction of that second.
// A buff covering the whole second has fraction 1; a buff whose edge falls inside
// the second gets the linear sub-second fraction (step 4 above).
function buffsForSecond(buffIntervals, actorHash, secStartMs, secEndMs){
 return buffIntervals
  .filter(b=>b.targetActorHash===actorHash && b.startMs<secEndMs && b.endMs>secStartMs)
  .map(b=>({...b, coverageFraction:overlapFraction(b, secStartMs, secEndMs)}))
  .filter(b=>b.coverageFraction>0);
}

// gapSecond: {sourceActorHash, targetActorHash, secStartMs, secEndMs, missingAmount}
// buffIntervals: full interval ledger (see above)
// skillTypeHint: {damageType, currentKungfu, conditionalDamageEligible} approximated from
//   adjacent captured hits of the same actor; null fields propagate as "unknown", never guessed as a default.
// targetAttributes/targetWeak: same inputs simpleHitCredit already requires for real hits.
function reconstructGapSecond(gapSecond, buffIntervals, {targetAttributes={}, targetWeak=null, personalDamageBonus=null, currentKungfu=null, conditionalDamageEligible=null, contextAt=null, contextBoundaries=[]}={}){
 const {sourceActorHash, targetActorHash, secStartMs, secEndMs, missingAmount}=gapSecond;
 if(!finite(missingAmount)||missingAmount<=0)throw Error('invalid_gap_missing_amount');
 if(!finite(secStartMs)||!finite(secEndMs)||secEndMs<=secStartMs)throw Error('invalid_gap_second_window');
 const buffs=buffsForSecond(buffIntervals, sourceActorHash, secStartMs, secEndMs)
  .concat(buffsForSecond(buffIntervals, targetActorHash, secStartMs, secEndMs));
 // Partial-coverage buffs are scaled by their within-second time fraction before
 // being handed to the real pool math: a buff present for 40% of the second is
 // treated, for this reconstructed second only, as if its rate applied to 40%
 // of the missing amount's pool weight. This is the approved linear fallback;
 // full-second buffs pass through with fraction 1 (no distortion).
 const stateCuts=contextBoundaries.filter(t=>t>secStartMs&&t<secEndMs);
 const fullCoverage=buffs.every(b=>b.coverageFraction===1)&&stateCuts.length===0;
 const calculate=(amount,effects,t)=>simpleHitCredit({amount,sourceActorHash,targetActorHash,effects,targetAttributes,targetWeak,personalDamageBonus,currentKungfu,conditionalDamageEligible,...(contextAt?contextAt(t):{})});
 // Partial coverage: different buffs can cover different, non-nested portions
 // of the second (e.g. buff A covers [0.0,0.6), buff B covers [0.3,1.0)). The
 // only correct way to apply the approved linear-interpolation fallback is to
 // cut the second at every buff start/end boundary that falls inside it, so
 // each resulting sub-interval has one unambiguous, constant buff combination.
 // Sorting buffs by coverage fraction and stacking them (the earlier, wrong
 // approach) silently drops any buff whose fraction is not the maximum.
 if(!fullCoverage){
  const boundaries=new Set([0,1]);
  for(const t of stateCuts)boundaries.add((t-secStartMs)/(secEndMs-secStartMs));
  for(const b of buffs){
   const from=Math.max(b.startMs,secStartMs), to=Math.min(b.endMs,secEndMs);
   boundaries.add((from-secStartMs)/(secEndMs-secStartMs));
   boundaries.add((to-secStartMs)/(secEndMs-secStartMs));
  }
  const cuts=[...boundaries].sort((a,b)=>a-b);
  const slices=[];
  for(let i=0;i<cuts.length-1;i++){
   const from=cuts[i],to=cuts[i+1],mid=(from+to)/2,width=to-from;
   if(width<=0)continue;
   const active=buffs.filter(b=>{const bf=Math.max(0,(Math.max(b.startMs,secStartMs)-secStartMs)/(secEndMs-secStartMs)),bt=Math.min(1,(Math.min(b.endMs,secEndMs)-secStartMs)/(secEndMs-secStartMs));return bf<=mid&&bt>=mid;});
   slices.push({amount:missingAmount*width,t:secStartMs+mid*(secEndMs-secStartMs), effects:active.map(b=>({buffNo:b.buffNo,level:b.level,buffInstanceHash:b.buffInstanceHash,sourceActorHash:b.sourceActorHash,targetActorHash:b.targetActorHash,charge_level:b.charge_level,ambiguousStackOwner:!!b.ambiguousStackOwner}))});
  }
  const results=slices.map(s=>calculate(s.amount,s.effects,s.t));
  const gain=results.reduce((n,r)=>n+r.gain,0);
  const creditByKey=new Map();
  for(const r of results)for(const c of r.credit){const k=c.providerId+'|'+c.beneficiaryId+'|'+c.ruleId;const row=creditByKey.get(k)||{...c,creditedDamage:0};row.creditedDamage+=c.creditedDamage;creditByKey.set(k,row);}
  return {status:'reconstructed', gain, credit:[...creditByKey.values()], issues:[...new Set(results.flatMap(r=>r.issues))], reconstruction:{secStartMs,secEndMs,missingAmount,subSecondSlices:slices.length,fullSecondCoverage:false}};
 }
 const effects=buffs.map(b=>({buffNo:b.buffNo,level:b.level,buffInstanceHash:b.buffInstanceHash,sourceActorHash:b.sourceActorHash,targetActorHash:b.targetActorHash,charge_level:b.charge_level,ambiguousStackOwner:!!b.ambiguousStackOwner}));
 const result=calculate(missingAmount,effects,(secStartMs+secEndMs)/2);
 return {...result, status:'reconstructed', reconstruction:{secStartMs,secEndMs,missingAmount,subSecondSlices:1,fullSecondCoverage:true}};
}

// Frozen reception-time state; no interpolation of missing hits.
function reconstructGapJump(window, context={}){
 const {sourceActorHash,targetActorHash,missingAmount,fromMs,toMs,jump,previousJump}=window;
 if(!jump)throw Error('missing_statistic_jump_snapshot');
 if(!finite(missingAmount)||missingAmount<=0)throw Error('invalid_gap_missing_amount');
 const relevant=b=>b.targetActorHash===sourceActorHash||(targetActorHash&&b.targetActorHash===targetActorHash);
 const effects=jump.effects.filter(relevant);
 const signature=xs=>JSON.stringify(xs.filter(relevant).map(b=>[b.targetActorHash,b.buffInstanceHash,b.buffNo,b.sourceActorHash,b.charge_level,b.level]).sort());
 const holders=[sourceActorHash,targetActorHash].filter(Boolean);
 const buffChangedInInterval=!!previousJump&&(holders.some(a=>(jump.revisions.get(a)||0)!==(previousJump.revisions.get(a)||0))||signature(jump.effects)!==signature(previousJump.effects));
 const result=simpleHitCredit({amount:missingAmount,sourceActorHash,targetActorHash,effects,schemaPreset:jump.schemaPreset??null,sourceAttributes:jump.attributes.get(sourceActorHash)||{},targetAttributes:jump.attributes.get(targetActorHash)||{},targetWeak:jump.weak.get(targetActorHash)??null,...context});
 return {...result,status:'reconstructed',issues:[...result.issues,...(buffChangedInInterval?['buff_changed_in_statistic_interval']:[])],reconstruction:{timingBasis:'statistic-jump-buff-snapshot-estimate',buffSnapshotAtMs:toMs,buffChangedInInterval,estimated:true,intervalStartMs:fromMs}};
}
module.exports={reconstructGapJump,reconstructGapSecond, buffsForSecond, overlapFraction, gapWindows, atOrBefore};
