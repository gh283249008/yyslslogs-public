'use strict';
// Allocation only: derived damage is already part of server totals. Callers must
// replace the corresponding residual credit, never add this amount to raw DPS.
function recordedComponentCredit({origin,ratio,sourceActorHash,providerActorHash=null,recordedRate=0,ruleId='221004'}){
 const finite=Number.isFinite;
 if(!origin||!finite(origin.amount)||origin.amount<0||!finite(ratio)||ratio<=0||!sourceActorHash||!finite(recordedRate)||recordedRate<0||(recordedRate>0&&!providerActorHash))throw Error('invalid_recorded_component');
 if(!finite(origin.gain)||origin.gain<0||origin.gain>origin.amount||!Array.isArray(origin.credit)||!Array.isArray(origin.allocation?.pools))throw Error('unresolved_origin_allocation');
 const close=(a,b)=>Math.abs(a-b)<=1e-8*Math.max(1,origin.amount);
 let rawL=0,sum=0;
 for(const p of origin.allocation.pools){if(!finite(p.effectiveMultiplier)||p.effectiveMultiplier<1)throw Error('invalid_origin_multiplier');rawL+=Math.log(p.effectiveMultiplier);}
 for(const c of origin.credit){if(!finite(c.creditedDamage)||c.creditedDamage<0||!c.providerId||c.providerId===sourceActorHash||c.beneficiaryId!==sourceActorHash)throw Error('invalid_origin_credit');sum+=c.creditedDamage;}
 const baseOriginGain=finite(origin.allocation.unweightedGain)?origin.allocation.unweightedGain:origin.gain;
 if(!close(sum,origin.gain)||!close(origin.amount*(-Math.expm1(-rawL)),baseOriginGain))throw Error('inconsistent_origin_allocation');
 const B=providerActorHash!==sourceActorHash?Math.log1p(recordedRate):0,total=rawL+B;
 const amount=origin.amount*ratio*(1+recordedRate),unweightedGain=amount*(-Math.expm1(-total));
 // Preserve the original recorded-damage split. Existing origin providers
 // inherit their post-allocation weights, including a user-specified weight
 // above one; the recorded provider's own credit stays at its original value.
 const originScale=total&&baseOriginGain?unweightedGain*rawL/total/baseOriginGain:0;
 const attack=origin.allocation.pools.find(p=>p.id==='attack');
 const channelAttack=attack?.components&&Object.values(attack.components).every(c=>finite(c.logGain)&&finite(c.otherLogGain)&&finite(c.share));
 const credit=origin.credit.map(c=>{
  let creditedDamage=c.creditedDamage*originScale;
  if(c.poolId==='attack'&&channelAttack){
   if(!finite(c.weight)||c.weight<0||c.weight>1)throw Error('invalid_origin_attack_weight');
   creditedDamage=Object.values(attack.components).reduce((n,ch)=>{
    const joint=ch.otherLogGain+ch.logGain+B;
    return n+(joint?amount*(-Math.expm1(-joint))*ch.logGain/joint*ch.share*c.weight:0);
   },0);
  }
  return {...c,stage:'origin',creditedDamage};
 });
 if(B>0)credit.push({providerId:providerActorHash,beneficiaryId:sourceActorHash,ruleId:String(ruleId),stage:'recorded',creditedDamage:unweightedGain*B/total});
 const gain=credit.reduce((n,c)=>n+c.creditedDamage,0);
 const given=credit.reduce((n,c)=>n+c.creditedDamage,0);
 if(!finite(amount)||!finite(gain)||gain>amount+1e-8*Math.max(1,amount)||Math.abs(given-gain)>1e-8*Math.max(1,amount))throw Error('recorded_allocation_not_conserved');
 return {status:'estimated',includeInDps:false,amount,gain,credit,conservationError:given-gain,originLogGain:rawL,recordedLogGain:B,unweightedGain,issues:[...(origin.issues||[])]};
}
module.exports={recordedComponentCredit};
