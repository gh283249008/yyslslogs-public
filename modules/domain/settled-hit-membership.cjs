'use strict';
const {normalDamageEligible}=require('./personal-buff-baselines.cjs');
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=.01;
const one=(rows,predicate)=>{const matches=(rows||[]).filter(predicate);return matches.length===1?matches[0]:null;};
const skill=id=>/^[1-9]\d*$/.test(String(id))?String(id):null;
const key=h=>[h.sourceActorHash,h.targetActorHash,skill(h.rawSkillId)].join(':');

// Final ordinary-skill accounting can prove that pending notifications were
// outside this encounter. Neither delayed damage nor residual amount selects hits.
function settledHitMembership(current,snapshot,settlements,policy){
 if(!policy?.enabled||snapshot?.status!=='estimated'||!current?.endMs||current.transportGaps||current.historyIncomplete||current.overflow||!Array.isArray(current.hits)||current.hits.length>policy.maxHits)return null;
 const start=current.startMs,end=current.endMs,cutoff=Date.parse(snapshot.throughObservedAt),counter=current.counters;
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||snapshot.encounterAnchor!==current.startObservedAt||!counter||snapshot.throughObservedAt!==counter.observedAt||!valid(counter.transportRecordOrdinal)||!Number.isFinite(cutoff)||cutoff<end)return null;
 const settlement=settlements.filter(e=>e.encounterContext?.startObservedAt===current.startObservedAt&&Date.parse(e.observedAt)<=cutoff).at(-1);
 if(!settlement||!valid(settlement.transportRecordOrdinal)||settlement.transportRecordOrdinal>counter.transportRecordOrdinal||Date.parse(settlement.observedAt)<end)return null;
 const roster=new Set(snapshot.actors.map(a=>a.id)),groups=new Map();
 for(const h of current.hits)if(h.timestampMs<start&&roster.has(h.sourceActorHash)&&!roster.has(h.targetActorHash)&&skill(h.rawSkillId)){
  const k=key(h);if(!groups.has(k))groups.set(k,{source:h.sourceActorHash,target:h.targetActorHash,skill:skill(h.rawSkillId),pending:[]});groups.get(k).pending.push(h);
 }
 const excluded=[],proofs=[];
 for(const [k,g]of groups){
  if(!g.target||g.pending.length>policy.maxPendingHits)continue;
  const actor=one(settlement.actors,a=>a.actorHash===g.source),view=one(snapshot.actors,a=>a.id===g.source),server=one(counter.actors,a=>a.idHash===g.source);
  if(!actor||!view||!server||!close(actor.totals?.damage,view.damage)||!close(server.damage,view.damage))continue;
  const sourceHits=current.hits.filter(h=>h.sourceActorHash===g.source&&!roster.has(h.targetActorHash));
  if(!close(sourceHits.reduce((n,h)=>n+h.amount,0),view.observedDamage))continue;
  const history=(current.statHistory||[]).filter(t=>t.actors?.has(g.source));
  if(!history.length||history[0].actors.get(g.source)!==0||!valid(history[0].transportRecordOrdinal)||g.pending.some(h=>h.transportRecordOrdinal>=history[0].transportRecordOrdinal))continue;
  const target=one(actor.targets,t=>t.targetActorHash===g.target),details=one(actor.ownSkillDetails?.targets,t=>t.targetActorHash===g.target);
  const total=one(target?.categories?.damage?.skills,s=>String(s.skillId)===g.skill),detail=one(details?.categories?.damage,s=>String(s.skillId)===g.skill);
  if(!total||!detail||!Number.isSafeInteger(detail.count)||detail.count<=0||!Number.isFinite(detail.min)||!Number.isFinite(detail.max)||detail.min<=0||detail.max<detail.min)continue;
  const all=current.hits.filter(h=>key(h)===k),refs=new Set();let previous=-1,bad=false;
  for(const h of all){
   const raw=h.hitInput,ref=[h.transportRecordOrdinal,raw?.sequence].join(':');
   if(!valid(h.transportRecordOrdinal)||!valid(raw?.sequence)||refs.has(ref)||h.transportRecordOrdinal<previous||h.transportRecordOrdinal>counter.transportRecordOrdinal||!Number.isFinite(h.timestampMs)||h.timestampMs>end||!Number.isFinite(h.amount)||h.amount<=0||raw.sourceActorHash!==h.sourceActorHash||raw.targetActorHash!==h.targetActorHash||raw.transportRecordOrdinal!==h.transportRecordOrdinal||Date.parse(raw.observedAt)!==h.timestampMs||raw.amount!==h.amount||String(raw.rawSkillId)!==g.skill||raw.rawCalcpointId!==h.rawCalcpointId||normalDamageEligible(h.rawCalcpointId,raw.schemaPreset)!==true){bad=true;break;}
   refs.add(ref);previous=h.transportRecordOrdinal;
  }
  if(bad)continue;
  const kept=all.filter(h=>h.timestampMs>=start),amount=kept.reduce((n,h)=>n+h.amount,0);
  if(kept.length!==detail.count||!close(amount,total.amount)||!close(Math.min(...kept.map(h=>h.amount)),detail.min)||!close(Math.max(...kept.map(h=>h.amount)),detail.max)||all.length===detail.count)continue;
  excluded.push(...g.pending);proofs.push({source:g.source,target:g.target,skill:g.skill,serverTotal:total.amount,detail:{count:detail.count,min:detail.min,max:detail.max},excluded:g.pending.map(h=>({record:h.transportRecordOrdinal,sequence:h.hitInput.sequence,amount:h.amount})),excludedAmount:g.pending.reduce((n,h)=>n+h.amount,0)});
 }
 if(!excluded.length||excluded.length>policy.maxPendingHits)return null;
 return {excluded,proof:{basis:'independent-ordinary-skill-settlement',groups:proofs,excludedHits:excluded.length,excludedAmount:excluded.reduce((n,h)=>n+h.amount,0)}};
}
module.exports={settledHitMembership};
