'use strict';
const {gapWindows}=require('./gap-reconstruction.cjs');
const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=.01;
const ordinal=e=>e.transportRecordOrdinal;
const valid=n=>Number.isSafeInteger(n)&&n>=0;
const interval=g=>[g.fromMs,g.toMs].join(':');

// Only records actually excluded from the ordinary-hit ledger may explain a
// mixed residual. They never become additional raw damage or modeled hits.
class RecordedResidualContext {
 constructor(policy){this.policy=policy?.partition;this.current=null;this.events=[];this.keys=new Set();this.invalid=false;}
 observe(e,current,included){
  if(!this.policy?.enabled||!current)return;
  if(this.current!==current){this.current=current;this.events=[];this.keys=new Set();this.invalid=false;}
  if(included||e.amount===0)return;
  const t=Date.parse(e.observedAt),key=[ordinal(e),e.sequence].join(':');
  if(!valid(ordinal(e))||!valid(e.sequence)||!Number.isFinite(t)||!Number.isFinite(e.amount)||e.amount<=0||!e.sourceActorHash||!e.targetActorHash||this.keys.has(key)||ordinal(e)<(this.events.at(-1)?.transportRecordOrdinal??0)||this.events.length>=this.policy.maxExcludedHits){this.invalid=true;return;}
  if(t<current.startMs)return;
  this.keys.add(key);this.events.push({sourceActorHash:e.sourceActorHash,targetActorHash:e.targetActorHash,amount:e.amount,timestampMs:t,transportRecordOrdinal:ordinal(e),sequence:e.sequence});
 }
 partitions(current,snapshot,group,outputs,raw){
  const empty=()=>new Map();
  if(!this.policy?.enabled||this.current!==current||this.invalid)return empty();
  const roster=new Set(snapshot.actors.map(a=>a.id));if(!roster.has(group.source)||roster.has(group.target))return empty();
  const cutoff=Date.parse(snapshot.throughObservedAt),history=(current.statHistory??[]).filter(s=>s.t<=cutoff),last=history.at(-1);
  if(!last||!valid(ordinal(last)))return empty();
  const hits=current.hits.filter(h=>h.sourceActorHash===group.source&&ordinal(h)<=ordinal(last)),included=new Set(hits.map(h=>[ordinal(h),h.hitInput?.sequence].join(':')));
  const extra=this.events.filter(h=>h.sourceActorHash===group.source&&ordinal(h)<=ordinal(last)&&h.timestampMs<=cutoff&&h.timestampMs<=current.endMs&&(h.sourceActorHash===h.targetActorHash||roster.has(h.targetActorHash)));
  if(!extra.length||extra.some(h=>included.has([ordinal(h),h.sequence].join(':'))))return empty();
  const corrected=gapWindows(history,[...hits,...extra].sort((a,b)=>ordinal(a)-ordinal(b)||((a.sequence??a.hitInput?.sequence??0)-(b.sequence??b.hitInput?.sequence??0))),group.source);
  const sum=xs=>xs.reduce((n,x)=>n+x.missing,0),expected=outputs.reduce((n,o)=>n+o.amount*o.count,0),observed=extra.reduce((n,h)=>n+h.amount,0);
  if(!close(sum(corrected),expected)||!close(sum(raw)-sum(corrected),observed))return empty();
  const used=new Set(),parts=new Map();
  for(const o of outputs){
   const candidates=corrected.filter(g=>g.toMs>=o.at&&g.toMs<=o.at+o.maxDelayMs&&close(g.missing,o.amount));
   if(candidates.length!==o.count)return empty();
   for(const g of candidates){
    const k=interval(g);if(used.has(k))return empty();used.add(k);
    const original=raw.filter(x=>interval(x)===k),projected=snapshot.coverage.gapSeconds.filter(x=>x.sourceActorHash===group.source&&interval(x)===k&&(x.targetActorHash===group.target||x.targetActorHash===null));
    const starts=history.filter(s=>s.t===g.fromMs),ends=history.filter(s=>s.t===g.toMs);
    if(original.length!==1||projected.length!==1||starts.length!==1||ends.length!==1||!valid(ordinal(starts[0]))||!valid(ordinal(ends[0]))||ordinal(starts[0])>=ordinal(ends[0])||!close(original[0].missing,projected[0].missing))return empty();
    const local=extra.filter(h=>ordinal(h)>ordinal(starts[0])&&ordinal(h)<=ordinal(ends[0])),retained=local.reduce((n,h)=>n+h.amount,0);
    if(!close(original[0].missing-o.amount,retained))return empty();
    if(retained>.01)parts.set(k,{output:o,retainedAmount:retained,observedExcluded:local.map(h=>({record:ordinal(h),sequence:h.sequence,source:h.sourceActorHash,target:h.targetActorHash,amount:h.amount})),basis:'observed-excluded-hits-and-whole-fight-closure'});
   }
  }
  return used.size===corrected.length?parts:empty();
 }
}
module.exports={RecordedResidualContext};
