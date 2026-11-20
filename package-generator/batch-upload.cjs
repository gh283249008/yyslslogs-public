'use strict';
class UploadBatch {
  constructor(client) { this.client=client; this.active=false; this.cancelled=false; }
  stop() {
    this.cancelled=true;
    if (this.client.active && !this.client.committing) this.client.stop();
  }
  async run(files,allowed,onProgress,onResult) {
    if(this.active || this.client.active)throw Error('已有上传任务');
    if(!this.client.user)throw Error('请先登录');
    if(!Array.isArray(files)||!files.length || !files.every(p=>allowed.has(p)))throw Error('请先生成或选择上传文件');
    this.active=true;this.cancelled=false;
    const results=[];
    try {
      for(const file of new Set(files)) {
        let result={file,status:'waiting'};
        if(!this.cancelled){
          try {
            const receipt=await this.client.upload(file,p=>onProgress({...p,file}));
            result={file,status:'complete',id:receipt.id};
          }catch(error){
            result={file,status:'failed',error:error.message};
            if(this.cancelled || [401,403,429].includes(error.status)) this.cancelled=true;
          }
        }
        results.push(result);onResult(result);
      }
      return results;
    }finally{this.active=false;}
  }
}
module.exports={UploadBatch};
