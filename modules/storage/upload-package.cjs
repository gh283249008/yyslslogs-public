'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises'),{Transform}=require('node:stream'),{createGzip}=require('node:zlib');
// Each member is independently gzip-compressed. This preserves every field and event,
// while allowing bounded-memory validation and reads without unpacking to disk.
async function createUploadPackage(capture,destination,{recoverTail=false,onProgress=()=>{}}={}){
 const {analysisFile}=await import('../contracts/import-format.mjs');
 capture=path.resolve(capture);destination=path.resolve(destination);
 if(destination===capture||destination.startsWith(capture+path.sep))throw Error('Package must be outside capture');
 if(fs.existsSync(destination))throw Error('Destination already exists');
 const files=[];
 function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory())walk(file);else{const rel=path.relative(capture,file).replaceAll('\\','/');if(analysisFile(rel))files.push({path:rel,file,stat:fs.statSync(file)});}}}
 walk(capture);files.sort((a,b)=>a.path.localeCompare(b.path));
 if(!files.some(f=>f.path==='battles/index.jsonl'))throw Error('Missing battle index');
 await fs.promises.mkdir(path.dirname(destination),{recursive:true});
 const work=await fs.promises.mkdtemp(destination+'.work-'),payload=path.join(work,'payload');
 const manifest={format:'yysls-upload',version:1,files:[]},warnings=[];
 try{
  for(const f of files){
   const hash=crypto.createHash('sha256');let rawSize=0,inputBytes=0;
   const compressed=path.join(work,'member');
   const stages=[fs.createReadStream(f.file),new Transform({transform(c,e,cb){inputBytes+=c.length;cb(null,c);}})];
   if(recoverTail&&f.path.endsWith('.jsonl')){
    let tail=Buffer.alloc(0);
    stages.push(new Transform({transform(c,e,cb){try{const bytes=Buffer.concat([tail,c]);let start=0,end;while((end=bytes.indexOf(10,start))!==-1){const line=bytes.subarray(start,end+1);if(line.length>4*1024**2)throw Error('日志单行过大：'+f.path);if(line.toString('utf8').trim())JSON.parse(line.toString('utf8'));this.push(line);start=end+1;}tail=Buffer.from(bytes.subarray(start));if(tail.length>4*1024**2)throw Error('日志单行过大：'+f.path);cb();}catch(err){cb(Error('记录中段损坏，未生成压缩包：'+f.path+' '+err.message));}},flush(cb){if(tail.length){try{if(tail.toString('utf8').trim())JSON.parse(tail.toString('utf8'));this.push(tail);}catch{warnings.push({file:f.path,discardedIncompleteTailBytes:tail.length});}}cb();}}));
   }
   if(recoverTail&&f.path.endsWith('.json')){if(f.stat.size>64*1024**2)throw Error('JSON文件过大：'+f.path);try{JSON.parse(fs.readFileSync(f.file,'utf8'));}catch{throw Error('元数据不完整：'+f.path);}}
   stages.push(new Transform({transform(c,e,cb){rawSize+=c.length;hash.update(c);cb(null,c);}}),createGzip({level:6}),fs.createWriteStream(compressed,{flags:'wx'}));await pipeline(...stages);
   const after=fs.statSync(f.file);if(inputBytes!==f.stat.size||after.size!==f.stat.size||after.mtimeMs!==f.stat.mtimeMs)throw Error('记录仍在变化，请停止采集后重试。');
   const size=fs.statSync(compressed).size;
   await pipeline(fs.createReadStream(compressed),fs.createWriteStream(payload,{flags:'a'}));await fs.promises.unlink(compressed);
   manifest.files.push({path:f.path,size,rawSize,encoding:'gzip',sha256:hash.digest('hex')});
   onProgress({done:manifest.files.length,total:files.length,file:f.path});
  }
  // Check the whole source set again, not just each individual member.
  for(const f of files){const s=fs.statSync(f.file);if(s.size!==f.stat.size||s.mtimeMs!==f.stat.mtimeMs)throw Error('Capture changed during export');}
  const header=Buffer.from(JSON.stringify(manifest));if(header.length>2*1024**2)throw Error('Manifest too large');
  const prefix=Buffer.alloc(12);prefix.write('YYLOGS1\n');prefix.writeUInt32LE(header.length,8);
  const assembled=path.join(work,'package');await fs.promises.writeFile(assembled,Buffer.concat([prefix,header]));
  await pipeline(fs.createReadStream(payload),fs.createWriteStream(assembled,{flags:'a'}));
  // link is atomic and refuses to overwrite an existing package.
  await fs.promises.link(assembled,destination);
  return {path:destination,files:manifest.files.length,rawBytes:manifest.files.reduce((n,f)=>n+f.rawSize,0),bytes:fs.statSync(destination).size,manifest,warnings};
 }finally{await fs.promises.rm(work,{recursive:true,force:true});}
}
function defaultUploadPath(capture,runtimeRoot){
 const directory=fs.existsSync(path.join(runtimeRoot,'runtime'))?path.dirname(runtimeRoot):runtimeRoot;
 return path.join(directory,path.basename(path.dirname(path.resolve(capture)))+'.yylogs');
}
module.exports={createUploadPackage,defaultUploadPath};
