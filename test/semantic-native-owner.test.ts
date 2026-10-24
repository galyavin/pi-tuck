import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtempSync,mkdirSync,readdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createSemanticRecall,semanticEligibleSources,type NativeOwnerInputControl,type SemanticRecallController} from '../src/semantic-recall';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
const roots:string[]=[],owners:SemanticRecallController[]=[],calls:{path:string;args:readonly string[];child:Helper}[]=[];
const final=(exitCode:number|null=0)=>JSON.stringify({op:'settled',activeProcesses:0,exitCode})+'\n';
interface Launch {executable:string;args:string[];cwd:string;env:Record<string,string>;input?:string;stdinMode:string;jobId:string;}
interface RPC {id:number;op:string;path?:string;}
// Transport/resource doubles only, NOT native Windows Job/OS qualification.
class Helper extends EventEmitter {
 readonly stdout=new PassThrough();readonly stderr=new PassThrough();pid:number|undefined=4321;
 launch?:Launch;raw='';buffer='';closed=false;autoCancel=true;hangReady=false;hangRpc=false;
 controls:NativeOwnerInputControl[]=[];requests:RPC[]=[];
 readonly stdin=new Writable({write:(chunk:Buffer,_encoding,done)=>{
  this.raw+=chunk.toString();this.buffer+=chunk.toString();let end:number;
  while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
   if(!this.launch){this.launch=JSON.parse(line);continue;}
   const control=JSON.parse(line) as NativeOwnerInputControl;this.controls.push(control);
   if(control.op==='cancel'){if(this.autoCancel)setImmediate(()=>this.settle(1));continue;}
   const bytes=Buffer.from(control.input,'base64');expect(bytes.length).toBeLessThanOrEqual(1048576);expect(line.length+1).toBeLessThanOrEqual(2*1048576);
   const rpc=JSON.parse(bytes.toString()) as RPC;this.requests.push(rpc);if(this.hangRpc||this.hangReady&&rpc.op==='ready')continue;
   let result:unknown={};if(rpc.op==='ready')result={identity:'protocol-fixture',dimensions:768,maxTokens:8192,offline:true};
   if(rpc.op==='tokenize')result={ranges:[[]]};
   if(rpc.op==='index'){if(rpc.path){mkdirSync(dirname(rpc.path),{recursive:true});writeFileSync(rpc.path,'owned derived data');}result={coveredKeys:[],rows:[]};}
   setImmediate(()=>{if(!this.closed)this.stdout.write(JSON.stringify({id:rpc.id,ok:true,result})+'\n');});
  }done();
 }});
 close(code=0,signal:NodeJS.Signals|null=null){if(this.closed)return;this.closed=true;this.stdin.destroy();this.stdout.end();this.stderr.end();this.emit('close',code,signal);}
 settle(code:number|null=0){if(!this.closed){this.stderr.write(final(code));this.close();}}
 kill=vi.fn(()=>{this.close(1);return true;});
}
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'pi-semantic-owner-'));roots.push(root);
 const project=join(root,'project');mkdirSync(project);
 const config={pythonPath:join(root,'python'),runtimeRoot:join(root,'runtime'),indexDirectory:join(root,'cache'),nativeOwnerHelperPath:join(root,'verified-helper'),queryWaitMs:2000};
 const sessionManager=SessionManager.inMemory(project);sessionManager.appendMessage({role:'user',content:'Original permitted evidence.',timestamp:1});sessionManager.appendCompaction('summary of what was cut','no-such-entry',100,undefined,true); // out of view: a search waits for the source
 const provider=()=>semanticEligibleSources({cwd:project,sessionManager},{},()=>{});
 const c=createSemanticRecall(config);owners.push(c);return{root,project,config,provider,c};
}
async function started(index=0){await vi.waitFor(()=>expect(calls.length).toBeGreaterThan(index));return calls[index]!;}
async function prepared(){const f=fixture();f.c.enable();expect((await f.c.search('evidence',f.provider)).status).toBe('no_matches');return{...f,h:calls[0]!.child};}
async function held(f:Awaited<ReturnType<typeof prepared>>,closing:Promise<void>){let finished=false;void closing.finally(()=>{finished=true;}).catch(()=>{});await new Promise(done=>setTimeout(done,35));expect(finished).toBe(false);expect(existsSync(f.h.launch!.cwd)).toBe(true);expect(readdirSync(f.config.indexDirectory)).toHaveLength(1);expect(()=>f.c.enable()).toThrow('cleanup is unresolved');}
beforeEach(()=>{Object.defineProperty(process,'platform',{value:'win32'});calls.length=0;vi.mocked(spawn).mockImplementation((path,args)=>{const child=new Helper();calls.push({path,args:args as string[],child});return child as unknown as ChildProcessWithoutNullStreams;});});
afterEach(async()=>{
 vi.useRealTimers();vi.mocked(spawn).mockImplementation((path,args)=>{const child=new Helper();calls.push({path,args:args as string[],child});queueMicrotask(()=>child.settle());return child as unknown as ChildProcessWithoutNullStreams;});
 for(const {child} of calls)child.settle();await Promise.all(owners.splice(0).map(c=>c.close()));
 Object.defineProperty(process,'platform',platform);vi.restoreAllMocks();vi.unstubAllEnvs();vi.mocked(spawn).mockReset();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});
});
test('Windows requires explicit verified ownership before spawn/scratch; source stays exact',async()=>{
 const f=fixture(),{nativeOwnerHelperPath:_unused,...config}=f.config;f.c.configure(config);const original=f.provider();
 f.c.enable();expect((await f.c.search('evidence',f.provider)).status).toBe('unavailable');expect(f.c.status().lastError).toContain('nativeOwnerHelperPath');expect(spawn).not.toHaveBeenCalled();expect(readdirSync(f.root)).toEqual(['project']);expect(f.provider().id).toBe(original.id);
});
test('OS spawn rejection starts no Job; semantic failure cleans scratch without an impossible join',async()=>{
 const f=fixture();f.c.enable();
 vi.mocked(spawn).mockImplementation((path,args,options)=>{
  const child=new Helper();child.pid=undefined;calls.push({path,args:args as string[],child});
  expect(options?.env).not.toHaveProperty('OPENAI_API_KEY');
  queueMicrotask(()=>{child.emit('error',new Error('could not start'));child.close(-2);});
  return child as unknown as ChildProcessWithoutNullStreams;
 });
 vi.stubEnv('OPENAI_API_KEY','unselected-provider-test-value');
 try { expect((await f.c.search('evidence',f.provider)).status).toBe('unavailable');await f.c.close();
  expect(calls).toHaveLength(1);expect(existsSync(calls[0]!.child.launch!.cwd)).toBe(false);
 } finally { vi.unstubAllEnvs(); }
});
test('persistent RPC uses actual stream launch/full fields and only native framed close frees scratch/index',async()=>{
 const f=await prepared(),kill=vi.spyOn(process,'kill'),original=f.provider();
 expect(calls[0]).toMatchObject({path:f.config.nativeOwnerHelperPath,args:['--run']});
 expect(f.h.launch).toMatchObject({executable:f.config.pythonPath,args:expect.arrayContaining(['-I','-B','-u']),cwd:expect.any(String),env:{PI_SEMANTIC_RUNTIME_ROOT:f.config.runtimeRoot},stdinMode:'stream',jobId:expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)});
 expect(Buffer.byteLength(f.h.raw.split('\n')[0]!+'\n')).toBeLessThan(2*1048576);expect(f.h.launch!.input).toBeUndefined();expect(f.h.stdin.writableEnded).toBe(false);
 expect(f.h.requests.map(r=>r.op)).toContain('ready');expect(f.h.requests.map(r=>r.op)).toContain('index');
 f.h.stderr.write(JSON.stringify({op:'stderr',data:Buffer.from(final()).toString('base64')})+'\n');
 f.h.autoCancel=false;const closing=f.c.close();await held(f,closing);
 expect(f.h.controls.at(-1)).toEqual({op:'cancel'});f.h.stderr.write(final(4294967295));await held(f,closing);f.h.close();await closing;
 expect(existsSync(f.h.launch!.cwd)).toBe(false);expect(readdirSync(f.config.indexDirectory)).toEqual([]);expect(kill).not.toHaveBeenCalled();expect(f.provider().id).toBe(original.id);
});
test('Windows worker and helper preserve OS values with one case-insensitive environment name',async()=>{
 const systemRoot='C:\\Windows';
 for(const name of ['SystemRoot','SYSTEMROOT','WINDIR'])vi.stubEnv(name,systemRoot);
 vi.stubEnv('LANG','en_US.UTF-8');vi.stubEnv('LC_ALL','en_US.UTF-8');
 const f=await prepared(),helperEnv=vi.mocked(spawn).mock.calls[0]![2]!.env!;
 for(const env of [helperEnv,f.h.launch!.env]){
  const names=Object.keys(env).map(name=>name.toUpperCase());expect(new Set(names).size).toBe(names.length);
  expect(env).toMatchObject({SYSTEMROOT:systemRoot,WINDIR:systemRoot,LANG:'en_US.UTF-8',LC_ALL:'en_US.UTF-8'});
 }
 f.h.close(1);const closing=f.c.close(),joiner=await started(1);
 expect(vi.mocked(spawn).mock.calls[1]![2]!.env).toEqual({SYSTEMROOT:systemRoot});
 joiner.child.settle(null);await closing;
 expect(existsSync(f.h.launch!.cwd)).toBe(false);expect(readdirSync(f.config.indexDirectory)).toEqual([]);
});
test('safe diagnostics around native zero preserve operation failure without discarding joined cleanup',async()=>{
 const f=await prepared(),worker=(f.c as unknown as {worker:{call:(op:string)=>Promise<unknown>}}).worker;
 f.h.hangRpc=true;const pending=worker.call('probe'),rejected=expect(pending).rejects.toThrow(/Local worker (closed|stopped)/);
 await vi.waitFor(()=>expect(f.h.requests.at(-1)?.op).toBe('probe'));
 const diagnostic=JSON.stringify({version:1,ok:false,error:{code:'RUN_SETTLEMENT',message:'Input pipe closed.'}})+'\n';
 f.h.stderr.write(diagnostic+final(1)+diagnostic);f.h.close(1);await rejected;
 const closing=f.c.close();await new Promise(done=>setImmediate(done));
 expect(calls).toHaveLength(1);await closing;
 expect(existsSync(f.h.launch!.cwd)).toBe(false);expect(readdirSync(f.config.indexDirectory)).toEqual([]);
});
test('a transient diagnostic cannot discard a later exact native join zero',async()=>{
 const f=await prepared();f.h.close(1);const closing=f.c.close(),joiner=await started(1);
 const diagnostic=JSON.stringify({version:1,ok:false,error:{code:'RUN_SETTLEMENT',message:'Query was temporarily unavailable.'}})+'\n';
 joiner.child.stderr.write(diagnostic+final(null));joiner.child.close();
 let joined=false;void closing.then(()=>{joined=true;});await vi.waitFor(()=>expect(joined).toBe(true),{timeout:1000});
 expect(joiner.child.kill).not.toHaveBeenCalled();expect(calls).toHaveLength(2);
 expect(existsSync(f.h.launch!.cwd)).toBe(false);expect(readdirSync(f.config.indexDirectory)).toEqual([]);
});
test.each([
 '', '{"op":"settled","activeProcesses":0}\n',
 '{"op":"settled","activeProcesses":1,"exitCode":0}\n',
 '{"op":"settled","activeProcesses":0,"exitCode":-1}\n',
 '{"op":"settled","activeProcesses":0,"exitCode":0,"extra":true}\n',
 '{"op":"settled","activeProcesses":1,"activeProcesses":0,"exitCode":0}\n',
 '{"op":"stderr","data":"Zh=="}\n',
 JSON.stringify({op:'stderr',data:Buffer.alloc(32769).toString('base64')})+'\n',
 Buffer.from([255,10]),final()+final(),final().trimEnd(),'x'.repeat(65537),
])('crash/invalid native frame keeps custody through failed exact-UUID joins',async frame=>{
 const f=await prepared();f.h.autoCancel=false;
 if(frame)f.h.stderr.write(frame);f.h.close(1);const closing=f.c.close();
 const joiner=await started(1);expect(joiner).toMatchObject({path:f.config.nativeOwnerHelperPath,args:['--join-job']});expect(JSON.parse(joiner.child.raw)).toEqual({jobId:f.h.launch!.jobId});await held(f,closing);
 joiner.child.stderr.write(JSON.stringify({version:1,ok:false,error:{code:'RUN_SETTLEMENT',message:'Named absence is unknown.'}})+'\n');joiner.child.close(1);
 const retry=await started(2);expect(JSON.parse(retry.child.raw)).toEqual({jobId:f.h.launch!.jobId});await held(f,closing);retry.child.settle(null);await closing;
 expect(existsSync(f.h.launch!.cwd)).toBe(false);expect(readdirSync(f.config.indexDirectory)).toEqual([]);
});
test('native RPC delivery is reply-gated: two caller slots never blindly enqueue three native inputs',async()=>{
 const f=await prepared(),worker=(f.c as unknown as {worker:{call:(op:string)=>Promise<unknown>}}).worker;f.h.hangRpc=true;
 const before=f.h.requests.length,first=worker.call('probe'),second=worker.call('probe');
 await vi.waitFor(()=>expect(f.h.requests.length).toBe(before+1));await expect(worker.call('probe')).rejects.toThrow('concurrency bound');
 const a=f.h.requests.at(-1)!;f.h.stdout.write(JSON.stringify({id:a.id,ok:true,result:{one:true}})+'\n');await expect(first).resolves.toEqual({one:true});
 expect(f.h.requests.length).toBe(before+2);const b=f.h.requests.at(-1)!;f.h.stdout.write(JSON.stringify({id:b.id,ok:true,result:{two:true}})+'\n');await expect(second).resolves.toEqual({two:true});await f.c.close();
});
test('deadline forces close, never releases unknown custody; exact native retry alone frees it',async()=>{
 const f=await prepared();f.h.autoCancel=false;vi.useFakeTimers();const closing=f.c.close();await vi.advanceTimersByTimeAsync(5001);expect(f.h.kill).toHaveBeenCalled();expect(calls[1]!.args).toEqual(['--join-job']);expect(existsSync(f.h.launch!.cwd)).toBe(true);
 calls[1]!.child.close(1);await vi.advanceTimersByTimeAsync(251);expect(calls[2]!.args).toEqual(['--join-job']);expect(existsSync(f.h.launch!.cwd)).toBe(true);calls[2]!.child.settle(null);await closing;vi.useRealTimers();expect(existsSync(f.h.launch!.cwd)).toBe(false);
});
test('caller abort cancels pending RPC, joins native frames and performs no inference',async()=>{
 const f=fixture(),controller=new AbortController();f.c.enable();
 // Set hangReady before the asynchronous start creates its helper.
 vi.mocked(spawn).mockImplementation((path,args)=>{const child=new Helper();child.hangReady=true;calls.push({path,args:args as string[],child});return child as unknown as ChildProcessWithoutNullStreams;});
 const searching=f.c.search('evidence',f.provider,controller.signal),rejected=expect(searching).rejects.toMatchObject({name:'AbortError'});const run=await started();await vi.waitFor(()=>expect(run.child.requests.length).toBe(1));controller.abort();await rejected;await f.c.close();expect(run.child.controls.at(-1)).toEqual({op:'cancel'});expect(existsSync(run.child.launch!.cwd)).toBe(false);expect(f.c.status().operations).toEqual({preparationEmbeddings:0,queryEmbeddings:0});
});
test('external standalone settings retain admission; current-runtime override selects only current helper',async()=>{
 const f=fixture(),path=join(f.root,'external.json'),current=join(f.root,'current-helper');writeFileSync(path,JSON.stringify({...f.config,nativeOwnerHelperPath:join(f.root,'old-helper')}));
 await f.c.configureExternal(f.project,path,{nativeOwnerHelperPath:current});f.c.enable();await f.c.search('evidence',f.provider);expect(calls[0]!.path).toBe(current);await f.c.close();
 await f.c.configureExternal(f.project,path);f.c.enable();await f.c.search('evidence',f.provider);expect(calls[1]!.path).toBe(join(f.root,'old-helper'));await f.c.close();
 await expect(f.c.configureExternal(f.project,path,{nativeOwnerHelperPath:join(f.project,'helper')})).rejects.toThrow('outside project');
 for(const nativeOwnerHelperPath of ['', 'relative', 42])await expect(f.c.configureExternal(f.project,path,{nativeOwnerHelperPath:nativeOwnerHelperPath as string})).rejects.toThrow();
 const inside=join(f.project,'settings.json');writeFileSync(inside,JSON.stringify(f.config));await expect(f.c.configureExternal(f.project,inside,{nativeOwnerHelperPath:current})).rejects.toThrow('outside project');
});
