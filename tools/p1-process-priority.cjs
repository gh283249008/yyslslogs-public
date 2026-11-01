'use strict';
const os=require('os');
function setWorkerPriority(pid=0,role='decoder'){
 const priority=role==='capture'?os.constants.priority.PRIORITY_NORMAL:os.constants.priority.PRIORITY_BELOW_NORMAL;
 try{os.setPriority(pid,priority);return {role,applied:true,priority:os.getPriority(pid)};}
 catch(e){return {role,applied:false,error:e.code||e.message};}
}
module.exports={setWorkerPriority};
