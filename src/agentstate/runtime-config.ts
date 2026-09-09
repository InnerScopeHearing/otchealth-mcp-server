/**
 * Configuration required by the agent-state data plane.
 *
 * Scheduled maintenance tasks use this module instead of the gateway-wide schema.  They must be
 * able to read the durable checkpoint with only the state-plane references, rather than being
 * forced to receive unrelated integration credentials.
 */
export type AgentStateBackend = 'cosmos' | 'postgres';

export type AgentStatePostgresConfig = Readonly<{
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  sslVerify: boolean;
}>;

function configError(): never {
  throw new Error('agentstate_runtime_config_invalid');
}

export function loadAgentStateBackend(): AgentStateBackend {
  const backend = process.env.STATE_BACKEND ?? 'postgres';
  if (backend !== 'cosmos' && backend !== 'postgres') configError();
  return backend;
}

export function loadAgentStatePostgresConfig(): AgentStatePostgresConfig {
  const rawPort = process.env.PG_PORT ?? '5432';
  if (!/^\d+$/.test(rawPort)) configError();
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) configError();
  const rawVerify = process.env.PG_SSL_VERIFY ?? 'true';
  if (rawVerify !== 'true' && rawVerify !== 'false') configError();
  return {
    host: process.env.PG_HOST ?? '',
    port,
    database: process.env.PG_DATABASE ?? 'agentstate',
    user: process.env.PG_USER ?? '',
    password: process.env.PG_PASSWORD ?? '',
    sslVerify: rawVerify === 'true',
  };
}
