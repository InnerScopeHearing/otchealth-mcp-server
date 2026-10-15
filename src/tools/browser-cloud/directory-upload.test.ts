import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateCloudBrowserAction } from './actions.js';
import { validateDeterministicPlan } from '../browser-cloud-gateway/index.js';
test('external folder action accepts bounded named tree while preserving single-file upload', () => {
  const fileId = randomUUID();
  const action = { type: 'upload_directory', selector: '#folder', files: [{ fileId, relativePath: 'Docs/notes.txt' }] };
  assert.deepEqual(validateCloudBrowserAction(action), action);
  assert.deepEqual(validateCloudBrowserAction({ type: 'upload', selector: '#file', fileId }), { type: 'upload', selector: '#file', fileId });
  for (const files of [[], [{ fileId, relativePath: '/tmp/notes.txt' }], [{ fileId, relativePath: 'Docs/../notes.txt' }], [{ fileId, relativePath: 'Docs/notes.txt' }, { fileId, relativePath: 'Docs/other.txt' }], [{ fileId, relativePath: 'Docs/notes.txt' }, { fileId: randomUUID(), relativePath: 'Docs/notes.txt' }], Array.from({ length: 33 }, (_, i) => ({ fileId: randomUUID(), relativePath: `Docs/${i}.txt` }))]) assert.throws(() => validateCloudBrowserAction({ ...action, files }));
  assert.throws(() => validateCloudBrowserAction({ ...action, path: '/home/otcbrowser' }));
  assert.throws(() => validateDeterministicPlan({ profile_id: 'public-profile', max_seconds: 180, actions: [action] }));
});
test('folder manifest rejects a file that is also an ancestor directory in either entry order', () => {
  const entries = [{ fileId: randomUUID(), relativePath: 'Docs/a.txt' }, { fileId: randomUUID(), relativePath: 'Docs/a.txt/b.txt' }];
  for (const files of [entries, [...entries].reverse()]) assert.throws(() => validateCloudBrowserAction({ type: 'upload_directory', selector: '#folder', files }));
  assert.doesNotThrow(() => validateCloudBrowserAction({ type: 'upload_directory', selector: '#folder', files: [{ fileId: randomUUID(), relativePath: 'Docs/a.txt' }, { fileId: randomUUID(), relativePath: 'Docs/a.txt-other/b.txt' }] }));
});
