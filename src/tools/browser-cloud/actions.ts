import { z } from "zod";
import { CLOUD_BROWSER_KEYS, CloudBrowserError, type CloudBrowserAction } from "./contract.js";
import type { BrowserPageAction } from "./page-controls.js";

const coordinate = z.number().finite().min(0).max(10_000);
const selector = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\r\n]/.test(value));
export const cloudBrowserActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("navigate"), url: z.string().url().max(2048) }).strict(),
  z.object({ type: z.literal("snapshot") }).strict(),
  z.object({ type: z.literal("capture"), request: z.discriminatedUnion("type", [
    z.object({ type: z.literal("screenshot"), format: z.enum(["png", "jpeg"]).optional() }).strict(),
    z.object({ type: z.literal("pdf"), landscape: z.boolean().optional(), printBackground: z.boolean().optional() }).strict(),
  ]) }).strict(),
  z.object({ type: z.literal("click"), selector, button: z.enum(["left", "right"]).optional(), clickCount: z.union([z.literal(1), z.literal(2)]).optional() }).strict(),
  z
    .object({
      type: z.literal("type"),
      selector,
      text: z
        .string()
        .min(1)
        .max(1024)
        .refine((value) => !/[\u0000-\u001f]/.test(value)),
    })
    .strict(),
  z.object({ type: z.literal("wait_for"), selector }).strict(),
  z.object({ type: z.literal("press_key"), key: z.enum(CLOUD_BROWSER_KEYS), modifiers: z.number().int().min(0).max(15).optional() }).strict(),
  z.object({ type: z.literal("scroll"), x: coordinate, y: coordinate, deltaX: z.number().finite().min(-10_000).max(10_000), deltaY: z.number().finite().min(-10_000).max(10_000) }).strict(),
  z.object({ type: z.literal("mouse_move"), x: coordinate, y: coordinate }).strict(),
  z.object({ type: z.literal("drag"), fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate, steps: z.number().int().min(1).max(20).optional() }).strict(),
  z
    .object({
      type: z.literal("tab_create"),
      url: z
        .string()
        .url()
        .max(2048)
        .regex(/^https?:\/\//i),
    })
    .strict(),
  z
    .object({
      type: z.literal("tab_select"),
      targetId: z
        .string()
        .min(1)
        .max(256)
        .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    })
    .strict(),
  z
    .object({
      type: z.literal("tab_close"),
      targetId: z
        .string()
        .min(1)
        .max(256)
        .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    })
    .strict(),
  z.object({ type: z.literal("navigate_back") }).strict(),
  z.object({ type: z.literal("navigate_forward") }).strict(),
  z.object({ type: z.literal("reload") }).strict(),
  z.object({ type: z.literal("focus"), selector }).strict(),
  z
    .object({
      type: z.literal("select"),
      selector,
      value: z
        .string()
        .max(1024)
        .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    })
    .strict(),
  z
    .object({
      type: z.literal("dialog"),
      accept: z.boolean(),
      promptText: z
        .string()
        .max(1024)
        .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
        .optional(),
    })
    .strict(),
]);

export function validateCloudBrowserAction(value: unknown): CloudBrowserAction {
  const parsed = cloudBrowserActionSchema.safeParse(value);
  if (!parsed.success) throw new CloudBrowserError("invalid_action", "Browser action is invalid or exceeds its typed bounds.");
  return parsed.data;
}

export type { BrowserPageAction };

export interface CloudBrowserCdp {
  command(method: string, params: Record<string, unknown>, timeout: number, page?: string): Promise<Record<string, unknown>>;
}

const keyCodes: Record<(typeof CLOUD_BROWSER_KEYS)[number], number> = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  Space: 32,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  KeyA: 65,
  KeyC: 67,
  KeyV: 86,
  KeyP: 80,
  KeyS: 83,
  KeyF: 70,
  KeyZ: 90,
  F5: 116,
};

/** Only typed protocol operations; callers cannot supply arbitrary CDP methods or script. */
export async function executeCloudBrowserInteraction(cdp: CloudBrowserCdp, page: string, input: CloudBrowserAction, remaining: () => number): Promise<void> {
  const action = validateCloudBrowserAction(input);
  const command = (method: string, params: Record<string, unknown>) => cdp.command(method, params, remaining(), page);
  const cleanupCommand = (method: string, params: Record<string, unknown>) => {
    let timeout = 1;
    try {
      timeout = Math.min(1000, Math.max(1, remaining()));
    } catch {
      /* one bounded cleanup attempt even at an expired deadline */
    }
    return cdp.command(method, params, timeout, page);
  };
  const withCleanup = async <T>(operation: () => Promise<T>, cleanup: () => Promise<unknown>): Promise<T> => {
    let failed = false;
    try {
      return await operation();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await cleanup();
      } catch (error) {
        if (!failed) throw error;
      }
    }
  };
  if (action.type === "press_key") {
    const modifiers = action.modifiers ?? 0;
    const letter = action.key.startsWith("Key") ? action.key.slice(3) : undefined;
    const key = action.key === "Space" ? " " : letter ? (modifiers & 8 ? letter : letter.toLowerCase()) : action.key;
    const text = modifiers & 7 ? undefined : action.key === "Enter" ? "\r" : action.key === "Space" || letter ? key : undefined;
    const params = { key, code: action.key, windowsVirtualKeyCode: keyCodes[action.key], modifiers };
    await withCleanup(
      () => command("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...(text === undefined ? {} : { text }) }),
      () => cleanupCommand("Input.dispatchKeyEvent", { type: "keyUp", ...params }),
    );
    return;
  }
  if (action.type === "scroll") {
    await command("Input.dispatchMouseEvent", { type: "mouseWheel", x: action.x, y: action.y, deltaX: action.deltaX, deltaY: action.deltaY });
    return;
  }
  if (action.type === "mouse_move") {
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: action.x, y: action.y });
    return;
  }
  if (action.type === "drag") {
    let x = action.fromX;
    let y = action.fromY;
    await command("Input.dispatchMouseEvent", { type: "mouseMoved", x: action.fromX, y: action.fromY });
    await withCleanup(
      async () => {
        await command("Input.dispatchMouseEvent", { type: "mousePressed", x: action.fromX, y: action.fromY, button: "left", clickCount: 1 });
        const steps = action.steps ?? 5;
        for (let step = 1; step <= steps; step++) {
          x = action.fromX + ((action.toX - action.fromX) * step) / steps;
          y = action.fromY + ((action.toY - action.fromY) * step) / steps;
          await command("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 1 });
        }
      },
      () => cleanupCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }),
    );
    return;
  }
  if (action.type !== "click" && action.type !== "type" && action.type !== "wait_for") throw new CloudBrowserError("invalid_action", "This operation is handled by browser navigation or observation.");
  await command("DOM.enable", {});
  await command("DOM.getDocument", { depth: 0 });
  const search = await command("DOM.performSearch", { query: action.selector });
  const count = typeof search.resultCount === "number" ? search.resultCount : 0;
  const searchId = typeof search.searchId === "string" ? search.searchId : "";
  if (!searchId) throw new CloudBrowserError("selector_not_found", "The browser action selector did not match a page element.");
  const matches = await withCleanup(
    async () => {
      if (count < 1) throw new CloudBrowserError("selector_not_found", "The browser action selector did not match a page element.");
      return command("DOM.getSearchResults", { searchId, fromIndex: 0, toIndex: 1 });
    },
    () => cleanupCommand("DOM.discardSearchResults", { searchId }),
  );
  const nodeId = (matches.nodeIds as unknown[] | undefined)?.[0];
  if (typeof nodeId !== "number") throw new CloudBrowserError("selector_not_found", "The browser selector did not resolve to an element.");
  if (action.type === "wait_for") return;
  if (action.type === "type") {
    await command("DOM.focus", { nodeId });
    await command("Input.insertText", { text: action.text });
    return;
  }
  const box = await command("DOM.getBoxModel", { nodeId });
  const quad = (box.model as { content?: unknown[] } | undefined)?.content;
  if (!Array.isArray(quad) || quad.length !== 8 || !quad.every((value) => typeof value === "number" && Number.isFinite(value))) throw new CloudBrowserError("selector_not_interactable", "The selected element is not interactable.");
  const q = quad as number[];
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  const button = action.button ?? "left";
  const clickCount = action.clickCount ?? 1;
  for (let count = 1; count <= clickCount; count++)
    await withCleanup(
      () => command("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: count }),
      () => cleanupCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: count }),
    );
}
