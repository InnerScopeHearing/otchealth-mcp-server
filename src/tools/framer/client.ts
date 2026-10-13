/**
 * Narrow adapter over Framer's official Server API. This first version exposes
 * only project identity and documented read-method permission checks. Mutating
 * canvas, CMS, code, preview, and deploy operations are intentionally absent
 * until their exact method shapes and target safety are wired and reviewed.
 */

export const ENLIGHTENED_LILY_PROJECT_URL = "https://framer.com/projects/Enlightened-Lily--bdTiiIITB77TCuMA3XFs-9ssTK";
// The owner URL includes a trailing share suffix. framer-api@5.1.0's published
// project-ID parser captures the alphanumeric run after `--` and validates 20
// characters (see /workspace/browser-completion-2026-10-13-1647/framer/sdk-research.md).
export const ENLIGHTENED_LILY_PROJECT_ID = "bdTiiIITB77TCuMA3XFs";
/** `isAllowedTo` availability checks only; these are not a list of all SDK features. */
export const FRAMER_READ_METHODS = ["getProjectInfo", "getChangedPaths"] as const;
export type FramerReadMethod = (typeof FRAMER_READ_METHODS)[number];

export interface FramerProjectInfo {
  id: string;
  name: string;
}

export interface FramerSdkClient {
  getProjectInfo(): Promise<unknown>;
  getChangedPaths(): Promise<unknown>;
  isAllowedTo(method: FramerReadMethod): boolean;
  disconnect(): Promise<void>;
}

export type FramerSdkConnect = (projectUrl: string, apiKey: string) => Promise<FramerSdkClient>;

export interface FramerProjectAdapter {
  getProjectInfo(): Promise<FramerProjectInfo>;
  /** Reports only these two read-method permissions; it does not imply write/publish readiness. */
  getCapabilities(): Promise<{ project: FramerProjectInfo; methods: Record<FramerReadMethod, boolean> }>;
  close(): Promise<void>;
}

export class FramerAdapterError extends Error {
  constructor(readonly code: "invalid_configuration" | "connection_failed" | "project_mismatch" | "read_failed" | "close_failed", message: string) {
    super(message);
    this.name = "FramerAdapterError";
  }
}

function projectIdFromUrl(projectUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(projectUrl);
  } catch {
    throw new FramerAdapterError("invalid_configuration", "Framer project URL is invalid.");
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "framer.com" || parsed.username || parsed.password || parsed.port) {
    throw new FramerAdapterError("invalid_configuration", "Framer project URL must be an HTTPS framer.com project URL.");
  }
  if (parsed.search || parsed.hash) throw new FramerAdapterError("invalid_configuration", "Framer project URL must not include query or fragment data.");
  const approvedPath = new URL(ENLIGHTENED_LILY_PROJECT_URL).pathname;
  if (parsed.pathname !== approvedPath) throw new FramerAdapterError("invalid_configuration", "Configured Framer project does not match the approved project URL.");
  const match = /^.+--([A-Za-z0-9]+)/.exec(parsed.pathname.slice("/projects/".length));
  if (!match?.[1] || match[1].length !== 20) throw new FramerAdapterError("invalid_configuration", "Framer project URL has an invalid project ID.");
  return match[1];
}

function parseProjectInfo(value: unknown): FramerProjectInfo {
  if (!value || typeof value !== "object") throw new FramerAdapterError("read_failed", "Framer returned invalid project metadata.");
  const info = value as Record<string, unknown>;
  if (typeof info.id !== "string" || typeof info.name !== "string") {
    throw new FramerAdapterError("read_failed", "Framer returned incomplete project metadata.");
  }
  return { id: info.id, name: info.name };
}

/** Creates a project-bound client. The caller owns lifecycle and must call close(). */
export async function connectFramerProject(input: {
  projectUrl: string;
  apiKey: string;
  connect: FramerSdkConnect;
}): Promise<FramerProjectAdapter> {
  const urlProjectId = projectIdFromUrl(input.projectUrl);
  if (!input.apiKey.trim()) throw new FramerAdapterError("invalid_configuration", "Framer API key is not configured.");
  if (urlProjectId !== ENLIGHTENED_LILY_PROJECT_ID) throw new FramerAdapterError("invalid_configuration", "Configured Framer project does not match the approved project.");

  let sdk: FramerSdkClient;
  try {
    sdk = await input.connect(input.projectUrl, input.apiKey);
  } catch {
    // SDK errors may contain URLs or request details. Never return them to a caller.
    throw new FramerAdapterError("connection_failed", "Framer project connection failed.");
  }

  let cachedInfo: FramerProjectInfo;
  let closed = false;
  const projectInfo = async (): Promise<FramerProjectInfo> => {
    if (closed) throw new FramerAdapterError("read_failed", "Framer project connection is closed.");
    return cachedInfo;
  };

  try {
    cachedInfo = parseProjectInfo(await sdk.getProjectInfo());
    if (cachedInfo.id !== ENLIGHTENED_LILY_PROJECT_ID) throw new FramerAdapterError("project_mismatch", "Connected Framer project does not match the approved project.");
  } catch (error) {
    await sdk.disconnect().catch(() => undefined);
    if (error instanceof FramerAdapterError) throw error;
    throw new FramerAdapterError("read_failed", "Framer project metadata could not be read.");
  }

  return {
    getProjectInfo: projectInfo,
    async getCapabilities() {
      const project = await projectInfo();
      try {
        return {
          project,
          methods: {
            getProjectInfo: sdk.isAllowedTo("getProjectInfo"),
            getChangedPaths: sdk.isAllowedTo("getChangedPaths"),
          },
        };
      } catch {
        throw new FramerAdapterError("read_failed", "Framer read capabilities could not be checked.");
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await sdk.disconnect();
      } catch {
        throw new FramerAdapterError("close_failed", "Framer project connection could not be closed cleanly.");
      }
    },
  };
}
