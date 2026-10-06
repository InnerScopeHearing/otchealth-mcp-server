import { test } from 'node:test';
import assert from 'node:assert/strict';

test('dependent serial deliveries preserve order and continue after an unknown acknowledgement', async () => {
  const { deliverCheckpointBatch } = await import('./checkpoint-delivery.js');
  const called: number[] = [];
  const result = await deliverCheckpointBatch([0, 1, 2], async index => {
    called.push(index);
    if (index === 1) throw new Error('synthetic lost acknowledgement');
    return {id:String(index),stored:true,indexed:true};
  }, 4, true);
  assert.deepEqual(called, [0, 1, 2]);
  assert.deepEqual(result.map(item => item.id), ['0', null, '2']);
  assert.equal(result[1]?.stored, false);
});
import { deliverCheckpointMemory, deliverCheckpointBatch, checkpointDeliveryStatus } from './checkpoint-delivery.js';

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

test('bounded checkpoint delivery overlaps independent work and keeps receipt order after partial failure', async () => {
  let active = 0, maximum = 0;
  const started: number[] = [];
  const result = await deliverCheckpointBatch([0, 1, 2, 3, 4], async item => {
    active++;
    maximum = Math.max(maximum, active);
    started.push(item);
    await new Promise(resolve => setTimeout(resolve, item === 0 ? 20 : 5));
    active--;
    if (item === 2) throw new Error('synthetic lost acknowledgement');
    return { id: `id-${item}`, stored: true, indexed: true };
  }, 4);
  assert.equal(maximum, 4);
  assert.deepEqual(started.slice(0, 4), [0, 1, 2, 3]);
  assert.deepEqual(result, [
    { id: 'id-0', stored: true, indexed: true },
    { id: 'id-1', stored: true, indexed: true },
    { id: null, stored: false, indexed: false },
    { id: 'id-3', stored: true, indexed: true },
    { id: 'id-4', stored: true, indexed: true },
  ]);
  assert.equal(checkpointDeliveryStatus(result).storage_unconfirmed, 1);
});

test('superseding checkpoint batches retain serial order', async () => {
  const order: number[] = [];
  const result = await deliverCheckpointBatch([0, 1, 2], async item => {
    order.push(item);
    return { id: `id-${item}`, stored: true, indexed: true };
  }, 4, true);
  assert.deepEqual(order, [0, 1, 2]);
  assert.deepEqual(result.map(item => item.id), ['id-0', 'id-1', 'id-2']);
});
