import {afterEach,expect,test,vi} from 'vitest';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtempSync,mkdirSync,rmSync,existsSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createSemanticRecall,semanticEligibleSources} from '../src/semantic-recall';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
const platform=Object.getOwnPropertyDescriptor(process,'platform')!;
const roots:string[]=[];
afterEach(()=>{Object.defineProperty(process,'platform',platform);vi.restoreAllMocks();vi.mocked(spawn).mockReset();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
test.each([false,true])('POSIX leader exit is insufficient; only exact group absence releases resources (group refuses kill %s)',async stubborn=>{
 const root=mkdtempSync(join(tmpdir(),'pi-semantic-group-'));roots.push(root);
 const project=join(root,'project');mkdirSync(project);
 const config={pythonPath:join(root,'python'),runtimeRoot:join(root,'runtime'),indexDirectory:join(root,'cache'),queryWaitMs:2000};
 const child=new EventEmitter(),stdout=new PassThrough(),stderr=new PassThrough();
 const stdin=new Writable({write(chunk:Buffer,_encoding,done){
  const rpc=JSON.parse(chunk.toString()) as {id:number;op:string;path?:string};let result:unknown={};
  if(rpc.op==='ready')result={identity:'group-fixture',dimensions:768,maxTokens:8192,offline:true};
  if(rpc.op==='tokenize')result={ranges:[[]]};
  if(rpc.op==='index'){if(rpc.path){mkdirSync(dirname(rpc.path),{recursive:true});writeFileSync(rpc.path,'derived');}result={coveredKeys:[]};}
  setImmediate(()=>stdout.write(JSON.stringify({id:rpc.id,ok:true,result})+'\n'));done();
 }});
 Object.assign(child,{stdin,stdout,stderr,pid:4321});vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
 Object.defineProperty(process,'platform',{value:'linux'});
 let exists=true,leaderExited=false;
 const kill=vi.spyOn(process,'kill').mockImplementation((pid,value)=>{
  expect(pid).toBe(-4321); // Never signal/probe just the leader.
  if(value==='SIGTERM'&&!leaderExited){leaderExited=true;setImmediate(()=>child.emit('close',0,null));}
  if(value==='SIGKILL'&&!stubborn)exists=false;
  if(value===0&&!exists)throw Object.assign(new Error('No process group'),{code:'ESRCH'});
  return true;
 });
 const sessionManager=SessionManager.inMemory(project);sessionManager.appendMessage({role:'user',content:'Original source.',timestamp:1});sessionManager.appendCompaction('summary of what was cut','no-such-entry',100,undefined,true); // out of view: a search waits for the source
 const c=createSemanticRecall(config),provider=()=>semanticEligibleSources({cwd:project,sessionManager},{},()=>{});
 c.enable();expect((await c.search('source',provider)).status).toBe('no_matches');
 expect(spawn).toHaveBeenCalledWith(config.pythonPath,expect.arrayContaining(['-I','-B','-u']),expect.objectContaining({detached:true}));
 const scratch=readdirSync(root).find(name=>name.startsWith('.pi-semantic-'))!;expect(scratch).toBeTruthy();
 if(stubborn){
  await expect(c.close()).rejects.toThrow('group did not close');expect(leaderExited).toBe(true);
  expect(existsSync(join(root,scratch))).toBe(true);expect(readdirSync(config.indexDirectory)).toHaveLength(1);
  expect(()=>c.enable()).toThrow('cleanup is unresolved');exists=false;await c.close();
 }else await c.close();
 expect(kill.mock.calls.some(([,signal])=>signal==='SIGKILL')).toBe(true);
 expect(kill.mock.calls.some(([,signal])=>signal===0)).toBe(true);
 expect(existsSync(join(root,scratch))).toBe(false);expect(readdirSync(config.indexDirectory)).toEqual([]);
 expect(c.status()).toMatchObject({enabled:false,cleanupError:null});
},10000);
// T22: macOS answers EPERM for a group whose only remaining member exited and is not yet reaped (reproduced on darwin: kill(-pgid, 0) and
// SIGTERM give EPERM for a zombie-only group, ESRCH once reaped). EPERM means the group is still present: the close keeps polling to its
// bound and fails only if the group remains; any other errno still fails at once.
test.each(['transient','persistent','other'] as const)('POSIX close: EPERM from a group that is going away (%s)',async mode=>{
 const root=mkdtempSync(join(tmpdir(),'pi-semantic-eperm-'));roots.push(root);
 const project=join(root,'project');mkdirSync(project);
 const config={pythonPath:join(root,'python'),runtimeRoot:join(root,'runtime'),indexDirectory:join(root,'cache'),queryWaitMs:2000};
 const child=new EventEmitter(),stdout=new PassThrough(),stderr=new PassThrough();
 const stdin=new Writable({write(chunk:Buffer,_encoding,done){
  const rpc=JSON.parse(chunk.toString()) as {id:number;op:string;path?:string};let result:unknown={};
  if(rpc.op==='ready')result={identity:'group-fixture',dimensions:768,maxTokens:8192,offline:true};
  if(rpc.op==='tokenize')result={ranges:[[]]};
  if(rpc.op==='index'){if(rpc.path){mkdirSync(dirname(rpc.path),{recursive:true});writeFileSync(rpc.path,'derived');}result={coveredKeys:[]};}
  setImmediate(()=>stdout.write(JSON.stringify({id:rpc.id,ok:true,result})+'\n'));done();
 }});
 Object.assign(child,{stdin,stdout,stderr,pid:4321});vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
 Object.defineProperty(process,'platform',{value:'linux'});
 let leaderExited=false,zombieProbes=0,gone=false;
 const kill=vi.spyOn(process,'kill').mockImplementation((pid,value)=>{
  expect(pid).toBe(-4321);
  if(!leaderExited){if(value==='SIGTERM'){leaderExited=true;setImmediate(()=>child.emit('close',0,null));}return true;}
  // After the leader exits, only an unreaped member is left.
  if(gone)throw Object.assign(new Error('No process group'),{code:'ESRCH'});
  if(mode==='other')throw Object.assign(new Error('kill EINVAL'),{code:'EINVAL'});
  if(mode==='transient'&&value===0&&++zombieProbes>3){gone=true;throw Object.assign(new Error('No process group'),{code:'ESRCH'});}
  throw Object.assign(new Error('kill EPERM'),{code:'EPERM'});
 });
 const sessionManager=SessionManager.inMemory(project);sessionManager.appendMessage({role:'user',content:'Original source.',timestamp:1});sessionManager.appendCompaction('summary of what was cut','no-such-entry',100,undefined,true);
 const c=createSemanticRecall(config),provider=()=>semanticEligibleSources({cwd:project,sessionManager},{},()=>{});
 c.enable();expect((await c.search('source',provider)).status).toBe('no_matches');
 if(mode==='transient'){await c.close();expect(zombieProbes).toBeGreaterThan(3);expect(c.status()).toMatchObject({enabled:false,cleanupError:null});}
 else if(mode==='persistent'){
  const started=performance.now();await expect(c.close()).rejects.toThrow('group did not close');expect(performance.now()-started).toBeGreaterThanOrEqual(900); // polled to the bound, not failed at the first EPERM
  gone=true;await c.close();expect(c.status()).toMatchObject({enabled:false,cleanupError:null});
 }else{await expect(c.close()).rejects.toThrow('EINVAL');gone=true;await c.close();}
 expect(kill.mock.calls.some(([,signal])=>signal===0)).toBe(true);
},10000);
