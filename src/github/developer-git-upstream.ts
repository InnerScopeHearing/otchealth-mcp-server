import { request } from 'undici';
import type { Readable } from 'node:stream';
import { DEVELOPER_GIT_REPOSITORIES } from './developer-git-policy.js';

export interface DeveloperGitUpstreamRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Readonly<Record<string, string>>;
  body?: Readable;
  signal: AbortSignal;
}

export interface DeveloperGitUpstreamResponse {
  statusCode: number;
  contentType?: string;
  body: Readable;
}

/**
 * The GitHub App token remains in the gateway process. The caller can never choose an
 * origin, supply upstream authorization or invoke receive-pack through this adapter.
 */
export function createDeveloperGitUpstream(getToken: () => Promise<string>) {
  return async (input: DeveloperGitUpstreamRequest): Promise<DeveloperGitUpstreamResponse> => {
    const allowed = [...DEVELOPER_GIT_REPOSITORIES].some((repo) => {
      const base = `https://github.com/InnerScopeHearing/${repo}.git/`;
      return (input.method === 'GET' && input.url === `${base}info/refs?service=git-upload-pack`) ||
        (input.method === 'POST' && input.url === `${base}git-upload-pack`);
    });
    if (!allowed || (input.method === 'GET' && input.body !== undefined) ||
        (input.method === 'POST' && input.body === undefined) ||
        (input.headers['git-protocol'] !== undefined && input.headers['git-protocol'] !== 'version=2')) {
      throw new Error('Invalid Developer Git upstream request');
    }
    if (input.signal.aborted) throw new Error('Developer Git request aborted');
    const token = await getToken();
    if (input.signal.aborted) throw new Error('Developer Git request aborted');
    const headers: Record<string, string> = {
      authorization: 'Basic ' + Buffer.from('x-access-token:' + token, 'utf8').toString('base64'),
      'user-agent': 'otchealth-developer-git-read',
      accept: input.method === 'GET' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-upload-pack-result',
    };
    if (input.method === 'POST') headers['content-type'] = 'application/x-git-upload-pack-request';
    if (input.headers['git-protocol']) headers['git-protocol'] = input.headers['git-protocol'];
    const res = await request(input.url, {
      method: input.method,
      headers,
      body: input.body,
      signal: input.signal,
      headersTimeout: 30000,
      bodyTimeout: 30000,
    });
    const type = res.headers['content-type'];
    return { statusCode: res.statusCode, contentType: typeof type === 'string' ? type : undefined, body: res.body };
  };
}
