import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { historyImage, MAX_HISTORY_IMAGE_BYTES } from "../src/history-image.js";
import { historyAround } from "../src/history-image.js";
import { installCompaction } from "../src/compaction.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1sAAAAASUVORK5CYII=";
const image = (data = png) => ({ type: "image" as const, mimeType: "image/png", data });
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content,
	api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 1, stopReason: "toolUse",
	usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });
const metadata = (result: ReturnType<typeof historyImage>) => JSON.parse(result.content.find(b => b.type === "text")!.text);
const manager = () => SessionManager.inMemory(process.cwd());

test("image recall returns one exact native block with original role and selected locator", () => {
	const session = manager(), other = image("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC");
	const id = session.appendMessage({ role: "user", content: [{ type: "text", text: "Approved reference" }, image(), other], timestamp: 1 });
	const before = JSON.stringify(session.getBranch());
	const result = historyImage(session.getBranch(), { entryId: id, image: 1 });
	expect(result.content[1]).toEqual(other);
	expect(metadata(result)).toMatchObject({ status: "ok", role: "user", image: 1, imageCount: 2, read: { entryId: id, image: 1 } });
	expect(metadata(historyImage(session.getBranch(), { entryId: id, image: 2 })).status).toBe("no_image");
	expect(JSON.stringify(session.getBranch())).toBe(before);
});

test("source scope, ambiguity, private records and malformed delivery never expose bytes", () => {
	const session = manager(), id = session.appendMessage({ role: "user", content: [image()], timestamp: 1 });
	const foreign = manager().appendMessage({ role: "user", content: [image()], timestamp: 1 });
	expect(metadata(historyImage(session.getBranch(), { entryId: foreign, image: 0 })).status).toBe("not_found");
	expect(metadata(historyImage([...session.getBranch(), session.getEntry(id)!], { entryId: id, image: 0 })).status).toBe("ambiguous");
	const privateId = session.appendMessage({ role: "custom", customType: "host.policy", content: [image()], display: false, timestamp: 1 });
	expect(historyImage(session.getBranch(), { entryId: privateId, image: 0 }).content).toHaveLength(1);
	const corrupt = session.appendMessage({ role: "user", content: [image(Buffer.from("not an image").toString("base64"))], timestamp: 1 });
	expect(metadata(historyImage(session.getBranch(), { entryId: corrupt, image: 0 })).status).toBe("unsupported_image");
	const oversized = session.appendMessage({ role: "user", content: [image(Buffer.alloc(MAX_HISTORY_IMAGE_BYTES + 1).toString("base64"))], timestamp: 1 });
	expect(historyImage(session.getBranch(), { entryId: oversized, image: 0 }).content).toHaveLength(1);
	for (const value of [-1, 0.5, NaN, Infinity]) expect(() => historyImage(session.getBranch(), { entryId: id, image: value })).toThrow("Invalid");
	session.branch(id); session.appendMessage({ role: "user", content: "New branch", timestamp: 2 });
	expect(metadata(historyImage(session.getBranch(), { entryId: corrupt, image: 0 })).status).toBe("not_found");
});


test("around supplies image-only neighbors and distant unique producer receipts without echoes", () => {
 const session=manager();const producer=session.appendMessage(assistant([{type:"toolCall",id:"capture",name:"capture",arguments:{path:"reference.png"}}]));
 for(let i=0;i<5;i++)session.appendMessage({role:"user",content:"Neighbor "+i,timestamp:1});
 session.appendMessage({role:"toolResult",toolName:"tuck_recall",toolCallId:"echo",content:[image()],isError:false,timestamp:1});
 const original=session.appendMessage({role:"toolResult",toolName:"capture",toolCallId:"capture",content:[image()],isError:false,timestamp:1});
 const page=historyAround(session.getBranch(),{around:producer,before:0,after:1});
 expect(page.imageSources.map(e=>e.entryId)).toEqual([original]);expect(JSON.stringify(page)).not.toContain(png);
 const imageOnly=historyAround(session.getBranch(),{around:original,before:1,after:0});
 expect(imageOnly.entries.at(-1)).toMatchObject({entryId:original,role:"toolResult",imageCount:1,imageRead:{entryId:original,image:0}});
 session.appendMessage(assistant([{type:"toolCall",id:"capture",name:"capture",arguments:{}}]));
 expect(historyAround(session.getBranch(),{around:producer,before:0,after:0}).imageSources).toEqual([]);
 expect(historyAround([...session.getBranch(),session.getEntry(producer)!],{around:producer}).status).toBe("ambiguous");
});

test("registered image and around modes obey the existing optional host access policy",async()=>{
 const session=manager(),id=session.appendMessage({role:"user",content:[image()],timestamp:1});
 let execute:Parameters<ExtensionAPI["registerTool"]>[0]["execute"]|undefined,permitted=true,checks=0;
 await installCompaction({registerCommand:()=>{},registerTool:(tool:Parameters<ExtensionAPI["registerTool"]>[0])=>{if(tool.name==="tuck_recall")execute=tool.execute;},on:()=>()=>{}} as unknown as ExtensionAPI,
 {assertAccess:()=>{checks++;if(!permitted)throw Error("Read admission denied");}});
 const run=(input:unknown)=>execute!("read",input as never,undefined,()=>{},{sessionManager:session} as unknown as Parameters<NonNullable<typeof execute>>[4]);
 expect((await run({entryId:id,image:0})).content[1]).toEqual(image());
 const around=await run({around:id});const first=around.content[0];expect(first?.type==='text'&&JSON.parse(first.text).status).toBe("ok");
 permitted=false;await expect(run({entryId:id,image:0})).rejects.toThrow("Read admission denied");expect(checks).toBeGreaterThanOrEqual(3);
});
