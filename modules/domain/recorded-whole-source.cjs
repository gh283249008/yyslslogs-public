'use strict';
const {gapWindows,atOrBefore,reconstructGapJump}=require('./gap-reconstruction.cjs');
const {recordedComponentCredit}=require('./recorded-credit.cjs');
const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=.01;
const ordinal=n=>Number.isSafeInteger(n)&&n>=0;
const sum=(rows,key)=>rows.reduce((n,r)=>n+r[key],0);
const creditKey=c=>[c.providerId,c.beneficiaryId,c.ruleId].join(':');
function creditMap(rows){const m=new Map();for(const r of rows){const k=creditKey(r);m.set(k,(m.get(k)||0)+r.creditedDamage);}return m;}

// A complete source residual is an accounting unit, not a guessed timeline.
// The caller must supply its sole validated source group; other groups, even
// rejected ones, prevent this fallback. No partial residual can be consumed.
function wholeSourcePlan(current,snapshot,candidate,policy,eligible,residualContext=null){
 const config=policy?.wholeSource,{g,outputs,summary,detail,key}=candidate;
 if(!config?.enabled||!config.skillIds?.includes(String(g.rule.skillId))||!current?.endMs||current.transportGaps||current.historyIncomplete||current.overflow||snapshot.coverage.recordedDamage)return null;
 if(snapshot.encounterAnchor!==current.startObservedAt||snapshot.throughObservedAt!==current.counters?.observedAt)return null;
 const cutoff=Date.parse(snapshot.throughObservedAt),record=current.counters.transportRecordOrdinal,roster=new Set(snapshot.actors.map(a=>a.id)),actor=snapshot.actors.find(a=>a.id===g.source);
 if(!Number.isFinite(cutoff)||cutoff<current.endMs||!ordinal(record)||!actor||roster.has(g.target)||!close(actor.damage,current.counters.actors.find(a=>a.idHash===g.source)?.damage))return null;
 const history=(current.statHistory||[]).filter(t=>atOrBefore({timestampMs:t.t,transportRecordOrdinal:t.transportRecordOrdinal},{t:cutoff,transportRecordOrdinal:record})),last=history.at(-1);
 if(!last||last.t!==cutoff||last.transportRecordOrdinal!==record||!close(last.actors.get(g.source),actor.damage))return null;
 let previousRecord=-1,previousTime=-Infinity,previousServer=0;
 for(const t of history){const server=t.actors.get(g.source);if(!ordinal(t.transportRecordOrdinal)||t.transportRecordOrdinal<previousRecord||!Number.isFinite(t.t)||t.t<previousTime||t.t<current.startMs||Number.isFinite(server)&&server<previousServer||t.transportRecordOrdinal===previousRecord&&(t.t!==previousTime||server!==previousServer))return null;previousRecord=t.transportRecordOrdinal;previousTime=t.t;if(Number.isFinite(server))previousServer=server;}
 const mine=current.hits.filter(h=>h.sourceActorHash===g.source&&!roster.has(h.targetActorHash)&&atOrBefore(h,{t:cutoff,transportRecordOrdinal:record})),refs=new Set(),objects=new Set(mine);previousRecord=-1;
 if(mine.length>config.maxOrigins)return null;
 // Existing pending ordinary hits keep their original credit. Only modeled
 // origins below must be in-battle; the final counters must confirm every
 // admitted ordinary hit, including any pending hit brought into this fight.
 for(const h of mine){const id=[h.transportRecordOrdinal,h.hitInput?.sequence].join(':');if(!ordinal(h.transportRecordOrdinal)||!ordinal(h.hitInput?.sequence)||refs.has(id)||h.transportRecordOrdinal<previousRecord||!Number.isFinite(h.amount)||h.amount<=0||!Number.isFinite(h.timestampMs)||h.timestampMs>current.endMs)return null;refs.add(id);previousRecord=h.transportRecordOrdinal;}
 if(!close(sum(mine,'amount'),actor.observedDamage))return null;
 if(!outputs.length||outputs.length>policy.maxWindows||outputs.some(o=>o.count!==1||!Number.isFinite(o.amount)||o.amount<=0||!Number.isFinite(o.at)||o.at<current.startMs||o.at>current.endMs||!ordinal(o.removeRecord)||o.removeRecord>record))return null;
 const total=sum(outputs,'amount');
 const sourceResidual=actor.damage-sum(mine,'amount');
 if(outputs.length!==detail?.count||!close(total,summary?.amount)||!close(Math.min(...outputs.map(o=>o.amount)),detail.min)||!close(Math.max(...outputs.map(o=>o.amount)),detail.max)||!close(actor.reconstructedDamage,sourceResidual)||!close(actor.unreconstructedDamage,0))return null;
 const excluded=[];
 if(!close(sourceResidual,total)){
  // Exclusions come only from the tracker bound to this actual encounter.
  // Inspect every source exclusion before the cutoff; unknown targets cannot
  // be silently dropped merely because a known self hit explains the amount.
  if(!config.retainObservedExcluded||!policy.partition?.enabled||residualContext?.current!==current||residualContext.invalid||!residualContext.policy?.enabled||!Array.isArray(residualContext.events)||residualContext.events.length>policy.partition.maxExcludedHits||sourceResidual<total)return null;
  const seen=new Set(refs);let prior=-1;
  for(const h of residualContext.events){if(h.sourceActorHash!==g.source)continue;
   if(!ordinal(h.transportRecordOrdinal)||!ordinal(h.sequence)||!Number.isFinite(h.timestampMs)||!Number.isFinite(h.amount)||h.amount<=0)return null;
   if(h.transportRecordOrdinal>record||h.timestampMs>cutoff||h.timestampMs>current.endMs)continue;
   const ref=[h.transportRecordOrdinal,h.sequence].join(':');
   if(h.timestampMs<current.startMs||h.transportRecordOrdinal<prior||seen.has(ref)||!roster.has(h.targetActorHash))return null;
   seen.add(ref);prior=h.transportRecordOrdinal;excluded.push(h);
  }
  if(!excluded.length||!close(sourceResidual-total,sum(excluded,'amount')))return null;
 }
 const origins=new Set(),credits=[];
 try{for(const o of outputs){let amount=0;if(o.ratio!==g.rule.ratio||!o.origins.length)return null;
   for(const h of o.origins){if(!objects.has(h)||origins.has(h)||h.sourceActorHash!==g.source||h.targetActorHash!==g.target||h.timestampMs<current.startMs||h.transportRecordOrdinal>o.removeRecord||eligible(g.rule,h)!==true)return null;origins.add(h);const joint=recordedComponentCredit({origin:h,ratio:o.ratio,sourceActorHash:g.source,providerActorHash:o.covered?o.provider:null,recordedRate:o.covered?policy.rate:0,ruleId:policy.buffNo});amount+=joint.amount;credits.push(...joint.credit);}if(!close(amount,o.amount))return null;
  }}catch{return null;}
 const raw=gapWindows(history,mine,g.source),gaps=snapshot.coverage.gapSeconds.filter(gap=>gap.sourceActorHash===g.source);
 if(!gaps.length||gaps.length!==raw.length||!close(sum(gaps,'missing'),sourceResidual)||!close(sum(raw,'missing'),sourceResidual))return null;
 const corrected=excluded.length?gapWindows(history,[...mine,...excluded].sort((a,b)=>a.transportRecordOrdinal-b.transportRecordOrdinal||(a.sequence??a.hitInput?.sequence)-(b.sequence??b.hitInput?.sequence)),g.source):raw;
 if(!close(sum(corrected,'missing'),total)||corrected.some(c=>!raw.some(r=>r.fromMs===c.fromMs&&r.toMs===c.toMs)))return null;
 const intervals=new Set(),previous=[],retained=[];
 try{for(const gap of gaps){const interval=[gap.fromMs,gap.toMs].join(':');if(intervals.has(interval)||!Number.isFinite(gap.fromMs)||!Number.isFinite(gap.toMs)||gap.toMs<gap.fromMs||gap.recordedDamage)return null;intervals.add(interval);const candidates=raw.filter(r=>r.fromMs===gap.fromMs&&r.toMs===gap.toMs);if(candidates.length!==1||!close(candidates[0].missing,gap.missing))return null;const old=reconstructGapJump({...candidates[0],sourceActorHash:g.source,targetActorHash:gap.targetActorHash,missingAmount:gap.missing},{encounterSchool:snapshot.coverage.encounterSchools[g.source]||null});if(!close(old.gain,gap.gain))return null;previous.push(...old.credit);
   if(excluded.length){const parts=corrected.filter(r=>r.fromMs===gap.fromMs&&r.toMs===gap.toMs);if(parts.length>1)return null;const amount=gap.missing-(parts[0]?.missing||0);if(amount<-.01)return null;if(amount>.01){const credit=old.credit.map(c=>({...c,creditedDamage:c.creditedDamage*amount/gap.missing}));retained.push({fromMs:gap.fromMs,toMs:gap.toMs,amount,gain:sum(credit,'creditedDamage'),credit});}}
  }}catch{return null;}
 if(excluded.length&&!close(sum(retained,'amount'),sum(excluded,'amount')))return null;
 const previousMap=creditMap(previous),withdrawal=snapshot.transfers.filter(t=>t.reconstructed&&t.beneficiaryId===g.source),actualMap=creditMap(withdrawal);
 if([...new Set([...previousMap.keys(),...actualMap.keys()])].some(k=>!close(previousMap.get(k)||0,actualMap.get(k)||0)))return null;
 const modelGain=sum(credits,'creditedDamage');credits.push(...retained.flatMap(r=>r.credit));
 const actors=new Set([...snapshot.actors,...snapshot.mechanics].map(a=>a.id));if([...withdrawal,...credits].some(c=>!actors.has(c.providerId)||!actors.has(c.beneficiaryId)||!Number.isFinite(c.creditedDamage)||c.creditedDamage<0))return null;
 return {key,source:g.source,target:g.target,skill:g.rule.skillId,outputs,gaps,amount:total,withdrawal,credits,previousGain:sum(withdrawal,'creditedDamage'),gain:sum(credits,'creditedDamage'),originCount:origins.size,basis:excluded.length?'independent-settlement-and-observed-excluded-source-residual':'independent-settlement-and-complete-source-residual',...(excluded.length?{retained,retainedAmount:sum(excluded,'amount'),retainedGain:sum(retained,'gain'),modelGain,observedExcluded:excluded.map(h=>({record:h.transportRecordOrdinal,sequence:h.sequence,source:h.sourceActorHash,target:h.targetActorHash,amount:h.amount}))}:{})};
}
module.exports={wholeSourcePlan};
