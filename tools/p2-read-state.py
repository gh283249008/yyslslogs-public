"""Read-only, bounded static chain from the saved REA evidence; no scan or injection."""
import pathlib,json,sys,ctypes,datetime,hashlib
from p2_state_reader import StateReader, StateReadError
check_connection = "--check-connection" in sys.argv[2:]
q=pathlib.Path(sys.argv[1]);module=json.loads((q/'module.json').read_text(encoding='utf-8-sig'));trail=[];total=0
catalog=json.loads((pathlib.Path(__file__).resolve().parents[1]/'config/client-build.json').read_text(encoding='utf-8'))
image_hash=hashlib.sha256(pathlib.Path(module['modulePath']).read_bytes()).hexdigest()
profile=next((p for p in [catalog]+catalog.get('profiles',[]) if p['imageSha256']==image_hash),None)
if profile is None:
 supplied=json.load(sys.stdin) if not sys.stdin.isatty() else None
 if isinstance(supplied,dict) and supplied.get('imageSha256')==image_hash:profile=supplied
if profile is None:raise RuntimeError('Unsupported client build; state offsets not applied')
k=ctypes.WinDLL('kernel32',use_last_error=True);k.OpenProcess.restype=ctypes.c_void_p;k.OpenProcess.argtypes=[ctypes.c_uint32,ctypes.c_bool,ctypes.c_uint32];k.ReadProcessMemory.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.POINTER(ctypes.c_size_t)];k.CloseHandle.argtypes=[ctypes.c_void_p]
handle=k.OpenProcess(0x0410,False,module['pid'])
if not handle:raise RuntimeError('Read-only process access denied; administrator launch required')
def read(a,n,why):
 global total
 if not (65536<=a<0x7fffffffffff and 0<n<=1040) or total+n>4194304:raise RuntimeError('Bounded read rejected')
 total+=n;buf=ctypes.create_string_buffer(n);got=ctypes.c_size_t();at=datetime.datetime.now(datetime.timezone.utc).isoformat()
 if not k.ReadProcessMemory(handle,a,buf,n,ctypes.byref(got)) or got.value!=n:raise RuntimeError('Read failed')
 item={'address':hex(a),'bytes':n,'purpose':why,'atUtc':at}
 if not check_connection:
  file=q/(str(len(trail))+'.private.bin');file.write_bytes(buf.raw);item['file']=str(file)
 trail.append(item);return buf.raw
base=int(module['imageBase'],16)
reader=StateReader(read,base,profile)
result={'pid':module['pid'],'clientBuildId':profile['id'],'clientBuildSha256':image_hash,'scope':'Exact static field chain only; no scan, mutation, hook or target execution'}
try:
 result.update(reader.recover(check_connection=check_connection))
 if result['status']=='snapshot-ready':result.update(stateObject=trail[-1]['file'],snapshotAtUtc=trail[-1]['atUtc'])
except Exception as e:
 result.update(reader.context)
 result.update(status='stopped',reason=str(e) or 'Connection state validation failed')
 if isinstance(e,StateReadError):result.update(reasonCode=e.code,failure=e.details)
finally:k.CloseHandle(handle)
result['reads']=trail
(q/'rpc-state-recovery.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k not in ('reads','stateObject')}))
