import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { connectConfiguredFramerProject } from "../../server/framer-runtime.js";
import { FramerAdapterError, type FramerProjectAdapter } from "./client.js";
import { registerTool, type CallerHashProvider, type ToolContext, type ToolResultPayload } from "../registry.js";

export const FRAMER_PROJECT_INSPECT_TOOL = "framer_project_inspect";
export type FramerRuntimeFactory = () => Promise<FramerProjectAdapter>;

/** Callable independently in tests so the in-handler identity check is exercised directly. */
export async function inspectFramerProject(
  callerAgent: string,
  runtimeFactory: FramerRuntimeFactory = connectConfiguredFramerProject,
): Promise<ToolResultPayload> {
  if (callerAgent !== "cto" && callerAgent !== "developer") {
    throw new FramerAdapterError("forbidden_role", "Framer project inspection is restricted to the CTO and Developer lanes.");
  }

  let adapter: FramerProjectAdapter | undefined;
  try {
    adapter = await runtimeFactory();
    const data = await adapter.getCapabilities();
    await adapter.close();
    return { data, summary: `Connected to Framer project ${data.project.name} (${data.project.id}); read-only inspection is available.` };
  } catch (error) {
    if (adapter) await adapter.close().catch(() => undefined);
    if (error instanceof FramerAdapterError) throw error;
    // Do not surface SDK/runtime messages, which can contain request and connection details.
    throw new FramerAdapterError("connection_failed", "Framer project inspection failed.");
  }
}

export function registerFramerProjectInspect(
  server: McpServer,
  callerHash: CallerHashProvider,
  runtimeFactory: FramerRuntimeFactory = connectConfiguredFramerProject,
): void {
  registerTool(server, {
    name: FRAMER_PROJECT_INSPECT_TOOL,
    category: "read",
    annotations: {
      title: "Inspect Enlightened Lily Framer project",
      description: "Read the approved Framer project's identity and this adapter's implemented read/write method surface. No content is changed or published.",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputShape: {},
    outputShape: {
      project: z.object({ id: z.string(), name: z.string() }),
      readMethods: z.array(z.string()),
      writeMethods: z.array(z.string()),
    },
    handler: async (_input, ctx: ToolContext) => inspectFramerProject(ctx.callerAgent, runtimeFactory),
  }, callerHash);
}
