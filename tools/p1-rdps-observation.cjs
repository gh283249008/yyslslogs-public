'use strict';
const registry=require('../evidence/p1/rdps-rules/runtime-registry.json');
const {getRdpsValidationStatus}=require('./p1-rdps-runtime.cjs');
// This adapter connects capture to validation diagnostics. It does not pretend
// packet reception and public buff state are a validated counterfactual hit.
class RdpsObservation {
 constructor(source){this.source=source;this.buffEvents=0;this.damageNotifications=0;this.selected=new Map();this.sourceChanges=0;}
 observeBuff(e){this.buffEvents++;if(e.sourceChanged)this.sourceChanges++;const rule=registry.rules[String(e.buffNo)];if(!rule?.selectedForAttribution)return;const row=this.selected.get(rule.id)||{ruleId:rule.id,name:rule.name,observations:0,withProvider:0,crossActor:0};row.observations++;if(e.sourceActorHash)row.withProvider++;if(e.sourceEqualsTarget===false)row.crossActor++;this.selected.set(rule.id,row);}
 observeDamage(){this.damageNotifications++;}
 snapshot(health){return {schemaVersion:1,source:this.source,publishedAt:new Date().toISOString(),...getRdpsValidationStatus(),health,observations:{buffEvents:this.buffEvents,damageNotifications:this.damageNotifications,sourceChanges:this.sourceChanges,selectedEffects:[...this.selected.values()]},limits:['Counts are session observations, not credited hits, casts or buff uptime.','Public buff data and packet arrival times do not establish private state, effective stack ownership or hit execution time.','No counterfactual pools are fabricated; normalized attribution-input.json remains absent until evidence is validated.']};}
}
module.exports={RdpsObservation};
