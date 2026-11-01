'use strict';
function createBlockStream(normalize) {
const LIMIT=16*1024*1024;
class BlockStream {
 constructor(onBlock,{onResync=null}={}){this.buf=Buffer.alloc(0);this.aligned=false;this.onBlock=onBlock;this.onResync=onResync;this.wireSeq=null;this.skipped=0;this.records=0;this.fragments=[];this.resyncs=0;this.resyncSkippedBytes=0;this.discardedBytes=0;this.pendingResync=null;}
 // After a transport gap the partial record is discarded and the next block
 // boundary is searched with the same multi-record validation as startup.
 resync(info={}){const r={...info,discardedPartialBytes:this.buf.length,recordOrdinal:this.records};this.discardedBytes+=this.buf.length;this.buf=Buffer.alloc(0);this.fragments=[];this.wireSeq=null;this.aligned=false;this.resyncs++;this.pendingResync=r;return r;}
 push(bytes,meta){if(this.wireSeq===null)this.wireSeq=meta.seq;this.fragments.push({start:meta.seq,end:meta.seq+bytes.length,meta});this.buf=Buffer.concat([this.buf,bytes]);if(this.buf.length>LIMIT)throw Error('Framing buffer exceeds16MiB');
  if(!this.aligned){for(let off=0;off<Math.min(65536,Math.max(0,this.buf.length-3));off++){
    try{const r=normalize(this.buf.subarray(off),{maxBodyBytes:LIMIT,allowIncompleteTail:true});if(r.records.length>=3&&r.records.every(x=>x.methodIndex<128)){if(this.pendingResync)this.resyncSkippedBytes+=off;else this.skipped=off;this.buf=this.buf.subarray(off);this.wireSeq+=off;this.aligned=true;if(this.pendingResync){const done={...this.pendingResync,skippedBytes:off,wireSequence:this.wireSeq};this.pendingResync=null;this.onResync?.(done);}break;}}catch{}
   }if(!this.aligned){if(this.buf.length>256*1024)throw Error('No validated server block boundary within64KiB prefix');return;}}
  const r=normalize(this.buf,{maxBodyBytes:LIMIT,allowIncompleteTail:true});
  for(const b of r.records){const start=this.wireSeq+b.inputOffset,end=start+b.inputBytes,parts=this.fragments.filter(x=>x.end>start&&x.start<end);const completion=parts.reduce((a,x)=>!a||x.meta.observedAt>a.observedAt?x.meta:a,null);this.onBlock(r.output.subarray(b.outputOffset+4,b.outputOffset+4+b.bodyBytes),{...completion,wireSequence:start,wireBytes:b.inputBytes,compressed:b.compressed,recordOrdinal:this.records++});}
  this.buf=this.buf.subarray(r.consumedBytes);this.wireSeq+=r.consumedBytes;this.fragments=this.fragments.filter(x=>x.end>this.wireSeq);
 }
}

return BlockStream;
}
module.exports={createBlockStream};
