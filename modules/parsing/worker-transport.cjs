'use strict';
const config=require('../configuration/contract.cjs').validate('config/worker-protocol.json',require('../../config/worker-protocol.json'));
class WorkerBatchWriter {
 constructor(stream,{onError=()=>{}}={}){this.stream=stream;this.onError=onError;this.jobs=[];this.bytes=0;this.scheduled=null;this.closed=false;this.batching=false;this.writes=0;}
 push(job){
  if(this.closed)throw Error('Worker writer closed');
  const text=JSON.stringify(job),bytes=Buffer.byteLength(text);
  if(!this.batching){this.stream.write(text+'\n');this.writes++;return;}
  if(this.jobs.length&&(this.bytes+bytes>config.maxBatchBytes||this.jobs.length>=config.maxBatchJobs))this.flush();
  // A large single frame uses the existing single-job format; never split an RPC.
  if(bytes>config.maxBatchBytes){this.stream.write(text+'\n');this.writes++;return;}
  this.jobs.push(text);this.bytes+=bytes;
  if(this.jobs.length===config.maxBatchJobs)this.flush();
  else if(!this.scheduled)this.scheduled=setImmediate(()=>{this.scheduled=null;try{this.flush();}catch(e){this.onError(e);}});
 }
 flush(){
  clearImmediate(this.scheduled);this.scheduled=null;
  if(this.closed||!this.jobs.length)return;
  this.stream.write('{"schemaVersion":1,"jobs":['+this.jobs.join(',')+']}\n');this.writes++;this.jobs=[];this.bytes=0;
 }
 close(){this.closed=true;clearImmediate(this.scheduled);this.scheduled=null;this.jobs=[];this.bytes=0;}
}
function workerResponses(line){
 const value=JSON.parse(line);
 if(value&&Object.hasOwn(value,'results')){
  if(value.schemaVersion!==1||!Array.isArray(value.results)||!value.results.length||value.results.length>config.maxBatchJobs)throw Error('Invalid worker response batch');
  const ids=new Set();for(const row of value.results){if(!row||!Number.isSafeInteger(row.id)||ids.has(row.id))throw Error('Invalid worker response identity');ids.add(row.id);}
  return value.results;
 }
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid worker response');
 return [value];
}
module.exports={WorkerBatchWriter,workerResponses,config};
