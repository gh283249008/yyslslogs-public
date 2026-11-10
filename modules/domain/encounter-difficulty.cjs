'use strict';
// Presentation only. Neither difficulty nor a display name establishes targetBoss.
const rules=require('../../config/rdps-simple-v1.json').rules;
const challengeBuffIds=new Set(Object.entries(rules).filter(([,r])=>r.family==='xueji').map(([id])=>Number(id)));
// User display rule (2026-11-11): observed blood sacrifice means challenge;
// otherwise label normal, including incomplete/legacy records. No damage inference.
const normal=()=>({mode:'normal',basis:'user-default-without-blood-sacrifice'});
function observedDifficulty(intervals,{startMs,endMs,players=[]}={}){
 if(!Number.isFinite(startMs)||!Number.isFinite(endMs)||endMs<startMs)return normal();
 const roster=new Set(players);
 const found=(intervals||[]).find(iv=>challengeBuffIds.has(Number(iv.buffNo))&&roster.has(iv.targetActorHash)&&Number.isFinite(iv.startMs)&&iv.startMs<=endMs&&iv.endMs>startMs);
 return found?{mode:'challenge',basis:'observed-blood-sacrifice',buffNo:Number(found.buffNo)}:normal();
}
function identityDifficulty(identity){
 if(['normal','challenge'].includes(identity?.difficulty?.mode))return identity.difficulty;
 if(/（挑战模式）$/.test(identity?.bossName||identity?.name||''))return {mode:'challenge',basis:'confirmed-identity'};
 return normal();
}
function battleDifficulty(battle,identity){
 const a=battle?.attribution,c=battle?.clock,start=Date.parse(c?.startObservedAt),cutoff=Date.parse(a?.throughObservedAt),statisticsCutoff=Date.parse(battle?.statistics?.observedAt);
 if(a?.source?.sessionId&&a.source.sessionId===battle?.source?.sessionId&&a.encounterAnchor===c?.startObservedAt&&a.npcNo===c?.npcNo&&Number.isFinite(start)&&Number.isFinite(cutoff)&&cutoff>=start&&(!Number.isFinite(statisticsCutoff)||cutoff<=statisticsCutoff)){
  if(a.difficulty?.mode==='challenge'&&a.difficulty.basis==='observed-blood-sacrifice'&&challengeBuffIds.has(Number(a.difficulty.buffNo)))return a.difficulty;
  // Old headers did not retain a separate difficulty field. A positive blood-sacrifice
  // transfer proves activation; a default/zero mechanic row does not.
  if((a.transfers||[]).some(t=>challengeBuffIds.has(Number(t.ruleId))&&t.providerId==='mechanic:xueji'&&Number.isFinite(t.creditedDamage)&&t.creditedDamage>0))return {mode:'challenge',basis:'observed-blood-sacrifice-transfer'};
 }
 return identityDifficulty(identity);
}
function difficultyName(name,difficulty){
 name=name||'未命名首领';
 return name.replace(/（(?:普通模式|挑战模式|普通竞速)）$/,'')+(difficulty?.mode==='challenge'?'（挑战模式）':'（普通模式）');
}
module.exports={observedDifficulty,identityDifficulty,battleDifficulty,difficultyName};
