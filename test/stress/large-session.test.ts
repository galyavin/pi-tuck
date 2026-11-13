import {afterAll,expect,test,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager,type ExtensionAPI,type ExtensionContext} from '@earendil-works/pi-coding-agent';
import {installCompaction} from '../../src/compaction';
import {createSemanticRecall} from '../../src/semantic-recall';
import {projectedMessages} from '../../src/omissions';
import * as content from '../../src/tuck/core/content';
import {serializeTranscript} from '../../src/tuck/core/transcript';
import {DIALOGUE_SUFFIX} from '../../src/tuck/core/format';

// Search on a session of a real long-running agent's size: about 85 MB, growing between searches, with the next plan still preparing when a
// search comes. Three field defects lived only there (2026-11-10): the keyword half's time limit failed the whole search; a search answered
// "nothing indexed" while its plan was fully indexed; earlier results stopped matching a grown snapshot. A fake encoder stands in for EG-2, so
// this runs on any machine; it checks the search's contract, not ranking quality. Runs with the stress suite (STRESS=1).
const RUN=/^(1|true|yes)$/i.test(process.env.STRESS??''), TARGET_MB=Number(process.env.LARGE_SESSION_MB)||85;
const root=mkdtempSync(join(tmpdir(),'large-session-'));afterAll(()=>rmSync(root,{recursive:true,force:true}));
let seed=0x1a2b3c;const rnd=()=>{seed=(seed*1103515245+12345)>>>0;return seed/2**32;};
const WORDS='permit contractor ledger invoice accela portal record status window export capped grid source index change store probe tenant license address parcel'.split(' ');
const text=(n:number)=>Array.from({length:n},()=>WORDS[Math.floor(rnd()*WORDS.length)]).join(' ');
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
let at=0,calls=0;
/** One agent round: a short thought and a tool call, then a tool result of a few kilobytes, with a cut every `cutEvery` rounds. */
function round(m:SessionManager,i:number,cutEvery=400){
 const id='call_'+(++calls);
 m.appendMessage({role:'assistant',content:[{type:'thinking',thinking:text(40),thinkingSignature:'reasoning_content'},{type:'text',text:text(12)},{type:'toolCall',id,name:'bash',arguments:{command:'grep -n '+WORDS[i%WORDS.length]+' data/file_'+i+'.txt'}}],api:'openai-completions',provider:'fixture',model:'fixture',usage,stopReason:'toolUse',timestamp:++at} as never);
 m.appendMessage({role:'toolResult',toolCallId:id,toolName:'bash',content:[{type:'text',text:'line '+i+': '+text(380)}],isError:false,timestamp:++at} as never);
 if(i%cutEvery===cutEvery-1)m.appendCompaction('summary through round '+i,'no-such-entry',100,undefined,true);
}
function fixture(){
 const c=createSemanticRecall({pythonPath:'/unused',runtimeRoot:join(root,'rt'),indexDirectory:join(root,'idx'),queryWaitMs:2000});c.enable();
 const internal=c as any,stored=new Set<string>(),state={tokenizeMs:0};
 internal.runtime=async()=>({call:async(op:string,input:any)=>{
  if(op==='tokenize'){if(state.tokenizeMs)await new Promise(r=>setTimeout(r,state.tokenizeMs));return {ranges:[[{start:0,end:input.texts[0].length}]]};}
  if(op==='embed')return {vectors:input.texts.map(()=>[1])};
  if(op==='index'){if(input.action==='upsert')for(const row of input.rows)stored.add(row.key);if(input.action==='status')return {coveredKeys:input.keys.filter((k:string)=>stored.has(k))};
   if(input.action==='score'){const found=input.keys.filter((k:string)=>stored.has(k));return {ranked:found.slice(0,24).map((key:string)=>({key,score:1})),observed:found.length};}return {};}
  throw new Error('unexpected RPC '+op);}});
 return {c,state};
}

/** Use this same 85 MB fixture, rather than a small proxy: a warm projection reads no old output text, and an append reads only the new
 * result. The spy proves incremental work without depending on a wall-clock threshold; timings include the normal projection filters. */
function checkTwinProjection(m:SessionManager){
 const text=Array.from({length:6},(_,i)=>`Twin stress substantive line ${i}: retained original evidence.`).join('\n');
 const append=()=>{
  const id='call_'+(++calls);
  m.appendMessage({role:'assistant',content:[{type:'toolCall',id,name:'read',arguments:{path:'twin.txt'}}],api:'openai-completions',provider:'fixture',model:'fixture',usage,stopReason:'toolUse',timestamp:++at});
  m.appendMessage({role:'toolResult',toolCallId:id,toolName:'read',content:[{type:'text',text}],isError:false,timestamp:++at});
  return id;
 };
 append();
 const keep=m.appendMessage({role:'user',content:'Continue with the stress fixture.',timestamp:++at});
 m.appendCompaction(serializeTranscript([{kind:'omission',reason:'Earlier outputs are out of view.'}])+DIALOGUE_SUFFIX,keep,10000,{compactor:'pi-tuck'},true);
 const repeated=append(),ctx={sessionManager:m,cwd:join(root,'project')} as unknown as ExtensionContext;
 const reads=vi.spyOn(content,'textOf');
 try{
  const messages=m.buildSessionProjection().messages,start=performance.now(),cold=projectedMessages(messages,ctx),coldMs=performance.now()-start;
  const result=cold.find(message=>message.role==='toolResult'&&message.toolCallId===repeated);
  expect(result).toMatchObject({content:[{type:'text',text},{type:'text',text:expect.stringContaining('[pi-tuck: this output repeats output #')}]});
  expect(reads.mock.calls.length).toBeGreaterThan(1000);reads.mockClear();
  const warm:number[]=[];
  for(let i=0;i<20;i++){const start=performance.now(),projected=projectedMessages(messages,ctx);warm.push(performance.now()-start);expect(projected).toEqual(cold);}
  expect(reads).not.toHaveBeenCalled();
  append();
  const grown=m.buildSessionProjection().messages,startAppend=performance.now();projectedMessages(grown,ctx);const appendMs=performance.now()-startAppend;
  expect(reads).toHaveBeenCalledTimes(1);
  process.stdout.write(`twin projection at ~${TARGET_MB} MB: cold ${coldMs.toFixed(1)} ms, warm median ${warm.sort((a,b)=>a-b)[10]!.toFixed(2)} ms, append ${appendMs.toFixed(2)} ms; old outputs rescanned: 0\n`);
 }finally{reads.mockRestore();}
}

test.skipIf(!RUN)(`search on a ~${TARGET_MB} MB session that grows between searches, with the next plan still preparing`,async()=>{
 const m=SessionManager.inMemory(join(root,'project'));m.appendMessage({role:'user',content:'Long-running task: '+text(60),timestamp:++at});
 let i=0;const bytes=()=>JSON.stringify(m.getEntries()).length;
 while(i%2000!==0||bytes()<TARGET_MB*1e6){round(m,i++);if(i>200000)throw new Error('size not reached');}
 const {c,state}=fixture(),tools:any[]=[];
 await installCompaction({registerCommand:()=>{},registerTool:(t:any)=>tools.push(t),on:()=>()=>{}} as unknown as ExtensionAPI,{semanticRecall:c,search:true});
 const search=async(query:string)=>{
  const result=await tools.find(t=>t.name==='tuck_search').execute('s',{query},undefined,undefined,{sessionManager:m,cwd:join(root,'project')});
  expect(result.isError,JSON.stringify(result.content).slice(0,300)).not.toBe(true);
  const [words,page]=result.content.map((b:any)=>JSON.parse(b.text));
  expect(words.status==='keyword_timeout'||Array.isArray(words.hits),JSON.stringify(words).slice(0,200)).toBe(true);
  return page;
 };
 // A first search on the whole history: it never fails the call, and with nothing indexed it says so or ranks what it has.
 const first=await search('accela export capped grid');
 expect(['ok','indexing_incomplete']).toContain(first.status);
 // Let the plan finish, as background preparation would. The provider is the one tuck_search gave the controller.
 const provider=(c as any).provider;
 for(let k=0;k<600&&!(c.status() as any).indexingComplete;k++){await c.search('warm up',provider);await new Promise(r=>setTimeout(r,50));}
 expect((c.status() as any).indexingComplete).toBe(true);
 // Three turns: the session grows, the next plan prepares slower than a search waits, and a search comes meanwhile. It ranks the plan it grew
 // from (every unit of which is indexed) and says what that covers; it never answers "nothing indexed" while a complete plan exists.
 for(let turn=0;turn<3;turn++){
  for(let k=0;k<300;k++)round(m,i++,100);
  state.tokenizeMs=20;c.schedule(provider);await new Promise(r=>setTimeout(r,30));
  const page=await search('permit contractor license '+turn);
  expect(page.status,page.notice).toBe('ok');
  expect(page.notice).toMatch(/This ranking covers the history through entry|Semantic ranking covers/);
  state.tokenizeMs=0;
  for(let k=0;k<600&&!(c.status() as any).indexingComplete;k++)await new Promise(r=>setTimeout(r,50));
 }
 await c.close();
 checkTwinProjection(m);
},30*60*1000);
