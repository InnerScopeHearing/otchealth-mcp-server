#!/usr/bin/env python3
"""Read the deployed Intercom metadata canaries without logging provider/account bodies."""
import json
import os
import urllib.error
import urllib.request

OPS = {'identifyAdmin', 'listDataConnectors', 'listContentImportSources', 'listOfficeHoursSchedules', 'listAudiences', 'get__export_reporting_data_get_datasets', 'getIpAllowlist'}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def main():
    token = os.environ.get('ADMIN_REVOKE_TOKEN')
    if not token:
        print(json.dumps({'status': 'blocked', 'error': 'admin_probe_auth_not_configured'}))
        return 1
    req = urllib.request.Request('https://mcp.otchealth.app/health/intercom', headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
    try:
        opener = urllib.request.build_opener(NoRedirect())
        try:
            response = opener.open(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.code
            raw = response.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        data = json.loads(raw)
        checks = data.get('checks', [])
        if not isinstance(checks, list) or len(checks) > 7:
            raise ValueError()
        safe_checks = []
        for check in checks:
            if not isinstance(check, dict) or check.get('operation_id') not in OPS:
                raise ValueError()
            safe_checks.append({'operation_id': check['operation_id'], 'state': 'ready' if check.get('state') == 'ready' else 'blocked', 'http_status': check.get('http_status') if type(check.get('http_status')) is int else 0})
        ready = status == 200 and data.get('ready') is True and len(safe_checks) == 7 and {x['operation_id'] for x in safe_checks} == OPS and all(x['state'] == 'ready' and 200 <= x['http_status'] < 300 for x in safe_checks)
        print(json.dumps({'status': 'passed' if ready else 'blocked', 'api_version': '2.17', 'configured': data.get('configured') is True, 'checks': safe_checks, 'scope': 'configuration GETs only; no runtime/write acceptance'}))
        return 0 if ready else 1
    except Exception:
        print(json.dumps({'status': 'blocked', 'error': 'intercom_probe_failed'}))
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
