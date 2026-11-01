'use strict';
// Cipher primitives supplied by the codec adapter; no filesystem/process dependencies.
function createOrderedCipher({crypt,step,validate}) {
class OrderedCipher {
 // onGap enables recovery: an unresolved gap older than gapMs advances RC4 by
 // the exact missing TCP byte count and reports it. Without onGap a gap fails.
 // gapPendingBytes also triggers recovery when buffered data past the hole grows
 // that large, so a finite replay or a heavy burst does not wait on wall time.
 constructor(state,origin,{onBytes,onGap=null,gapMs=3000,gapPendingBytes=1024*1024,maxSkip=128*1024*1024}={}){this.s=validate({i:state.i,j:state.j,S:[...state.S]});this.origin=origin;this.next=null;this.base=null;this.pending=[];this.pendingBytes=0;this.history=Buffer.alloc(0);this.onBytes=onBytes;this.onGap=onGap;this.gapMs=gapMs;this.gapPendingBytes=gapPendingBytes;this.maxSkip=maxSkip;this.gapSince=null;this.overlaps=0;this.skippedRanges=[];this.gapCount=0;this.gapBytes=0;this.lateBytes=0;this.unverifiedDuplicateBytes=0;}
 push(packet){
  let seq=packet.seq;if(this.next!==null){while(seq<this.next-0x80000000)seq+=0x100000000;while(seq>this.next+0x80000000)seq-=0x100000000;}
  if(!Number.isSafeInteger(seq)||seq<this.origin)throw Error('Sequence precedes session cipher origin');
  this.pending.push({...packet,seq});this.pendingBytes+=packet.data.length;
  if(this.onGap&&this.next!==null&&this.pendingBytes>this.gapPendingBytes){this.drain();if(this.pendingBytes>this.gapPendingBytes)this.recover();}
  if(this.pendingBytes>4*1024*1024)throw Error('TCP pending buffer exceeds 4MiB');
 }
 start(){if(this.next!==null||!this.pending.length)return;this.pending.sort((a,b)=>a.seq-b.seq);this.next=this.base=this.pending[0].seq;const skip=this.base-this.origin;if(skip>this.maxSkip)throw Error('Session sequence distance exceeds configured RC4 seek budget');for(let n=0;n<skip;n++)step(this.s);this.drain();}
 drain(now=Date.now()){
  if(this.next===null)return;
  this.pending.sort((a,b)=>a.seq-b.seq);
  while(this.pending.length){let p=this.pending[0];if(p.seq>this.next){this.gapSince??=now;return;}
   this.pending.shift();this.pendingBytes-=p.data.length;
   if(p.seq<this.base&&this.onGap){p=this.dropLate(p);if(!p)continue;}
   let overlap=Math.min(p.data.length,this.next-p.seq);
   if(overlap){if(p.seq<this.base)throw Error('Late packet before initialized capture start');const prev=this.history.subarray(p.seq-this.base,p.seq-this.base+overlap);if(prev.length!==overlap||!prev.equals(p.data.subarray(0,overlap)))throw Error('Conflicting or unverifiable TCP retransmission');this.overlaps+=overlap;}
   const add=p.data.subarray(overlap);if(!add.length)continue;
   // Bounded retransmission window, independent of session lifetime. Cipher
   // state continues forward; old evidence is retained by the raw disk ledger.
   const start=this.next;this.history=Buffer.concat([this.history,add]);this.next+=add.length;
   if(this.history.length>1024*1024){const trim=this.history.length-1024*1024;this.history=this.history.subarray(trim);this.base+=trim;}
   this.onBytes(crypt(this.s,add),{seq:start,endSeq:this.next,observedAt:p.observedAt,frame:p.frame});
   this.gapSince=null;
  }
 }
 // Bytes inside an already skipped range arrived too late; they are counted,
 // never decrypted with a keystream position that has moved past them.
 // Bytes before the retained history were already consumed (or lie before a
 // recovered gap) and can no longer be compared; they are counted, not trusted.
 dropLate(p){
  const r=this.skippedRanges.find(x=>p.seq>=x.from&&p.seq<x.to);
  const until=r?r.to:this.base,late=Math.min(p.data.length,until-p.seq);
  if(r)this.lateBytes+=late;else this.unverifiedDuplicateBytes+=late;
  if(late>=p.data.length)return null;
  const rest={...p,seq:until,data:p.data.subarray(late)};return rest.seq<this.base?this.dropLate(rest):rest;
 }
 recover(now=Date.now()){
  if(!this.onGap)throw Error('Unresolved TCP gap; continuity invalid');
  this.pending.sort((a,b)=>a.seq-b.seq);const p=this.pending[0];
  if(this.next===null||!p||p.seq<=this.next)return false;
  const bytes=p.seq-this.next;if(bytes>this.maxSkip)throw Error('TCP gap exceeds configured RC4 seek budget');
  for(let n=0;n<bytes;n++)step(this.s);
  const gap={fromSeq:this.next,toSeq:p.seq,bytes,waitedMs:this.gapSince===null?0:now-this.gapSince,resumeFrame:p.frame,resumeObservedAt:p.observedAt};
  this.skippedRanges.push({from:this.next,to:p.seq});if(this.skippedRanges.length>64)this.skippedRanges.shift();
  this.next=this.base=p.seq;this.history=Buffer.alloc(0);this.gapSince=null;this.gapCount++;this.gapBytes+=bytes;
  this.onGap(gap);this.drain(now);return true;
 }
 tick(now=Date.now()){this.drain(now);if(this.gapSince!==null&&now-this.gapSince>=this.gapMs)this.recover(now);}
 // Finite input (replay): recover every remaining gap instead of waiting.
 finish(now=Date.now()){this.drain(now);while(this.pending.length&&this.recover(now));}
}

return OrderedCipher;
}
module.exports={createOrderedCipher};
