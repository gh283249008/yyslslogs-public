'use strict';
const fs=require('node:fs');
const limits=Object.freeze(require('../configuration/contract.cjs').validate('config/runtime-io.json',require('../../config/runtime-io.json')));
// The raw journal is the durable queue. A paused decoder never pauses ingestion.
class RawSpool {
 constructor(file,{io=fs,clock=Date.now}={}){
  this.io=io;this.clock=clock;this.offset=0;this.size=0;this.pending='';this.closed=false;
  this.writer=io.openSync(file,'a');
  try{this.reader=io.openSync(file,'r');}catch(error){io.closeSync(this.writer);throw error;}
 }
 append(bytes){
  if(this.closed)throw Error('Raw spool closed');
  let offset=0;while(offset<bytes.length){const n=this.io.writeSync(this.writer,bytes,offset,bytes.length-offset);if(n<=0)throw Error('Raw write made no progress');offset+=n;this.size+=n;}
  return offset;
 }
 get backlogBytes(){return this.size-this.offset+Buffer.byteLength(this.pending);}
 get hasPending(){return this.offset<this.size||Boolean(this.pending.trim());}
 pump(onLine,canRead){
  if(this.closed||!canRead())return;
  const begin=this.clock();
  while(!this.closed&&canRead()&&this.clock()-begin<limits.pumpBudgetMs){
   const nl=this.pending.indexOf('\n');
   if(nl>=0){const line=this.pending.slice(0,nl);this.pending=this.pending.slice(nl+1);onLine(line);continue;}
   if(this.offset>=this.size)break;
   const b=Buffer.alloc(Math.min(limits.rawReadChunkBytes,this.size-this.offset)),n=this.io.readSync(this.reader,b,0,b.length,this.offset);
   if(n<=0)throw Error('Raw read made no progress');
   this.offset+=n;this.pending+=b.subarray(0,n).toString('utf8');
   if(this.pending.length>limits.rawLineLimitBytes)throw Error('Raw packet line exceeds16MiB');
  }
 }
 close(){if(this.closed)return;this.closed=true;try{this.io.closeSync(this.writer);}finally{this.io.closeSync(this.reader);}}
}
module.exports={RawSpool,limits};
