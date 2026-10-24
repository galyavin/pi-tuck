import { pythonFlags, testPython, testNativeOwner } from './python-fixture';
import {test,expect} from 'vitest';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('EG2 runtime and offline provisioning verify exact publisher schemas, precision identities, utility origin and owned rollback',()=>{
 const testPath=fileURLToPath(new URL('./eg2-runtime.test.py',import.meta.url));
 // Source/effect boundary with synthetic assets, not native model quality qualification.
 expect(()=>execFileSync(testPython,[...pythonFlags,testPath],{encoding:'utf8',stdio:'pipe'})).not.toThrow();
});
