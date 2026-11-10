'use strict';
const fs=require('node:fs'),path=require('node:path');
const parse=v=>typeof v==='string'&&/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)&&v.split('.').every(n=>Number.isSafeInteger(Number(n)))?v.split('.').map(Number):null;
const compare=(a,b)=>{const x=parse(a),y=parse(b);if(!x||!y)throw Error('Invalid release version');for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0;};
function resolveReleaseVersion({sourceVersion,releaseDirectory,requested,localTest=false}){
 if(!parse(sourceVersion))throw Error('Invalid source package version');
 let latest=sourceVersion;
 if(fs.existsSync(releaseDirectory))for(const item of fs.readdirSync(releaseDirectory,{withFileTypes:true})){
  if(!item.isDirectory()||!item.name.startsWith('YyslsLogs-'))continue;
  const file=path.join(releaseDirectory,item.name,'build-manifest.json');
  if(!fs.existsSync(file))continue;
  let manifest;try{manifest=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error('Unreadable desktop release manifest: '+file);}
  if(manifest.localTest)continue;
  if(!parse(manifest.version))throw Error('Invalid desktop release manifest version: '+file);
  if(compare(manifest.version,latest)>0)latest=manifest.version;
 }
 if(requested&&requested!=='auto'){
  if(!parse(requested))throw Error('Use auto or a semantic version');
  if(!localTest&&compare(requested,latest)<=0)throw Error('New release version must exceed '+latest+'; use auto');
  return requested;
 }
 const next=parse(latest);next[2]++;if(!Number.isSafeInteger(next[2]))throw Error('Version overflow');return next.join('.');
}
module.exports={resolveReleaseVersion,compare};
