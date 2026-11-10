'use strict';
const {resolveEncounterDisplayIdentity}=require('./encounter-display-name.cjs');
const {identityDifficulty,difficultyName,battleDifficulty}=require('./encounter-difficulty.cjs');
const {normalizeGameData}=require('./game-data-version.cjs');
// Cumulative snapshots only. Never manufacture hit counts, buff credit or uptime.
class CombatModel {
  constructor() { this.session=null; this.current=null; this.history=[]; this.n=0; this.latest=null; this.lastZero=null; }
  ingest(s) {
    if(s.schemaVersion!==1 || !s.source?.sessionId || !Array.isArray(s.actors)) throw Error('Invalid snapshot schema');
    if(s.observedAt===null && !s.actors.length){
      if(this.session!==s.source.sessionId){this.archive('session-change');this.session=s.source.sessionId;this.lastZero=null;}
      this.latest=s;return this.view();
    }
    if(!Number.isFinite(Date.parse(s.observedAt))) throw Error('Invalid observedAt');
    const ids=new Set();
    for(const a of s.actors){
      if(!/^[a-f0-9]{8,64}$/i.test(a.idHash)||ids.has(a.idHash))throw Error('Invalid or duplicate actor');
      ids.add(a.idHash);
      for(const k of ['damage','heal','absorbDmg'])if(!Number.isFinite(a[k])||a[k]<0)throw Error('Invalid cumulative counter');
    }
    if(!Number.isFinite(s.timeCostSeconds)||s.timeCostSeconds<0)throw Error('Invalid duration');
    this.latest=s;
    if(s.health?.session==='invalid'||s.health?.gap||s.health?.status==='invalid')return this.view();
    if(this.session!==s.source.sessionId){this.archive('session-change');this.session=s.source.sessionId;this.lastZero=null;}
    const total=s.actors.reduce((v,a)=>v+a.damage,0), c=this.current;
    if(c && (s.npcNo!==c.npcNo || s.actors.some(a=>c.actors[a.idHash] && a.damage<c.actors[a.idHash].damage))) this.archive('counter-or-target-reset');
    if(!total || !s.npcNo){this.lastZero=s.npcNo?{npcNo:s.npcNo,at:s.observedAt}:null;return this.view();}
    if(!this.current){
      const zero=this.lastZero,delta=zero?Date.parse(s.observedAt)-Date.parse(zero.at):Infinity;
      // An observed zero-to-positive transition brackets the first recorded damage.
      // It is a local estimate, never an authoritative encounter start timestamp.
      const bracket=zero?.npcNo===s.npcNo && delta>0 && delta<=2500?{from:zero.at,to:s.observedAt}:null;
      this.current={id:`${this.session}:${++this.n}`,npcNo:s.npcNo,actors:{},firstObservedAt:s.observedAt,mode:s.source.mode,...(s.source.gameData!==undefined?{displayGameData:normalizeGameData(s.source.gameData)}:{}),authoritativeSeconds:null,finalized:false,
        estimatedStartAt:bracket?new Date((Date.parse(bracket.from)+Date.parse(bracket.to))/2).toISOString():null,startBracket:bracket};
      this.lastZero=null;
    }
    const fight=this.current;
    // A later increase after an end snapshot is not silently assigned the old time.
    const anyGrowth=s.actors.some(a=>a.damage>(fight.actors[a.idHash]?.damage??0));
    if(anyGrowth && fight.finalized){fight.authoritativeSeconds=null;fight.finalized=false;}
    // Keep absent actors but label roster coverage as unknown: absence is not zero damage.
    for(const a of s.actors)fight.actors[a.idHash]={...a};
    fight.lastObservedAt=s.observedAt;
    this.applyEncounterClock(s.encounterClock);
    if(s.timeCostSeconds>0){fight.authoritativeSeconds=s.timeCostSeconds;fight.finalized=true;fight.endObservedAt=s.observedAt;}
    return this.view();
  }
  archive(reason){if(this.current){this.history.push({...this.current,reason});this.history=this.history.slice(-50);this.current=null;}}
  applyEncounterClock(clock){
    const c=this.current;if(!c||!clock||clock.source?.sessionId!==this.session||clock.npcNo!==c.npcNo)return;
    const start=Date.parse(clock.startObservedAt),first=Date.parse(c.firstObservedAt),end=clock.endObservedAt?Date.parse(clock.endObservedAt):null;
    if(!Number.isFinite(start)||first<start-1000||(end!==null&&(!Number.isFinite(end)||end<start||first>end+2500)))return;
    c.encounterClock={...clock};
  }
  applyResourceStatistic(s){
    // A resource counter is not inferred from Behit.hurt, target bar loss, or HP.
    // The producer must supply a separately validated outgoing-damage counter.
    if(s?.schemaVersion!==1||s.resourceId!==2||s.kind!=='damage'||s.direction!=='outgoing'||
      s.targetScope!=='encounter-hostile'||s.counterMode!=='cumulative'||s.evidence?.status!=='validated'||
      typeof s.evidence.ruleId!=='string'||!s.evidence.ruleId||!Array.isArray(s.actors)||
      !Number.isFinite(Date.parse(s.observedAt)))return false;
    const c=[this.current,...this.history.slice().reverse()].filter(Boolean).find(c=>
      c.id.startsWith(s.source?.sessionId+':')&&c.npcNo===s.npcNo&&
      s.encounterAnchor===(c.encounterClock?.startObservedAt||c.firstObservedAt));
    if(!c||Date.parse(s.observedAt)<Date.parse(c.encounterClock?.startObservedAt||c.firstObservedAt)||
      (c.encounterClock?.endObservedAt&&Date.parse(s.observedAt)>Date.parse(c.encounterClock.endObservedAt)+2500))return false;
    if(c.qiCounter&&Date.parse(s.observedAt)<Date.parse(c.qiCounter.observedAt))return false;
    const ids=new Set(),values={};
    for(const a of s.actors){
      if(!/^[a-f0-9]{8,64}$/i.test(a.idHash)||ids.has(a.idHash)||!c.actors[a.idHash]||
        !Number.isFinite(a.damage)||a.damage<0||a.damage>Number.MAX_SAFE_INTEGER||
        (c.qiCounter?.values[a.idHash]!==undefined&&a.damage<c.qiCounter.values[a.idHash]))return false;
      ids.add(a.idHash);values[a.idHash]=a.damage;
    }
    c.qiCounter={observedAt:s.observedAt,values:{...(c.qiCounter?.values||{}),...values},
      coverage:s.coverage==='complete-encounter'?'complete-encounter':'observed-actors-only',evidence:s.evidence};
    return true;
  }
  view(now=Date.now()){
    const c=this.current||this.history.at(-1),s=this.latest;
    if(!c)return {snapshot:s,encounter:null,historyCount:this.history.length};
    let seconds=c.authoritativeSeconds,basis=seconds?'server-end-summary':'unavailable';
    const clock=c.encounterClock;
    if(!seconds && (clock?.startObservedAt||c.estimatedStartAt)){
      let end=Date.parse(c.lastObservedAt);
      const live=c.mode==='live' && this.current && s?.health?.session==='valid' && !s.health?.gap && !s.health?.stale && s.health?.status!=='invalid';
      // Tick between fresh updates only. Freeze on stale input instead of silently
      // advancing the denominator for a disconnected or already-ended encounter.
      if(live && now>=end && now-end<=3500)end=now;
      if(c.mode==='live'){
        end=Math.max(end,c.estimatedClockEnd||end);
        c.estimatedClockEnd=end;
      }
      if(clock?.endObservedAt)end=Date.parse(clock.endObservedAt);
      seconds=Math.max(0,(end-Date.parse(clock?.startObservedAt||c.estimatedStartAt))/1000)||null;
      basis=clock?.startObservedAt?'server-battle-state-received':'local-statistic-start-estimate';
    }
    const identity=clock?.identityContext?resolveEncounterDisplayIdentity(clock.identityContext,c.npcNo,c.displayGameData):null;
    const qiValues=c.qiCounter?.values||{},qiRows=Object.values(qiValues),qiDamage=qiRows.length?qiRows.reduce((v,a)=>v+a,0):null;
    const qi={status:qiDamage===null?'unavailable':'validated-counter',resourceId:2,damage:qiDamage,
      dps:qiDamage!==null&&seconds?qiDamage/seconds:null,coverage:c.qiCounter?.coverage||'unverified',
      reason:qiDamage===null?'尚无已验证的逐来源真气输出数据；不使用 hurt 或目标真气条变化代替。':null};
    return {snapshot:s,historyCount:this.history.length,encounter:{...c,retained:!this.current,identity,
      durationBasis:basis,durationSeconds:seconds,clockEnded:!!clock?.endObservedAt,
      coverage:'observed-actors-only',perHit:'unverified',attribution:'unavailable',qi,
      actors:Object.values(c.actors).map(a=>({...a,dps:seconds?a.damage/seconds:null,qiDamage:qiValues[a.idHash]??null,
        qiDps:qiValues[a.idHash]!==undefined&&seconds?qiValues[a.idHash]/seconds:null,rdps:null,dpsGiven:null,dpsTaken:null,adps:null}))}};
  }
}
function toKagerou(view,labels={}){
  const c=view.encounter;if(!c)return null;
  const total=c.actors.reduce((v,a)=>v+a.damage,0),time=c.durationSeconds;
  const shownDamage=a=>a.damage;
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const Combatant=Object.fromEntries(c.actors.map(a=>[a.idHash,{name:escape(labels[a.idHash]||a.name||`玩家 ${a.idHash.slice(0,6)}`),Job:'',yyslsSchoolColor:a.schoolDisplay?.color||'#9aa3ad',yyslsSchoolName:a.schoolDisplay?.name||null,damage:Math.floor(shownDamage(a)),yyslsRawDamage:a.damage,yyslsMechanicDamage:a.mechanicDamage||0,
    encdps:time?a.damage/time:a.dps??'---','damage%':total?String(shownDamage(a)/total*100):'---',healed:a.heal,
    yyslsAbsorb:a.absorbDmg,yyslsQiDamage:a.qiDamage??'—',yyslsQiDps:a.qiDps??'—',
    yyslsRdps:['available','estimated'].includes(c.attributionValidation?.status)&&Number.isFinite(a.rdps)?a.rdps:'—',
    yyslsGiven:['available','estimated'].includes(c.attributionValidation?.status)&&Number.isFinite(a.dpsGiven)?a.dpsGiven:'—',
    yyslsTaken:['available','estimated'].includes(c.attributionValidation?.status)&&Number.isFinite(a.dpsTaken)?a.dpsTaken:'—',yyslsCoverage:c.attributionValidation?.status==='estimated'?'简化估算':'已观测'}]));
  for(const m of c.mechanics||[])if(c.attributionValidation?.status==='estimated')Combatant[m.id]={name:escape(m.name),Job:'',yyslsMechanic:true,yyslsSchoolColor:'#bd5a76',damage:0,yyslsRawDamage:0,encdps:0,'damage%':'0',yyslsRdps:m.partial&&m.externalGiven===0?'—':m.rdps,yyslsGiven:m.rdps,yyslsTaken:'—',yyslsCoverage:m.partial?'部分状态未知':'机制增伤估算'};
  return {isActive:c.finalized||c.clockEnded?'false':'true',Encounter:{yyslsEncounterId:c.id,damage:total,
    title:difficultyName(c.identity?.bossName||`目标 ${c.npcNo}（名称待确认）`,c.difficulty||battleDifficulty({source:view.snapshot?.source,clock:c.encounterClock,statistics:{observedAt:c.lastObservedAt},attribution:view.snapshot?.attributionEstimate},c.identity)),CurrentZoneName:c.identity?.dungeonName||'燕云十六声 · 已观测角色',
    duration:time?`${Math.floor(time/60).toString().padStart(2,'0')}:${(time%60).toFixed(2).padStart(5,'0')}`:'时长待结算',
    DURATION:time??0,encdps:time?total/time:'---',enchps:'---',yyslsQiDamage:c.qi?.damage??'—',
    yyslsQiDps:c.qi?.dps??'—',yyslsQiStatus:c.qi?.status||'unavailable',yyslsQiReason:c.qi?.reason||''},Combatant};
}
module.exports={CombatModel,toKagerou};
