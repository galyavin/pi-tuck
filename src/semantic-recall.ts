import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,rm,mkdtemp,mkdir} from 'node:fs/promises';
import {lstatSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,relative,join,dirname,basename,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {ExtensionContext,SessionEntry} from '@earendil-works/pi-coding-agent';
import {createRecall,type RecallPolicy,type ReadableEntry} from './recall';
import {buildGlobalIndexById} from './pi-tuck/core/global-indices';
// Session-owned mutable scratch is outside verified software and caller projects.
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const abort=()=>Object.assign(new Error('Semantic recall cancelled'),{name:'AbortError'});
const yieldWork=()=>new Promise<void>(done=>setTimeout(done,5));
// Resolve existing ancestors without creating an index or accepting a dangling link.
function physicalPath(path:string):string {
 const parts:string[]=[];let parent=resolve(path);
 for(;;){try{return join(realpathSync(parent),...parts);}catch(error){
  if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  try{lstatSync(parent);throw error;}catch(statError){if(statError===error||(statError as NodeJS.ErrnoException).code!=='ENOENT')throw statError;}
  const next=dirname(parent);if(next===parent)throw error;parts.unshift(basename(parent));parent=next;
 }}
}
function outsideProject(project:string,path:string,kind:'configuration'|'index'|'runtime'|'scratch'){
 const inside=(base:string,target:string)=>{const rel=relative(base,target);return rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);};
 if(inside(resolve(project),resolve(path))||inside(physicalPath(project),physicalPath(path)))throw new Error('Semantic '+kind+' must be outside project');
}
function outsideRuntime(runtime:string,path:string,kind:'index'|'scratch'){
 const inside=(base:string,target:string)=>{const rel=relative(base,target);return rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);};
 if(inside(resolve(runtime),resolve(path))||inside(physicalPath(runtime),physicalPath(path)))throw new Error('Semantic '+kind+' must be outside immutable runtime');
}
function scratchParent(config:SemanticRecallConfig){return config.scratchDirectory??dirname(config.indexDirectory);}
/** Windows ownership is an explicit current-runtime dependency, never Task data.
 * --run uses a fresh UUIDv4 and stdinMode:"stream" for persistent RPC. Launch
 * lines (including LF) are <=2 MiB; decoded input/control is <=1 MiB, at most
 * two RPCs in flight. Raw stdout is data; only strict native stderr envelopes
 * and final {op:"settled",activeProcesses:0,exitCode:uint32|null} are authority.
 * Crash/invalid framing invokes this same helper's private --join-job {jobId}.
 * Named absence, leader exit and deadlines are UNKNOWN: custody stays pending.
 */
export interface SemanticRecallConfig {pythonPath:string;runtimeRoot:string;indexDirectory:string;scratchDirectory?:string;queryWaitMs?:number;prepareWorkMs?:number;maxUnits?:number;maxSourceCharacters?:number;workerPath?:string;nativeOwnerHelperPath?:string;}
export type NativeOwnerInputControl={op:'input';input:string}|{op:'cancel'};
interface NativeOwnerLaunch {executable:string;args:string[];cwd:string;env:Record<string,string>;jobId:string;stdinMode:'stream';input?:string;}
export interface PriorResult {entryId:string;start:number;end:number;sourceSha:string;}
interface Source {entry:SessionEntry;row:ReadableEntry;sourceText:string;ranges:{start:number;end:number}[];order:number;sha:string;}
interface InputSpan {source:Source;start:number;end:number;}
interface Unit {key:string;entryId:string;start:number;end:number;inputSha:string;encoded:string;source:Source;}
/** What one snapshot indexes: the sources in window order, with their unit counts, and the character totals the coverage statement reports.
 * Window order is kind first, then recency: out-of-view conversation (newest first), then out-of-view tool output (newest first), then what is still in view (newest first).
 * `searchUnits` is how many leading units are out-of-view conversation: a search waits for those, never for the out-of-view tool output or the in-view tail behind them. */
interface Window {order:Source[];counts:number[];searchUnits:number;windowCharacters:number;eligibleCharacters:number;conversationOutOfView:number;toolOutOfView:number;}
/** `viewStart` is the branch position of the latest compaction's first kept entry: sources before it are out of view (compacted away). `indexed` holds the keys of units whose vectors are stored. */
interface Snapshot {id:string;session:string;project:string;sources:Source[];units:Unit[];complete:boolean;throughEntryId:string|null;viewStart:number;indexed:Set<string>;window?:Window;}
const sourceCharacters=(source:Source)=>source.ranges.reduce((n,r)=>n+r.end-r.start,0);
const expandedGroups = Symbol('expanded semantic groups');
export interface SemanticEvidenceReference extends PriorResult {basis:'explicit prior or word result'|'earlier source text in this response';}
export interface SemanticSourceEvidence extends ReadableEntry {sourceOrder?:number;sourceSha:string;textOffset:number;totalCharacters:number;read:{entryId:string;offset:number;limit:number};complete:boolean;evidenceReference?:SemanticEvidenceReference;notice?:string;}
export interface SemanticGroup {sources:SemanticSourceEvidence[];notice:string;}
export interface SemanticPage {status:string;notice:string;coverage:ReturnType<SemanticRecallController["status"]>;groups:SemanticGroup[];method?:string;}
interface NativeReceipt {op:'settled';activeProcesses:0;exitCode:number|null;}
const nativeBase64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
function nativeObject(text:string):Record<string,unknown>{
 const value=JSON.parse(text) as Record<string,unknown>,tokens=text.match(/"(?:\\.|[^"\\])*"|[{}:\[\],]/g)??[],objects:Set<string>[]=[];
 for(let i=0;i<tokens.length;i++){const token=tokens[i];if(token==='{')objects.push(new Set());else if(token==='}')objects.pop();else if(token?.startsWith('"')&&tokens[i+1]===':'){const key=JSON.parse(token) as string,keys=objects.at(-1)!;if(keys.has(key))throw new Error('Duplicate native frame key');keys.add(key);}}
 return value;
}
function nativeSafeError(frame:Record<string,unknown>):boolean{
 if(Object.keys(frame).sort().join(',')!=='error,ok,version'||frame.version!==1||frame.ok!==false||!frame.error||typeof frame.error!=='object'||Array.isArray(frame.error))return false;
 const error=frame.error as Record<string,unknown>;return Object.keys(error).sort().join(',')==='code,message'&&['INVALID_REQUEST','RUN_START','RUN_SETTLEMENT'].includes(error.code as string)&&typeof error.message==='string'&&error.message.length>0&&error.message.length<=1024;
}
function observeNativeFrames(stream:NodeJS.ReadableStream,stderr:(data:Buffer)=>void,invalid:()=>void,diagnostic:()=>void=invalid):()=>NativeReceipt|undefined{
 let pending=Buffer.alloc(0),receipt:NativeReceipt|undefined,broken=false;
 const bad=()=>{if(!broken){broken=true;receipt=undefined;pending=Buffer.alloc(0);invalid();}};
 stream.on('data',(chunk:Buffer)=>{if(broken)return;let start=0;while(start<chunk.length){const lf=chunk.indexOf(10,start),end=lf<0?chunk.length:lf;if(pending.length+end-start>65536){bad();return;}pending=Buffer.concat([pending,chunk.subarray(start,end)]);if(lf<0)break;
  try{const text=pending.toString('utf8');if(!Buffer.from(text).equals(pending)||text.includes('\r'))throw new Error();const frame=nativeObject(text);if(!frame||typeof frame!=='object'||Array.isArray(frame))throw new Error();const keys=Object.keys(frame).sort().join(',');
   // A strict diagnostic can accompany an operation failure before or after
   // its one zero receipt. It cannot erase observed cleanup or become success.
   if(nativeSafeError(frame))diagnostic();
   else if(receipt)throw new Error('Native output followed settlement');
   else if(keys==='data,op'&&frame.op==='stderr'&&typeof frame.data==='string'&&nativeBase64.test(frame.data)){const data=Buffer.from(frame.data,'base64');if(data.length>32768||data.toString('base64')!==frame.data)throw new Error();stderr(data);}
   else if(keys==='activeProcesses,exitCode,op'&&frame.op==='settled'&&frame.activeProcesses===0&&(frame.exitCode===null||typeof frame.exitCode==='number'&&Number.isSafeInteger(frame.exitCode)&&frame.exitCode>=0&&frame.exitCode<=4294967295))receipt=frame as unknown as NativeReceipt;
   else throw new Error();
  }catch{bad();return;}pending=Buffer.alloc(0);start=end+1;
 }});stream.on('error',bad);return()=>{if(pending.length)bad();return broken?undefined:receipt;};
}
async function joinExactNativeJob(helper:string,jobId:string):Promise<void>{
 for(;;){const empty=await new Promise<boolean>(done=>{
  const child=spawn(helper,['--join-job'],{stdio:'pipe',windowsHide:true,env:{SYSTEMROOT:process.env.SYSTEMROOT??''}});let invalid=false;
  const bad=()=>{invalid=true;child.kill();},timer=setTimeout(bad,5000);
  const receipt=observeNativeFrames(child.stderr,()=>bad(),bad,()=>{});
  child.stdout.on('data',bad);child.stdout.on('error',bad);child.stdin.on('error',bad);child.once('error',()=>{invalid=true;});
  child.once('close',(code,signal)=>{clearTimeout(timer);done(!invalid&&code===0&&!signal&&!!receipt());});child.stdin.end(JSON.stringify({jobId})+'\n');
 }).catch(()=>false);if(empty)return;await new Promise(done=>setTimeout(done,250));}
}
/** A refusal, death or timeout of the worker (not a caller's cancel or a bound). `code` is the worker's reason code when it sent one. */
class WorkerFailure extends Error {constructor(message:string,readonly code:string|null=null){super(message);this.name='SemanticWorkerFailure';}}
/** Reasons the worker gives for a native encoder that failed to start or answer: time can mend these. Every other worker code is a verification refusal (membership, integrity, origin, pins, profile) that needs repair. */
const TRANSIENT_CODES=new Set(['native_start_failure','native_start_timeout','native_request_failure','native_response_bound','native_transport_unavailable','local_runtime_failure']);
const integrityRefusal=(error:WorkerFailure)=>error.code!==null&&!TRANSIENT_CODES.has(error.code);
/** Automatic recovery after a failed start or a lost worker: bounded exponential backoff, then a steady slow cadence. Integrity refusals use the slow cadence only. */
export const HEAL_DELAYS_MS:readonly number[]=[5000,30000,120000];
export const HEAL_STEADY_MS=600000;
/** A session that has not searched for this long gives its worker back (the index stays on disk). Enabling starts nothing; a search starts the worker again. */
export const IDLE_STOP_MS=600000;
/** The most units one index window holds. The worker's SQLite store stops at 8,008 rows (`PRAGMA max_page_count=8192` in scripts/semantic-worker.py), so a cap below that keeps a window of short units from filling the store and sticking in `unavailable`. Raise it only together with the store. */
export const MAX_INDEX_UNITS=8000;
/** Keys per worker `score` request: a multiple of the worker's 128-key sub-batches, aligned from the start of the covered prefix. A key is a SHA-256 hex digest (64 characters, see `hash`), so 1024 keys and the 768-float query make a request of about 90 KiB, far under both the 512 KiB design bound and the worker's 1 MiB line limit. */
const SCORE_CHUNK=1024;
/** The wait before the next automatic attempt, given how many were already armed since the last success. */
export function healDelayMs(attempts:number,integrity:boolean,delays:readonly number[]=HEAL_DELAYS_MS,steady=HEAL_STEADY_MS):number{return integrity?steady:delays[attempts]??steady;}
/** Errors that mean "the history moved or a slice ended; try again", not that the runtime failed. They do not make the state `unavailable`. */
const CHURN=/indexing incomplete|history changed|source changed before|branch or source changed|cancelled/i;
export type SemanticState='disabled'|'unavailable'|'preparing'|'ready'|'waiting';
const PROBE_TEXT='AB1 semantic recall status probe';
class LocalWorker {
 private nativeHelper=false;private jobId?:string;private helperReceipt?:()=>NativeReceipt|undefined;private nativeExit?:{code:number|null;signal:NodeJS.Signals|null};
 // Serialize native RPC delivery by child reply, not host pipe acceptance.
 // This leaves room for the previous native write to finish plus one queued
 // control, even when the child replies before that writer goroutine retires.
 private nativeInputs:{id:number;control:string}[]=[];private nativeInputId?:number;
 private child?:ChildProcessWithoutNullStreams;private scratch?:string;private starting?:Promise<void>;private exited?:Promise<void>;private buffer='';private next=0;private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();private stopped=false;private lost=false;private closing?:Promise<void>;
 constructor(private config:SemanticRecallConfig, private project:string, private cleanupFailure:(error:unknown)=>void, private onLoss:(reason:string)=>void=()=>{}){}
 private closeInBackground(){void this.close().catch(error=>this.cleanupFailure(error));}
 // The worker stopped without the controller asking: report it once, then join it like any other background close.
 private lose(reason:string){if(!this.stopped&&!this.lost){this.lost=true;this.onLoss(reason);}this.closeInBackground();}
 private async start(){
  if(this.child)return;if(this.starting)return this.starting;
  this.starting=(async()=>{
   this.nativeHelper=process.platform==='win32';
   if(this.nativeHelper){if(!this.config.nativeOwnerHelperPath)throw new Error('Windows semantic recall requires an explicit verified nativeOwnerHelperPath with streaming input and Job settlement');outsideProject(this.project,this.config.nativeOwnerHelperPath,'runtime');}
   outsideProject(this.project,this.config.runtimeRoot,'runtime');
   const scratchRoot=scratchParent(this.config);outsideProject(this.project,scratchRoot,'scratch');outsideRuntime(this.config.runtimeRoot,scratchRoot,'scratch');await mkdir(scratchRoot,{recursive:true,mode:0o700});outsideProject(this.project,scratchRoot,'scratch');outsideRuntime(this.config.runtimeRoot,scratchRoot,'scratch');this.scratch=await mkdtemp(join(scratchRoot,'.pi-semantic-'));outsideProject(this.project,this.scratch,'scratch');outsideRuntime(this.config.runtimeRoot,this.scratch,'scratch');
   if(this.stopped)throw new Error('Local worker closed');
   const worker=this.config.workerPath??fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../scripts/semantic-worker.py':'../../scripts/semantic-worker.py',import.meta.url));
   const osNames=this.nativeHelper?['SYSTEMROOT','WINDIR','LANG','LC_ALL']:['SystemRoot','SYSTEMROOT','WINDIR','LANG','LC_ALL'];
   const osEnvironment=Object.fromEntries(osNames.flatMap(name=>typeof process.env[name]==='string'?[[name,process.env[name]!]]:[]));
   const args=['-I','-B','-u',worker],env={...osEnvironment,TMPDIR:this.scratch,TMP:this.scratch,TEMP:this.scratch,PI_SEMANTIC_RUNTIME_ROOT:this.config.runtimeRoot};
   this.jobId=randomUUID();const launch:NativeOwnerLaunch={executable:this.config.pythonPath,args,cwd:this.scratch,env,jobId:this.jobId,stdinMode:'stream'};
   const launchLine=JSON.stringify(launch)+'\n';if(this.nativeHelper&&Buffer.byteLength(launchLine)>2*1048576)throw new Error('Native owner launch bound');
   const child=spawn(this.nativeHelper?this.config.nativeOwnerHelperPath!:this.config.pythonPath,this.nativeHelper?['--run']:args,{cwd:this.scratch,env:this.nativeHelper?osEnvironment:env,stdio:'pipe',detached:!this.nativeHelper});
   this.child=child;this.exited=new Promise<void>(done=>child.once('close',(code,signal)=>{this.nativeExit={code,signal};this.rejectAll(new WorkerFailure('Local worker stopped'));done();this.lose('Local worker stopped');}));
   child.stdout.on('data',data=>{this.buffer+=data.toString();if(this.buffer.length>16*1024*1024){this.lose('Local worker output bound');return;}let end;while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);try{const reply=JSON.parse(line),pending=this.pending.get(reply.id);if(pending){clearTimeout(pending.timer);this.pending.delete(reply.id);reply.ok?pending.resolve(reply.result):pending.reject(new WorkerFailure('Local semantic runtime: '+reply.error?.code,reply.error?.code??null));if(this.nativeHelper&&this.nativeInputId===reply.id){this.nativeInputId=undefined;this.pumpNativeInput();}}}catch{this.lose('Local worker framing');}}});
   child.stdout.on('error',()=>this.lose('Local worker output'));
   if(this.nativeHelper)this.helperReceipt=observeNativeFrames(child.stderr,()=>{},()=>this.closeInBackground());
   else child.stderr.resume();
   child.stdin.on('error',()=>this.lose('Local worker input'));child.on('error',()=>{this.rejectAll(new WorkerFailure('Local runtime unavailable'));this.lose('Local runtime unavailable');});
   if(this.nativeHelper)child.stdin.write(launchLine);
  })();
  try{await this.starting;}catch(error){await this.close();throw error;}
 }
 async call(op:string,input:object={},signal?:AbortSignal):Promise<any>{
  if(signal?.aborted)throw abort();if(this.stopped)throw new WorkerFailure('Local worker closed');
  await this.start();if(this.stopped||signal?.aborted)throw this.lost&&!signal?.aborted?new WorkerFailure('Local worker stopped'):abort();if(this.pending.size>=2)throw new Error('Local semantic concurrency bound');
  const id=++this.next,body=JSON.stringify({id,op,...input})+'\n';if(Buffer.byteLength(body)>1048576)throw new Error('Local worker input bound');
  return new Promise((resolveReply,reject)=>{const onAbort=()=>{this.closeInBackground();reject(abort());};signal?.addEventListener('abort',onAbort,{once:true});const finish=(callback:(value:any)=>void,value:any)=>{signal?.removeEventListener('abort',onAbort);callback(value);};const timer=setTimeout(()=>{this.lose('Local runtime deadline');finish(reject,new WorkerFailure('Local runtime deadline'));},60000);this.pending.set(id,{resolve:value=>finish(resolveReply,value),reject:error=>finish(reject,error),timer});if(this.nativeHelper){const control:NativeOwnerInputControl={op:'input',input:Buffer.from(body).toString('base64')};this.nativeInputs.push({id,control:JSON.stringify(control)+'\n'});this.pumpNativeInput();}else this.child!.stdin.write(body);});
 }
 private pumpNativeInput(){if(this.stopped||this.nativeInputId!==undefined)return;const next=this.nativeInputs.shift();if(next){this.nativeInputId=next.id;this.child!.stdin.write(next.control);}}
 private rejectAll(error:Error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.nativeInputs=[];this.nativeInputId=undefined;}
 async close(){if(this.closing)return this.closing;this.stopped=true;const closing=this.stopNative();this.closing=closing;try{await closing;}finally{if(this.closing===closing)this.closing=undefined;}}
 private async stopNative(){await this.starting?.catch(()=>{});this.rejectAll(new WorkerFailure('Local worker closed'));const child=this.child;if(child){
  if(this.nativeHelper){
   // Never taskkill or kill the helper leader as a substitute for Job absence.
   if(!this.nativeExit){const cancel:NativeOwnerInputControl={op:'cancel'};child.stdin.end(JSON.stringify(cancel)+'\n');}
   // Deadline can force kill-on-close, never claim settlement. Failed starts,
   // crashes and invalid frames still require exact named observation. Native
   // named absence cannot supply a receipt; retries retain scratch/index custody.
   const timer=setTimeout(()=>child.kill(),5000);
   try{await this.exited;}finally{clearTimeout(timer);}
   if(child.pid!==undefined&&(!this.helperReceipt?.()||this.nativeExit?.signal||typeof this.nativeExit?.code!=='number'))await joinExactNativeJob(this.config.nativeOwnerHelperPath!,this.jobId!);
   this.child=undefined;
  }else{
  // The worker and its native encoder share one owned process group. HTTP abort is not cancellation.
  // macOS answers EPERM for a group whose remaining member has exited but is not yet reaped (T22): the group is still present, so keep polling to the bound below; only a group still present after it fails the close.
  const signal=(value:NodeJS.Signals)=>{try{if(child.pid)process.kill(-child.pid,value);}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code!=='ESRCH'&&code!=='EPERM')throw error;}};
  const alive=()=>{if(!child.pid)return false;try{process.kill(-child.pid,0);return true;}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='ESRCH')return false;if(code==='EPERM')return true;throw error;}};
  const timer=setTimeout(()=>signal('SIGKILL'),1000);signal('SIGTERM');try{await this.exited;if(alive())signal('SIGKILL');const until=Date.now()+1000;while(alive()&&Date.now()<until)await new Promise(done=>setTimeout(done,10));if(alive())throw new Error('Owned native encoder group did not close');this.child=undefined;}finally{clearTimeout(timer);}
 }}if(this.scratch){await rm(this.scratch,{recursive:true,force:true});this.scratch=undefined;}}
}
/** Where the current view starts, as a branch position: the latest compaction entry's first kept entry. Earlier entries were compacted away. With no compaction, nothing is out of view. */
export function viewStart(branch:SessionEntry[]):number{
 const at=branch.findLastIndex(entry=>entry.type==='compaction');if(at<0)return 0;
 const entry=branch[at]!,kept=entry.type==='compaction'?branch.findIndex(candidate=>candidate.id===entry.firstKeptEntryId):-1;
 return kept>=0&&kept<=at?kept:at;
}
const TOOL_OUTPUT=new Set(['toolResult','bashExecution']);
const isToolOutput=(source:Source)=>TOOL_OUTPUT.has(source.row.role);
/** Sources in the order they are covered: out-of-view conversation (user messages, assistant text, tool-call names and arguments), then out-of-view tool output, then what is in view.
 * Each part is newest first, extending backward. */
function windowOrder(snapshot:Snapshot):Source[]{
 const before=snapshot.sources.filter(source=>source.order<snapshot.viewStart),kept=snapshot.sources.filter(source=>source.order>=snapshot.viewStart);
 return[...before.filter(source=>!isToolOutput(source)).reverse(),...before.filter(isToolOutput).reverse(),...kept.reverse()];
}
/** How many leading units of the window are indexed. Indexing runs in window order, so this is what the coverage statement covers and the only part a search ranks. */
function indexedPrefix(snapshot:Snapshot){let prefix=0;while(prefix<snapshot.units.length&&snapshot.indexed.has(snapshot.units[prefix]!.key))prefix++;return prefix;}
/** The coverage statement of a snapshot for its first `prefix` units (the indexed prefix unless the caller froze another): back to the oldest source named. */
function windowCoverage(snapshot:Snapshot,prefix=indexedPrefix(snapshot)){
 const window=snapshot.window;if(!window)return null;
 const time=(source?:Source)=>{const at=source?.row.sourceTime;return at&&at.basis!=='unknown'?at.utc:null;};
 let indexedCharacters=0,conversation=0,tools=0,units=0,oldest:Source|undefined,oldestTool:Source|undefined;
 for(const [index,source] of window.order.entries()){
  units+=window.counts[index]!;if(units>prefix)break;
  const size=sourceCharacters(source);indexedCharacters+=size;if(!oldest||source.order<oldest.order)oldest=source;
  if(source.order<snapshot.viewStart){if(isToolOutput(source)){tools+=size;if(!oldestTool||source.order<oldestTool.order)oldestTool=source;}else conversation+=size;}
 }
 return{indexedCharacters,windowCharacters:window.windowCharacters,outOfViewCharacters:window.conversationOutOfView+window.toolOutOfView,eligibleCharacters:window.eligibleCharacters,oldestCoveredEntryId:oldest?.entry.id??null,oldestCoveredTime:time(oldest),
  conversation:{indexedCharacters:conversation,outOfViewCharacters:window.conversationOutOfView},toolResults:{indexedCharacters:tools,outOfViewCharacters:window.toolOutOfView,oldestCoveredTime:time(oldestTool)}};
}
export function semanticEligibleSources(ctx:Pick<ExtensionContext,'sessionManager'|'cwd'>,policy:RecallPolicy,access:()=>void):Snapshot {
 try{access();}catch(error){throw Object.assign(new Error(error instanceof Error?error.message:'Source access denied'),{name:'SemanticAccessError'});}const branch=ctx.sessionManager.getBranch(),all=ctx.sessionManager.getEntries();
 if(branch.some(e=>e.type==='context_edit'&&e.replacement!==null))throw new Error('Unsupported replacement context edit');
 const omitted=new Set(branch.flatMap(e=>e.type==='context_edit'?[e.targetId]:[]));
 const projection=ctx.sessionManager.buildSessionProjection();for(const p of projection.entries)if(!p.messages.length&&p.sourceEntry.type!=='compaction')omitted.add(p.sourceEntry.id);
 const ids=new Map<string,number>();for(const e of all)ids.set(e.id,(ids.get(e.id)??0)+1);
 const eligible=branch.filter(e=>!omitted.has(e.id)&&ids.get(e.id)===1),recall=createRecall(policy),attempts=recall.recallAttempts(eligible),links=recall.producerReads(eligible),indices=buildGlobalIndexById(all);
 const orders=new Map(branch.map((entry,order)=>[entry.id,order]));
 const sources=eligible.flatMap(entry=>{const order=orders.get(entry.id)!;const row=recall.discoveryEntry(entry,attempts,links);if(!row)return[];const {sourceText:unusedText,ranges:unusedRanges,...readable}=row;return[{entry,row:readable,sourceText:row.sourceText,ranges:row.ranges,order,sha:hash({entry,order,row:readable,ranges:row.ranges,index:indices.get(entry.id)})}];});
 const session=ctx.sessionManager.getSessionId(),id=hash({session,project:resolve(ctx.cwd),branch:branch.map(e=>[e.id,e.parentId]),sources:sources.map(s=>[s.entry.id,s.sha])});return{id,session,project:ctx.cwd,sources,units:[],complete:false,throughEntryId:sources.at(-1)?.entry.id??null,viewStart:viewStart(branch),indexed:new Set()};
}
export class SemanticRecallController {
 private readonly ownerId=randomUUID();private readonly indexFiles=new Set<string>();private closing?:Promise<void>;private joiningSearches=0;private activeSearches=new Set<Promise<SemanticPage>>();private config?:SemanticRecallConfig;private worker?:LocalWorker;private identity='';private provider?:()=>Snapshot;private generation=0;private cleanupError:string|null=null;private dirty=false;private operations={preparationEmbeddings:0,queryEmbeddings:0};
 // The fields below decide `status().state`; their setters announce a change to `onStateChange` listeners.
 private _enabled=false;private _current?:Snapshot;private _task?:Promise<void>;private _timer?:ReturnType<typeof setTimeout>;private _error:string|null=null;
 private get enabled(){return this._enabled;}private set enabled(value:boolean){this._enabled=value;this.touch();}
 private get current(){return this._current;}private set current(value:Snapshot|undefined){this._current=value;this.touch();}
 private get task(){return this._task;}private set task(value:Promise<void>|undefined){this._task=value;this.touch();}
 private get timer(){return this._timer;}private set timer(value:ReturnType<typeof setTimeout>|undefined){this._timer=value;this.touch();}
 private get error(){return this._error;}private set error(value:string|null){this._error=value;this.touch();}
 // Automatic recovery: why the last start failed or the worker was lost (null while healthy), the attempts armed since the last success, and the pending retry.
 // Tokenized units by source sha, kept across attempts: an attempt that a history change aborts loses nothing it finished, and the next one tokenizes only the rest.
 // Pruned to the eligible sources when an attempt starts and to the window when one publishes.
 private tokenized=new Map<string,Unit[]>();
 private healReason:string|null=null;private healIntegrity=false;private healAttempts=0;private healTimer?:ReturnType<typeof setTimeout>;private healRetryAt:number|null=null;private recycle=false;
 // Lazy start: background work runs only for a session that searched within the idle limit, or that searched at some point and has just been cut (T21, `indexAtCut`).
 private active=false;private fullIndexing=false;private idleTimer?:ReturnType<typeof setTimeout>;private idling?:Promise<void>;private quietStop=false;
 // Whether this session ran a search since the controller was created or last closed; it survives idle stops, so a cut after a long quiet spell still indexes (T21).
 private searched=false;
 private readonly listeners=new Set<(state:SemanticState,reason:string|null)=>void>();private announced='disabled\0';private announcing=false;
 constructor(config?:SemanticRecallConfig,private readonly timing:{healDelaysMs?:readonly number[];healSteadyMs?:number;idleStopMs?:number}={}){if(config)this.configure(config);}
 /** Be told when `status().state` or `lastError` changes: once per change, after the synchronous work that caused it. Returns the unsubscribe. A listener that throws is ignored. */
 onStateChange(listener:(state:SemanticState,reason:string|null)=>void):()=>void{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
 private touch(){if(this.announcing)return;this.announcing=true;queueMicrotask(()=>{this.announcing=false;const {state,lastError}=this.status(),key=state+'\0'+(lastError??'');if(key===this.announced)return;this.announced=key;for(const listener of [...this.listeners])try{listener(state,lastError);}catch{}});}
 /** A host that could not configure the runtime records why a requested start failed. The controller stays disabled and `lastError` carries the reason until the next `enable`. */
 refuse(reason:string){this.error=reason;}
 configure(config:SemanticRecallConfig){if(this.enabled||this.worker||this.task)throw new Error('Disable before changing semantic configuration');for(const [key,max] of [['queryWaitMs',120000],['prepareWorkMs',120000],['maxUnits',MAX_INDEX_UNITS],['maxSourceCharacters',2000000]] as const){const value=config[key];if(value!==undefined&&(!Number.isSafeInteger(value)||value<1||value>max))throw new Error('Invalid bounded semantic configuration: '+key);}if('rerank' in config)throw new Error('Obsolete rerank configuration: this release supports embeddings only');for(const key of ['pythonPath','runtimeRoot','indexDirectory'] as const)if(typeof config[key]!=='string'||!config[key])throw new Error('Invalid semantic runtime configuration');if(config.scratchDirectory!==undefined&&(typeof config.scratchDirectory!=='string'||!config.scratchDirectory||!isAbsolute(config.scratchDirectory)))throw new Error('Invalid semantic scratchDirectory; absolute directory required');if(config.nativeOwnerHelperPath!==undefined&&(typeof config.nativeOwnerHelperPath!=='string'||!config.nativeOwnerHelperPath||!isAbsolute(config.nativeOwnerHelperPath)))throw new Error('Invalid semantic nativeOwnerHelperPath; absolute verified helper required');const normalized={...config,pythonPath:resolve(config.pythonPath),runtimeRoot:resolve(config.runtimeRoot),indexDirectory:resolve(config.indexDirectory),...(config.scratchDirectory===undefined?{}:{scratchDirectory:resolve(config.scratchDirectory)})};outsideRuntime(normalized.runtimeRoot,normalized.indexDirectory,'index');outsideRuntime(normalized.runtimeRoot,scratchParent(normalized),'scratch');this.config=normalized;}
 /** Ordinary external settings remain caller-selected/outside-project. The
  * optional override is a current-process verified dependency, not Task data. */
 async configureExternal(project:string,selectedPath=process.env.PI_SEMANTIC_RECALL_CONFIG??join(homedir(),'.config/pi/semantic-recall.json'),runtime?:{nativeOwnerHelperPath?:string}){const path=resolve(selectedPath);outsideProject(project,path,'configuration');if(runtime?.nativeOwnerHelperPath!==undefined)outsideProject(project,runtime.nativeOwnerHelperPath,'runtime');this.configure({...JSON.parse(await readFile(path,'utf8')) as SemanticRecallConfig,...(runtime?.nativeOwnerHelperPath===undefined?{}:{nativeOwnerHelperPath:runtime.nativeOwnerHelperPath})});}
 enable(){if(this.closing||this.joiningSearches||this.cleanupError)throw new Error('Semantic cleanup is unresolved; retry close before enable');if(!this.config)throw new Error('Optional local semantic runtime is not configured');this.enabled=true;this.error=null;this.healReason=null;this.healAttempts=0;this.cancelHeal();if(this.provider&&this.active)this.schedule(this.provider);}
 status(){return{enabled:this.enabled,configured:Boolean(this.config),cleanupError:this.cleanupError,state:(!this.enabled?'disabled':this.healReason!==null||(this.error!==null&&!CHURN.test(this.error))?'unavailable':this.task||this.timer?'preparing':this.current?.complete?'ready':'waiting') as SemanticState,snapshotId:this.current?.id??null,throughEntryId:this.current?.throughEntryId??null,eligibleSources:this.current?.sources.length??0,totalUnits:this.current?.units.length??0,coveredUnits:this.current?.indexed.size??0,indexingComplete:Boolean(this.current?.complete),lastError:this.error??this.healReason,window:this.current?windowCoverage(this.current):null,recovery:this.healReason===null?null:{attempts:this.healAttempts,integrity:this.healIntegrity,retryAt:this.healRetryAt===null?null:new Date(this.healRetryAt).toISOString()},operations:{...this.operations},limits:{keyword:16000,broad:20000}};}
 schedule(provider:()=>Snapshot){this.provider=provider;if(!this.enabled||this.timer||!this.active||this.healTimer)return;this.timer=setTimeout(()=>{this.timer=undefined;if(this.task){this.dirty=true;return;}this.task=this.prepare(provider,this.fullIndexing).catch(async error=>{if(this.quietStop||!this.enabled)return;this.error=error instanceof Error?error.message:'local failure';if(error instanceof Error&&error.name==='SemanticAccessError'){this.enabled=false;this.generation++;this.dirty=false;try{await this.closeResources();}catch(cleanup){this.cleanupError=cleanup instanceof Error?cleanup.message:'Semantic cleanup failed';this.error=this.cleanupError;}}else this.heal(error);}).finally(()=>{this.task=undefined;if(this.enabled&&this.dirty){this.dirty=false;this.error=null;this.schedule(this.provider!);}});},5);}
 /** A saved cut has moved entries out of view: start indexing them now, for a session that has searched before but is not searching now, or whose worker the idle limit stopped (T21). Awaits nothing; a failure goes to `heal` like any preparation.
  * Only a session that ran a search earlier (`searched`) indexes at a cut: every AB1 session has its own controller and worker, so indexing at every node's cut could run several encoders at once on a 16 GB machine.
  * It is the conversation that left the view only (P8: kind first, no full pass), a heal backoff in progress is not bypassed, and the idle limit (P7) applies afterwards. */
 indexAtCut(provider:()=>Snapshot){if(this.enabled&&!this.healTimer&&this.searched&&!this.active){this.active=true;this.armIdle();}this.schedule(provider);}
 private async runtime(project:string){if(this.idling)await this.idling;if(!this.enabled)throw abort();outsideProject(project,this.config!.runtimeRoot,'runtime');outsideProject(project,scratchParent(this.config!),'scratch');outsideRuntime(this.config!.runtimeRoot,scratchParent(this.config!),'scratch');if(this.worker&&this.recycle){const old=this.worker;await old.close();if(this.worker===old){this.worker=undefined;this.identity='';this.recycle=false;}if(!this.enabled)throw abort();}
  if(!this.worker){const worker=new LocalWorker(this.config!,project,error=>{if(this.worker!==worker)return;this.cleanupError=error instanceof Error?error.message:'Semantic cleanup failed';this.error=this.cleanupError;this.enabled=false;this.generation++;},reason=>{if(this.worker===worker)this.heal(new WorkerFailure(reason));});this.worker=worker;}if(!this.identity){const ready=await this.worker.call('ready');if(ready.dimensions!==768||ready.maxTokens!==8192||!ready.offline)throw new Error('Incompatible semantic model; EG2 768/8192 offline required');this.identity=hash({worker:ready.identity,chunk:'eg2-passage256-focused-disjoint-direct-v3'});}return this.worker;}
 private path(snapshot:Snapshot){const directory=this.config!.indexDirectory;outsideProject(snapshot.project,directory,'index');return join(directory,hash({owner:this.ownerId,session:snapshot.session,project:resolve(snapshot.project)})+'.sqlite');}
 private async index(action:string,snapshot:Snapshot,extra:object={}){const path=this.path(snapshot),generation=this.generation,worker=await this.runtime(snapshot.project);if(!this.enabled||generation!==this.generation)throw abort();if(this.provider)this.recheck(this.provider,snapshot);this.indexFiles.add(path);const result=await worker.call('index',{path,identity:this.identity,action,projectDirectory:snapshot.project,...extra});if(!this.enabled||generation!==this.generation)throw abort();if(this.provider)this.recheck(this.provider,snapshot);return result;}
 private async prepare(provider:()=>Snapshot,full=true){
  if(!this.enabled)return;
  const generation=this.generation,started=performance.now();let snapshot=provider();const prior=this.current;
  if(prior?.complete&&prior.id===snapshot.id)return;
  // Both caps bound the window instead of failing above them. The unit cap (MAX_INDEX_UNITS) stays below the worker's 8,008-row store; the character cap, 2,000,000, usually binds first, at about 2.2 thousand units.
  const maxChars=this.config!.maxSourceCharacters??2000000,maxUnits=this.config!.maxUnits??MAX_INDEX_UNITS;
  const check=()=>{if(generation!==this.generation||!this.enabled)throw abort();this.recheck(provider,snapshot);};
  this.path(snapshot); // Reject project-local/aliased index storage before starting inference.
  const worker=await this.runtime(snapshot.project);check();
  // A retry after a failure proves the native encoder too, not only the worker: nothing may need embedding, and recovery must not be declared on a worker that cannot embed.
  if(this.healReason!==null){await worker.call('embed',{texts:[PROBE_TEXT],kind:'query'});check();this.recovered();}
  const stillEligible=new Map(snapshot.sources.map(source=>[source.entry.id,source.sha]));
  await this.index('reconcile',snapshot,{keys:(prior?.units??[]).filter(unit=>stillEligible.get(unit.source.entry.id)===unit.source.sha).map(unit=>unit.key)});check();
  if(prior?.id===snapshot.id)snapshot=prior;
  else{
   // The window covers what the agent can no longer see, kind first and then recency (see windowOrder), within both caps, newest first. A source too large to fit even alone is skipped;
   // the first source that does not fit the rest of the budget ends the window. What the window drops is not ranked (pi_tuck_recall still reads it) and loses its stored vectors.
   const built=new Map<string,Unit[]>(),order:Source[]=[];let chars=0,units=0;
   const eligibleShas=new Set(stillEligible.values());for(const sha of [...this.tokenized.keys()])if(!eligibleShas.has(sha))this.tokenized.delete(sha);
   for(const source of windowOrder(snapshot)){
    const size=sourceCharacters(source);
    if(size>maxChars)continue;
    if(chars+size>maxChars)break;
    let list:Unit[];const reused=this.tokenized.get(source.sha);
    if(reused)list=reused.map(unit=>({...unit,source}));
    else{
     list=[];
     for(const range of source.ranges){
      if(generation!==this.generation||!this.enabled)throw abort();if(provider().id!==snapshot.id)throw new Error('Eligible history changed before tokenization');
      const text=source.sourceText.slice(range.start,range.end);const pieces=(await worker.call('tokenize',{texts:[text],kind:'passage',split:true,maxTokens:256})).ranges[0] as {start:number;end:number}[];
      check();for(const part of pieces){const start=range.start+part.start,end=range.start+part.end,encoded=`Source role: ${source.row.role}\nOriginal passage: ${source.sourceText.slice(start,end)}`,inputSha=hash(encoded),key=hash({identity:this.identity,source:source.sha,start,end,inputSha});list.push({key,entryId:source.entry.id,start,end,inputSha,encoded,source});}
      if(units+list.length>maxUnits)break;
      if(generation!==this.generation||!this.enabled)throw abort();await yieldWork();
     }
    }
    if(units+list.length>maxUnits)break;
    this.tokenized.set(source.sha,list);built.set(source.sha,list);order.push(source);chars+=size;units+=list.length;
   }
   for(const sha of [...this.tokenized.keys()])if(!built.has(sha))this.tokenized.delete(sha);
   snapshot.units=order.flatMap(source=>built.get(source.sha)!);
   const outside=snapshot.sources.filter(source=>source.order<snapshot.viewStart),total=(sources:Source[])=>sources.reduce((n,source)=>n+sourceCharacters(source),0);
   snapshot.window={order,counts:order.map(source=>built.get(source.sha)!.length),searchUnits:order.filter(source=>source.order<snapshot.viewStart&&!isToolOutput(source)).reduce((n,source)=>n+built.get(source.sha)!.length,0),
    windowCharacters:chars,eligibleCharacters:total(snapshot.sources),conversationOutOfView:total(outside.filter(source=>!isToolOutput(source))),toolOutOfView:total(outside.filter(isToolOutput))};
  }
  check();
  this.current=snapshot;
  const keys=snapshot.units.map(u=>u.key);await this.index('reconcile',snapshot,{keys});check();const present=await this.index('status',snapshot,{keys});check();
  snapshot.indexed=new Set<string>(present.coveredKeys);let progressed=false;
  // Embedding runs in window order, so what is indexed is a growing prefix. Out-of-view conversation is small and never evicted: it is indexed whenever the worker is alive, right after a cut.
  // Tool output and the in-view tail wait for a search (`full`), newest first: embedding tool output the window drops a few cuts later would waste hours of work.
  const wanted=snapshot.units.filter(unit=>full||(unit.source.order<snapshot.viewStart&&!isToolOutput(unit.source)));
  for(let offset=0;offset<wanted.length;offset+=8){
   if(generation!==this.generation||!this.enabled)throw abort();const now=provider();if(now.id!==snapshot.id)throw new Error('Eligible history changed; indexing incomplete');
   const units=wanted.slice(offset,offset+8).filter(u=>!snapshot.indexed.has(u.key));
   if(units.length){const result=await worker.call('embed',{texts:units.map(u=>u.encoded),kind:'passage'});this.operations.preparationEmbeddings+=units.length;check();await this.index('upsert',snapshot,{rows:units.map((u,i)=>({key:u.key,entryId:u.entryId,start:u.start,end:u.end,inputSha:u.inputSha,vector:result.vectors[i]}))});check();for(const unit of units)snapshot.indexed.add(unit.key);progressed=true;}
   await yieldWork();if(progressed&&performance.now()-started>(this.config!.prepareWorkMs??30000)){this.error='Preparation work slice exhausted; indexing incomplete';this.dirty=true;return;}
  }
  check();
  if(snapshot.units.every(unit=>snapshot.indexed.has(unit.key))){snapshot.complete=true;if(full)this.fullIndexing=false;}
  this.error=null;this.recovered();
 }
 async waitForReady(timeoutMs=this.config?.queryWaitMs??30000,signal?:AbortSignal,expectedSnapshotId?:string,forSearch=false){if(this.enabled)this.demand();let targetId=expectedSnapshotId;try{targetId??=this.provider?.().id;}catch(error){await this.disable(false);throw error;}if(this.enabled&&this.provider&&this.current?.id!==targetId){this.error=null;this.schedule(this.provider);}const started=performance.now();while(this.enabled&&!this.readyFor(targetId,forSearch)&&!this.error&&!this.healTimer&&performance.now()-started<timeoutMs){if(signal?.aborted){await this.cancelled();throw abort();}if(this.provider&&!this.timer&&!this.task)this.schedule(this.provider);await new Promise(done=>setTimeout(done,10));}this.armIdle();return this.status();}
 /** A plan for this snapshot that is fully indexed or, for a search, has all its out-of-view conversation indexed. The tool output behind it and the in-view tail are not worth waiting for: they keep indexing in the background and the coverage statement says how far they got.
 * With no out-of-view conversation (no cut) nothing waits: the search returns at once (T17). Only a window whose out-of-view part is tool output alone still waits for the whole window. */
 private readyFor(id:string|undefined,forSearch:boolean){const plan=this.current;return Boolean(plan&&plan.id===id&&(plan.complete||(forSearch&&plan.window!==undefined&&plan.window.searchUnits>0&&plan.units.slice(0,plan.window.searchUnits).every(unit=>plan.indexed.has(unit.key)))));}
 private recheck(provider:()=>Snapshot,snapshot:Snapshot){const now=provider();if(now.id!==snapshot.id||now.session!==snapshot.session||now.project!==snapshot.project)throw new Error('Eligible branch or source changed before semantic admission');}
 private async joinPreparation(deadline:number,signal?:AbortSignal){
  const task=this.task;if(!task)return true;let timer:ReturnType<typeof setTimeout>|undefined,onAbort:(()=>void)|undefined;
  try{
   const waiting=[task.then(()=>true),new Promise<boolean>(done=>{timer=setTimeout(()=>done(false),Math.max(0,deadline-performance.now()));})];
   if(signal)waiting.push(new Promise<boolean>((_resolve,reject)=>{onAbort=()=>reject(abort());signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}));
   return await Promise.race(waiting);
  }catch(error){if(signal?.aborted){await this.cancelled();throw abort();}throw error;}
  finally{if(timer)clearTimeout(timer);if(onAbort)signal?.removeEventListener('abort',onAbort);}
 }
 search(query:string,provider:()=>Snapshot,signal?:AbortSignal,prior:PriorResult[]=[],words?:any):Promise<SemanticPage>{const task=this.searchOwned(query,provider,signal,prior,words);this.activeSearches.add(task);const settled=()=>{this.activeSearches.delete(task);this.armIdle();};void task.then(settled,settled);return task;}
 private async searchOwned(query:string,provider:()=>Snapshot,signal?:AbortSignal,prior:PriorResult[]=[],words?:any):Promise<SemanticPage>{if(signal?.aborted)throw abort();if(!this.enabled)return{status:'disabled',notice:'Optional semantic recall is disabled; ordinary word recall remains available.',coverage:this.status(),groups:[]};
  this.demand();this.searched=true;
  const deadline=performance.now()+(this.config!.queryWaitMs??30000),incomplete=():SemanticPage=>({status:'indexing_incomplete',notice:'No semantic ranking performed: nothing of the requested eligible snapshot is indexed yet.',coverage:this.status(),groups:[]}),
   unavailable=():SemanticPage=>({status:'unavailable',notice:'Local semantic preparation unavailable; permitted ordinary recall remains available.',coverage:this.status(),groups:[]});
  const queryGeneration=this.generation;let bound:Snapshot;try{bound=provider();}catch(error){await this.disable(false);throw error;}this.provider=provider;if(this.healTimer)return unavailable(); // a retry is waiting: it owns the next attempt, a search does not bypass the backoff
  // Nothing out of view (no cut yet, or the cut kept everything): the whole history is in the agent's context, so a search never waits for indexing, and the query never starts a worker itself (background preparation may). It ranks what an already running worker has indexed, else it says so at once; a recorded failure is still reported as unavailable, as on the waiting path.
  if(bound.sources.every(source=>source.order>=bound.viewStart)){
   const failure=this.error??this.healReason,failed=failure!==null&&!CHURN.test(failure),planned=this.current?.id===bound.id&&this.current.complete,page=failed?unavailable():null; // built before the retry clears the error, so the page's coverage reports it
   if(!planned){this.error=null;this.schedule(provider);}
   if(!(this.current?.id===bound.id&&((this.current.complete&&!this.current.units.length)||(indexedPrefix(this.current)>0&&this.worker!==undefined&&!this.recycle&&!this.idling)))){if(page)return page;return{status:'indexing_incomplete',notice:'No semantic ranking performed: nothing is out of view, so the whole history is in your context.',coverage:this.status(),groups:[]};}
  }else{
  if(this.current?.id!==bound.id){const prepared=!this.task||await this.joinPreparation(deadline,signal);if(signal?.aborted||queryGeneration!==this.generation)throw abort();if(!prepared||performance.now()>=deadline)return incomplete();this.error=null;this.schedule(provider);}else if(!this.current.complete){this.error=null;this.schedule(provider);}await this.waitForReady(Math.max(0,deadline-performance.now()),signal,bound.id,true);if(signal?.aborted||queryGeneration!==this.generation)throw abort();
  }
  // Ranking needs a plan for the bound snapshot and an indexed prefix; the coverage statement describes exactly that prefix and nothing else is ranked, so a search that reaches its wait limit with part of the window indexed ranks that part. Only an empty prefix is `indexing_incomplete`.
  const snapshot=this.current;if(!snapshot||snapshot.id!==bound.id||(snapshot.units.length?indexedPrefix(snapshot)===0:!snapshot.complete)){const failure=this.error??this.healReason;return failure&&!CHURN.test(failure)?unavailable():incomplete();}
  if(!snapshot.units.length)return{status:'no_matches',notice:'No eligible original source units in this snapshot.',coverage:this.status(),method:'embedding',groups:[]};
  try{const worker=await this.runtime(snapshot.project);this.recheck(provider,snapshot);const encoded=await worker.call('embed',{texts:[query],kind:'query'},signal);this.operations.queryEmbeddings++;this.recheck(provider,snapshot);const prefix=indexedPrefix(snapshot),stored=snapshot.units.slice(0,prefix),byKey=new Map(stored.map(u=>[u.key,u])),covered=windowCoverage(snapshot,prefix)!;let ranked:{unit:Unit;score:number}[]=[],observed=0;for(let offset=0;offset<stored.length;offset+=SCORE_CHUNK){this.recheck(provider,snapshot);const scored=await this.index('score',snapshot,{keys:stored.slice(offset,offset+SCORE_CHUNK).map(u=>u.key),query:encoded.vectors[0]}) as {ranked:{key:string;score:number}[];observed:number};observed+=scored.observed;ranked.push(...scored.ranked.map(row=>({unit:byKey.get(row.key)!,score:row.score})));ranked.sort((a,b)=>b.score-a.score);ranked=ranked.slice(0,24);if(signal?.aborted)throw abort();await yieldWork();}if(observed!==stored.length)throw new Error('Snapshot index coverage changed');
   if(signal?.aborted||queryGeneration!==this.generation||!this.enabled)throw abort();this.recheck(provider,snapshot);const final=provider();const finalSources=new Map(final.sources.map(source=>[source.entry.id,source.sha]));if(snapshot.sources.some(source=>finalSources.get(source.entry.id)!==source.sha))throw new Error('Eligible source changed or access revoked before return');
   for(const reference of prior){const source=snapshot.sources.find(s=>s.entry.id===reference.entryId);if(!Number.isSafeInteger(reference.start)||!Number.isSafeInteger(reference.end)||reference.start>reference.end||!source||reference.sourceSha!==source.sha||reference.end>source.sourceText.length)throw new Error('Invalid explicit prior source range');}const previous=[...prior,...(words?.hits??[]).map((hit:any)=>({entryId:hit.entryId,start:hit.read.offset,end:hit.read.offset+hit.read.limit,sourceSha:snapshot.sources.find(s=>s.entry.id===hit.entryId)?.sha}))];return{status:'ok',notice:'Related original evidence, not current truth or proof that every qualification was found. Scores do not establish authority, event time or supersession. Sources preserve recorded time and original order.'+` Semantic ranking covers ${covered.conversation.indexedCharacters} of ${covered.conversation.outOfViewCharacters} characters of earlier conversation and ${covered.toolResults.indexedCharacters} of ${covered.toolResults.outOfViewCharacters} characters of earlier tool output (newest first, back to ${covered.toolResults.oldestCoveredTime??covered.oldestCoveredTime??'an unknown time'}); use pi_tuck_recall for the rest.`,coverage:{...this.status(),window:covered},method:'embedding',groups:this.assemble(ranked.map(hit=>hit.unit),snapshot,previous)};
  }catch(error){if(error instanceof Error&&error.name==='SemanticAccessError'){await this.disable(false);throw error;}if(signal?.aborted||queryGeneration!==this.generation||error instanceof Error&&error.name==='AbortError'){await this.cancelled();throw abort();}this.heal(error);return{status:'unavailable',notice:'Local semantic search failed; ordinary recall remains available. '+(error instanceof Error?error.message:'failure'),coverage:this.status(),groups:[]};}
 }
 private assemble(units:Unit[],snapshot:Snapshot,previous:PriorResult[]):SemanticGroup[]{
  // Collapse coordinate overlap only; disjoint evidence in one entry remains independent.
  const groups:SemanticGroup[]=[],selected:InputSpan[]=[];
  for(const unit of units){
   if(groups.length>=8)break;
   const inputs:InputSpan[]=[{source:unit.source,start:unit.start,end:unit.end}];
   const producer=unit.source.row.producerRead;
    for(const source of snapshot.sources){
     if(source===unit.source)continue;
     if(producer&&source.entry.id===producer.entryId){for(const r of source.ranges){const start=Math.max(r.start,producer.offset),end=Math.min(r.end,producer.offset+producer.limit);if(start<end)inputs.push({source,start,end});}}
     else if(!producer&&Math.abs(source.order-unit.source.order)===1&&['user','assistant'].includes(source.row.role)&&source.ranges[0]){const r=source.ranges[0];let end=Math.min(r.end,r.start+1000);if(/[\uD800-\uDBFF]/u.test(source.sourceText[end-1]??''))end--;inputs.push({source,start:r.start,end});}
    }
   const spans=inputs.map(input=>this.focus(input)).sort((a,b)=>a.source.order-b.source.order||a.start-b.start);
   if(spans.every(p=>[...selected,...previous.filter(r=>r.entryId===p.source.entry.id&&r.sourceSha===p.source.sha).map(r=>({source:p.source,start:r.start,end:r.end}))].some(old=>old.source.sha===p.source.sha&&old.start<=p.start&&old.end>=p.end)))continue;
   const sources=spans.map(p=>this.evidence(p.source,p.start,p.end));
   groups.push({sources,notice:'Bounded original passage; omitted text may qualify it. Not current authority or exhaustive qualifications.'});selected.push(...spans);
  }
  const consolidated=consolidateEvidence(groups,previous);Object.defineProperty(consolidated,expandedGroups,{value:{groups,previous}});return consolidated;
 }
 private focus(input:InputSpan):InputSpan{
  const {source}=input,range=source.ranges.find(r=>r.start<=input.start&&r.end>=input.end);if(!range)throw new Error('Evidence outside eligible original range');
  if(range.end-range.start<=1600)return{source,...range};
  let start=source.sourceText.lastIndexOf('\n\n',input.start);start=start<range.start?range.start:start+2;
  let end=source.sourceText.indexOf('\n\n',input.end);end=end<0||end>range.end?range.end:end;
  if(end-start>2000){start=input.start;end=input.end;}
  return{source,start,end};
 }
 private evidence(source:Source,start:number,end:number){return{...source.row,sourceOrder:source.order,sourceSha:source.sha,text:source.sourceText.slice(start,end),textOffset:start,totalCharacters:source.sourceText.length,read:{entryId:source.entry.id,offset:start,limit:end-start},complete:start===0&&end===source.sourceText.length};}
 async disable(joinSearches=true){if(joinSearches)this.joiningSearches++;try{if(!this.closing){const stop=this.stopOwner();this.closing=stop;void stop.finally(()=>{if(this.closing===stop)this.closing=undefined;}).catch(()=>{});}await this.closing;if(joinSearches)await Promise.allSettled([...this.activeSearches]);}finally{if(joinSearches)this.joiningSearches--;}}
 private async closeResources(){this.fullIndexing=false;this.cancelHeal();this.cancelIdle();this.active=false;this.healReason=null;this.healAttempts=0;this.recycle=false;const worker=this.worker;await worker?.close();await Promise.all([...this.indexFiles].flatMap(path=>[path,path+'-wal',path+'-shm']).map(path=>rm(path,{force:true})));this.indexFiles.clear();if(this.worker===worker)this.worker=undefined;this.identity='';this.current=undefined;this.tokenized.clear();this.cleanupError=null;}
 private async stopOwner(){this.dirty=false;this.enabled=false;this.generation++;if(this.timer){clearTimeout(this.timer);this.timer=undefined;}try{await this.closeResources();await this.task;this.task=undefined;}catch(error){this.cleanupError=error instanceof Error?error.message:'Semantic cleanup failed';throw error;}}

 /** A search, or a wait for readiness, is demand: it lets background work start and keeps it alive for IDLE_STOP_MS after the last one. */
 private demand(){this.active=true;this.fullIndexing=true;this.cancelIdle();}
 private cancelIdle(){if(this.idleTimer)clearTimeout(this.idleTimer);this.idleTimer=undefined;}
 private armIdle(){this.cancelIdle();if(!this.enabled||!this.active)return;this.idleTimer=setTimeout(()=>{this.idleTimer=undefined;void this.idleStop();},this.timing.idleStopMs??IDLE_STOP_MS);this.idleTimer.unref();}
 private idleStop(){
  if(this.idling||!this.enabled||!this.active||this.joiningSearches||this.activeSearches.size)return Promise.resolve();
  return this.stopWorker();
 }
 /** A search or wait the caller cancelled (Esc) or that a stop overtook ends, and the worker with it, but recall stays enabled: the next search starts a worker again (P7). Only access loss disables (see `searchOwned`). */
 private async cancelled(){if(this.enabled)await this.stopWorker();else await this.disable(false);}
 /** Stop the worker and any preparation under way, quietly (no error, no recovery). The vectors stay in the on-disk index and the in-memory plan,
  * so the next search starts a worker and finds them. Enabled stays enabled; a recorded start failure stays recorded, but its retry timer ends. Used after the idle limit and after a cancelled search. */
 private stopWorker():Promise<void>{
  if(this.idling)return this.idling;
  const running=this.task; // a preparation a search starts during the stop waits for it in runtime(), so the stop must not wait for that one
  const stop=(async()=>{
   this.active=false;this.fullIndexing=false;this.quietStop=true;this.generation++;this.dirty=false;
   if(this._timer){clearTimeout(this._timer);this.timer=undefined;}
   this.cancelHeal();
   const worker=this.worker;
   try{await worker?.close();await running;if(this.worker===worker){this.worker=undefined;this.identity='';this.recycle=false;}}
   catch(error){this.cleanupError=error instanceof Error?error.message:'Semantic cleanup failed';this.error=this.cleanupError;this.enabled=false;this.generation++;}
   finally{this.quietStop=false;}
  })();
  this.idling=stop;void stop.finally(()=>{if(this.idling===stop)this.idling=undefined;});return stop;
 }
 private cancelHeal(){if(this.healTimer)clearTimeout(this.healTimer);this.healTimer=undefined;this.healRetryAt=null;}
 /** A worker failure puts the controller into recovery: `unavailable` with the reason, the worker replaced at the next attempt, a retry armed. Other failures only re-arm a retry already under way. */
 private heal(error:unknown){
  if(!this.enabled)return;
  if(error instanceof WorkerFailure){this.healReason=error.message;this.healIntegrity=integrityRefusal(error);this.recycle=true;if(this.current)this.current.complete=false;}
  this.touch();
  if(this.healReason===null||this.healTimer||!this.provider)return;
  if(!(error instanceof WorkerFailure)&&error instanceof Error&&CHURN.test(error.message))return; // the history moved: not a failed attempt; the next turn end or search retries
  const delay=healDelayMs(this.healAttempts++,this.healIntegrity,this.timing.healDelaysMs,this.timing.healSteadyMs);
  this.healRetryAt=Date.now()+delay;
  this.healTimer=setTimeout(()=>{this.healTimer=undefined;this.healRetryAt=null;if(this.enabled&&this.provider&&this.healReason!==null)this.schedule(this.provider);},delay);
  this.healTimer.unref();
 }
 private recovered(){this.cancelHeal();this.healReason=null;this.healAttempts=0;this.touch();}
 /** One-shot health check for a status tool: start the worker (it verifies every file), embed a fixed string, and report. Enable first; close afterwards. */
 async probe(project:string):Promise<{dimension:number;startMs:number;embedMs:number}>{
  const started=performance.now();await this.runtime(project);const ready=performance.now();
  const vector=(await this.worker!.call('embed',{texts:[PROBE_TEXT],kind:'query'})).vectors?.[0];if(!Array.isArray(vector))throw new WorkerFailure('Local semantic runtime: invalid_vector','invalid_vector');
  return{dimension:vector.length,startMs:Math.round(ready-started),embedMs:Math.round(performance.now()-ready)};
 }
 async invalidate(){await this.disable();this.error='Caller invalidated semantic source access; explicit enable required';}
 async close(){await this.disable();this.provider=undefined;this.searched=false;} // a closed controller serves a new session, which has not searched (T21); a disable and enable keeps it
}
export const createSemanticRecall=(config?:SemanticRecallConfig)=>new SemanticRecallController(config);
/** Consolidate only source-bound coordinate overlap; equal text in distinct events is retained.
 * Reference rows preserve each original association without repeating its evidence text.
 */
function consolidateEvidence(groups:SemanticGroup[],previous:PriorResult[]=[]):SemanticGroup[]{
 const delivered:PriorResult[]=[];
 return groups.map(group=>{const consolidated={...group,sources:group.sources.flatMap(source=>{
  const start=source.textOffset,end=start+source.text.length;
  const prior=previous.find(p=>p.entryId===source.entryId&&p.sourceSha===source.sourceSha&&p.start<=start&&p.end>=end);
  const covered=prior?[{start,end,prior:true}]:delivered.filter(p=>p.entryId===source.entryId&&p.sourceSha===source.sourceSha&&p.start<end&&p.end>start).map(p=>({start:Math.max(start,p.start),end:Math.min(end,p.end),prior:false})).sort((a,b)=>a.start-b.start);
  const merged:typeof covered=[];for(const range of covered){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}
  const parts:SemanticSourceEvidence[]=[];let cursor=start;
  const piece=(left:number,right:number,reference?:boolean,prior?:boolean)=>{if(left>=right)return;parts.push({...source,text:reference?'':source.text.slice(left-start,right-start),textOffset:left,read:{entryId:source.entryId,offset:left,limit:right-left},complete:!reference&&left===0&&right===source.totalCharacters,...(reference?{evidenceReference:{entryId:source.entryId,sourceSha:source.sourceSha,start:left,end:right,basis:prior?'explicit prior or word result':'earlier source text in this response'},notice:'Original association retained; evidence text is referenced, not repeated.'}:{})});};
  for(const range of merged){piece(cursor,range.start);piece(range.start,range.end,true,range.prior);cursor=range.end;}piece(cursor,end);
  if(!source.text.length)return[source];if(!prior)delivered.push({entryId:source.entryId,sourceSha:source.sourceSha,start,end});return parts;
 })};
  // References must not displace evidence merely because their metadata is larger.
  return JSON.stringify(consolidated).length<=JSON.stringify(group).length?consolidated:group;
 });
}
/** Price complete evidence groups before delivery; ordinary section is never changed.
 * Consolidate each admitted prefix, so capacity omissions never back references.
 */
export function budgetSemantic(value:any,allowance:number){
 const plan=value.groups?.[expandedGroups],groups:SemanticGroup[]=plan?.groups??value.groups??[],previous:PriorResult[]=plan?.previous??[];
 const page={...value,groups:[] as SemanticGroup[],omittedGroups:groups.length};
 if(JSON.stringify(page).length>allowance)throw new Error('Semantic status cannot fit declared complete allowance');
 const accepted:SemanticGroup[]=[],omitted:SemanticGroup[]=[];
 for(const group of groups){
  const candidate=consolidateEvidence([...accepted,group],previous);page.groups=candidate;page.omittedGroups--;
  if(JSON.stringify(page).length<=allowance){accepted.push(group);continue;}
  page.groups=consolidateEvidence(accepted,previous);page.omittedGroups++;omitted.push(group);
 }
 // Coherent bodies have first use of capacity. One locator group cannot block a later body,
 // enter the evidence-reference ledger, or point back to text from an omitted group.
 const firstOmitted=omitted[0];
 if(firstOmitted){
  const partial:SemanticGroup={...firstOmitted,sources:firstOmitted.sources.map((source:SemanticSourceEvidence):SemanticSourceEvidence=>{
   const {evidenceReference:_reference,...original}=source;
   return{...original,text:'',complete:false,notice:'Original evidence omitted for response capacity; use exact expansion locator.',read:{entryId:source.entryId,offset:source.textOffset,limit:Math.min(8000,source.totalCharacters-source.textOffset)}};
  })};
  page.groups.push(partial);page.omittedGroups--;if(JSON.stringify(page).length>allowance){page.groups.pop();page.omittedGroups++;}
 }
 if(groups.length&&!page.groups.length)page.status='no_room';
 if(JSON.stringify(page).length>allowance)throw new Error('Semantic status cannot fit declared complete allowance');return page;
}
