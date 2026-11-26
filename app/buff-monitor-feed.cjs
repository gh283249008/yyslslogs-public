'use strict';
// Personal buff monitor: own-client identity plus that recipient's public buffs.
// It is a UI state feed, not team coverage or rDPS attribution.
const fs=require('fs'),path=require('path');
const {StringDecoder}=require('node:string_decoder');

const {buffs:BUFFS,slots:SLOTS,cooldownEstimates=[]}=require('../config/overlay-buffs.json');
const {BuffCooldownEstimates}=require('./buff-cooldown-estimates.cjs');
const ACTIVE_KINDS=new Set(['apply_candidate','update','snapshot','field_patch']);
const REMOVAL_KINDS=new Set(['remove_candidate']);
const {resolveEncounterDisplayIdentity}=require('../modules/domain/encounter-display-name.cjs');

class BuffMonitorFeed {
  constructor(latestPath,{now=()=>Date.now(),definitions=BUFFS,subject=null}={}){
    this.cooldownEstimates=new BuffCooldownEstimates(cooldownEstimates);this.definitions=definitions;this.enabled=Object.keys(definitions).length>0;this.now=now;this.setSource(latestPath);this.subject=subject;
  }
  setSource(latestPath){
    this.latestPath=path.resolve(latestPath);
    this.file=path.join(path.dirname(this.latestPath),'buff-events.jsonl');
    this.reset();this.subject=null;
  }
  reset(){
    this.cooldownEstimates.clear();
    this.offset=0;this.partial='';this.decoder=new StringDecoder('utf8');this.states=new Map();this.seenActors=new Set();this.sessionId=null;this.selfActor=null;this.identityConflict=false;this.interrupted=false;this.catchingUp=false;this.boss=null;
  }
  bind(actor){
    if(!actor)return;
    if(this.selfActor&&this.selfActor!==actor){this.identityConflict=true;this.cooldownEstimates.clear();}
    else this.selfActor=actor;
  }
  selectedActor(){
    return this.subject?.sessionId===this.sessionId?this.subject.actor:null;
  }
  setSubject(actor,sessionId){
    if(sessionId!==this.sessionId)throw Error('采集会话已切换，请重新打开设置');
    if(actor&&!this.subjectOptions().some(row=>row.id===actor))throw Error('该角色尚未在本次采集中识别，请等待角色数据');
    if(actor!==this.selectedActor())this.cooldownEstimates.clear();
    this.subject=actor?{actor,sessionId}:null;
  }
  subjectOptions(){
    try{
      const data=JSON.parse(fs.readFileSync(path.join(path.dirname(this.latestPath),'identities.json'),'utf8'));
      if(data.source?.sessionId!==this.sessionId)return [];
      const {validIdentity}=require('../tools/p1-identity-cache.cjs');
      return (data.names||[]).filter(row=>validIdentity(row)&&this.seenActors.has(row.idHash)).map(row=>({id:row.idHash,name:row.name}));
    }catch{return [];}
  }
  setBoss(snapshot){
    const clock=snapshot?.encounterClock;
    const identity=clock&&!clock.endObservedAt&&clock.source?.sessionId===this.sessionId&&snapshot.source?.sessionId===this.sessionId
      ?resolveEncounterDisplayIdentity(clock.identityContext,snapshot.npcNo,snapshot.source.gameData):null;
    const actor=identity?.bossActorHash||identity?.displayActorHash;
    const next=actor?{actor,name:identity.bossName,start:clock.startObservedAt,key:JSON.stringify([this.sessionId,clock.spaceHash,clock.startObservedAt,actor])}:null;
    if(this.boss&&this.boss.key!==next?.key){
      for(const [key,event]of this.states)if(event.targetActorHash===this.boss.actor&&(!next||Date.parse(event.observedAt)<Date.parse(next.start)))this.states.delete(key);
    }
    this.boss=next;
  }
  consume(event){
    if(event?.source?.sessionId&&this.sessionId&&event.source.sessionId!==this.sessionId){this.cooldownEstimates.clear();this.states.clear();this.seenActors.clear();this.selfActor=null;this.identityConflict=false;this.interrupted=false;this.subject=null;this.boss=null;}
    if(event?.source?.sessionId)this.sessionId=event.source.sessionId;
    if(event.kind==='monitor_invalidate'){
      this.cooldownEstimates.invalidate(event);
      for(const [key,state] of this.states)if((!event.targetActorHash||state.targetActorHash===event.targetActorHash)&&(!event.bag||state.bag===event.bag))this.states.delete(key);
      if(!event.bag&&(!event.targetActorHash||event.targetActorHash===this.selfActor)){this.selfActor=null;this.identityConflict=false;}
      if(!event.targetActorHash){this.interrupted=true;if(event.reason==='session_end')this.subject=null;}
      return;
    }
    if(event.kind==='monitor_identity'){
      if(['buffs_data.oc_buffs','buffs_data.oc_flags','buffs_data.oc_flags_src'].includes(event.identityBasis))this.bind(event.targetActorHash);
      return;
    }
    // An own-client bag identifies the local recipient, even when this particular
    // buff is not monitored. Public buffs require that exact recipient binding.
    if(event?.bag==='oc_buffs'&&event.targetActorHash){
      this.bind(event.targetActorHash);
    }
    if(!['oc_buffs','ac_buffs'].includes(event?.bag))return;
    if(event.targetActorHash)this.seenActors.add(event.targetActorHash);
    this.cooldownEstimates.consume(event,this.selectedActor()||(!this.identityConflict&&this.selfActor),this.definitions);
    const key=`${event.bag}:${event.targetActorHash||'self'}:${event.buffInstanceHash||event.buffNo}`;
    if(REMOVAL_KINDS.has(event.kind)){this.states.delete(key);return;}
    if(!ACTIVE_KINDS.has(event.kind))return;
    if(!this.definitions[event.buffNo]){if(event.buffNo!=null)this.states.delete(key);return;}
    let prior=this.states.get(key);
    if(prior&&prior.buffNo!==event.buffNo){this.states.delete(key);prior=null;}
    const observed=Date.parse(event.observedAt)/1000;
    const refresh=!event.initial&&event.kind!=='snapshot'&&(event.kind==='apply_candidate'||
      event.kind==='update'&&event.changes?.start_ts!=null||
      prior&&event.rawStartTimestamp!=null&&event.rawStartTimestamp!==prior.rawStartTimestamp);
    // A patch cannot create a new lifetime after expiry, removal or loss.
    if(!prior&&!refresh&&event.kind!=='snapshot'&&!(event.initial&&event.kind==='apply_candidate'))return;
    this.interrupted=false;
    // Server start_ts and the capture clock are different clocks. A saved Lin
    // application/removal lasts 12.002s, while nominalExpiry-localNow gives 15s.
    // Anchor only a received application/explicit refresh, never a field patch
    // or an initial snapshot of a buff that may already have been running.
    const localExpirySeconds=refresh
      ?(Number.isFinite(observed)&&Number.isFinite(event.durationSeconds)&&event.durationSeconds>0?observed+event.durationSeconds:null)
      :event.kind==='snapshot'?null:prior?.localExpirySeconds??null;
    this.states.set(key,{...prior,...event,localExpirySeconds,observedAt:event.observedAt||new Date(this.now()).toISOString()});
  }
  readNew(){
    const preferred=path.join(path.dirname(this.latestPath),'monitor-events.jsonl');
    if(this.file!==preferred&&fs.existsSync(preferred)){this.file=preferred;this.reset();}
    let stat;try{stat=fs.statSync(this.file);}catch(e){if(e.code==='ENOENT')return;throw e;}
    if(stat.size<this.offset){this.reset();this.subject=null;}
    if(stat.size===this.offset)return;
    const length=Math.min(4*1024*1024,stat.size-this.offset),buffer=Buffer.alloc(length),fd=fs.openSync(this.file,'r');
    try{fs.readSync(fd,buffer,0,length,this.offset);}finally{fs.closeSync(fd);}
    const text=this.partial+this.decoder.write(buffer);
    const rows=text.split(/\r?\n/);this.partial=rows.pop();this.offset+=length;
    for(const row of rows){if(!row.trim())continue;try{this.consume(JSON.parse(row));}catch{/* A malformed evidence row cannot create a UI state. */}}
    this.catchingUp=this.offset<stat.size;
  }
  poll(health=null,snapshot=null){
    this.readNew();
    this.setBoss(snapshot);
    const disconnected=health?.session==='invalid'||['invalid','stopped','connection-closed'].includes(health?.status);
    if(disconnected){this.cooldownEstimates.clear();this.states.clear();this.interrupted=true;}
    const nowSeconds=this.now()/1000,chosen=new Map();
    for(const [key,event] of this.states){
      const definition=this.definitions[event.buffNo];if(!definition)continue;
      const expiry=typeof event.localExpirySeconds==='number'?event.localExpirySeconds:NaN;
      if(Number.isFinite(expiry))this.cooldownEstimates.suppress(event.buffNo,event.targetActorHash,expiry);
      if(Number.isFinite(expiry)&&expiry<=nowSeconds){this.states.delete(key);continue;}
      if(this.catchingUp||disconnected)continue;
      for(const spec of definition.monitors||[definition]){
      const boss=spec.target==='boss';
      const actor=boss?this.boss?.actor:this.selectedActor()||(!this.identityConflict&&this.selfActor);
      if(!boss&&!this.selectedActor()&&this.identityConflict)continue;
      if(boss&&(!actor||event.bag!=='ac_buffs'||Date.parse(event.observedAt)<Date.parse(this.boss.start)))continue;
      if(event.targetActorHash?event.targetActorHash!==actor:boss||event.bag!=='oc_buffs')continue;
      const stacks=Number.isInteger(event.charge_level)&&event.charge_level>=1&&event.charge_level<=spec.maxStacks?event.charge_level:null;
      const value={durationSeconds:typeof event.durationSeconds==='number'&&event.durationSeconds>0?event.durationSeconds:null,phase:spec.requiresResourceSuccess?(event.resourceChangeSuccess===true?'active':event.resourceChangeSuccess===false?'pending':'unknown'):null,stacks,id:String(event.buffNo),name:spec.name,variant:spec.requiresResourceSuccess?(event.resourceChangeSuccess===true?spec.variant:event.resourceChangeSuccess===false?'待治疗达标':'增伤状态未知'):spec.slot==='bengjie'?(stacks==null?'层数未知':`${stacks} 层`):spec.variant,remainingSeconds:Number.isFinite(expiry)?Math.max(0,expiry-nowSeconds):null,expiresAt:Number.isFinite(expiry)?new Date(expiry*1000).toISOString():null,observedAt:event.observedAt,kind:event.kind,uncertain:event.completeFields!==true};
      const keyForDisplay=spec.monitorKey||spec.slot;
      const previous=chosen.get(keyForDisplay);
      if(!previous||(value.remainingSeconds??-1)>(previous.remainingSeconds??-1)){
        chosen.set(keyForDisplay,{...value,key:keyForDisplay,style:spec.slot,order:spec.order,target:boss?'boss':'self',targetName:boss?this.boss.name:null});
      }
      }
    }
    if(!this.catchingUp&&!disconnected){
      const actor=this.selectedActor()||(!this.identityConflict&&this.selfActor);
      for(const row of this.cooldownEstimates.project(actor,this.definitions,nowSeconds)){
        const actual=chosen.get(row.key);
        if(!actual||actual.remainingSeconds==null)chosen.set(row.key,row);
      }
    }
    const buffs=this.definitions===BUFFS?SLOTS.map(slot=>chosen.get(slot)||null):[...chosen.values()].sort((a,b)=>a.order-b.order);
    const specs=Object.values(this.definitions).flatMap(spec=>spec.monitors||[spec]),needsSelf=specs.some(spec=>spec.target!=='boss'),needsBoss=specs.some(spec=>spec.target==='boss');
    const status=this.catchingUp?'catching-up':this.interrupted?'interrupted':needsSelf&&this.identityConflict&&!this.selectedActor()?'identity-conflict':needsSelf&&!this.selfActor&&!this.selectedActor()&&!buffs.some(row=>row?.target==='self')?'waiting-identity':needsBoss&&!this.boss?'waiting-boss':'observing';
    return {schemaVersion:1,source:{sessionId:this.sessionId},status,subject:this.selectedActor()||this.selfActor,manualSubject:!!this.selectedActor(),boss:this.boss?.name||null,buffs,notice:'自身 Buff 与本场 Boss Debuff 分开匹配；倒计时按收到应用/刷新事件的时刻与同步持续时间估算，移除立即隐藏。首次快照起点未知时不猜剩余时间。'};
  }
}
module.exports={BUFFS,BuffMonitorFeed};
