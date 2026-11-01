'use strict';
const {createUploadPackage}=require('../modules/storage/upload-package.cjs');
if(require.main===module){const [capture,destination]=process.argv.slice(2);if(!capture||!destination)throw Error('Usage: export-upload-package CAPTURE OUTPUT.yylogs');createUploadPackage(capture,destination).then(({manifest,...summary})=>console.log(JSON.stringify(summary))).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={createUploadPackage};
