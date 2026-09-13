# Registry pointer-refresh packaging correction

At gateway commit `915d9f2b01442047c5cf653396389c19fc40a982`, the pointer-refresh task and runner were added under `tools/`, but the Dockerfile copied neither module into the build stage or runtime stage. The Dockerfile uses an explicit allowlist for one-off task modules, not a recursive tools copy.

An ECS command that names `tools/identity-registry-pointer-refresh-task.mjs` in that image therefore fails before the wrapper can emit its structured event. This is a static packaging classification for the failed refresh run. It explains an observed terminal nonzero result with a missing event, but it is not a substitute for the exact task log classifier and does not assert the task's complete runtime cause.

This correction withdraws any implication that commit `915d9f2` had complete pointer-refresh image packaging verification. The prior image build can establish neither module's runtime presence because both were omitted from its Dockerfile copy allowlist.

The fix copies the task and runner in both Dockerfile stages. The build workflow first runs the source packaging test, then after the multi-platform ECR build pulls each `linux/amd64` and `linux/arm64` manifest, copies both modules from a stopped container, and compares each SHA-256 to the checked-out source. The verification executes neither module and exposes no task inputs or secrets.
