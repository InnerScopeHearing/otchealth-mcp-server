const PROJECT_KEY_ENV_PREFIX = 'REVENUECAT_PROJECT_KEY_';
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PROJECT_KEY_ENV_PATTERN = /^REVENUECAT_PROJECT_KEY_[A-Z0-9_]+$/;
const SECRET_KEY_PATTERN = /^sk_[A-Za-z0-9_-]{8,}$/;

export type RevenueCatCredentialErrorCode =
  | 'revenuecat_project_key_mapping_invalid'
  | 'revenuecat_project_key_missing'
  | 'revenuecat_project_key_invalid'
  | 'revenuecat_not_configured';

export class RevenueCatCredentialError extends Error {
  readonly code: RevenueCatCredentialErrorCode;

  constructor(code: RevenueCatCredentialErrorCode, message: string) {
    super(message);
    this.name = 'RevenueCatCredentialError';
    this.code = code;
  }
}

type ProjectKeyEnvMap = Record<string, string>;

function parseProjectKeyEnvMap(raw: string | undefined): ProjectKeyEnvMap {
  if (raw === undefined || raw === '') return Object.create(null) as ProjectKeyEnvMap;
  if (raw.length > 32_768) {
    throw new RevenueCatCredentialError('revenuecat_project_key_mapping_invalid', 'RevenueCat project key mapping is invalid.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RevenueCatCredentialError('revenuecat_project_key_mapping_invalid', 'RevenueCat project key mapping is invalid.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RevenueCatCredentialError('revenuecat_project_key_mapping_invalid', 'RevenueCat project key mapping is invalid.');
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 1_000) {
    throw new RevenueCatCredentialError('revenuecat_project_key_mapping_invalid', 'RevenueCat project key mapping is invalid.');
  }
  const mapping: ProjectKeyEnvMap = Object.create(null) as ProjectKeyEnvMap;
  for (const [projectId, envName] of entries) {
    if (!PROJECT_ID_PATTERN.test(projectId) || typeof envName !== 'string' || !PROJECT_KEY_ENV_PATTERN.test(envName)) {
      throw new RevenueCatCredentialError('revenuecat_project_key_mapping_invalid', 'RevenueCat project key mapping is invalid.');
    }
    mapping[projectId] = envName;
  }
  return mapping;
}

function isSecretKey(value: string | undefined): value is string {
  return typeof value === 'string' && SECRET_KEY_PATTERN.test(value);
}

/** Resolves only a key value already present in the process environment. Never fetches or logs secrets. */
export function resolveRevenueCatApiKey(projectId?: string): string {
  const mapping = parseProjectKeyEnvMap(process.env.REVENUECAT_PROJECT_KEY_ENV_JSON);

  if (projectId !== undefined) {
    if (typeof projectId !== 'string' || !PROJECT_ID_PATTERN.test(projectId)) {
      throw new RevenueCatCredentialError('revenuecat_project_key_mapping_invalid', 'RevenueCat project identifier is invalid.');
    }
    if (Object.hasOwn(mapping, projectId)) {
      const envName = mapping[projectId]!;
      const projectKey = process.env[envName];
      if (!projectKey) {
        throw new RevenueCatCredentialError('revenuecat_project_key_missing', 'The configured RevenueCat project key is unavailable.');
      }
      if (!isSecretKey(projectKey)) {
        throw new RevenueCatCredentialError('revenuecat_project_key_invalid', 'The configured RevenueCat project key is invalid.');
      }
      return projectKey;
    }
  }

  const globalKey = process.env.REVENUECAT_API_KEY;
  if (!globalKey) {
    throw new RevenueCatCredentialError('revenuecat_not_configured', 'REVENUECAT_API_KEY is not configured.');
  }
  return globalKey;
}

/** True only when a valid project mapping names a present, syntactically valid secret key. */
export function hasRevenueCatProjectCredential(projectId: string): boolean {
  try {
    const mapping = parseProjectKeyEnvMap(process.env.REVENUECAT_PROJECT_KEY_ENV_JSON);
    if (!PROJECT_ID_PATTERN.test(projectId) || !Object.hasOwn(mapping, projectId)) return false;
    return isSecretKey(process.env[mapping[projectId]!]);
  } catch {
    return false;
  }
}

// Keep the prefix named here to make the accepted mapping namespace explicit and testable.
export const revenueCatProjectKeyEnvPrefix = PROJECT_KEY_ENV_PREFIX;
