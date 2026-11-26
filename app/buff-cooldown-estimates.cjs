'use strict';
// UI-only estimates. Never synthesize captured buff events or attribution facts.
class BuffCooldownEstimates {
  constructor(rules=[]){this.rules=rules;this.clear();}
  clear(){this.states=new Map();this.seen=new Map();}
  suppress(id,actor,until){
    const key=actor+':'+id,row=this.states.get(key);
    // A real timed cooldown supersedes an estimate from the same activation,
    // including when the real cooldown expires earlier than the estimate.
    if(row&&row.at<=until)this.states.delete(key);
  }
  invalidate(event){
    for(const [key,row] of this.states)if(!event.targetActorHash||row.actor===event.targetActorHash)this.states.delete(key);
    for(const [key,row] of this.seen)if(!event.targetActorHash||row.actor===event.targetActorHash)this.seen.delete(key);
  }
  consume(event,actor,definitions){
    if(!actor||event.targetActorHash!==actor||!['ac_buffs','oc_buffs'].includes(event.bag))return;
    const at=Date.parse(event.observedAt)/1000;if(!Number.isFinite(at))return;
    for(const rule of this.rules){
      const definition=definitions[rule.id];
      if(!definition||(definition.monitors||[definition]).every(row=>row.target==='boss'))continue;
      const key=actor+':'+rule.id;
      if(event.kind==='remove_candidate'&&[rule.id,...rule.parentBuffIds].includes(event.buffNo)){this.states.delete(key);continue;}
      if(!rule.triggerBuffIds.includes(event.buffNo)||event.initial||!['apply_candidate','update'].includes(event.kind))continue;
      if(event.kind==='update'&&event.changes?.start_ts==null)continue;
      if(!Number.isFinite(event.rawStartTimestamp)||!Number.isFinite(event.durationSeconds)||event.durationSeconds<=0)continue;
      if(event.sourceActorHash&&event.sourceActorHash!==actor)continue;
      const signature=String(event.rawStartTimestamp);
      const previous=this.seen.get(key);
      // The same application may be reported through both own/public bags.
      if(previous&&(previous.signature===signature||at<=previous.at))continue;
      this.seen.set(key,{actor,signature,at});
      this.states.set(key,{actor,rule,at,expires:at+rule.cooldownSeconds,triggerBuffId:event.buffNo});
    }
  }
  project(actor,definitions,now){
    const result=[];
    for(const [key,row] of this.states){
      if(row.expires<=now){this.states.delete(key);continue;}
      if(row.actor!==actor||row.at>now)continue;
      const definition=definitions[row.rule.id];if(!definition)continue;
      for(const spec of definition.monitors||[definition]){
        if(spec.target==='boss')continue;
        result.push({key:spec.monitorKey||spec.slot,style:spec.slot,order:spec.order,target:'self',targetName:null,id:String(row.rule.id),name:spec.name,variant:row.rule.label,durationSeconds:row.rule.cooldownSeconds,remainingSeconds:row.expires-now,expiresAt:new Date(row.expires*1000).toISOString(),observedAt:new Date(row.at*1000).toISOString(),estimated:true,timingBasis:'observed-effect-trigger',triggerBuffId:row.triggerBuffId,kind:'cooldown-estimate',uncertain:true,stacks:null,phase:null});
      }
    }
    return result;
  }
}
module.exports={BuffCooldownEstimates};
