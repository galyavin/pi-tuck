#!/usr/bin/env python3
"""One session-owned native encoder; tokenizer offsets and SQLite remain local utilities."""
import os,sys,json,pathlib,sqlite3,math,struct,subprocess,signal,time,socket,http.client,runpy,secrets
RUNTIME=runpy.run_path(str(pathlib.Path(__file__).with_name('eg2-runtime.py')))
ROOT=pathlib.Path(os.environ['PI_SEMANTIC_RUNTIME_ROOT']).resolve()
PINS=RUNTIME['read_json'](ROOT/'pins.json')
IDENTITY=RUNTIME['configuration_identity'](ROOT,__file__)
class Refusal(Exception):pass
verified=False;tokenizer=None;server=None
# Only Windows uses TCP. Never publish the token in config, files, argv or replies.
WINDOWS=os.name=='nt';encoder_port=None;encoder_token=None
class LocalHTTP(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.settimeout(self.timeout);self.sock.connect('encoder.sock')
def request(path,data=None):
 if path not in ('/health','/props','/v1/embeddings'):raise Refusal('native_path_failure')
 if WINDOWS:
  if encoder_port is None or not encoder_token:raise Refusal('native_transport_unavailable')
  connection=http.client.HTTPConnection('127.0.0.1',encoder_port,timeout=55)
 else:connection=LocalHTTP('localhost',timeout=55)
 try:
  headers={'Content-Type':'application/json'}
  if WINDOWS:headers['Authorization']='Bearer '+encoder_token
  body=None if data is None else json.dumps(data).encode();connection.request('GET' if data is None else 'POST',path,body,headers)
  response=connection.getresponse();payload=response.read(16*1024*1024+1)
  if len(payload)>16*1024*1024:raise Refusal('native_response_bound')
  if response.status!=200:raise Refusal('native_request_failure')
  return json.loads(payload)
 finally:connection.close()
def native_executable():
 executable=ROOT/('native/llama-server.exe' if WINDOWS else 'native/llama-server')
 # A target mismatch cannot select an unmanifested executable.
 if executable.relative_to(ROOT).as_posix() not in RUNTIME['read_json'](ROOT/'assets.sha256.json'):raise Refusal('native_target_failure')
 return executable
def verify():
 global verified,PINS,IDENTITY
 if verified:return
 try:
  RUNTIME['python_supported']();pins=RUNTIME['verify_runtime'](ROOT);native_executable();RUNTIME['verify_tokenizers'](ROOT)
  if RUNTIME['configuration_identity'](ROOT,__file__)!=IDENTITY:raise ValueError('runtime_changed_before_readiness')
 except ValueError as error:raise Refusal(str(error))
 PINS=pins;verified=True
def tok():
 global tokenizer
 if tokenizer is None:
  verify();from tokenizers import Tokenizer
  tokenizer=Tokenizer.from_file(str(ROOT/'models/embedding/tokenizer.json'));tokenizer.no_truncation();tokenizer.no_padding()
 return tokenizer
def texts(req):
 a=req.get('texts',[])
 if not isinstance(a,list) or len(a)>24 or any(not isinstance(x,str) for x in a):raise Refusal('invalid_batch')
 return a
def framed(t,kind):
 if kind not in ('query','passage'):raise Refusal('invalid_kind')
 return PINS['embedding']['queryInstruction' if kind=='query' else 'documentInstruction']+t
def enc(t):
 ids=tok().encode(t,add_special_tokens=True).ids
 if len(ids)>8192:raise Refusal('token_limit')
 return ids
SERVER_EXIT_GRACE_S=1.5 # longer than the package's 1 s SIGKILL of the group: under its custody a slow shutdown meets that SIGKILL (no crash report), never a second SIGTERM; the terminate() below serves a signal from outside it
def close_native(signaled=False):
 global server,encoder_port,encoder_token
 if server is not None:
  # The group signal already reached llama-server; a second interrupt during its shutdown makes it abort (SIGABRT).
  if signaled:
   try:server.wait(timeout=SERVER_EXIT_GRACE_S)
   except subprocess.TimeoutExpired:pass
  if server.poll() is None:
   server.terminate()
   try:server.wait(timeout=.7)
   except subprocess.TimeoutExpired:server.kill();server.wait()
  server=None
 encoder_port=None;encoder_token=None
def terminate(signum,frame):
 close_native(True);raise SystemExit(128+signum)
for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,terminate)
def load():
 global server,encoder_port,encoder_token
 if server is None:
  verify();env={k:v for k,v in os.environ.items() if not k.startswith(('LLAMA_','GGML_'))}
  executable=native_executable()
  transport=['--host','encoder.sock']
  if WINDOWS:
   encoder_token=secrets.token_hex(32)
   # Reserve an OS-selected loopback port until immediately before launch. A bind
   # collision is a start failure, never a retry to an unauthenticated endpoint.
   with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as reservation:
    reservation.bind(('127.0.0.1',0));encoder_port=reservation.getsockname()[1]
   transport=['--host','127.0.0.1','--port',str(encoder_port)]
   # Pinned common/arg.cpp supports LLAMA_API_KEY; server-http.cpp requires Bearer
   # on /props and embeddings, but /health is public. No token in process argv.
   env['LLAMA_API_KEY']=encoder_token
  server=subprocess.Popen([str(executable),'-m',str(ROOT/'model.gguf'),'--embedding','--pooling','mean','--embd-normalize','2','--ctx-size','8192','--batch-size','8192','--ubatch-size','8192','--parallel','1','--n-gpu-layers','0','--cache-type-k','f32','--cache-type-v','f32','--flash-attn','off','--threads','4',*transport,'--no-webui','--log-disable'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=env)
  started=time.monotonic()
  while True:
   if server.poll() is not None:raise Refusal('native_start_failure')
   try:
    if request('/health').get('status')=='ok':
     if WINDOWS:request('/props') # Public health alone is not authenticated readiness.
     if server.poll() is not None:raise Refusal('native_start_failure')
     break
   except (OSError,Refusal):pass
   if time.monotonic()-started>50:raise Refusal('native_start_timeout')
   time.sleep(.02)
 return server
def run(req):
 op=req['op']
 if op=='close':close_native();return {'closed':True}
 if op=='ready':
  verify()
  return {'identity':IDENTITY,'dimensions':768,'maxTokens':8192,'offline':True,'dtype':PINS['embedding']['dtype'],'computePrecision':'float32','pythonVersion':list(sys.version_info[:3]),'model':PINS['embedding']}
 if op=='tokenize':
  a=texts(req);kind=req.get('kind','passage')
  if req.get('split'):
   if kind!='passage':raise Refusal('query_split_forbidden')
   result=[]
   for t in a:
    offsets=tok().encode(t,add_special_tokens=False).offsets;ranges=[]
    if not offsets and t:ranges.append({'start':0,'end':len(t.encode('utf-16-le'))//2,'tokens':2})
    limit=req.get('maxTokens',256);overhead=len(enc(framed('',kind)));step=limit-overhead-4
    if not 1<=step<=8192-overhead:raise Refusal('invalid_chunk_limit')
    bounds=sorted(set([0,len(t)]+[offsets[i][0] for i in range(step,len(offsets),step)]))
    for start,end in zip(bounds,bounds[1:]):
     count=len(enc(framed(t[start:end],kind)))
     if count>limit:raise Refusal('chunk_token_limit')
     ranges.append({'start':len(t[:start].encode('utf-16-le'))//2,'end':len(t[:end].encode('utf-16-le'))//2,'tokens':count})
    result.append(ranges)
   return {'ranges':result,'offsetUnit':'utf16'}
  return {'counts':[len(tok().encode(framed(t,kind),add_special_tokens=True).ids) for t in a],'maxTokens':8192}
 if op=='embed':
  a=texts(req);kind=req.get('kind','passage')
  if len(a)>8:raise Refusal('batch_limit')
  ids=[enc(framed(t,kind)) for t in a]
  if not a:return {'vectors':[],'identity':IDENTITY}
  load();out=request('/v1/embeddings',{'input':ids,'encoding_format':'float','truncate':False})['data'];out.sort(key=lambda row:row['index']);vectors=[row['embedding'] for row in out]
  if len(vectors)!=len(a) or any(len(v)!=768 or any(not math.isfinite(x) for x in v) or abs(sum(x*x for x in v)**.5-1)>1e-5 for v in vectors):raise Refusal('invalid_vector')
  return {'vectors':vectors,'identity':IDENTITY,'nativePID':server.pid}
 if op=='index':return index(req)
 raise Refusal('unknown_op')
def index(r):
 path=pathlib.Path(r['path']).resolve()
 project=pathlib.Path(r.get('projectDirectory',os.getcwd())).resolve()
 if path==project or project in path.parents:raise Refusal('index_requires_external_path')
 supplied=pathlib.Path(r['path'])
 if not supplied.is_absolute() or ROOT==path or ROOT in path.parents:raise Refusal('index_requires_external_path')
 if any(part.is_symlink() for part in (supplied,*supplied.parents)):raise Refusal('index_symlink_forbidden')
 readonly=r['action'] in ('status','score')
 if readonly and not path.exists():return {'coveredKeys':[]} if r['action']=='status' else {'ranked':[],'observed':0}
 if not readonly:path.parent.mkdir(parents=True,exist_ok=True)
 db=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True) if readonly else sqlite3.connect(str(path))
 if not readonly:
  db.execute('PRAGMA max_page_count=8192')
  db.execute('PRAGMA secure_delete=ON')
 if not readonly:db.execute('CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY,entryId TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,inputSha TEXT NOT NULL,identity TEXT NOT NULL,vector BLOB NOT NULL)')
 try:
  action=r['action'];identity=r['identity']
  if action=='reconcile':
   keys=r['keys']
   if len(keys)>10000:raise Refusal('record_limit')
   allowed=set(keys)
   remove=[x[0] for x in db.execute('SELECT key,identity FROM records') if x[0] not in allowed or x[1]!=identity]
   db.executemany('DELETE FROM records WHERE key=?',[(x,) for x in remove]);out={'removed':len(remove)}
  elif action=='delete':
   keys=r['keys']
   if len(keys)>10000:raise Refusal('record_limit')
   db.executemany('DELETE FROM records WHERE key=?',[(x,) for x in keys]);out={'deleted':len(keys)}
  elif action=='upsert':
   rows=r['rows']
   if len(rows)>8:raise Refusal('batch_limit')
   for x in rows:
    v=x['vector']
    if len(v)!=768 or any(not math.isfinite(y) for y in v):raise Refusal('invalid_vector')
    if x['start']<0 or x['end']<x['start']:raise Refusal('invalid_range')
    if any(not isinstance(x[k],str) or len(x[k])>1024 for k in ('key','entryId','inputSha')) or len(identity)>1024:raise Refusal('metadata_limit')
    db.execute('INSERT OR REPLACE INTO records VALUES(?,?,?,?,?,?,?)',(x['key'],x['entryId'],x['start'],x['end'],x['inputSha'],identity,struct.pack('<768f',*v)))
   if db.execute('SELECT count(*) FROM records').fetchone()[0]>10000:raise Refusal('record_limit')
   out={'upserted':len(rows)}
  elif action=='status':
   keys=r['keys']
   if len(keys)>10000:raise Refusal('record_limit')
   out={'coveredKeys':[x[0] for x in db.execute(f"SELECT key FROM records WHERE identity=? AND key IN ({','.join('?' for _ in keys)}) ORDER BY rowid",(identity,*keys))] if keys else []}
  elif action=='score':
   # Dot product of every requested stored vector with the query, in key order: 128-key sub-batches, each in rowid order, a plain sequential float64 sum
   # (bit-identical to the node reduce this replaced; sum(), math.sumprod and numpy are not). Returns the stable top 24 by descending score, and how many rows were found.
   keys=r['keys'];query=r['query']
   if len(keys)>10000:raise Refusal('record_limit')
   if len(query)!=768 or any(not math.isfinite(y) for y in query):raise Refusal('invalid_vector')
   scored=[]
   for i in range(0,len(keys),128):
    part=keys[i:i+128]
    for x in db.execute(f"SELECT key,vector FROM records WHERE identity=? AND key IN ({','.join('?' for _ in part)}) ORDER BY rowid",(identity,*part)):
     s=0.0
     for a,b in zip(struct.unpack('<768f',x[1]),query):s+=a*b
     scored.append((x[0],s))
   scored.sort(key=lambda t:t[1],reverse=True) # reverse=True keeps equal scores in their original order
   out={'ranked':[{'key':k,'score':s} for k,s in scored[:24]],'observed':len(scored)}
  else:raise Refusal('unknown_index_action')
  db.commit();return out
 except:db.rollback();raise
 finally:db.close()
try:
 while True:
  line=sys.stdin.buffer.readline(1048577)
  if not line:break
  if len(line)>1048576 and not line.endswith(b'\n'):
   while True:
    tail=sys.stdin.buffer.readline(1048577)
    if not tail or tail.endswith(b'\n'):break
  req={}
  try:
   if len(line)>1048576:raise Refusal('input_limit')
   req=json.loads(line);result=run(req);response={'id':req.get('id'),'ok':True,'result':result}
  except Refusal as e:response={'id':req.get('id'),'ok':False,'error':{'code':str(e)}}
  except Exception:response={'id':req.get('id'),'ok':False,'error':{'code':'local_runtime_failure'}}
  print(json.dumps(response,separators=(',',':')),flush=True)
  if req.get('op')=='close':break
finally:close_native()
