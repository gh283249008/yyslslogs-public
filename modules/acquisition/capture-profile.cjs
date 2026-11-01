'use strict';
// Passive capture tuning only: no adapter/route/MTU or game socket changes.
const fields=['frame.number','frame.time_epoch','frame.interface_id','ip.src','tcp.srcport','ip.dst','tcp.dstport','tcp.seq_raw','tcp.len','tcp.flags.syn','tcp.flags.fin','tcp.flags.reset','tcp.payload'];
// Append only: old packet/payload positions remain stable. Raw options retain
// every SACK block, timestamp and window scale without online TCP analysis.
const diagnosticFields=[...fields,'tcp.ack_raw','tcp.flags.ack','tcp.window_size_value','tcp.options','ip.id','ip.ttl','frame.len','tcp.hdr_len'];
const diagnosticFieldArgs=['-T','fields','-E','separator=/t','-E','occurrence=f',...diagnosticFields.flatMap(f=>['-e',f])];
const isLiveFieldCount=n=>n===fields.length||n===diagnosticFields.length;
const decodeArgs=['-n','--only-protocols','eth,ethertype,vlan,arp,raw,null,sll,ppp,pppoes,pppoed,ip,ipv6,tcp,data','-o','tcp.desegment_tcp_streams:FALSE','-o','tcp.analyze_sequence_numbers:FALSE'];
const fieldArgs=['-T','fields','-E','separator=/t','-E','occurrence=f',...fields.flatMap(f=>['-e',f])];
function captureArgs(interfaces,filter,duration,diagnostics=false){return ['-l',...decodeArgs,'-p','-B','16',...interfaces.flatMap(i=>['-i',i]),'-f',filter,...(duration?['-a','duration:'+duration]:[]),'-s','0',...(diagnostics?diagnosticFieldArgs:fieldArgs)];}
module.exports={fields,diagnosticFields,diagnosticFieldArgs,isLiveFieldCount,decodeArgs,fieldArgs,captureArgs};
