import { scriptedModelRuntime } from './model-fixture';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, expect, vi } from 'vitest';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';

for (const kind of ['fit', 'conversation', 'tools', 'effective-override'] as const)
test(`complete native request budget admits or rejects before effects: ${kind}`, async () => {
 const dir=mkdtempSync(join(tmpdir(),'pi-request-budget-'));let session:AgentSession|undefined;
 const network=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('Unexpected HTTP');});
 try {
  const runtime=await scriptedModelRuntime(),model=runtime.getModel('openai-codex','gpt-6.1-sol');
  if(!model)throw Error('Required catalogue model unavailable');
  const settings=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false,reserveTokens:32768,
   ...(kind==='effective-override'?{modelOverrides:{[`${model.provider}/${model.id}`]:{reserveTokens:model.contextWindow-1}}}:{})}});
  const manager=SessionManager.inMemory(dir);
  const words=kind==='conversation'?145000:kind==='tools'?143000:1;
  const sourceId=manager.appendMessage({role:'user',content:'x'.repeat(words*4),timestamp:0});
  const original=JSON.stringify(manager.getEntries().find(e=>e.id===sourceId));
  let requests=0,effects=0,permitted=true;const faults:string[]=[];
  const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager:settings,noExtensions:true,noSkills:true,noContextFiles:true,noPromptTemplates:true,noThemes:true,systemPrompt:'Budget contact',extensionFactories:[async pi=>{
   // Exercise actual effective Pi settings, including in-memory model overrides.
   await installCompaction(pi,{cutAt:1,assertAccess:()=>{if(!permitted)throw Error('Revoked');},fail:e=>{faults.push(String(e));permitted=false;}});
  }]});await loader.reload();expect(loader.getExtensions().errors).toEqual([]);
  ({session}=await createAgentSession({cwd:dir,modelRuntime:runtime,model,thinkingLevel:'low',sessionManager:manager,settingsManager:settings,resourceLoader:loader,tools:['effect'],customTools:[{
   name:'effect',label:'Effect',description:kind==='tools'?'d'.repeat(12000):'Local effect witness',parameters:Type.Object({}),
   execute:async()=>{effects++;return {content:[],details:{}};},
  }]}));await session.bindExtensions({});
  session.agent.streamFunction=(_m,_ctx,options)=>{
   const aborted=Boolean(options?.signal?.aborted);if(!aborted)requests++;
   const message:AssistantMessage={role:'assistant',content:aborted?[]:requests===1?[{type:'toolCall',id:'budget-effect',name:'effect',arguments:{}}]:[{type:'text',text:'Finished'}],api:model.api,provider:model.provider,model:model.id,timestamp:1,stopReason:aborted?'aborted':requests===1?'toolUse':'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
   const stream=createAssistantMessageEventStream();stream.push(aborted?{type:'error',reason:'aborted',error:message}:{type:'done',reason:message.stopReason==='toolUse'?'toolUse':'stop',message});stream.end(message);return stream;
  };
  await session.prompt('Continue');
  if(kind==='fit'){expect(faults).toEqual([]);expect(requests).toBe(2);expect(effects).toBe(1);}
  else {expect(faults.join(' ')).toContain('Complete Pi context');expect(requests).toBe(0);expect(effects).toBe(0);expect(permitted).toBe(false);}
  expect(network).not.toHaveBeenCalled();expect(JSON.stringify(manager.getEntries().find(e=>e.id===sourceId))).toBe(original);
 } finally {if(session){await session.abort();session.dispose();}network.mockRestore();rmSync(dir,{recursive:true,force:true});}
});
