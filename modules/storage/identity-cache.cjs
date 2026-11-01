'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const SOURCES=new Set(['wire.match.players_data.nickname','wire.avatar.base.nickname','wire.combat_stat_detail.name','wire.loading_data.player_data.nickname','wire.team.players_base.nickname']);
const valid=row=>row&&/^[a-f0-9]{16}$/.test(row.idHash)&&typeof row.name==='string'&&row.name.trim()&&Buffer.byteLength(row.name,'utf8')<=256&&!/[\u0000-\u001f\u007f]/.test(row.name)&&SOURCES.has(row.nameSource);
class IdentityCache {
 constructor({file,clientBuildSha256,names,io=fs,now=Date.now}){
  Object.assign(this,{file,clientBuildSha256,names,io,now});this.lastRead=-Infinity;this.lastHistory=-Infinity;
  this.versionFile=file&&/^[a-f0-9]{64}$/.test(clientBuildSha256||'')?path.join(path.dirname(file),'identity-cache',clientBuildSha256+'.json'):null;
  this.diagnostics={cacheEnabled:!!this.versionFile,readErrors:[],recoveredFromCache:0,recoveredFromHistory:0};
 }
 read(file){return JSON.parse(this.io.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
 merge(rows,origin){let changed=false;for(const row of rows||[]){
  if(!valid(row))continue;const previous=this.names.get(row.idHash);
  // A current wire observation always beats an older cached nickname.
  if(previous&&String(previous.observedAt||'')>=String(row.observedAt||''))continue;
  this.names.set(row.idHash,{...row,fromIdentityCache:true,identityRecovery:origin});changed=true;
  this.diagnostics[origin==='history'?'recoveredFromHistory':'recoveredFromCache']++;
 }return changed;}
 recover({needed=[],force=false}={}){
  if(!this.versionFile||(!force&&this.now()-this.lastRead<5000))return false;
  this.lastRead=this.now();this.diagnostics.readErrors=[];let changed=false;
  for(const file of [this.file,this.versionFile])try{
   const cached=this.read(file);
   if(cached.clientBuildSha256===this.clientBuildSha256)changed=this.merge(cached.names,'cache')||changed;
  }catch(e){if(e.code!=='ENOENT')this.diagnostics.readErrors.push({file,code:e.code||'invalid-json',message:e.message});}
  if((!this.names.size||needed.some(id=>!this.names.has(id)))&&this.now()-this.lastHistory>=30000){
   this.lastHistory=this.now();const sessions=path.join(path.dirname(this.file),'sessions');
   let dirs=[];try{dirs=this.io.readdirSync(sessions,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>d.name).sort().reverse().slice(0,64);}catch(e){if(e.code!=='ENOENT')this.diagnostics.readErrors.push({file:sessions,code:e.code||'read-error'});}
   for(const name of dirs)try{
    const dir=path.join(sessions,name),configBytes=this.io.readFileSync(path.join(dir,'session.private.json'));
    const config=JSON.parse(configBytes.toString('utf8').replace(/^\uFEFF/,''));
    if(config.clientBuildSha256!==this.clientBuildSha256)continue;
    const manifest=this.read(path.join(dir,'capture/manifest.json'));
    if(manifest.configSha256!==crypto.createHash('sha256').update(configBytes).digest('hex'))continue;
    const identity=this.read(path.join(dir,'capture/identities.json'));
    if(identity.source?.sessionId!==manifest.sessionId||identity.source?.mode!=='live')continue;
    changed=this.merge(identity.names,'history')||changed;
   }catch{}
  }
  this.diagnostics.checkedAt=new Date(this.now()).toISOString();return changed;
 }
 publish(write){
  // A fresh/failed read must never erase a previously populated cache.
  if(!this.versionFile||!this.names.size)return;
  const names=[...this.names.values()].filter(valid).slice(-10000);if(!names.length)return;
  this.io.mkdirSync(path.dirname(this.versionFile),{recursive:true});
  write(this.versionFile,{clientBuildSha256:this.clientBuildSha256,names});
 }
 status(actors=[]){return {...this.diagnostics,names:this.names.size,unresolvedActors:actors.map(a=>a.idHash).filter(id=>!this.names.has(id))};}
}
module.exports={IdentityCache,validIdentity:valid};
