/** Explicit company lanes only. Personal and unrecognized identities are never queryable. */
export const COMPANY_CHAT_ACTION_LANES = ['cto','developer','coo','cro','cfo','clo','exec','cpo','cco','wefunder-campaign-director','agents-shared'] as const;
export type CompanyChatActionLane = (typeof COMPANY_CHAT_ACTION_LANES)[number];
