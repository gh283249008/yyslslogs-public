const fs=require('node:fs'),path=require('node:path');
const {findBattleCapture,canRecover}=require('../modules/storage/recover-statistics.cjs');
function scanSessions(root){
 let entries=[];try{entries=fs.readdirSync(root,{withFileTypes:true});}catch{return [];}
 return entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()).flatMap(e=>{
  const original=path.join(root,e.name,'capture'), indexed=findBattleCapture(original);
  const statisticsOnly=indexed!==original;
  if(!indexed&&!canRecover(original))return [];
  const capture=indexed||original;
  const stamp=e.name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/),date=stamp?new Date(stamp[1]+'T'+stamp[2]+':'+stamp[3]+':'+stamp[4]+'.'+stamp[5]+'Z'):fs.statSync(capture).mtime;
  const day=[date.getFullYear(),String(date.getMonth()+1).padStart(2,'0'),String(date.getDate()).padStart(2,'0')].join('-');
  return [{id:e.name,date:day,time:date.toLocaleTimeString('zh-CN',{hour12:false}),capture,statisticsOnly,needsRecovery:!indexed,interrupted:!fs.existsSync(path.join(original,'completion.json'))}];
 }).sort((a,b)=>b.id.localeCompare(a.id));
}
module.exports={scanSessions};
