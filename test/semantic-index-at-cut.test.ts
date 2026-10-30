import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager,type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {createSemanticRecall,semanticEligibleSources,type SemanticRecallController} from '../src/semantic-recall';
import {installCompaction} from '../src/compaction';

// A saved cut starts background indexing of what left the view, for a session that has searched before (a host may give each session its own
// controller and worker, so a session that never searched starts nothing). The cut never waits for it, and a failure goes to recovery.
type Snapshot=ReturnType<typeof semanticEligibleSources>;
interface Internals {runtime(project:string):Promise<{call(op:string,input:any):Promise<unknown>}>;current?:Snapshot;task?:Promise<void>;timer?:unknown;healTimer?:ReturnType<typeof setTimeout>;healReason:string|null;active:boolean;fullIndexing:boolean;idleTimer?:unknown;error:string|null;}
const roots:string[]=[],controllers:SemanticRecallController[]=[];
afterEach(async()=>{for(const c of controllers.splice(0))await c.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'semantic-index-at-cut-'));roots.push(root);
 const c=createSemanticRecall({pythonPath:'/unused-python',runtimeRoot:join(root,'runtime'),indexDirectory:join(root,'index'),queryWaitMs:60000});controllers.push(c);c.enable();
 const internal=c as unknown as Internals,stored=new Set<string>();let embeddings=0,failEmbed=false,undercount=false;
 internal.runtime=async()=>({call:async(op,input)=>{
  if(op==='tokenize')return {ranges:[[{start:0,end:input.texts[0].length}]]};
  if(op==='embed'){if(input.kind==='query')return {vectors:[[1]]};if(failEmbed)throw new Error('embedding interrupted');embeddings+=input.texts.length;return {vectors:input.texts.map(()=>[1])};}
  if(op==='index'){
   if(input.action==='reconcile'){for(const key of stored)if(!input.keys.includes(key))stored.delete(key);}
   if(input.action==='upsert')for(const row of input.rows)stored.add(row.key);
   if(input.action==='status')return {coveredKeys:input.keys.filter((key:string)=>stored.has(key))};
   if(input.action==='score'){const found=internal.current!.units.filter(unit=>input.keys.includes(unit.key)&&stored.has(unit.key));return {ranked:found.slice(0,24).map(unit=>({key:unit.key,score:1})),observed:found.length-(undercount?1:0)};}
   return {};
  }
  throw new Error('unexpected RPC');
 }});
 const cwd=join(root,'project'),manager=SessionManager.inMemory(cwd);
 let at=0;const append=(text:string)=>manager.appendMessage({role:'user',content:text,timestamp:++at*1000});
 const provider=()=>semanticEligibleSources({cwd,sessionManager:manager},{},()=>{});
 return {c,internal,stored,manager,append,provider,cwd,get embeddings(){return embeddings;},set failEmbed(value:boolean){failEmbed=value;},set undercount(value:boolean){undercount=value;}};
}
const settled=async(c:SemanticRecallController,internal:Internals)=>{for(let i=0;i<400&&(internal.timer||internal.task);i++)await new Promise(done=>setTimeout(done,5));return c.status();};
/** A search with nothing out of view: it returns at once and marks the session as one that searches. Then the idle limit passes: the
 * idle stop leaves the session inactive (no background work) until the next demand, which is the state a real session was in. */
const searchBeforeAnyCut=async(f:ReturnType<typeof fixture>)=>{const page=await f.c.search('earlier',f.provider);expect(page.status).toBe('indexing_incomplete');await settled(f.c,f.internal);f.internal.active=false;f.internal.fullIndexing=false;clearTimeout(f.internal.idleTimer as ReturnType<typeof setTimeout>);f.internal.idleTimer=undefined;};
// The search above indexes what existed then, in the background; history added after it is what a cut must index.
const cutAll=(f:ReturnType<typeof fixture>)=>{f.append('decided after the last search');f.manager.appendCompaction('summary of what was cut','no-such-entry',100,undefined,true);};

test('a session that searched before: a cut indexes the conversation that left the view, with no search', async()=>{
 const f=fixture();f.append('first decision');f.append('second decision');await searchBeforeAnyCut(f);
 const before=f.embeddings;cutAll(f);
 f.c.indexAtCut(f.provider);
 expect(f.internal.active).toBe(true);expect(f.internal.idleTimer).toBeDefined(); // reactivated, and the idle limit is armed again so the worker is given back later
 const status=await settled(f.c,f.internal);
 expect(f.embeddings-before).toBeGreaterThan(0);
 expect(status.window?.conversation.indexedCharacters).toBe(status.window?.conversation.outOfViewCharacters);
 expect(status.window?.conversation.outOfViewCharacters).toBeGreaterThan(0);
});
test('a session that never searched starts nothing at a cut', async()=>{
 const f=fixture();f.append('first decision');cutAll(f);
 f.c.indexAtCut(f.provider);
 await settled(f.c,f.internal);
 expect(f.embeddings).toBe(0);expect(f.internal.current).toBeUndefined();
});
test('disabled, or a recovery retry pending: a cut starts nothing', async()=>{
 const off=fixture();off.append('first decision');await searchBeforeAnyCut(off);await off.c.disable();const before=off.embeddings;cutAll(off);
 off.c.indexAtCut(off.provider);await settled(off.c,off.internal);expect(off.embeddings).toBe(before);
 const backoff=fixture();backoff.append('first decision');await searchBeforeAnyCut(backoff);const was=backoff.embeddings;cutAll(backoff);
 const pending=setTimeout(()=>{},100000);backoff.internal.healTimer=pending;
 try{backoff.c.indexAtCut(backoff.provider);await new Promise(done=>setTimeout(done,50));expect(backoff.internal.active).toBe(false);expect(backoff.internal.timer).toBeUndefined();expect(backoff.internal.task).toBeUndefined();expect(backoff.embeddings).toBe(was);}
 finally{clearTimeout(pending);backoff.internal.healTimer=undefined;}
});
test('through installCompaction: the cut handler does not wait for indexing, and a failure goes to recovery', async()=>{
 const f=fixture();f.append('first decision');await searchBeforeAnyCut(f);cutAll(f);f.failEmbed=true;
 const handlers=new Map<string,((event:unknown,ctx:unknown)=>unknown)[]>();
 const pi={on:(name:string,handler:(event:unknown,ctx:unknown)=>unknown)=>{handlers.set(name,[...(handlers.get(name)??[]),handler]);},registerCommand:()=>{},registerTool:()=>{}} as unknown as ExtensionAPI;
 const handle=await installCompaction(pi,{semanticRecall:f.c});
 try{
  const ctx={cwd:f.cwd,sessionManager:f.manager};
  const results=(handlers.get('session_compact')??[]).map(handler=>handler({},ctx));
  expect(results.every(result=>result===undefined)).toBe(true); // nothing for Pi to await
  expect(f.internal.timer??f.internal.task).toBeDefined(); // indexing is scheduled, not done
  await settled(f.c,f.internal);
  expect(f.c.status().lastError).toBe('embedding interrupted'); // the failed preparation took the ordinary failure path (schedule's catch, then heal), and nothing was thrown at the cut
  expect(f.c.status().enabled).toBe(true);
  expect(f.manager.getBranch().at(-1)?.type).toBe('compaction');
 }finally{await handle.close();}
});
test('a search soon after the cut ranks the whole out-of-view conversation without waiting', async()=>{
 const f=fixture();f.append('first decision');f.append('second decision');await searchBeforeAnyCut(f);cutAll(f);
 f.c.indexAtCut(f.provider);await settled(f.c,f.internal);
 const embedded=f.embeddings,started=performance.now(),page=await f.c.search('decision',f.provider);
 expect(f.embeddings).toBe(embedded); // the search found the window already indexed: no preparation ran while it waited
 expect(performance.now()-started).toBeLessThan(5000); // far under queryWaitMs (60 s)
 expect(page.status).toBe('ok');
 expect(page.coverage.window?.conversation.indexedCharacters).toBe(page.coverage.window?.conversation.outOfViewCharacters);
});
test('a closed controller serves a new session: it has not searched, so its cut starts nothing', async()=>{
 const f=fixture();f.append('first decision');await searchBeforeAnyCut(f);await f.c.close();f.c.enable();const before=f.embeddings;cutAll(f);
 f.c.indexAtCut(f.provider);await settled(f.c,f.internal);
 expect(f.embeddings).toBe(before);expect(f.internal.active).toBe(false);
});
test('a worker that reports fewer stored vectors than the covered prefix makes the search unavailable, not a partial ranking', async()=>{
 const f=fixture();f.append('first decision');f.append('second decision');await searchBeforeAnyCut(f);cutAll(f);
 f.c.indexAtCut(f.provider);await settled(f.c,f.internal);f.undercount=true;
 const page=await f.c.search('decision',f.provider);
 expect(page.status).toBe('unavailable');expect(page.notice).toContain('Snapshot index coverage changed');
});
test('with nothing out of view, a recorded failure is still reported as unavailable', async()=>{
 const f=fixture();f.append('first decision');const error=f.internal.error='Incompatible semantic model; EG2 768/8192 offline required';
 const page=await f.c.search('decision',f.provider);
 expect(page.status).toBe('unavailable');
 // The page's coverage is built before the retry clears the error, so it reports the failure, not 'preparing' with no error; the retry is still scheduled.
 expect(page.coverage.lastError).toBe(error);expect(page.coverage.state).toBe('unavailable');
 expect(f.internal.error).toBeNull();expect(Boolean(f.internal.timer||f.internal.task)).toBe(true);
});
