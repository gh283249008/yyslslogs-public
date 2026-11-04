"""Hash-bound property dictionaries; historical replays retain the legacy map."""
import pathlib,json,hashlib,os
ROOT=pathlib.Path(__file__).resolve().parents[1]
LEGACY_INDEX_SHA='b274d7be7fecfdd1fa94532d818c07ccdba1d56d35f2e6bd9845a41fa9f052d6'
BUILD_SHA=os.environ.get('YYSLS_CLIENT_BUILD_SHA256','').lower()
catalog=json.loads((ROOT/'config/schema-profiles.json').read_text(encoding='utf-8'))
profile_id=catalog['byClientSha256'].get(BUILD_SHA)
external=os.environ.get('YYSLS_VERIFIED_SCHEMA') if BUILD_SHA else None
if profile_id is None and external:
 spec=json.loads(external)
 if spec['clientBuildSha256']!=BUILD_SHA:raise ValueError('Verified schema client mismatch')
 profile_id=spec['id'];catalog['profiles'][profile_id]=spec
if profile_id is None:
 if BUILD_SHA:raise ValueError('Unsupported client hash for property schema')
 profile_id=catalog['legacyReplayProfileId']
PROFILE=catalog['profiles'][profile_id]
INDEX=ROOT/PROFILE['file']
INDEX_SHA=PROFILE['sha256']
data=INDEX.read_bytes()
if hashlib.sha256(data).hexdigest()!=INDEX_SHA:raise ValueError('Property schema dictionary hash mismatch')
rows=json.loads(data)['rows']
NAMES={r['index']:r['name'] for r in rows}
if len(NAMES)!=len(rows):raise ValueError('Duplicate property schema index')
SCHEMA_COUNT=PROFILE['count']
if any(not isinstance(i,int) or not 0<=i<SCHEMA_COUNT for i in NAMES):raise ValueError('Property schema index out of bounds')
def schema_index(name):
 matches=[i for i,n in NAMES.items() if n==name]
 if len(matches)!=1:raise ValueError('Missing or ambiguous property schema name: '+name)
 return matches[0]
def schema_metadata():
 return dict(id=profile_id,clientBuildSha256=BUILD_SHA or None,count=SCHEMA_COUNT,file=PROFILE['file'],sha256=INDEX_SHA,legacyReplayFallback=not bool(BUILD_SHA))
