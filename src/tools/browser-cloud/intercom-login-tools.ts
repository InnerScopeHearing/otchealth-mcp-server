import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool, type CallerHashProvider } from '../registry.js';
import { currentIntercomPrincipalKey, type IntercomLoginService } from './intercom-login-service.js';

export function registerIntercomBrowserLoginTool(server: McpServer, callerHash: CallerHashProvider, runtime: () => IntercomLoginService): void {
  registerTool(server, {
    name:'browser_cloud_intercom_login_start', category:'write_simple',
    annotations:{ title:'Connect my Intercom cloud browser', description:'Prepare a persistent cloud browser for this authenticated COO connection and the company workspace ID supplied by its owner. Returns a short-lived human sign-in link. Passwords and MFA stay inside the provider window; never store the link in Brain. Saved browser state remains separate for each connection.', readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true },
    inputShape:{workspace_id:z.string().regex(/^[A-Za-z0-9]{3,32}$/),workspace_host:z.enum(['app.intercom.com','app.eu.intercom.com','app.au.intercom.com']).default('app.intercom.com')},
    outputShape:{login_url:z.string().optional(),profile_id:z.string().optional(),session_id:z.string().optional(),expires_at:z.number().optional(),status:z.string().optional(),dry_run:z.boolean().optional(),error:z.string().optional()},
    ephemeralOutput:true,
    redactResultForLog:()=>({status:'human_login_required', capability:'redacted'}),
    handler:async(input,ctx)=>{
      if(ctx.callerAgent!=='coo') return {data:{error:'coo_connection_required'},summary:'Use the authenticated COO connection.'};
      if(ctx.dryRun) return {data:{dry_run:true},summary:'No browser profile or sign-in session was created.'};
      try {return {data:await runtime().start(currentIntercomPrincipalKey(),input.workspace_id,input.workspace_host),summary:'Open this short-lived link and sign in to the company workspace Settings. After sign-in, click Done. Keep this link out of shared memory.'};}
      catch(error){return {data:{error:error && typeof error==='object' && 'code' in error?String(error.code):'intercom_login_unavailable'},summary:'Cloud sign-in preparation did not complete. No authentication is claimed.'};}
    }
  },callerHash);
}
