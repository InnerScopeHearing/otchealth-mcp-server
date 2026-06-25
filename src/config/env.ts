import { z } from 'zod';

const EnvSchema = z.object({
  // Customer.io
  CIO_SITE_ID: z.string().min(1, 'CIO_SITE_ID is required'),
  CIO_TRACK_KEY: z.string().min(1, 'CIO_TRACK_KEY is required'),
  CIO_APP_API_BEARER: z.string().min(1, 'CIO_APP_API_BEARER is required'),

  // MCP server auth
  PERPLEXITY_CONNECTOR_TOKEN: z
    .string()
    .min(32, 'PERPLEXITY_CONNECTOR_TOKEN must be at least 32 chars'),
  ADMIN_REVOKE_TOKEN: z
    .string()
    .min(32, 'ADMIN_REVOKE_TOKEN must be at least 32 chars'),

  // n8n
  N8N_BASE_URL: z
    .string()
    .url()
    .default('https://automation.otchealth.app'),
  N8N_API_KEY: z.string().optional().default(''),
  N8N_WEBHOOK_SECRET: z
    .string()
    .min(32, 'N8N_WEBHOOK_SECRET must be at least 32 chars'),

  // Cloudflare
  CLOUDFLARE_API_TOKEN: z.string().optional().default(''),
  CLOUDFLARE_ZONE_ID: z.string().optional().default(''),

  // Microsoft Graph (COO send-as coo@otchealthmart.com)
  GRAPH_TENANT_ID: z.string().optional().default(''),
  GRAPH_CLIENT_ID: z.string().optional().default(''),
  GRAPH_CLIENT_SECRET: z.string().optional().default(''),
  GRAPH_SENDER_EMAIL: z.string().optional().default('coo@otchealthmart.com'),

  // Stripe (read-only)
  STRIPE_SECRET_KEY: z.string().optional().default(''),

  // OAuth 2.1 (confidential client). When OAUTH_CLIENT_ID + OAUTH_TOKEN_SIGNING_SECRET are set,
  // the gateway issues real expiring JWT access/refresh tokens (PKCE S256 mandatory). When unset,
  // the legacy static-connector-token behavior is preserved for back-compat.
  OAUTH_CLIENT_ID: z.string().optional().default(''),
  OAUTH_CLIENT_SECRET: z.string().optional().default(''),
  OAUTH_TOKEN_SIGNING_SECRET: z.string().optional().default(''),
  OAUTH_REDIRECT_URIS: z.string().optional().default(''),
  PUBLIC_BASE_URL: z.string().optional().default(''),

  // Semantic recall over the memory-exec Azure AI Search index (read-only QUERY key).
  // Inert when unset -> memory_recall falls back to keyword search over the blob feed.
  AZURE_SEARCH_ENDPOINT: z.string().optional().default(''),
  AZURE_SEARCH_QUERY_KEY: z.string().optional().default(''),

  // Feature flags
  READ_ONLY_MODE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  ENABLE_WRITE_TOOLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  ENABLE_HIGH_RISK_TOOLS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  DRY_RUN_DEFAULT: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // Server
  PORT: z
    .string()
    .default('8080')
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => Number.isFinite(n) && n > 0 && n < 65536, 'PORT must be a valid port number'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  // CIO workspace (informational, used in error messages)
  CIO_WORKSPACE_ID: z.string().default('193366'),

  // Phase 2: Shopify (hearingassist.myshopify.com / otchealthmart.com)
  SHOPIFY_SHOP: z.string().optional().default(''),
  SHOPIFY_API_VERSION: z.string().optional().default('2024-10'),
  SHOPIFY_ACCESS_TOKEN: z.string().optional().default(''),

  // Phase 2: Intercom
  INTERCOM_ACCESS_TOKEN: z.string().optional().default(''),

  // Phase 3: Netlify (INND site + portfolio deploy visibility, read-only)
  NETLIFY_AUTH_TOKEN: z.string().optional().default(''),

  // Phase 3: Gumroad (digital-products cash lane scoreboard, read-only)
  GUMROAD_ACCESS_TOKEN: z.string().optional().default(''),

  // Phase 4: kb-memory shared brain (commons store ONLY; non-PHI, non-MNPI, non-privileged
  // by construction). Inert without these. Mirrors skills/kb-memory commons (otchealthcommons /
  // company-journal). NEVER wire the cfo/clo/clo-personal/PHI storage accounts here.
  AZURE_COMMONS_STORAGE_ACCOUNT: z.string().optional().default(''),
  AZURE_COMMONS_STORAGE_KEY: z.string().optional().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n` +
        `Check .env against .env.example, or refer to Matt's Notion Token Vault.`,
    );
  }
  cached = parsed.data;
  return cached;
}
