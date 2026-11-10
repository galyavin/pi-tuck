import {expect,test} from 'vitest';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {semanticEligibleSources} from '../src/semantic-recall';
import {memoizedEligibleSources} from '../src/eligibility-cache';

// A prompt's cut reaches the requests at once and the session only at the end of the first turn. A tuck_search in that turn saw no cut, said
// "nothing is out of view, so the whole history is in your context", and ranked nothing (78% of searches in the 2026-11-10 lane runs). Search now
// takes the pending cut's first kept entry as the edge of the view.
function session(){
 const m=SessionManager.inMemory('/tmp/pending-cut');const ids:string[]=[];
 for(let i=0;i<8;i++)ids.push(m.appendMessage({role:'user',content:'turn '+i,timestamp:i+1}));
 return {m,ids,ctx:{cwd:'/tmp/pending-cut',sessionManager:m}};
}
test('with no cut saved, a pending cut puts everything before its first kept entry out of view', ()=>{
 const {ids,ctx}=session();
 const plain=semanticEligibleSources(ctx,{},()=>{}),pending=semanticEligibleSources(ctx,{},()=>{},ids[5]);
 expect(plain.sources.every(s=>s.order>=plain.viewStart)).toBe(true); // what the search read as "nothing is out of view"
 expect(pending.sources.filter(s=>s.order<pending.viewStart).length).toBe(5);
 expect(pending.id).not.toBe(plain.id);
});
test('a saved newer cut wins over an older pending one, and the memo keeps pending and plain apart', ()=>{
 const {m,ids,ctx}=session();
 const a=memoizedEligibleSources(ctx,undefined,()=>{}),b=memoizedEligibleSources(ctx,undefined,()=>{},ids[3]);
 expect(b.viewStart).toBeGreaterThan(a.viewStart);
 m.appendCompaction('summary',ids[6]!,100,undefined,true);
 const c=semanticEligibleSources(ctx,{},()=>{},ids[3]);
 expect(c.sources.filter(s=>s.order<c.viewStart).every(s=>s.order<6)).toBe(true);
 expect(c.viewStart).toBe(6);
});
