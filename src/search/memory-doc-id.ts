/** Stable key shared by search backends and historical repair. Preserve semantic.mjs compatibility. */
export function memoryDocId(agent: string, id: string): string {
  return `${agent}__${id}`.replace(/[^A-Za-z0-9_\-=]/g, '_');
}
