import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverCheckpointMemory, checkpointDeliveryStatus } from './checkpoint-delivery.js';

test('accepted storage survives thrown or returned indexing failure without rewriting memory', async () => {
  for (const throws of [true, false]) {
    let writes = 0;
    const result = await deliverCheckpointMemory(async () => { writes++; return { id: 'original' }; }, async () => {
      if (throws) throw Error('index unavailable');
      return { indexed: false };
    });
    assert.equal(writes, 1);
    assert.deepEqual(checkpointDeliveryStatus([result]), { written: ['original'], indexed: [], unindexed: ['original'], storage_unconfirmed: 0, checkpoint: false });
  }
});
test('unconfirmed storage is not reported written or passed to indexing', async () => {
  let indexed = false;
  const result = await deliverCheckpointMemory(async (): Promise<{ id: string }> => { throw Error('response lost'); }, async () => { indexed = true; return { indexed: true }; });
  assert.equal(indexed, false);
  assert.equal(checkpointDeliveryStatus([result]).storage_unconfirmed, 1);
  assert.equal(checkpointDeliveryStatus([result]).checkpoint, false);
});
test('a successful episode does not hide a failed explicit memory', () => {
  assert.equal(checkpointDeliveryStatus([{id:null,stored:false,indexed:false},{id:'episode',stored:true,indexed:true}]).checkpoint, false);
  assert.equal(checkpointDeliveryStatus([]).checkpoint, false);
  assert.equal(checkpointDeliveryStatus([{id:'memory',stored:true,indexed:true}]).checkpoint, true);
});
