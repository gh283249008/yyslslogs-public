'use strict';
const fs=require('fs'),path=require('path');
const {POLICY,policySha256}=require('../tools/p1-simple-rdps.cjs');
const {ACTIVE_PROFILE}=require('../tools/p1-version-baseline.cjs');
function applySimpleEstimate(view,dir){
 const c=view.encounter,s=view.snapshot,file=path.join(dir,'attribution-estimate.json');
 if(!c||!s||(!s.attributionEstimate&&!fs.existsSync(file)))return null;
 if(!s.attributionEstimate&&fs.statSync(file).size>4*1024*1024)throw Error('estimate_file_too_large');
 const e=s.attributionEstimate||JSON.parse(fs.readFileSync(file,'utf8'));
 if(e.status!=='estimated')return null;
 if(e.model!==POLICY.id||e.policySha256!==policySha256||e.attributionBasis?.profile?.configSha256!==ACTIVE_PROFILE.configSha256)throw Error('estimate_version_mismatch');
 if(e.source?.sessionId!==s.source?.sessionId||e.npcNo!==c.npcNo||e.encounterAnchor!==c.encounterClock?.startObservedAt)throw Error('estimate_encounter_mismatch');
 if(e.resource!=='HP'||!Number.isFinite(c.durationSeconds)||c.durationSeconds<=0||e.throughObservedAt!==c.lastObservedAt)throw Error('estimate_snapshot_mismatch');
 const retained=s.source.mode==='live'&&(view.transportStale||s.health?.gap||s.health?.session!=='valid');
 if(!Array.isArray(e.actors)||e.actors.length!==c.actors.length)throw Error('estimate_roster_mismatch');
 const rows=new Map(e.actors.map(a=>[a.id,a]));if(rows.size!==e.actors.length)throw Error('estimate_duplicate_actor');
 let given=0,taken=0;
 const mechanicIds=new Set();
 const mechanics=(e.mechanics||[]).map(m=>{
  const spec=POLICY.mechanicProviders?.[m.id];
  if(!spec||mechanicIds.has(m.id)||!Number.isFinite(m.externalGiven)||m.externalGiven<0)throw Error('estimate_mechanic_invalid');
  mechanicIds.add(m.id);given+=m.externalGiven;
  return {...m,name:spec.name,rdps:m.externalGiven/c.durationSeconds};
 });
 const mechanicTaken=new Map(),mechanicTransfers=new Map();
 for(const t of e.transfers||[])if(mechanicIds.has(t.providerId)){
  if(!rows.has(t.beneficiaryId)||!Number.isFinite(t.creditedDamage)||t.creditedDamage<0)throw Error('estimate_mechanic_transfer_invalid');
  mechanicTaken.set(t.beneficiaryId,(mechanicTaken.get(t.beneficiaryId)||0)+t.creditedDamage);
  mechanicTransfers.set(t.providerId,(mechanicTransfers.get(t.providerId)||0)+t.creditedDamage);
 }
 for(const m of mechanics)if(Math.abs((mechanicTransfers.get(m.id)||0)-m.externalGiven)>1e-7*Math.max(1,m.externalGiven))throw Error('estimate_mechanic_transfers_mismatch');
 const actors=c.actors.map(a=>{
  const r=rows.get(a.idHash);if(!r||['damage','externalGain','externalGiven','observedDamage'].some(k=>!Number.isFinite(r[k])||r[k]<0)||Math.abs(r.damage-a.damage)>.01||r.externalGain>a.damage+.01)throw Error('estimate_counter_mismatch');
  given+=r.externalGiven;taken+=r.externalGain;
  const mechanicDamage=mechanicTaken.get(a.idHash)||0;
  if(mechanicDamage>r.externalGain+0.01)throw Error('estimate_mechanic_exceeds_gain');
  return {...a,mechanicDamage,rdps:(a.damage-r.externalGain+r.externalGiven)/c.durationSeconds,dpsGiven:r.externalGiven/c.durationSeconds,dpsTaken:r.externalGain/c.durationSeconds};
 });
 if(Math.abs(given-taken)>1e-7*Math.max(1,given,taken))throw Error('estimate_transfer_not_conserved');
 return {result:{...e,retained:!!retained,totalGiven:given/c.durationSeconds,totalTaken:taken/c.durationSeconds},encounter:{...c,attribution:'estimated',actors,mechanics}};
}
module.exports={applySimpleEstimate};
