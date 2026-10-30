import { scriptedModelRuntime } from './model-fixture';
import {test,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime,SessionManager,SettingsManager,DefaultResourceLoader,createAgentSession,type AgentSession} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream,type AssistantMessage,type UserMessage} from '@earendil-works/pi-ai';
import {installCompaction} from '../src/compaction';
import {parseRecords,TRANSCRIPT_HEADER,splitSummary} from '../src/tuck/core/transcript';
import {Type} from 'typebox';
for(const kind of ['repeated-text','active-auto','unobserved-text','image','omitted','superseded','capacity-conflict'] as const)
test(`current input source remains complete or explicitly fails: ${kind}`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-current-input-'));let session:AgentSession|undefined, handle:Awaited<ReturnType<typeof installCompaction>>|undefined;
 const network=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('Unexpected HTTP');});
 try{
  const runtime=await scriptedModelRuntime(),model=runtime.getModel('openai-codex','gpt-6.1-sol');if(!model)throw Error('Required catalogue model unavailable');
  const manager=SessionManager.inMemory(dir),faults:string[]=[];
  const answer=(content:AssistantMessage['content'],stopReason:AssistantMessage['stopReason']='stop'):AssistantMessage=>({role:'assistant',content,stopReason,api:model.api,provider:model.provider,model:model.id,timestamp:0,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}}});
  const cycle=(id:string,n:number)=>{
   manager.appendMessage(answer([{type:'toolCall',id,name:'read',arguments:{path:id}}],'toolUse'));
   manager.appendMessage({role:'toolResult',toolCallId:id,toolName:'read',isError:false,timestamp:0,content:[{type:'text',text:'Observed mechanical test data.\n'.repeat(n)}]});
   manager.appendMessage(answer([{type:'text',text:'Observed prior result'}]));
  };
  manager.appendMessage({role:'user',content:'Earlier historical task',timestamp:0});cycle('prior',5000);
  const text='CURRENT_SOURCE_BEGIN\r\n\u001b[31m'+Array.from({length:260},(_,i)=>'Exact current condition '+i+': preserve the public interface and current policy.').join('\r\n')+'\r\nCURRENT_SOURCE_LAST_RESTRICTION';
  const content:UserMessage['content']=kind==='image'?[{type:'text',text},{type:'image',mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9l8AAAAASUVORK5CYII='}]:kind==='capacity-conflict'?'CURRENT_SOURCE_BEGIN '+'x'.repeat(580000):text;
  const id=manager.appendMessage({role:'user',content,timestamp:0});
  if(kind!=='unobserved-text')for(let i=0;i<5;i++)cycle('done-'+i,1800);
  if(kind==='omitted')manager.appendContextEdit(id,null);
  if(kind==='superseded'){manager.appendMessage({role:'user',content:'NEW_CURRENT_SOURCE',timestamp:0});for(let i=0;i<5;i++)cycle('new-'+i,1800);}
  const originals=manager.getEntries().map(e=>({id:e.id,json:JSON.stringify(e)}));
  const settings=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:true,reserveTokens:model.maxTokens+8192,keepRecentTokens:0}});
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,systemPrompt:'Free current-source invariant',extensionFactories:[async pi=>{handle=await installCompaction(pi,{settings,fail:e=>faults.push(String(e))});}]});
  await loader.reload();({session}=await createAgentSession({cwd:dir,modelRuntime:runtime,model,thinkingLevel:'low',sessionManager:manager,settingsManager:settings,resourceLoader:loader,tools:['tuck_recall','read'],customTools:[{name:'read',label:'Read',description:'Free observed current-round witness',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'New observed mechanical data.\n'.repeat(1800)}],details:{}})}]}));await session.bindExtensions({});session.agent.streamFunction=()=>{throw Error('Unexpected model request');};
  if(kind==='active-auto'){
   let requests=0;
   session.agent.streamFunction=()=>{
    requests++;const content:AssistantMessage['content']=requests<=2?Array.from({length:4},(_,i)=>({type:'toolCall',id:'new-observation-'+requests+'-'+i,name:'read',arguments:{}})):[{type:'text',text:'Scripted valid continuation.'}];
    const message=answer(content,requests<=2?'toolUse':'stop');message.usage.input=requests<=2?140000:1;message.usage.totalTokens=message.usage.input;
    const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:requests<=2?'toolUse':'stop',message});stream.end(message);return stream;
   };
   await session.prompt(text);
   const cut=manager.getBranch().findLast(e=>e.type==='compaction');expect(cut?.type).toBe('compaction');
   if(cut?.type!=='compaction')throw Error('Missing automatic native cut');
   const records=parseRecords(splitSummary(cut.summary)!.body);
   const historical=records.some(r=>r.kind==='excerpt'&&r.role==='user'&&r.text===text);
   const native=manager.buildSessionProjection().messages.some(m=>m.role==='user'&&(typeof m.content==='string'?m.content:m.content.flatMap(b=>b.type==='text'?[b.text]:[]).join('\n'))===text);
   expect(historical||native).toBe(true);expect(requests).toBe(3);expect(faults).toEqual([]);
  }else if(kind==='capacity-conflict'){
   await expect(session.compact()).rejects.toThrow('Compaction cancelled');expect(manager.getEntries().filter(e=>e.type==='compaction')).toHaveLength(0);
  }else{
   for(let i=0;i<(kind==='repeated-text'?3:1);i++){
    if(i)for(let j=0;j<3;j++)cycle('additional-'+i+'-'+j,2000);
    const cut=await session.compact(),view=manager.buildSessionProjection().messages;
    const records=parseRecords(splitSummary(cut.summary)!.body);
    if(kind==='image'||kind==='unobserved-text')expect(view.some(m=>m.role==='user'&&JSON.stringify(m.content)===JSON.stringify(content))).toBe(true);
    else if(kind==='repeated-text')expect(records.some(r=>r.kind==='excerpt'&&r.role==='user'&&r.text===text)).toBe(true);
    else if(kind==='omitted')expect(JSON.stringify(view)).not.toContain('CURRENT_SOURCE_BEGIN');
    else {
     // A newer current source removes mandatory protection, not historical evidence.
     expect(JSON.stringify(view)).toContain('NEW_CURRENT_SOURCE');
     expect(records.filter(r=>r.kind==='excerpt'&&r.text==='NEW_CURRENT_SOURCE').length).toBeLessThanOrEqual(1);
    }
   }
   expect(faults).toEqual([]);
  }
  for(const e of originals)expect(JSON.stringify(manager.getEntries().find(x=>x.id===e.id))).toBe(e.json);
  expect(network).not.toHaveBeenCalled();
 }finally{if(session)await session.abort();await handle?.close();session?.dispose();network.mockRestore();rmSync(dir,{recursive:true,force:true});}
});
