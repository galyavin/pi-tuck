import {test,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {SessionManager,type ExtensionAPI,type ToolDefinition,type ExtensionToolContext} from '@earendil-works/pi-coding-agent';
import {createSemanticRecall,type PriorResult,type SemanticGroup} from '../src/semantic-recall';
import {installCompaction} from '../src/compaction';

// A model passes a returned source back in priorResults as it got it: its sourceSha and read, unchanged. Ranges in any other shape are refused.
test('tuck_search takes a returned source\'s sourceSha and read unchanged as a prior result',async()=>{
 const m=SessionManager.inMemory('/search-prior-test');m.appendMessage({role:'user',content:'needle original qualification',timestamp:1});
 const sourceSha=createHash('sha256').update('a').digest('hex');
 const returned={entryId:'a',role:'user',text:'qualification',sourceSha,textOffset:40,totalCharacters:200,read:{entryId:'a',offset:40,limit:13},complete:false,sourceTime:{basis:'message',utc:'2026-10-01T00:00:00Z'}};
 const semantic=createSemanticRecall(),seen:PriorResult[][]=[];
 semantic.search=async(_query:string,_provider:unknown,_signal?:AbortSignal,prior:PriorResult[]=[])=>{seen.push([...prior]);return{status:'ok',notice:'Original evidence.',coverage:semantic.status(),groups:[{sources:[returned],notice:"Original coherent group."}] as unknown as SemanticGroup[]} as never;};
 let tool:ToolDefinition|undefined;const pi={on:()=>{},registerCommand:()=>{},registerTool:(t:ToolDefinition)=>{if(t.name==='tuck_search')tool=t;}} as unknown as ExtensionAPI;
 const handle=await installCompaction(pi,{semanticRecall:semantic,assertAccess:()=>{}});const ctx={cwd:'/search-prior-test',sessionManager:m} as unknown as ExtensionToolContext;
 try{
  const first=await tool!.execute('first',{query:'needle'},undefined,undefined,ctx);
  const source=(JSON.parse(first.content[1]!.type==='text'?first.content[1]!.text:'') as {groups:{sources:typeof returned[]}[]}).groups[0]!.sources[0]!;
  await tool!.execute('again',{query:'needle',priorResults:[{sourceSha:source.sourceSha,read:source.read}]},undefined,undefined,ctx);
  expect(seen[1]).toEqual([{entryId:'a',sourceSha,start:40,end:53}]);
  await expect(tool!.execute('old',{query:'needle',priorResults:[{entryId:'a',sourceSha,start:40,end:53}]} as never,undefined,undefined,ctx)).rejects.toThrow('Invalid broad search input');
 }finally{await handle.close();}
});
