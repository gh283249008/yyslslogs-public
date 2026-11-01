"""Incremental public/own-client buff evidence, preset 10012; never attribution.

Reuses p1-buff-extract.py and p1-buff-normalize.py mappings. Unknown removal,
AOI and clock semantics are retained as uncertainty, not silently validated.
"""
import pathlib,json,hashlib,copy,collections,math
from p1_schema_profile import ROOT, INDEX, INDEX_SHA, NAMES, SCHEMA_COUNT
def hashed(value):return hashlib.sha256(value if isinstance(value,bytes) else str(value).encode()).hexdigest()[:16]

class BuffStream:
 def __init__(self):
  data=INDEX.read_bytes()
  if hashlib.sha256(data).hexdigest()!=INDEX_SHA:raise ValueError('Buff property preset evidence changed')
  self.names=dict(NAMES)
  self.guids={};self.classes={};self.states={};self.counts=collections.Counter();self.actors={};self.invalidations=[];self.revision=0
  policy=json.loads((ROOT/'config/rdps-simple-v1.json').read_text(encoding='utf-8'))
  self.resource_rules={int(no):r['resourceChangeResource'] for no,r in policy['rules'].items() if r.get('requiresResourceSuccess') and isinstance(r.get('resourceChangeResource'),int)}
  self.state_events={}
 def value(self,v):
  for f,x in v.ListFields():
   if f.name=='sindex':return self.names.get(x,'sindex:'+str(x))
   if f.name=='svalue':return {'bytesHash':hashed(x),'length':len(x)}
   if f.name in ('ivalue','fvalue','dvalue','bvalue'):return x
  return None
 def _ids(self,m):
  fields=m.DESCRIPTOR.fields_by_name
  if m.DESCRIPTOR.name=='AoiGuid':
   for field in ('leave','remove'):
    for guid in getattr(m,field):self.invalidate('observed_aoi_'+field,self.guids.get(guid),clear=False)
  if 'guid' in fields and 'id' in fields and fields['id'].type==fields['id'].TYPE_BYTES and m.id:
   actor=hashed(m.id)
   if m.guid in self.guids and self.guids[m.guid]!=actor:self.invalidate('guid_rebound',self.guids[m.guid])
   self.guids[m.guid]=actor
   if m.DESCRIPTOR.name=='AreaCreateEntityMsg':self.classes[actor]=m.name.decode('ascii',errors='replace')
  for f,v in m.ListFields():
   if f.type==f.TYPE_MESSAGE:
    for sub in (v if f.is_repeated else [v]):self._ids(sub)
 def invalidate(self,reason,actor=None,clear=True):
  self.revision+=1
  self.counts['invalidation:'+reason]+=1
  self.invalidations.append({'reason':reason,'actorHash':actor})
  self.invalidations=self.invalidations[-100:]
  if clear:
   for k in list(self.states):
    if actor is None or k[0]==actor:self.states.pop(k)
   for k in list(self.state_events):
    if actor is None or k[0]==actor:self.state_events.pop(k)
 def consume(self,msg):
  self._ids(msg);rows=[];groups=[];resource_rows=[]
  def walk(m,path,actor,initial):
   fields=m.DESCRIPTOR.fields_by_name
   if 'guid' in fields and m.HasField('guid'):actor=self.guids.get(m.guid,actor)
   initial=initial or m.DESCRIPTOR.name=='AreaCreateEntityMsg'
   if m.DESCRIPTOR.name=='PropItem':
    if m.HasField('eid') and m.eid:actor=hashed(m.eid)
    if m.path:path=[self.value(x) for x in m.path]
    if m.HasField('name'):path=path+[self.value(m.name)]
    path=[x for x in path if x is not None]
    if len(path)>=2 and path[:2]==['buffs_data','res_changed_record']:
     resource_rows.append({'target':actor,'path':path,'oper':m.oper,'hasValue':m.HasField('value'),'hasDict':m.HasField('dict'),'value':self.value(m.value) if m.HasField('value') else None})
    if len(path)>=2 and path[:2] in (['buffs_data','ac_buffs'],['buffs_data','oc_buffs']):
     r={'targetActorHash':actor,'targetClass':self.classes.get(actor),'initial':initial,'path':path,'oper':m.oper,'hasValue':m.HasField('value'),'hasDict':m.HasField('dict')}
     if r['hasValue']:r['value']=self.value(m.value)
     if len(path)==2 and not initial and not r['hasDict']:
      self.invalidate('unresolved_bag_operation_'+str(m.oper),actor)
     rows.append(r)
   for f,v in m.ListFields():
    if f.type==f.TYPE_MESSAGE:
     for sub in (v if f.is_repeated else [v]):walk(sub,path,actor,initial)
  walk(msg,[],None,False)
  def key(r):
   x=r['path'][2];return (r['targetActorHash'],r['path'][1],x.get('bytesHash') if isinstance(x,dict) else str(x))
  for r in rows:
   if len(r['path'])<3:continue
   if len(r['path'])==3:groups.append({'root':r,'children':[]})
   elif groups and key(r)==key(groups[-1]['root']):groups[-1]['children'].append(r)
   else:groups.append({'root':{**r,'path':r['path'][:3],'oper':None},'children':[r]})
  out=[]
  for group in groups:
   r=group['root'];k=key(r);op=r['oper'];before=copy.deepcopy(self.states.get(k,{}));s={} if op in (11,49) else copy.deepcopy(before);changes={}
   for child in group['children']:
    suffix=child['path'][3:]
    if child['hasValue'] and len(suffix)==1 and isinstance(suffix[0],str):s[suffix[0]]=child['value'];changes[suffix[0]]=child['value']
   kind={11:'apply_candidate',12:'update',49:'snapshot',4:'remove_candidate',None:'field_patch'}.get(op,'unknown_operation')
   if any(n in changes and changes[n]!=before.get(n) for n in ('No','start_ts','duration','fromid')):
    s.pop('_resourceChangeRemaining',None)
   self.counts[kind]+=1
   if not k[0]:self.counts['unknownTarget']+=1
   if kind=='unknown_operation':self.invalidate('unknown_instance_opcode_'+str(op),k[0])
   v=before if op==4 else s
   source=v.get('fromid');source=source.get('bytesHash') if isinstance(source,dict) and source.get('length') else None
   prior=before.get('fromid');prior=prior.get('bytesHash') if isinstance(prior,dict) and prior.get('length') else None
   raw=v.get('start_ts');duration=v.get('duration');start=raw*.1+1576080000 if isinstance(raw,(int,float)) else None;seconds=duration*.1 if isinstance(duration,(int,float)) else None
   e={key:r[key] for key in ('targetActorHash','targetClass','initial')}
   e.update(kind=kind,rawOperation=op,buffInstanceHash=k[2],bag=k[1],buffNo=v.get('No'),level=v.get('level'),charge_level=v.get('charge_level'),duration=duration,durationSeconds=seconds,rawStartTimestamp=raw,startTimestampSeconds=start,nominalExpirySeconds=start+seconds if start is not None and seconds is not None and seconds>=0 else None,skill_id=v.get('skill_id'),sourceActorHash=source,sourceIdPresent=source is not None,sourceEqualsTarget=source==k[0] if source else None,sourceChanged=prior is not None and prior!=source,previousSourceActorHash=prior,completeFields=all(n in s for n in ('No','fromid','duration','start_ts')),hadKnownState=bool(before),changes=changes,attributionReady=False,appliesOnlyToSource=None,visibility='ALL_CLIENTS projection' if k[1]=='ac_buffs' else 'OWN_CLIENT projection',timingBasis='packet reception and nominal buff clock; no validated hit execution clock',semanticEvidence='Preset fields and static getters validated; lifecycle opcode labels are candidates, not authoritative ownership')
   if e['buffNo'] in self.resource_rules:self._resource_fields(e,v.get('_resourceChangeRemaining'))
   out.append(e)
   a=self.actors.setdefault(k[0],{'actorHash':k[0],'events':0,'sourcePresentEvents':0,'acEvents':0,'ocEvents':0,'hasInitialSnapshot':False})
   a['events']+=1;a['sourcePresentEvents']+=source is not None;a['acEvents' if k[1]=='ac_buffs' else 'ocEvents']+=1;a['hasInitialSnapshot']|=kind=='snapshot'
   if op==4:self.states.pop(k,None);self.state_events.pop(k,None)
   elif kind!='unknown_operation':
    self.states[k]=s
    if e['buffNo'] in self.resource_rules:self.state_events[k]=e
    else:self.state_events.pop(k,None)
  # The server publishes this counter outside ac_buffs/oc_buffs. Never infer it
  # from healing totals, nominal expiry, or a same-named buff. A counter applies
  # only when exactly one known instance on this recipient uses that resource.
  resource_changes={}
  for r in resource_rows:
   if len(r['path'])==2:
    if r['oper'] in (2,11,49):
     for resource in set(self.resource_rules.values()):resource_changes[(r['target'],resource)]=None
   elif len(r['path'])==3 and isinstance(r['path'][2],int):
    value=r['value'];valid=type(value) in (int,float) and math.isfinite(value) and value>=0
    resource_changes[(r['target'],r['path'][2])]=value if r['hasValue'] and r['oper'] in (7,8,39,40,45,49) and valid else None
  for (actor,resource),remaining in resource_changes.items():
   matches=[(k,s) for k,s in self.states.items() if k[0]==actor and self.resource_rules.get(s.get('No'))==resource]
   instances={k[2] for k,s in matches}
   if len(instances)!=1:remaining=None
   for k,s in matches:
    s['_resourceChangeRemaining']=remaining
    base=self.state_events.get(k)
    if base is None:continue
    event=copy.deepcopy(base);event.update(kind='field_patch',rawOperation=None,initial=False,changes={'res_changed_record':{str(resource):remaining}},hadKnownState=True)
    self._resource_fields(event,remaining);self.state_events[k]=event;out.append(event)
    self.counts['field_patch']+=1
    a=self.actors[k[0]];a['events']+=1;a['sourcePresentEvents']+=event['sourceIdPresent'];a['acEvents' if k[1]=='ac_buffs' else 'ocEvents']+=1
  if out:self.revision+=1
  return out
 def _resource_fields(self,event,remaining):
  event.update(resourceChangeRemaining=remaining,resourceChangeSuccess=None if remaining is None else remaining==0,resourceChangeBasis='observed res_changed_record; unique recipient buff instance')
 def coverage(self):
  return {'schemaVersion':1,'preset':SCHEMA_COUNT,'events':sum(a['events'] for a in self.actors.values()),'kinds':dict(self.counts),'actors':list(self.actors.values()),'recentInvalidations':self.invalidations,'attributionReady':False,'complete':False,'timingValidated':False,'sourceOwnershipValidated':False,'snapshotValidated':False,'privateBuffCoverageComplete':False,'aoiClosureValidated':False,'lifecycleOpcodesValidated':False,'limits':['Public visibility does not prove complete teammate private state.','Removal/clear and AOI closure semantics remain unvalidated; absence is never zero gain.','Provider changes are observations; historical stack ownership remains unknown.','Nominal expiry is not authoritative execution time; never expire for attribution by receive clock.']}
