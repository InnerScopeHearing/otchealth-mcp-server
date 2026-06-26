import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { allTools } from '../catalog/catalog.js';

const SERVICE_NAME = 'otchealth-mcp-server';

export interface VersionPayload {
  service: string;
  version: string;
  gitTag: string;
  toolCount: number;
  uptimeSeconds: number;
}

interface VersionPayloadInput {
  gitSha?: string;
  revisionStamp?: string;
  toolCount?: number;
  uptimeSeconds?: number;
  version?: string;
}

function loadPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

const packageVersion = loadPackageVersion();

export function buildVersionPayload(input: VersionPayloadInput = {}): VersionPayload {
  return {
    service: SERVICE_NAME,
    version: input.version ?? packageVersion,
    gitTag: input.revisionStamp || input.gitSha || 'unknown',
    toolCount: input.toolCount ?? 0,
    uptimeSeconds: input.uptimeSeconds ?? 0,
  };
}

export function registerVersion(app: FastifyInstance): void {
  app.get('/version', async () =>
    buildVersionPayload({
      revisionStamp: process.env.REVISION_STAMP,
      gitSha: process.env.GIT_SHA,
      toolCount: allTools().length,
      uptimeSeconds: Math.floor(process.uptime()),
    }),
  );
}
