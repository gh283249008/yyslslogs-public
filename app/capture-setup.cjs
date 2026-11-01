'use strict';
const fs=require('node:fs'),path=require('node:path');
const {runtimePaths,run}=require('../tools/p2-runtime.cjs');
const officialPage='https://npcap.com/#download';
function installerUrl(html){
 const match=html.match(/href=["']((?:https:\/\/npcap\.com\/|\/)?dist\/npcap-[\d.]+\.exe)["']/i);
 if(!match)throw Error('未找到官方驱动下载，请从 Npcap 官网安装。');
 return new URL(match[1],'https://npcap.com/').href;
}
async function downloadInstaller(dataRoot,fetchUrl=fetch){
 const page=await fetchUrl('https://npcap.com/',{signal:AbortSignal.timeout(30000)});
 if(!page.ok)throw Error('无法连接 Npcap 官网');
 const url=installerUrl(await page.text());
 const res=await fetchUrl(url,{redirect:'error',signal:AbortSignal.timeout(120000)});
 if(!res.ok||(res.url&&new URL(res.url).hostname!=='npcap.com'))throw Error('驱动下载失败或来源不符');
 const bytes=Buffer.from(await res.arrayBuffer());
 if(bytes.length<100000||bytes.length>32*1024*1024)throw Error('驱动安装包大小异常');
 const dir=path.join(dataRoot,'downloads');fs.mkdirSync(dir,{recursive:true});
 const file=path.join(dir,path.basename(new URL(url).pathname));fs.writeFileSync(file,bytes);
 // Verify Windows trust and expected publisher before opening downloaded code.
 const signature=JSON.parse(await run(runtimePaths().powershell,['-NoProfile','-NonInteractive','-Command',
  `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g,"''")}'; @{status=$s.Status.ToString();subject=$s.SignerCertificate.Subject}|ConvertTo-Json -Compress`]));
 if(signature.status!=='Valid'||!/Insecure\.Com|Nmap Software/i.test(signature.subject||''))throw Error('驱动的数字签名未通过验证，请从 Npcap 官网安装。');
 return file;
}
module.exports={downloadInstaller,installerUrl,officialPage};
