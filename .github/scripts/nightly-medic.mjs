// Nightly fleet-medic: cost-bounded autonomous CI fixer.
// Runs daily. Only SPENDS when main's CI is actually failing (green nights = $0).
// Hard self-cap: max 1 agent assignment per day. Posts a daily entry to the Nightly Medic Log issue.
// Auth: GH_PAT (a user PAT) — required to assign coding agents (App tokens cannot).
const PAT = process.env.GH_PAT;
const REPO = process.env.REPO || 'InnerScopeHearing/otchealth-mcp-server';
const AGENT = process.env.AGENT_LOGIN || 'openai-code-agent'; // Codex (cheap); swap to anthropic-code-agent if desired
const [owner, repo] = REPO.split('/');
const API = 'https://api.github.com';
const H = { Authorization: `Bearer ${PAT}`, Accept: 'application/vnd.github+json', 'User-Agent': 'otc-nightly-medic', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' };
const today = new Date().toISOString().slice(0, 10);
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { raw: t }; } };
async function gql(query, variables) { const r = await fetch(`${API}/graphql`, { method: 'POST', headers: H, body: JSON.stringify({ query, variables }) }); return j(r); }

async function findLogIssue() {
  // 2026-08-30: prefer an explicit FLEET_MEDIC_LOG_ISSUE override, same env var name and same
  // rollover convention the gateway's postAlert() already uses (src/config/env.ts /
  // src/server/webhooks.ts) -- so ONE runbook ("create the next successor issue, then bump
  // FLEET_MEDIC_LOG_ISSUE") covers both consumers instead of only the gateway's.
  //
  // Root cause this fixes: issue #21 ("Nightly Medic Log") hit GitHub's hard 2500-comment cap
  // around 2026-08-10. On 2026-08-28 the gateway side was repointed at a successor, issue #258
  // ("fleet-medic alert log v2 (successor to #21)"), via this same env var on the live task
  // definition -- but this script was not updated, so its title search (below) kept matching
  // #21, which is still open (closing it was never part of the fix), and every comment attempt
  // has 403'd since, turning the nightly workflow red every night (see logLine()'s 2026-08-28
  // comment for why that failure is loud rather than silent).
  //
  // Fetching the override issue directly (not by search) sidesteps a second, latent problem: if
  // a future successor issue's title also happened to match the "Nightly Medic Log" search below
  // while #21 is still open, GitHub Search's result ordering, not recency, would decide which of
  // the two the old code found -- an explicit issue number has no such ambiguity.
  const override = process.env.FLEET_MEDIC_LOG_ISSUE;
  if (override) {
    const n = parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) {
      const issue = await j(await fetch(`${API}/repos/${REPO}/issues/${n}`, { headers: H }));
      if (issue && issue.number && issue.state === 'open') return issue;
      console.error(`nightly-medic: FLEET_MEDIC_LOG_ISSUE=${n} is not a usable open issue (state=${issue?.state ?? issue?.message ?? 'unknown'}); falling back to title search`);
    } else {
      console.error(`nightly-medic: FLEET_MEDIC_LOG_ISSUE=${JSON.stringify(override)} is not a positive integer; falling back to title search`);
    }
  }
  const q = `repo:${REPO} in:title "Nightly Medic Log" type:issue state:open`;
  const s = await j(await fetch(`${API}/search/issues?q=${encodeURIComponent(q)}`, { headers: H }));
  return (s.items || [])[0];
}
async function logLine(issueNumber, body) {
  // 2026-08-28: this POST had no response check at all -- issue #21 ("Nightly Medic Log") hit
  // GitHub's hard 2500-comment cap around 2026-08-10 (403 "Commenting is disabled on issues with
  // more than 2500 comments"), and every comment since has 403'd silently while this script still
  // exited 0, so the Actions run stayed GREEN while actually failing to log a single word. Checking
  // res.ok and flipping the run RED (via exitCode, not a hard exit -- see below) is what turns that
  // back into a signal a human/agent would actually notice.
  const res = await fetch(`${API}/repos/${REPO}/issues/${issueNumber}/comments`, { method: 'POST', headers: H, body: JSON.stringify({ body }) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`nightly-medic: failed to post log comment to issue #${issueNumber} (HTTP ${res.status}): ${text.slice(0, 300)}`);
    // process.exitCode (not process.exit()): logLine is called mid-script, sometimes followed by a
    // bare `return` in the SAME branch that called it -- setting exitCode lets that branch finish
    // normally (any log line already printed to stdout stays visible) while still making the whole
    // run exit non-zero once the script naturally ends, rather than truncating it here.
    process.exitCode = 1;
  }
}

// Best-effort: today's Copilot/AI spend from the org metered-billing usage API.
// Non-fatal — returns a human string; if the API isn't available, says so.
async function dailySpend() {
  try {
    const d = new Date();
    const url = `${API}/organizations/${owner}/settings/billing/usage?year=${d.getUTCFullYear()}&month=${d.getUTCMonth() + 1}&day=${d.getUTCDate()}`;
    const u = await j(await fetch(url, { headers: H }));
    const items = u.usageItems || u.usage || [];
    if (!Array.isArray(items) || !items.length) return 'spend today: n/a';
    let net = 0;
    for (const it of items) {
      const prod = String(it.product || it.sku || '').toLowerCase();
      if (prod.includes('copilot')) net += Number(it.netAmount ?? it.net_amount ?? 0) || 0;
    }
    return `Copilot spend today: $${net.toFixed(2)}`;
  } catch {
    return 'spend today: n/a';
  }
}

// Guards the runtime IIFE below so `import`ing this file (nightly-medic.test.mjs does exactly
// that, to unit-test findLogIssue() without a network call) never runs it as a side effect --
// import.meta.url only equals the invoking file:// path when this script is the one actually
// executed (`node medic.mjs`, the real GH Actions invocation), not when another module imports
// it. Behavior for the real runtime path is unchanged.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) (async () => {
  if (!PAT) { console.error('GH_PAT required'); process.exit(1); }
  const log = await findLogIssue();
  const logNo = log?.number;
  const spend = await dailySpend();

  // 1) Did the latest completed CI on main fail?
  const runs = await j(await fetch(`${API}/repos/${REPO}/actions/runs?branch=main&status=completed&per_page=5`, { headers: H }));
  const latest = (runs.workflow_runs || []).filter(r => r.event !== 'dynamic')[0] || (runs.workflow_runs || [])[0];
  const conclusion = latest?.conclusion;
  const failing = ['failure', 'timed_out', 'startup_failure'].includes(conclusion);

  // 2) Daily cap: if we already acted today (open issue labeled nightly-fix created today), skip.
  const openFix = await j(await fetch(`${API}/repos/${REPO}/issues?labels=nightly-fix&state=open&per_page=10`, { headers: H }));
  const actedToday = (Array.isArray(openFix) ? openFix : []).some(i => (i.created_at || '').slice(0, 10) === today);

  if (!failing) {
    const msg = `🟢 ${today} — main CI is ${conclusion || 'unknown'} (run: ${latest?.html_url || 'n/a'}). No action, $0 spend. (${spend})`;
    console.log(msg); if (logNo) await logLine(logNo, msg); return;
  }
  if (actedToday) {
    const msg = `🟡 ${today} — main CI failing but a nightly-fix task was already opened today (daily cap = 1). Skipping to bound spend. (${spend})`;
    console.log(msg); if (logNo) await logLine(logNo, msg); return;
  }

  // 3) Create a fix issue and assign the (cheap) coding agent.
  const issue = await j(await fetch(`${API}/repos/${REPO}/issues`, { method: 'POST', headers: H, body: JSON.stringify({
    title: `Fix failing CI on main (${today})`,
    labels: ['nightly-fix'],
    body: `The latest CI run on \`main\` concluded **${conclusion}** (${latest?.html_url}).\n\nInvestigate and fix the failing checks. Keep the change minimal and atomic; run the tests locally before opening the PR. Do not touch secrets/PHI. If the failure is environmental (not a code bug), comment with the diagnosis instead of changing code.`,
  }) }));
  // resolve agent actor id + assign
  const rq = await gql(`query($o:String!,$n:String!){repository(owner:$o,name:$n){suggestedActors(capabilities:[CAN_BE_ASSIGNED],first:30){nodes{login __typename ... on Bot{id} ... on User{id}}}}}`, { o: owner, n: repo });
  const actor = (rq.data?.repository?.suggestedActors?.nodes || []).find(x => x.login === AGENT);
  let assigned = 'NOT-ASSIGNED';
  if (actor && issue.node_id) {
    const m = await gql(`mutation($a:ID!,$b:ID!){replaceActorsForAssignable(input:{assignableId:$a,actorIds:[$b]}){assignable{... on Issue{number}}}}`, { a: issue.node_id, b: actor.id });
    assigned = m.errors ? ('ERR ' + JSON.stringify(m.errors).slice(0, 100)) : `assigned ${AGENT}`;
  }
  const msg = `🔴 ${today} — main CI ${conclusion}. Opened fix issue #${issue.number} and ${assigned}. (1/1 daily cap used.) (${spend})`;
  console.log(msg); if (logNo) await logLine(logNo, msg);
})().catch(e => { console.error('nightly-medic error: ' + e.message); process.exit(1); });

// Exported for .github/scripts/nightly-medic.test.mjs only -- inert for the curl+node runtime
// path above (ESM named exports don't execute anything; the IIFE above still runs exactly as
// it always has when this file is invoked directly).
export { findLogIssue };
