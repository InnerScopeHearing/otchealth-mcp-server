import { CloudBrowserService, DynamoCloudBrowserSessionStore, AgentCoreCloudBrowserTransport } from '../tools/browser-cloud/index.js';
import { CloudBrowserJobs } from '../tools/browser-cloud-jobs/contracts.js';
import { createDynamoBrowserJobStore, createS3BrowserArtifactStore, createSqsBrowserQueue } from '../tools/browser-cloud-jobs/aws-adapters.js';
import { cloudBrowserRuntimeStatus, startCloudBrowserWorker, type CloudBrowserGatewayRuntime } from '../tools/browser-cloud-gateway/index.js';

let instance: CloudBrowserGatewayRuntime | undefined;
function configured(): CloudBrowserGatewayRuntime {
  if (!cloudBrowserRuntimeStatus().enabled) throw new Error('cloud_browser_not_configured');
  if (!instance) {
    const config = { region: process.env.AWS_REGION || 'us-east-1', table: process.env.CLOUD_BROWSER_DDB_TABLE,
      bucket: process.env.CLOUD_BROWSER_ARTIFACT_BUCKET, queueUrl: process.env.CLOUD_BROWSER_QUEUE_URL };
    const queue = createSqsBrowserQueue(config);
    const artifacts = createS3BrowserArtifactStore(config);
    instance = { browser: new CloudBrowserService(new DynamoCloudBrowserSessionStore(config.table, config.region), new AgentCoreCloudBrowserTransport(config.region)),
      jobs: new CloudBrowserJobs(createDynamoBrowserJobStore(config), queue, artifacts), queue, artifacts };
  }
  return instance!;
}

// Lazy properties let disabled tools explain configuration gaps without making AWS calls at registration.
export const cloudBrowserRuntime: CloudBrowserGatewayRuntime = {
  get browser() { return configured().browser; }, get jobs() { return configured().jobs; }, get queue() { return configured().queue; }, get artifacts() { return configured().artifacts; },
};

/** Runs in the existing ECS gateway, never on the user's desktop. Durable claims fence replicas. */
export function runCloudBrowserPolling(): () => void {
  if (process.env.CLOUD_BROWSER_WORKER_ENABLED !== 'true' || !cloudBrowserRuntimeStatus().enabled) return () => undefined;
  const worker = startCloudBrowserWorker(cloudBrowserRuntime);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = async (): Promise<void> => {
    try { if (!stopped && worker) await worker.pollOnce(1); }
    catch { console.warn('[cloud-browser] bounded worker poll failed; durable queue retained'); }
    finally { if (!stopped) { timer = setTimeout(() => { void poll(); }, 20_000); timer.unref(); } }
  };
  void poll();
  return () => { stopped = true; if (timer) clearTimeout(timer); };
}
