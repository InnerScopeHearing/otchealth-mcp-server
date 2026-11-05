# Approval health fingerprint redaction

The unauthenticated gateway and approval-broker health responses previously included unsalted
SHA-256 fingerprints of three shared approval secrets. The public endpoints now retain only the
public JWK fingerprint and existing configuration booleans. They also omit the unsalted owner
subject fingerprint, which could reveal a predictable identifier. They do not publish secret values or
secret-derived fingerprints. This change does not rotate credentials or change approval behavior.

The historical Azure-only deploy workflow compares the removed fields and will fail its
compatibility check if run. That workflow is disarmed and its target infrastructure was retired.
Any future replacement must implement a separately authenticated compatibility check; public
hashes must not be restored. GitHub default-branch search found no other checked-in consumer
of these field names in the organization at this review point. Unknown external consumers are not
ruled out. Validate monitoring and rollout compatibility before deployment.
