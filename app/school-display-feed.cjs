'use strict';
const fs=require('fs'),path=require('path');
const catalog=require('../config/overlay-schools.json');
// Display inference only. Never supplies currentKungfu to attribution.
class SchoolDisplayFeed {
 constructor(latestPath){this.dir=path.dirname(latestPath);this.reset();}
 reset(){this.key=null;this.identity=null;this.offset=0;this.pending=Buffer.alloc(0);this.rows=[];this.totals=new Map();}
 poll(view){
  const c=view.encounter,s=view.snapshot;if(!c||!s?.source?.sessionId)return;
  const start=c.encounterClock?.startObservedAt||c.firstObservedAt;
  const end=c.encounterClock?.endObservedAt||c.lastObservedAt;
  const startMs=Date.parse(start),endMs=Math.min(Date.parse(end),Date.parse(s.observedAt));
  if(!Number.isFinite(startMs)||!Number.isFinite(endMs))return;
  let dir=this.dir;
  if(!fs.existsSync(path.join(dir,'damage-events.jsonl'))&&path.basename(path.dirname(dir))==='battles')dir=path.resolve(dir,'../..');
  const file=path.join(dir,'damage-events.jsonl');if(!fs.existsSync(file))return;
  const stat=fs.statSync(file),identity=`${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  const key=[s.source.sessionId,c.id,start].join(':');
  if(key!==this.key||identity!==this.identity||stat.size<this.offset){this.reset();this.key=key;this.identity=identity;}
  // At most 2 MiB per poll; long saved sessions catch up without blocking the UI.
  if(!this.rows.length&&stat.size>this.offset){
   const fd=fs.openSync(file,'r');try{const b=Buffer.alloc(Math.min(2*1024*1024,stat.size-this.offset)),n=fs.readSync(fd,b,0,b.length,this.offset);this.offset+=n;
    const bytes=Buffer.concat([this.pending,b.subarray(0,n)]),last=bytes.lastIndexOf(10);
    if(last>=0){this.rows=bytes.subarray(0,last).toString('utf8').split('\n');this.pending=bytes.subarray(last+1);}else this.pending=bytes;
    if(this.pending.length>2*1024*1024)throw Error('Oversized school display event');
   }finally{fs.closeSync(fd);}
  }
  let consumed=0;
  for(const line of this.rows){
   if(!line.trim()){consumed++;continue;}
   const r=JSON.parse(line),t=Date.parse(r.observedAt);
   // Future ledger rows wait for the matching latest publication.
   if(r.source?.sessionId===s.source.sessionId&&(t>Date.parse(s.observedAt)||(Number.isFinite(s.transport?.recordOrdinal)&&Number.isFinite(r.transportRecordOrdinal)&&r.transportRecordOrdinal>s.transport.recordOrdinal)))break;
   consumed++;
   if(r.source?.sessionId!==s.source.sessionId||!Number.isFinite(t)||t<startMs||t>endMs||r.sourceActorHash===r.targetActorHash||!Number.isFinite(r.amount)||r.amount<0)continue;
   let info=null;for(const id of [r.rawSkillId,r.rawCalcpointId!=null?Math.floor(r.rawCalcpointId/100):null]){const k=catalog.skills[id];if(k!=null){info=catalog.schools[k];break;}}
   if(!info||info.placeholder)continue;
   const m=this.totals.get(r.sourceActorHash)||new Map(),row=m.get(info.id)||{...info,amount:0,hits:0};row.amount+=r.amount;row.hits++;m.set(info.id,row);this.totals.set(r.sourceActorHash,m);
  }
  this.rows=this.rows.slice(consumed);
  c.actors=c.actors.map(a=>{const list=[...(this.totals.get(a.idHash)?.values()||[])].sort((a,b)=>b.amount-a.amount||b.hits-a.hits),primary=list[0];return primary?{...a,schoolDisplay:{id:primary.id,name:primary.name,color:primary.color,basis:'inferred-from-captured-hits'}}:a;});
 }
}
module.exports={SchoolDisplayFeed};
