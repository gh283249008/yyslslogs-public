'use strict';
// Stable compatibility entry; implementation belongs to the domain/module layer.
module.exports=require('../modules/domain/encounter-catalog.cjs');
const fs=require('fs'),path=require('path');
const {resolveEncounterIdentity}=module.exports;
if(require.main===module){const assert=require('assert'),r=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../evidence/p1/encounter-retest/recovered-encounter-context.json'),'utf8')),c=r.encounter.identity;
 assert.equal(resolveEncounterIdentity(c,77).bossName,'寄棺主');
 assert.equal(resolveEncounterIdentity(c,78),null);
 assert.equal(resolveEncounterIdentity({...c,dungeonSid:157},77),null);
 assert.equal(resolveEncounterIdentity({...c,npcs:c.npcs.map(x=>({...x,customValueId:0}))},77),null);
 assert.equal(resolveEncounterIdentity({...c,preset:10013},77),null);
 assert.equal(resolveEncounterIdentity({...c,npcs:[...c.npcs,...c.npcs]},77),null);
 console.log(JSON.stringify({passed:true,cases:6,nameBinding:'full scoped tuple, user-labeled sample'}));
}
