'use strict';
// Select before loading collector lifecycle: packaging never starts capture.
if(process.argv.includes('--generate-yylogs') || ['生成 yylogs.exe','yylogs上传器.exe'].includes(require('node:path').basename(process.execPath))) require('../package-generator/main.cjs');
else require('./main.cjs');
