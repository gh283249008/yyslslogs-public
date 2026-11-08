const fs=require('fs'),path=require('path');
const {SchoolDisplayFeed}=require('./school-display-feed.cjs');
const {validIdentity}=require('../modules/storage/identity-cache.cjs');
// Consume every appended statistic, including short-lived nonzero time_cost.
// Latest.json remains health metadata; it must not erase an end snapshot.
class SnapshotFeed {
  constructor(latestPath){this.latestPath=latestPath;this.schoolDisplay=new SchoolDisplayFeed(latestPath);this.ledger=path.join(path.dirname(latestPath),'statistics.jsonl');this.identity=null;this.offset=0;this.pending='';this.lastFallbackKey=null;this.deferred=[];
    this.resourceLedger=path.join(path.dirname(latestPath),'resource-statistics.jsonl');this.resourceIdentity=null;this.resourceOffset=0;this.resourcePending='';}
  pollResources(model){
    if(!fs.existsSync(this.resourceLedger))return;
    const f=fs.openSync(this.resourceLedger,'r');
    try{
      const stat=fs.fstatSync(f),id=`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if(id!==this.resourceIdentity||stat.size<this.resourceOffset){this.resourceIdentity=id;this.resourceOffset=0;this.resourcePending='';}
      const n=stat.size-this.resourceOffset;if(n>32*1024*1024)throw Error('Resource statistics backlog exceeds32MiB');
      if(n){const b=Buffer.alloc(n),got=fs.readSync(f,b,0,n,this.resourceOffset);this.resourceOffset+=got;this.resourcePending+=b.subarray(0,got).toString('utf8');
        const lines=this.resourcePending.split('\n');this.resourcePending=lines.pop();
        for(const line of lines)if(line.trim())model.applyResourceStatistic(JSON.parse(line));}
    }finally{fs.closeSync(f);}
  }
  poll(model){
    const latest=JSON.parse(fs.readFileSync(this.latestPath,'utf8').replace(/^\uFEFF/,''));
    if(fs.existsSync(this.ledger)){
      const f=fs.openSync(this.ledger,'r');
      try{const stat=fs.fstatSync(f),id=`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        if(id!==this.identity||stat.size<this.offset){this.identity=id;this.offset=0;this.pending='';this.deferred=[];}
        const n=stat.size-this.offset;if(n>32*1024*1024)throw Error('Statistics backlog exceeds32MiB');
        if(n){const b=Buffer.alloc(n),got=fs.readSync(f,b,0,n,this.offset);this.offset+=got;this.pending+=b.subarray(0,got).toString('utf8');
          const lines=this.pending.split('\n');this.pending=lines.pop();for(const line of lines)if(line.trim())this.deferred.push(JSON.parse(line));}
      }finally{fs.closeSync(f);}
      while(this.deferred.length){const row=this.deferred[0];if(row.source?.sessionId===latest.source?.sessionId&&row.sequence>latest.sequence)break;model.ingest(this.deferred.shift());}
    }else if(latest.observedAt){const key=JSON.stringify([latest.source?.sessionId,latest.sequence,latest.observedAt,latest.transport?.wireSequence]);
      if(key!==this.lastFallbackKey){model.ingest(latest);this.lastFallbackKey=key;}
    }
    // Keep last encounter data, but surface stopped/invalid/missing input honestly.
    if(model.session!==latest.source?.sessionId)model.ingest({...latest,observedAt:null,actors:[]});
    model.latest=latest;
    model.applyEncounterClock(latest.encounterClock);
    let resourceError=null;
    try{this.pollResources(model);}catch{resourceError='真气独立统计输入不可用';}
    const view=model.view();let identityError=null;
    const namesFile=path.join(path.dirname(this.latestPath),'identities.json');
    if(view.encounter&&fs.existsSync(namesFile))try{
      const identity=JSON.parse(fs.readFileSync(namesFile,'utf8').replace(/^\uFEFF/,''));
      if(identity.source?.sessionId===latest.source?.sessionId && view.encounter.id.startsWith(identity.source.sessionId+':')){
        const names=new Map((identity.names||[]).filter(validIdentity).map(a=>[a.idHash,a]));
        view.encounter.actors=view.encounter.actors.map(a=>names.has(a.idHash)?{...a,name:names.get(a.idHash).name,nameSource:names.get(a.idHash).nameSource}:a);
      }
    }catch(e){identityError='Name metadata unavailable';}
    let schoolDisplayError=null;try{this.schoolDisplay.poll(view);}catch{schoolDisplayError='武学颜色证据暂不可用';}
    return {...view,identityError,resourceError,schoolDisplayError,inputError:null,transportStale:Date.now()-Date.parse(latest.publishedAt||latest.observedAt)>5000};
  }
}
module.exports={SnapshotFeed};
