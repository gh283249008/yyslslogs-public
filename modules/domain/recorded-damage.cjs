'use strict';
const {recordedComponentCredit}=require('./recorded-credit.cjs');
const {gapWindows,reconstructGapJump}=require('./gap-reconstruction.cjs');
const {calcpointHasTag,normalDamageEligible}=require('./personal-buff-baselines.cjs');
const {RecordedWindowContext}=require('./recorded-window-context.cjs');
const {RecordedSeriesContext}=require('./recorded-series-context.cjs');
const {RecordedResidualContext}=require('./recorded-residual-context.cjs');
const {RecordedPrestartContext}=require('./recorded-prestart-context.cjs');
const {wholeSourcePlan}=require('./recorded-whole-source.cjs');
const {settledHitMembership}=require('./settled-hit-membership.cjs');
const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=.01;
function recordedHitEligible(rule,hit){
 const id=hit.rawCalcpointId,preset=hit.hitInput?.schemaPreset;
 const positive=rule.calcpointIds?Number.isSafeInteger(id)&&id>0?rule.calcpointIds.includes(id):null:rule.normalDamageOnly?normalDamageEligible(id,preset):calcpointHasTag(id,rule.calcpointTag,preset);
 if(rule.excludedCalcpointTag===undefined)return positive;
 const excluded=calcpointHasTag(id,rule.excludedCalcpointTag,preset);
 if(positive===false||excluded===true)return false;
 return positive===null||excluded===null?null:true;
}
// Optional sealed-report estimator. It never supplies observed hits or raw damage.
class RecordedDamageTracker{
 constructor(policy){this.policy=policy;this.active=new Map();this.stage=new Map();this.windows=[];this.settlements=[];this.overflow=false;this.context=new RecordedWindowContext(policy);this.series=new RecordedSeriesContext(policy);this.residual=new RecordedResidualContext(policy);this.prestart=new RecordedPrestartContext(policy);}
 observeDamage(e,stream,included){if(this.policy?.enabled){this.residual.observe(e,stream.current,included);this.prestart.observe(e,this.active.values(),stream.current,included,stream.schemaPreset);}}
 observeSettlement(e){if(e.kind==='server-detailed-settlement'){this.settlements.push(e);if(this.settlements.length>128)this.settlements.shift();}}
 observeBuff(b){
  if(!this.policy?.enabled)return;this.series.observe(b);const t=Date.parse(b.observedAt),key=[b.targetActorHash,b.bag,b.buffInstanceHash].join(':');if(!Number.isFinite(t))return;
  this.context.observe(b);
  if(/clear|leave|aoi|gap/.test(b.kind||'')){for(const [k,v]of this.active)if(!b.targetActorHash||v.targetActorHash===b.targetActorHash)this.active.delete(k);for(const [k,v]of this.stage)if(!b.targetActorHash||v.targetActorHash===b.targetActorHash)this.stage.delete(k);return;}
  if(!b.targetActorHash||!b.buffInstanceHash||!Number.isSafeInteger(b.transportRecordOrdinal)||b.transportRecordOrdinal<0){this.active.delete(key);this.stage.delete(key);return;}
  const rule=this.policy.models[String(b.buffNo)];
  const previous=this.active.get(key);
  // A same-instance start_ts refresh extends the recorder; saved settlement
  // count/min/max corroborate retaining its accumulated hits until removal.
  if(previous&&(b.sourceChanged||b.kind==='snapshot'||b.buffNo!==previous.buffNo||b.sourceActorHash!==previous.sourceActorHash||t<Date.parse(previous.observedAt)||b.transportRecordOrdinal<previous.transportRecordOrdinal||(b.kind!=='remove_candidate'&&b.duration!==previous.duration)))this.active.delete(key);
  if(rule&&b.kind==='apply_candidate'&&!b.initial&&b.sourceActorHash){this.active.set(key,b);this.prestart.begin(b,rule);}
  if(b.kind==='remove_candidate'){
   const a=this.active.get(key);this.active.delete(key);
   if(a){const context=[...this.stage.values()].filter(v=>v.targetActorHash===b.targetActorHash&&v.expires>t),bu=context.filter(v=>v.buffNo===this.policy.buffNo),li=context.filter(v=>v.buffNo===this.policy.prerequisiteBuffNo);
    this.windows.push({apply:a,remove:b,provider:bu.length===1&&li.length===1?bu[0].sourceActorHash:null,covered:bu.length===1&&li.length===1&&!!bu[0].sourceActorHash});if(this.windows.length>this.policy.maxWindows){this.overflow=true;this.windows.shift();}}
   this.stage.delete(key);return;
  }
  if([this.policy.buffNo,this.policy.prerequisiteBuffNo].includes(b.buffNo)&&b.durationSeconds>0){const old=this.stage.get(key),refresh=!old||old.rawStartTimestamp!==b.rawStartTimestamp||old.duration!==b.duration;this.stage.set(key,{...b,expires:refresh?t+b.durationSeconds*1000:old.expires});}
 }
 apply(stream,snapshot){
  const current=stream.current,plan=this.policy?.enabled&&typeof stream.snapshot==='function'?settledHitMembership(current,snapshot,this.settlements,this.policy.pendingMembership):null;
  if(!plan)return this.applyRecorded(stream,snapshot);
  const originalHits=current.hits,excluded=new Set(plan.excluded);let result=null;
  try{
   // Keep encounter identity for observed prestart origins, while protecting
   // original hit credit objects from snapshot's fixed-school reevaluation.
   current.hits=structuredClone(originalHits.filter(h=>!excluded.has(h)));
   const normalized=stream.snapshot();
   if(normalized.status==='estimated'&&normalized.actors.length===snapshot.actors.length&&normalized.actors.every(a=>snapshot.actors.some(b=>a.id===b.id&&a.damage===b.damage)))result=this.applyRecorded(stream,normalized);
  }catch{result=null;}finally{current.hits=originalHits;}
  if(result?.status==='estimated')return {...result,coverage:{...result.coverage,settlementMembership:plan.proof}};
  const unchanged=this.applyRecorded(stream,snapshot);return {...unchanged,reasons:[...(unchanged.reasons||[]),'settlement_membership_normalization_failed']};
 }
 applyRecorded(stream,snapshot){
  const p=this.policy,c=stream.current;if(!p?.enabled||snapshot.status!=='estimated'||!c?.endMs||this.overflow||c.transportGaps||c.historyIncomplete)return snapshot;
  const cutoff=Date.parse(snapshot.throughObservedAt),settlement=this.settlements.filter(e=>e.encounterContext?.startObservedAt===c.startObservedAt&&Date.parse(e.observedAt)<=cutoff).at(-1);if(!settlement)return snapshot;
  const groups=new Map();for(const w of this.windows){const rule=p.models[String(w.apply.buffNo)];if(!rule||Date.parse(w.remove.observedAt)<c.startMs||Date.parse(w.remove.observedAt)>c.endMs||Date.parse(w.apply.observedAt)<c.startMs&&!rule.prestart?.enabled)continue;const key=[w.apply.sourceActorHash,w.apply.targetActorHash,rule.skillId].join(':');if(!groups.has(key))groups.set(key,{source:w.apply.sourceActorHash,target:w.apply.targetActorHash,rule,windows:[]});groups.get(key).windows.push(w);}
  for(const [key,g]of this.series.groups(c))groups.set(key,g);
  let plans=[];const rejected=[],validated=[];
  for(const [key,g]of groups){
   const actor=settlement.actors?.find(a=>a.actorHash===g.source),sum=actor?.targets?.find(t=>t.targetActorHash===g.target)?.categories?.damage?.skills?.find(s=>String(s.skillId)===String(g.rule.skillId)),detail=actor?.ownSkillDetails?.targets?.find(t=>t.targetActorHash===g.target)?.categories?.damage?.find(s=>String(s.skillId)===String(g.rule.skillId));
   if(!sum){rejected.push({key,reason:'missing-skill-settlement-total'});continue;}
   const independentDetail=!!detail&&Number.isSafeInteger(detail.count)&&Number.isFinite(detail.min)&&Number.isFinite(detail.max);
   if(!independentDetail&&!p.allowMissingIndependentDetail){rejected.push({key,reason:'missing-independent-settlement-detail'});continue;}
   let unknown=!!g.unknown;const outputs=[...(g.outputs??[])];
   for(const w of g.windows){const bounds=this.context.describe(w.apply,w.remove,g.rule);if(!bounds){unknown=true;continue;}const origins=[];for(const h of c.hits){
     if(h.sourceActorHash!==g.source||h.targetActorHash!==g.target||h.transportRecordOrdinal<w.apply.transportRecordOrdinal||h.transportRecordOrdinal>w.remove.transportRecordOrdinal)continue;
     const tag=recordedHitEligible(g.rule,h);
     // No eligible same-record hits exist in the verified exact-ID samples.
     // Their execution order is unknown; reject the group instead of guessing.
     const atApply=h.transportRecordOrdinal===w.apply.transportRecordOrdinal,atRemove=h.transportRecordOrdinal===w.remove.transportRecordOrdinal;
     if(g.rule.rejectBoundaryHits&&(atApply||atRemove)&&tag!==false){unknown=true;continue;}
     if(atApply&&!bounds.includeApply||atRemove&&!bounds.includeRemove)continue;
     if(tag===null)unknown=true;if(tag===true)origins.push(h);
    }
    if(Date.parse(w.apply.observedAt)<c.startMs){const evidence=this.prestart.verify(w,c,origins);if(!evidence){unknown=true;continue;}bounds.prestartEvidence=evidence;}
    const amount=origins.reduce((n,h)=>n+h.amount*g.rule.ratio*(w.covered?1+p.rate:1),0);if(amount>0)outputs.push({origins,amount,bounds,count:1,ratio:g.rule.ratio,covered:w.covered,provider:w.provider,at:Date.parse(w.remove.observedAt),maxDelayMs:p.maxGapDelayMs,removeRecord:w.remove.transportRecordOrdinal});}
   const amounts=outputs.flatMap(o=>Array(o.count).fill(o.amount));if(unknown||!amounts.length||!close(amounts.reduce((a,b)=>a+b,0),sum.amount)||independentDetail&&(amounts.length!==detail.count||!close(Math.min(...amounts),detail.min)||!close(Math.max(...amounts),detail.max))){rejected.push({key,reason:'settlement-model-mismatch'});continue;}
   if(independentDetail)validated.push({key,g,outputs,summary:sum,detail});
   const mine=c.hits.filter(h=>h.sourceActorHash===g.source),gaps=gapWindows(c.statHistory||[],mine,g.source);
   const partitions=this.residual.partitions(c,snapshot,g,outputs,gaps);
   for(const o of outputs){const matches=snapshot.coverage.gapSeconds.filter(x=>x.sourceActorHash===g.source&&(x.targetActorHash===g.target||x.targetActorHash===null)&&x.toMs>=o.at&&x.toMs<=o.at+o.maxDelayMs&&(close(x.missing,o.amount)||partitions.get([x.fromMs,x.toMs].join(':'))?.output===o));
    if(!matches.length||matches.length>o.count){rejected.push({key,reason:'nonunique-or-missing-residual'});continue;}
    if(matches.length<o.count)rejected.push({key,reason:'unmatched-series-ticks',generationRecord:o.generationRecord,count:o.count-matches.length});
    for(const gap of matches){const raw=gaps.find(x=>x.fromMs===gap.fromMs&&x.toMs===gap.toMs);if(!raw){rejected.push({key,reason:'missing-frozen-gap-state'});continue;}
    const previous=reconstructGapJump({...raw,sourceActorHash:g.source,targetActorHash:gap.targetActorHash,missingAmount:gap.missing},{encounterSchool:snapshot.coverage.encounterSchools[g.source]||null});if(!close(previous.gain,gap.gain)){rejected.push({key,reason:'residual-policy-mismatch'});continue;}
    const credits=o.origins.flatMap(h=>recordedComponentCredit({origin:h,ratio:o.ratio,sourceActorHash:g.source,providerActorHash:o.covered?o.provider:null,recordedRate:o.covered?p.rate:0,ruleId:p.buffNo}).credit).map(x=>independentDetail?x:{...x,estimateBasis:'missing-independent-skill-detail'});
    const partition=partitions.get([gap.fromMs,gap.toMs].join(':'));const withdrawal=partition?o.amount/gap.missing:1;
    plans.push({key,gap,previous,credits,withdrawal,partition:partition?{basis:partition.basis,retainedAmount:partition.retainedAmount,observedExcluded:partition.observedExcluded}:undefined,source:g.source,target:g.target,removeRecord:o.removeRecord,generationRecord:o.generationRecord,amount:o.amount,bounds:o.bounds,skill:g.rule.skillId,estimateBasis:independentDetail?null:'missing-independent-skill-detail'});
    }
   }
  }
  const wholePlans=[];
  for(const candidate of validated){const source=candidate.g.source;if([...groups.values()].filter(g=>g.source===source).length!==1||plans.filter(a=>a.source===source).length===candidate.outputs.reduce((n,o)=>n+o.count,0))continue;const whole=wholeSourcePlan(c,snapshot,candidate,p,recordedHitEligible,this.residual);if(whole){wholePlans.push(whole);plans=plans.filter(a=>a.source!==source);for(let i=rejected.length-1;i>=0;i--)if(rejected[i].key===candidate.key)rejected.splice(i,1);}}
  const counts=new Map();for(const a of plans){const k=[a.source,a.gap.fromMs,a.gap.toMs].join(':');counts.set(k,(counts.get(k)||0)+1);}
  const out=structuredClone(snapshot),actors=new Map([...out.actors,...out.mechanics].map(a=>[a.id,a])),transfers=new Map(out.transfers.map(t=>[[t.providerId,t.beneficiaryId,t.ruleId,!!t.reconstructed,t.estimateBasis||''].join(':'),t]));const replaced=[];
  const move=(credits,sign)=>{for(const x of credits){const n=x.creditedDamage*sign,provider=actors.get(x.providerId),actor=actors.get(x.beneficiaryId);provider.externalGiven+=n;provider.reconstructedGiven=(provider.reconstructedGiven||0)+n;actor.externalGain+=n;actor.reconstructedGain+=n;const k=[x.providerId,x.beneficiaryId,x.ruleId,true,x.estimateBasis||''].join(':');const row=transfers.get(k)||{providerId:x.providerId,beneficiaryId:x.beneficiaryId,ruleId:x.ruleId,name:String(x.ruleId)===String(p.buffNo)?p.name:x.name,creditedDamage:0,reconstructed:true,...(x.estimateBasis?{estimateBasis:x.estimateBasis}:{})};row.creditedDamage+=n;transfers.set(k,row);}};
  for(const a of plans){const k=[a.source,a.gap.fromMs,a.gap.toMs].join(':');if(counts.get(k)!==1||[...a.previous.credit,...a.credits].some(x=>!actors.has(x.providerId)||!actors.has(x.beneficiaryId))){rejected.push({key:a.key,reason:'conflicting-gap-or-provider'});continue;}move(a.previous.credit,-a.withdrawal);move(a.credits,1);const gain=a.credits.reduce((n,x)=>n+x.creditedDamage,0),row=out.coverage.gapSeconds.find(g=>g.sourceActorHash===a.source&&g.fromMs===a.gap.fromMs&&g.toMs===a.gap.toMs);row.gain=gain+a.previous.gain*(1-a.withdrawal);row.recordedDamage=true;out.coverage.reconstructedGain+=gain-a.previous.gain*a.withdrawal;replaced.push({source:a.source,target:a.target,skill:a.skill,boundaryModel:a.bounds,amount:a.amount,partition:a.partition,removeRecord:a.removeRecord,generationRecord:a.generationRecord,fromMs:a.gap.fromMs,toMs:a.gap.toMs,oldTarget:a.gap.targetActorHash,...(a.estimateBasis?{estimateBasis:a.estimateBasis}:{})});}
  const wholeSources=[];
  for(const a of wholePlans){move(a.withdrawal,-1);move(a.credits,1);out.coverage.reconstructedGain+=a.gain-a.previousGain;
   for(const gap of out.coverage.gapSeconds.filter(g=>g.sourceActorHash===a.source)){gap.previousGain=gap.gain;gap.gain=null;gap.recordedDamage=true;gap.recordedSource=a.key;const retained=a.retained?.find(r=>r.fromMs===gap.fromMs&&r.toMs===gap.toMs);if(retained){gap.retainedAmount=retained.amount;gap.retainedGain=retained.gain;}}
   wholeSources.push({source:a.source,target:a.target,skill:a.skill,basis:a.basis,amount:a.amount,gain:a.gain,previousGain:a.previousGain,originCount:a.originCount,intervals:a.gaps.length,...(a.retained?{retained:a.retained,retainedAmount:a.retainedAmount,retainedGain:a.retainedGain,modelGain:a.modelGain,observedExcluded:a.observedExcluded}:{})});
   for(const o of a.outputs)replaced.push({source:a.source,target:a.target,skill:a.skill,boundaryModel:o.bounds,amount:o.amount,removeRecord:o.removeRecord,fromMs:null,toMs:null,basis:a.basis});
  }
  out.transfers=[...transfers.values()].filter(t=>t.creditedDamage>1e-8);const given=[...actors.values()].reduce((n,a)=>n+a.externalGiven,0),taken=out.actors.reduce((n,a)=>n+a.externalGain,0);
  if([...actors.values()].some(a=>!Number.isFinite(a.externalGiven)||a.externalGiven<-.01)||out.actors.some(a=>!Number.isFinite(a.externalGain)||a.externalGain<-.01||a.externalGain>a.damage+.01)||Math.abs(given-taken)>1e-7*Math.max(1,given,taken))return {...snapshot,reasons:[...snapshot.reasons,'recorded_replacement_not_conserved']};
  out.conservation={...out.conservation,totalGiven:given,totalTaken:taken,givenTakenError:given-taken,rdpsDamageError:given-taken};out.coverage.recordedDamage={estimated:true,replaced,rejected,policy:p.id,unverifiedReplacements:replaced.filter(x=>x.estimateBasis==='missing-independent-skill-detail').length,...(wholeSources.length?{wholeSources}:{})};out.limitations.push('步乱按保存窗口、技能结算总量和唯一同额统计缺口估算；继承原击增益共同分摊，替换旧缺口贡献，不增加原始伤害。缺少独立技能次数、最小值或最大值时仍按模型估算并标记“估算”；技能总量或伤害缺口无法匹配时保留原缺口估算。');if(wholeSources.length)out.limitations.push('完整来源结算与全部残差闭合时，可整组替换原缺口贡献；区间增益不再单独分配，整组增益列在wholeSources，不推断服务器执行时刻。');return out;
 }
}
module.exports={RecordedDamageTracker,recordedHitEligible};
