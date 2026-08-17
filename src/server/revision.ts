/**
 * WHICH IMAGE IS SERVING THIS CALL? — a runtime revision discriminator.
 *
 * WHY THIS EXISTS (2026-08-17, CFO escalation). Two full cycles were spent on a dispute where the
 * CTO's verification passed and the CFO's identical-looking test failed, and NEITHER SIDE COULD
 * PROVE THEY WERE TALKING TO THE SAME BUILD. The only version-shaped field on the connector surface
 * was `catalog_probe`'s `build_tag`, a HAND-EDITED constant ("catalog-probe-2026-07-26.1") that does
 * not move when a deploy happens, and `tool_registry_count`, which does not move for a bug fix.
 * Neither is a revision discriminator. The CFO said so explicitly rather than mistaking one for a
 * proof, which was correct, and then asked for a real one. This is it.
 *
 * DERIVED AT RUNTIME, NEVER HAND-MAINTAINED. That is the whole point: a constant someone must
 * remember to bump is exactly the artifact that produced the ambiguity. Everything here comes from
 * the container's own metadata, so it cannot drift from reality:
 *
 *   ECS_CONTAINER_METADATA_URI_V4  the task metadata endpoint AWS injects into every ECS task. It
 *                                  reports the actual Image (with tag), the immutable ImageID
 *                                  digest, and the task-definition family + revision.
 *   process start time             distinguishes two tasks running the SAME image, which is what a
 *                                  force-new-deployment produces, and dates the rollout.
 *
 * FAIL-OPEN AND CACHED. A metadata lookup that fails must never break a health check or a tool call,
 * so every field degrades to null and the result is cached after the first success. Outside ECS
 * (local dev, tests) the endpoint is simply absent and the fields are null, which is honest rather
 * than fabricated.
 *
 * NOT SENSITIVE. An image tag, a digest and a task-definition revision are deployment facts, not
 * credentials, and they are already visible to anyone who can read the ECS console. Exposing them on
 * the connector surface is what makes a cross-party disagreement resolvable in seconds.
 */

export interface RevisionInfo {
  /** Full image reference including tag, e.g. ".../otchealth-mcp-gateway:2d2fe9a". Null off-ECS. */
  image: string | null;
  /** Just the tag portion — normally the short git sha the image was built from. */
  image_tag: string | null;
  /** Immutable content digest. Two deploys of the same tag still differ here. */
  image_digest: string | null;
  /** ECS task definition family and revision, e.g. "otchealth-gateway:13". */
  task_definition: string | null;
  /** When THIS process started (ISO). Distinguishes tasks running the same image. */
  started_at: string;
  /** Seconds this process has been up. A tiny value means a rollout just happened. */
  uptime_seconds: number;
  /** Why the container fields are null, when they are. Null when they resolved fine. */
  source_error: string | null;
}

const STARTED_AT = new Date().toISOString();

/** Cached container-derived half. The process-derived half is recomputed per call (uptime moves). */
let cached: Pick<RevisionInfo, 'image' | 'image_tag' | 'image_digest' | 'task_definition' | 'source_error'> | null =
  null;

/** Exported for direct unit test: the cached-after-success path makes this unreachable from
 *  revisionInfo() once any lookup has succeeded, and this parsing is where a wrong answer would
 *  send two parties chasing a difference that does not exist. */
export function tagOf(image: string | null): string | null {
  if (!image) return null;
  // Split on the LAST ':' so a registry host carrying a port is not mistaken for a tag.
  const at = image.lastIndexOf(':');
  if (at < 0) return null;
  const tag = image.slice(at + 1);
  // A '/' after the colon means that colon belonged to a host:port, not a tag.
  return tag.includes('/') ? null : tag;
}

async function loadContainerMetadata(): Promise<NonNullable<typeof cached>> {
  const uri = process.env.ECS_CONTAINER_METADATA_URI_V4 || process.env.ECS_CONTAINER_METADATA_URI;
  if (!uri) {
    return {
      image: null,
      image_tag: null,
      image_digest: null,
      task_definition: null,
      source_error: 'not running on ECS (no container metadata endpoint)',
    };
  }
  try {
    // Deliberately short: this is called from /health, which must stay fast even when the metadata
    // endpoint is unhappy. A slow discriminator that delays a health check is worse than a null one.
    const res = await fetch(uri, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`metadata HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const labels = (body['Labels'] ?? {}) as Record<string, string>;
    const family = labels['com.amazonaws.ecs.task-definition-family'];
    const version = labels['com.amazonaws.ecs.task-definition-version'];
    const image = typeof body['Image'] === 'string' ? body['Image'] : null;
    return {
      image,
      image_tag: tagOf(image),
      image_digest: typeof body['ImageID'] === 'string' ? body['ImageID'] : null,
      task_definition: family && version ? `${family}:${version}` : null,
      source_error: null,
    };
  } catch (e) {
    return {
      image: null,
      image_tag: null,
      image_digest: null,
      task_definition: null,
      source_error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** The serving revision. Never throws; every field degrades to null with `source_error` set. */
export async function revisionInfo(): Promise<RevisionInfo> {
  // Only a SUCCESSFUL lookup is cached. Caching a failure would pin a null answer for the life of
  // the task, which is precisely the "stale constant" problem this module exists to remove.
  if (!cached || cached.source_error) cached = await loadContainerMetadata();
  return {
    ...cached,
    started_at: STARTED_AT,
    uptime_seconds: Math.round(process.uptime()),
  };
}
