import fs from 'node:fs';
import path from 'node:path';
// Keep both normal and delay-import DLL dependencies, not the entire GUI suite.
export function peImports(file){
 const b=fs.readFileSync(file),pe=b.readUInt32LE(0x3c);
 if(b.toString('ascii',pe,pe+4)!=='PE\0\0')throw Error('Not PE: '+file);
 const count=b.readUInt16LE(pe+6),optional=pe+24,size=b.readUInt16LE(pe+20);
 const is64=b.readUInt16LE(optional)===0x20b,dd=optional+(is64?112:96);
 const imageBase=is64?Number(b.readBigUInt64LE(optional+24)):b.readUInt32LE(optional+28);
 const sections=Array.from({length:count},(_,i)=>{
  const s=optional+size+40*i;return {va:b.readUInt32LE(s+12),size:Math.max(b.readUInt32LE(s+8),b.readUInt32LE(s+16)),raw:b.readUInt32LE(s+20)};
 });
 const offset=rva=>{const s=sections.find(s=>rva>=s.va&&rva<s.va+s.size);if(!s)throw Error('Unmapped PE RVA in '+file);return s.raw+rva-s.va;};
 const name=rva=>{const i=offset(rva),end=b.indexOf(0,i);if(end<0)throw Error('Unterminated PE import');return b.toString('ascii',i,end);};
 const imports=[];
 for(const [index,stride] of [[1,20],[13,32]]){
  const rva=b.readUInt32LE(dd+index*8);if(!rva)continue;
  for(let at=offset(rva),n=0;n<4096;at+=stride,n++){
   if(b.subarray(at,at+stride).every(x=>x===0))break;
   const value=b.readUInt32LE(at+(index===1?12:4));
   if(value)imports.push(name(index===13&&!(b.readUInt32LE(at)&1)?value-imageBase:value));
  }
 }
 return [...new Set(imports)];
}
export function nativeClosure(dir,entries){
 const local=new Map(fs.readdirSync(dir).map(n=>[n.toLowerCase(),n]));
 const files=new Set(),external=new Set();
 const visit=name=>{
  const real=local.get(name.toLowerCase());if(!real){external.add(name);return;}
  if(files.has(real))return;files.add(real);
  for(const dep of peImports(path.join(dir,real)))visit(dep);
 };
 entries.forEach(visit);
 return {files:[...files].sort(),external:[...external].sort()};
}
export function sourceClosure(root,entries){
 const found=new Set();
 const visit=file=>{
  file=path.resolve(root,file);
  if(!file.startsWith(root+path.sep))throw Error('Dependency leaves workspace: '+file);
  const rel=path.relative(root,file);if(found.has(rel))return;
  if(!fs.existsSync(file))throw Error('Missing runtime source: '+rel);
  found.add(rel);
  if(!/\.(cjs|mjs|js)$/.test(file))return;
  const source=fs.readFileSync(file,'utf8');
  const patterns=[/require\(\s*['"](\.[^'"]+)['"]\s*\)/g,/(?:import|export)\s+(?:[^;'"\n]+?\s+from\s*)?['"](\.[^'"]+)['"]/g,/import\(\s*['"](\.[^'"]+)['"]\s*\)/g];
  for(const pattern of patterns)for(const m of source.matchAll(pattern))visit(path.resolve(path.dirname(file),m[1]));
 };
 entries.forEach(visit);return [...found].sort();
}
