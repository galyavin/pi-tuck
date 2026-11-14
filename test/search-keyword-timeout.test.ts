import {afterEach,expect,test,vi} from 'vitest';
import {SessionManager} from '@earendil-works/pi-coding-agent';

afterEach(()=>{vi.restoreAllMocks();});
test('the keyword time-out message no longer tells the agent to simplify a regex', async()=>{
 const {tuck,tuckRecall}=await import('../src/tuck');
 const m=SessionManager.inMemory('/tmp/keyword-timeout-2');for(let i=0;i<4;i++)m.appendMessage({role:'user',content:'decision '+i,timestamp:i+1});
 let clock=1e12;vi.spyOn(Date,'now').mockImplementation(()=>(clock+=4000));
 expect(()=>tuckRecall(tuck,m.getEntries(),m.getBranch(),{query:'decision'})).toThrow(/^Search aborted: query exceeded 3000ms on this history\. Use more specific words/);
});
