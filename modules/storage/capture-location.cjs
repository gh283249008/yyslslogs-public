'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const file = data => path.join(data,'capture-location.json');
function locations(data) {
  try {
    const value=JSON.parse(fs.readFileSync(file(data),'utf8'));
    if(value.schemaVersion!==1 || !Array.isArray(value.roots) || !value.roots.length ||
       !value.roots.every(root=>typeof root==='string' && path.isAbsolute(root))) throw Error('记录目录设置无效');
    return value.roots;
  } catch(error) {
    if(error.code==='ENOENT')return [path.join(data,'sessions')];
    throw error;
  }
}
function selectLocation(data,folder) {
  if(!path.isAbsolute(folder)) throw Error('请选择完整目录');
  const probe=path.join(folder,'.yylogs-'+crypto.randomUUID());
  fs.closeSync(fs.openSync(probe,'wx'));
  fs.unlinkSync(probe);
  const selected=path.resolve(folder);
  let previous;
  try{previous=locations(data);}catch(error){
    if(!(error instanceof SyntaxError) && error.message!=='记录目录设置无效')throw error;
    fs.copyFileSync(file(data), file(data)+'.invalid-'+crypto.randomUUID(),fs.constants.COPYFILE_EXCL);
    previous=[path.join(data,'sessions')];
  }
  const roots=[selected,...previous.filter(item=>path.resolve(item).toLowerCase()!==selected.toLowerCase())];
  fs.mkdirSync(data,{recursive:true});
  const temp=file(data)+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify({schemaVersion:1,roots}));fs.renameSync(temp,file(data));}
  finally{fs.rmSync(temp,{force:true});}
  return selected;
}
module.exports={locations,selectLocation};
