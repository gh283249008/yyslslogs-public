"""Receive-time numeric attribute projection. Never authoritative hit-time rDPS.

consume(protobuf_message, provenance) or consume_operations(rows, provenance).
Rows use exact Python int / {int64Decimal: str}; never a rounded JSON double.
Salt is private decoding context, never included in emitted events. Initial
snapshots are atomic; their salt can occur after attributes within the snapshot.
Later salt changes clear old state and never backfill previously unknown values.
"""
import collections, math, struct, json, hashlib
from p1_buff_stream import BuffStream, hashed, ROOT, INDEX_SHA
from p1_schema_profile import LEGACY_INDEX_SHA

SUPPLEMENT=ROOT/'evidence/p1/rdps-rules/supplemental-index-names.json'
SUPPLEMENT_SHA='99d39fc6da4f13fb35bf976e74ba371e8eac29a09bce0e47a554c2652842f853'

FIELDS = frozenset(('W_DEF', 'W_ATK_PEN_RDC', 'W_ATK_PEN',
 'CORRECTABLE_W_ATK_PEN_RDC', 'CORRECTABLE_W_ATK_PEN', 'ATK_PEN_CORRECT_PARA',
 'MIN_W_ATK', 'MAX_W_ATK', 'W_ATK_IGR', 'W_ATK_IGR_RDC', 'W_ATK_SCALE', 'W_DEF_SCALE',
 'PRO_DEF_A', 'PRO_DEF_B', 'PRO_DEF_C', 'PRO_DEF_D', 'PRO_DEF_E'))

def exact_int(value):
 if isinstance(value, dict): value=value.get('int64Decimal')
 if isinstance(value, str) and value.lstrip('-').isdigit(): value=int(value)
 if isinstance(value, bool) or not isinstance(value, int): raise ValueError('exact_integer_required')
 if not -(1<<63)<=value<(1<<64): raise ValueError('integer_outside_64_bits')
 return value

def decode_salted_float64(value, salt):
 value=exact_int(value);salt=exact_int(salt)
 result=0.0 if value==0 else struct.unpack('<d',struct.pack('<Q',(value^salt)&((1<<64)-1)))[0]
 if not math.isfinite(result): raise ValueError('nonfinite_decoded_attribute')
 return result

class AttributeStream(BuffStream):
 def __init__(self,max_actors=4096):
  super().__init__()
  supplement_bytes=SUPPLEMENT.read_bytes()
  if hashlib.sha256(supplement_bytes).hexdigest()!=SUPPLEMENT_SHA:raise ValueError('Attribute schema supplement evidence changed')
  supplement=json.loads(supplement_bytes)
  if supplement['schemaPreset']!=10012 or supplement['baseIndexNamesSha256']!=LEGACY_INDEX_SHA:raise ValueError('Attribute schema supplement base mismatch')
  self.supplement_names={r['index']:r['name'] for r in supplement['rows']} if INDEX_SHA==LEGACY_INDEX_SHA else {}
  if any(k in self.names and self.names[k]!=v for k,v in self.supplement_names.items()):raise ValueError('Attribute schema supplement conflicts with base')
  self.base_names=dict(self.names);self.supplement_session=supplement['sameSessionId']
  if isinstance(max_actors,bool) or not isinstance(max_actors,int) or max_actors<1:raise ValueError('positive_actor_capacity_required')
  self.max_actors=max_actors;self.generation_sequence=0;self.session=None;self.last_ordinal=None;self.pending_invalidations=[]
 def invalidate(self, reason, actor=None, clear=True):
  self.pending_invalidations.append({'status':'invalidated','targetActorHash':actor,'reason':reason,'attribute':None})
  # AOI loss is a coverage boundary, even when the buff projection retains history.
  self.generation_sequence+=1
  actors=list(self.states) if actor is None else [actor]
  for a in actors:self.states.pop(a,None)
  if reason.startswith('observed_aoi_') or reason=='guid_rebound':
   for guid,known in list(self.guids.items()):
    if actor is None or known==actor:self.guids.pop(guid,None)
   if actor is None:self.classes.clear()
   else:self.classes.pop(actor,None)
  self.revision+=1;self.counts['invalidation:'+reason]+=1
  self.invalidations.append({'reason':reason,'actorHash':actor});self.invalidations=self.invalidations[-100:]
 def _capacity_reset(self):
  self.invalidate('identity_capacity');self.guids.clear();self.classes.clear()
 def _session_boundary(self,provenance):
  session=((provenance or {}).get('source') or {}).get('sessionId')
  if session is not None and session!=self.session:
   self.invalidate('session_boundary');self.guids.clear();self.classes.clear();self.session=session;self.last_ordinal=None
   # Name bytes were validated for this process lifetime. Unknown future builds
   # keep the historical base decoder, without silently applying new mappings.
   self.names=dict(self.base_names)
   if session==self.supplement_session:self.names.update(self.supplement_names)
 def _state(self, actor):
  if actor not in self.states and len(self.states)>=self.max_actors:self._capacity_reset()
  return self.states.setdefault(actor,{'salt':None,'generation':self.generation_sequence,'fields':{}})
 def _ids(self,m):
  fields=m.DESCRIPTOR.fields_by_name
  if m.DESCRIPTOR.name=='AoiGuid':
   for field in ('leave','remove'):
    for guid in getattr(m,field):
     actor=self.guids.get(guid)
     if actor is not None:self.invalidate('observed_aoi_'+field,actor)
  if 'guid' in fields and 'id' in fields and fields['id'].type==fields['id'].TYPE_BYTES and m.id:
   actor=hashed(m.id)
   if m.guid in self.guids and self.guids[m.guid]!=actor:self.invalidate('guid_rebound',self.guids[m.guid])
   if (m.guid not in self.guids and len(self.guids)>=self.max_actors) or (actor not in self.classes and len(self.classes)>=self.max_actors) or (actor not in self.states and len(self.states)>=self.max_actors):self._capacity_reset()
   self.guids[m.guid]=actor
   if m.DESCRIPTOR.name=='AreaCreateEntityMsg':self.classes[actor]=m.name.decode('ascii',errors='replace')
  for f,v in m.ListFields():
   if f.type==f.TYPE_MESSAGE:
    for sub in (v if f.is_repeated else [v]):self._ids(sub)
 def consume(self, msg, provenance=None):
  self.pending_invalidations=[]
  self._session_boundary(provenance)
  self._ids(msg);rows=[]
  def walk(m,path,actor,initial):
   fields=m.DESCRIPTOR.fields_by_name
   if 'guid' in fields and m.HasField('guid'):actor=self.guids.get(m.guid,actor)
   if m.DESCRIPTOR.name=='AreaCreateEntityMsg':
    if m.id:actor=hashed(m.id)
    # Entity reconstruction replaces the entire attribute view, including when
    # the snapshot carries no attributes or only fields outside our projection.
    # Keep the boundary in this atomic batch so a later snapshot salt still
    # decodes earlier fields, without retaining state from the prior entity.
    if actor:rows.append({'targetActorHash':actor,'initial':True,'path':[]})
   initial=initial or m.DESCRIPTOR.name=='AreaCreateEntityMsg'
   if m.DESCRIPTOR.name=='PropItem':
    if m.HasField('eid') and m.eid:actor=hashed(m.eid)
    if m.path:path=[self.value(x) for x in m.path]
    if m.HasField('name'):path=path+[self.value(m.name)]
    path=[x for x in path if x is not None]
    if path and path[0]=='attr' and len(path)<=2:
     r={'targetActorHash':actor,'targetClass':self.classes.get(actor),'initial':initial,'path':path,'oper':m.oper,'hasValue':m.HasField('value')}
     if r['hasValue']:
      r['value']=self.value(m.value)
      r['wireValueKind']=next((f.name for f,v in m.value.ListFields()),None)
     rows.append(r)
   for f,v in m.ListFields():
    if f.type==f.TYPE_MESSAGE:
     for sub in (v if f.is_repeated else [v]):walk(sub,path,actor,initial)
  walk(msg,[],None,False)
  return self.consume_operations(rows,provenance)
 def consume_operations(self, rows, provenance=None):
  provenance=dict(provenance or {})
  # Only an allowlist is copied: callers cannot override field/value/status.
  head={k:provenance[k] for k in ('source','observedAt','publishedAt','recordOrdinal','transportRecordOrdinal','wireSequence') if k in provenance}
  self._session_boundary(head)
  ordinal=head.get('transportRecordOrdinal',head.get('recordOrdinal'))
  if ordinal is not None:
   if self.last_ordinal is not None and ordinal<=self.last_ordinal:
    self.invalidate('nonmonotonic_record');return []
   self.last_ordinal=ordinal
  selected=[r for r in rows if len(r.get('path',[]))==2 and r['path'][0]=='attr' and isinstance(r['path'][1],str) and r['path'][1] in FIELDS|{'salt'}]
  initial={r['targetActorHash'] for r in rows if r.get('initial') and r.get('targetActorHash')}
  for actor in initial:
   self.invalidate('initial_snapshot',actor);state=self._state(actor)
   salts=[r for r in selected if r.get('initial') and r.get('targetActorHash')==actor and r['path'][1]=='salt' and r.get('hasValue')]
   try:
    keys={exact_int(r['value']) for r in salts}
    if len(keys)==1:state['salt']=keys.pop()
    elif keys:self.counts['ambiguous_initial_salt']+=1
   except ValueError:self.counts['invalid_initial_salt']+=1
  output=[]
  for r in rows:
   path=r.get('path',[]);actor=r.get('targetActorHash')
   if not path or path[0]!='attr':continue
   if len(path)==1 and not r.get('initial'):
    self.invalidate('unresolved_attribute_container_operation',actor);continue
   if len(path)!=2 or not isinstance(path[1],str) or path[1] not in FIELDS|{'salt'}:continue
   field=path[1];state=self._state(actor) if actor else None
   if field=='salt':
    if r.get('initial'):continue
    # A salt-only update is a new generation. No retrospective decode.
    self.invalidate('salt_update',actor);state=self._state(actor) if actor else None
    try:
     if state is not None and r.get('hasValue') and r.get('oper')==7:state['salt']=exact_int(r['value'])
    except ValueError:self.counts['invalid_salt_update']+=1
    continue
   event={**head,'targetActorHash':actor,'targetClass':r.get('targetClass'),'attribute':field,'initial':bool(r.get('initial')),
    'rawOperation':r.get('oper'),'wireValueKind':r.get('wireValueKind'),'saltGeneration':state['generation'] if state else None,
    'saltKnown':state is not None and state['salt'] is not None,'status':'unavailable','value':None,'attributionReady':False,
    'timingBasis':'packet-reception property observation; hit-time applicability unvalidated'}
   try:
    if state is None:raise ValueError('unknown_actor')
    if not r.get('hasValue'):raise ValueError('missing_property_value')
    if r.get('oper') not in ((45,46) if r.get('initial') else (7,)):raise ValueError('unvalidated_property_operation')
    kind=r.get('wireValueKind');raw=r['value']
    if kind in ('fvalue','dvalue'):
     if isinstance(raw,bool) or not isinstance(raw,(int,float)) or not math.isfinite(raw):raise ValueError('invalid_direct_float')
     value=float(raw);codec='direct_protobuf_float'
    elif kind in (None,'ivalue'):
     if state['salt'] is None:raise ValueError('salt_unknown')
     value=decode_salted_float64(raw,state['salt']);codec='native_rm_salt_xor64_double'
    else:raise ValueError('unsupported_wire_value_kind')
    event.update(status='decoded-observation',value=value,codec=codec,numericDecodeValidated=True)
    state['fields'][field]=dict(event)
   except (ValueError,TypeError) as error:
    event['reason']=str(error)
    if state is not None:state['fields'].pop(field,None)
   self.counts[event['status']]+=1;output.append(event)
  if output:self.revision+=1
  return output
 def coverage(self):
  return {'schemaVersion':1,'counts':dict(self.counts),'schemaSupplement':{'sha256':SUPPLEMENT_SHA,'sessionMatched':self.session==self.supplement_session,'appliedIndices':sorted(self.supplement_names) if self.session==self.supplement_session else []},'capacity':{'maxActors':self.max_actors,'states':len(self.states),'guids':len(self.guids),'classes':len(self.classes),'generationSequence':self.generation_sequence},'actors':[{'actorHash':actor,'saltKnown':s['salt'] is not None,'saltGeneration':s['generation'],'decodedFields':sorted(s['fields'])} for actor,s in self.states.items()],
   'recentInvalidations':self.invalidations,'numericCodecValidated':True,'complete':False,'attributionReady':False,
   'limits':['OWN_CLIENT fields are not complete for teammates.','Receive-time values are not validated hit-time attributes.','Missing correction or penetration fields are unknown, never zero.','No historical decode with later salt; AOI and session changes invalidate state.']}

