'use strict';
const {randomUUID}=require('node:crypto');

// A PID alone can be reused after a restart. Both identities must match before
// a service status can select a capture file or change the overlay state.
class ServiceLifecycle{
 constructor({handshakeTimeoutMs=15000,createLaunchId=randomUUID}={}){
  this.handshakeTimeoutMs=handshakeTimeoutMs;this.createLaunchId=createLaunchId;this.current=null;
 }
 begin(now=Date.now()){
  this.current={launchId:this.createLaunchId(),pid:null,startedAt:now,handshakeAt:null,lastStatusAt:null,phase:'starting'};
  return this.current.launchId;
 }
 bindPid(launchId,pid){
  if(this.current?.launchId!==launchId||!Number.isSafeInteger(pid)||pid<=0)return false;
  this.current.pid=pid;return true;
 }
 accept(status,now=Date.now()){
  const c=this.current;
  if(!c||['stopped','failed'].includes(c.phase)||!Number.isSafeInteger(c.pid))return false;
  if(!status||typeof status!=='object'||status.launchId!==c.launchId||status.pid!==c.pid||typeof status.message!=='string')return false;
  c.handshakeAt??=now;c.lastStatusAt=now;c.phase='running';return true;
 }
 checkStartupTimeout(now=Date.now()){
  const c=this.current;
  if(!c||c.phase!=='starting'||c.handshakeAt!==null||now-c.startedAt<this.handshakeTimeoutMs)return false;
  c.phase='start-timeout';return true;
 }
 finish(launchId,{code=null,signal=null,error=null}={},now=Date.now()){
  const c=this.current;
  if(!c||c.launchId!==launchId||['stopped','failed'].includes(c.phase))return false;
  Object.assign(c,{phase:error?'failed':'stopped',endedAt:now,exitCode:code,signal,error});return true;
 }
 snapshot(){return this.current?{...this.current}:null;}
}
module.exports={ServiceLifecycle};
