'use strict';
// Stable compatibility entry; implementation belongs to the domain/module layer.
module.exports=require('../modules/configuration/contract.cjs');
if(require.main===module)console.log(JSON.stringify({passed:true,configs:module.exports.validateAll(),products:['desktop','analyzer'].map(p=>({product:p,...module.exports.distribution(p)}))}));
