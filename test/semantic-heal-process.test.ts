import {afterEach,expect,test} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {METAL_UNAVAILABLE,SemanticRecallController,semanticEligibleSources} from '../src/semantic-recall';
import {testNativeOwner,testPython} from './python-fixture';
// Real processes: the controller starts a real worker process; the test owns the "encoder" the worker depends on and kills only that child, by its handle.
const roots:string[]=[],encoders:ChildProcess[]=[];
afterEach(()=>{for(const encoder of encoders.splice(0))encoder.kill('SIGKILL');for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const wait=async(done:()=>boolean|Promise<boolean>,ms=15000)=>{const until=Date.now()+ms;while(Date.now()<until){if(await done())return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('condition not met in time');};
function encoder(runtimeRoot:string):ChildProcess{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});encoders.push(child);
 writeFileSync(join(runtimeRoot,'encoder.pid'),String(child.pid));return child;
}
test('a worker whose encoder child was killed is replaced on its own, and search answers ok again once the encoder is back',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-semantic-heal-process-'));roots.push(root);
 const project=join(root,'project'),runtimeRoot=join(root,'runtime');mkdirSync(project);mkdirSync(runtimeRoot);
 const first=encoder(runtimeRoot);
 const config={pythonPath:testPython,runtimeRoot,indexDirectory:join(root,'cache'),workerPath:fileURLToPath(new URL('./heal-worker-fixture.py',import.meta.url)),queryWaitMs:8000,...testNativeOwner};
 const sessionManager=SessionManager.inMemory(project);sessionManager.appendMessage({role:'user',content:'Original source about the encoder.',timestamp:1});sessionManager.appendCompaction('summary of what was cut','no-such-entry',100,undefined,true); // the source is out of view, so a search waits for it (with nothing out of view it does not)
 const controller=new SemanticRecallController(config,{healDelaysMs:[60],healSteadyMs:60}),provider=()=>semanticEligibleSources({cwd:project,sessionManager},{},()=>{});
 const states:string[]=[];controller.onStateChange(state=>states.push(state));
 controller.enable();
 expect((await controller.search('encoder',provider)).status).toBe('ok');
 // The test's own child, by its own handle.
 const exited=new Promise<void>(done=>first.once('exit',()=>done()));first.kill('SIGKILL');await exited;
 const failed=await controller.search('encoder',provider);
 expect(failed.status).toBe('unavailable');
 await wait(()=>controller.status().state==='unavailable'&&(controller.status().recovery?.attempts??0)>=2); // retries run while the encoder is gone
 expect(controller.status().lastError).toBe('Local semantic runtime: local_runtime_failure');
 encoder(runtimeRoot); // repaired
 await wait(()=>controller.status().state==='ready');
 expect(controller.status().recovery).toBeNull();
 expect((await controller.search('encoder',provider)).status).toBe('ok');
 expect(states).toContain('unavailable');expect(states.at(-1)).toBe('ready');
 await controller.close();
},60000);

test('after an idle stop the next search starts a new worker process and finds the vectors in the SQLite file: nothing is embedded again',async()=>{
 const root=mkdtempSync(join(tmpdir(),'pi-semantic-idle-process-'));roots.push(root);
 const project=join(root,'project'),runtimeRoot=join(root,'runtime');mkdirSync(project);mkdirSync(runtimeRoot);encoder(runtimeRoot);
 const config={pythonPath:testPython,runtimeRoot,indexDirectory:join(root,'cache'),workerPath:fileURLToPath(new URL('./heal-worker-fixture.py',import.meta.url)),queryWaitMs:8000,...testNativeOwner};
 const sessionManager=SessionManager.inMemory(project);for(const text of ['First original source.','Second original source.','Third original source.'])sessionManager.appendMessage({role:'user',content:text,timestamp:1});sessionManager.appendCompaction('summary of what was cut','no-such-entry',100,undefined,true); // out of view: a search waits for the sources
 const controller=new SemanticRecallController(config,{idleStopMs:300}),provider=()=>semanticEligibleSources({cwd:project,sessionManager},{},()=>{});
 controller.enable();await wait(()=>!(controller as unknown as {worker?:unknown}).worker); // enabled and idle: no worker process
 expect(controller.status()).toMatchObject({enabled:true,state:'waiting'});
 expect((await controller.search('source',provider)).status).toBe('ok');
 const worker=(controller as unknown as {worker?:unknown}).worker;expect(worker).toBeDefined();
 expect(controller.status().operations).toEqual({preparationEmbeddings:3,queryEmbeddings:1});
 await wait(()=>!(controller as unknown as {worker?:unknown}).worker); // the idle stop joined the first worker process
 expect(readdirSync(config.indexDirectory).some(name=>name.endsWith('.sqlite'))).toBe(true);expect(controller.status()).toMatchObject({enabled:true,state:'ready',lastError:null});
 const page=await controller.search('source',provider);
 expect(page.status).toBe('ok');expect((controller as unknown as {worker?:unknown}).worker).not.toBe(worker);
 expect(controller.status().operations).toEqual({preparationEmbeddings:3,queryEmbeddings:2}); // the three stored vectors were reused
 expect(page.groups.length).toBeGreaterThan(0);
 await controller.close();expect(existsSync(config.indexDirectory)?readdirSync(config.indexDirectory):[]).toEqual([]);
},60000);

// A busy machine: the worker takes longer to start (Python start, `ready`, the model load) than a loaded call may take. Held to the per-call
// deadline, it never started and semantic recall went unavailable (R&D's repro on a machine at load 65-87: 0 of 1,606 units after 173 s).
function slowStart(delayMs:number){
 const root=mkdtempSync(join(tmpdir(),'pi-semantic-slow-start-'));roots.push(root);
 const project=join(root,'project'),runtimeRoot=join(root,'runtime');mkdirSync(project);mkdirSync(runtimeRoot);encoder(runtimeRoot);
 writeFileSync(join(runtimeRoot,'ready-delay-ms'),String(delayMs));
 const config={pythonPath:testPython,runtimeRoot,indexDirectory:join(root,'cache'),workerPath:fileURLToPath(new URL('./heal-worker-fixture.py',import.meta.url)),queryWaitMs:8000,...testNativeOwner};
 const sessionManager=SessionManager.inMemory(project);sessionManager.appendMessage({role:'user',content:'Original source about the encoder.',timestamp:1});sessionManager.appendCompaction('summary of what was cut','no-such-entry',100,undefined,true);
 return {runtimeRoot,config,provider:()=>semanticEligibleSources({cwd:project,sessionManager},{},()=>{})};
}
test('a worker that starts slower than a loaded call may take still starts: its start has its own deadline',async()=>{
 const {config,provider}=slowStart(800);
 const controller=new SemanticRecallController(config,{callDeadlineMs:300,startDeadlineMs:5000,healDelaysMs:[60],healSteadyMs:60});
 controller.enable();
 expect((await controller.search('encoder',provider)).status).toBe('ok');
 expect(controller.status()).toMatchObject({state:'ready',lastError:null,recovery:null});
 await controller.close();
},60000);
test('a worker that missed its start deadline is retried in the same session and becomes ready once the machine is free',async()=>{
 const {runtimeRoot,config,provider}=slowStart(1500);
 const controller=new SemanticRecallController(config,{callDeadlineMs:300,startDeadlineMs:600,healDelaysMs:[60],healSteadyMs:60});
 const states:string[]=[];controller.onStateChange(state=>states.push(state));
 controller.enable();
 expect((await controller.search('encoder',provider)).status).not.toBe('ok');
 await wait(()=>controller.status().state==='unavailable');
 expect(controller.status().lastError).toBe('Local runtime deadline');
 rmSync(join(runtimeRoot,'ready-delay-ms')); // the load is gone
 await wait(()=>controller.status().state==='ready');
 expect(controller.status().recovery).toBeNull();
 expect((await controller.search('encoder',provider)).status).toBe('ok');
 expect(states).toContain('unavailable');expect(states.at(-1)).toBe('ready');
 await controller.close();
},60000);
// A loaded worker on a starved CPU: an embed batch takes longer than a call on a loaded model may take. Its deadline grows with the texts it
// carries, so indexing slows down instead of failing (R&D's repro at load 85-99: 72 of 1,606 units, then unavailable at 432 s).
test('a loaded worker whose embed batch outlasts the per-call deadline slows down and does not fail: the deadline grows with the batch',async()=>{
 const {runtimeRoot,config,provider}=slowStart(0);
 writeFileSync(join(runtimeRoot,'embed-delay-ms'),'700');
 const controller=new SemanticRecallController(config,{callDeadlineMs:300,embedTextMs:1000,startDeadlineMs:5000,healDelaysMs:[60],healSteadyMs:60});
 controller.enable();
 expect((await controller.search('encoder',provider)).status).toBe('ok');
 expect(controller.status()).toMatchObject({state:'ready',lastError:null,recovery:null});
 await controller.close();
},60000);
// Semantic recall runs on Metal only. Where the server cannot start on Metal (a VM, a Mac without a GPU), it goes off with that reason, and
// a search still answers with word recall.
test('where Metal cannot start, semantic recall is off with that reason and tuck_search answers with words only',async()=>{
 const {runtimeRoot,config,provider}=slowStart(0);
 writeFileSync(join(runtimeRoot,'no-metal'),'');
 const controller=new SemanticRecallController(config,{healDelaysMs:[60],healSteadyMs:60000});
 controller.enable();
 const page=await controller.search('encoder',provider);
 expect(page.status).toBe('unavailable');
 await wait(()=>controller.status().state==='unavailable');
 expect(controller.status().lastError).toBe(METAL_UNAVAILABLE);
 await controller.close();
},60000);
