import { connectFramerProject, type FramerProjectAdapter, type FramerSdkClient } from "../tools/framer/client.js";

/**
 * Trusted runtime entry point. Reads the API key only from the process environment;
 * it has no model-visible secret lookup, configuration, or echo operation.
 */
export async function connectConfiguredFramerProject(env: NodeJS.ProcessEnv = process.env): Promise<FramerProjectAdapter> {
  const projectUrl = env.FRAMER_PROJECT_URL;
  const apiKey = env.FRAMER_API_KEY;
  if (!projectUrl || !apiKey) {
    throw new Error("Framer project runtime is not configured.");
  }

  const packageName = "framer-api";
  let sdkModule: { connect?: (projectUrl: string, apiKey: string) => Promise<FramerSdkClient> };
  try {
    sdkModule = await import(packageName) as typeof sdkModule;
  } catch {
    throw new Error("Framer Server API client is unavailable.");
  }
  if (typeof sdkModule.connect !== "function") throw new Error("Framer Server API client is unavailable.");

  return connectFramerProject({ projectUrl, apiKey, connect: sdkModule.connect });
}
