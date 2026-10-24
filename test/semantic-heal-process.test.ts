import {afterEach,expect,test} from 'vitest';
import {spawn,type ChildProcess} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {SemanticRecallController,semanticEligibleSources} from '../src/semantic-recall';
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
