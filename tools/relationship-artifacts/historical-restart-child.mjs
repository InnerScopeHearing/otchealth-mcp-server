import { readFileSync, writeFileSync } from "node:fs";
import { createTwoRunHistoricalFixture } from "./historical-restart-fixture.mjs";
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
try { const f = await createTwoRunHistoricalFixture({ journalDirectory: input.journalDirectory, flags: input.flags ?? {}, snapshot: input.snapshot }); const result = await f.host.retrieve(f.query); await f.routes.close(); writeFileSync(process.argv[3], JSON.stringify({ ok: true, result })); }
catch (error) { writeFileSync(process.argv[3], JSON.stringify({ ok: false, code: error.code ?? error.message })); }
