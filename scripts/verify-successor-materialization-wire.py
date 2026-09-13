"""Produce a synthetic receipt using the actual CTO source-owned publisher.

Usage: python scripts/verify-successor-materialization-wire.py MATERIALIZER_DIRECTORY
Uses an in-memory S3 fixture. No AWS or document source access occurs.
"""
import base64
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import test_source_bound_publish as fixture

worker = fixture.source_bound
rows = [fixture.row('unknown/one.json'), fixture.row('unknown/two.json'), fixture.row('eligible.json')]
exclusions = []
for index, row in enumerate(rows[:2]):
    marker = str(index + 1) * 64
    exclusions.append({'proposal_key': marker, 'run_id': 'run_' + marker,
                       'operation_id': 'subop_' + marker, 'source_document_version': 'docv_' + marker,
                       'catalog_source_sha256': row['sha256'],
                       'source_path_sha256': hashlib.sha256(row['path'].encode()).hexdigest()})
request = {'operation': 'inspect', 'source_version_id': 'source-v1',
           'cohort_id': 'cfo-catalog-successor-unknown-20260912', 'policy_sha256': 'b' * 64,
           'source_prefixes': [], 'source_scope': 'all_cfo_source_documents',
           'quarantine_exclusions': exclusions}
authority = [{key: value for key, value in request.items() if key != 'operation'} |
             {'allow_publish': True, 'expires_at': '2099-01-01T00:00:00Z'}]
source = fixture.raw(*rows)
inspected = worker.materialize.materialize(request, fixture.S3(source), authority, fixture.NOW)
s3 = fixture.S3(source)
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
                  'receipt_version': stored['version'], 'counts': result['counts']}))
