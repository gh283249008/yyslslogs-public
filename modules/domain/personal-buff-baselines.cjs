'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const bytes=fs.readFileSync(path.join(__dirname,'../../config/personal-buff-baselines.json'));
const DATA=JSON.parse(bytes),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
const hasPersonalRule=buffNo=>Object.hasOwn(DATA.rules,buffNo);
function observedPersonalBaseline({effects,sourceActorHash,rawCalcpointId}){
 const totals={damage:0,attack:0},entries=[],issues=[],seen=new Set();
 for(const e of effects){
  const rule=DATA.rules[e.buffNo];
  if(!rule||e.targetActorHash!==sourceActorHash)continue;
  const key=String(e.buffNo)+':'+(e.buffInstanceHash??'');
  if(seen.has(key))continue;seen.add(key);
  if(!rule.levels.includes(e.level)){issues.push('personal_buff_level_unknown:'+e.buffNo);continue;}
  const stacks=rule.maxStacks===1?1:e.charge_level;
  if(!Number.isInteger(stacks)||stacks<1||stacks>rule.maxStacks){issues.push('personal_buff_stacks_unknown:'+e.buffNo);continue;}
  const c=rule.condition,cp=DATA.calcpoints[rawCalcpointId];
  if(c.damageType||c.calcpointClassAny||c.calcpointTagsAny||c.calcpointType){
   if(!cp){issues.push('personal_buff_hit_condition_unknown:'+e.buffNo);continue;}
   const checks=[
    [c.damageType,cp[0],v=>v===c.damageType],
    [c.calcpointClassAny,cp[1],v=>c.calcpointClassAny.includes(v)],
    [c.calcpointType,cp[2],v=>v===c.calcpointType],
    [c.calcpointTagsAny,cp[3],v=>Array.isArray(v)&&v.some(t=>c.calcpointTagsAny.includes(t))]
   ].filter(([required])=>required);
   if(checks.some(([,v,test])=>v!==null&&!test(v)))continue;
   if(checks.some(([,v])=>v===null)){issues.push('personal_buff_hit_condition_unknown:'+e.buffNo);continue;}
  }
  const rate=rule.rate*stacks;totals[rule.pool]+=rate;
  entries.push({buffNo:e.buffNo,name:rule.name,pool:rule.pool,rate,stacks,level:e.level,sourceActorHash:e.sourceActorHash??null,conditionBasis:c.damageType?'decoded-calcpoint-table': 'observed-buff-table'});
 }
 return {...totals,entries,issues,complete:false};
}
// cond_attack=[1,0,0]: normal damage type only; the zero class/type
// predicates are wildcards. Missing table rows remain unknown.
function normalDamageEligible(rawCalcpointId){
 const value=DATA.calcpoints[rawCalcpointId]?.[0];
 return typeof value==='number'?value===1:null;
}
function calcpointType(rawCalcpointId){return DATA.calcpoints[rawCalcpointId]?.[2]??null;}
module.exports={hasPersonalRule,observedPersonalBaseline,normalDamageEligible,calcpointType,sha256};
