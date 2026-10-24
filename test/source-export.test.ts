import { expect, test } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { exportSource } from "../src/source-export";
import { installCompaction } from "../src/compaction";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
const make = () => {
 const manager = SessionManager.inMemory("/test");
 const id = manager.appendMessage({role:"toolResult",toolName:"capture_scan",toolCallId:"scan",content:[{type:"text",text:'a,"b"\r\n😀 end\n'},{type:"image",data:"PRIVATE_PIXEL",mimeType:"image/png"}],isError:false,timestamp:0});
 return {manager,id, entries:manager.getEntries(), branch:manager.getBranch()};
};
test("exact full readable source and global index preserve recorded text; pixels are not invented text", () => {
 const x=make(), before=JSON.stringify(x.entries), a=exportSource(x.entries,x.branch,{entryId:x.id}), b=exportSource(x.entries,x.branch,{index:0});
 expect(a).toEqual(b);expect(a?.text).toBe('a,"b"\r\n😀 end\n');expect(a?.role).toBe("toolResult");expect(JSON.stringify(x.entries)).toBe(before);
});
test("null, private, off-branch, duplicate and saved-view sources cannot export", () => {
 const x=make();expect(exportSource(x.entries,[],{entryId:x.id})).toBeUndefined();
 expect(exportSource([...x.entries,x.entries[0]!],x.branch,{entryId:x.id})).toBeUndefined();
 expect(exportSource(x.entries,[...x.branch,x.branch[0]!],{entryId:x.id})).toBeUndefined();
 x.manager.appendContextEdit(x.id,null);expect(exportSource(x.manager.getEntries(),x.manager.getBranch(),{entryId:x.id})).toBeUndefined();
 const secret=x.manager.appendCustomMessageEntry("secret","DO_NOT_EXPORT",true);expect(exportSource(x.manager.getEntries(),x.manager.getBranch(),{entryId:secret},{privateCustomTypes:["secret"]})).toBeUndefined();
 const cut=x.manager.appendCompaction("DERIVED_VIEW",x.id,100,{},true);expect(exportSource(x.manager.getEntries(),x.manager.getBranch(),{entryId:cut})).toBeUndefined();
 const replacement={id:"edit",type:"context_edit",targetId:x.id,replacement:"unsupported",parentId:x.id,timestamp:new Date().toISOString()} as unknown as SessionEntry;
 expect(()=>exportSource(x.entries,[...x.branch,replacement],{entryId:x.id})).toThrow("replacement context edits");
});
test("empty or image-only sources have no text; assistant hidden reasoning is never exported", () => {
 const m=SessionManager.inMemory("/test");const id=m.appendMessage({role:"user",content:[{type:"image",data:"PIXEL",mimeType:"image/png"}],timestamp:0});expect(exportSource(m.getEntries(),m.getBranch(),{entryId:id})).toBeUndefined();
 const a=m.appendMessage({role:"assistant",content:[{type:"thinking",thinking:"SECRET_REASONING"},{type:"text",text:"Public prose"}],api:"openai-codex-responses",provider:"openai-codex",model:"gpt-6.1-sol",timestamp:0,stopReason:"stop",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});expect(exportSource(m.getEntries(),m.getBranch(),{entryId:a})?.text).toBe("Public prose");
});
test("actual registered tool rejects mixed export schemas/access/cancellation before native write", async () => {
 let tool:ToolDefinition|undefined, denied=false, writes=0;
 const pi={on:()=>{},getSettings:()=>({}),registerCommand:()=>{},registerTool:(t:ToolDefinition)=>{if(t.name==="pi_tuck_recall")tool=t}} as unknown as ExtensionAPI;
 await installCompaction(pi,{assertAccess:()=>{if(denied)throw Error("Access denied")}});
 const x=make(), signal=new AbortController(), ctx={sessionManager:x.manager,executeTool:async()=>{writes++;return{isError:false,content:[]}}} as unknown as ExtensionToolContext;
 const run=(input:unknown)=>tool!.execute("call",input,signal.signal,undefined,ctx);
 for(const input of [{entryId:x.id,outputPath:"out",limit:5},{index:0,entryId:x.id,outputPath:"out"},{query:"a",outputPath:"out"},{entryId:x.id,outputPath:""}])await expect(run(input)).rejects.toThrow("Invalid recall input");
 denied=true;await expect(run({entryId:x.id,outputPath:"out"})).rejects.toThrow("Access denied");denied=false;signal.abort();await expect(run({entryId:x.id,outputPath:"out"})).rejects.toThrow("cancelled");expect(writes).toBe(0);
});
