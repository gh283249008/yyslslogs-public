'use strict';
// Personal buff monitor: own-client identity plus that recipient's public buffs.
// It is a UI state feed, not team coverage or rDPS attribution.
const fs=require('fs'),path=require('path');
const {StringDecoder}=require('node:string_decoder');

const {buffs:BUFFS,slots:SLOTS}=require('../config/overlay-buffs.json');
const ACTIVE_KINDS=new Set(['apply_candidate','update','snapshot','field_patch']);
const REMOVAL_KINDS=new Set(['remove_candidate']);

class BuffMonitorFeed {
  constructor(latestPath,{now=()=>Date.now()}={}){
    this.now=now;this.setSource(latestPath);
  }
  setSource(latestPath){
    this.latestPath=path.resolve(latestPath);
    this.file=path.join(path.dirname(this.latestPath),'buff-events.jsonl');
    this.offset=0;this.partial='';this.decoder=new StringDecoder('utf8');this.states=new Map();this.sessionId=null;this.selfActor=null;this.identityConflict=false;
  }
  consume(event){
    if(event?.source?.sessionId&&this.sessionId&&event.source.sessionId!==this.sessionId){this.states.clear();this.selfActor=null;this.identityConflict=false;}
    if(event?.source?.sessionId)this.sessionId=event.source.sessionId;
    // An own-client bag identifies the local recipient, even when this particular
    // buff is not monitored. Public buffs require that exact recipient binding.
    if(event?.bag==='oc_buffs'&&event.targetActorHash){
      if(this.selfActor&&this.selfActor!==event.targetActorHash)this.identityConflict=true;
      else this.selfActor=event.targetActorHash;
    }
    if(!['oc_buffs','ac_buffs'].includes(event?.bag)||!BUFFS[event.buffNo])return;
    const key=`${event.bag}:${event.targetActorHash||'self'}:${event.buffInstanceHash||event.buffNo}`;
    if(REMOVAL_KINDS.has(event.kind)){this.states.delete(key);return;}
    if(!ACTIVE_KINDS.has(event.kind))return;
    const prior=this.states.get(key),observed=Date.parse(event.observedAt)/1000;
    const refresh=!event.initial&&event.kind!=='snapshot'&&(event.kind==='apply_candidate'||
      event.kind==='update'&&event.changes?.start_ts!=null||
      prior&&event.rawStartTimestamp!=null&&event.rawStartTimestamp!==prior.rawStartTimestamp);
    // Server start_ts and the capture clock are different clocks. A saved Lin
    // application/removal lasts 12.002s, while nominalExpiry-localNow gives 15s.
    // Anchor only a received application/explicit refresh, never a field patch
    // or an initial snapshot of a buff that may already have been running.
    const localExpirySeconds=refresh&&Number.isFinite(observed)&&Number.isFinite(event.durationSeconds)&&event.durationSeconds>0
      ?observed+event.durationSeconds:prior?.localExpirySeconds??null;
    this.states.set(key,{...prior,...event,localExpirySeconds,observedAt:event.observedAt||new Date(this.now()).toISOString()});
  }
  readNew(){
    let stat;try{stat=fs.statSync(this.file);}catch(e){if(e.code==='ENOENT')return;throw e;}
    if(stat.size<this.offset){this.offset=0;this.partial='';this.decoder=new StringDecoder('utf8');this.states.clear();this.selfActor=null;this.identityConflict=false;}
    if(stat.size===this.offset)return;
    const length=Math.min(4*1024*1024,stat.size-this.offset),buffer=Buffer.alloc(length),fd=fs.openSync(this.file,'r');
    try{fs.readSync(fd,buffer,0,length,this.offset);}finally{fs.closeSync(fd);}
    const text=this.partial+this.decoder.write(buffer);
    const rows=text.split(/\r?\n/);this.partial=rows.pop();this.offset+=length;
    for(const row of rows){if(!row.trim())continue;try{this.consume(JSON.parse(row));}catch{/* A malformed evidence row cannot create a UI state. */}}
  }
  poll(){
    this.readNew();
    const nowSeconds=this.now()/1000,chosen=new Map();
    for(const [key,event] of this.states){
      const spec=BUFFS[event.buffNo];if(!spec)continue;
      const expiry=typeof event.localExpirySeconds==='number'?event.localExpirySeconds:NaN;
      if(Number.isFinite(expiry)&&expiry<=nowSeconds){this.states.delete(key);continue;}
      if(event.bag==='ac_buffs'&&(this.identityConflict||!this.selfActor||event.targetActorHash!==this.selfActor))continue;
      const stacks=Number.isInteger(event.charge_level)&&event.charge_level>=1&&event.charge_level<=spec.maxStacks?event.charge_level:null;
      const value={durationSeconds:typeof event.durationSeconds==='number'&&event.durationSeconds>0?event.durationSeconds:null,phase:spec.requiresResourceSuccess?(event.resourceChangeSuccess===true?'active':event.resourceChangeSuccess===false?'pending':'unknown'):null,stacks,id:String(event.buffNo),name:spec.name,variant:spec.requiresResourceSuccess?(event.resourceChangeSuccess===true?spec.variant:event.resourceChangeSuccess===false?'待治疗达标':'增伤状态未知'):spec.slot==='bengjie'?(stacks==null?'层数未知':`${stacks} 层`):spec.variant,remainingSeconds:Number.isFinite(expiry)?Math.max(0,expiry-nowSeconds):null,expiresAt:Number.isFinite(expiry)?new Date(expiry*1000).toISOString():null,observedAt:event.observedAt,kind:event.kind,uncertain:event.completeFields!==true};
      const previous=chosen.get(spec.slot);
      if(!previous||(value.remainingSeconds??-1)>(previous.remainingSeconds??-1))chosen.set(spec.slot,value);
    }
    return {schemaVersion:1,source:{sessionId:this.sessionId},status:this.sessionId?'observing':'waiting',buffs:SLOTS.map(slot=>chosen.get(slot)||null),notice:'仅显示本机自身 Buff；倒计时按收到应用/刷新事件的时刻与同步持续时间估算，移除立即隐藏。首次快照起点未知时不猜剩余时间。'};
  }
}
module.exports={BUFFS,BuffMonitorFeed};
