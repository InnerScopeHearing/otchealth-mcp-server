import type { DaytonaApiBrowserProviderOptions } from '../tools/browser-daytona/client.js';
import type { BrowserFileStore } from '../tools/browser-cloud/file-broker.js';
import type { CloudBrowserStore } from '../tools/browser-cloud/contract.js';
import { createAwsBrowserFileStore, type AwsBrowserFileStoreConfig } from '../tools/browser-cloud/aws-file-store.js';
import { DynamoCloudBrowserSessionStore } from '../tools/browser-cloud/dynamo-store.js';
import { createConfiguredBrowserFileBroker } from './cloud-browser-runtime.js';

export interface DaytonaArtifactPortsDependencies {
  env?: NodeJS.ProcessEnv;
  /** Trusted test/boot seams only. No caller credentials, paths or store choices. */
  createFileStore?: (config: AwsBrowserFileStoreConfig) => BrowserFileStore;
  createCaptureStore?: (table: string, region: string) => Pick<CloudBrowserStore, 'createCapture'>;
}

/** Reuses the existing file-stage/artifact-get namespace and validation chain.
 * Construction is effect-free; concrete stores are created lazily at first use.
 * No guessed account bucket/table, no unscanned Daytona upload fallback.
 */
export function createConfiguredDaytonaArtifactPorts(dependencies: DaytonaArtifactPortsDependencies = {}): Pick<DaytonaApiBrowserProviderOptions, 'files' | 'captures'> {
  const env = dependencies.env ?? process.env, table = env.CLOUD_BROWSER_DDB_TABLE, bucket = env.CLOUD_BROWSER_ARTIFACT_BUCKET, region = env.AWS_REGION ?? 'us-east-1';
  if (env.CLOUD_BROWSER_ENABLED !== 'true' || !table || !/^[a-z0-9_-]{3,255}$/.test(table) || !bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || !/^[a-z]{2}-[a-z]+-\d$/.test(region) || !env.CLOUD_BROWSER_QUEUE_URL?.startsWith(`https://sqs.${region}.amazonaws.com/`)) return {};
  let captureStore: Pick<CloudBrowserStore, 'createCapture'> | undefined;
  const captures = { createCapture: (...args: Parameters<CloudBrowserStore['createCapture']>) => {
    captureStore ??= dependencies.createCaptureStore?.(table, region) ?? new DynamoCloudBrowserSessionStore(table, region);
    return captureStore.createCapture(...args);
  } };
  const host = env.BROWSER_FILE_CLAMAV_HOST, port = Number(env.BROWSER_FILE_CLAMAV_PORT ?? 3310), timeout = Number(env.BROWSER_FILE_CLAMAV_TIMEOUT_MS ?? 20000);
  const scannerConfigured = typeof host === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(host) && port === 3310
    && Number.isInteger(timeout) && timeout >= 50 && timeout <= 20000
    && (env.BROWSER_FILE_CLAMAV_ALLOW_LOOPBACK === undefined || ['true', 'false'].includes(env.BROWSER_FILE_CLAMAV_ALLOW_LOOPBACK));
  if (!scannerConfigured) return { captures };
  let broker: ReturnType<typeof createConfiguredBrowserFileBroker> | undefined;
  const files = { forUpload: (...args: Parameters<NonNullable<DaytonaApiBrowserProviderOptions['files']>['forUpload']>) => {
    broker ??= createConfiguredBrowserFileBroker((dependencies.createFileStore ?? createAwsBrowserFileStore)({ table, bucket, region }), env);
    return broker.forUpload(...args);
  } };
  return { files, captures };
}
