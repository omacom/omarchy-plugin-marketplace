import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveStandardInstallationEvent } from '../scripts/standard-installation-event.mjs';
const time = '2026-11-01T12:27:40Z';
const event = (id = 34830658131, created_at = '2026-11-01T12:27:39Z', actor = 'HANCORE-linux', action = 'labeled') => ({id, created_at, actor: {login: actor}, event: action, label: {name: 'standard-installation-approved'}});
test('resolves the real approval with GitHub issue timestamp one second later', () => {
  assert.deepEqual(resolveStandardInstallationEvent([event()], 'HANCORE-linux', time), {id:34830658131, createdAt:'2026-11-01T12:27:39Z'});
  assert.equal(resolveStandardInstallationEvent([event(1, time)], 'HANCORE-linux', time).id, 1);
});
test('rejects stale, future, ambiguous, removed or replaced approval transitions', () => {
  for (const events of [[], [event(1, '2026-11-01T12:27:38Z')], [event(1, '2026-11-01T12:27:41Z')], [event(1),event(2,time)], [event(1),event(2,time,'HANCORE-linux','unlabeled')], [event(1),event(2,time,'other')], [event(0)], [event(1,'invalid')]]) {
    assert.throws(()=>resolveStandardInstallationEvent(events,'HANCORE-linux',time));
  }
  assert.throws(()=>resolveStandardInstallationEvent([event()],'HANCORE-linux','invalid'));
});
test('workflow preserves permission checks and binds analysis to the resolved event time', async () => {
  const {readFile} = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/verify-plugin.yml', import.meta.url), 'utf8');
  const authorization = workflow.slice(workflow.indexOf('- name: Authorize standard installation approval'), workflow.indexOf('- name: Authorize maintainer verification revocation'));
  assert.match(authorization, /node scripts\/standard-installation-event\.mjs "\$REVIEWER" "\$APPROVAL_REQUESTED_AT"/);
  assert.match(authorization, /collaborators\/\$\{REVIEWER\}\/permission/);
  assert.match(authorization, /admin\|maintain\|write/);
  assert.match(authorization, /echo "event_time=\$\{event_time\}"/);
  assert.equal((workflow.match(/expected_installation_transition=.*STANDARD_INSTALLATION_APPROVAL_REQUESTED_AT/g) || []).length, 2);
  assert.equal((workflow.match(/STANDARD_INSTALLATION_APPROVAL_REQUESTED_AT: \$\{\{ needs\.analyze\.outputs\.standard_installation_approval_event_time \}\}/g) || []).length, 2);
  assert.match(workflow, /standard_installation_approval_event_time: \$\{\{ steps\.standard-installation-authorization\.outputs\.event_time \}\}/);
  assert.match(workflow, /STANDARD_INSTALLATION_APPROVAL_REQUESTED_AT: \$\{\{ steps\.standard-installation-authorization\.outputs\.event_time \}\}/);
});
