import { currentCallerAgent, isConnectorSurface } from '../../server/request-context.js';
import type { UpdateContactOpts } from '../../intercom/full-client.js';

/** The one owner-approved synthetic contact available to ordinary COO Chat. */
export const COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID = '6ab5f0e0843a84e15468a558';

/** Fixed non-personal marker used for harmless write/readback verification. */
export const COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME = 'Synthetic Intercom Contact Verification';

function isCooChatConnector(): boolean {
  return currentCallerAgent() === 'coo' && isConnectorSurface();
}

export function assertCooChatIntercomContactTarget(contactId: string): void {
  if (isCooChatConnector() && contactId !== COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID) {
    throw new Error('COO Chat Intercom contact access is restricted to the approved synthetic test contact.');
  }
}

/**
 * A COO connector read is confined to the synthetic contact and returns only the synthetic ID plus
 * its fixed verification marker. All vendor-provided customer fields are discarded.
 */
export function projectIntercomContactForCooChat(contact: unknown): unknown {
  if (!isCooChatConnector()) return contact;
  if (!contact || typeof contact !== 'object' || Array.isArray(contact)) {
    throw new Error('Intercom did not return the expected synthetic contact.');
  }

  const record = contact as Record<string, unknown>;
  if (record.id !== COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID) {
    throw new Error('Intercom returned an unexpected contact for the synthetic verification request.');
  }

  return {
    id: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID,
    name: record.name === COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME
      ? COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME
      : null,
  };
}

/**
 * COO Chat can only write the fixed verification label to the approved synthetic contact. Other
 * callers retain the existing full update behavior and remain subject to their existing gates.
 */
export function projectContactUpdateForCooChat(input: UpdateContactOpts): UpdateContactOpts {
  if (!isCooChatConnector()) return input;

  assertCooChatIntercomContactTarget(input.contact_id);
  if (input.name !== COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME ||
      Object.keys(input).some((key) => key !== 'contact_id' && key !== 'name')) {
    throw new Error('COO Chat Intercom updates are limited to the fixed synthetic verification name.');
  }

  return {
    contact_id: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_ID,
    name: COO_CHAT_SYNTHETIC_INTERCOM_CONTACT_NAME,
  };
}
