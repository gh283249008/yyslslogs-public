'use strict';
// Renderer contract: the table receives toKagerou separately. Full attribution
// ledgers and capture snapshots stay in the main process and retained files.
function overlayState(view){
 if(!view)return {};
 const s=view.snapshot,c=view.encounter,a=view.attribution||c?.attributionValidation;
 return {
  inputError:view.inputError,resourceError:view.resourceError,transportStale:view.transportStale,
  snapshot:s?{source:{mode:s.source?.mode},health:s.health,coverage:{knownAcquisitionGaps:s.coverage?.knownAcquisitionGaps},actors:(s.actors||[]).map(()=>null)}:null,
  encounter:c?{actors:(c.actors||[]).map(()=>null),qi:c.qi?{status:c.qi.status,reason:c.qi.reason}:null,durationBasis:c.durationBasis,finalized:c.finalized,clockEnded:c.clockEnded,retained:c.retained}:null,
  attribution:a?{status:a.status,limitations:a.limitations,reasons:a.reasons,updating:a.updating,retained:a.retained}:null,
 };
}
function buffStateKey(state){return JSON.stringify({...state,buffs:state.buffs?.map(b=>{if(!b)return b;const {remainingSeconds,...fixed}=b;return fixed;})});}
module.exports={overlayState,buffStateKey};
