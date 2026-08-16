/**
 * MCP tool: claims_check — the OTCHealth CLAIMS-COMPLIANCE GATE.
 *
 * The Medvi lesson, codified: Medvi's FDA warning letter targeted front-end ad +
 * advertorial CLAIM SPECIFICITY, not the business model. So every customer-facing
 * line — ad, advertorial, landing page, email, SMS, or CS script — must pass this
 * gate before it ships. SOP-1: "No claim ships unless the gate passes."
 *
 * For PSAP products (e.g. iHEARtrio) the hard rule: market SOUND AMPLIFICATION /
 * GENERAL WELLNESS only. NEVER state or imply the product treats, diagnoses, cures,
 * prevents, or mitigates hearing loss or any disease, and never call a PSAP a
 * "hearing aid" or "medical device". OTC hearing-aid claims are a separate, gated
 * (Matt + clinical) regime and are out of scope here.
 *
 * Judgment runs on a credit-funded/lower-cost chat provider (FLEET COST PROTOCOL: Azure Foundry
 * by default, or OpenAI-direct when LLM_PROVIDER=openai) — high tier for a quality-critical
 * compliance call — and returns a structured, logged verdict.
 *
 * Env: LLM_PROVIDER (foundry default | openai); see src/azure/foundry.ts's chatTarget() for the
 * full var list per provider. Read-only; mutates nothing. Advisory gate — callers (and humans)
 * must honor a 'block'/'revise'.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { chat, chatConfigured, type ChatMessage } from '../../azure/foundry.js';
import { loadEnv } from '../../config/env.js';

const PSAP_RULESET = `
OTCHealth claims-compliance ruleset (PSAP / general-wellness marketing).

ALLOWED (compliant) language for a PSAP like iHEARtrio:
- "personal sound amplification product (PSAP)", "sound amplifier"
- helps you "hear conversations / TV / phone calls / the outdoors more clearly"
- "for everyday listening situations", "general wellness", "amplifies the sounds around you"
- comfort, discretion, rechargeable battery, price/value, ease of setup, support.

PROHIBITED (these are the violations that draw FTC/FDA action):
- ANY claim or implication that the product treats, diagnoses, cures, prevents,
  mitigates, restores, corrects, or reverses hearing loss or any disease/condition.
- Calling a PSAP a "hearing aid", "medical device", or "FDA-approved/cleared".
- Specific medical-outcome promises ("restore your hearing", "fixes hearing loss",
  "X% better hearing in Y days", "doctor-recommended treatment").
- Diagnostic claims about the user from the iHEARtest screening (it is a general
  self-check, NOT a diagnosis).
- Misleading equivalence to prescription/OTC hearing aids.

REQUIRED context where relevant:
- A PSAP disclaimer is expected on ads/advertorials/landing pages: not a hearing aid;
  not intended to diagnose, treat, cure, or prevent any condition; consult a
  professional if concerned about hearing.

CHANNEL STRICTNESS: ads and advertorials get the HARDEST screening (the Medvi failure
point). cs scripts must also avoid clinical/diagnostic statements (handoff instead).
`.trim();

export function registerClaimsCheck(server: McpServer, callerHash: CallerHashProvider): void {
  registerTool(
    server,
    {
      name: 'claims_check',
      category: 'read',
      annotations: {
        title: 'Claims-compliance gate (PSAP / FTC-FDA)',
        description:
          'Screens customer-facing copy (ad, advertorial, web, email, SMS, or CS script) against the OTCHealth PSAP/FTC-FDA claims ruleset before it ships. Returns verdict pass/revise/block, a risk score, the exact violating phrases with fixes, and a compliant rewrite. Ads + advertorials are screened hardest (the Medvi failure point). Read-only; mutates nothing. Runs on credit-funded Azure Foundry.',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputShape: {
        text: z.string().min(1).describe('The customer-facing copy to screen.'),
        channel: z
          .enum(['ad', 'advertorial', 'web', 'email', 'sms', 'cs', 'other'])
          .optional()
          .describe('Where the copy will appear. ad/advertorial are screened hardest. Default: other.'),
        productClass: z
          .enum(['PSAP', 'OTC_hearing_aid', 'AWARE', 'general'])
          .optional()
          .describe('Product the copy is for. Default PSAP. OTC_hearing_aid is gated elsewhere (Matt + clinical) — this gate will flag it for escalation.'),
        context: z.string().optional().describe('Optional extra context (offer, audience, etc.).'),
      },
      outputShape: {
        verdict: z.string(),
        risk: z.number(),
        violations: z.unknown(),
        compliant_rewrite: z.string(),
        notes: z.string(),
        channel: z.string(),
        productClass: z.string(),
        model: z.string(),
        error: z.string().optional(),
      },
      handler: async (input) => {
        const channel = input.channel ?? 'other';
        const productClass = input.productClass ?? 'PSAP';
        if (!chatConfigured()) {
          const provider = loadEnv().LLM_PROVIDER;
          return {
            data: {
              verdict: 'error', risk: 100, violations: [], compliant_rewrite: '', notes: '', channel, productClass, model: '',
              // Kept as 'foundry_unconfigured' on the default provider for byte-identical
              // backward-compat with anything keyed on this exact string.
              error: provider === 'openai' ? 'openai_unconfigured' : 'foundry_unconfigured',
            },
            summary:
              provider === 'openai'
                ? 'claims_check unavailable: LLM_PROVIDER=openai but OPENAI_API_KEY not configured on the gateway.'
                : 'claims_check unavailable: Foundry endpoint/key not configured on the gateway.',
          };
        }
        if (productClass === 'OTC_hearing_aid') {
          return {
            data: {
              verdict: 'block', risk: 100, violations: [{ phrase: '(entire copy)', rule: 'OTC hearing-aid claims are a gated regime', severity: 'high', fix: 'Escalate to Matt + clinical sign-off; do not ship OTC hearing-aid claims from this gate.' }],
              compliant_rewrite: '', notes: 'OTC hearing-aid marketing requires Matt + clinical gate (FDA process). This gate covers PSAP/general-wellness only.', channel, productClass, model: 'n/a',
            },
            summary: 'claims_check: BLOCK — OTC hearing-aid copy must go through the Matt + clinical gate, not this PSAP gate.',
          };
        }
        const hardChannels = channel === 'ad' || channel === 'advertorial';
        const sys = `You are a strict US healthcare-marketing compliance reviewer (FTC advertising substantiation + FDA PSAP-vs-hearing-aid boundary). Apply the ruleset EXACTLY. Be conservative: when in doubt, flag. ${hardChannels ? 'This is an AD or ADVERTORIAL — apply the STRICTEST scrutiny; this is exactly where regulators look first.' : ''}\n\n${PSAP_RULESET}\n\nReturn ONLY JSON: {"verdict":"pass|revise|block","risk":0-100,"violations":[{"phrase":"<verbatim offending text>","rule":"<which rule>","severity":"low|medium|high","fix":"<concrete fix>"}],"compliant_rewrite":"<the full copy rewritten to be compliant while keeping the persuasive intent; keep a PSAP disclaimer where appropriate>","notes":"<short reviewer note>"}. verdict=block if any high-severity violation; revise if low/medium; pass only if fully clean.`;
        const user = `CHANNEL: ${channel}\nPRODUCT CLASS: ${productClass}${input.context ? `\nCONTEXT: ${input.context}` : ''}\n\nCOPY TO SCREEN:\n"""\n${input.text}\n"""`;
        const messages: ChatMessage[] = [
          { role: 'system', content: sys },
          { role: 'user', content: user },
        ];
        try {
          const res = await chat(messages, { maxTokens: 1800, jsonMode: true, tier: 'high' });
          let parsed: any = {};
          try { parsed = JSON.parse(res.text); } catch { parsed = { verdict: 'revise', risk: 50, violations: [], compliant_rewrite: '', notes: 'parser_fallback: model did not return clean JSON', raw: res.text?.slice(0, 600) }; }
          const verdict = String(parsed.verdict || 'revise');
          const risk = typeof parsed.risk === 'number' ? parsed.risk : (verdict === 'block' ? 90 : verdict === 'pass' ? 5 : 50);
          const vcount = Array.isArray(parsed.violations) ? parsed.violations.length : 0;
          return {
            data: {
              verdict, risk,
              violations: parsed.violations ?? [],
              compliant_rewrite: parsed.compliant_rewrite ?? '',
              notes: parsed.notes ?? '',
              channel, productClass, model: res.model,
            },
            summary: `claims_check [${channel}/${productClass}] -> ${verdict.toUpperCase()} (risk ${risk}, ${vcount} violation${vcount === 1 ? '' : 's'}) on ${res.model}.`,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { data: { verdict: 'error', risk: 100, violations: [], compliant_rewrite: '', notes: '', channel, productClass, model: '', error: msg }, summary: `claims_check failed: ${msg}` };
        }
      },
    },
    callerHash,
  );
}
