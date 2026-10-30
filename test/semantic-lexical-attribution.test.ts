import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {test,expect} from 'vitest';
import {SessionManager,type ExtensionAPI,type ExtensionToolContext,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {installCompaction} from '../src/compaction';
import {createSemanticRecall,semanticEligibleSources} from '../src/semantic-recall';
import {tuck,tuckRecall} from '../src/tuck';

// Out of contract (eligibility-cache.ts): an entry edited in place after it was appended, and a readAttemptMarker whose behaviour changes after install. The lexical recheck of tuck_search
// reruns only when eligibilityKey moves, so those are not pinned here (they were the 'attempt', 'invalid' and 'interpretation' cases). The cases below stay in contract.
for(const change of ['unchanged','access','cancel'] as const)test(`actual lexical offer binds excluded receipt attempt metadata: ${change}`,async()=>{
 const cwd='/lexical-attribution-contact',m=SessionManager.inMemory(cwd);
 m.appendMessage({role:'user',content:'Eligible ordinary history.',timestamp:1});
 const markerId=m.appendCustomEntry('contact.attempt',{attemptId:'old'});
 const receiptId=m.appendMessage({role:'toolResult',toolCallId:'recorded',toolName:'bash',content:[{type:'text',text:'needle recorded receipt unchanged'}],isError:false,timestamp:2});
 m.appendContextEdit(receiptId,null);m.appendCompaction('summary of what was cut','no-such-entry',100,undefined,true); // everything above is out of view, so the search waits for the indexed window (with nothing out of view it does not)
 let permitted=true;
 const policy={attemptMarkerType:'contact.attempt',readAttemptMarker:(entry:any)=>typeof entry.data.attemptId==='string'?{nodeId:'host',attemptId:entry.data.attemptId}:undefined};
 const access=()=>{if(!permitted)throw Error('Access revoked');};
 const provider=()=>semanticEligibleSources({cwd,sessionManager:m},policy,access);
 const initial=provider();expect(initial.sources.some(s=>s.entry.id===receiptId)).toBe(false);
 const resources=fileURLToPath(new URL('../',import.meta.url));
 const semantic=createSemanticRecall({pythonPath:resolve('/unused'),runtimeRoot:join(resources,'test'),indexDirectory:join(resources,'.cache/lexical-contact')}) as any;semantic.enabled=true;semantic.current=initial;initial.complete=true;
 initial.units=initial.sources.map((source:any,i)=>({source,key:String(i),entryId:source.entry.id,start:0,end:source.sourceText.length,encoded:source.sourceText,inputSha:source.sha}));initial.indexed=new Set(initial.units.map((u:any)=>u.key));initial.window={order:initial.sources,counts:initial.sources.map(()=>1),searchUnits:0,windowCharacters:0,eligibleCharacters:0,conversationOutOfView:0,toolOutOfView:0};
 let resume!:()=>void,paused!:()=>void;const entered=new Promise<void>(done=>paused=done),gate=new Promise<void>(done=>resume=done);
 semantic.runtime=async()=>({call:async(op:string,input:any)=>{expect(op).toBe('embed');expect(input.kind).toBe('query');paused();await gate;return{vectors:[[1]]};}});
 semantic.index=async()=>({ranked:initial.units.slice(0,24).map((u:any)=>({key:u.key,score:1})),observed:initial.units.length});
 let tool:ToolDefinition|undefined;const pi={on:()=>{},registerCommand:()=>{},registerTool:(t:ToolDefinition)=>{if(t.name==='tuck_search')tool=t;}} as unknown as ExtensionAPI;
 const handle=await installCompaction(pi,{semanticRecall:semantic,recallPolicy:policy,assertAccess:access});
 const words=()=>{const page=tuckRecall(tuck,m.getEntries(),m.getBranch(),{query:'needle'},policy);if(!('hits' in page))throw Error('Expected lexical discovery page');return page;},before=words();
 expect(before.hits[0]?.recordedAttempt).toEqual({nodeId:'host',attemptId:'old'});
 const receiptBefore=JSON.stringify(m.getEntries().find(e=>e.id===receiptId)),branchBefore=m.getBranch().map(e=>[e.id,e.parentId]);
 const signal=new AbortController(),running=tool!.execute('contact',{query:'needle'},signal.signal,undefined,{cwd,sessionManager:m} as unknown as ExtensionToolContext);
 // Attach rejection handling before inducing cancellation/revocation.
 const outcome=running.then(result=>({result}),error=>({error}));
 try{
  await entered;
  const marker=m.getBranch().find(e=>e.id===markerId)!;expect(marker.type).toBe('custom');
  if(change==='access')permitted=false;
  if(change==='cancel')signal.abort();
  expect(JSON.stringify(m.getEntries().find(e=>e.id===receiptId))).toBe(receiptBefore);
  expect(m.getBranch().map(e=>[e.id,e.parentId])).toEqual(branchBefore);
  if(change!=='access')expect(provider().id).toBe(initial.id); // The semantic frontier cannot observe this attribution dependency.
  resume();const out=await outcome;
  if(change==='access'||change==='cancel'){expect('error' in out).toBe(true);if('error' in out)expect(String(out.error)).toMatch(change==='access'?/Access revoked/:/cancelled/);return;}
  if('error' in out)throw out.error;
  const texts=out.result.content.filter(b=>b.type==='text').map(b=>b.text!);
  expect(texts[0]).toBe(JSON.stringify(before));expect(texts.join('\n').length).toBeLessThanOrEqual(20000);expect(JSON.parse(texts[1]!).status).toBe('ok');
 }finally{resume();await outcome;await handle.close();expect(semantic.activeSearches.size).toBe(0);}
});
