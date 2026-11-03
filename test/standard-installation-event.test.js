import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { approvalDecisionForEvents } from "../scripts/approve-submission.mjs";
import { resolveStandardInstallationEvent } from "../scripts/standard-installation-event.mjs";

const reviewer = "HANCORE-linux";
const triggeredAt = "2026-11-01T12:27:40Z";
function transition(id, created_at, event = "labeled", login = reviewer, label = "standard-installation-approved") {
  return { id, created_at, event, actor: { login }, label: { name: label } };
}
// Issue #13539, run 41306602337: the label event is one second before issue.updated_at.
const approval = transition(34830658131, "2026-11-01T12:27:39Z");

test("resolves real approvals recorded one second before issue.updated_at", () => {
  assert.deepEqual(resolveStandardInstallationEvent([approval], reviewer, triggeredAt), {
    id: 34830658131,
    createdAt: "2026-11-01T12:27:39Z",
  });
  assert.equal(resolveStandardInstallationEvent([transition(1, triggeredAt)], reviewer, triggeredAt).id, 1);

  // Issue #12569, runs 39733286664 and 39733626753: both attempts were one second early.
  const first = transition(33920286194, "2026-10-22T06:20:03Z");
  const removed = transition(33920483866, "2026-10-22T06:23:18Z", "unlabeled");
  const second = transition(33920486678, "2026-10-22T06:23:20Z");
  assert.equal(resolveStandardInstallationEvent([first], reviewer, "2026-10-22T06:20:04Z").id, first.id);
  assert.equal(
    resolveStandardInstallationEvent([first, removed, second], reviewer, "2026-10-22T06:23:21Z").id,
    second.id,
  );
});

test("rejects stale, future, ambiguous, removed, foreign, or invalid approval transitions", () => {
  const rejected = [
    [],
    [transition(1, "2026-11-01T12:27:38Z")],
    [transition(1, "2026-11-01T12:27:41Z")],
    [approval, transition(2, triggeredAt)],
    [approval, transition(2, triggeredAt, "unlabeled")],
    [approval, transition(2, triggeredAt, "labeled", "other")],
    [transition(1, triggeredAt, "labeled", "other")],
    [transition(0, triggeredAt)],
    [transition(1, "invalid")],
    [transition(1, "2026-11-01T12:27:40.123Z")],
  ];
  for (const events of rejected) {
    assert.throws(() => resolveStandardInstallationEvent(events, reviewer, triggeredAt), {
      code: "approval-event-invalid",
    });
  }
  assert.throws(() => resolveStandardInstallationEvent([approval], reviewer, "invalid"), {
    code: "approval-event-invalid",
  });
});

test("keeps the two approval labels separate", () => {
  const listing = transition(2, triggeredAt, "labeled", reviewer, "approved-and-verified");
  assert.equal(resolveStandardInstallationEvent([approval, listing], reviewer, triggeredAt).id, approval.id);
  assert.equal(
    approvalDecisionForEvents([approval, listing], { approver: reviewer, expectedRequestedAt: triggeredAt }).eventId,
    listing.id,
  );
  assert.throws(
    () => approvalDecisionForEvents([approval], { approver: reviewer, expectedRequestedAt: triggeredAt }),
    { code: "approval-event-invalid" },
  );
});

test("workflow keeps permission checks and binds publication to the resolved event time", async () => {
  const workflow = await readFile(new URL("../.github/workflows/verify-plugin.yml", import.meta.url), "utf8");
  const authorization = workflow.slice(
    workflow.indexOf("- name: Authorize standard installation approval"),
    workflow.indexOf("- name: Authorize maintainer verification revocation"),
  );
  assert.match(authorization, /node scripts\/standard-installation-event\.mjs "\$REVIEWER" "\$APPROVAL_REQUESTED_AT"/);
  assert.match(authorization, /collaborators\/\$\{REVIEWER\}\/permission/);
  assert.match(authorization, /admin\|maintain\|write/);
  assert.match(authorization, /echo "event_time=\$\{event_time\}"/);
  assert.equal((workflow.match(/expected_installation_transition=.*STANDARD_INSTALLATION_APPROVAL_REQUESTED_AT/g) || []).length, 2);
  assert.equal(
    (workflow.match(/STANDARD_INSTALLATION_APPROVAL_REQUESTED_AT: \$\{\{ needs\.analyze\.outputs\.standard_installation_approval_event_time \}\}/g) || []).length,
    2,
  );
  assert.match(workflow, /standard_installation_approval_event_time: \$\{\{ steps\.standard-installation-authorization\.outputs\.event_time \}\}/);
  assert.match(workflow, /STANDARD_INSTALLATION_APPROVAL_REQUESTED_AT: \$\{\{ steps\.standard-installation-authorization\.outputs\.event_time \}\}/);
});
