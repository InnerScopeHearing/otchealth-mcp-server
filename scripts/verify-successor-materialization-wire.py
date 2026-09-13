"""Produce a synthetic receipt using the actual CTO source-owned publisher.

Usage: python scripts/verify-successor-materialization-wire.py MATERIALIZER_DIRECTORY
Uses an in-memory S3 fixture. No AWS or document source access occurs.
"""
import base64
import hashlib
import json
import sys
from pathlib import Path

if len(sys.argv) < 2:
    raise SystemExit('MATERIALIZER_DIRECTORY is required')

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))


def verify_gateway_producer_fixture():
    """Exercise capture's raw-byte check with objects serialized by gateway code.

    The Node caller supplies only synthetic proposal, admission, and publication
    grant bytes, each produced by the gateway's own canonical serializer.  This
    keeps this compatibility regression free of AWS and source-document input.
    """
    import capture_completed_publication_exclusions as capture

    payload = json.load(sys.stdin)
    if set(payload) != {'config', 'objects'} or not isinstance(payload['objects'], list):
        raise SystemExit('invalid producer fixture')

    class Body:
        def __init__(self, data): self.data = data
        def iter_chunks(self, chunk_size=65536):
            for offset in range(0, len(self.data), chunk_size):
                yield self.data[offset:offset + chunk_size]
        def close(self): pass

    class S3:
        def __init__(self, records): self.records = records
        def list_objects_v2(self, **kwargs):
            prefix = kwargs['Prefix']
            return {'IsTruncated': False, 'Contents': [
                {'Key': key} for key in self.records if key.startswith(prefix) and '/runs/' in key
            ]}
        def get_object(self, **kwargs):
            record = self.records[kwargs['Key']]
            if kwargs.get('VersionId') not in (None, record['version_id']):
                raise AssertionError('pinned version changed')
            return {'VersionId': record['version_id'], 'Body': Body(record['raw'])}

    records = {}
    for item in payload['objects']:
        if set(item) != {'key', 'version_id', 'raw_base64'}:
            raise SystemExit('invalid producer object')
        records[item['key']] = {'version_id': item['version_id'],
                                'raw': base64.b64decode(item['raw_base64'], validate=True)}
    captured = capture.capture_from_s3(S3(records), 'synthetic-bucket', payload['config'])
    print(json.dumps({'status': 'passed', 'captured_items': len(captured['items'])}, separators=(',', ':')))


if len(sys.argv) == 3 and sys.argv[2] == '--verify-gateway-producer-fixture':
    verify_gateway_producer_fixture()
    raise SystemExit(0)

import test_source_bound_publish as fixture

worker = fixture.source_bound
rows = [fixture.row('unknown/one.json'), fixture.row('unknown/two.json'),
        fixture.row('already-published.json', sha256='3' * 64, enriched_sha256='3' * 64),
        fixture.row('eligible.json', sha256='4' * 64, enriched_sha256='4' * 64)]
exclusions = []
for index, row in enumerate(rows[:2]):
    marker = str(index + 1) * 64
    exclusions.append({'proposal_key': marker, 'run_id': 'run_' + marker,
                       'operation_id': 'subop_' + marker, 'source_document_version': 'docv_' + marker,
                       'catalog_source_sha256': row['sha256'],
                       'source_path_sha256': hashlib.sha256(row['path'].encode()).hexdigest()})
completed_digest = hashlib.sha256(b'synthetic-old-publication').hexdigest()
completed_manifest = {'schema': 'cfo-completed-publication-exclusion-manifest-v1',
                      'source_cohort_id': 'cfo-catalog-publish-20260909-live',
                      'producer_id': 'cfo-relationship-worker',
                      'items': [{'proposal_key': completed_digest, 'run_id': 'run_' + completed_digest,
                                 'source_document_version': 'docv_' + completed_digest,
                                 'catalog_source_sha256': rows[2]['sha256'],
                                 'source_path_sha256': hashlib.sha256(rows[2]['path'].encode()).hexdigest(),
                                 'publication_grant': {'key': 'graph-trial/synthetic/grant', 'version_id': 'grant-v1', 'sha256': completed_digest},
                                 'proposal': {'key': 'graph-trial/synthetic/proposal', 'version_id': 'proposal-v1', 'sha256': completed_digest},
                                 'admission': {'key': 'graph-trial/synthetic/admission', 'version_id': 'admission-v1', 'sha256': completed_digest}}]}
completed_raw = worker.materialize.completed_manifest.canonical(completed_manifest)
completed_sha = hashlib.sha256(completed_raw).hexdigest()
completed_pointer = worker.materialize.completed_manifest.pointer(
    completed_manifest, worker.materialize.completed_manifest.PREFIX + completed_sha + '.json', 'completed-v1')
request = {'operation': 'inspect', 'source_version_id': 'source-v1',
           'cohort_id': 'cfo-catalog-successor-unknown-20260912', 'policy_sha256': 'b' * 64,
           'source_prefixes': [], 'source_scope': 'all_cfo_source_documents',
           'quarantine_exclusions': exclusions,
           'completed_publication_exclusion_manifest': completed_pointer}
authority = [{key: value for key, value in request.items() if key != 'operation'} |
             {'allow_publish': True, 'expires_at': '2099-01-01T00:00:00Z'}]
source = fixture.raw(*rows)
inspect_s3 = fixture.S3(source)
inspect_s3.objects[completed_pointer['key']] = {'data': completed_raw, 'version': completed_pointer['version_id']}
inspected = worker.materialize.materialize(request, inspect_s3, authority, fixture.NOW)
s3 = fixture.S3(source)
s3.objects[completed_pointer['key']] = {'data': completed_raw, 'version': completed_pointer['version_id']}
result = worker.publish_source_bound({'operation': 'publish_source_bound', 'inspect_receipt': inspected,
                                     'inspect_receipt_sha256': worker.publish_inspected.digest(worker.publish_inspected.encode(inspected))},
                                    s3, authority, fixture.NOW)
stored = s3.objects[result['receipt_key']]
context = {key: result[key] for key in ('cohort_id', 'policy_sha256', 'source_scope', 'catalog_key', 'catalog_source_sha256')}
context['source_prefixes'] = []
context['materialization'] = {'catalog_content_sha256': result['catalog_content_sha256'],
                              'source_catalog_version_id': result['source_version_id'],
                              'materialization_receipt_key': result['receipt_key'],
                              'materialization_receipt_sha256': result['receipt_sha256'],
                              'catalog_version_id': result['catalog_version_id']}
print(json.dumps({'context': context, 'receipt_base64': base64.b64encode(stored['data']).decode(),
                  'receipt_version': stored['version'], 'counts': result['counts'],
                  'completed_publication_exclusion_manifest': result['completed_publication_exclusion_manifest']}))
