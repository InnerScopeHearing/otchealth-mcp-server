import { z } from 'zod';

export interface TwilioResourceCountsProjection {
  requested_page_size: number;
  messaging_services_returned: number;
  incoming_numbers_returned: number;
}

export const twilioPageSizeSchema = z.number().int().min(1).max(100);

export async function readCooTwilioResourceCounts(input: {
  caller: string;
  pageSize: number;
  listMessagingServices: (pageSize: number) => Promise<readonly unknown[]>;
  listIncomingNumbers: (pageSize: number) => Promise<readonly unknown[]>;
}): Promise<TwilioResourceCountsProjection> {
  if (input.caller !== 'coo') throw new Error('This Twilio count tool is available to the COO lane only.');
  const parsedSize = twilioPageSizeSchema.safeParse(input.pageSize);
  if (!parsedSize.success) throw new Error('Twilio page size must be an integer from 1 through 100.');
  const pageSize = parsedSize.data;
  try {
    const [messagingServices, incomingNumbers] = await Promise.all([
      input.listMessagingServices(pageSize),
      input.listIncomingNumbers(pageSize),
    ]);
    return projectTwilioResourceCounts({
      requested_page_size: pageSize,
      messaging_services: messagingServices,
      incoming_numbers: incomingNumbers,
    });
  } catch {
    throw new Error('Twilio resource counts are unavailable. Check the server log using the correlation ID.');
  }
}

export function projectTwilioResourceCounts(input: {
  requested_page_size: number;
  messaging_services: readonly unknown[];
  incoming_numbers: readonly unknown[];
}): TwilioResourceCountsProjection {
  const parsedSize = twilioPageSizeSchema.safeParse(input.requested_page_size);
  if (!parsedSize.success) throw new TypeError('Twilio page size must be an integer from 1 through 100.');
  if (!Array.isArray(input.messaging_services) || !Array.isArray(input.incoming_numbers)) {
    throw new TypeError('Twilio list response must be an array');
  }
  if (input.messaging_services.length > parsedSize.data || input.incoming_numbers.length > parsedSize.data) {
    throw new TypeError('Twilio list response exceeded the requested page size.');
  }
  return {
    requested_page_size: input.requested_page_size,
    messaging_services_returned: input.messaging_services.length,
    incoming_numbers_returned: input.incoming_numbers.length,
  };
}
