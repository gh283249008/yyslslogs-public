'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
function recordedBuild(directory,source){
 try{
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const profile=manifest.propertySchemaProfile;
  const hd=source?.gameData?.manifestSha256;
  if(!source?.sessionId||manifest.sessionId!==source.sessionId||!profile||profile.legacyReplayFallback!==false)return;
  if(typeof hd!=='string'||!/^[a-f0-9]{64}$/.test(hd)||manifest.gameData?.manifestSha256!==hd||profile.gameDataSha256!==hd)return;
  if(typeof profile.clientBuildSha256==='string'&&/^[a-f0-9]{64}$/.test(profile.clientBuildSha256))return profile.clientBuildSha256;
 }catch{
  // Missing or unreadable optional metadata must not interrupt battle recording.
  return undefined;
 }
}
class BattleArchive{
 constructor(sessionDir,source){this.sessionDir=sessionDir;this.source=source;this.dir=path.join(sessionDir,'battles');this.current=null;this.previous=null;fs.mkdirSync(this.dir,{recursive:true});}
 update(snapshot,estimate,identities=[]){
  const clock=snapshot.encounterClock;if(!clock?.startObservedAt||!snapshot.source?.sessionId)return;
  if(!snapshot.observedAt||Date.parse(snapshot.observedAt)<Date.parse(clock.startObservedAt))return;
  const id=crypto.createHash('sha256').update(snapshot.source.sessionId+':'+clock.startObservedAt).digest('hex').slice(0,20);
  const dir=path.join(this.dir,id);fs.mkdirSync(dir,{recursive:true});
  const stats={observedAt:snapshot.observedAt,npcNo:snapshot.npcNo,timeCostSeconds:snapshot.timeCostSeconds,actors:snapshot.actors,sequence:snapshot.sequence};
  const statKey=JSON.stringify(stats);
  if(this.current!==id){
   this.clientBuildSha256=(snapshot.source.sessionId===this.source?.sessionId&&
    snapshot.source.gameData?.manifestSha256===this.source.gameData?.manifestSha256)
    ?recordedBuild(this.sessionDir,this.source):undefined;
   this.current=id;this.previous=null;fs.appendFileSync(path.join(this.dir,'index.jsonl'),JSON.stringify({id,source:this.source,startObservedAt:clock.startObservedAt,path:id})+'\n');
  }
  const recorded={...snapshot,source:{...snapshot.source,mode:'replay'},health:{...snapshot.health,status:'recorded',session:'recorded'}};
  if(this.previous!==statKey){fs.appendFileSync(path.join(dir,'snapshots.jsonl'),JSON.stringify({statistics:stats,attribution:estimate?.encounterAnchor===clock.startObservedAt?estimate:null})+'\n');fs.appendFileSync(path.join(dir,'statistics.jsonl'),JSON.stringify(recorded)+'\n');this.previous=statKey;}
  fs.writeFileSync(path.join(dir,'latest.json'),JSON.stringify(recorded));
  fs.writeFileSync(path.join(dir,'identities.json'),JSON.stringify({source:this.source,names:identities}));
  if(estimate?.encounterAnchor===clock.startObservedAt)fs.writeFileSync(path.join(dir,'attribution-estimate.json'),JSON.stringify(estimate));
  const data={schemaVersion:1,id,source:this.source,updatedAt:new Date().toISOString(),status:clock.endObservedAt?'ended':snapshot.health?.status==='stopped'||snapshot.health?.status==='invalid'?'interrupted':'active',clock,statistics:stats,identities,attribution:estimate?.encounterAnchor===clock.startObservedAt?estimate:null,health:snapshot.health,rawSessionDirectory:'../..',rawFiles:['manifest.json','transport.private.tsv','damage-events.jsonl','buff-events.jsonl','encounter-events.jsonl','attribute-events.jsonl','attribution-hit-estimates.jsonl','settlement-details.jsonl'],scope:'Per-fight snapshots and attribution with shared retained raw session evidence. Reception clock; missing events are not reconstructed.'};
  if(this.clientBuildSha256)data.clientBuildSha256=this.clientBuildSha256;
  const target=path.join(dir,'battle.json'),tmp=target+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data));fs.renameSync(tmp,target);
 }
}
module.exports={BattleArchive};
