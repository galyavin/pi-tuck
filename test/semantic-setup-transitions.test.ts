import { expect, test } from 'vitest';
import { SemanticRecallController } from '../src/semantic-recall';

const config = { pythonPath: '/usr/bin/python3', runtimeRoot: '/tmp/tuck-transition-runtime', indexDirectory: '/tmp/tuck-transition-index' };
test.each(['off-project', 'off-platform', 'off-settings'] as const)('enable preserves the %s policy state', async state => {
 const controller = new SemanticRecallController(config);
 try {
  controller.setSetup(state);
  controller.enable();
  expect(controller.status()).toMatchObject({ setup: state, enabled: false });
 } finally { await controller.close(); }
});

test('a throwing enable leaves failed with its start reason', async () => {
 const controller = new SemanticRecallController();
 try {
  controller.setSetup('starting');
  expect(() => controller.enable()).toThrow('Optional local semantic runtime is not configured');
  expect(controller.status()).toMatchObject({ setup: 'failed', enabled: false, lastError: 'Optional local semantic runtime is not configured' });
 } finally { await controller.close(); }
});

test('closing a ready controller leaves an off setup state', async () => {
 const controller = new SemanticRecallController(config);
 controller.enable();
 await controller.close();
 expect(controller.status()).toMatchObject({ setup: 'off-user', enabled: false });
});

test('revoking source access already leaves the ready state and preserves its reason', async () => {
 const controller = new SemanticRecallController(config);
 controller.enable();
 const error = Object.assign(new Error('Source access revoked'), { name: 'SemanticAccessError' });
 try {
  await expect(controller.search('query', () => { throw error; })).rejects.toThrow(error);
  expect(controller.status()).toMatchObject({ setup: 'off-user', enabled: false, lastError: error.message });
 } finally { await controller.close(); }
});

test('background access revocation leaves the ready state and records the reason', async () => {
 const controller = new SemanticRecallController(config);
 controller.enable();
 try {
  controller.indexAtCut(() => { throw Object.assign(new Error('Background access revoked'), { name: 'SemanticAccessError' }); });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(controller.status()).toMatchObject({ setup: 'failed', enabled: false, lastError: 'Background access revoked' });
 } finally { await controller.close(); }
});

test('an idle worker cleanup failure leaves the ready state and records the reason', async () => {
 const controller = new SemanticRecallController(config);
 controller.enable();
 // Inject only the worker close fault; exercise the controller's actual stop path.
 const internals = controller as unknown as { worker?: { close: () => Promise<void> }; stopWorker: () => Promise<void> };
 internals.worker = { close: async () => { throw new Error('Worker cleanup failed'); } };
 try {
  await internals.stopWorker();
  expect(controller.status()).toMatchObject({ setup: 'failed', enabled: false, lastError: 'Worker cleanup failed' });
 } finally { internals.worker = undefined; await controller.close(); }
});
