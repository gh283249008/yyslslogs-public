// Passive same-session P1 pipeline. Never opens game memory or sends game traffic.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process'),readline=require('readline');
const {WorkerBatchWriter,workerResponses}=require('../modules/parsing/worker-transport.cjs');
const {RawSpool,limits:ioLimits}=require('../modules/storage/raw-spool.cjs');
const {runtimePaths,powershellScriptArgs}=require('./p2-runtime.cjs');
const {OrderedCipher,BlockStream,statisticFromBytes}=require('./p1-live-core.cjs');
const {damageEventsFromAreaSync}=require('./p1-rdps-damage-batch.cjs');
const {hpTextEvidenceFromAreaSync}=require('./p1-hp-text-evidence.cjs');
const {connectionBoundary}=require('./p1-capture-flags.cjs');
const {namesFromMatchWrapper}=require('./p1-identity-names.cjs');
const {IdentityCache,validIdentity}=require('./p1-identity-cache.cjs');
const {RdpsObservation}=require('./p1-rdps-observation.cjs');
const {SimpleRdpsStream}=require('./p1-simple-rdps.cjs');
const {decodeStatisticPayload,settlementFromObject,SettlementAuditBuffer}=require('./p1-settlement-details.cjs');
const args=process.argv.slice(2),opts={};for(let i=0;i<args.length;i+=2){if(!args[i].startsWith('--')||args[i+1]===undefined)throw Error('Expected --option value');opts[args[i].slice(2)]=args[i+1];}
if(!opts.config||!opts.out)throw Error('Usage: node p1-live-pipeline.cjs --config SESSION_JSON --out NEW_DIR [--replay PACKETS_TSV] [--duration 600]');
const configPath=path.resolve(opts.config),c=JSON.parse(fs.readFileSync(configPath)),out=path.resolve(opts.out),mode=opts.replay?'replay':'live';
const {setWorkerPriority}=require('./p1-process-priority.cjs');
const workerPriorities={pipeline:mode==='live'?setWorkerPriority():{applied:false,reason:'offline replay'}};
if(fs.existsSync(out))throw Error('Use a new output directory');fs.mkdirSync(out,{recursive:true});
const ledger=new (require('./p1-ledger-writer.cjs').LedgerWriter)();
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const state=require('./p1-cipher-anchor.cjs').loadCipherAnchor(c);
const sessionId=hash(Buffer.from(JSON.stringify([c.pid,c.processStartUtc,c.flow,c.serverEncryptedOrigin,c.initialStateSha256]))).slice(0,24);
const gameData=require('../modules/domain/game-data-version.cjs').normalizeGameData(c.gameData);
const source=require('../modules/domain/game-data-version.cjs').createSessionSource(mode,sessionId,gameData);
const identities=new Map();
const identityCache=new IdentityCache({file:c.identityCacheFile,clientBuildSha256:c.clientBuildSha256,names:identities});
identityCache.recover({force:true});

const rdpsObservation=new RdpsObservation({mode,sessionId});
const simpleRdps=new SimpleRdpsStream(source);
const {RecordedDamageTracker}=require('../modules/domain/recorded-damage.cjs');
const recordedPolicy=require('./p1-simple-rdps.cjs').POLICY.recordedDamage;let recorded=new RecordedDamageTracker(recordedPolicy);
function rdpsSnapshot(){return recorded.apply(simpleRdps,simpleRdps.snapshot());}
const battleArchive=new (require('./p1-battle-archive.cjs').BattleArchive)(out,source);
function estimateObserve(method,event,job){try{const row={...event,observedAt:job.observedAt,transportRecordOrdinal:job.recordOrdinal},prior=simpleRdps.current,count=prior?.hits.length??0;if(method==='observeBuff')recorded.observeBuff(row);const result=simpleRdps[method](row);if(method==='observeDamage')recorded.observeDamage(row,simpleRdps,simpleRdps.current===prior&&(simpleRdps.current?.hits.length??0)>count);if(method==='observeDamage'&&result){const {hitInput,contextIssues,schoolKey,...record}=result;ledger.append(path.join(out,'attribution-hit-estimates.jsonl'),JSON.stringify({...record,source:{mode,sessionId},model:require('./p1-simple-rdps.cjs').POLICY.id,policySha256:require('./p1-simple-rdps.cjs').policySha256})+'\n');}if(method==='observeStatistic'){const estimate=rdpsSnapshot();if(estimate.status==='estimated')ledger.append(path.join(out,'attribution-estimates.jsonl'),JSON.stringify(estimate)+'\n');return estimate;}}catch(e){simpleRdps.error=e.message;ledger.append(path.join(out,'attribution-errors.jsonl'),JSON.stringify({method,recordOrdinal:job.recordOrdinal,error:e.message})+'\n');}}
let encounterClock=null;
const settlementAudit=new SettlementAuditBuffer();
let rejectedEventCount=0,detailCount=0,auxiliaryEventCount=0,auxiliaryRejectedCount=0,attributeEventCount=0,attributeCoverage=null;
let buffEventCount=0,buffCoverage={schemaVersion:1,events:0,complete:false,attributionReady:false,timingValidated:false,sourceOwnershipValidated:false,snapshotValidated:false,privateBuffCoverageComplete:false,lifecycleOpcodesValidated:false,aoiClosureValidated:false,reason:'Waiting for validated buff property observations'};
if(opts['identity-seed']){const seed=JSON.parse(fs.readFileSync(opts['identity-seed'],'utf8').replace(/^\uFEFF/,''));if(seed.source?.sessionId!==sessionId)throw Error('Identity seed session mismatch');for(const row of seed.names||[])if(validIdentity(row))identities.set(row.idHash,row);}
let latest={schemaVersion:1,source,observedAt:null,health:{status:'starting',gap:false,stale:true,session:mode==='live'?'pending':'recorded',reason:'Waiting for validated session and server statistics'},npcNo:null,timeCostSeconds:0,actors:[],sequence:0},lastStatWall=0,lastBindWall=0,lastBind=null,stopped=false,failed=false,capture=null,watcher=null,tick=null,startTimer=null,frames=0,statsCount=0,eventCount=0,protoCount=0,pending=new Map(),nextJob=0;
const manifest={schemaVersion:1,...(gameData!==undefined?{gameData}:{}),startedAt:new Date().toISOString(),mode,sessionId,configPath,configSha256:hash(fs.readFileSync(configPath)),pid:c.pid,processStartUtc:c.processStartUtc,flow:c.flow,interface:c.captureInterface,serverEncryptedOrigin:c.serverEncryptedOrigin,initialStateSha256:c.initialStateSha256,code:['../modules/acquisition/kcp-stream.cjs','../modules/acquisition/connection-candidates.cjs','../modules/storage/raw-spool.cjs','../modules/storage/ledger-writer.cjs','../modules/acquisition/capture-profile.cjs','../modules/acquisition/capture-flags.cjs','../config/runtime-io.json','p1-capture-profile.cjs','p1-network-diagnostics.cjs','p1-process-priority.cjs','p1-battle-archive.cjs','p1_target_resource_stream.py','p1-capture-flags.cjs','p1_attribute_stream.py','p1-hp-text-evidence.cjs','p1-settlement-details.cjs','p1-snapshot-publisher.cjs','p1-simple-rdps.cjs','p1-gap-rdps-reconstruction.cjs','p1-version-baseline.cjs','p1-physical-resistance.cjs','p1-rdps-observation.cjs','p1-rdps-runtime.cjs','p1_buff_stream.py','p1_encounter_schema.py','p1_encounter_identity.py','p1-identity-names.cjs','p1-identity-cache.cjs','p1-live-core.cjs','p1-rdps-damage-batch.cjs','p1-live-pipeline.cjs','p1-live-proto.py','../scripts/windows/p1-live-session-watch.ps1'].map(n=>({file:n,sha256:hash(fs.readFileSync(path.join(__dirname,n)))})),limits:['Requires the recorded session-specific cipher state and sequence origin; no automatic re-login recovery.','Cumulative statistics and single/batch Behit notifications are decoded. Notifications include damage, healing and incoming damage; complete hostile events and buff attribution remain unverified.','Read-only packet capture. No game process memory access, modification or injected code.','Single configured capture interface. Startup may discard an incomplete initial frame after strict multiframe/schema validation.','Session bindings are polled once per second; SYN/FIN/RST end the bound connection, keeping data already captured.','Capture loss is bridged by exact RC4 advance and block resync; messages inside a gap are absent, logged in transport-gaps.jsonl, and stateful buff/attribute views restart after it.']};
manifest.transportFormat=c.transport==='kcp'?{version:3,transport:'kcp',fields:require('../modules/acquisition/capture-profile.cjs').udpFields,envelope:c.kcp.envelope,sequence:'KCP segments reassembled to cipher byte offsets; unknown gaps are not skipped',telemetryIntervalMs:5000}:{version:2,fields:require('./p1-capture-profile.cjs').diagnosticFields,appliesTo:mode==='live'?'this live capture':'replay input retains its original 8/13/21-field format',tcpAnalysis:'offline only',telemetryIntervalMs:5000};
if(c.transport==='kcp')manifest.limits=[...manifest.limits.filter(s=>!s.startsWith('Session bindings')&&!s.startsWith('Capture loss')),'PID, start time, image path and selected UDP endpoint are verified once per second.','KCP conversation and relay destination are pinned; unresolved segment gaps stop decoding. Missing ciphertext lengths are never guessed.'];
manifest.buffSchemaEvidence=['evidence/p1/encounter-retest/index-names.json','evidence/p1/rdps-rules/supplemental-index-names.json','evidence/p0/runtime-rpc-analysis/common.proto.descriptor.bin','evidence/p0/runtime-rpc-analysis/client_gate.proto.descriptor.bin','evidence/p1/event-validation/buff-item/LT21-3478.luac.tsv','evidence/p1/rdps-rules/resources/LT41-3348.luac.tsv'].map(file=>({file,sha256:hash(fs.readFileSync(path.resolve(__dirname,'..',file)))}));
manifest.cipherAnchor={kind:c.cipherStateKind||'login-initial',report:c.cipherAnchorReport||null,reportSha256:c.cipherAnchorReportSha256||null,loaderSha256:hash(fs.readFileSync(path.join(__dirname,'p1-cipher-anchor.cjs')))};
if(mode==='replay'){manifest.replayFile=path.resolve(opts.replay);manifest.replaySha256=hash(fs.readFileSync(opts.replay));}
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
const networkDiagnostics=mode==='live'?new (require('./p1-network-diagnostics.cjs').NetworkDiagnostics)(out,{mode,sessionId}):null;
const snapshotPublisher=new (require('./p1-snapshot-publisher.cjs').SnapshotPublisher)();
function atomic(file,data){snapshotPublisher.write(file,data);}
function publishIdentities(){const names=[...identities.values()].slice(-10000);atomic(path.join(out,'identities.json'),{source:{sessionId,mode},clientBuildSha256:c.clientBuildSha256,names});if(mode==='live')try{identityCache.publish(atomic);}catch(e){identityCache.diagnostics.writeError={code:e.code||'write-error',message:e.message};}}
function publishBuffCoverage(estimate=rdpsSnapshot()){atomic(path.join(out,'buff-coverage.json'),{...buffCoverage,source:{sessionId,mode},publishedAt:new Date().toISOString(),sessionHealth:latest.health,attributionReady:false,complete:false});atomic(path.join(out,'attribution-validation.json'),rdpsObservation.snapshot(latest.health));try{atomic(path.join(out,'attribution-estimate.json'),estimate);}catch(e){simpleRdps.error=e.message;}}
publishIdentities();
publishBuffCoverage();
if(opts['restore-statistics']){
 const file=path.resolve(opts['restore-statistics']),bytes=fs.readFileSync(file),rows=bytes.toString('utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
 for(const row of rows){if(row.schemaVersion!==1||row.source?.sessionId!==sessionId||!Array.isArray(row.actors)||!Number.isFinite(Date.parse(row.observedAt))||!Number.isFinite(row.timeCostSeconds)||row.timeCostSeconds<0)throw Error('Restored statistic session/schema mismatch');for(const actor of row.actors){if(!/^[a-f0-9]{16}$/.test(actor.idHash)||['damage','heal','absorbDmg'].some(k=>!Number.isFinite(actor[k])||actor[k]<0))throw Error('Invalid restored actor');}}
 const restored=rows.map(row=>({...row,source:{...row.source,mode,restoredFromCapture:true},actors:row.actors.map(a=>({...a,...(identities.get(a.idHash)||{})}))}));
 if(restored.length){fs.writeFileSync(path.join(out,'statistics.jsonl'),restored.map(JSON.stringify).join('\n')+'\n');statsCount=restored.length;latest={...restored.at(-1),health:{status:'starting',gap:false,stale:true,session:mode==='live'?'pending':'recorded',reason:'Restored prior result; waiting for capture session validation'}};}
 manifest.restoredStatistics={file,sha256:hash(bytes),count:restored.length};fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2));
}
function publish(estimate=rdpsSnapshot()){if(identityCache.recover({needed:latest.actors.map(a=>a.idHash)}))publishIdentities();latest.actors=latest.actors.map(a=>({...a,...(identities.get(a.idHash)||{})}));latest.identityCoverage=identityCache.status(latest.actors);atomic(path.join(out,'identity-status.json'),latest.identityCoverage);publishBuffCoverage(estimate);latest.attributionEstimate=estimate;try{battleArchive.update(latest,estimate,[...identities.values()]);}catch(e){ledger.append(path.join(out,"archive-errors.jsonl"),JSON.stringify({at:new Date().toISOString(),error:e.message})+"\n");}if(attributeCoverage)atomic(path.join(out,'attribute-coverage.json'),{...attributeCoverage,source:{mode,sessionId},publishedAt:new Date().toISOString(),events:attributeEventCount,sessionHealth:latest.health,streamEnded:stopped});latest.buffCoverage={file:'buff-coverage.json',events:buffEventCount,attributionReady:false,complete:false};latest.coverage={complete:false,knownAcquisitionGaps:c.knownAcquisitionGaps||[],rejectedEventCount,startupDiscardedPrefixBytes:blocks.skipped,transportContinuity:continuity(),note:'Current capture continuity does not establish whole-encounter coverage'};latest.publication=snapshotPublisher.status();latest.publishedAt=new Date().toISOString();atomic(path.join(out,'latest.json'),latest);atomic(path.join(out,'health.json'),{at:latest.publishedAt,...latest.health,packets:frames,decodedBlocks:protoCount,statistics:statsCount,restoredStatistics:manifest.restoredStatistics?.count||0,newStatistics:statsCount-(manifest.restoredStatistics?.count||0),settlementDetails:detailCount,attributeEvents:attributeEventCount,auxiliaryNumberTips:auxiliaryEventCount,auxiliaryRejectedCount,damageEvents:eventCount,buffEvents:buffEventCount,rejectedEventCount,workerPriorities,pendingProto:pending.size,rawBacklogBytes:(rawSpool?.backlogBytes||0),aligned:blocks.aligned,skippedPrefixBytes:blocks.skipped,duplicateBytes:ordered.overlaps,transportContinuity:continuity(),lastFrameAt:lastFrameWall?new Date(lastFrameWall).toISOString():null,lastDecodedAt:lastDecodedWall?new Date(lastDecodedWall).toISOString():null,pid:process.pid,publication:snapshotPublisher.status()});}
let verifiedSchema='';if(c.decoderEnvelope){const p=require('./decoder-profiles.cjs').verify(c.decoderEnvelope,c.clientBuildSha256),file=path.join(out,'verified-schema.json');fs.writeFileSync(file,p.dictionary,{flag:'wx'});verifiedSchema=JSON.stringify({clientBuildSha256:c.clientBuildSha256,id:p.schema.id,count:p.schema.count,file,sha256:p.schema.sha256});}
const py=spawn(c.python,['-B','-X','utf8',path.join(__dirname,'p1-live-proto.py')],{cwd:path.resolve(__dirname,'..'),env:{...process.env,YYSLS_VERIFIED_SCHEMA:verifiedSchema,YYSLS_CLIENT_BUILD_SHA256:c.clientBuildSha256||'',YYSLS_GAME_DATA_SHA256:gameData===undefined?'':gameData.manifestSha256||'unknown'},windowsHide:true,stdio:['pipe','pipe','pipe']});py.stderr.on('data',b=>ledger.append(path.join(out,'proto.stderr.txt'),b));
py.once('spawn',()=>{if(mode==='live')workerPriorities.schema=setWorkerPriority(py.pid);});
let rawSpool=null,pumpTimer=null,lastFrameWall=0,lastDecodedWall=0,lastTickWall=0,loopLagSkips=0;
let lastDecodedCaptureAt=null,ingressBytes=0,ingressChunks=0,lastIngressAt=null,rawWriteMaxMs=0,loopLagMaxMs=0,lastNetworkSample=performance.now();
function pumpRaw(){if(stopped||failed||!rawSpool)return;try{rawSpool.pump(packet,()=>pending.size<=ioLimits.maxPendingProto);}catch(e){fail(e.message);}}
// Windows Python emits CRLF. A busy decoder can receive the two characters
// more than 100 ms apart; they still delimit one JSON record, never a blank job.
const workerWriter=new WorkerBatchWriter(py.stdin,{onError:e=>fail(e.message)});
let readyResolve;const ready=new Promise(r=>readyResolve=r);
readline.createInterface({input:py.stdout,crlfDelay:Infinity}).on('line',line=>{if(stopped)return;try{for(const message of workerResponses(line))onWorkerMessage(message);}catch(e){fail(e.message);}});
function onWorkerMessage(m){if(stopped)return;try{if(m.ready){workerWriter.batching=m.workerProtocol?.schemaVersion===1;manifest.workerProtocol=m.workerProtocol||{schemaVersion:0};manifest.propertySchemaProfile=m.schemaProfile;atomic(path.join(out,'manifest.json'),manifest);readyResolve();return;}const job=pending.get(m.id);if(!job)throw Error('Unexpected schema worker response');pending.delete(m.id);if(!m.ok)throw Error('Protobuf validation failed: '+m.error);
 if(m.control==='transport_gap'){buffCoverage=m.buffCoverage;attributeCoverage=m.attributeCoverage;simpleRdps.markGap(job.gap);recorded=new RecordedDamageTracker(recordedPolicy);settlementAudit.markGap(job.recordOrdinal);encounterClock=encounterClock&&{...encounterClock,transportGaps:(encounterClock.transportGaps||0)+1};latest.health={...latest.health,lastGap:{index:job.gap.index,bytes:job.gap.bytes,resumeObservedAt:job.gap.resumeObservedAt}};publish();return;}
 protoCount++;lastDecodedWall=Date.now();lastDecodedCaptureAt=job.observedAt;
 if(m.attributeCoverage)attributeCoverage=m.attributeCoverage;
 for(const event of m.attributeEvents||[]){attributeEventCount++;estimateObserve('observeAttribute',event,job);ledger.append(path.join(out,'attribute-events.jsonl'),JSON.stringify({...event,schemaVersion:1,source:{mode,sessionId},observedAt:job.observedAt,transportRecordOrdinal:job.recordOrdinal,sequence:attributeEventCount})+'\n');}
 for(const event of m.buffEvents||[]){buffEventCount++;rdpsObservation.observeBuff(event);estimateObserve('observeBuff',event,job);ledger.append(path.join(out,'buff-events.jsonl'),JSON.stringify({...event,schemaVersion:1,source:{mode,sessionId},observedAt:job.observedAt,publishedAt:new Date().toISOString(),sequence:buffEventCount,transportRecordOrdinal:job.recordOrdinal,transport:{wireSequence:job.wireSequence,wireBytes:job.wireBytes,captureFrame:job.frame}})+'\n');}
 // Publish diagnostics with statistic/heartbeat snapshots, not every RPC.
 if(m.buffCoverage)buffCoverage=m.buffCoverage;
 for(const wrapper of m.events||[]){
  const auxiliary=hpTextEvidenceFromAreaSync(Buffer.from(wrapper.data,'base64'),wrapper.targetActorHash,wrapper.methodIndex);
  for(const event of auxiliary.events){auxiliaryEventCount++;ledger.append(path.join(out,'auxiliary-number-tips.jsonl'),JSON.stringify({...event,source:{mode,sessionId},observedAt:job.observedAt,transportRecordOrdinal:job.recordOrdinal,transportPath:wrapper.path,sequence:auxiliaryEventCount})+'\n');}
  for(const rejection of auxiliary.rejected){auxiliaryRejectedCount++;ledger.append(path.join(out,'rejected-number-tips.jsonl'),JSON.stringify({...rejection,observedAt:job.observedAt,transportRecordOrdinal:job.recordOrdinal,transportPath:wrapper.path})+'\n');}

  const reject=(reason,syncSubIndex=null)=>{rejectedEventCount++;settlementAudit.reject(job.recordOrdinal);ledger.append(path.join(out,'rejected-events.private.jsonl'),JSON.stringify({observedAt:job.observedAt,transport:job,path:wrapper.path,targetActorHash:wrapper.targetActorHash,methodIndex:wrapper.methodIndex,syncSubIndex,reason,wrapperBase64:wrapper.data})+'\n');};
  try{
   const result=damageEventsFromAreaSync(Buffer.from(wrapper.data,'base64'),wrapper.targetActorHash,wrapper.methodIndex);
   for(const item of result.rejected)reject(item.reason,item.syncSubIndex);
   for(const event of result.events){settlementAudit.observeDamage(event,job.recordOrdinal);eventCount++;rdpsObservation.observeDamage(event);estimateObserve('observeDamage',{...event,sequence:eventCount,transportPath:wrapper.path},job);ledger.append(path.join(out,'damage-events.jsonl'),JSON.stringify({schemaVersion:1,source:{mode,sessionId},observedAt:job.observedAt,publishedAt:new Date().toISOString(),sequence:eventCount,transportRecordOrdinal:job.recordOrdinal,transportPath:wrapper.path,transport:{wireSequence:job.wireSequence,wireBytes:job.wireBytes,captureFrame:job.frame},...event})+'\n');}
  }catch(e){reject(e.message);}
 }
 for(const row of m.identityRows||[]){const entry={...row,observedAt:job.observedAt,transportRecordOrdinal:job.recordOrdinal};identities.set(row.idHash,entry);ledger.append(path.join(out,'identity-events.jsonl'),JSON.stringify({source:{mode,sessionId},...entry})+'\n');}if(m.identityRows?.length)publishIdentities();
 for(const wrapper of m.identities||[]){try{const names=namesFromMatchWrapper(Buffer.from(wrapper.data,'base64'),wrapper.methodIndex);for(const row of names){const entry={...row,observedAt:job.observedAt,transportRecordOrdinal:job.recordOrdinal};identities.set(row.idHash,entry);ledger.append(path.join(out,'identity-events.jsonl'),JSON.stringify({source:{mode,sessionId},...entry})+'\n');}if(names.length)publishIdentities();}catch(e){ledger.append(path.join(out,'rejected-identities.private.jsonl'),JSON.stringify({observedAt:job.observedAt,reason:e.message,wrapperBase64:wrapper.data})+'\n');}}
 for(const event of m.encounterEvents||[]){
  if(c.decoderEnvelope){const ctx=event.identityContext||(event.kind==='encounter-identity'?event:null);if(ctx)ctx.decoderProof={payload:c.decoderEnvelope.payload,signature:c.decoderEnvelope.signature};}
  estimateObserve('observeEncounter',event,job);
  settlementAudit.observeEncounter(event,job.recordOrdinal);
  const entry={...event,source:{mode,sessionId},observedAt:job.observedAt,transportRecordOrdinal:job.recordOrdinal};
  ledger.append(path.join(out,'encounter-events.jsonl'),JSON.stringify(entry)+'\n');
  if(event.kind==='boss-battle-state'){
   if(event.initial)encounterClock=null;
   if(event.active&&event.previousActive===false&&event.stateChanged&&!event.initial)encounterClock={source:{sessionId},spaceHash:event.spaceHash,startObservedAt:job.observedAt,endObservedAt:null,npcNo:null,timingBasis:event.timingBasis,identityContext:event.identityContext};
   if(!event.active&&encounterClock?.spaceHash===event.spaceHash)encounterClock={...encounterClock,endObservedAt:job.observedAt};
   latest.encounterClock=encounterClock;
   publish();
  }
 }
 for(const encoded of m.statistics){try{const statisticBytes=Buffer.from(encoded,'base64'),statisticObject=decodeStatisticPayload(statisticBytes);if(statisticObject.stat_type===2){const detail=settlementFromObject(statisticObject);detailCount++;const settlementRow={...detail,source:{mode,sessionId},observedAt:job.observedAt,transportRecordOrdinal:job.recordOrdinal,encounterContext:encounterClock?{association:'unverified-receive-order-context',npcNo:encounterClock.npcNo,startObservedAt:encounterClock.startObservedAt,spaceHash:encounterClock.spaceHash}:null,payloadSha256:hash(statisticBytes)};recorded.observeSettlement(settlementRow);ledger.append(path.join(out,'settlement-details.jsonl'),JSON.stringify(settlementRow)+'\n');const conservation={...settlementAudit.audit(detail),source:{mode,sessionId},observedAt:job.observedAt,transportRecordOrdinal:job.recordOrdinal,payloadSha256:hash(statisticBytes),targetScope:'Observed dungeon NPC identities; hostility not inferred'};ledger.append(path.join(out,'settlement-conservation.jsonl'),JSON.stringify(conservation)+'\n');atomic(path.join(out,'settlement-conservation.json'),conservation);continue;}const data=statisticFromBytes(statisticBytes);data.actors=data.actors.map(a=>({...a,...(identities.get(a.idHash)||{})}));if(encounterClock&&data.npcNo){encounterClock.npcNo??=data.npcNo;if(encounterClock.npcNo===data.npcNo)data.encounterClock={...encounterClock};}const estimate=estimateObserve('observeStatistic',data,job);statsCount++;lastStatWall=Date.now();const remembered=data.timeCostSeconds>0?{seconds:data.timeCostSeconds,observedAt:job.observedAt,npcNo:data.npcNo}:latest.lastAuthoritativeTimeCost;
 latest={schemaVersion:1,source,observedAt:job.observedAt,health:{status:'healthy',gap:false,stale:false,session:mode==='live'?'valid':'recorded',reason:'Schema-validated cumulative statistic response'},...data,sequence:statsCount,transport:{wireSequence:job.wireSequence,wireBytes:job.wireBytes,compressed:job.compressed,recordOrdinal:job.recordOrdinal,captureFrame:job.frame},...(remembered?{lastAuthoritativeTimeCost:remembered}:{})};ledger.append(path.join(out,'statistics.jsonl'),JSON.stringify(latest)+'\n');publish(estimate);}catch(e){ledger.append(path.join(out,'rejected-statistics.private.jsonl'),JSON.stringify({observedAt:job.observedAt,transport:job,reason:e.message,payloadBase64:encoded})+'\n');}}
 }catch(e){fail(e.message);}}
py.on('error',e=>fail('Schema worker failed: '+e.message));py.on('exit',code=>{if(!stopped)fail('Schema worker exited '+code);});py.stdin.on('error',e=>{if(!stopped)fail('Schema worker pipe closed');});
function enqueue(meta,job){if(pending.size>=65536)throw Error('Single-block schema queue exceeds65536 records');const id=++nextJob;pending.set(id,meta);workerWriter.push({id,...job});}
const blocks=new BlockStream((body,meta)=>enqueue(meta,{body:body.toString('base64'),sessionId,recordOrdinal:meta.recordOrdinal,observedAt:meta.observedAt}),{onResync:r=>ledger.append(path.join(out,'transport-gaps.jsonl'),JSON.stringify({kind:'block-resync',source:{mode,sessionId},...r})+'\n')});
// Capture loss is recorded and bridged: RC4 advances by the exact missing TCP
// byte count, framing resyncs at the next validated block, stateful decoders
// invalidate in stream order. Missing messages are never reconstructed.
const gapRecovery=c.transport!=='kcp'&&c.gapRecovery!==false;
function onGap(gap){
 const entry={kind:'tcp-gap',source:{mode,sessionId},index:ordered.gapCount,...gap,discardedPartialBytes:blocks.buf.length,nextRecordOrdinal:blocks.records};
 ledger.append(path.join(out,'transport-gaps.jsonl'),JSON.stringify(entry)+'\n');
 blocks.resync({gapIndex:entry.index,fromSeq:gap.fromSeq,toSeq:gap.toSeq});
 enqueue({control:'transport_gap',gap:entry,recordOrdinal:entry.nextRecordOrdinal,observedAt:gap.resumeObservedAt},{control:'transport_gap'});
}
const ordered=new OrderedCipher(state,c.serverEncryptedOrigin,{onBytes:(bytes,meta)=>blocks.push(bytes,meta),onGap:gapRecovery?onGap:null,gapMs:c.gapTimeoutMs??3000,maxSkip:c.maxRc4SeekBytes??128*1024*1024});
const kcp=c.transport==='kcp'?new (require('../modules/acquisition/kcp-stream.cjs').KcpStream)({...c.kcp,gapMs:c.gapTimeoutMs??3000,onBytes:(data,meta)=>{if(data.length){ordered.push({data,...meta});ordered.start();ordered.drain();}}}):null;
const inheritedCapture=!!kcp||c.captureHandoff==='tcp';
let finishingKcp=false;
process.on('message',message=>{if(message?.type==='kcp-capture-error'||message?.type==='tcp-capture-error')fail(message.message||'Inherited capture failed');});
function continuity(){return {recoveredGaps:ordered.gapCount,gapBytes:ordered.gapBytes,lateBytesDropped:ordered.lateBytes,resyncs:blocks.resyncs,resyncSkippedBytes:blocks.resyncSkippedBytes,discardedPartialBytes:blocks.discardedBytes,recovery:gapRecovery};}
function fail(reason){if(stopped)return;failed=true;latest.health={status:'invalid',gap:reason.toLowerCase().includes('gap')?{reason}:false,stale:true,session:'invalid',reason};finish('invalid');}
function finish(status='stopped'){
 if(stopped||finishingKcp)return;
 if(!inheritedCapture||mode!=='live'){finishNow(status);return;}
 finishingKcp=true;clearInterval(tick);clearTimeout(startTimer);
 (async()=>{
  try{
   if(process.connected)process.send({type:kcp?'stop-kcp-capture':'stop-tcp-capture'},()=>{});
   const deadline=Date.now()+30000;
   while(!process.stdin.readableEnded&&Date.now()<deadline)await wait(10);
   while(!failed&&(rawSpool?.hasPending||pending.size)&&Date.now()<deadline){pumpRaw();await wait(10);}
   if(!failed){
    ordered.start();if(kcp)ordered.drain();else ordered.finish();
    while(!failed&&pending.size&&Date.now()<deadline)await wait(10);
    if(!process.stdin.readableEnded||rawSpool?.hasPending||pending.size||kcp?.pending.size||blocks.buf.length)throw Error('Inherited capture stop has an incomplete transport tail or undrained queue');
   }
  }catch(e){failed=true;latest.health={status:'invalid',gap:{reason:e.message},stale:true,session:'invalid',reason:e.message};}
  finishNow(failed?'invalid':status);if(process.connected)process.disconnect();
 })().catch(e=>{failed=true;finishNow('invalid');if(process.connected)process.disconnect();});
}
function finishNow(status='stopped'){
 if(stopped)return;stopped=true;clearInterval(tick);clearInterval(pumpTimer);clearTimeout(startTimer);capture?.kill();watcher?.kill();workerWriter.close();py.kill();
 buffCoverage={...buffCoverage,streamEnded:true,attributionReady:false,complete:false};
 if(!failed&&status!=='connection-closed')latest.health={...latest.health,status,stale:mode==='live',reason:status==='replay-complete'?'Replay completed; no live connection claim':'Passive collector stopped'};
 publish();atomic(path.join(out,'completion.json'),{at:new Date().toISOString(),status,failed,packets:frames,blocks:protoCount,statistics:statsCount,incompleteTailBytes:blocks.buf.length,pendingPackets:ordered.pending.length+(kcp?.pending.size||0),pendingMessages:pending.size,unparsedCaptureBytes:rawSpool?.backlogBytes||0,drainComplete:!(pending.size||rawSpool?.hasPending||kcp?.pending.size),publication:snapshotPublisher.status()});
 ledger.close();rawSpool?.close();
 Promise.resolve().then(async()=>{
  if(mode==='live'){
   try {
    const captureDir=await require('../modules/storage/recover-statistics.cjs').persistRecoveredBattles(out);
    if(captureDir){
     const uploader=require('../modules/storage/upload-package.cjs');
     const packageFile=uploader.defaultUploadPath(out,path.resolve(__dirname,'..'));
     const {manifest,...result}=await uploader.createUploadPackage(captureDir,packageFile);
     atomic(path.join(path.dirname(out),'upload-package.json'),{status:'complete',...result});
    }
   } catch(e){atomic(path.join(path.dirname(out),'upload-package.json'),{status:'failed',error:e.message,rawRecordsRetained:true});}
  }
  const [publication]=await Promise.all([snapshotPublisher.close(),networkDiagnostics?.close()]);
  console.log(JSON.stringify({output:out,status,statistics:statsCount,publication}));process.exitCode=failed?1:0;
 });
}
function packet(line,oldFormat=false){if(stopped)return;const a=line.split('\t');if(!line.trim())return;let p;
 if(kcp){
  p=require('../modules/acquisition/kcp-stream.cjs').parseRow(line,c.kcp.remoteEndpoint,c.kcp.envelope);const f=c.flow;
  if(p.src!==f.serverAddress||p.sport!==f.serverPort||p.dst!==f.clientAddress||p.dport!==f.clientPort)throw Error('Unexpected KCP flow');
  if(p.envelope!==c.kcp.envelope||p.iface!==0)throw Error('KCP envelope or capture interface changed');
  frames++;lastFrameWall=Date.now();for(const segment of p.segments)kcp.push(segment,{frame:p.frame,observedAt:new Date(p.time*1000).toISOString()});return;
 }
 if(oldFormat){if(a.length!==8)throw Error('Replay TSV requires8 fields');p={frame:+a[0],time:a[1],iface:a[2],src:a[3],sport:+a[4],seq:+a[5],len:+a[6],hex:a[7]};if(p.iface!==String(c.replayInterfaceId))throw Error('Unexpected replay interface');}
 else{if(!require('./p1-capture-profile.cjs').isLiveFieldCount(a.length))throw Error('Live TSV requires 13 or 21 fields');p={frame:+a[0],time:a[1],iface:a[2],src:a[3],sport:+a[4],dst:a[5],dport:+a[6],seq:+a[7],len:+a[8],syn:a[9],fin:a[10],rst:a[11],hex:a[12]};if(connectionBoundary(p)){transportBoundarySeen=true;closeConnection('Connection SYN/FIN/RST observed; prior captured data retained');return;}if(transportBoundarySeen)return;if(p.src!==c.flow.serverAddress||p.sport!==c.flow.serverPort)return;if(p.dst!==c.flow.clientAddress||p.dport!==c.flow.clientPort)throw Error('Unexpected server flow');}
 if(p.src!==c.flow.serverAddress||p.sport!==c.flow.serverPort)return;const data=Buffer.from(p.hex||'','hex');if(data.length!==p.len)throw Error('Truncated capture payload');if(!data.length)return;frames++;lastFrameWall=Date.now();ordered.push({seq:p.seq,data,frame:p.frame,observedAt:new Date(Number(p.time)*1000).toISOString()});if(ordered.next!==null)ordered.drain();
}
function wait(ms){return new Promise(r=>setTimeout(r,ms));}
function endReplay(){ordered.start();if(kcp?.pending.size)throw Error('Replay ends with unresolved KCP gap');if(gapRecovery)ordered.finish();else{ordered.drain();if(ordered.pending.length)throw Error('Replay ends with unresolved transport gap');}}
// Three transport states, published separately from statistic freshness:
// flowing (decoded recently), receiving (packets but no decoded block), no-data.
function transportState(now=Date.now()){
 if(lastDecodedWall&&now-lastDecodedWall<10000)return 'flowing';
 if(lastFrameWall&&now-lastFrameWall<10000)return 'receiving-not-decoding';
 return 'no-data';
}
// A clean FIN/RST or a new SYN ends this connection. Everything already captured
// stays valid; queued blocks drain before the collector stops.
let closing=false,transportBoundarySeen=false;
async function closeConnection(reason){
 if(closing||stopped)return;closing=true;
 // Replay: stop consuming after the boundary; the replay loop completes normally.
 if(mode==='replay'){ledger.append(path.join(out,'transport-gaps.jsonl'),JSON.stringify({kind:'connection-closed',source:{mode,sessionId},reason})+'\n');return;}
 capture?.kill();
 try{ordered.drain();}catch(e){}
 for(let n=0;n<200&&pending.size&&!stopped;n++)await wait(50);
 if(stopped)return;
 latest.health={...latest.health,status:'connection-closed',session:'ended',stale:true,reason};
 ledger.append(path.join(out,'transport-gaps.jsonl'),JSON.stringify({kind:'connection-closed',source:{mode,sessionId},reason,at:new Date().toISOString(),undecodedQueue:pending.size})+'\n');
 finish('connection-closed');
}
process.on('SIGINT',()=>finish());process.on('SIGTERM',()=>finish());
(async()=>{await Promise.race([ready,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Schema worker readiness timeout')),10000);t.unref();})]);publish();
 if(mode==='replay'&&opts['spool-test']){
 rawSpool=new RawSpool(path.join(out,'transport.private.tsv'));
 const bytes=fs.readFileSync(opts.replay);rawSpool.append(bytes);pumpTimer=setInterval(pumpRaw,ioLimits.pumpIntervalMs);
 while(!stopped&&(rawSpool.hasPending||pending.size)){if(ordered.next===null&&ordered.pending.length>=8)ordered.start();await wait(10);}
 endReplay();while(pending.size&&!stopped)await wait(10);if(!stopped)finish('replay-complete');return;
 }
 if(mode==='replay'){const lines=fs.readFileSync(opts.replay,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/);for(const line of lines){packet(line,line.split('\t').length===8);if(ordered.next===null&&ordered.pending.length>=8)ordered.start();if(pending.size>1024){while(pending.size>256&&!stopped)await wait(10);}if(stopped)return;}endReplay();while(pending.size&&!stopped)await wait(10);if(!stopped)finish('replay-complete');return;}
 if(!c.pid||!c.processStartUtc||!c.processPath||!c.captureInterface)throw Error('Missing live session binding');
 watcher=spawn(runtimePaths().powershell,powershellScriptArgs(path.join(__dirname,'../scripts/windows/p1-live-session-watch.ps1'),[configPath,out]),{windowsHide:true,stdio:['ignore','pipe','pipe']});readline.createInterface({input:watcher.stdout}).on('line',s=>{try{const row=JSON.parse(s);if(row.kind==='network-os'){networkDiagnostics?.write(row);return;}lastBind=row;lastBindWall=Date.now();if(!lastBind.valid)closeConnection(lastBind.reason);}catch(e){fail('Session watcher output invalid');}});watcher.stderr.on('data',b=>ledger.append(path.join(out,'session.stderr.txt'),b));watcher.on('error',e=>fail('Session watcher failed'));watcher.on('exit',()=>{if(!stopped&&!closing&&!finishingKcp)fail('Session watcher ended');});
 for(let n=0;n<100&&!lastBind&&!stopped;n++)await wait(100);if(stopped)return;if(!lastBind?.valid)throw Error('Could not verify current process and flow');
 const f=c.flow,bpf=`tcp and host ${f.clientAddress} and host ${f.serverAddress} and port ${f.clientPort} and port ${f.serverPort}`;

 let ingress;
 if(inheritedCapture){
  ingress=process.stdin;
  process.stdin.on('end',()=>{if(!stopped&&!finishingKcp){if(fs.existsSync(path.join(out,'stop')))finish();else fail('Capture handoff closed');}});
  atomic(path.join(out,'collector.json'),{pid:null,pipelinePid:process.pid,schemaPid:py.pid,watcherPid:watcher.pid,interface:c.captureInterface,transport:kcp?'kcp':'tcp',captureOwner:'session-service'});
 }else{
 capture=spawn(c.tshark,require('./p1-capture-profile.cjs').captureArgs([c.captureInterface],bpf,undefined,true),{windowsHide:true,stdio:['ignore','pipe','pipe']});atomic(path.join(out,'collector.json'),{pid:capture.pid,pipelinePid:process.pid,schemaPid:py.pid,watcherPid:watcher.pid,interface:c.captureInterface,filter:bpf});capture.once('spawn',()=>{workerPriorities.capture=setWorkerPriority(capture.pid,'capture');});capture.stderr.on('data',b=>ledger.append(path.join(out,'capture.stderr.txt'),b));capture.on('error',e=>fail('Packet capture failed: '+e.message));capture.on('exit',code=>{if(!stopped)fail('Packet capture exited '+code);});ingress=capture.stdout;
 }
 rawSpool=new RawSpool(path.join(out,'transport.private.tsv'));ingress.on('data',bytes=>{if(stopped)return;try{const start=performance.now();rawSpool.append(bytes);rawWriteMaxMs=Math.max(rawWriteMaxMs,performance.now()-start);ingressBytes+=bytes.length;ingressChunks++;lastIngressAt=new Date().toISOString();}catch(e){fail('Raw evidence write failed: '+e.message);}});pumpTimer=setInterval(pumpRaw,ioLimits.pumpIntervalMs);
 startTimer=setTimeout(()=>{try{ordered.start();}catch(e){fail(e.message);}},1000);
 const began=Date.now();tick=setInterval(()=>{try{if(fs.existsSync(path.join(out,'stop'))||Date.now()-began>1000*Number(opts.duration??600)){finish();return;}if(closing)return;
  // After a blocked event loop, timers run before buffered watcher lines are
  // read. A lagging tick re-anchors the window instead of declaring staleness.
  const now=Date.now(),lag=lastTickWall?now-lastTickWall-1000:0;lastTickWall=now;
  loopLagMaxMs=Math.max(loopLagMaxMs,lag);
  const mono=performance.now();if(mono-lastNetworkSample>=5000){networkDiagnostics?.write({kind:'network-pipeline',at:new Date(now).toISOString(),intervalMs:mono-lastNetworkSample,cpuUsageUs:process.cpuUsage(),rssBytes:process.memoryUsage.rss(),pendingProto:pending.size,rawBacklogBytes:(rawSpool?.backlogBytes||0),ingressBytes,ingressChunks,lastIngressAt,rawWriteMaxMs,loopLagMaxMs,lastDecodedCaptureAt,lastDecodedAt:lastDecodedWall?new Date(lastDecodedWall).toISOString():null,publication:snapshotPublisher.status(),diagnostics:networkDiagnostics?.status()});lastNetworkSample=mono;rawWriteMaxMs=0;loopLagMaxMs=0;}
  if(lag>1000){loopLagSkips++;lastBindWall=Math.max(lastBindWall,now-1000);}
  if(now-lastBindWall>8000)throw Error('Session binding verification stale');if(ordered.next===null)ordered.start();ordered.tick();kcp?.tick();const transport=transportState(now);latest.health={...latest.health,status:lastStatWall?'healthy':'waiting',session:'valid',transport,gap:ordered.gapSince?{since:new Date(ordered.gapSince).toISOString()}:false,recoveredGaps:ordered.gapCount,loopLagSkips,stale:!lastStatWall||now-lastStatWall>3500,reason:transport==='receiving-not-decoding'?'Packets arriving but no decoded block in 10s':transport==='no-data'?'No packets from bound connection in 10s':lastStatWall?'Passive capture active; see stale flag':'Passive capture active; no statistic response yet'};publish();}catch(e){fail(e.message);}},1000);
})().catch(e=>fail(e.message));
