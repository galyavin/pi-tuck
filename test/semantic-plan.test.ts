import {afterEach,expect,test,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createSemanticRecall,semanticEligibleSources,viewStart,MAX_INDEX_UNITS,type SemanticRecallController} from '../src/semantic-recall';
import {installCompaction} from '../src/compaction';
type Snapshot=ReturnType<typeof semanticEligibleSources>;
type Unit=Snapshot['units'][number];
interface RPCInput {action?:string;keys?:string[];rows?:Unit[];texts?:string[];kind?:string;}
interface Internals {prepare(provider:()=>Snapshot,full?:boolean):Promise<void>;runtime(project:string):Promise<{call(op:string,input:RPCInput):Promise<unknown>}>;current?:Snapshot;task?:Promise<void>;}
const roots:string[]=[],controllers:SemanticRecallController[]=[];
afterEach(async()=>{for(const c of controllers.splice(0))await c.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(options:{maxUnits?:number;prepareWorkMs?:number;queryWaitMs?:number;maxSourceCharacters?:number}={}){
 const root=mkdtempSync(join(tmpdir(),'semantic-plan-'));roots.push(root);
 const c=createSemanticRecall({pythonPath:'/unused-python',runtimeRoot:join(root,'runtime'),indexDirectory:join(root,'index'),...options});controllers.push(c);c.enable();
 const internal=c as unknown as Internals,stored=new Set<string>();let tokenizations=0,embeddings=0,queryEmbeddings=0,failTokenizeAt=0,failEmbed=false,pieces=1,onTokenize:((n:number)=>void)|undefined,onEmbed:((n:number)=>void)|undefined;
 let gate:Promise<void>|undefined,embedGate:Promise<void>|undefined,failAfter:number|undefined;const embedded:string[]=[];
 internal.runtime=async()=>({call:async(op,input)=>{
  if(op==='tokenize'){tokenizations++;if(gate)await gate;if(tokenizations===failTokenizeAt)throw new Error('interrupted enumeration');onTokenize?.(tokenizations);const length=input.texts![0]!.length;return {ranges:[Array.from({length:pieces},(_,i)=>({start:Math.floor(i*length/pieces),end:Math.floor((i+1)*length/pieces)}))]};}
  if(op==='embed'){if(input.kind==='query'){queryEmbeddings++;return {vectors:[[1]]};}if(embedGate)await embedGate;embeddings++;if(failEmbed||(failAfter!==undefined&&embeddings>failAfter))throw new Error('embedding interrupted');embedded.push(...input.texts!.map(text=>text.split('Original passage: ')[1]!));onEmbed?.(embeddings);return {vectors:input.texts!.map(()=>[1])};}
  if(op==='index'){
   if(input.action==='reconcile'){for(const key of stored)if(!input.keys!.includes(key))stored.delete(key);}
   if(input.action==='upsert')for(const row of input.rows!)stored.add(row.key);
   if(input.action==='status')return {coveredKeys:input.keys!.filter(key=>stored.has(key))};
   if(input.action==='score'){const found=internal.current!.units.filter(unit=>input.keys!.includes(unit.key)&&stored.has(unit.key));return {ranked:found.slice(0,24).map(unit=>({key:unit.key,score:1})),observed:found.length};}
   return {};
  }
  throw new Error('unexpected RPC');
 }});
 const manager=SessionManager.inMemory(join(root,'project'));
 let at=0;const append=(text:string,timestamp=++at*1000)=>manager.appendMessage({role:'user',content:text,timestamp});
 const appendTool=(text:string)=>manager.appendMessage({role:'toolResult',toolCallId:'call-'+text,toolName:'bash',content:[{type:'text',text}],isError:false,timestamp:++at*1000});
 const cut=(firstKeptEntryId:string)=>manager.appendCompaction('summary of what was cut',firstKeptEntryId,100,undefined,true);
 const provider=()=>semanticEligibleSources({cwd:join(root,'project'),sessionManager:manager},{},()=>{});
 let release=()=>{};
 return {c,internal,stored,append,appendTool,cut,manager,embedded,provider,get release(){return release;},set release(value:()=>void){release=value;},omit:(id:string)=>manager.appendContextEdit(id,null),get tokenizations(){return tokenizations;},get embeddings(){return embeddings;},get queryEmbeddings(){return queryEmbeddings;},set failTokenizeAt(n:number){failTokenizeAt=n;},set pieces(n:number){pieces=n;},set onTokenize(fn:((n:number)=>void)|undefined){onTokenize=fn;},set onEmbed(fn:((n:number)=>void)|undefined){onEmbed=fn;},set failEmbed(value:boolean){failEmbed=value;},set gate(value:Promise<void>|undefined){gate=value;},set embedGate(value:Promise<void>|undefined){embedGate=value;},set failEmbedAfter(value:number|undefined){failAfter=value;}};
}
test('interrupted enumeration never publishes a partial plan; retry enumerates the missing source and preserves eligible cache',async()=>{
 const f=fixture();f.append('first');await f.internal.prepare(f.provider);const prior=f.internal.current!;const firstKey=prior.units[0]!.key;
 f.append('second');f.append('third');f.failTokenizeAt=3;
 await expect(f.internal.prepare(f.provider)).rejects.toThrow('interrupted enumeration');expect(f.internal.current).toBe(prior);expect(f.stored.has(firstKey)).toBe(true);
 f.failTokenizeAt=0;await f.internal.prepare(f.provider);expect(f.internal.current!.units).toHaveLength(3);expect(f.c.status().indexingComplete).toBe(true);expect(f.tokenizations).toBe(4);expect(f.embeddings).toBe(2); // the source the failed attempt finished is not tokenized again
});
test('an attempt that new history aborts keeps the sources it finished: the retry tokenizes only the remaining and the new sources',async()=>{
 const f=fixture();for(let i=0;i<10;i++)f.append('source '+i);
 f.onTokenize=n=>{if(n===4)f.append('arrived during the build');}; // the 4th source is in flight when the history changes
 await expect(f.internal.prepare(f.provider)).rejects.toThrow('changed');
 expect(f.tokenizations).toBe(4);expect(f.internal.current).toBeUndefined(); // nothing was published
 f.onTokenize=undefined;await f.internal.prepare(f.provider);
 expect(f.tokenizations).toBe(4+7+1); // the 3 finished sources are kept; the one in flight, the 6 behind it and the 1 new are tokenized
 expect(f.internal.current!.units).toHaveLength(11);expect(f.embedded).toHaveLength(11);
});
test('an attempt aborted while embedding keeps its tokenized units and its stored vectors: the retry tokenizes only the new source and embeds only what is not stored',async()=>{
 const f=fixture();for(let i=0;i<20;i++)f.append('source '+i);
 f.onEmbed=n=>{if(n===2)f.append('arrived during indexing');}; // the first batch of 8 is stored; the second is embedded when the history changes
 await expect(f.internal.prepare(f.provider)).rejects.toThrow('changed');
 expect(f.tokenizations).toBe(20);expect(f.embedded).toHaveLength(16);expect(f.stored.size).toBe(8);
 f.onEmbed=undefined;await f.internal.prepare(f.provider);
 expect(f.tokenizations).toBe(21);expect(f.embedded).toHaveLength(16+13); // 21 units, 8 stored: 13 embedded, the stored ones by key
 expect(f.c.status()).toMatchObject({indexingComplete:true,totalUnits:21});
});
test('the kept tokenized units are bounded: what left the window or the history is dropped, and a close drops them all',async()=>{
 const f=fixture({maxUnits:3});const ids=['m1','m2','m3','m4','m5'].map(text=>f.append(text));
 f.onEmbed=n=>{if(n===1)f.append('m6');};
 await expect(f.internal.prepare(f.provider)).rejects.toThrow('changed'); // m5, m4, m3 are in the window, then m6 arrives
 const kept=()=>(f.internal as unknown as {tokenized:Map<string,unknown>}).tokenized.size;
 expect(kept()).toBe(3);f.onEmbed=undefined;
 await f.internal.prepare(f.provider);expect(kept()).toBe(3); // the window is now m6, m5, m4: m3 left it when the plan was published
 f.omit(ids[4]!);f.onTokenize=()=>{f.append('m7');}; // m5 is withdrawn; the new window is m6, m4, m3, and m3 is in flight when m7 arrives
 await expect(f.internal.prepare(f.provider)).rejects.toThrow('changed');
 expect(kept()).toBe(2); // m6 and m4: the withdrawn m5 went when the attempt began, though no plan was published
 await f.c.close();expect(kept()).toBe(0);
});
test('Esc while a search joins a stale preparation cancels the search and leaves recall enabled',async()=>{
 const f=fixture({queryWaitMs:5000});f.append('old');f.cut('no-such-entry');let release!:()=>void;f.gate=new Promise<void>(done=>{release=done;});
 const task=f.internal.prepare(f.provider);f.internal.task=task.catch(()=>undefined);const terminal=Promise.allSettled([task]);
 try{
  await new Promise(done=>setTimeout(done,10));f.append('new');
  const abort=new AbortController(),outcome=f.c.search('query',f.provider,abort.signal).then(()=>undefined,error=>error as Error);
  await new Promise(done=>setTimeout(done,20));abort.abort();release();
  const error=await outcome;expect(error?.name).toBe('AbortError');
  expect(f.c.status()).toMatchObject({enabled:true,cleanupError:null}); // cancelled, not disabled
  expect(f.queryEmbeddings).toBe(0);
 }finally{release();await terminal;f.internal.task=undefined;f.gate=undefined;}
 expect((await f.c.search('query',f.provider)).status).toBe('ok'); // the next search simply runs
});
test('the unit cap sits below the worker store: 8,000 is the ceiling of the setting and the default window',async()=>{
 expect(MAX_INDEX_UNITS).toBe(8000);
 expect(()=>fixture({maxUnits:8001})).toThrow('Invalid bounded semantic configuration: maxUnits');expect(()=>fixture({maxUnits:0})).toThrow('maxUnits');
 expect(()=>fixture({maxUnits:8000})).not.toThrow();
 const f=fixture();f.pieces=100; // each source is 100 units, so 81 sources would be 8,100
 for(let i=0;i<81;i++)f.append('x'.repeat(100)+i);
 f.failEmbed=true;await expect(f.internal.prepare(f.provider)).rejects.toThrow('embedding interrupted'); // the plan is published before the first embedding
 expect(f.internal.current!.units).toHaveLength(8000);expect(f.internal.current!.window!.order).toHaveLength(80);
});
test('withdrawn sources are reconciled before interrupted fresh enumeration while eligible vectors survive',async()=>{
 const f=fixture();f.append('retained');const withdrawn=f.append('withdrawn');await f.internal.prepare(f.provider);
 const prior=f.internal.current!,retainedKey=prior.units.find(u=>u.encoded.includes('retained'))!.key,withdrawnKey=prior.units.find(u=>u.encoded.includes('withdrawn'))!.key;f.omit(withdrawn);f.append('new');f.failTokenizeAt=3;
 await expect(f.internal.prepare(f.provider)).rejects.toThrow('interrupted enumeration');expect(f.internal.current).toBe(prior);expect(f.stored.has(retainedKey)).toBe(true);expect(f.stored.has(withdrawnKey)).toBe(false);
});
test('published incomplete plan is reused directly after embedding failure and work-slice retry',async()=>{
 const f=fixture({prepareWorkMs:1});for(let i=0;i<10;i++)f.append('source '+i);f.failEmbed=true;
 await expect(f.internal.prepare(f.provider)).rejects.toThrow('embedding interrupted');const plan=f.internal.current!;expect(plan.units).toHaveLength(10);expect(plan.complete).toBe(false);
 f.failEmbed=false;await f.internal.prepare(f.provider);expect(f.internal.current).toBe(plan);expect(f.c.status().coveredUnits).toBe(8);expect(plan.complete).toBe(false);
 await f.internal.prepare(f.provider);expect(f.internal.current).toBe(plan);expect(plan.complete).toBe(false);expect(f.c.status().coveredUnits).toBe(10);
 await f.internal.prepare(f.provider);expect(plan.complete).toBe(true);expect(f.tokenizations).toBe(10);expect(f.c.status().coveredUnits).toBe(10);
});
test('cross-snapshot source membership reuses zero-unit sources and disjoint eligible slices',async()=>{
 const f=fixture();f.append('zero');f.append('left PRIVATE right');
 const provider=()=>{const s=f.provider();s.sources[0]!.ranges=[];s.sources[1]!.ranges=[{start:0,end:4},{start:13,end:18}];return s;};
 await f.internal.prepare(provider);expect(f.tokenizations).toBe(2);f.append('new');await f.internal.prepare(provider);
 expect(f.tokenizations).toBe(3);expect(f.internal.current!.units.map(u=>u.encoded).join('\n')).not.toContain('PRIVATE');expect(f.internal.current!.sources).toHaveLength(3);
});

// ---- P8: the window covers what the agent can no longer see, kind first and then recency
const order=(f:ReturnType<typeof fixture>)=>f.internal.current!.units.map(u=>u.encoded.split('Original passage: ')[1]);
/** c1 t1 c2 t2 | c3 t3 c4: conversation and tool output alternate; the first kept entry is c3, so c1..t2 are out of view. */
function mixed(f:ReturnType<typeof fixture>){const ids:Record<string,string>={};for(const name of ['c1','t1','c2','t2','c3','t3','c4'])ids[name]=name.startsWith('t')?f.appendTool(name):f.append(name);f.cut(ids.c3!);return ids;}
test('the window is kind first, then recency: out-of-view conversation, out-of-view tool output, then what is in view, each newest first, within both caps',async()=>{
 const all=fixture();mixed(all);await all.internal.prepare(all.provider);
 expect(order(all)).toEqual(['c2','c1','t2','t1','c4','t3','c3']);expect(all.embedded).toEqual(['c2','c1','t2','t1','c4','t3','c3']); // indexed in window order
 const units=fixture({maxUnits:3});mixed(units);await units.internal.prepare(units.provider);
 expect(order(units)).toEqual(['c2','c1','t2']); // the unit cap ends the window inside the out-of-view tool output
 const chars=fixture({maxSourceCharacters:7});mixed(chars);await chars.internal.prepare(chars.provider);
 expect(order(chars)).toEqual(['c2','c1','t2']); // 6 of 7 characters; the next source would make 8
 const none=fixture({maxSourceCharacters:3});mixed(none);await none.internal.prepare(none.provider);
 expect(order(none)).toEqual(['c2']); // conversation first: it takes the budget before any tool output
 expect(all.c.status().window).toMatchObject({windowCharacters:14,outOfViewCharacters:8,eligibleCharacters:14,conversation:{outOfViewCharacters:4},toolResults:{outOfViewCharacters:4}});
});
test('the window is contiguous: the first source that does not fit the rest of the budget ends it, even if an older one would fit',async()=>{
 const f=fixture({maxSourceCharacters:7});f.append('c1');f.appendTool('tt');f.append('c2');f.appendTool('t2.....');f.cut(f.append('kept')); // conversation 4, then t2 (7) does not fit, though tt (2) would
 await f.internal.prepare(f.provider);expect(order(f)).toEqual(['c2','c1']);
});
test('shell output is tool output: it is covered after the conversation, before what is in view',async()=>{
 const f=fixture();f.append('c1');f.manager.appendMessage({role:'bashExecution',command:'ls',output:'b1',exitCode:0,cancelled:false,truncated:false,timestamp:5000} as never);f.append('c2');f.cut(f.append('kept'));
 await f.internal.prepare(f.provider);const texts=order(f);
 expect(texts[0]).toBe('c2');expect(texts[1]).toBe('c1');expect(texts[2]).toContain('b1');expect(texts.at(-1)).toBe('kept'); // out-of-view conversation (newest first), then the shell output, then the view
});
test('with no compaction nothing is out of view; the in-view sources are covered newest first',async()=>{
 const f=fixture({maxUnits:3});for(const text of ['m1','m2','m3','m4','m5','m6'])f.append(text);await f.internal.prepare(f.provider);
 expect(order(f)).toEqual(['m6','m5','m4']);expect(f.c.status().window).toMatchObject({outOfViewCharacters:0,eligibleCharacters:12,windowCharacters:6,indexedCharacters:6,conversation:{outOfViewCharacters:0},toolResults:{outOfViewCharacters:0}});
});
test('a source too large to fit even alone is skipped; the window goes on past it',async()=>{
 const f=fixture({maxSourceCharacters:10});const ids=[f.append('old'),f.append('x'.repeat(40)),f.append('new')];f.cut(ids[2]!);await f.internal.prepare(f.provider);
 expect(order(f)).toEqual(['old','new']);expect(f.c.status().window).toMatchObject({windowCharacters:6,eligibleCharacters:46});
});
test('no throw above the caps: the plan is built within them and the lastError stays empty',async()=>{
 const f=fixture({maxUnits:3,maxSourceCharacters:18});for(let i=0;i<30;i++)f.append('source '+i);f.cut('no-such-entry');
 await f.internal.prepare(f.provider); // used to throw 'unit bound' / 'source bound'
 expect(f.c.status()).toMatchObject({lastError:null,totalUnits:2,indexingComplete:true});expect(f.c.status().window).toMatchObject({windowCharacters:18,eligibleCharacters:260});
 expect((await f.c.search('source',f.provider)).status).toBe('ok');
});
test('a cut moves entries to the front of the conversation order; the conversation is indexed after it, on the stored vectors',async()=>{
 const f=fixture({maxUnits:3});const ids=['m1','m2','m3','m4','m5','m6'].map(text=>f.append(text));await f.internal.prepare(f.provider);
 expect(order(f)).toEqual(['m6','m5','m4']);expect(f.embedded).toEqual(['m6','m5','m4']);
 f.cut(ids[5]!); // only m6 stays in view: m1..m5 move out
 await f.internal.prepare(f.provider,false); // what a cut triggers: conversation only, and it is all conversation
 expect(order(f)).toEqual(['m5','m4','m3']);expect(f.embedded).toEqual(['m6','m5','m4','m3']); // m5 and m4 reused; m3 indexed after the cut
 expect(f.c.status()).toMatchObject({indexingComplete:true,window:{outOfViewCharacters:10,windowCharacters:6,indexedCharacters:6,conversation:{indexedCharacters:6,outOfViewCharacters:10}}});
});
test('after a cut, conversation is indexed right away (not full) and tool output is left for a search (full)',async()=>{
 const f=fixture();mixed(f);
 await f.internal.prepare(f.provider,false);
 expect(f.embedded).toEqual(['c2','c1']); // out-of-view conversation only: no tool output, nothing in view
 expect(f.c.status()).toMatchObject({indexingComplete:false,window:{indexedCharacters:4,conversation:{indexedCharacters:4,outOfViewCharacters:4},toolResults:{indexedCharacters:0,outOfViewCharacters:4,oldestCoveredTime:null}}});
 await f.internal.prepare(f.provider,true);
 expect(f.embedded).toEqual(['c2','c1','t2','t1','c4','t3','c3']);expect(f.c.status()).toMatchObject({indexingComplete:true,window:{indexedCharacters:14,toolResults:{indexedCharacters:4,outOfViewCharacters:4}}});
});
test('a cut makes the package schedule indexing at once; a session that is not searching leaves it to the next search',async()=>{
 const f=fixture();const handlers:Record<string,((event:unknown,ctx:unknown)=>unknown)[]>={};
 const pi={on:(name:string,handler:(event:unknown,ctx:unknown)=>unknown)=>{(handlers[name]??=[]).push(handler);},registerCommand:()=>{},registerTool:()=>{}} as never;
 await installCompaction(pi,{semanticRecall:f.c});
 const ctx={cwd:join(tmpdir(),'cut-project'),sessionManager:f.manager,ui:{notify:()=>{}}} as never,schedule=vi.spyOn(f.c,'schedule');
 for(const handler of handlers.session_compact??[])handler({type:'session_compact'},ctx);
 expect(schedule).toHaveBeenCalledTimes(1); // the same call a turn end makes; it starts nothing unless the session is searching (see the lazy-start tests)
});
test('search ranks over what is indexed and states the coverage; indexing_incomplete only when nothing is indexed',async()=>{
 const f=fixture({queryWaitMs:60});const ids=mixed(f);void ids;
 f.embedGate=new Promise<void>(done=>{f.release=done;});f.failEmbedAfter=1; // the first batch (all 7 units) is held; then nothing more can be indexed
 const empty=await f.c.search('query',f.provider); // the first batch is held: nothing is indexed yet
 expect(empty.status).toBe('indexing_incomplete');expect(empty.groups).toEqual([]);expect(f.queryEmbeddings).toBe(0);
 f.release();await vi.waitFor(()=>expect(f.internal.task).toBeUndefined());
 const page=await f.c.search('query',f.provider);
 expect(page.status).toBe('ok');expect(f.internal.current!.complete).toBe(true);
 expect(page.coverage.window).toMatchObject({indexedCharacters:14,windowCharacters:14,outOfViewCharacters:8,eligibleCharacters:14,oldestCoveredTime:'1970-01-01T00:00:01Z',conversation:{indexedCharacters:4,outOfViewCharacters:4},toolResults:{indexedCharacters:4,outOfViewCharacters:4,oldestCoveredTime:'1970-01-01T00:00:02Z'}});
 expect(page.notice.endsWith('Semantic ranking covers 4 of 4 characters of earlier conversation and 4 of 4 characters of earlier tool output (newest first, back to 1970-01-01T00:00:02Z); use pi_tuck_recall for the rest.')).toBe(true);
});
test('partial coverage is stated, not hidden: only part of the tool output is indexed, and the sentence says how much and back to when',async()=>{
 const f=fixture({prepareWorkMs:1,queryWaitMs:60});const ids=['u1','u2'].map(text=>f.append(text));for(let i=1;i<=10;i++)f.appendTool('tool '+i+'.');f.cut(f.append('kept'));void ids;
 f.failEmbedAfter=1; // one batch of 8 is indexed: both conversation sources, then the six newest tool results; the next batch fails
 await f.internal.prepare(f.provider).catch(()=>undefined);
 const page=await f.c.search('query',f.provider);
 const snapshot=f.internal.current!,indexed=snapshot.indexed.size;
 expect(page.status).toBe('ok');expect(indexed).toBe(8);expect(snapshot.complete).toBe(false);
 const covered=page.coverage.window!;
 expect(covered.conversation).toEqual({indexedCharacters:4,outOfViewCharacters:4});
 expect(covered.toolResults).toMatchObject({outOfViewCharacters:covered.toolResults.outOfViewCharacters});
 const toolChars=covered.toolResults.indexedCharacters;expect(toolChars).toBeGreaterThan(0);expect(toolChars).toBeLessThan(covered.toolResults.outOfViewCharacters);
 expect(page.notice.endsWith(`Semantic ranking covers 4 of 4 characters of earlier conversation and ${toolChars} of ${covered.toolResults.outOfViewCharacters} characters of earlier tool output (newest first, back to ${covered.toolResults.oldestCoveredTime}); use pi_tuck_recall for the rest.`)).toBe(true);
});
test('all conversation is kept when tool output is evicted; what the window drops loses its stored vectors',async()=>{
 const f=fixture({maxUnits:5});f.append('c1');f.append('c2');for(let i=1;i<=6;i++)f.appendTool('t'+i);const kept=f.append('c3');f.cut(kept);
 await f.internal.prepare(f.provider);
 expect(order(f)).toEqual(['c2','c1','t6','t5','t4']); // both conversation sources first, then as many of the newest tool results as fit
 const key=(text:string)=>f.internal.current!.units.find(u=>u.encoded.endsWith(text))!.key;const t4=key('t4'),t5=key('t5');
 f.appendTool('t7');f.appendTool('t8');f.cut(f.append('c4'));
 await f.internal.prepare(f.provider);
 expect(order(f)).toEqual(['c3','c2','c1','t8','t7']); // the older tool output was evicted; the conversation, including the newly moved c3, stays
 expect(f.stored.has(t4)||f.stored.has(t5)).toBe(false); // evicted units are gone from the store; they would be embedded again on re-entry
 expect(f.c.status().window).toMatchObject({conversation:{indexedCharacters:6,outOfViewCharacters:6}});
});
test('history churn and an exhausted work slice are not a failure: the state stays out of unavailable',()=>{
 const f=fixture();const internal=f.c as unknown as {error:string|null};
 for(const message of ['Eligible history changed; indexing incomplete','Eligible history changed before tokenization','Eligible branch or source changed before semantic admission','Preparation work slice exhausted; indexing incomplete','Semantic recall cancelled']){internal.error=message;expect(f.c.status().state).not.toBe('unavailable');}
 internal.error='Local runtime unavailable';expect(f.c.status().state).toBe('unavailable');
});
test('the coverage statement is the contiguous indexed prefix of the window, though later units may be stored',async()=>{
 const f=fixture();const ids=mixed(f);void ids;await f.internal.prepare(f.provider);
 const plan=f.internal.current!;expect(f.c.status().window).toMatchObject({indexedCharacters:14,conversation:{indexedCharacters:4}});
 plan.indexed.delete(plan.units[0]!.key); // the newest out-of-view conversation is not indexed yet; everything behind it is
 expect(f.c.status().window).toMatchObject({indexedCharacters:0,conversation:{indexedCharacters:0},toolResults:{indexedCharacters:0,oldestCoveredTime:null}});
});
test('a search ranks only the indexed prefix the notice states: stored vectors beyond it are never returned',async()=>{
 const f=fixture();mixed(f);await f.internal.prepare(f.provider);
 const plan=f.internal.current!;plan.indexed.delete(plan.units[2]!.key); // c2 and c1 are the prefix; t2, t1, c4, t3, c3 are stored, but a unit stands between them and the prefix
 const page=await f.c.search('query',f.provider);
 expect(page.status).toBe('ok');
 const texts=page.groups.flatMap(group=>group.sources.map(source=>source.text)).sort();
 expect(texts).toEqual(['c1','c2']);
 expect(page.coverage.window).toMatchObject({indexedCharacters:4,conversation:{indexedCharacters:4,outOfViewCharacters:4},toolResults:{indexedCharacters:0,outOfViewCharacters:4}});
 expect(page.notice).toContain('covers 4 of 4 characters of earlier conversation and 0 of 4 characters of earlier tool output');
 plan.indexed.delete(plan.units[0]!.key); // no prefix at all, though five units are stored
 expect((await f.c.search('query',f.provider)).status).toBe('indexing_incomplete');
});
test('when only conversation is indexed the sentence goes back to the oldest conversation covered',async()=>{
 const f=fixture({queryWaitMs:40});mixed(f);await f.internal.prepare(f.provider,false);
 f.failEmbedAfter=0; // the search starts a full pass, which cannot index anything more
 const page=await f.c.search('query',f.provider);
 expect(page.status).toBe('ok');expect(page.notice.endsWith('Semantic ranking covers 4 of 4 characters of earlier conversation and 0 of 4 characters of earlier tool output (newest first, back to 1970-01-01T00:00:01Z); use pi_tuck_recall for the rest.')).toBe(true);
});
test('the view comes from the latest compaction entry\'s first kept entry, the same boundary Pi projects',()=>{
 const six=(f:ReturnType<typeof fixture>)=>['m1','m2','m3','m4','m5','m6'].map(text=>f.append(text));
 const f=fixture();const ids=six(f);expect(viewStart(f.manager.getBranch())).toBe(0);
 for(const kept of [3,5]){
  f.cut(ids[kept]!);
  const branch=f.manager.getBranch(),projected=new Set(f.manager.buildSessionProjection().entries.map(entry=>entry.sourceEntry.id));
  const outside=branch.slice(0,viewStart(branch)).map(entry=>entry.id);
  expect(outside.every(id=>!projected.has(id))).toBe(true);expect(branch.slice(viewStart(branch)).every(entry=>projected.has(entry.id))).toBe(true);
  expect(viewStart(branch)).toBe(kept);
 }
 expect(semanticEligibleSources({cwd:'/p',sessionManager:f.manager},{},()=>{}).viewStart).toBe(5);
 const gone=fixture();six(gone);gone.cut('no-such-entry'); // a first kept entry that is not on the branch: everything before the compaction is out of view
 expect(viewStart(gone.manager.getBranch())).toBe(6);expect(gone.manager.buildSessionProjection().entries.filter(e=>e.sourceEntry.type==='message')).toHaveLength(0);
});
test('incomplete coverage is never ranked or query-embedded',async()=>{
 const f=fixture();f.append('first');f.cut('no-such-entry');f.failEmbed=true;
 const page=await f.c.search('query',f.provider);expect(page.status).toBe('unavailable');expect(page.groups).toEqual([]);expect(f.internal.current!.complete).toBe(false);expect(f.queryEmbeddings).toBe(0);
});
test('stale preparation join shares absolute readiness deadline and leaves preparation owned, without query embedding',async()=>{
 const f=fixture({queryWaitMs:40});f.append('old');f.cut('no-such-entry');let release!:()=>void;f.gate=new Promise<void>(done=>{release=done;});
 const task=f.internal.prepare(f.provider);f.internal.task=task;const terminal=Promise.allSettled([task]);
 try{
  // Let enumeration reach the held RPC before changing eligible history.
  await new Promise(done=>setTimeout(done,10));f.append('new');const started=performance.now();
  const page=await f.c.search('query',f.provider);expect(performance.now()-started).toBeLessThan(250);expect(page.status).toBe('indexing_incomplete');expect(f.queryEmbeddings).toBe(0);expect(f.c.status().enabled).toBe(true);expect(f.internal.task).toBe(task);
  release();await expect(task).rejects.toThrow('changed');
 }finally{release();await terminal;f.internal.task=undefined;f.gate=undefined;}
 await f.internal.prepare(f.provider);
 expect((await f.c.search('query',f.provider)).status).toBe('ok');expect(f.queryEmbeddings).toBe(1);
});
test('disable during a held stale preparation reports cancellation rather than deadline incompleteness',async()=>{
 const f=fixture({queryWaitMs:40});f.append('old');f.cut('no-such-entry');let release!:()=>void;f.gate=new Promise<void>(done=>{release=done;});
 const task=f.internal.prepare(f.provider);f.internal.task=task;const terminal=Promise.allSettled([task]);let closing:Promise<unknown>|undefined;
 try{
  await new Promise(done=>setTimeout(done,10));f.append('new');
  const rejection=expect(f.c.search('query',f.provider)).rejects.toThrow('cancelled');
  closing=Promise.allSettled([f.c.disable(false)]);
  await rejection;expect(f.queryEmbeddings).toBe(0);expect(f.c.status().enabled).toBe(false);
 }finally{release();await terminal;await closing;f.internal.task=undefined;f.gate=undefined;}
});
// T17: with nothing out of view (no cut) the whole history is in the agent's context, so a search never waits for indexing and never starts a worker.
const NOTHING_OUT='No semantic ranking performed: nothing is out of view, so the whole history is in your context.'; // one notice whether or not indexing is still running (doctrine chain: the coverage field carries progress)
test('no cut and a cold worker: the search returns indexing_incomplete at once, far under queryWaitMs, and starts no query work',async()=>{
 const f=fixture({queryWaitMs:60000});f.append('first source');f.append('second source');
 const started=performance.now(),page=await f.c.search('query',f.provider),elapsed=performance.now()-started;
 expect(elapsed).toBeLessThan(2000);expect(page.status).toBe('indexing_incomplete');expect(page.notice).toBe(NOTHING_OUT);expect(page.groups).toEqual([]);
 expect(f.queryEmbeddings).toBe(0);
});
test('after a cut the wait for out-of-view conversation is unchanged: a search holds until queryWaitMs and says nothing of the snapshot is indexed',async()=>{
 const f=fixture({queryWaitMs:150});mixed(f);f.embedGate=new Promise<void>(done=>{f.release=done;}); // the first batch is held, so nothing is indexed
 const started=performance.now(),page=await f.c.search('query',f.provider),elapsed=performance.now()-started;
 expect(elapsed).toBeGreaterThanOrEqual(100);expect(page.status).toBe('indexing_incomplete');expect(page.notice).toBe('No semantic ranking performed: nothing of the requested eligible snapshot is indexed yet.');
 f.release();await vi.waitFor(()=>expect(f.internal.task).toBeUndefined());
});
test('indexing proceeds in the background after the immediate return, and a cold worker is still not started by a later query',async()=>{
 const f=fixture({queryWaitMs:60000});f.append('first source');f.append('second source');
 expect((await f.c.search('query',f.provider)).status).toBe('indexing_incomplete');
 await vi.waitFor(()=>expect(f.c.status().indexingComplete).toBe(true));expect(f.stored.size).toBe(2);expect(f.embeddings).toBeGreaterThan(0);
 const page=await f.c.search('query',f.provider); // indexed, but no worker is running (the idle limit or a cancel gave it back): a query does not start one
 expect(page.status).toBe('indexing_incomplete');expect(page.notice).toBe(NOTHING_OUT);expect(f.queryEmbeddings).toBe(0);
});
test('nothing out of view, indexed, and a worker already running: the search ranks and states its coverage',async()=>{
 const f=fixture({queryWaitMs:60000});f.append('first source');f.append('second source');
 await f.internal.prepare(f.provider);expect(f.c.status().indexingComplete).toBe(true);
 (f.internal as unknown as {worker:unknown}).worker={close:async()=>{}}; // the mocked runtime above stands for the running worker
 const started=performance.now(),page=await f.c.search('query',f.provider),elapsed=performance.now()-started;
 expect(elapsed).toBeLessThan(2000);expect(page.status).toBe('ok');expect(page.method).toBe('embedding');expect(f.queryEmbeddings).toBe(1);
 expect(page.groups.flatMap(group=>group.sources.map(source=>source.text)).sort()).toEqual(['first source','second source']);
 expect(page.notice).toContain('Semantic ranking covers 0 of 0 characters of earlier conversation and 0 of 0 characters of earlier tool output');
});
test('nothing out of view, indexed, a worker present but marked for recycling after a heal: the search does not rank, so a query never rebuilds a worker',async()=>{
 const f=fixture({queryWaitMs:60000});f.append('first source');f.append('second source');
 await f.internal.prepare(f.provider);expect(f.c.status().indexingComplete).toBe(true);
 const internals=f.internal as unknown as {worker:unknown;recycle:boolean};internals.worker={close:async()=>{}};internals.recycle=true; // a WorkerFailure was healed and the retry timer has fired
 const page=await f.c.search('query',f.provider);
 expect(page.status).toBe('indexing_incomplete');expect(page.notice).toBe(NOTHING_OUT);expect(f.queryEmbeddings).toBe(0);
});
test('nothing out of view, indexed, a worker present but an idle stop in flight: the search does not rank, so a query never waits for the stop and then builds a worker',async()=>{
 const f=fixture({queryWaitMs:60000});f.append('first source');f.append('second source');
 await f.internal.prepare(f.provider);expect(f.c.status().indexingComplete).toBe(true);
 const internals=f.internal as unknown as {worker:unknown;idling?:Promise<void>};internals.worker={close:async()=>{}};
 let finish=()=>{};internals.idling=new Promise<void>(done=>{finish=done;}); // pending: the stop has not finished
 try{
  const page=await f.c.search('query',f.provider);
  expect(page.status).toBe('indexing_incomplete');expect(page.notice).toBe(NOTHING_OUT);expect(f.queryEmbeddings).toBe(0);
 }finally{finish();internals.idling=undefined;}
});
test('an empty history with nothing out of view: once indexed, the search answers no_matches without a worker or a query embedding',async()=>{
 const f=fixture({queryWaitMs:60000});
 const first=await f.c.search('query',f.provider); // the snapshot is not indexed yet
 expect(first.status).toBe('indexing_incomplete');expect(first.notice).toBe(NOTHING_OUT);
 await vi.waitFor(()=>expect(f.c.status().indexingComplete).toBe(true));
 const page=await f.c.search('query',f.provider);
 expect(page.status).toBe('no_matches');expect(page.notice).toBe('No eligible original source units in this snapshot.');expect(f.queryEmbeddings).toBe(0);
 expect((f.internal as unknown as {worker?:unknown}).worker).toBeUndefined();
});
