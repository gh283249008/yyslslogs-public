'use strict';
const fs=require('fs'),path=require('path');
// Fail-open, bounded asynchronous telemetry. Never use the combat ledger or
// make packet processing wait for a diagnostic disk write.
class NetworkDiagnostics {
 constructor(directory,source){
  this.source=source;this.disabled=false;this.dropped=0;this.error=null;this.closed=false;
  try{this.stream=fs.createWriteStream(path.join(directory,'network-health.jsonl'),{flags:'a',highWaterMark:16384});this.stream.on('error',e=>{this.disabled=true;this.error=e.code||e.message;});}catch(e){this.disabled=true;this.error=e.code||e.message;}
 }
 write(row){if(this.disabled||this.closed)return;try{if(this.stream.writableLength>65536){this.dropped++;return;}this.stream.write(JSON.stringify({schemaVersion:1,source:this.source,...row,diagnosticDroppedRows:this.dropped})+'\n');}catch(e){this.disabled=true;this.error=e.code||e.message;}}
 status(){return {disabled:this.disabled,droppedRows:this.dropped,error:this.error};}
 close(){if(this.closed)return Promise.resolve();this.closed=true;return new Promise(resolve=>{if(!this.stream||this.stream.destroyed)return resolve();const timer=setTimeout(()=>{this.stream.destroy();resolve();},1000);this.stream.end(()=>{clearTimeout(timer);resolve();});});}
}
module.exports={NetworkDiagnostics};
