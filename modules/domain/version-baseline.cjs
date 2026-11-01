'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const DEFAULT_PATH=path.resolve(__dirname,'../../config/attribution-baselines.json');
function loadBaselineProfile(file=DEFAULT_PATH){
 const bytes=fs.readFileSync(file),config=require('../configuration/contract.cjs').validate('config/attribution-baselines.json',JSON.parse(bytes));
 if(config.schemaVersion!==1||typeof config.activeProfileId!=='string'||!Object.hasOwn(config.profiles||{},config.activeProfileId))throw Error('invalid_baseline_config');
 const p=config.profiles[config.activeProfileId];
 if(p.mode!=='version-baseline-estimate'||p.semantics!=='effective-penetration-baseline'||!Number.isInteger(p.revision)||p.revision<1||typeof p.source!=='string'||!p.source)throw Error('invalid_baseline_profile');
 for(const k of ['physicalPenetration','attributePenetration'])if(typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<0)throw Error('invalid_baseline_'+k);
 return Object.freeze({...p,id:config.activeProfileId,configSha256:crypto.createHash('sha256').update(bytes).digest('hex')});
}
// Load once per process; changes are applied on restart. Reports retain this
// complete immutable snapshot so later versions cannot relabel older results.
const ACTIVE_PROFILE=loadBaselineProfile();
function getAttributionBasis(){return {mode:ACTIVE_PROFILE.mode,label:'版本基准估算',profile:ACTIVE_PROFILE,playerAttributesObserved:false};}
function baselinePenetration(component){
 if(component==='physical')return ACTIVE_PROFILE.physicalPenetration;
 if(component==='attribute')return ACTIVE_PROFILE.attributePenetration;
 throw Error('unsupported_damage_component');
}
module.exports={loadBaselineProfile,ACTIVE_PROFILE,getAttributionBasis,baselinePenetration};
