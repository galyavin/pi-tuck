import {expect,test,vi} from 'vitest';
import {SessionManager,DefaultResourceLoader,SettingsManager,type ExtensionToolContext} from '@earendil-works/pi-coding-agent';
import {installCompaction} from '../src/compaction';
import {compileDialogue,compileShrunkDialogue} from '../src/tuck/core/summarize';
import {parseRecords,serializeRecords,splitSummary} from '../src/tuck/core/transcript';
import {resolveSourceTime} from '../src/tuck/core/source-time';
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const answer=(text:string,timestamp=Date.UTC(2026,9,4))=>({role:'assistant' as const,content:[{type:'text' as const,text}],timestamp,stopReason:'stop' as const,api:'openai-codex-responses' as const,provider:'openai-codex',model:'gpt-6.1-sol',usage});
const rows=(summary:string)=>parseRecords(splitSummary(summary)!.body);

test('recorded native time wins over journal; invalid native uses labelled journal, invalid/missing stays unknown',()=>{
 expect(resolveSourceTime({type:'message',timestamp:'2026-10-05T01:02:03Z',message:{timestamp:Date.UTC(2026,9,1)}})).toEqual({basis:'message',utc:'2026-10-01T00:00:00Z'});
 for(const value of [undefined,NaN,Infinity,-1,'yesterday','2026-02-30T00:00:00Z']) expect(resolveSourceTime({type:'message',timestamp:'2026-10-05T01:02:03Z',message:{timestamp:value}})).toEqual({basis:'journal',utc:'2026-10-05T01:02:03Z'});
 expect(resolveSourceTime({timestamp:'2026-02-30T00:00:00Z'})).toEqual({basis:'unknown'});
 expect(resolveSourceTime({})).toEqual({basis:'unknown'});
});

test('actual registered source/search/continuation/around/image/export surfaces carry independent source times and exact bodies',async()=>{
 let handle:Awaited<ReturnType<typeof installCompaction>>|undefined;
 const HTTP=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('Unexpected HTTP')});
 try{
 const m=SessionManager.inMemory('/test'),old=m.appendMessage({role:'user',content:'needle original binding 😀\r\n',timestamp:Date.UTC(2026,9,5)});
 const call=m.appendMessage({...answer('needle producer',Date.UTC(2026,8,1)),stopReason:'toolUse',content:[{type:'toolCall',id:'call',name:'bash',arguments:{command:'check'}}]});
 const receipt=m.appendMessage({role:'toolResult',toolCallId:'call',toolName:'bash',content:[{type:'text',text:'needle receipt 😀\r\n'}],timestamp:Date.UTC(2026,9,2),isError:false});
 const image=m.appendMessage({role:'user',content:[{type:'image',mimeType:'image/png',data:'iVBORw0KGgo='}],timestamp:Date.UTC(2026,9,3)});
 for(let i=0;i<12;i++)m.appendMessage({role:'user',content:'needle qualification '+i,timestamp:Date.UTC(2026,9,4)});
 m.appendCustomMessageEntry('private','needle SECRET',false);
 const loader=new DefaultResourceLoader({cwd:'/test',agentDir:'/test',settingsManager:SettingsManager.inMemory(),noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,extensionFactories:[async pi=>{handle=await installCompaction(pi,{recallPolicy:{privateCustomTypes:['private']}});}]});await loader.reload();expect(loader.getExtensions().errors).toEqual([]);
 const tool=loader.getExtensions().extensions[0]!.tools.get('tuck_recall')!.definition;
 let written='';const ctx={sessionManager:m,executeTool:async(_name:string,args:{content:string})=>{written=args.content;return {content:[],isError:false};}} as unknown as ExtensionToolContext;
 const invoke=async(input:unknown)=>{const result=await tool.execute('time-contact',input,undefined,undefined,ctx);return {result,page:JSON.parse(result.content.find(b=>b.type==='text')!.text!)};};
 for(const input of [{entryId:old},{entryId:old,offset:3,limit:9},{entryId:old,query:'needle'}])expect((await invoke(input)).page.entries[0].sourceTime).toEqual({basis:'message',utc:'2026-10-05T00:00:00Z'});
 const source=(await invoke({entryId:receipt})).page.entries[0];expect(source.sourceTime.utc).toBe('2026-10-02T00:00:00Z');expect(source.producerTime.utc).toBe('2026-09-01T00:00:00Z');expect(source.producerCall.sourceTime).toEqual(source.producerTime);expect((await invoke(source.producerRead)).page.entries[0].sourceTime).toEqual(source.producerTime);
 const first=(await invoke({query:'needle'})).page,next=(await invoke({continuation:first.next})).page;expect(first.next).toBeDefined();for(const hit of [...first.hits,...next.hits])expect(hit.sourceTime.basis).toBe('message');expect(JSON.stringify(first).length).toBeLessThanOrEqual(16000);expect(JSON.stringify(next).length).toBeLessThanOrEqual(16000);
 const around=(await invoke({around:call})).page;expect(around.associatedReceipts.sources[0].sourceTime).toEqual(source.sourceTime);expect(around.associatedReceipts.sources[0].producerTime).toEqual(source.producerTime);for(const item of around.entries)expect(item.sourceTime.basis).toBe('message');expect(around.imageSources[0].sourceTime.utc).toBe('2026-10-03T00:00:00Z');
 const pixels=await invoke({entryId:image,image:0});expect(pixels.page.sourceTime.utc).toBe('2026-10-03T00:00:00Z');expect(pixels.result.content[1]).toEqual({type:'image',mimeType:'image/png',data:'iVBORw0KGgo='});
 const exported=(await invoke({entryId:receipt,outputPath:'recorded.txt'})).page;expect(exported.sourceTime).toEqual(source.sourceTime);expect(Buffer.from(written)).toEqual(Buffer.from(source.text));expect(JSON.stringify([first,next,around,exported])).not.toContain('SECRET');expect(HTTP).not.toHaveBeenCalled();
 }finally{await handle?.close();HTTP.mockRestore();}
});

test('public original custom notices keep their native entry identity and carry no time: only user turns are timed',()=>{
 const m=SessionManager.inMemory('/test'),id=m.appendCustomMessageEntry('public','Original public qualification',true),entry=m.getBranch()[0]!;
 const compiled=compileDialogue({messages:[{role:'custom',customType:'public',content:'Original public qualification',display:true,timestamp:999}],sourceIndices:[undefined],sourceEntryIds:[id],sourceTimes:[resolveSourceTime(entry)]});
 const record=rows(compiled)[0];expect(record.sourceEntryId).toBe(id);expect(resolveSourceTime(entry).basis).toBe('journal');expect(record).not.toHaveProperty('sourceTime');expect(record).not.toHaveProperty('sourceIndex');expect(parseRecords(serializeRecords([record]))).toEqual([record]);
});

test('portable core times user turns only, in the whole and the shrunk dialogue, and keeps strict serialization',()=>{
 const messages=[{role:'user' as const,content:'Old binding: retain qualified mode.',timestamp:999}, {...answer('later correction'),content:[{type:'text' as const,text:'later correction'},{type:'toolCall' as const,id:'a',name:'bash',arguments:{command:'check'}}]}, {role:'toolResult' as const,toolCallId:'a',toolName:'bash',content:[{type:'text' as const,text:'recorded output'}],isError:false,timestamp:999}];
 const sourceTimes=[{basis:'journal' as const,utc:'2026-01-01T00:00:00Z'},{basis:'message' as const,utc:'2026-02-01T00:00:00Z'},{basis:'unknown' as const}];
 const input={messages,sourceIndices:[5,6,7],sourceTimes,ranking:{maxBriefChars:2400}};
 const whole=compileDialogue(input),shrunk=compileShrunkDialogue(input),records=rows(shrunk);
 // The dialogue holds no tool record, so no call/result time either; the user turn alone is timed.
 expect(records.some(r=>r.kind==='tool_receipt'||r.kind==='tool_call')).toBe(false);
 expect(records.find(r=>r.role==='user')!.sourceTimes).toEqual([{sourceIndex:5,...sourceTimes[0]}]);
 expect(records.filter(r=>r.role!=='user').some(r=>r.sourceTimes)).toBe(false);
 expect(shrunk.length).toBeLessThanOrEqual(2400);expect(shrunk).toBe(whole);expect(parseRecords(serializeRecords(records))).toEqual(records);expect(shrunk).not.toContain('1970');
 expect(()=>parseRecords(JSON.stringify({...records[0],sourceTimes:[{sourceIndex:999,basis:'unknown'}]}))).toThrow('Mismatched');
 expect(()=>parseRecords(JSON.stringify({...records[0],sourceTimes:[{sourceIndex:5,basis:'message',utc:'2026-02-30T00:00:00Z'}]}))).toThrow();
});

