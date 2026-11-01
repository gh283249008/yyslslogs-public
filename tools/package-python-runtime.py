"""Pack the verified CPython runtime without pip, caches or development tools."""
import pathlib,sys,zipfile,shutil,subprocess
source=pathlib.Path(sys.argv[1]);target=pathlib.Path(sys.argv[2])
# Accept a full install or an already isolated, verified runtime.
stdlib=source/'Lib'
archive=source/'python312.zip'
required={'encodings/__init__.py','codecs.py','json/__init__.py'}
if not (stdlib/'encodings/__init__.py').is_file():
 if not archive.is_file():raise RuntimeError('Missing Python standard library')
 with zipfile.ZipFile(archive) as z:
  if not required.issubset(z.namelist()) or z.testzip():raise RuntimeError('Incomplete Python standard library archive')
target.mkdir(parents=True,exist_ok=False)
for name in ('python.exe','python3.dll','python312.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt'):
 shutil.copy2(source/name,target/name)
shutil.copytree(source/'DLLs',target/'DLLs',ignore=shutil.ignore_patterns('__pycache__','*.pdb','*.lib','*.exp','*.pyc'))
excluded={'site-packages','test','tests','__pycache__','idlelib','tkinter','ensurepip','turtledemo'}
if (stdlib/'encodings/__init__.py').is_file():
 with zipfile.ZipFile(target/'python312.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for p in sorted((source/'Lib').rglob('*')):
   rel=p.relative_to(source/'Lib')
   if p.is_file() and not any(part in excluded for part in rel.parts) and p.suffix in ('.py','.txt','.json','.pem'):
    z.write(p,rel.as_posix())
else:
 shutil.copy2(archive,target/'python312.zip')
# Isolate the interpreter from the recipient's registry and Python environment.
(target/'python312._pth').write_text('python312.zip\n.\nDLLs\n../../tools\n../../evidence/p0/runtime-rpc-analysis/pydeps\n',encoding='ascii')

subprocess.run([str((target/"python.exe").resolve()),"-B","-X","utf8","-c","import encodings,ctypes,zlib,hashlib,json; print(\"packaged Python ready\")"],check=True)
