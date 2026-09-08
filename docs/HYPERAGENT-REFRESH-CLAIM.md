# Hyperagent refresh ownership

Previously, replicas called the single-use refresh-token endpoint before attempting the shared ETag write. A successful compare-and-swap afterward could not undo duplicate submission. An HTTP 401 also left a rejected access token usable until its recorded expiry.

The token store now claims the shared document before submission. The claim is a token-free, dead-status document carrying a random owner ID and start time. Old replicas reading that claimed family also fail closed. Only a confirmed claim owner submits the refresh grant. It persists the replacement using the claim ETag before returning the access token.

Other requests wait for that owner with a 20-second wall-clock deadline, a 200-attempt cap and individual 5-second store-operation limits. A 45-second-old claim is treated as an unknown outcome. There is no lease takeover or automatic replay of its refresh token. Unknown claim acknowledgement, endpoint response, or final persistence outcome fails closed. A final write that committed despite a lost acknowledgement can be adopted by a later read.

The transport retries HTTP 401 at most once for exactly `list_agents`, `list_threads` and `get_thread`. It passes the rejected token into the shared store, which adopts a different valid winner or claims a refresh. Writes and unknown tool names are never replayed. Source authorization and wrapper filtering are unchanged.

Synthetic tests cover simultaneous replicas on the same ETag and first-create race, concurrent rejected-token repair, lease waiting and abandonment, store deadlines, uncertain endpoint/persistence outcomes, missing rotation material, consent replacement, retry limits, write non-replay and existing source-ring isolation. No live credential or source record is used.

Deployment precautions: confirm the runtime code path and image before deploying; source callers should be quiesced while old code drains because an old request that already read the pre-claim token cannot obey the new claim. Keep both replicas on the same configured bootstrap family. The existing bootstrap-family replacement behavior does not order concurrent configuration changes, so do not roll out conflicting consent credentials. An already-consumed token cannot be repaired by code; an unknown/dead chain requires authoritative recovery or fresh owner consent, never a manual replay of the old token.
