"""Persistent, offline-only schema gate. No networking or process access."""
import sys,pathlib,json,base64,struct,hashlib
from p1_encounter_schema import EncounterSchema
from p1_buff_stream import BuffStream
from p1_attribute_stream import AttributeStream
from p1_target_resource_stream import TargetResourceStream
from p1_identity_stream import IdentityStream
from p1_schema_profile import schema_metadata
identity_stream=IdentityStream()
encounter_schema=EncounterSchema()
buff_stream=BuffStream()
attribute_stream=AttributeStream()
target_resource_stream=TargetResourceStream()
root=pathlib.Path(__file__).resolve().parents[1]/'evidence/p0/runtime-rpc-analysis'
sys.path.insert(0,str(root/'pydeps'))
from google.protobuf import descriptor_pool,message_factory
pool=descriptor_pool.DescriptorPool()
for name in ('common.proto','client_gate.proto'):pool.AddSerializedFile((root/(name+'.descriptor.bin')).read_bytes())
service=pool.FindServiceByName('mobile.server.lua.IGateClient')
types=[message_factory.GetMessageClass(m.input_type) for m in service.methods]
def walk(msg,out,events,identities,path,depth=0):
 if depth>30:raise ValueError('Message nesting exceeds limit')
 if msg.DESCRIPTOR.name=='AreaMessage' and msg.method.index==0x2e77db68:
  out.append(base64.b64encode(msg.smsgpack).decode())
 if msg.DESCRIPTOR.name=='AreaMessage' and msg.method.index in (1164740750,1000155338):
  events.append({'methodIndex':msg.method.index,'targetActorHash':hashlib.sha256(msg.id).hexdigest()[:16] if msg.id else None,'path':path,'data':base64.b64encode(msg.smsgpack).decode()})
 if msg.DESCRIPTOR.name=='AreaMessage' and msg.method.index==1376711304:
  identities.append({'methodIndex':msg.method.index,'path':path,'data':base64.b64encode(msg.smsgpack).decode()})
 for f,v in msg.ListFields():
  if f.type==f.TYPE_MESSAGE:
   if f.is_repeated:
    for index,item in enumerate(v):walk(item,out,events,identities,path+'.'+f.name+'['+str(index)+']',depth+1)
   else:walk(v,out,events,identities,path+'.'+f.name,depth+1)
worker_protocol=json.loads((pathlib.Path(__file__).resolve().parents[1]/'config/worker-protocol.json').read_text(encoding='utf-8'))
if worker_protocol.get('schemaVersion')!=1 or not 1<=worker_protocol.get('maxBatchJobs',0)<=128:raise ValueError('Unsupported worker protocol')
print(json.dumps({'ready':True,'methods':len(types),'schemaProfile':schema_metadata(),'workerProtocol':worker_protocol}),flush=True)
def transport_gap():
 # Lost bytes may have carried AOI/buff/attribute changes. Every incremental
 # view restarts from the next snapshot; nothing before the gap is carried over.
 buff_stream.invalidate('transport_gap')
 target_resource_stream.invalidate('transport_gap')
 attribute_stream.invalidate('transport_gap')
 attribute_stream.last_ordinal=None
 encounter_schema.states.clear()
 return {'buffCoverage':buff_stream.coverage(),'attributeCoverage':attribute_stream.coverage()}
def decode_job(job):
 try:
  if job.get('control')=='transport_gap':
   return {'id':job['id'],'ok':True,'control':'transport_gap',**transport_gap()}
  b=base64.b64decode(job['body'],validate=True);mi=struct.unpack_from('<H',b)[0]
  if not 0<=mi<len(types):raise ValueError('Server method index outside recorded schema')
  msg=types[mi]();msg.ParseFromString(b[2:])
  if not msg.IsInitialized():raise ValueError('Missing required protobuf fields')
  out=[];events=[];identities=[];walk(msg,out,events,identities,msg.DESCRIPTOR.name)
  encounter_events=encounter_schema.consume(msg)
  encounter_events.extend(target_resource_stream.consume(msg))
  attribute_revision=attribute_stream.revision
  attribute_events=attribute_stream.consume(msg,{'source':{'sessionId':job.get('sessionId')},'transportRecordOrdinal':job.get('recordOrdinal'),'observedAt':job.get('observedAt')})
  attribute_events=attribute_stream.pending_invalidations+attribute_events
  buff_revision=buff_stream.revision
  buff_events=buff_stream.consume(msg)
  return {'id':job['id'],'ok':True,'statistics':out,'events':events,'identities':identities,'identityRows':identity_stream.consume(msg),'encounterEvents':encounter_events,'buffEvents':buff_events,'attributeEvents':attribute_events,'attributeCoverage':attribute_stream.coverage() if job['id']%100==0 else None,'buffCoverage':buff_stream.coverage() if job['id']%100==0 else None}
 except Exception as e:return {'id':job.get('id') if isinstance(job,dict) else None,'ok':False,'error':type(e).__name__+': '+str(e)}

for line in sys.stdin:
 try:
  envelope=json.loads(line)
  if isinstance(envelope,dict) and 'jobs' in envelope:
   jobs=envelope['jobs']
   if envelope.get('schemaVersion')!=1 or not isinstance(jobs,list) or not 1<=len(jobs)<=worker_protocol['maxBatchJobs']:raise ValueError('Invalid worker batch')
   if any(not isinstance(job,dict) or not isinstance(job.get('id'),int) for job in jobs) or len({job['id'] for job in jobs})!=len(jobs):raise ValueError('Invalid worker job identities')
   # Coverage contains live counters/lists: freeze each response BEFORE the next
   # job mutates decoder state, exactly as the legacy per-job print did.
   results=[json.dumps(decode_job(job)) for job in jobs]
   print('{"schemaVersion":1,"results":['+','.join(results)+']}',flush=True)
   continue
  else:result=decode_job(envelope)
 except Exception as e:result={'id':None,'ok':False,'error':type(e).__name__+': '+str(e)}
 print(json.dumps(result),flush=True)
