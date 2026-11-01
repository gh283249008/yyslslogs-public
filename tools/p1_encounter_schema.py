"""Passive schema projection using the selected client's validated names.

Evidence: encounter-retest/index-names.json; static local-dungeon main/36;
party-retest record 2248/3115/14476. Timings remain packet receive times.
"""
import hashlib
from p1_encounter_identity import EncounterIdentity
from p1_schema_profile import schema_index, SCHEMA_COUNT

BATTLE_STATE_PATH=[schema_index('dungeon'),schema_index('is_in_boss_battle')]
FINISH_PATH=[schema_index('dungeon'),schema_index('dungeon_finish')]

class EncounterSchema:
 def __init__(self):
  self.spaces={}
  self.states={}
  self.identity=EncounterIdentity()

 def consume(self,msg):
  identity_events=self.identity.consume(msg)
  typ=msg.DESCRIPTOR.name
  initial=typ=='AreaCreateEntityMsg'
  if initial:
   if msg.name!=b'SpaceData':return identity_events
   space_hash=hashlib.sha256(msg.id).hexdigest()[:16]
   self.spaces[msg.guid]={'hash':space_hash,'id':bytes(msg.id)}
   props=msg.props.props
   guid=msg.guid
  elif typ=='AoiProp' and msg.guid in self.spaces:
   guid=msg.guid;props=msg.props;space_hash=self.spaces[guid]['hash']
  else:return identity_events
  out=list(identity_events)
  def key(v):
   return v.sindex if v.HasField('sindex') else None
  def walk(item,parent):
   if item.HasField('eid') and bytes(item.eid)!=self.spaces[guid]['id']:return
   path=[key(x) for x in item.path] if item.path else list(parent)
   if item.HasField('name'):path.append(key(item.name))
   path=[x for x in path if x is not None]
   # Only a received completion update is evidence for this encounter. A
   # completed instance's initial snapshot must not label a later pull.
   if path==FINISH_PATH and not initial and item.HasField('value'):
    val=item.value
    if (val.HasField('ivalue') and val.ivalue==1) or (val.HasField('bvalue') and val.bvalue):
     out.append({'kind':'dungeon-completed','spaceHash':space_hash,'identityContext':self.identity.context(self.identity.spaces[space_hash]),'initial':False,'propertyPath':['dungeon','dungeon_finish'],'propertyIndexes':list(FINISH_PATH),'preset':SCHEMA_COUNT})
   if path==BATTLE_STATE_PATH and item.HasField('value'):
    val=item.value
    active=bool(val.bvalue) if val.HasField('bvalue') else bool(val.ivalue) if val.HasField('ivalue') and val.ivalue in (0,1) else None
    if active is not None:
     prev=self.states.get(space_hash)
     if initial or prev is None or active!=prev:
      context=self.identity.context(self.identity.spaces[space_hash])
      out.append({'kind':'boss-battle-state','active':active,'initial':initial,'previousActive':prev,'stateChanged':prev is not None and active!=prev,'spaceHash':space_hash,'identityContext':context,'propertyPath':['dungeon','is_in_boss_battle'],'propertyIndexes':list(BATTLE_STATE_PATH),'preset':SCHEMA_COUNT,'timingBasis':'server_state_received; packet reception, not a server event timestamp'})
     self.states[space_hash]=active
   if item.HasField('dict'):
    for sub in item.dict.item:walk(sub,path)
  for item in props:walk(item,[])
  return out

