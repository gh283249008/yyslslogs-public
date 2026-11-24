'use strict';
const fs=require('node:fs'),path=require('node:path');
const {buffs,slots}=require('../config/overlay-buffs.json');
const names=require('../config/monitor-buff-names.json').names;
const groups=Object.fromEntries(slots.map(slot=>['group:'+slot,Object.values(buffs).find(spec=>spec.slot===slot).name]));
function definitions(selection){
  if(!Array.isArray(selection))throw Error('监控列表无效');
  const seen=new Set(),result=Object.create(null);
  const entries=selection.map(item=>typeof item==='string'?{key:item,target:'self'}:item);
  const put=(id,spec)=>{
    const monitors=(result[id]?.monitors||[]).filter(row=>row.target!==spec.target);
    monitors.push(spec);result[id]={...spec,monitors};
  };
  for(const [order,item] of entries.entries()){
    const {key,target}=item||{};
    if(!['self','boss'].includes(target))throw Error('请选择自身 Buff 或 Boss Debuff');
    if(typeof key!=='string'||(!Object.hasOwn(groups,key)&&!/^[1-9]\d{0,9}$/.test(key)))throw Error('请输入有效状态 ID');
    const monitorKey=target==='boss'?'boss:'+key:key;
    if(seen.has(monitorKey))throw Error('同一对象的状态只能添加一次');
    seen.add(monitorKey);
    if(Object.hasOwn(groups,key)){
      for(const [id,spec] of Object.entries(buffs)){
        if('group:'+spec.slot===key)put(id,{...spec,monitorKey,order,target});
      }
    }
  }
  for(const [order,{key,target}] of entries.entries()){
    if(Object.hasOwn(groups,key))continue;
    const spec=buffs[key]||{slot:'custom',name:names[key]||'ID '+key,variant:''};
    put(key,{...spec,monitorKey:target==='boss'?'boss:'+key:key,order,target});
  }
  return result;
}
function readSelection(data){
  try{
    const scopedFile=path.join(data,'monitor-targets.json'),listFile=path.join(data,'monitor-list.json');
    const settings=JSON.parse(fs.readFileSync(fs.existsSync(scopedFile)?scopedFile:fs.existsSync(listFile)?listFile:path.join(data,'monitor-buffs.json'),'utf8'));
    let selection;
    if(settings.schemaVersion===1&&Array.isArray(settings.slots)&&settings.slots.length===slots.length){
      selection=settings.slots.map((key,i)=>key==='default'?'group:'+slots[i]:key).filter(key=>key!=='');
    }else if([2,3].includes(settings.schemaVersion))selection=settings.selection;
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
  // Keep the schema 1/2 file readable by a rolled-back 0.4.3 installation.
  const scoped=selection.some(item=>typeof item==='object')||fs.existsSync(path.join(data,'monitor-targets.json'));
  const file=path.join(data,scoped?'monitor-targets.json':'monitor-list.json');
  fs.writeFileSync(file+'.tmp',JSON.stringify({schemaVersion:scoped?3:2,selection}));
  fs.renameSync(file+'.tmp',file);
}
module.exports={definitions,readSelection,saveSelection,names,groups};
