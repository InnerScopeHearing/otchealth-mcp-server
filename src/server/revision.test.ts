import { test } from 'node:test';
import assert from 'node:assert/strict';

// A revision discriminator that can be WRONG is worse than none: it is the hand-maintained
// build_tag problem again, just with more ceremony. These pin the two properties that matter --
// it never throws, and it never fabricates a value it did not observe.

test('off ECS: every container field is null and the reason is stated, not fabricated', async () => {
  const prev = process.env.ECS_CONTAINER_METADATA_URI_V4;
  const prev2 = process.env.ECS_CONTAINER_METADATA_URI;
  delete process.env.ECS_CONTAINER_METADATA_URI_V4;
  delete process.env.ECS_CONTAINER_METADATA_URI;
  try {
    const { revisionInfo } = await import('./revision.js');
    const r = await revisionInfo();
    assert.equal(r.image, null);
    assert.equal(r.image_tag, null);
    assert.equal(r.task_definition, null);
    assert.match(String(r.source_error), /not running on ECS/);
    // The process-derived half is always real, and is what distinguishes two tasks on one image.
    assert.match(r.started_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof r.uptime_seconds, 'number');
  } finally {
    if (prev) process.env.ECS_CONTAINER_METADATA_URI_V4 = prev;
    if (prev2) process.env.ECS_CONTAINER_METADATA_URI = prev2;
  }
});

test('a metadata endpoint that FAILS degrades to null with the error, and is not cached as truth', async () => {
  process.env.ECS_CONTAINER_METADATA_URI_V4 = 'http://169.254.170.2/never';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
  try {
    const { revisionInfo } = await import('./revision.js');
    const r = await revisionInfo();
    assert.equal(r.image, null);
    assert.match(String(r.source_error), /500/);

    // Now let it succeed: a previously-FAILED lookup must be retried, never pinned. Caching a
    // failure would freeze a null answer for the life of the task -- the stale-constant problem
    // this module exists to remove.
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          Image: '900915535335.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway:2d2fe9a',
          ImageID: 'sha256:abc123',
          Labels: {
            'com.amazonaws.ecs.task-definition-family': 'otchealth-gateway',
            'com.amazonaws.ecs.task-definition-version': '13',
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const ok = await revisionInfo();
    assert.equal(ok.image_tag, '2d2fe9a', 'the tag is the git sha the image was built from');
    assert.equal(ok.task_definition, 'otchealth-gateway:13');
    assert.equal(ok.image_digest, 'sha256:abc123');
    assert.equal(ok.source_error, null);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.ECS_CONTAINER_METADATA_URI_V4;
  }
});

test('tagOf: a registry host carrying a PORT is not mistaken for an image tag', async () => {
  const { tagOf } = await import('./revision.js');
  assert.equal(tagOf('900915535335.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway:2d2fe9a'), '2d2fe9a');
  // ':5000/gateway' must not be read as the tag -- a bogus tag would send two parties chasing a
  // difference that does not exist, which is the failure this module exists to prevent.
  assert.equal(tagOf('registry.internal:5000/gateway'), null);
  assert.equal(tagOf('gateway'), null, 'no tag at all is null, not an empty string');
  assert.equal(tagOf(null), null);

  // A DIGEST-PINNED reference carries both. ECS reports some tasks this way and others not, so two
  // replicas of the SAME service reported different image_tags on the first deploy of this module --
  // one the tag, one 64 hex characters of digest. A discriminator that disagrees with itself across
  // replicas would restart the very argument this exists to end.
  assert.equal(
    tagOf('900915535335.dkr.ecr.us-east-1.amazonaws.com/otchealth-mcp-gateway:84b9bbb@sha256:4c818a121aa273f5'),
    '84b9bbb',
    'the digest suffix must be stripped before looking for the tag',
  );
  // Digest-only, no tag: honestly null rather than the hex masquerading as a tag.
  assert.equal(tagOf('repo/gateway@sha256:4c818a121aa273f5'), null);
});
