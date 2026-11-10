import {afterEach,expect,test} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createSemanticRecall,semanticEligibleSources} from '../src/semantic-recall';

// A search used to answer `indexing_incomplete` ("nothing of the requested eligible snapshot is indexed yet") while every unit of the plan it
// had was indexed: the session grew after a turn, the next plan was still preparing (tokenizing a large window can outlast the wait), and the
// search accepted only a plan for exactly its own snapshot. Seen in the field with 2,863 of 2,863 units indexed. Now a search ranks the latest
// plan the session has only grown from, and says which entries that ranking covers; a plan whose sources changed is still not ranked.
const roots:string[]=[];afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'semantic-grown-'));roots.push(root);
 const c=createSemanticRecall({pythonPath:'/unused',runtimeRoot:join(root,'rt'),indexDirectory:join(root,'idx'),queryWaitMs:1000});c.enable();
 const internal=c as any,stored=new Set<string>(),state={slow:false};
 internal.runtime=async()=>({call:async(op:string,input:any)=>{
  if(op==='tokenize'){if(state.slow)await new Promise(r=>setTimeout(r,400));return {ranges:[[{start:0,end:input.texts[0].length}]]};}
  if(op==='embed')return {vectors:input.texts.map(()=>[1])};
  if(op==='index'){if(input.action==='upsert')for(const row of input.rows)stored.add(row.key);if(input.action==='status')return {coveredKeys:input.keys.filter((k:string)=>stored.has(k))};
   if(input.action==='score'){const found=input.keys.filter((k:string)=>stored.has(k));return {ranked:found.slice(0,24).map((key:string)=>({key,score:1})),observed:found.length};}return {};}
  throw new Error('unexpected RPC '+op);}});
 const cwd=join(root,'project'),manager=SessionManager.inMemory(cwd);let at=0;const add=(text:string)=>manager.appendMessage({role:'user',content:text,timestamp:++at*1000});
 const provider=()=>semanticEligibleSources({cwd,sessionManager:manager},{},()=>{});
 return {c,state,manager,add,provider};
}
test('the next plan still preparing past the wait: the search ranks the fully indexed plan it grew from, and says what it covers', async()=>{
 const f=fixture();
 for(let i=0;i<5;i++)f.add('decision '+i);f.manager.appendCompaction('first summary','no-such-entry',100,undefined,true);f.add('after the first cut');
 expect((await f.c.search('decision',f.provider)).status).toBe('ok');
 const through=(f.c.status() as any).throughEntryId;
 for(let i=0;i<8;i++)f.add('later work '+i);f.manager.appendCompaction('second summary','no-such-entry',100,undefined,true);f.add('after the second cut');
 f.state.slow=true;f.c.schedule(f.provider);await new Promise(r=>setTimeout(r,20));
 const page=await f.c.search('decision',f.provider) as any;
 expect(page.status).toBe('ok');
 expect(page.groups.length).toBeGreaterThan(0);
 expect(page.notice).toContain(`This ranking covers the history through entry ${through}`);
 await f.c.close();
});
test('a plan the session did not only grow from is not ranked', async()=>{
 const f=fixture();
 for(let i=0;i<5;i++)f.add('decision '+i);f.manager.appendCompaction('first summary','no-such-entry',100,undefined,true);f.add('after the first cut');
 expect((await f.c.search('decision',f.provider)).status).toBe('ok');
 const internal=f.c as any;internal.current={...internal.current,sources:internal.current.sources.map((s:any,i:number)=>i?s:{...s,sha:'f'.repeat(64)})}; // one source no longer matches
 for(let i=0;i<8;i++)f.add('a new turn '+i);f.state.slow=true;f.c.schedule(f.provider);await new Promise(r=>setTimeout(r,20));
 const page=await f.c.search('decision',f.provider) as any;
 expect(page.status).not.toBe('ok');
 await f.c.close();
});
