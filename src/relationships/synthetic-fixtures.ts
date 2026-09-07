import type { AssertionClass, RelationshipPredicate } from './schema.js';
import { canonicalJson, sha256 } from './schema.js';

export type SyntheticFixtureId = 'alpha_depends_beta' | 'beta_depends_gamma' | 'alpha_candidate_delta' | 'alpha_depends_zeta_correction' | 'retract_alpha_zeta';

export interface SyntheticAssertionFixture {
  operation: 'assert'; subject: string; predicate: RelationshipPredicate; object: string;
  assertionClass: AssertionClass; validFrom: string; validTo: string | null; supersedesFixture?: SyntheticFixtureId;
}
export interface SyntheticRetractionFixture {
  operation: 'retract'; retractsFixture: SyntheticFixtureId; effectiveValidFrom: string;
}
export type SyntheticFixture = SyntheticAssertionFixture | SyntheticRetractionFixture;
export const FIXTURES = Object.freeze({
  alpha_depends_beta: {
    operation: 'assert', subject: 'synthetic_service_alpha', predicate: 'depends_on', object: 'synthetic_service_beta',
    assertionClass: 'fact', validFrom: '2026-01-01T00:00:00Z', validTo: null,
  },
  beta_depends_gamma: {
    operation: 'assert', subject: 'synthetic_service_beta', predicate: 'depends_on', object: 'synthetic_service_gamma',
    assertionClass: 'fact', validFrom: '2026-01-01T00:00:00Z', validTo: null,
  },
  alpha_candidate_delta: {
    operation: 'assert', subject: 'synthetic_service_alpha', predicate: 'hosted_on', object: 'synthetic_service_delta',
    assertionClass: 'candidate', validFrom: '2026-01-01T00:00:00Z', validTo: null,
  },
  alpha_depends_zeta_correction: {
    operation: 'assert', subject: 'synthetic_service_alpha', predicate: 'depends_on', object: 'synthetic_service_zeta',
    assertionClass: 'fact', validFrom: '2026-02-01T00:00:00Z', validTo: null, supersedesFixture: 'alpha_depends_beta',
  },
  retract_alpha_zeta: {
    operation: 'retract', retractsFixture: 'alpha_depends_zeta_correction', effectiveValidFrom: '2026-04-01T00:00:00Z',
  },
} satisfies Record<string, SyntheticFixture>);
export function syntheticEvidence(fixtureId: SyntheticFixtureId) {
  const fixtureBytes = canonicalJson(FIXTURES[fixtureId]);
  return [{
    source_uri: `synthetic://relationship-pilot/${fixtureId}`,
    source_sha256: sha256(`source\0${fixtureBytes}`),
    excerpt_sha256: sha256(`excerpt\0${fixtureBytes}`),
    locator: { kind: 'json_pointer' as const, value: `/fixtures/${fixtureId}` },
    ring: 'commons' as const,
    extractor: { kind: 'deterministic' as const, name: 'relationship-pilot-fixture' as const, version: '1' as const },
  }];
}
