import { createPublicKey } from 'node:crypto';
import { z } from 'zod';

const label = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,95}$/);
const text = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]{0,1023}$/)
  .refine(value => value.split('/').every(part => part && part !== '.' && part !== '..'));
const prefix = key.refine(value => value.startsWith('graph-trial/'));
const version = z.string().regex(/^[A-Za-z0-9._~+/-]{1,1024}$/).refine(value => value !== 'null');
const publicKey = z.string().max(4096).refine(value => {
  if (!value.startsWith('-----BEGIN PUBLIC KEY-----')) return false;
  try { return createPublicKey(value).asymmetricKeyType === 'ed25519'; } catch { return false; }
});
const schema = z.object({
  schema: z.literal('identity-registry-production-v1'),
  registry_id: label,
  authority: z.object({ schema: z.literal('authenticated-structured-identity-authority-v1'),
    adapter_id: text, source_system: text, scope: z.literal('cfo'), version: text }).strict(),
  binding: z.object({ authenticated_caller: z.literal('cfo'), room: z.literal('finance'),
    source_index: z.literal('finance-cfo-source-docs'),
    run: z.object({ ref_version: text, run_id: label, purpose: text, scope: text,
      run_version: text, manifest_sha256: hash }).strict(),
  }).strict(),
  public_key: publicKey,
  partition_manifest_version: z.string().regex(/^sirm_[a-f0-9]{64}$/),
  source: z.object({ prefix,
    manifest: z.object({ key, version_id: version, sha256: hash }).strict(),
    pointer: z.object({ key }).strict(),
    catalog: z.object({ catalog_version: text, catalog_sha256: hash }).strict(),
  }).strict(),
  storage: z.object({ prefix, approved_policy_canonical_sha256: hash, approved_storage_scope_sha256: hash,
    sse: z.union([z.object({ algorithm: z.literal('AES256') }).strict(),
      z.object({ algorithm: z.literal('aws:kms'), kmsKeyId: z.string().min(1).max(1024) }).strict()]),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const inside = (objectKey: string) => objectKey.startsWith(value.source.prefix + '/');
  if (!inside(value.source.manifest.key) || !inside(value.source.pointer.key) ||
      value.source.manifest.key === value.source.pointer.key ||
      value.source.prefix === value.storage.prefix || value.source.prefix.startsWith(value.storage.prefix + '/') ||
      value.storage.prefix.startsWith(value.source.prefix + '/')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_registry_storage_scope' });
  }
});
export type IdentityRegistryProductionConfig = z.infer<typeof schema>;

/** Deployment JSON contains references and a PUBLIC key only. Errors never echo its contents. */
export function parseIdentityRegistryProductionConfig(raw: string | undefined): IdentityRegistryProductionConfig | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    if (Buffer.byteLength(raw) > 32 * 1024) throw new Error();
    const value: unknown = JSON.parse(raw);
    const config = schema.parse(value);
    const freeze = (item: unknown): void => {
      if (item && typeof item === 'object') {
        Object.values(item).forEach(freeze);
        Object.freeze(item);
      }
    };
    freeze(config);
    return config;
  } catch { throw new Error('identity_registry_production_configuration_invalid'); }
}
