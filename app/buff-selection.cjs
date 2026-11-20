'use strict';
const fs=require('node:fs'),path=require('node:path');
const {buffs,slots}=require('../config/overlay-buffs.json');
const names=require('../config/monitor-buff-names.json').names;
const groups=Object.fromEntries(slots.map(slot=>['group:'+slot,Object.values(buffs).find(spec=>spec.slot===slot).name]));
function definitions(selection){
  if(!Array.isArray(selection))throw Error('监控列表无效');
  const seen=new Set(),result=Object.create(null);
  for(const [order,key] of selection.entries()){
    if(typeof key!=='string'||(!Object.hasOwn(groups,key)&&!/^[1-9]\d{0,9}$/.test(key)))throw Error('请输入有效状态 ID');
    if(seen.has(key))throw Error('同一状态只能添加一次');
    seen.add(key);
    if(Object.hasOwn(groups,key)){
      for(const [id,spec] of Object.entries(buffs)){
        if('group:'+spec.slot===key)result[id]={...spec,monitorKey:key,order};
      }
    }
  }
  for(const [order,key] of selection.entries()){
    if(Object.hasOwn(groups,key))continue;
    const spec=buffs[key]||{slot:'custom',name:names[key]||'ID '+key,variant:''};
    result[key]={...spec,monitorKey:key,order};
  }
  return result;
}
function readSelection(data){
  try{
    const listFile=path.join(data,'monitor-list.json');
    const settings=JSON.parse(fs.readFileSync(fs.existsSync(listFile)?listFile:path.join(data,'monitor-buffs.json'),'utf8'));
    let selection;
    if(settings.schemaVersion===1&&Array.isArray(settings.slots)&&settings.slots.length===slots.length){
      selection=settings.slots.map((key,i)=>key==='default'?'group:'+slots[i]:key).filter(key=>key!=='');
    }else if(settings.schemaVersion===2)selection=settings.selection;
    else throw Error('监控列表版本未知');
    definitions(selection);
    return selection;
  }catch(error){
    if(error.code!=='ENOENT')console.warn('监控列表读取失败',error.message);
    return [];
  }
}
function saveSelection(data,selection){
  definitions(selection);
  const file=path.join(data,'monitor-list.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify({schemaVersion:2,selection}));
  fs.renameSync(file+'.tmp',file);
}
module.exports={definitions,readSelection,saveSelection,names,groups};
