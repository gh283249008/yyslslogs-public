"""Server Avatar ID -> base.nickname only; never pet or social display names."""
from p1_encounter_identity import properties, actor_hash, scalar
from p1_schema_profile import schema_index, SCHEMA_COUNT

NICKNAME_PATH=(schema_index('base'),schema_index('nickname'))
NAME_INDEX=schema_index('name')
ROSTER_PATHS={
 (schema_index('team'),schema_index('players_base')):'team.players_base',
 (schema_index('loading_data'),schema_index('player_data')):'loading_data.player_data',
}

class IdentityStream:
 def __init__(self): self.guids={}; self.names={}
 def consume(self,msg):
  out=self._consume(msg)
  typ=msg.DESCRIPTOR.name
  if typ=='AoiProp':items=msg.props
  elif typ=='AreaCreateEntityMsg':items=msg.props.props
  else:return out
  for path,value,op in properties(items):
   if len(path)!=4 or path[:2] not in ROSTER_PATHS or path[3]!=NICKNAME_PATH[1]:continue
   if not isinstance(path[2],bytes) or not 0<len(path[2])<=256 or not isinstance(value,bytes):continue
   try:name=value.decode('utf8')
   except UnicodeDecodeError:continue
   if not name.strip() or len(value)>256 or any(ord(x)<32 or ord(x)==127 for x in name):continue
   actor=actor_hash(path[2])
   if self.names.get(actor)==name:continue
   self.names[actor]=name
   source=ROSTER_PATHS[path[:2]]
   out.append({'idHash':actor,'name':name,'nameSource':'wire.'+source+'.nickname','identityEvidence':{'preset':SCHEMA_COUNT,'path':source+'.[actorId].nickname','actorIdFromDictionaryKey':True}})
  return out
 def _consume(self,msg):
  typ=msg.DESCRIPTOR.name
  if typ=='SpaceData':return self.combat_names(msg)
  if typ=='AreaCreateEntityMsg':
   self.guids.pop(msg.guid,None)
   if msg.name!=b'Avatar':return []
   actor=actor_hash(msg.id);self.guids[msg.guid]=actor;items=msg.props.props
  elif typ=='AoiProp' and msg.guid in self.guids:
   actor=self.guids[msg.guid];items=msg.props
  elif typ=='AoiGuid':
   for guid in list(msg.leave)+list(msg.remove):self.guids.pop(guid,None)
   return []
  else:return []
  out=[]
  for path,value,op in properties(items):
   if path!=NICKNAME_PATH or not isinstance(value,bytes):continue
   try:name=value.decode('utf8')
   except UnicodeDecodeError:continue
   if not name.strip() or len(value)>256 or any(ord(x)<32 or ord(x)==127 for x in name):continue
   if self.names.get(actor)==name:continue
   self.names[actor]=name
   out.append({'idHash':actor,'name':name,'nameSource':'wire.avatar.base.nickname','identityEvidence':{'preset':SCHEMA_COUNT,'propertyIndexes':list(NICKNAME_PATH),'entityClass':'Avatar','message':typ}})
  return out
 def combat_names(self,msg):
  out=[]
  def walk(m,path=()):
   if m.DESCRIPTOR.name=='PropItem':
    if m.path:path=tuple(scalar(v) for v in m.path)
    if m.HasField('name'):path+=(scalar(m.name),)
    if len(path)==5 and path[0]==b'combat_stat' and path[2] in (b'combat_stat_detail',b'own_skill_detail') and isinstance(path[3],bytes) and path[4]==NAME_INDEX and m.HasField('value'):
     value=scalar(m.value)
     if isinstance(value,bytes):
      try:name=value.decode('utf8')
      except UnicodeDecodeError:name=''
      actor=actor_hash(path[3])
      if name.strip() and len(value)<=256 and not any(ord(x)<32 or ord(x)==127 for x in name) and self.names.get(actor)!=name:
       self.names[actor]=name
       out.append({'idHash':actor,'name':name,'nameSource':'wire.combat_stat_detail.name','identityEvidence':{'preset':SCHEMA_COUNT,'path':'combat_stat.*.'+path[2].decode()+'.[actorId].name','actorIdFromDictionaryKey':True}})
   for f,v in m.ListFields():
    if f.type==f.TYPE_MESSAGE:
     for x in (v if f.is_repeated else [v]):walk(x,path)
  walk(msg)
  return out
