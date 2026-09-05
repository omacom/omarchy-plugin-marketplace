import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Run the real public rechecks in an isolated process. Only the upstream inspection
// and update-subject boundaries are inert fakes. All GitHub calls are intercepted;
// no community code, network, scanner, registry write or publication is permitted.
test("listing and update live rechecks reject stale approvals before evidence can authorize them", () => {
  const script = `
    import assert from "node:assert/strict";
    import { mock } from "node:test";
    const root = new URL(process.env.REVIEW_ROOT);
    const sha = "a".repeat(40);
    const repo = "example/plugin";
    const inspect = async () => ({ commitSha: sha, repository: repo, manifests: [{ id: "example.plugin" }] });
    mock.module(new URL("scripts/build-catalog.mjs", root).href, {
      namedExports: { inspectSubmission: inspect, inspectListedPluginSource: inspect },
    });
    const updateDomain = await import(new URL("scripts/plugin-update.mjs", root));
    mock.module(new URL("scripts/plugin-update.mjs", root).href, {
      namedExports: {
        ...updateDomain,
        parsePluginUpdateRequest: () => ({ repoUrl: "https://github.com/" + repo, pluginId: "example.plugin" }),
        sourceForPluginUpdate: () => ({ repo: "https://github.com/" + repo }),
        resolvePluginUpdate: () => ({ pluginIds: ["example.plugin"] }),
      },
    });
    const { serializeSecurityBaselineMarker } = await import(new URL("scripts/security-baseline-record.mjs", root));
    const { recheckApprovalState } = await import(new URL("scripts/approve-submission.mjs", root));
    const { recheckPluginUpdateApproval } = await import(new URL("scripts/approve-plugin-update.mjs", root));
    const first = { id: 100, event: "labeled", label: { name: "approved-and-verified" }, actor: { login: "maintainer" }, created_at: "2026-09-04T21:49:24Z" };
    const triggeredAt = "2026-09-04T21:49:25Z";
    const removed = { ...first, id: 101, event: "unlabeled", created_at: "2026-09-04T21:49:30Z" };
    const second = { ...first, id: 102, created_at: "2026-09-04T21:50:00Z" };
    const marker = serializeSecurityBaselineMarker({
      baselineVersion: "3", repository: repo, pluginIds: ["example.plugin"],
      commitSha: sha, checkedAt: "2026-09-04T21:40:00.000Z",
      outcome: "passed", enforcementMode: "selective", findings: [], capabilities: [],
    });
    let issue, events;
    let permission = "write";
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
      assert.ok(!options.method || options.method === "GET", "No remote mutation may be attempted");
      const path = new URL(url).pathname;
      calls.push(path);
      let payload;
      if (path === "/repos/example/marketplace/issues/3380") payload = issue;
      else if (path === "/repos/example/marketplace/issues/3380/events") payload = events;
      else if (path === "/repos/example/marketplace/issues/3380/comments") payload = [{
        id: 200, user: { login: "github-actions[bot]" }, body: marker,
        created_at: "2026-09-04T21:40:01Z", updated_at: "2026-09-04T21:40:01Z",
      }];
      else if (path === "/repos/example/marketplace/collaborators/maintainer/permission") payload = { permission };
      else throw new Error("Unexpected request: " + url);
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    };
    const options = {
      repositoryName: "example/marketplace", issueNumber: 3380, token: "inert-token",
      approvedIssueBody: "approved body", approvedIssueTitle: "[Verify]: Example",
      repoUrl: "https://github.com/" + repo, approver: "maintainer",
      expectedRequestedAt: triggeredAt, expectedManualSetup: false,
    };
    for (const [type, check] of [["submission", recheckApprovalState], ["plugin-update", recheckPluginUpdateApproval]]) {
      issue = { state: "open", body: options.approvedIssueBody, title: options.approvedIssueTitle,
        labels: [type, "validated", "approved-and-verified"].map((name) => ({ name })) };
      events = [first];
      calls.length = 0;
      let result = await check(options);
      assert.equal(result.decision.eventId, first.id);
      assert.equal(result.decision.requestedAt, first.created_at);
      // No additional history request is introduced by trigger resolution.
      assert.equal(calls.splice(0).filter((path) => path.endsWith("/events")).length, 1);
      if (type === "submission") {
        issue.title = "[Plugin]: Transient title";
        await assert.rejects(check(options), { code: "approval-body-changed" });
        issue.title = options.approvedIssueTitle;
      }
      result = await check({
        ...options,
        expectedEventId: first.id,
        expectedRequestedAt: first.created_at,
        expectedTriggeredAt: triggeredAt,
      });
      assert.equal(result.decision.eventId, first.id);
      // Rechecks do not retain the initial one-second compatibility allowance.
      await assert.rejects(check({
        ...options,
        expectedEventId: first.id,
        expectedTriggeredAt: triggeredAt,
      }), { code: "approval-event-invalid" });
      const exact = { ...first, id: 104, created_at: triggeredAt };
      events = [exact];
      result = await check(options);
      assert.equal(result.decision.eventId, exact.id);
      events = [first, exact];
      await assert.rejects(check(options), { code: "approval-event-invalid" });
      await assert.rejects(check({
        ...options,
        expectedEventId: exact.id,
        expectedRequestedAt: exact.created_at,
        expectedTriggeredAt: triggeredAt,
      }), { code: "approval-event-invalid" });
      const delayed = { ...first, id: 103, created_at: triggeredAt };
      events = [first, delayed];
      await assert.rejects(check(options), { code: "approval-event-invalid" });
      await assert.rejects(check({
        ...options,
        expectedEventId: first.id,
        expectedRequestedAt: first.created_at,
        expectedTriggeredAt: triggeredAt,
      }), { code: "approval-event-invalid" });
      events = [first, removed, second];
      await assert.rejects(check(options), { code: "approval-event-invalid" });
      await assert.rejects(check({
        ...options,
        expectedEventId: first.id,
        expectedRequestedAt: first.created_at,
        expectedTriggeredAt: triggeredAt,
      }), { code: "approval-event-invalid" });
      result = await check({ ...options, expectedRequestedAt: second.created_at });
      assert.equal(result.decision.eventId, second.id);
      events = [first, { ...removed, created_at: first.created_at }, { ...second, created_at: first.created_at }];
      await assert.rejects(check(options), { code: "approval-event-invalid" });
      events = [first];
      permission = "read";
      await assert.rejects(check(options), { code: type === "submission" ? "approval-permission-denied" : "update-permission-denied" });
      permission = "write";
      issue.labels = issue.labels.filter((label) => label.name !== "approved-and-verified");
      await assert.rejects(check(options), { code: type === "submission" ? "approval-label-missing" : "update-label-missing" });
      issue.labels.push({ name: "approved-and-verified" });
      if (type === "submission") {
        // Remmina/Steelseries: add manual-setup after approval. Pomodoro: remove it.
        issue.labels.push({ name: "manual-setup" });
        await assert.rejects(check(options), { code: "approval-label-changed" });
        issue.labels = issue.labels.filter((label) => label.name !== "manual-setup");
        await assert.rejects(check({ ...options, expectedManualSetup: true }), { code: "approval-label-changed" });
      }
      await assert.rejects(check({ ...options, expectedRequestedAt: undefined }), { code: "approval-event-invalid" });
    }
    console.log("Both real recheck paths passed the approval race matrix.");
  `;
  const result = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 30000,
    env: { PATH: process.env.PATH, REVIEW_ROOT: new URL("../", import.meta.url).href, GITHUB_TOKEN: "", GH_TOKEN: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Both real recheck paths passed/);
});
