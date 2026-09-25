import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestContext } from '../../server/request-context.js';
import {
  assertCooChatIntercomContactTarget,
  COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID,
  COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME,
  projectContactUpdateForCooChat,
  projectIntercomContactForCooChat,
} from './coo-synthetic-contact.js';
import type { UpdateContactOpts } from '../../intercom/full-client.js';

function withRequestContext<T>(callerAgent: string, connectorSurface: boolean, fn: () => T): T {
  return requestContext.run({
    callerHash: 'synthetic-caller',
    correlationId: 'synthetic-correlation',
    callerAgent,
    connectorSurface,
  }, fn);
}

test('COO Chat may address only the approved synthetic Intercom contact', () => {
  withRequestContext('coo', true, () => {
    assert.doesNotThrow(() => assertCooChatIntercomContactTarget(COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID));
    assert.throws(
      () => assertCooChatIntercomContactTarget('another-contact'),
      /approved synthetic test contact/,
    );
  });
});

test('COO Chat contact reads return only the synthetic ID and fixed verification name', () => {
  const untrustedContact = {
    id: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID,
    name: 'Unverified contact name',
    email: 'hidden@example.invalid',
    phone: '+10000000000',
    custom_attributes: { internal_note: 'hidden' },
  };

  withRequestContext('coo', true, () => {
    assert.deepEqual(projectIntercomContactForCooChat(untrustedContact), {
      id: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID,
      name: null,
    });
    assert.deepEqual(projectIntercomContactForCooChat({
      ...untrustedContact,
      name: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME,
    }), {
      id: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID,
      name: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME,
    });
    assert.throws(
      () => projectIntercomContactForCooChat({ ...untrustedContact, id: 'another-contact' }),
      /unexpected contact/,
    );
  });
});

test('COO Chat contact updates accept only the fixed marker on the approved synthetic contact', () => {
  const approved: UpdateContactOpts = {
    contact_id: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID,
    name: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME,
  };

  withRequestContext('coo', true, () => {
    assert.deepEqual(projectContactUpdateForCooChat(approved), approved);
    assert.throws(() => projectContactUpdateForCooChat({
      contact_id: 'another-contact',
      name: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME,
    }), /approved synthetic test contact/);
    assert.throws(() => projectContactUpdateForCooChat({
      ...approved,
      name: 'Unverified contact name',
    }), /fixed synthetic verification name/);
    assert.throws(() => projectContactUpdateForCooChat({
      ...approved,
      email: 'hidden@example.invalid',
    }), /fixed synthetic verification name/);
  });
});

test('other lanes and non-connector COO callers retain their existing contact behavior', () => {
  const otherContact = {
    id: 'another-contact',
    name: 'Example contact',
    email: 'example@example.invalid',
    custom_attributes: { tier: 'standard' },
  };
  const otherUpdate: UpdateContactOpts = {
    contact_id: 'another-contact',
    name: 'Example contact',
    email: 'example@example.invalid',
  };

  for (const [callerAgent, connectorSurface] of [['cro', true], ['coo', false]] as const) {
    withRequestContext(callerAgent, connectorSurface, () => {
      assert.strictEqual(projectIntercomContactForCooChat(otherContact), otherContact);
      assert.strictEqual(projectContactUpdateForCooChat(otherUpdate), otherUpdate);
      assert.doesNotThrow(() => assertCooChatIntercomContactTarget('another-contact'));
    });
  }
});
