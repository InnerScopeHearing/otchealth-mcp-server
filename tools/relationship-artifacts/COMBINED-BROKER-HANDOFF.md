# Combined gateway broker validation

This draft follows PR327 at 001352694c2baecb20c33116d29a9339ec6f3c8f. It integrates ef555169045524395e1a35c735df407c0c69b0bf followed by aba8cf89f0c0a08f6930ab4658cf7c95e3174b17 as a2d3de9 and aea9115. Superseded 98c48bd was not imported.

The graph worker broker validates immutable subscription review results against the prepared source witness, reviewed provider identity and exact request bundle. It preserves negative and uncertain forms and rejects mismatched requests before persistence. Existing durable publication and scheduler behavior is retained.

Current main was fetched read-only at 796c62faf268460e7d75fe6087dfd7f4f1053e87. Git merge-tree --write-tree HEAD origin/main returned a clean merge tree 9aefd8d2a4bd8b92645e5afbb44da3da199c392e, exit 0. This establishes source merge compatibility; main was not merged and this is not a runtime deployment test.

Combined validation passed 72 gateway relationship and broker tests with zero skips, plus production TypeScript compilation. Actual CTO factories came from PR191 integration head aa7e91674fbb3865bd6adfbbb9e14787d10a0f84. The real provider/broker-client/operation-store wire acceptance passed negative and uncertain review results, mismatched request rejection and replay without a second model call. Transport and model output were synthetic; no AWS or live model calls occurred.

Saved results: combined-broker-test-output.txt and combined-broker-wire-output.txt. The coordinator remains sole release owner. Production registry binding, persistent host installation, policy activation and live verification remain separate dependencies. PR316 and CTO PR190 holds are unchanged. No deployment or activation is included.
