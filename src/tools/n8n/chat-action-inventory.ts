import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { listChatActionInventory } from '../../agentstate/store.js';
import { COMPANY_CHAT_ACTION_LANES } from '../../agentstate/chat-action-metadata.js';
import { currentCallerAgent } from '../../server/request-context.js';
import { registerTool, type CallerHashProvider } from '../registry.js';

const jobId = z.string().regex(/^caj_[a-f0-9]{64}$/);
const inputSchema = z.object({ owner: z.enum(COMPANY_CHAT_ACTION_LANES), cursor: jobId.optional(), page_size: z.number().int().min(1).max(50).optional() }).strict();
const recordSchema = z.object({ id: jobId, status: z.enum(['queued','running','succeeded','failed']), action: z.enum(['brain_search','checkpoint']), caller_agent: z.enum(COMPANY_CHAT_ACTION_LANES), created_at: z.string().datetime(), updated_at: z.string().datetime() });
type Input = z.infer<typeof inputSchema>;
type Deps = { query: typeof listChatActionInventory; register?: typeof registerTool };
const defaults: Deps = { query: listChatActionInventory };

export async function handleChatActionInventory(input: Input, ctx: {callerAgent:string}, deps: Deps = defaults) {
  if (ctx.callerAgent !== 'cto') throw new Error('inventory_forbidden');
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error('inventory_invalid_input');
  const {owner, cursor, page_size} = parsed.data;
  const limit = page_size ?? 25;
  const rows = await deps.query({ owner, after:cursor ?? '', limit:limit+1 });
  // Validate every selected row before exposing anything. Strip any unexpected adapter fields.
  const valid = rows.map((value) => {
    const row = recordSchema.safeParse(value);
    if (!row.success || row.data.caller_agent !== owner || (cursor && row.data.id <= cursor)) throw new Error('inventory_invalid_record');
    return row.data;
  });
  if (valid.some((r,i) => i>0 && valid[i-1].id >= r.id) || valid.length>limit+1) throw new Error('inventory_invalid_record');
  const jobs=valid.slice(0,limit);
  return {data:{jobs,count:jobs.length,next_cursor:valid.length>limit ? jobs[jobs.length-1].id : null}, summary:`Returned ${jobs.length} company job metadata records.`};
}

export function registerChatActionInventory(server: McpServer, callerHash: CallerHashProvider, deps: Deps = defaults): void {
  const caller = currentCallerAgent();
  if (caller && caller !== 'cto') return;
  (deps.register ?? registerTool)(server, {
    name:'chat_action_inventory', category:'read',
    authorizeBeforeInput: (_input,caller) => caller === 'cto' ? null : {code:'inventory_forbidden',message:'Inventory is restricted to the CTO lane.'},
    annotations:{title:'Inspect company Chat action metadata',description:'CTO-only, read-only metadata for one company lane. Uses bounded pages; no job payloads or results are returned.',readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
    inputShape:{owner:inputSchema.shape.owner,cursor:inputSchema.shape.cursor,page_size:inputSchema.shape.page_size},
    outputShape:{jobs:z.array(recordSchema),count:z.number(),next_cursor:jobId.nullable()},
    handler:(input,ctx)=>handleChatActionInventory(input,ctx,deps),
  },callerHash);
}
