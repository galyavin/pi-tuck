import {expect,test,vi} from 'vitest';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {installCompaction} from '../src/compaction';

// A reply that stops at the output limit may be cut off, and plain Pi says nothing. pi-tuck tells the operator once per run, on the operator's
// side only, decided when the run settles: a later reply that ends normally (a retry, a continuation) clears it.
async function fixture(){
 const handlers=new Map<string,((event:any,ctx:any)=>unknown)[]>();
 const pi={registerCommand:()=>{},registerTool:()=>{},on:(name:string,h:any)=>{handlers.set(name,[...(handlers.get(name)??[]),h]);return ()=>{};},getActiveTools:()=>[],getAllTools:()=>[]} as unknown as ExtensionAPI;
 await installCompaction(pi,{search:false});
 const notices:string[]=[],ctx={ui:{notify:(m:string)=>notices.push(m)},sessionManager:{getBranch:()=>[],getEntries:()=>[]},hasUI:true} as any;
 const fire=async(name:string,event:any={})=>{for(const h of handlers.get(name)??[]){try{await h(event,ctx);}catch{/* other handlers need a fuller context */}}};
 const reply=(stopReason:string)=>fire('message_end',{message:{role:'assistant',stopReason,content:[]}});
 return {notices,fire,reply};
}
const NOTICE="pi-tuck: the last reply stopped at the model's output limit and may be cut off. Ask the agent to continue.";
test('a run that ends on a reply cut at the output limit gets one notice', async()=>{
 const f=await fixture();await f.fire('agent_start');await f.reply('length');await f.fire('agent_settled');await f.fire('agent_settled');
 expect(f.notices.filter(n=>n===NOTICE)).toHaveLength(1);
});
test('a later reply in the same run that ends normally clears it; a normal run says nothing', async()=>{
 const f=await fixture();
 await f.fire('agent_start');await f.reply('length');await f.fire('message_end',{message:{role:'toolResult',content:[]}});await f.reply('stop');await f.fire('agent_settled');
 await f.fire('agent_start');await f.reply('toolUse');await f.reply('stop');await f.fire('agent_settled');
 expect(f.notices.filter(n=>n===NOTICE)).toEqual([]);
});
test('with no UI (pi -p) the notice goes to stderr', async()=>{
 const handlers=new Map<string,((event:any,ctx:any)=>unknown)[]>();
 const pi={registerCommand:()=>{},registerTool:()=>{},on:(name:string,h:any)=>{handlers.set(name,[...(handlers.get(name)??[]),h]);return ()=>{};},getActiveTools:()=>[],getAllTools:()=>[]} as unknown as ExtensionAPI;
 await installCompaction(pi,{search:false});
 const ctx={ui:{notify:()=>{throw new Error('no UI');}},sessionManager:{getBranch:()=>[],getEntries:()=>[]},hasUI:false} as any;
 const fire=async(name:string,event:any={})=>{for(const h of handlers.get(name)??[]){try{await h(event,ctx);}catch{}}};
 const write=vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
 try{await fire('agent_start');await fire('message_end',{message:{role:'assistant',stopReason:'length',content:[]}});await fire('agent_settled');
  expect(write.mock.calls.filter(c=>String(c[0]).startsWith("pi-tuck: the last reply stopped"))).toHaveLength(1);}finally{write.mockRestore();}
});
