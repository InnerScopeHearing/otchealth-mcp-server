import { randomUUID } from 'node:crypto';
import { CloudBrowserError, type CloudBrowserSession, type CloudBrowserStore, type CloudBrowserTransport } from './contract.js';

/** Called only after the exact session is authenticated and locked; deletion remains the caller's final step. */
export async function stopOwnedSession(input: {
  store: CloudBrowserStore;
  transport: CloudBrowserTransport;
  session: CloudBrowserSession;
  lockOwner: string;
}): Promise<void> {
  let session = input.session;
  // Legacy/unleased records contain no authority to clear a separate human-login lease.
  if (session.loginLeaseOwner === undefined) {
    await input.transport.stop(session);
    return;
  }
  if (!input.store.releaseStoppedLoginLease) throw new CloudBrowserError('login_lease_cleanup_unavailable', 'The owned login session requires supported cleanup.');
  if (!session.providerStopped) {
    if (!session.providerStopToken) {
      session = { ...session, providerStopToken: randomUUID() };
      await input.store.saveSessionUnderLock(session, input.lockOwner);
    }
    await input.transport.stop(session);
    session = { ...session, providerStopped: true };
    await input.store.saveSessionUnderLock(session, input.lockOwner);
  }
  // Any store failure retains the stopped receipt, principal and lease token for an explicit retry.
  await input.store.releaseStoppedLoginLease(session, input.lockOwner);
}
