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
  const q = `repo:${REPO} in:title "Nightly Medic Log" type:issue state:open`;
  const s = await j(await fetch(`${API}/search/issues?q=${encodeURIComponent(q)}`, { headers: H }));
  return (s.items || [])[0];
}
async function logLine(issueNumber, body) {
  await fetch(`${API}/repos/${REPO}/issues/${issueNumber}/comments`, { method: 'POST', headers: H, body: JSON.stringify({ body }) });
}

(async () => {
  if (!PAT) { console.error('GH_PAT required'); process.exit(1); }
  const log = await findLogIssue();
  const logNo = log?.number;

  // 1) Did the latest completed CI on main fail?
  const runs = await j(await fetch(`${API}/repos/${REPO}/actions/runs?branch=main&status=completed&per_page=5`, { headers: H }));
  const latest = (runs.workflow_runs || []).filter(r => r.event !== 'dynamic')[0] || (runs.workflow_runs || [])[0];
  const conclusion = latest?.conclusion;
  const failing = ['failure', 'timed_out', 'startup_failure'].includes(conclusion);

  // 2) Daily cap: if we already acted today (open issue labeled nightly-fix created today), skip.
  const openFix = await j(await fetch(`${API}/repos/${REPO}/issues?labels=nightly-fix&state=open&per_page=10`, { headers: H }));
  const actedToday = (Array.isArray(openFix) ? openFix : []).some(i => (i.created_at || '').slice(0, 10) === today);

  if (!failing) {
    const msg = `🟢 ${today} — main CI is ${conclusion || 'unknown'} (run: ${latest?.html_url || 'n/a'}). No action, $0 spend.`;
    console.log(msg); if (logNo) await logLine(logNo, msg); return;
  }
  if (actedToday) {
    const msg = `🟡 ${today} — main CI failing but a nightly-fix task was already opened today (daily cap = 1). Skipping to bound spend.`;
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
  const msg = `🔴 ${today} — main CI ${conclusion}. Opened fix issue #${issue.number} and ${assigned}. (1/1 daily cap used.)`;
  console.log(msg); if (logNo) await logLine(logNo, msg);
})().catch(e => { console.error('nightly-medic error: ' + e.message); process.exit(1); });
