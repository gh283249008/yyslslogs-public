'use strict';
const {ACTIVE_PROFILE,F,POLICY,policySha256,registry,personalBuffs,kungfuChannels,finite,time}=require('./context.cjs');
const {simpleHitCredit}=require('./hit-credit.cjs');
class SimpleRdpsStream {
 constructor(source){this.source=source;this.buffRevisions=new Map();this.buffs=new Map();this.buffHistory=[];this.openBuffHistory=new Map();this.stateHistory=[];this.attrs=new Map();this.weak=new Map();this.npcs=new Set();this.current=null;this.pending=[];this.lastTime=0;this.seen=new Set();this.error=null;}
 // Lost transport bytes may hide buff removals and qi changes: active buffs and
 // weak state restart from later observations. Hits inside the gap are absent
 // and stay uncredited; base attributes keyed by stable actor id are retained.
 // Until an actor's buffs are seen again in a full snapshot, its hits carry an
 // explicit unknown-state issue instead of silently counting as zero gain.
 markGap(gap){for(const key of this.openBuffHistory.keys())this.closeHistoryInterval(key,this.lastTime);this.buffs.clear();this.weak.clear();this.pending=[];for(const a of this.attrs.values())delete a.attributeResistanceWithEffects;this.resynced=new Set();if(this.current&&!this.current.endMs)this.current.transportGaps=(this.current.transportGaps||0)+1;this.gaps=(this.gaps||0)+1;this.lastGap=gap||null;}
 observeAttribute(e){
  if(e.status==='invalidated'){
   for(const [actor,a] of this.attrs)if(!e.targetActorHash||actor===e.targetActorHash){delete a.attributeResistanceWithEffects;if(finite(time(e)))this.stateHistory.push({t:time(e),target:actor,attributes:{...a}});}
   return;
  }
  const a=this.attrs.get(e.targetActorHash)||{};
  if(e.saltGeneration!==undefined&&a.attributeSaltGeneration!==e.saltGeneration){delete a.attributeResistanceWithEffects;a.attributeSaltGeneration=e.saltGeneration;}
  const property=/^PRO_DEF_([A-E])$/.exec(e.attribute||'');
  if(property){
   const values={...a.attributeResistanceWithEffects};
   if(e.status==='decoded-observation'&&finite(e.value))values[property[1]]=e.value;else delete values[property[1]];
   a.attributeResistanceWithEffects=values;
  }else{
   if(e.status!=='decoded-observation'||!finite(e.value)||!e.initial)return;
   if(e.attribute==='W_ATK_PEN_RDC')a.baseResistance=e.value;
   if(e.attribute==='W_DEF')a.baseDefense=e.value;
  }
  this.attrs.set(e.targetActorHash,a);
  if(finite(time(e)))this.stateHistory.push({t:time(e),target:e.targetActorHash,attributes:{...a}});
 }
 observeBuff(e){
  const t=time(e);if(!finite(t))return;this.lastTime=Math.max(t,this.lastTime);
  if(this.resynced&&e.targetActorHash&&(e.initial||e.kind==='snapshot'))this.resynced.add(e.targetActorHash);
  if(!e.buffInstanceHash){if(/clear|aoi|leave/.test(e.kind||''))for(const[k,b]of this.buffs){if(b.targetActorHash===e.targetActorHash){this.closeHistoryInterval(k,t);this.buffs.delete(k);}}return;}
  const key=e.targetActorHash+':'+e.buffInstanceHash;
  if(e.kind==='remove_candidate'||/clear|aoi|leave/.test(e.kind||'')){this.closeHistoryInterval(key,t);this.buffs.delete(key);return;}
  if(!POLICY.rules[e.buffNo]&&!personalBuffs.hasPersonalRule(e.buffNo)&&!registry.rules[e.buffNo]?.selectedForAttribution)return;
  const prior=this.buffs.get(key),duration=e.durationSeconds;
  if(!finite(duration)||duration<=0)return;
  const refresh=!prior||e.rawStartTimestamp!==prior.rawStartTimestamp||e.duration!==prior.duration;
  // Nominal server-clock timestamps are not mixed with local capture time.
  const expiresMs=refresh?t+duration*1000:prior.expiresMs;
  const next={...e,expiresMs,ambiguousStackOwner:!!(prior?.ambiguousStackOwner||(e.sourceChanged&&POLICY.rules[e.buffNo]?.maxStacks>1&&e.charge_level>1))};
  const changed=refresh||['buffNo','level','sourceActorHash','charge_level','ambiguousStackOwner','resourceChangeSuccess'].some(k=>prior?.[k]!==next[k]);
  if(changed)this.closeHistoryInterval(key,t);
  this.buffs.set(key,next);
  if(changed)this.openHistoryInterval(key,next,t);
 }
 // Independent closed-interval ledger of past buff coverage, kept separately
 // from the live this.buffs map (which only holds currently-active state) so
 // a later gap-second reconstruction can ask "was this buff active at time T"
 // for any T in the fight, not just "is it active now".
 openHistoryInterval(key,buff,startMs){this.buffRevisions.set(buff.targetActorHash,(this.buffRevisions.get(buff.targetActorHash)||0)+1);const iv={key,buffNo:buff.buffNo,level:buff.level,buffInstanceHash:buff.buffInstanceHash,sourceActorHash:buff.sourceActorHash,targetActorHash:buff.targetActorHash,charge_level:buff.charge_level,resourceChangeSuccess:buff.resourceChangeSuccess,ambiguousStackOwner:buff.ambiguousStackOwner,startMs,endMs:buff.expiresMs};this.buffHistory.push(iv);this.openBuffHistory.set(key,iv);if(this.buffHistory.length>200000){this.buffHistory=this.buffHistory.slice(-100000);if(this.current)this.current.historyIncomplete=true;}}
 closeHistoryInterval(key,endMs){const open=this.openBuffHistory.get(key);if(open){this.buffRevisions.set(open.targetActorHash,(this.buffRevisions.get(open.targetActorHash)||0)+1);open.endMs=Math.min(endMs,open.endMs);}this.openBuffHistory.delete(key);}
 observeEncounter(e){
  const t=time(e);if(!finite(t))return;this.lastTime=Math.max(t,this.lastTime);
  if(e.kind==='target-qi-state'){this.weak.set(e.targetActorHash,e.weak);this.stateHistory.push({t,target:e.targetActorHash,weak:e.weak});return;}
  const context=e.identityContext||e;
  if(context.kind==='encounter-identity'||Array.isArray(context.npcs)){
   if(e.initial&&context.spaceHash!==this.spaceHash){for(const key of this.openBuffHistory.keys())this.closeHistoryInterval(key,t);this.buffs.clear();this.npcs.clear();this.weak.clear();}
   this.spaceHash=context.spaceHash||this.spaceHash;
   for(const n of context.npcs||[])if(n.entityClass==='Npc')this.npcs.add(n.actorHash);
  }
  if(e.kind!=='boss-battle-state')return;
  if(e.active&&!e.initial&&e.previousActive===false){
   this.current={startObservedAt:e.observedAt,startMs:t,endMs:null,spaceHash:e.spaceHash,hits:[],npcNo:null,counters:null,overflow:false};
   this.buffHistory=this.buffHistory.filter(iv=>iv.endMs>=t-1000);
   // Keep one state baseline per actor/field plus observations in this pull.
   const states=new Map();for(const row of this.stateHistory)states.set(row.target+('attributes' in row?':attributes':':weak'),row);
   this.stateHistory=[...states.values()].sort((a,b)=>a.t-b.t);
   for(const h of this.pending)if(h.timestampMs>=t-1000&&this.npcs.has(h.targetActorHash))this.current.hits.push(h);
   this.pending=[];this.error=null;
  }else if(!e.active&&this.current&&!e.initial&&e.spaceHash===this.current.spaceHash)this.current.endMs=t;
 }
 observeDamage(e){
  const t=time(e);if(!finite(t)||!finite(e.amount)||e.amount<=0)return;this.lastTime=Math.max(t,this.lastTime);
  const id=[e.transportRecordOrdinal,e.transportPath,e.syncSubIndex,e.sequence].join(':');
  if(this.seen.has(id))return;this.seen.add(id);if(this.seen.size>200000)this.seen.delete(this.seen.values().next().value);
  if(e.sourceActorHash===e.targetActorHash||!this.npcs.has(e.targetActorHash))return;
  const effects=[];const unsupported=new Set();
  for(const[k,b]of this.buffs){if(b.expiresMs<=t){this.buffs.delete(k);continue;}
   if([e.sourceActorHash,e.targetActorHash].includes(b.targetActorHash)){effects.push(b);if(!POLICY.rules[b.buffNo]&&!personalBuffs.hasPersonalRule(b.buffNo))unsupported.add(b.buffNo);}
  }
  const hitInput={...e,effects,targetAttributes:{...this.attrs.get(e.targetActorHash)},targetWeak:this.weak.get(e.targetActorHash)??null};
  const result=simpleHitCredit(hitInput);
  const gapUnknown=this.resynced&&[e.sourceActorHash,e.targetActorHash].some(a=>!this.resynced.has(a));
  const contextIssues=[...[...unsupported].map(n=>'unsupported_effect:'+n),...(gapUnknown?['buff_state_unknown_after_transport_gap']:[])];
  const h={id,transportRecordOrdinal:e.transportRecordOrdinal,timestampMs:t,sourceActorHash:e.sourceActorHash,targetActorHash:e.targetActorHash,amount:e.amount,rawSkillId:e.rawSkillId,rawCalcpointId:e.rawCalcpointId,hitInput,contextIssues,...result,issues:[...result.issues,...contextIssues]};
  if(this.current&&!this.current.endMs){if(this.current.hits.length<100000)this.current.hits.push(h);else this.current.overflow=true;}
  else {this.pending.push(h);this.pending=this.pending.filter(x=>x.timestampMs>=t-1000).slice(-4096);}
  return h;
 }
 observeStatistic(s){
  if(!this.current||!Array.isArray(s.actors))return;
  if(this.current.npcNo&&this.current.npcNo!==s.npcNo)return;
  if(this.current.counters&&s.actors.some(a=>a.damage<(this.current.counters.actors.find(b=>a.idHash===b.idHash)?.damage||0)))return;
  const merged=new Map((this.current.counters?.actors||[]).map(a=>[a.idHash,a]));for(const a of s.actors)merged.set(a.idHash,a);
  this.current.npcNo=s.npcNo;this.current.counters={...s,actors:[...merged.values()]};
  // Ordered per-tick history, kept only for gap-second reconstruction (step 2
  // of the approved method: exact server-delta minus captured-delta per tick).
  if(!this.current.statHistory)this.current.statHistory=[];
  const t=Date.parse(s.observedAt);
  if(finite(t))this.current.statHistory.push({t,transportRecordOrdinal:s.transportRecordOrdinal,actors:new Map(this.current.counters.actors.map(a=>[a.idHash,a.damage])),jump:{effects:[...this.buffs.values()].filter(b=>b.expiresMs>t).map(b=>({...b})),revisions:new Map(this.buffRevisions),attributes:new Map([...this.attrs].map(([k,v])=>[k,structuredClone(v)])),weak:new Map(this.weak)}});
  if(this.current.statHistory.length>20000){this.current.statHistory=this.current.statHistory.slice(-10000);this.current.historyIncomplete=true;}
 }
 snapshot(){
  const c=this.current,meta={schemaVersion:1,source:this.source,status:'unavailable',model:POLICY.id,policySha256,attributionBasis:{mode:'simplified-estimate',label:POLICY.label+'·已采命中+缺口估算',profile:ACTIVE_PROFILE,allocationPolicy:POLICY.allocationPolicy},publishedAt:new Date().toISOString(),resource:'HP',exactAttribution:false};
  if(!POLICY.enabled||!c?.counters||!c.npcNo||this.error||c.overflow)return {...meta,reasons:[this.error||'waiting_for_encounter_and_statistics']};
  const s=c.counters,roster=new Set(s.actors.map(a=>a.idHash));
  const actors=s.actors.map(a=>({id:a.idHash,damage:a.damage,observedDamage:0,externalGain:0,externalGiven:0}));const byId=new Map(actors.map(a=>[a.id,a]));
  // Encounter mechanics receive their own ledger, never a player's GIVEN.
  const mechanics=Object.entries(POLICY.mechanicProviders||{}).map(([id,p])=>({id,name:p.name,damage:0,externalGiven:0,reconstructedGiven:0}));
  const providers=new Map([...byId,...mechanics.map(a=>[a.id,a])]);
  const transfers=new Map(),issues=new Map();let hits=0,uncreditedHits=0,personalBaselineKnownHits=0,observedPersonalBaselineHits=0,deferredHits=0;const blocked=new Set();
  // Restrict credits to the same cumulative snapshot, not later in-flight hits.
  const cutoff=Date.parse(s.observedAt);
  const admitted=[],schoolChoices=new Map();
  for(const h of c.hits){
   if((Number.isInteger(h.transportRecordOrdinal)&&Number.isInteger(s.transportRecordOrdinal)?h.transportRecordOrdinal>s.transportRecordOrdinal:h.timestampMs>cutoff)||!roster.has(h.sourceActorHash)||roster.has(h.targetActorHash))continue;
   // A hit may arrive before the cumulative reply includes it. Admit whole
   // hits in per-attacker order; defer the remainder without clearing the party.
   const actor=byId.get(h.sourceActorHash);
   if(blocked.has(actor.id)||actor.observedDamage+h.amount>actor.damage+0.01){blocked.add(actor.id);deferredHits++;continue;}
   hits++;actor.observedDamage+=h.amount;
   admitted.push(h);
   const school=kungfuChannels.resolveEncounterSchool(h.hitInput||h);
   if(school){const choices=schoolChoices.get(actor.id)||new Map();choices.set(school.liupaiId,school);schoolChoices.set(actor.id,choices);}
  }
  const encounterSchools=new Map();
  for(const [id,choices]of schoolChoices){
   if(choices.size===1)encounterSchools.set(id,[...choices.values()][0]);
   else issues.set('conflicting_encounter_school:'+id,1);
  }
  // Re-evaluate earlier hits when the first concrete school arrives, using
  // their original buff/attribute state. Never use a later snapshot's evidence.
  for(const h of admitted){
   const school=encounterSchools.get(h.sourceActorHash)||null,schoolKey=school?.liupaiId??null;
   if(h.hitInput&&h.schoolKey!==schoolKey){
    const result=simpleHitCredit({...h.hitInput,encounterSchool:school});
    Object.assign(h,result,{schoolKey,issues:[...result.issues,...h.contextIssues]});
   }
   if(h.issues.some(reason=>reason!=='personal_damage_bonus_unobserved'))uncreditedHits++;
   if(h.allocation.personalBaselineKnown)personalBaselineKnownHits++;
   if(h.allocation.observedPersonalBaseline.entries.length)observedPersonalBaselineHits++;
   for(const reason of h.issues)issues.set(reason,(issues.get(reason)||0)+1);
   for(const x of h.credit){
    if(!providers.has(x.providerId)){issues.set('provider_not_in_roster',(issues.get('provider_not_in_roster')||0)+1);continue;}
    providers.get(x.providerId).externalGiven+=x.creditedDamage;byId.get(h.sourceActorHash).externalGain+=x.creditedDamage;
    const key=[x.providerId,x.beneficiaryId,x.ruleId].join(':');const row=transfers.get(key)||{providerId:x.providerId,beneficiaryId:x.beneficiaryId,ruleId:x.ruleId,name:x.name,creditedDamage:0};row.creditedDamage+=x.creditedDamage;transfers.set(key,row);
   }
  }
  if(deferredHits)issues.set('hits_waiting_for_cumulative_confirmation',deferredHits);
  // Reception-clock residual windows, reconciled against later arrivals.
  // Never pour the final encounter shortfall into the earliest seconds.
  const {gapWindows,atOrBefore,reconstructGapJump}=require('./gap-reconstruction.cjs');
  let reconstructedHits=0,reconstructedGain=0;const gapSeconds=[];
  const hist=(c.statHistory||[]).filter(h=>atOrBefore({timestampMs:h.t,transportRecordOrdinal:h.transportRecordOrdinal},{t:cutoff,transportRecordOrdinal:s.transportRecordOrdinal}));
  const hitGroups=new Map(actors.map(a=>[a.id,[]]));
  for(const h of c.hits)if(hitGroups.has(h.sourceActorHash)&&!roster.has(h.targetActorHash)&&atOrBefore(h,{t:cutoff,transportRecordOrdinal:s.transportRecordOrdinal}))hitGroups.get(h.sourceActorHash).push(h);
  const historyUnsafe=c.transportGaps||c.historyIncomplete;
  if(historyUnsafe)issues.set('gap_reconstruction_history_incomplete',1);
  for(const actor of actors){
   const mine=hitGroups.get(actor.id),shortfall=Math.max(0,actor.damage-actor.observedDamage);
   actor.reconstructedDamage=0;actor.reconstructedGain=0;actor.reconstructedGiven=0;
   if(historyUnsafe||shortfall<=0.01)continue;
   for(const window of gapWindows(hist,mine,actor.id)){
    if(window.fromMs===null||window.toMs<window.fromMs){issues.set('gap_amount_outside_statistic_history',1);continue;}
    const take=Math.min(window.missing,shortfall-actor.reconstructedDamage);if(take<=0.01)continue;
    // A target inferred from the same actor's captured notifications is only
    // an estimate. If ambiguous or absent, target-specific rules stay unknown.
    const targets=new Set(mine.filter(h=>h.timestampMs>window.fromMs&&atOrBefore(h,{t:window.toMs,transportRecordOrdinal:window.transportRecordOrdinal})).map(h=>h.targetActorHash));
    const target=targets.size===1?[...targets][0]:null;
    try{
     const r=reconstructGapJump({sourceActorHash:actor.id,targetActorHash:target,missingAmount:take,...window},{encounterSchool:encounterSchools.get(actor.id)||null});
     for(const reason of r.issues)issues.set('gap:'+reason,(issues.get('gap:'+reason)||0)+1);
     if(!target)issues.set('gap_target_unknown',1);
     let gain=0;
     for(const x of r.credit){
      if(!providers.has(x.providerId)){issues.set('gap:provider_not_in_roster',1);continue;}
      gain+=x.creditedDamage;providers.get(x.providerId).externalGiven+=x.creditedDamage;
      const key=['reconstructed',x.providerId,x.beneficiaryId,x.ruleId].join(':');
      const row=transfers.get(key)||{providerId:x.providerId,beneficiaryId:x.beneficiaryId,ruleId:x.ruleId,name:x.name,creditedDamage:0,reconstructed:true};row.creditedDamage+=x.creditedDamage;transfers.set(key,row);
     }
     reconstructedHits++;reconstructedGain+=gain;actor.externalGain+=gain;actor.reconstructedGain+=gain;actor.reconstructedDamage+=take;
     gapSeconds.push({sourceActorHash:actor.id,targetActorHash:target,targetBasis:target?'same-interval-captured-target-estimate':'unknown',fromMs:window.fromMs,toMs:window.toMs,missing:take,gain,...r.reconstruction,issues:r.issues});
    }catch(e){issues.set('gap_reconstruction_error:'+e.message,1);}
   }
  }
  for(const row of transfers.values())if(row.reconstructed)providers.get(row.providerId).reconstructedGiven+=row.creditedDamage;
  for(const actor of actors)actor.unreconstructedDamage=Math.max(0,actor.damage-actor.observedDamage-actor.reconstructedDamage);
  if(reconstructedHits)issues.set('reconstructed_gap_intervals',reconstructedHits);
  const mechanicGiven=mechanics.reduce((s,a)=>s+a.externalGiven,0);
  const totalGiven=actors.reduce((s,a)=>s+a.externalGiven,mechanicGiven),totalTaken=actors.reduce((s,a)=>s+a.externalGain,0);
  const totalDamage=actors.reduce((s,a)=>s+a.damage,0),totalAttributedDamage=actors.reduce((s,a)=>s+a.damage-a.externalGain+a.externalGiven,mechanicGiven);
  const conservation={unit:'damage',totalGiven,totalTaken,givenTakenError:totalGiven-totalTaken,rdpsDamageError:totalAttributedDamage-totalDamage};
  if(Object.values(conservation).some(v=>typeof v==='number'&&!finite(v))||Math.abs(conservation.givenTakenError)>1e-9*Math.max(1,totalGiven,totalTaken)||Math.abs(conservation.rdpsDamageError)>1e-9*Math.max(1,totalDamage))return {...meta,reasons:['estimate_not_conserved']};
  return {...meta,status:'estimated',npcNo:c.npcNo,encounterAnchor:c.startObservedAt,spaceHash:c.spaceHash,throughObservedAt:s.observedAt,actors,mechanics:mechanics.filter(m=>m.externalGiven>0||this.buffHistory.some(b=>POLICY.mechanicProviders[m.id].ruleIds.includes(String(b.buffNo))&&roster.has(b.targetActorHash)&&b.startMs<=cutoff&&b.endMs>=Date.parse(c.startObservedAt))).map(m=>({...m,partial:POLICY.mechanicProviders[m.id].ruleIds.some(id=>issues.has('resource_success_unknown:'+id)||issues.has('gap:resource_success_unknown:'+id))})),transfers:[...transfers.values()],conservation,coverage:{encounterSchools:Object.fromEntries(encounterSchools),kind:'observed-hits-plus-gap-reconstruction',transportGaps:c.transportGaps||0,hits,deferredHits,hitsWithSkippedRules:uncreditedHits,personalBaselineKnownHits,personalBaselineUnknownHits:hits-personalBaselineKnownHits,observedPersonalBaselineHits,personalBuffBaseline:POLICY.personalBuffBaseline,reconstructedGapSeconds:reconstructedHits,reconstructedGain,gapSeconds,timingBasis:'statistic-jump-buff-snapshot-estimate',reconciliation:'cumulative-residual; late notifications retract most recent unmatched intervals',fullAttribution:false},reasons:[...issues.keys()],limitations:['首版简化倍率，不代表真实角色属性或精确游戏公式。','已采命中与缺口估算分开记账；缺口估算不增加命中次数、技能明细或原始伤害。','减防使用防御比值近似；幻鸣、惧刃减抗倍率按授权应用全部气血伤害。惧刃使用属性穿透版本基准30；按已采技能所属流派（或明确观测的当前武学）选择对应实测抗性；该通道缺测时不计入。流派未知时保留五系已观测最小增幅回退；缺口沿用本场固定流派，整场流派未知时仍用此回退，不猜伤害属性构成，整条气血近似仍可能高估。惧刃8%及易伤10%的指定武学按用户口径沿用整场固定具体流派；已知非普通伤害排除，缺少伤害类型的气血部分按普通伤害简化估算并标记。惊神仍要求确切持续伤害或高额流血判定点，不用固定流派代替这些条件。','霖、气竭5%与八方易伤同区加算；区内按增量比例、区间按对数权重分摊。','按已观察 buff 的等级、层数、有效区间和判定表条件纳入个人增伤及攻击区分母；个人基线覆盖仍不完整，未观察项不补造。易伤条件额外10%需武学与伤害适用条件均已知。','未支持的条件效果单独列出；自身增益不外转。','缺口按服务器累计与已收逐击的差额定位到接收区间（通常约1秒），后到逐击会撤回最近未匹配差额；这不是精确的服务器命中时刻。缺口使用统计跳变到达时冻结的增益及气竭状态；区间内buff变化单独标记估算，不按时间均摊；指定武学条件沿用本场固定具体流派，持续伤害等其他技能条件未知时不启用。目标仅在同期该玩家已采命中指向唯一目标时近似使用；否则跳过目标相关规则。首个统计前、传输断流或历史不全的缺口不补算。0估算增益不代表确认无增益。']};
 }
}

module.exports={SimpleRdpsStream};
