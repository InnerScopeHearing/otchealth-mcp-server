import { createHash } from 'node:crypto';

export type CallerSurfaceTool = {
  name: string;
  [key: string]: unknown;
};

export function lazyCallerSurfaceEntry(factory: () => CallerSurfaceTool): () => CallerSurfaceTool {
  let value: CallerSurfaceTool | undefined;
  return () => {
    value ??= factory();
    return value;
  };
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, sortObjectKeys(object[key])]),
  );
}

/** Fingerprints a caller's finalized tools/list entries. Arrays keep their protocol order. */
export function callerSurfaceFingerprint(tools: readonly CallerSurfaceTool[]): string {
  const canonical = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tool) => sortObjectKeys(tool));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
