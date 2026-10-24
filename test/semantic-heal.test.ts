import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtempSync,mkdirSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {HEAL_DELAYS_MS,HEAL_STEADY_MS,IDLE_STOP_MS,healDelayMs,SemanticRecallController,semanticEligibleSources,type SemanticPage} from '../src/semantic-recall';
vi.mock('node:child_process',()=>({spawn:vi.fn()}));
// A fake worker per spawn: it answers the controller's RPCs from a script, and the test decides when it dies.
// Its index lives in `db`, keyed by the index file path, so it survives a worker restart the way the SQLite file does.
interface Fake {child:EventEmitter;pid:number;alive:boolean;}
const fakes:Fake[]=[];
const db=new Map<string,Map<string,{key:string}>>();
const embeds={passage:0,query:0};
let readies:number[]=[]; // spawn numbers that were asked to verify themselves (`ready`)
let refusal:(spawnNumber:number)=>string|null=()=>null;
let onList:(()=>void)|undefined; // called when a ranking page is read from the index
let held:(()=>void)|undefined,holdEmbed=false,holdQuery=false,holdAfter=Infinity; // holdAfter: hold every passage batch once this many passages were embedded; holdQuery: hold the query embedding
const roots:string[]=[];
function fake(spawnNumber:number):Fake {
 const child=new EventEmitter(),stdout=new PassThrough(),stderr=new PassThrough();
 const reply=(value:object)=>queueMicrotask(()=>stdout.write(JSON.stringify(value)+'\n'));
 const stdin=new Writable({write(chunk:Buffer,_encoding,done){
  const rpc=JSON.parse(chunk.toString()) as {id:number;op:string;texts?:string[];kind?:string;action?:string;path?:string;keys?:string[];rows?:{key:string}[]};
  const code=rpc.op==='ready'?refusal(spawnNumber):null;
  if(code)reply({id:rpc.id,ok:false,error:{code}});
  else if(rpc.op==='ready'){readies.push(spawnNumber);reply({id:rpc.id,ok:true,result:{identity:'heal-fixture',dimensions:768,maxTokens:8192,offline:true}});}
  else if(rpc.op==='tokenize')reply({id:rpc.id,ok:true,result:{ranges:rpc.texts!.map(text=>[{start:0,end:text.length,tokens:3}])}});
  else if(rpc.op==='embed'){
   embeds[rpc.kind==='query'?'query':'passage']+=rpc.texts!.length;
   const answer=()=>reply({id:rpc.id,ok:true,result:{vectors:rpc.texts!.map(()=>[1,...new Array(767).fill(0)])}});
   if(((holdEmbed||embeds.passage>holdAfter)&&rpc.kind!=='query')||(holdQuery&&rpc.kind==='query'))held=answer;else answer();
  }else{ // index
   const rows=db.get(rpc.path!)??new Map<string,{key:string}>();db.set(rpc.path!,rows);let result:object={};
   if(rpc.action==='upsert'){mkdirSync(dirname(rpc.path!),{recursive:true});writeFileSync(rpc.path!,'derived');}
   if(rpc.action==='reconcile')for(const key of [...rows.keys()])if(!rpc.keys!.includes(key))rows.delete(key);
   if(rpc.action==='upsert')for(const row of rpc.rows!)rows.set(row.key,row);
   if(rpc.action==='status')result={coveredKeys:rpc.keys!.filter(key=>rows.has(key))};
   if(rpc.action==='score'){onList?.();const found=rpc.keys!.filter(key=>rows.has(key));result={ranked:found.slice(0,24).map(key=>({key,score:1})),observed:found.length};}
   reply({id:rpc.id,ok:true,result});
  }
  done();
 }});
 const entry:Fake={child,pid:7000+spawnNumber,alive:true};Object.assign(child,{stdin,stdout,stderr,pid:entry.pid});return entry;
}
const die=(entry:Fake)=>{if(!entry.alive)return;entry.alive=false;entry.child.emit('close',1,null);};
const realTick=()=>new Promise<void>(done=>setImmediate(done));
async function until(done:()=>boolean){for(let i=0;i<600&&!done();i++){await realTick();await vi.advanceTimersByTimeAsync(5);}expect(done()).toBe(true);}
async function advance(ms:number){await vi.advanceTimersByTimeAsync(ms);for(let i=0;i<40;i++){await realTick();await vi.advanceTimersByTimeAsync(5);}}
function setup(timing?:ConstructorParameters<typeof SemanticRecallController>[1]){
 const root=mkdtempSync(join(tmpdir(),'pi-semantic-heal-'));roots.push(root);
 const project=join(root,'project');mkdirSync(project);
 const config={pythonPath:join(root,'python'),runtimeRoot:join(root,'runtime'),indexDirectory:join(root,'cache'),queryWaitMs:2000};
 const sessionManager=SessionManager.inMemory(project);const append=(text:string)=>sessionManager.appendMessage({role:'user',content:text,timestamp:1});append('Original source.');
 const appendTool=(text:string)=>sessionManager.appendMessage({role:'toolResult',toolCallId:'call-'+text,toolName:'bash',content:[{type:'text',text}],isError:false,timestamp:1});
 const cut=(firstKeptEntryId:string)=>sessionManager.appendCompaction('summary of what was cut',firstKeptEntryId,100,undefined,true); cut('no-such-entry'); // the first source is out of view (a compact-all cut), so a search waits for it as it does after a cut: with nothing out of view a search no longer waits for indexing
 const controller=new SemanticRecallController(config,timing),provider=()=>semanticEligibleSources({cwd:project,sessionManager},{},()=>{});
 const events:[string,string|null][]=[];controller.onStateChange((state,reason)=>events.push([state,reason]));
 return {controller,provider,events,append,appendTool,cut,root,config};
}
/** One search, driven under the fake clock until it answers. */
async function ask(controller:SemanticRecallController,provider:()=>ReturnType<typeof semanticEligibleSources>):Promise<SemanticPage>{
 let page:SemanticPage|undefined;void controller.search('source',provider).then(value=>{page=value;});await until(()=>page!==undefined);return page!;
}
beforeEach(()=>{
 fakes.length=0;db.clear();readies=[];embeds.passage=0;embeds.query=0;held=undefined;onList=undefined;holdEmbed=false;holdQuery=false;holdAfter=Infinity;refusal=()=>null;vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date','performance']});
 vi.mocked(spawn).mockImplementation((() => {const entry=fake(fakes.length+1);fakes.push(entry);return entry.child as unknown as ChildProcessWithoutNullStreams;}) as never);
 vi.spyOn(process,'kill').mockImplementation(((pid:number,signal?:string|number)=>{
  const entry=fakes.find(candidate=>-candidate.pid===pid);if(!entry)throw Object.assign(new Error('No process group'),{code:'ESRCH'});
  if(signal===0){if(!entry.alive)throw Object.assign(new Error('No process group'),{code:'ESRCH'});return true;}
  if(signal==='SIGTERM'||signal==='SIGKILL')setImmediate(()=>die(entry));
  return true;
 }) as never);
});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.mocked(spawn).mockReset();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
/** close() under the fake clock: a preparation that is still waiting on a timer needs the clock to move before it can end. */
async function shut(controller:SemanticRecallController){let closed=false;void controller.close().then(()=>{closed=true;});await until(()=>closed);}
const retryIn=(c:SemanticRecallController)=>new Date(c.status().recovery!.retryAt!).getTime()-Date.now();
const alive=()=>fakes.filter(entry=>entry.alive).length;

test('the backoff is 5 s, 30 s, 2 min, then every 10 min; an integrity refusal is always 10 min; the idle limit is 10 min',()=>{
 expect(HEAL_DELAYS_MS).toEqual([5000,30000,120000]);expect(HEAL_STEADY_MS).toBe(600000);expect(IDLE_STOP_MS).toBe(600000);
 expect([0,1,2,3,4,9].map(attempt=>healDelayMs(attempt,false))).toEqual([5000,30000,120000,600000,600000,600000]);
 expect([0,1,2,9].map(attempt=>healDelayMs(attempt,true))).toEqual([600000,600000,600000,600000]);
 expect(healDelayMs(1,false,[1,2],7)).toBe(2);expect(healDelayMs(2,false,[1,2],7)).toBe(7);
});

test('a failed start is retried on its own at 5 s, 30 s and 2 min, then every 10 min, and the first success ends the recovery',async()=>{
 refusal=n=>n<=5?'native_start_failure':null;
 const {controller,provider,events}=setup({idleStopMs:10*3600*1000});controller.enable();
 expect((await ask(controller,provider)).status).toBe('unavailable');
 expect(fakes).toHaveLength(1);expect(controller.status().state).toBe('unavailable');expect(controller.status().lastError).toBe('Local semantic runtime: native_start_failure');
 expect(controller.status().recovery).toMatchObject({attempts:1,integrity:false});
 for(const [index,delay] of [5000,30000,120000,600000].entries()){
  const wait=retryIn(controller);expect(wait).toBeGreaterThan(delay-400);expect(wait).toBeLessThanOrEqual(delay);
  await advance(delay-1000);expect(fakes).toHaveLength(index+1); // not a moment early
  await advance(1500);await until(()=>fakes.length===index+2&&controller.status().state==='unavailable');
 }
 const wait=retryIn(controller);expect(wait).toBeGreaterThan(600000-400); // the steady cadence holds
 await advance(wait+10);await until(()=>controller.status().state==='ready');
 expect(controller.status()).toMatchObject({recovery:null,lastError:null});expect(fakes).toHaveLength(6);
 expect(events.map(([state])=>state)).toContain('unavailable');expect(events.at(-1)![0]).toBe('ready');
 await controller.close();
});

test('integrity refusals keep their reason and use the slow cadence only',async()=>{
 refusal=n=>n<=2?'tokenizers_membership_failure':null;
 const {controller,provider}=setup({idleStopMs:10*3600*1000});controller.enable();await ask(controller,provider);
 expect(controller.status().lastError).toBe('Local semantic runtime: tokenizers_membership_failure');
 expect(controller.status().recovery).toMatchObject({integrity:true});expect(retryIn(controller)).toBeGreaterThan(600000-400);
 await advance(599000);expect(fakes).toHaveLength(1); // 5 s, 30 s and 2 min pass with no attempt
 await advance(2000);await until(()=>fakes.length===2&&controller.status().state==='unavailable');
 expect(controller.status().lastError).toBe('Local semantic runtime: tokenizers_membership_failure');expect(retryIn(controller)).toBeGreaterThan(600000-400);
 await advance(601000);await until(()=>controller.status().state==='ready');expect(fakes).toHaveLength(3);
 await controller.close();
});

test('a worker that dies is replaced on its own; the state goes unavailable and back, and the callback tells each step',async()=>{
 const {controller,provider,events}=setup();controller.enable();expect((await ask(controller,provider)).status).toBe('ok');expect(fakes).toHaveLength(1);
 die(fakes[0]!);
 await until(()=>controller.status().state==='unavailable');
 expect(controller.status().lastError).toBe('Local worker stopped');expect(retryIn(controller)).toBeGreaterThan(5000-400);
 await advance(5500);await until(()=>controller.status().state==='ready');
 expect(fakes).toHaveLength(2);expect(controller.status().recovery).toBeNull();
 expect(events).toContainEqual(['unavailable','Local worker stopped']);expect(events.at(-1)![0]).toBe('ready');
 await controller.close();
});

test('enable alone revives a lost worker at once, without waiting for the backoff',async()=>{
 const {controller,provider}=setup();controller.enable();await ask(controller,provider);
 die(fakes[0]!);await until(()=>controller.status().state==='unavailable');expect(retryIn(controller)).toBeGreaterThan(4000);
 controller.enable(); // what /semantic-recall on does
 expect(controller.status().recovery).toBeNull();
 await until(()=>fakes.length===2&&controller.status().state==='ready');
 await controller.close();
});

test('while a retry waits, a turn end or a search triggers no new attempt and a search answers unavailable at once',async()=>{
 refusal=()=> 'native_start_failure';
 const {controller,provider}=setup();controller.enable();await ask(controller,provider);
 controller.schedule(provider);await advance(1000);expect(fakes).toHaveLength(1);
 expect((await ask(controller,provider)).status).toBe('unavailable');expect(fakes).toHaveLength(1);
 await controller.close();
});

test('after a success the next failure starts again at 5 s; a disable ends the recovery and its timer',async()=>{
 refusal=n=>n===1||n===3?'native_start_failure':null;
 const {controller,provider}=setup();controller.enable();await ask(controller,provider);await advance(5500);await until(()=>controller.status().state==='ready');
 die(fakes[1]!);await until(()=>controller.status().state==='unavailable');expect(retryIn(controller)).toBeGreaterThan(5000-400);
 await advance(5500);await until(()=>controller.status().state==='unavailable'&&fakes.length===3); // spawn 3 fails again
 expect(controller.status().recovery).toMatchObject({attempts:2});
 await controller.disable();expect(controller.status()).toMatchObject({state:'disabled',recovery:null});
 const spawned=fakes.length;await advance(700000);expect(fakes).toHaveLength(spawned);
});

test('refuse records why a start failed: still disabled, the reason and the event stay until the next enable',async()=>{
 const {controller,provider,events}=setup();
 controller.refuse('no verified EG-2 runtime');await realTick();
 expect(controller.status()).toMatchObject({state:'disabled',enabled:false,lastError:'no verified EG-2 runtime'});expect(events).toEqual([['disabled','no verified EG-2 runtime']]);
 controller.enable();expect(controller.status().lastError).toBeNull();
 expect((await ask(controller,provider)).status).toBe('ok');await controller.close();
});

test('the state callback fires once per change, never throws into the controller, and stops at unsubscribe',async()=>{
 const {controller,provider,events}=setup();
 const quiet=vi.fn(),stop=controller.onStateChange(quiet),late=vi.fn();controller.onStateChange(()=>{throw new Error('listener bug');});controller.onStateChange(late);
 controller.enable();await ask(controller,provider);expect(late).toHaveBeenCalled(); // a listener after the one that threw still hears each change
 expect(events.map(([state])=>state)).toEqual([...new Set(events.map(([state])=>state))]); // no repeated state in a row
 expect(events.map(([state])=>state)).toContain('ready');expect(quiet).toHaveBeenCalled();
 stop();const calls=quiet.mock.calls.length;await controller.disable();await realTick();
 expect(quiet.mock.calls.length).toBe(calls);expect(events.at(-1)![0]).toBe('disabled');
});

// ---- P7: lazy start and idle stop
test('enabling starts no worker and no indexing; a turn end starts none; the state is on (waiting) while idle',async()=>{
 const {controller,provider}=setup();controller.enable();controller.schedule(provider);
 await advance(60000);
 expect(fakes).toHaveLength(0);expect(embeds).toEqual({passage:0,query:0});expect(controller.status()).toMatchObject({enabled:true,state:'waiting',lastError:null,recovery:null,indexingComplete:false});
 await controller.close();
});

test('the first search starts the worker and builds the whole index; a turn end then embeds nothing that is still in view',async()=>{
 const {controller,provider,append}=setup();controller.enable();controller.schedule(provider);
 const page=await ask(controller,provider);
 expect(page.status).toBe('ok');expect(fakes).toHaveLength(1);expect(embeds).toEqual({passage:1,query:1});expect(controller.status()).toMatchObject({state:'ready',indexingComplete:true,coveredUnits:1});
 append('A second source, still in view.');controller.schedule(provider);await advance(1000);
 expect(embeds.passage).toBe(1); // a background turn end does not index what the agent can still see
 expect(controller.status()).toMatchObject({state:'waiting',indexingComplete:false});
 await controller.close();
});

test('right after a cut the conversation that left the view is indexed in the background; tool output waits for the next search',async()=>{
 const {controller,provider,append,appendTool,cut}=setup();controller.enable();await ask(controller,provider);expect(embeds.passage).toBe(1);
 const user=append('New conversation, then cut away.'),tool=appendTool('New tool output, then cut away.'),kept=append('Still in view.');
 void user;void tool;cut(kept);
 controller.schedule(provider);await advance(1000); // what the package does on a cut
 expect(embeds.passage).toBe(2); // the conversation unit only
 expect(controller.status().window).toMatchObject({conversation:{indexedCharacters:expect.any(Number),outOfViewCharacters:expect.any(Number)},toolResults:{indexedCharacters:0}});
 const covered=controller.status().window!;expect(covered.conversation.indexedCharacters).toBe(covered.conversation.outOfViewCharacters);expect(covered.toolResults.outOfViewCharacters).toBeGreaterThan(0);
 expect((await ask(controller,provider)).status).toBe('ok');
 await until(()=>embeds.passage===4); // the search started the tool output, and the in-view tail behind it, in the background
 await until(()=>controller.status().indexingComplete);
 const done=controller.status().window!;expect(done.toolResults.indexedCharacters).toBe(done.toolResults.outOfViewCharacters);
 await shut(controller);
});

test('with no search for the idle limit the worker stops, the index stays on disk, and a turn end does not restart it',async()=>{
 const {controller,provider,config,events}=setup();controller.enable();await ask(controller,provider);expect(alive()).toBe(1);
 await advance(IDLE_STOP_MS-5000);expect(alive()).toBe(1); // not early
 await advance(10000);
 expect(alive()).toBe(0);expect(fakes).toHaveLength(1);
 expect(controller.status()).toMatchObject({enabled:true,state:'ready',lastError:null,recovery:null,cleanupError:null});
 expect(readdirSync(config.indexDirectory).length).toBeGreaterThan(0);expect(db.size).toBe(1);
 controller.schedule(provider);await advance(30000);expect(fakes).toHaveLength(1);expect(events.every(([state])=>state!=='unavailable')).toBe(true);
 await controller.close();expect(readdirSync(config.indexDirectory)).toEqual([]);
});

test('each search restarts the idle clock',async()=>{
 const {controller,provider}=setup();controller.enable();await ask(controller,provider);
 await advance(IDLE_STOP_MS-60000);await ask(controller,provider);
 await advance(IDLE_STOP_MS-60000);expect(alive()).toBe(1); // 9 min after the second search, 18 min after the first
 await advance(120000);expect(alive()).toBe(0);
 await controller.close();
});

test('the next search restarts the worker and reuses the stored vectors: no passage is embedded again',async()=>{
 const {controller,provider}=setup();controller.enable();await ask(controller,provider);
 expect(embeds).toEqual({passage:1,query:1});const prepared=controller.status().operations.preparationEmbeddings;
 await advance(IDLE_STOP_MS+10000);expect(alive()).toBe(0);
 const page=await ask(controller,provider);
 expect(page.status).toBe('ok');expect(fakes).toHaveLength(2);expect(alive()).toBe(1);
 expect(embeds).toEqual({passage:1,query:2});expect(controller.status().operations.preparationEmbeddings).toBe(prepared);
 expect(readies).toEqual([1,2]); // the restarted worker verified itself again before any use
 expect(page.groups.length).toBeGreaterThan(0); // the stored vector was ranked
 await controller.close();
});

test('after the history grew while idle, the restart embeds only the new passages',async()=>{
 const {controller,provider,append,cut}=setup();controller.enable();await ask(controller,provider);
 await advance(IDLE_STOP_MS+10000);append('Added while idle.');cut('no-such-entry');
 expect((await ask(controller,provider)).status).toBe('ok');
 expect(embeds).toEqual({passage:2,query:2}); // the first source's vector was reused
 await controller.close();
});

test('an idle stop in the middle of indexing ends it quietly (not unavailable), and the next search resumes',async()=>{
 holdEmbed=true;
 const {controller,provider,events}=setup({idleStopMs:1000});controller.enable();
 const searching=ask(controller,provider);await until(()=>held!==undefined); // the worker is embedding a passage; the answer is held back
 await advance(8000);await searching.catch(()=>undefined);
 expect(alive()).toBe(0);expect(controller.status().state).not.toBe('unavailable');expect(controller.status().lastError).toBeNull();
 expect(events.some(([state])=>state==='unavailable')).toBe(false);
 holdEmbed=false;held=undefined;
 expect((await ask(controller,provider)).status).toBe('ok');expect(fakes).toHaveLength(2);
 await controller.close();
});

test('heal applies on demand: retries run while the session is searching, end at the idle stop, and the next search tries at once',async()=>{
 refusal=n=>n<=2?'native_start_failure':null;
 const {controller,provider}=setup({idleStopMs:20000});controller.enable();await ask(controller,provider); // spawn 1 fails; a retry is armed at 5 s
 await advance(5500);await until(()=>fakes.length===2&&controller.status().state==='unavailable'); // spawn 2 fails; the next retry is armed at 30 s
 await advance(16000); // 21 s after the last search: past the idle limit, before the 30 s retry would have fired
 expect(controller.status()).toMatchObject({state:'unavailable',recovery:{attempts:2,retryAt:null}}); // no retry is promised any more
 await advance(70000);expect(fakes).toHaveLength(2);expect(alive()).toBe(0); // and none ran
 const page=await ask(controller,provider); // demand: an attempt now, without waiting for a timer
 expect(page.status).toBe('ok');expect(fakes).toHaveLength(3);expect(controller.status()).toMatchObject({state:'ready',recovery:null,lastError:null});
 await controller.close();
});

test('waiting for readiness is demand too: it starts the worker and the index',async()=>{
 const {controller,provider}=setup();controller.enable();controller.schedule(provider);expect(fakes).toHaveLength(0);
 let status:ReturnType<typeof controller.status>|undefined;void controller.waitForReady(2000).then(value=>{status=value;});
 await until(()=>status!==undefined);expect(status).toMatchObject({indexingComplete:true,state:'ready'});expect(fakes).toHaveLength(1);
 await controller.close();
});

// ---- the search path under recovery and idle stop
test('a search while a retry waits answers unavailable at once, even with an index stored: it starts no worker and bypasses no backoff; the timed retry restores service',async()=>{
 const {controller,provider}=setup({idleStopMs:10*3600*1000});controller.enable();await ask(controller,provider);
 die(fakes[0]!);await until(()=>controller.status().state==='unavailable');
 const page=await ask(controller,provider);
 expect(page.status).toBe('unavailable');expect(fakes).toHaveLength(1);expect(controller.status().state).toBe('unavailable');
 await advance(5500);await until(()=>controller.status().state==='ready');expect(fakes).toHaveLength(2);
 expect((await ask(controller,provider)).status).toBe('ok');
 await controller.close();
});

test('a search that starts while the idle stop is closing the worker is served after it, and neither it nor close() hangs',async()=>{
 const {controller,provider,append}=setup({idleStopMs:1000});controller.enable();await ask(controller,provider);
 append('Added just before the idle stop.'); // the next search must prepare, which is what used to wait on the stop that waited on it
 let hold=true;const killed:Fake[]=[];
 vi.mocked(process.kill).mockImplementation(((pid:number,signal?:string|number)=>{
  const entry=fakes.find(candidate=>-candidate.pid===pid);if(!entry)throw Object.assign(new Error('No process group'),{code:'ESRCH'});
  if(signal===0){if(!entry.alive)throw Object.assign(new Error('No process group'),{code:'ESRCH'});return true;}
  if(signal==='SIGTERM'||signal==='SIGKILL'){if(hold)killed.push(entry);else setImmediate(()=>die(entry));}
  return true;
 }) as never);
 await advance(1100); // the idle timer fired; the worker's close waits for its group to die
 let page:SemanticPage|undefined;void controller.search('source',provider).then(value=>{page=value;});
 await advance(300); // the search has started its preparation, which waits for the stop
 hold=false;for(const entry of killed)die(entry);
 await until(()=>page!==undefined);
 const next=await ask(controller,provider);expect(next.status).toBe('ok');expect(alive()).toBe(1);
 let closed=false;void controller.close().then(()=>{closed=true;});await until(()=>closed);
});

test('a search that reaches its wait limit with part of the window indexed ranks that part and states the coverage',async()=>{
 const {controller,provider,append,cut}=setup({idleStopMs:10*3600*1000});controller.enable();
 for(let i=0;i<20;i++)append('Conversation message number '+i+'.');
 cut(append('Still in view.'));
 holdAfter=8; // the first batch of 8 is embedded; the rest outlasts the wait
 const page=await ask(controller,provider);
 expect(controller.status().coveredUnits).toBe(8);
 expect(page.status).toBe('ok');expect(page.groups.length).toBeGreaterThan(0);
 const covered=page.coverage.window!.conversation;expect(covered.indexedCharacters).toBeGreaterThan(0);expect(covered.indexedCharacters).toBeLessThan(covered.outOfViewCharacters);
 expect(page.notice).toContain('Semantic ranking covers '+covered.indexedCharacters+' of '+covered.outOfViewCharacters+' characters of earlier conversation');
 await controller.close();
});

// ---- N1: Esc cancels a search and stops the worker, but recall stays enabled
/** One search with an abort signal, driven under the fake clock; `outcome` is its page or its error. */
function askAbortable(controller:SemanticRecallController,provider:()=>ReturnType<typeof semanticEligibleSources>){
 const abort=new AbortController(),box:{outcome?:SemanticPage|Error}={};
 void controller.search('source',provider,abort.signal).then(page=>{box.outcome=page;},error=>{box.outcome=error as Error;});
 return {abort,box};
}
test('Esc while a search waits for indexing cancels it and stops the worker, keeps recall enabled, and the next search starts a worker again and answers ok',async()=>{
 holdEmbed=true;
 const {controller,provider,events}=setup({idleStopMs:10*3600*1000});controller.enable();
 const {abort,box}=askAbortable(controller,provider);await until(()=>held!==undefined); // the worker is embedding; the answer is held back
 abort.abort();await until(()=>box.outcome!==undefined);
 expect((box.outcome as Error).name).toBe('AbortError');
 expect(alive()).toBe(0); // the worker is stopped
 expect(controller.status()).toMatchObject({enabled:true,lastError:null,cleanupError:null});expect(controller.status().state).not.toBe('unavailable');
 holdEmbed=false;held=undefined;
 const page=await ask(controller,provider);
 expect(page.status).toBe('ok');expect(page.status).not.toBe('disabled');expect(fakes).toHaveLength(2);expect(alive()).toBe(1);
 expect(events.some(([state])=>state==='disabled'||state==='unavailable')).toBe(false); // recall was never off or broken
 await shut(controller);
});

test('Esc while the query is being embedded cancels the search, stops the worker and keeps recall enabled',async()=>{
 const {controller,provider}=setup({idleStopMs:10*3600*1000});controller.enable();await ask(controller,provider);
 holdQuery=true;
 const {abort,box}=askAbortable(controller,provider);await until(()=>held!==undefined);
 abort.abort();await until(()=>box.outcome!==undefined);
 expect((box.outcome as Error).name).toBe('AbortError');expect(alive()).toBe(0);
 expect(controller.status()).toMatchObject({enabled:true,lastError:null});
 holdQuery=false;held=undefined;
 const page=await ask(controller,provider);
 expect(page.status).toBe('ok');expect(fakes).toHaveLength(2);expect(alive()).toBe(1);
 await controller.close();
});

// ---- a search waits only for the out-of-view conversation
test('a search waits only for the out-of-view conversation: a tool-output backlog does not hold it, the coverage says how far the tool output got, and indexing goes on in the background',async()=>{
 const {controller,provider,append,appendTool,cut}=setup({idleStopMs:10*3600*1000});controller.enable();
 for(let i=0;i<7;i++)append('Conversation message '+i+'.'); // with the setup's first message: 8 out-of-view conversation units, one batch
 for(let i=0;i<30;i++)appendTool('Tool output line '+i+'.');
 cut(append('Still in view.'));
 holdAfter=8; // the first batch of 8 (all the conversation) is embedded; the tool-output batches behind it are held
 const started=performance.now(),page=await ask(controller,provider);
 expect(performance.now()-started).toBeLessThan(1000); // queryWaitMs is 2000: the search did not wait out the backlog
 expect(page.status).toBe('ok');
 const covered=page.coverage.window!;
 expect(covered.conversation.indexedCharacters).toBe(covered.conversation.outOfViewCharacters);
 expect(covered.toolResults.indexedCharacters).toBe(0);expect(covered.toolResults.outOfViewCharacters).toBeGreaterThan(0);
 expect(page.notice).toContain(' and 0 of '+covered.toolResults.outOfViewCharacters+' characters of earlier tool output');
 expect(controller.status().indexingComplete).toBe(false);
 holdAfter=Infinity;held!();held=undefined; // the worker is alive: the backlog is indexed without another search
 await until(()=>controller.status().indexingComplete);
 const done=controller.status().window!;expect(done.toolResults.indexedCharacters).toBe(done.toolResults.outOfViewCharacters);
 await shut(controller);
});

// ---- R4: a retry whose probe embed succeeds is a recovery
test('a retry whose probe embed succeeds is a recovery: the state is back while preparation goes on, and history churn after it is no failed attempt',async()=>{
 const {controller,provider,append,cut}=setup({idleStopMs:10*3600*1000});controller.enable();await ask(controller,provider);
 append('Conversation that a cut moves out of view: the retry indexes it.');cut(append('Still in view.'));
 die(fakes[0]!);await until(()=>controller.status().state==='unavailable');
 holdEmbed=true;
 await advance(5500);await until(()=>held!==undefined); // the retry's worker passed its probe embed and is embedding a passage
 expect(controller.status()).toMatchObject({state:'preparing',recovery:null,lastError:null});
 append('Arrives while the retry indexes.');holdEmbed=false;held!();held=undefined; // the history changes after the probe
 await advance(1000);
 expect(controller.status().recovery).toBeNull();expect(controller.status().state).not.toBe('unavailable');expect(fakes).toHaveLength(2);
 await advance(60000);expect(fakes).toHaveLength(2); // no retry was armed over a healthy worker
 expect((await ask(controller,provider)).status).toBe('ok');
 await shut(controller);
});

test('history churn before the probe embed is not a failed attempt either: the backoff does not advance, and the next turn end retries',async()=>{
 const {controller,provider,append}=setup({idleStopMs:10*3600*1000});controller.enable();await ask(controller,provider);
 die(fakes[0]!);await until(()=>controller.status().state==='unavailable');expect(controller.status().recovery).toMatchObject({attempts:1});
 // the history changes while the retry's worker is starting, before its probe
 const spawnNext=vi.mocked(spawn).getMockImplementation()!;
 vi.mocked(spawn).mockImplementation(((...args:unknown[])=>{append('Arrives while the new worker starts.');return (spawnNext as (...a:unknown[])=>unknown)(...args);}) as never);
 await advance(5500);await advance(1000);
 expect(controller.status().recovery).toMatchObject({attempts:1,retryAt:null}); // not advanced, and no timer promised
 vi.mocked(spawn).mockImplementation(spawnNext);
 controller.schedule(provider);await until(()=>controller.status().recovery===null); // the next turn end retries, and its probe embed credits the recovery
 expect(controller.status().state).not.toBe('unavailable');expect(fakes).toHaveLength(2);
 await shut(controller);
});

// ---- R6: an intentional close is no fault
test('closing a session in the middle of a preparation is no fault: no error is recorded and the state never reads unavailable',async()=>{
 holdEmbed=true;
 const {controller,provider,events}=setup({idleStopMs:10*3600*1000});controller.enable();
 void controller.search('source',provider).catch(()=>undefined);
 await until(()=>held!==undefined); // a preparation is running
 await shut(controller);
 expect(controller.status()).toMatchObject({state:'disabled',lastError:null,cleanupError:null});
 expect(events.every(([,reason])=>reason===null)).toBe(true); // no "Local worker closed" was ever announced
});

// ---- R8b: a refusing worker answers unavailable
test('a worker that refuses when a search restarts it after the idle stop makes the search answer unavailable and start recovery: the search does not reject',async()=>{
 refusal=n=>n===2?'tokenizers_membership_failure':null;
 const {controller,provider}=setup({idleStopMs:1000});controller.enable();await ask(controller,provider);
 await advance(3000);expect(alive()).toBe(0); // idle: the plan stays complete, the worker is gone
 const page=await ask(controller,provider); // same snapshot, nothing to prepare: the ranking step starts the worker itself
 expect(page.status).toBe('unavailable');
 expect(controller.status()).toMatchObject({state:'unavailable',recovery:{integrity:true},lastError:'Local semantic runtime: tokenizers_membership_failure'});
 await controller.close();
});

test('the coverage a result states is the coverage it ranked, though indexing goes on in the background while it ranks',async()=>{
 const {controller,provider,append,appendTool,cut}=setup({idleStopMs:10*3600*1000});controller.enable();
 for(let i=0;i<135;i++)append('Conversation message '+i+'.'); // with the setup's first message: 136 out-of-view conversation units, 17 batches of 8, two ranking pages
 for(let i=0;i<20;i++)appendTool('Tool output line '+i+'.');
 cut(append('Still in view.'));
 holdAfter=136; // the conversation is embedded; the first tool-output batch is held
 onList=()=>{if(held){const release=held;held=undefined;holdAfter=Infinity;release();}}; // the held batch is released while the search reads its first ranking page
 const page=await ask(controller,provider);
 expect(embeds.passage).toBeGreaterThan(136); // the background indexed tool output while the search ranked
 const stated=page.coverage.window!;
 expect(stated.toolResults.indexedCharacters).toBe(0);expect(stated.conversation.indexedCharacters).toBe(stated.conversation.outOfViewCharacters);
 expect(page.notice).toContain(' and 0 of '+stated.toolResults.outOfViewCharacters+' characters of earlier tool output');
 await shut(controller);
});
