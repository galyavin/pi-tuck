import {afterEach,expect,test,vi} from 'vitest';
import {SessionManager,type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {installCompaction} from '../src/compaction';

// On a very long history the keyword half of tuck_search can hit its time limit. Before, that failed the whole search with advice to simplify a
// regex the agent never wrote (seen in the field on an 84.7 MB session). Now the semantic half still answers, and the keyword half says it stopped.
afterEach(()=>{vi.restoreAllMocks();});
test('a keyword time-out returns the semantic results and says the keyword half stopped', async()=>{
 const m=SessionManager.inMemory('/tmp/keyword-timeout');for(let i=0;i<4;i++)m.appendMessage({role:'user',content:'decision '+i,timestamp:i+1});
 m.appendCompaction('summary','no-such-entry',100,undefined,true);m.appendMessage({role:'user',content:'after the cut',timestamp:9});
 const page={status:'ok',notice:'semantic page',coverage:{snapshotId:'s'},groups:[]};
 const semantic={search:vi.fn(async()=>page),status:()=>({enabled:true}),close:async()=>{}} as never;
 const tools:any[]=[];await installCompaction({registerCommand:()=>{},registerTool:(t:any)=>tools.push(t),on:()=>()=>{}} as unknown as ExtensionAPI,{semanticRecall:semantic,search:true});
 let clock=1e12;vi.spyOn(Date,'now').mockImplementation(()=>(clock+=4000)); // every budget check sees the limit passed
 const result=await tools.find(t=>t.name==='tuck_search').execute('x',{query:'decision'},undefined,undefined,{sessionManager:m,cwd:'/tmp/keyword-timeout'});
 expect(result.isError).not.toBe(true);
 const [words,semanticPage]=result.content.map((b:any)=>JSON.parse(b.text));
 expect(words.status).toBe('keyword_timeout');expect(words.notice).toContain('the semantic results follow');
 expect(semanticPage.notice).toBe('semantic page');
});
test('the keyword time-out message no longer tells the agent to simplify a regex', async()=>{
 const {tuck,tuckRecall}=await import('../src/tuck');
 const m=SessionManager.inMemory('/tmp/keyword-timeout-2');for(let i=0;i<4;i++)m.appendMessage({role:'user',content:'decision '+i,timestamp:i+1});
 let clock=1e12;vi.spyOn(Date,'now').mockImplementation(()=>(clock+=4000));
 expect(()=>tuckRecall(tuck,m.getEntries(),m.getBranch(),{query:'decision'})).toThrow(/^Search aborted: query exceeded 3000ms on this history\. Use more specific words/);
});
