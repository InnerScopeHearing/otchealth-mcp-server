import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual, type JsonWebKey } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import descopeSdk from '@descope/node-sdk';
import { z } from 'zod';
import { createHeyGenApprovalContextToken, verifyHeyGenApprovalContextToken } from '../tools/heygen/approval-context.js';
import { encryptHeyGenOwnerApprovalHandle } from '../tools/heygen/approval-handle.js';
import { heyGenApprovalCompatibilityFingerprints, heyGenPublicJwkFingerprint } from '../tools/heygen/approval-fingerprint.js';

const StartSchema = z.object({
  context_token: z.string().min(100).max(32_768),
}).strict();
const CompleteSchema = z.object({
  challenge_token: z.string().min(100).max(65_536),
  code: z.string().regex(/^\d{6}$/),
}).strict();

const ApprovalBrokerEnvSchema = z.object({
  DESCOPE_PROJECT_ID: z.string().min(1),
  HEYGEN_OWNER_APPROVAL_ISSUER: z.string().url(),
  HEYGEN_OWNER_APPROVAL_AUDIENCE: z.string().min(1),
  HEYGEN_OWNER_APPROVAL_SUBJECT: z.string().min(1),
  HEYGEN_OWNER_APPROVAL_PRIVATE_JWK: z.string().min(1),
  HEYGEN_OWNER_APPROVAL_PUBLIC_JWK: z.string().min(1),
  HEYGEN_OWNER_APPROVAL_EMAIL: z.string().email(),
  HEYGEN_APPROVAL_CONTEXT_SECRET: z.string().min(32),
  HEYGEN_APPROVAL_HANDLE_SECRET: z.string().min(32),
  HEYGEN_APPROVAL_CALLBACK_SECRET: z.string().min(32),
  HEYGEN_APPROVAL_CALLBACK_URL: z.string().url(),
});

type ApprovalBrokerEnv = z.infer<typeof ApprovalBrokerEnvSchema>;

function approvalEnv(): ApprovalBrokerEnv {
  return ApprovalBrokerEnvSchema.parse(process.env);
}

const ChallengeSchema = z.object({
  version: z.literal(1),
  context_token: z.string().min(100).max(32_768),
  packet_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  challenge_id: z.string().regex(/^[a-f0-9]{32}$/),
  issued_at: z.number().int().nonnegative(),
  expires_at: z.number().int().positive(),
}).strict();

type OwnerIdentity = { email?: string; loginIds: string[]; verifiedEmail?: boolean };

export interface HeyGenApprovalBrokerDeps {
  now: () => number;
  random: (size: number) => Buffer;
  startOtp: (email: string) => Promise<{ maskedEmail?: string }>;
  verifyOtp: (email: string, code: string) => Promise<OwnerIdentity>;
  callback: (payload: Record<string, unknown>, secret: string, url: string) => Promise<void>;
}

function hmac(value: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(value, 'ascii').digest();
}

function createChallenge(contextToken: string, packetSha256: string, secret: string, nowMs: number, random: (size: number) => Buffer): { token: string; expiresAt: string } {
  if (secret.length < 32) throw new Error('Approval context secret is not configured.');
  const issuedAt = Math.floor(nowMs / 1000);
  const expiresAt = issuedAt + 10 * 60;
  const payloadObject = {
    version: 1 as const,
    context_token: contextToken,
    packet_sha256: packetSha256,
    challenge_id: random(16).toString('hex'),
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const payload = Buffer.from(JSON.stringify(payloadObject), 'utf8').toString('base64url');
  return { token: `${payload}.${hmac(payload, secret).toString('base64url')}`, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

function verifyChallenge(token: string, secret: string, nowMs: number): z.infer<typeof ChallengeSchema> {
  const parts = token.split('.');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error('Approval challenge is invalid.');
  const [payload, encodedMac] = parts as [string, string];
  const expected = hmac(payload, secret);
  const supplied = Buffer.from(encodedMac, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Approval challenge signature is invalid.');
  const challenge = ChallengeSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
  const now = Math.floor(nowMs / 1000);
  if (challenge.expires_at <= now - 30 || challenge.issued_at > now + 30 || challenge.expires_at - challenge.issued_at > 10 * 60) {
    throw new Error('Approval challenge is expired or outside its validity window.');
  }
  return challenge;
}

function approvalKey(privateJwkText: string, publicJwkText: string): { privateJwk: JsonWebKey; kid: string; publicFingerprint: string } {
  let privateJwk: JsonWebKey;
  let publicJwk: JsonWebKey;
  try {
    privateJwk = JSON.parse(privateJwkText) as JsonWebKey;
    publicJwk = JSON.parse(publicJwkText) as JsonWebKey;
  } catch {
    throw new Error('Approval JWK configuration is invalid.');
  }
  if (privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256' || !privateJwk.d || !privateJwk.x || !privateJwk.y || !privateJwk.kid) {
    throw new Error('Approval private key must be a named P-256 private JWK.');
  }
  const derived = createPublicKey(createPrivateKey({ key: privateJwk, format: 'jwk' })).export({ format: 'jwk' }) as JsonWebKey;
  if (publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' || publicJwk.kid !== privateJwk.kid || publicJwk.x !== derived.x || publicJwk.y !== derived.y) {
    throw new Error('Approval public/private JWK pair does not match.');
  }
  const publicFingerprint = heyGenPublicJwkFingerprint(JSON.stringify(publicJwk));
  if (!publicFingerprint) throw new Error('Approval public JWK is invalid.');
  return { privateJwk, kid: String(privateJwk.kid), publicFingerprint };
}

function issueOwnerJws(input: {
  packet: ReturnType<typeof verifyHeyGenApprovalContextToken>['packet'];
  issuer: string;
  audience: string;
  subject: string;
  privateJwk: JsonWebKey;
  kid: string;
  nowMs: number;
  random: (size: number) => Buffer;
}): { jws: string; expiresAt: number } {
  const now = Math.floor(input.nowMs / 1000);
  const expiresAt = now + 5 * 60;
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'OTC-HeyGen-Approval+jwt', kid: input.kid })).toString('base64url');
  const p = input.packet;
  const claims = {
    iss: input.issuer,
    aud: input.audience,
    sub: input.subject,
    iat: now,
    nbf: now,
    exp: expiresAt,
    jti: `hg-${input.random(24).toString('hex')}`,
    grant_type: p.grant_type,
    tool: p.tool,
    operation_id: p.operation_id,
    request_sha256: p.request_sha256,
    idempotency_key_sha256: p.idempotency_key_sha256,
    manifest_sha256: p.manifest_sha256,
    billing_snapshot_sha256: p.billing_snapshot_sha256,
    billing_state_sha256: p.billing_state_sha256,
    billing_observed_at: p.billing_observed_at,
    confirmed_premium_credits_before: p.confirmed_premium_credits_before,
    reserve_credits: p.reserve_credits,
    max_credits: p.max_credits,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`, 'ascii'), {
    key: createPrivateKey({ key: input.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { jws: `${header}.${payload}.${signature}`, expiresAt };
}

function ownerMatches(identity: OwnerIdentity, ownerEmail: string): boolean {
  const expected = ownerEmail.trim().toLowerCase();
  const loginIds = identity.loginIds.map((value) => value.trim().toLowerCase());
  return identity.verifiedEmail === true && (identity.email?.trim().toLowerCase() === expected || loginIds.includes(expected));
}

function defaultDeps(): HeyGenApprovalBrokerDeps {
  const env = approvalEnv();
  const descope = descopeSdk({ projectId: env.DESCOPE_PROJECT_ID });
  return {
    now: () => Date.now(),
    random: randomBytes,
    startOtp: async (email) => {
      const result = await descope.otp.signUpOrIn.email(email);
      if (!result.ok) throw new Error(`Owner OTP start failed (${result.error?.errorCode ?? result.code}).`);
      return { maskedEmail: result.data?.maskedEmail };
    },
    verifyOtp: async (email, code) => {
      const result = await descope.otp.verify.email(email, code);
      if (!result.ok || !result.data?.user) throw new Error(`Owner OTP verification failed (${result.error?.errorCode ?? result.code}).`);
      return {
        email: result.data.user.email,
        loginIds: result.data.user.loginIds,
        verifiedEmail: result.data.user.verifiedEmail,
      };
    },
    callback: async (payload, secret, url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-heygen-approval-callback-secret': secret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Gateway approval callback failed (HTTP ${response.status}).`);
    },
  };
}

export function registerHeyGenApprovalBrokerRoutes(app: FastifyInstance, injected?: HeyGenApprovalBrokerDeps): void {
  const deps = injected ?? defaultDeps();

  app.get('/approve', async (_request, reply) => {
    reply.header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.type('text/html; charset=utf-8');
    return reply.send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>OTCHealth HeyGen Approval</title><style>body{font-family:system-ui;background:#f5f7fb;color:#102035;margin:0;padding:7vw}main{max-width:620px;margin:auto;background:white;border:1px solid #d9e0ea;border-radius:16px;padding:32px;box-shadow:0 12px 36px #10203518}h1{font-size:1.6rem}button,input{font:inherit;padding:12px;border-radius:9px;border:1px solid #9caabd}button{background:#0b5fff;color:#fff;border:0;font-weight:650;cursor:pointer}button:disabled{opacity:.5}code{word-break:break-all}.muted{color:#52647a}.ok{color:#087d47}.err{color:#b42318}#verify{display:none}</style></head><body><main><h1>Approve one HeyGen Avatar Video</h1><p class="muted">This page signs one short-lived, single-use owner grant. It does not submit a video.</p><div id="summary"></div><button id="start">Send approval code</button><div id="verify"><p>Enter the six-digit code sent to the configured owner email.</p><input id="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" pattern="[0-9]{6}"> <button id="complete">Approve exact packet</button></div><p id="status" aria-live="polite"></p></main><script>(()=>{const q=new URLSearchParams(location.hash.slice(1));const context=q.get('context_token');let challenge='';const status=document.getElementById('status');const set=(t,c='')=>{status.textContent=t;status.className=c};if(!context){set('Missing or expired approval context. Return to the dry-run result and open a fresh link.','err');document.getElementById('start').disabled=true;}document.getElementById('start').onclick=async()=>{set('Sending code…');try{const r=await fetch('/v1/heygen/avatar-video/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({context_token:context})});const d=await r.json();if(!r.ok)throw new Error(d.message||d.error);challenge=d.challenge_token;document.getElementById('summary').textContent='Operation '+d.operation_id+' · request '+d.request_sha256+' · balance '+d.confirmed_premium_credits_before+' · maximum '+d.max_credits+' credit(s) · reserve '+d.reserve_credits+' · billing observed '+d.billing_observed_at;document.getElementById('verify').style.display='block';document.getElementById('start').disabled=true;set('Code sent to '+d.masked_owner+'.','ok');}catch(e){set(String(e.message||e),'err')}};document.getElementById('complete').onclick=async()=>{const code=document.getElementById('code').value.trim();if(!/^\\d{6}$/.test(code)){set('Enter the six-digit code.','err');return}set('Verifying and signing…');try{const r=await fetch('/v1/heygen/avatar-video/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({challenge_token:challenge,code})});const d=await r.json();if(!r.ok)throw new Error(d.message||d.error);history.replaceState(null,'',location.pathname);document.getElementById('verify').style.display='none';set('Approved. No video was submitted. You may close this page.','ok');}catch(e){set(String(e.message||e),'err')}}})();</script></body></html>`);
  });

  app.get('/health', async (_request, reply) => {
    try {
      const env = approvalEnv();
      const key = approvalKey(env.HEYGEN_OWNER_APPROVAL_PRIVATE_JWK, env.HEYGEN_OWNER_APPROVAL_PUBLIC_JWK);
      const configured = Boolean(
        env.DESCOPE_PROJECT_ID && env.HEYGEN_OWNER_APPROVAL_EMAIL && env.HEYGEN_OWNER_APPROVAL_SUBJECT &&
        env.HEYGEN_APPROVAL_CONTEXT_SECRET.length >= 32 && env.HEYGEN_APPROVAL_HANDLE_SECRET.length >= 32 &&
        env.HEYGEN_APPROVAL_CALLBACK_SECRET.length >= 32 && env.HEYGEN_APPROVAL_CALLBACK_URL,
      );
      const compatibility = heyGenApprovalCompatibilityFingerprints({
        publicJwk: env.HEYGEN_OWNER_APPROVAL_PUBLIC_JWK,
        contextSecret: env.HEYGEN_APPROVAL_CONTEXT_SECRET,
        handleSecret: env.HEYGEN_APPROVAL_HANDLE_SECRET,
        callbackSecret: env.HEYGEN_APPROVAL_CALLBACK_SECRET,
      });
      return reply.code(configured ? 200 : 503).send({
        status: configured ? 'ok' : 'unconfigured',
        service: 'otchealth-approval-broker',
        issuer: env.HEYGEN_OWNER_APPROVAL_ISSUER,
        audience: env.HEYGEN_OWNER_APPROVAL_AUDIENCE,
        subject_sha256: createHash('sha256').update(env.HEYGEN_OWNER_APPROVAL_SUBJECT).digest('hex'),
        key_id: key.kid,
        public_jwk_fingerprint_sha256: key.publicFingerprint,
        approval_compatibility: compatibility,
      });
    } catch {
      return reply.code(503).send({ status: 'invalid_configuration', service: 'otchealth-approval-broker' });
    }
  });

  app.post('/v1/heygen/avatar-video/start', {
    config: { rateLimit: { max: 3, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const env = approvalEnv();
    const parsed = StartSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'approval_request_invalid' });
    try {
      const verified = verifyHeyGenApprovalContextToken(parsed.data.context_token, env.HEYGEN_APPROVAL_CONTEXT_SECRET, deps.now());
      if (!verified.packet.family_story_exact_cap_required || verified.packet.max_credits !== verified.packet.conservative_credit_cap) {
        return reply.code(409).send({ error: 'approval_packet_not_family_exact' });
      }
      if (verified.packet.confirmed_premium_credits_before - verified.packet.max_credits < verified.packet.reserve_credits) {
        return reply.code(409).send({ error: 'approval_packet_reserve_violation' });
      }
      const otp = await deps.startOtp(env.HEYGEN_OWNER_APPROVAL_EMAIL);
      const challenge = createChallenge(parsed.data.context_token, verified.packetSha256, env.HEYGEN_APPROVAL_CONTEXT_SECRET, deps.now(), deps.random);
      return reply.send({
        challenge_token: challenge.token,
        challenge_expires_at: challenge.expiresAt,
        packet_sha256: verified.packetSha256,
        masked_owner: otp.maskedEmail ?? 'configured owner email',
        operation_id: verified.packet.operation_id,
        request_sha256: verified.packet.request_sha256,
        billing_observed_at: verified.packet.billing_observed_at,
        confirmed_premium_credits_before: verified.packet.confirmed_premium_credits_before,
        max_credits: verified.packet.max_credits,
        reserve_credits: verified.packet.reserve_credits,
      });
    } catch (error) {
      return reply.code(409).send({ error: 'approval_start_failed', message: (error as Error).message });
    }
  });

  app.post('/v1/heygen/avatar-video/complete', {
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const env = approvalEnv();
    const parsed = CompleteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'approval_completion_invalid' });
    try {
      const challenge = verifyChallenge(parsed.data.challenge_token, env.HEYGEN_APPROVAL_CONTEXT_SECRET, deps.now());
      const verified = verifyHeyGenApprovalContextToken(challenge.context_token, env.HEYGEN_APPROVAL_CONTEXT_SECRET, deps.now());
      if (verified.packetSha256 !== challenge.packet_sha256) throw new Error('Approval packet changed after OTP start.');
      const owner = await deps.verifyOtp(env.HEYGEN_OWNER_APPROVAL_EMAIL, parsed.data.code);
      if (!ownerMatches(owner, env.HEYGEN_OWNER_APPROVAL_EMAIL)) throw new Error('Authenticated owner identity is not authorized.');
      const key = approvalKey(env.HEYGEN_OWNER_APPROVAL_PRIVATE_JWK, env.HEYGEN_OWNER_APPROVAL_PUBLIC_JWK);
      const grant = issueOwnerJws({
        packet: verified.packet,
        issuer: env.HEYGEN_OWNER_APPROVAL_ISSUER,
        audience: env.HEYGEN_OWNER_APPROVAL_AUDIENCE,
        subject: env.HEYGEN_OWNER_APPROVAL_SUBJECT,
        privateJwk: key.privateJwk,
        kid: key.kid,
        nowMs: deps.now(),
        random: deps.random,
      });
      const handle = encryptHeyGenOwnerApprovalHandle({
        operationId: verified.packet.operation_id,
        ownerApprovalJws: grant.jws,
        expiresAt: grant.expiresAt,
      }, env.HEYGEN_APPROVAL_HANDLE_SECRET, deps.random);
      const expiresAt = new Date(grant.expiresAt * 1000).toISOString();
      await deps.callback({
        operation_id: verified.packet.operation_id,
        packet_sha256: verified.packetSha256,
        owner_approval_handle: handle,
        owner_subject: env.HEYGEN_OWNER_APPROVAL_SUBJECT,
        expires_at: expiresAt,
      }, env.HEYGEN_APPROVAL_CALLBACK_SECRET, env.HEYGEN_APPROVAL_CALLBACK_URL);
      return reply.send({
        approved: true,
        operation_id: verified.packet.operation_id,
        packet_sha256: verified.packetSha256,
        owner_approval_expires_at: expiresAt,
      });
    } catch (error) {
      return reply.code(401).send({ error: 'approval_completion_failed', message: (error as Error).message });
    }
  });
}

export const approvalBrokerTestExports = {
  createChallenge,
  verifyChallenge,
  issueOwnerJws,
  ownerMatches,
  approvalKey,
  createHeyGenApprovalContextToken,
};
