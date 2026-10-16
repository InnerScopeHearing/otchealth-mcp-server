import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hideDeniedWefunderChatActions } from './wefunder-visibility.js';

test('WeFunder visibility hides only the denied n8n chat-action bridge', () => {
  const input = [
    'catalog_probe',
    'chat_action_submit',
    'chat_action_status',
    'chat_action_result',
    'browser_broker_preflight',
    'browser_broker_inspect_public',
    'browser_cloud_profile_discover',
    'browser_cloud_session_start',
    'browser_cloud_login_start',
    'github_push_files',
  ];

  assert.deepEqual(hideDeniedWefunderChatActions(input), [
    'catalog_probe',
    'browser_broker_preflight',
    'browser_broker_inspect_public',
    'browser_cloud_profile_discover',
    'browser_cloud_session_start',
    'browser_cloud_login_start',
    'github_push_files',
  ]);
  assert.deepEqual(input, [
    'catalog_probe',
    'chat_action_submit',
    'chat_action_status',
    'chat_action_result',
    'browser_broker_preflight',
    'browser_broker_inspect_public',
    'browser_cloud_profile_discover',
    'browser_cloud_session_start',
    'browser_cloud_login_start',
    'github_push_files',
  ], 'visibility projection does not mutate its source allowlist');
});

