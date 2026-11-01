'use strict';
const fs=require('fs');
const limits=Object.freeze(require('../configuration/contract.cjs').validate('config/runtime-io.json',require('../../config/runtime-io.json')));
// Reuse descriptors and batch small derived-event writes. Raw packet evidence
// is written immediately and is also the decoder's durable backpressure queue.
class LedgerWriter {
 constructor(){this.files=new Map();this.timer=setInterval(()=>this.flush(),limits.ledgerFlushIntervalMs);this.timer.unref();}
 append(file,text){let r=this.files.get(file);if(!r){r={fd:fs.openSync(file,'a'),chunks:[],size:0};this.files.set(file,r);}r.chunks.push(text);r.size+=Buffer.byteLength(text);if(r.size>=limits.ledgerFlushBytes)this.flushFile(r);}
 flushFile(r){if(!r.size)return;fs.writeSync(r.fd,r.chunks.join(''));r.chunks=[];r.size=0;}
 flush(){for(const r of this.files.values())this.flushFile(r);}
 close(){clearInterval(this.timer);this.flush();for(const r of this.files.values())fs.closeSync(r.fd);this.files.clear();}
}
module.exports={LedgerWriter};
