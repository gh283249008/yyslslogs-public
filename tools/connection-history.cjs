'use strict';
const fs=require('node:fs'),path=require('node:path');
const fields=['pid','processStartUtc','processPath','clientBuildSha256','transport','flow','captureInterface','bindingUdpEndpoint','kcp'];
function routingHint(config){return {schemaVersion:1,scope:'routing-only; always recapture and revalidate cipher state',...Object.fromEntries(fields.filter(k=>config[k]!==undefined).map(k=>[k,config[k]]))};}
function read(file){if(fs.statSync(file).size>1024*1024)throw Error('Connection metadata exceeds limit');return JSON.parse(fs.readFileSync(file,'utf8'));}
function loadRoutingHint(data){
 try{const hint=read(path.join(data,'validated-connection.json'));if(hint.schemaVersion===1)return routingHint(hint);}catch{}
 // Upgrade from an earlier client: use its last successfully initialized
 // session only as a ranking hint. Never restore that session's cipher state.
 try{
  const service=read(path.join(data,'service.json'));
  if(typeof service.latestPath!=='string')return null;
  const latest=path.resolve(service.latestPath),sessions=path.resolve(data,'sessions')+path.sep;
  if(!latest.toLowerCase().startsWith(sessions.toLowerCase())||path.basename(latest)!=='latest.json'||path.basename(path.dirname(latest))!=='capture')return null;
  const config=read(path.join(path.dirname(latest),'../session.private.json'));
  if(config.cipherStateKind!=='validated-midstream'||!/^[a-f0-9]{64}$/.test(config.cipherAnchorReportSha256||''))return null;
  return routingHint(config);
 }catch{return null;}
}
module.exports={routingHint,loadRoutingHint};
