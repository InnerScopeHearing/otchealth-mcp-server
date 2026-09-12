// Test-facing production-port entry point. The compiled implementation uses
// ECS task-role SigV4 plus KMS and makes no calls merely by being imported.
export {
  createCfoIdentityRegistryKmsSigner,
  createExplicitExportImmutableStore,
} from '../dist/server/identity-registry-explicit-export-ports.js';
