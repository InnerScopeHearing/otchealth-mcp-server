import { randomUUID } from 'node:crypto';
import { BedrockAgentCoreControlClient, CreateBrowserProfileCommand, type CreateBrowserProfileCommandOutput } from '@aws-sdk/client-bedrock-agentcore-control';
import { Browser } from 'bedrock-agentcore/browser';
import { resolveAwsCredentials, signRequest, type AwsCredentials } from '../../search/sigv4.js';

const ACCOUNT_ID = '900915535335';
const MAX_LIVE_VIEW_SECONDS = 300;
const REQUEST_TIMEOUT_MS = 15_000;
const PROFILE_ID = /^[a-zA-Z][a-zA-Z0-9_]{0,47}-[a-zA-Z0-9]{10}$/;

export class IntercomProfileProviderError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'IntercomProfileProviderError'; }
}

export interface IntercomProfileProviderConfig {
  region: string;
  browserIdentifier: string;
}

export interface ProfileCreateInput {
  name: string;
  clientToken: string;
  /** Caller identity hash is accepted for the root-owned registry/audit boundary, never sent to AWS. */
  ownerSubjectHash: string;
}

export interface ProfileCreateResult {
  providerProfileId: string;
  status: 'created';
  roleReceipt: { accountId: string; principalType: 'assumed-role'; roleName: string };
}

export interface LiveViewInput {
  browserIdentifier: string;
  sessionId: string;
  expiresIn?: number;
}

type CreateClient = { send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> };
type BrowserForSigning = { attachSession(sessionId: string): void; generateLiveViewUrl(expiresIn?: number): Promise<string> };

export interface IntercomProfileProviderDeps {
  resolveCredentials?: () => Promise<AwsCredentials | null>;
  fetch?: typeof fetch;
  createControlClient?: (region: string, credentials: AwsCredentials) => CreateClient;
  createProfileCommand?: (input: { name: string; clientToken: string }) => unknown;
  createBrowser?: (input: { region: string; identifier: string; credentials: AwsCredentials }) => BrowserForSigning;
  now?: () => Date;
}

function fail(code: string, message: string): never { throw new IntercomProfileProviderError(code, message); }

function checkedRegion(region: string): string {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) return fail('region_invalid', 'The browser provider region is invalid.');
  return region;
}

function checkedBrowserId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return fail('browser_identifier_invalid', 'The browser identifier is invalid.');
  return value;
}

function checkedSessionId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) return fail('session_id_invalid', 'The browser session identifier is invalid.');
  return value;
}

function xmlValue(xml: string, tag: string): string | undefined {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escaped}(?:\\s[^>]*)?>([^<]*)</${escaped}>`).exec(xml);
  return match?.[1]?.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').trim();
}

async function verifyPrincipal(region: string, credentials: AwsCredentials, fetcher: typeof fetch, now: Date): Promise<ProfileCreateResult['roleReceipt']> {
  const host = `sts.${region}.amazonaws.com`;
  const body = 'Action=GetCallerIdentity&Version=2011-06-15';
  const signed = signRequest({ method: 'POST', host, path: '/', body, region, service: 'sts', credentials,
    now, extraHeaders: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' } });
  let response: Response;
  try {
    response = await fetcher(`https://${host}/`, { method: 'POST', headers: signed.headers, body, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { return fail('principal_check_unavailable', 'The AWS caller identity could not be confirmed.'); }
  if (!response.ok) return fail('principal_check_unavailable', 'The AWS caller identity could not be confirmed.');
  let xml: string;
  try { xml = await response.text(); } catch { return fail('principal_check_unavailable', 'The AWS caller identity could not be confirmed.'); }
  const account = xmlValue(xml, 'Account');
  const arn = xmlValue(xml, 'Arn');
  if (account !== ACCOUNT_ID || !arn) return fail('principal_forbidden', 'The AWS caller is not an authorized browser operator.');
  const assumedRole = /^arn:aws:sts::900915535335:assumed-role\/([A-Za-z0-9+=,.@_-]+)\/[A-Za-z0-9+=,.@_-]+$/.exec(arn);
  if (!assumedRole) return fail('principal_forbidden', 'The AWS caller is not an authorized assumed task role.');
  return { accountId: account, principalType: 'assumed-role', roleName: assumedRole[1] };
}

/** Thin AgentCore control/data-plane adapter. It never uses the SDK's default credential chain. */
export class IntercomProfileProvider {
  private readonly region: string;
  private readonly defaultBrowserIdentifier: string;
  private readonly credentialsOf: () => Promise<AwsCredentials | null>;
  private readonly fetcher: typeof fetch;
  private readonly controlClient: (region: string, credentials: AwsCredentials) => CreateClient;
  private readonly makeCreateCommand: (input: { name: string; clientToken: string }) => unknown;
  private readonly makeBrowser: (input: { region: string; identifier: string; credentials: AwsCredentials }) => BrowserForSigning;
  private readonly now: () => Date;

  constructor(config: IntercomProfileProviderConfig, deps: IntercomProfileProviderDeps = {}) {
    this.region = checkedRegion(config.region);
    this.defaultBrowserIdentifier = checkedBrowserId(config.browserIdentifier);
    this.credentialsOf = deps.resolveCredentials ?? resolveAwsCredentials;
    this.fetcher = deps.fetch ?? fetch;
    this.controlClient = deps.createControlClient ?? ((region, credentials) => new BedrockAgentCoreControlClient({
      region, maxAttempts: 1, credentials: async () => credentials,
    }) as unknown as CreateClient);
    this.makeCreateCommand = deps.createProfileCommand ?? ((input) => new CreateBrowserProfileCommand(input));
    this.makeBrowser = deps.createBrowser ?? ((input) => new Browser({
      region: input.region, identifier: input.identifier, credentialsProvider: async () => input.credentials,
    }));
    this.now = deps.now ?? (() => new Date());
  }

  async createProfile(input: ProfileCreateInput): Promise<ProfileCreateResult> {
    if (!/^[A-Za-z][A-Za-z0-9 _.-]{0,47}$/.test(input.name) || !/^[A-Za-z0-9_-]{16,128}$/.test(input.clientToken) || !/^[a-f0-9]{64}$/i.test(input.ownerSubjectHash)) {
      return fail('profile_input_invalid', 'The browser profile request is invalid.');
    }
    const credentials = await this.credentialsOf();
    if (!credentials) return fail('credentials_unavailable', 'Browser provider credentials are unavailable.');
    const roleReceipt = await verifyPrincipal(this.region, credentials, this.fetcher, this.now());
    let response: unknown;
    try {
      response = await this.controlClient(this.region, credentials).send(
        this.makeCreateCommand({ name: input.name, clientToken: input.clientToken }),
        { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
    } catch { return fail('profile_create_failed', 'The browser profile could not be created.'); }
    const value = response as CreateBrowserProfileCommandOutput | null;
    const providerProfileId = value?.profileId;
    if (typeof providerProfileId !== 'string' || !PROFILE_ID.test(providerProfileId)) return fail('profile_create_invalid', 'The browser provider returned an invalid profile identifier.');
    return { providerProfileId, status: 'created', roleReceipt };
  }

  async generateLiveViewUrl(input: LiveViewInput): Promise<{ url: string; expiresIn: number }> {
    const browserIdentifier = checkedBrowserId(input.browserIdentifier);
    const sessionId = checkedSessionId(input.sessionId);
    const expiresIn = input.expiresIn ?? MAX_LIVE_VIEW_SECONDS;
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_LIVE_VIEW_SECONDS) return fail('live_view_expiry_invalid', 'The browser live-view expiry is invalid.');
    if (browserIdentifier !== this.defaultBrowserIdentifier) return fail('browser_identifier_forbidden', 'The browser session is unavailable.');
    const credentials = await this.credentialsOf();
    if (!credentials) return fail('credentials_unavailable', 'Browser provider credentials are unavailable.');
    try {
      const browser = this.makeBrowser({ region: this.region, identifier: browserIdentifier, credentials });
      browser.attachSession(sessionId);
      const url = await browser.generateLiveViewUrl(expiresIn);
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== `bedrock-agentcore.${this.region}.amazonaws.com` || parsed.pathname !== `/browser-streams/${encodeURIComponent(browserIdentifier)}/sessions/${encodeURIComponent(sessionId)}/live-view`) {
        return fail('live_view_url_invalid', 'The browser provider returned an invalid live-view URL.');
      }
      return { url, expiresIn };
    } catch (error) {
      if (error instanceof IntercomProfileProviderError) throw error;
      return fail('live_view_unavailable', 'The browser live-view could not be created.');
    }
  }

  static newClientToken(): string { return randomUUID(); }
}
