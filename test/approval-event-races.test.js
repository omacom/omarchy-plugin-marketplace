import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  approvalDecisionForEvents,
  githubIssueComments,
  githubIssueEvents,
} from "../scripts/approve-submission.mjs";
import { publicSubmissionFailure } from "../scripts/submission-feedback.mjs";

const root = new URL("../", import.meta.url);
const actor = "maintainer";
const firstTime = "2026-09-04T21:49:24Z";
const secondTime = "2026-09-04T21:50:00Z";
function transition(id, created_at, event = "labeled", login = actor) {
  return { id, created_at, event, actor: { login }, label: { name: "approved-and-verified" } };
}
const first = transition(100, firstTime);
const removed = transition(101, "2026-09-04T21:49:30Z", "unlabeled");
const second = transition(102, secondTime);
const initial = { approver: actor, expectedRequestedAt: firstTime };
const productionIssue = Object.freeze({
  repository: "omacom/omarchy-plugin-marketplace",
  number: "3322",
  title: "[Plugin]: Steelseries mouse controllers",
  submissionRepository: "Djjamonconqueso/steelseries.mouse-controller",
  approver: "HANCORE-linux",
  manualSetup: true,
  triggeredAt: "2026-09-05T16:22:31Z",
  eventId: 30612835180,
  requestedAt: "2026-09-05T16:22:30Z",
});
// Exact approval-label history through the failed #3322 run; later live transitions
// are exercised separately at the final publication boundary below.
const productionApprovalHistory = Object.freeze([
  transition(30574873638, "2026-09-04T18:44:54Z", "labeled", "HANCORE-linux"),
  transition(30578870183, "2026-09-04T20:05:16Z", "unlabeled", "github-actions[bot]"),
  transition(30602247282, "2026-09-05T09:22:59Z", "labeled", "HANCORE-linux"),
  transition(30602278011, "2026-09-05T09:24:25Z", "unlabeled", "github-actions[bot]"),
  transition(productionIssue.eventId, productionIssue.requestedAt, "labeled", productionIssue.approver),
]);
const productionIssue4116 = Object.freeze({
  repository: "omacom/omarchy-plugin-marketplace",
  number: "4116",
  title: "[Plugin]: Plugin Switcher",
  submissionRepository: "houz42/omarchy-plugin-switcher",
  approver: "HANCORE-linux",
  manualSetup: false,
  triggeredAt: "2026-09-05T18:43:59Z",
  eventId: 30616991870,
  requestedAt: "2026-09-05T18:43:58Z",
});
const productionApprovalHistory4116 = Object.freeze([
  transition(30575208949, "2026-09-04T18:51:12Z", "labeled", "HANCORE-linux"),
  transition(30580502956, "2026-09-04T20:37:18Z", "unlabeled", "github-actions[bot]"),
  transition(
    productionIssue4116.eventId,
    productionIssue4116.requestedAt,
    "labeled",
    productionIssue4116.approver,
  ),
]);
const productionIncidents = Object.freeze({
  [productionIssue.number]: Object.freeze({
    ...productionIssue,
    history: productionApprovalHistory,
  }),
  [productionIssue4116.number]: Object.freeze({
    ...productionIssue4116,
    history: productionApprovalHistory4116,
  }),
});

function rejected(events, options = initial) {
  assert.throws(() => approvalDecisionForEvents(events, options), { code: "approval-event-invalid" });
}

test("approval admission selects only the unique trigger, and rechecks preserve its exact identity", () => {
  const events = [first, { event: "commented" }];
  const decision = approvalDecisionForEvents(events, initial);
  assert.deepEqual(decision, { eventId: 100, requestedAt: firstTime, reviewer: actor });
  assert.deepEqual(approvalDecisionForEvents(events, {
    ...initial,
    expectedEventId: decision.eventId,
    expectedRequestedAt: decision.requestedAt,
    expectedTriggeredAt: firstTime,
  }), decision);
  assert.deepEqual(approvalDecisionForEvents(events, {
    ...initial, expectedRequestedAt: "2026-09-04T21:49:24.000Z",
  }), decision);
});

test("production issue #3322 resolves its exact one-second GitHub lag and prior history", () => {
  const productionTrigger = {
    approver: productionIssue.approver,
    expectedRequestedAt: productionIssue.triggeredAt,
  };
  const decision = approvalDecisionForEvents(productionApprovalHistory, productionTrigger);
  assert.deepEqual(decision, {
    eventId: productionIssue.eventId,
    requestedAt: productionIssue.requestedAt,
    reviewer: productionIssue.approver,
  });
  assert.deepEqual(approvalDecisionForEvents(productionApprovalHistory, {
    ...productionTrigger,
    expectedEventId: decision.eventId,
    expectedRequestedAt: decision.requestedAt,
    expectedTriggeredAt: productionIssue.triggeredAt,
  }), decision);
  // Tolerance is initial-only: a recheck must use the event's actual timestamp.
  rejected(productionApprovalHistory, {
    ...productionTrigger,
    expectedEventId: decision.eventId,
    expectedTriggeredAt: productionIssue.triggeredAt,
  });
});

test("production issue #4116 independently resolves the same exact one-second lag", () => {
  const productionTrigger = {
    approver: productionIssue4116.approver,
    expectedRequestedAt: productionIssue4116.triggeredAt,
  };
  const decision = approvalDecisionForEvents(productionApprovalHistory4116, productionTrigger);
  assert.deepEqual(decision, {
    eventId: productionIssue4116.eventId,
    requestedAt: productionIssue4116.requestedAt,
    reviewer: productionIssue4116.approver,
  });
  assert.deepEqual(approvalDecisionForEvents(productionApprovalHistory4116, {
    ...productionTrigger,
    expectedEventId: decision.eventId,
    expectedRequestedAt: decision.requestedAt,
    expectedTriggeredAt: productionIssue4116.triggeredAt,
  }), decision);
});

test("GitHub issue pagination requires arrays of at most 100 records", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [acquire, code] of [
      [githubIssueEvents, "approval-event-invalid"],
      [githubIssueComments, "approval-security-baseline-invalid"],
    ]) {
      for (const batch of [{}, "not-an-array", Array.from({ length: 101 }, (_, id) => ({ id }))]) {
        let requests = 0;
        globalThis.fetch = async () => {
          requests += 1;
          return { ok: true, json: async () => batch };
        };
        await assert.rejects(
          () => acquire("example/marketplace", 1, "inert-token"),
          (error) => error?.code === code,
        );
        assert.equal(requests, 1);
      }

      const pages = [Array.from({ length: 100 }, (_, id) => ({ id })), []];
      let requests = 0;
      globalThis.fetch = async () => {
        const batch = pages[requests];
        requests += 1;
        return { ok: true, json: async () => batch };
      };
      assert.equal((await acquire("example/marketplace", 1, "inert-token")).length, 100);
      assert.equal(requests, 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("initial timestamp compatibility is asymmetric and limited to one second", () => {
  // The event must never be later than the webhook's issue.updated_at.
  rejected([first], { approver: actor, expectedRequestedAt: "2026-09-04T21:49:23Z" });
  // An event two seconds before issue.updated_at remains invalid.
  rejected([first], { approver: actor, expectedRequestedAt: "2026-09-04T21:49:26Z" });
  // A unique event in the one-second fallback still requires the triggering actor.
  rejected([{ ...first, actor: { login: "other-maintainer" } }], {
    approver: actor,
    expectedRequestedAt: "2026-09-04T21:49:25Z",
  });
  // Other labels do not make an otherwise unique approval transition ambiguous.
  const unrelated = {
    ...transition(101, "2026-09-04T21:49:25Z"),
    label: { name: "manual-setup" },
  };
  assert.equal(approvalDecisionForEvents([first, unrelated], {
    approver: actor,
    expectedRequestedAt: "2026-09-04T21:49:25Z",
  }).eventId, first.id);
});

test("an old request cannot adopt a newer approval by the same actor", () => {
  const events = [second, first, removed]; // API order must not choose the decision.
  rejected(events);
  rejected(events, {
    ...initial,
    expectedEventId: first.id,
    expectedTriggeredAt: firstTime,
  });
  assert.deepEqual(approvalDecisionForEvents(events, {
    approver: actor, expectedRequestedAt: secondTime,
  }), { eventId: second.id, requestedAt: secondTime, reviewer: actor });
});

test("a removed approval and another actor cannot authorize publication", () => {
  rejected([first, removed]);
  rejected([first, removed, transition(102, secondTime, "labeled", "other-maintainer")], {
    approver: actor, expectedRequestedAt: secondTime,
  });
});

test("multiple approval transitions in either initial second fail closed", () => {
  for (const login of [actor, "other-maintainer"]) {
    rejected([first, transition(101, firstTime, "unlabeled", login), transition(102, firstTime)]);
    rejected([first, transition(101, "2026-09-04T21:49:25Z", "unlabeled", login)], {
      approver: actor,
      expectedRequestedAt: "2026-09-04T21:49:25Z",
    });
  }
  rejected([first, transition(99, firstTime, "unlabeled")]);
  // A later transition with a larger ID must invalidate an already selected ID too.
  rejected([first, transition(101, firstTime, "unlabeled"), transition(102, firstTime)], {
    ...initial,
    expectedEventId: first.id,
    expectedTriggeredAt: firstTime,
  });
});

test("a delayed transition invalidates an initially resolved fallback identity", () => {
  const trigger = { approver: actor, expectedRequestedAt: "2026-09-04T21:49:25Z" };
  const provisional = approvalDecisionForEvents([first], trigger);
  assert.equal(provisional.eventId, first.id);
  const delayed = transition(102, "2026-09-04T21:49:25Z");
  rejected([first, delayed], trigger);
  rejected([first, delayed], {
    approver: actor,
    expectedEventId: provisional.eventId,
    expectedRequestedAt: provisional.requestedAt,
    expectedTriggeredAt: trigger.expectedRequestedAt,
  });
});

test("a delayed earlier transition invalidates an initially exact identity", () => {
  const decision = approvalDecisionForEvents([first], initial);
  const delayedEarlier = transition(99, "2026-09-04T21:49:23Z", "unlabeled", "other-maintainer");
  rejected([delayedEarlier, first], initial);
  rejected([delayedEarlier, first], {
    approver: actor,
    expectedEventId: decision.eventId,
    expectedRequestedAt: decision.requestedAt,
    expectedTriggeredAt: initial.expectedRequestedAt,
  });
});

test("missing, malformed and ambiguous approval identity never fall back to latest", () => {
  for (const options of [
    {}, { approver: actor }, { ...initial, expectedRequestedAt: "" },
    { ...initial, expectedRequestedAt: "2026-02-30T21:49:24Z" },
    { ...initial, expectedRequestedAt: "2026-09-04T21:49:24.001Z" },
    { ...initial, expectedRequestedAt: firstTime + "\n" },
    { ...initial, expectedRequestedAt: 1788558564000 },
    { ...initial, approver: "" }, { ...initial, approver: "other" },
    { ...initial, expectedEventId: first.id },
    { ...initial, expectedEventId: first.id, expectedTriggeredAt: "bad" },
    ...[0, -1, 100.5, "100", null, NaN, Number.MAX_SAFE_INTEGER + 1, 101].map((expectedEventId) => ({
      ...initial,
      expectedEventId,
      expectedTriggeredAt: firstTime,
    })),
  ]) rejected([first], options);
  for (const events of [null, {}, [], [null], [first, first],
    [{ ...first, id: "100" }], [{ ...first, id: 0 }],
    [{ ...first, created_at: "2026-02-30T21:49:24Z" }],
    [{ ...first, actor: null }], [first, { event: "unlabeled" }],
    [first, { ...removed, created_at: "bad" }],
  ]) rejected(events);
});

test("setup label changes do not become new approvals and feedback requires approval last", () => {
  // Pomodoro: approval at :24, manual-setup removed at :27. No replacement decision.
  const events = [first, { ...transition(101, "2026-09-04T21:49:27Z", "unlabeled"), label: { name: "manual-setup" } }];
  assert.equal(approvalDecisionForEvents(events, initial).eventId, first.id);
  const changed = publicSubmissionFailure({ code: "approval-label-changed" }, { phase: "approval" });
  assert.match(changed.reason, /manual-setup.*captured/);
  assert.match(changed.action, /setup labels first.*remove.*set it last/);
  const revoked = publicSubmissionFailure({ code: "approval-label-missing" }, { phase: "approval" });
  assert.match(revoked.action, /withdrawn.*Do not restore.*blockers/);
});

function stepScript(workflow, name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0);
  const next = workflow.indexOf("\n      - name:", start + 1);
  const step = workflow.slice(start, next < 0 ? undefined : next);
  const marker = "        run: |\n";
  const run = step.indexOf(marker);
  assert.ok(run >= 0);
  return step.slice(run + marker.length).split("\n").map((line) => line.replace(/^ {10}/, "")).join("\n");
}

test("both approval entry points bind trigger time before selecting any event", async () => {
  const workflow = await readFile(new URL(".github/workflows/approve-submission.yml", root), "utf8");
  assert.match(workflow, /github\.event_name == 'issues'[\s\S]*github\.event\.action == 'labeled'/);
  assert.match(workflow, /APPROVAL_TRIGGERED_AT: \$\{\{ github\.event\.issue\.updated_at \}\}/);
  assert.equal((workflow.match(/APPROVAL_TRIGGERED_AT:/g) || []).length, 3);
  for (const file of ["approve-submission.mjs", "approve-plugin-update.mjs"]) {
    const source = await readFile(new URL(`scripts/${file}`, root), "utf8");
    assert.match(source, /approvalTriggeredAt = requiredEnvironment\("APPROVAL_TRIGGERED_AT"\)/);
    assert.match(source, /expectedRequestedAt: approvalTriggeredAt/);
    assert.match(source, /approval_triggered_at=\$\{approvalTriggeredAt\}/);
    assert.match(source, /requiredEnvironment\("APPROVAL_REQUESTED_AT"\)/);
    assert.match(source, /requiredEnvironment\("APPROVAL_EVENT_ID"\)/);
    assert.match(source, /expectedTriggeredAt:/);
  }
  // Preserve the original setup snapshot checks, not a relaxed live-state adoption.
  assert.equal((workflow.match(/MANUAL_SETUP: \$\{\{ contains\(github.event.issue.labels.\*.name, 'manual-setup'\) \}\}/g) || []).length, 3);
  assert.match(workflow, /has_manual_setup.*EXPECTED_MANUAL_SETUP/);
});

test("the final write-token recheck enforces both production incidents, revocation, actor, and bounds", async () => {
  const workflow = await readFile(new URL(".github/workflows/approve-submission.yml", root), "utf8");
  const script = stepScript(
    workflow,
    "Recheck mutable approval state and push tested plugin publication",
  );
  assert.doesNotMatch(script, /git add|git commit|git fetch/);
  assert.doesNotMatch(script, /--paginate|--slurp/);
  assert.match(script, /fetch_bounded_issue_pages[\s\S]*commits\/HEAD[\s\S]*push origin HEAD:main/);
  const directory = await mkdtemp(join(tmpdir(), "approval-final-push-race-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const ghCalls = join(directory, "gh-calls.jsonl");
    const gitCalls = join(directory, "git-calls.jsonl");
    const output = join(directory, "output");
    await writeFile(ghCalls, "");
    await writeFile(gitCalls, "");
    await writeFile(join(bin, "gh"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
if (args[0] !== "api") process.exit(91);
const endpoint = args.find((arg) => arg.startsWith("repos/"));
const incidents = ${JSON.stringify(productionIncidents)};
const incident = incidents[process.env.ISSUE_NUMBER];
if (!incident) process.exit(94);
const productionHistory = incident.history;
const issueEndpoint = "repos/" + incident.repository + "/issues/" + incident.number;
const eventsPrefix = issueEndpoint + "/events?per_page=100&page=";
const commentsPrefix = issueEndpoint + "/comments?per_page=100&page=";
if (endpoint === issueEndpoint) {
  const validIssue = {
    number: Number(incident.number),
    state: "open", title: incident.title, body: "approved body",
    labels: [
      "submission", "validated",
      ...(incident.manualSetup ? ["manual-setup"] : []),
      "approved-and-verified",
    ].map((name) => ({ name })),
  };
  if (process.env.EVENT_MODE === "issue-api-failure") {
    console.log(JSON.stringify(validIssue));
    process.exit(75);
  }
  if (process.env.EVENT_MODE === "multiple-issue-documents") {
    console.log(JSON.stringify({
      number: Number(incident.number),
      state: "closed", title: "ignored", body: "",
      labels: [{ name: "needs-fixes" }],
    }));
    console.log(JSON.stringify(validIssue));
    process.exit(0);
  }
  if (process.env.EVENT_MODE === "labels-object") {
    console.log(JSON.stringify({
      ...validIssue,
      labels: Object.fromEntries([
        ...validIssue.labels.map((label) => [label.name, label]),
        ["needs-fixes", { name: "not-a-blocking-label" }],
      ]),
    }));
    process.exit(0);
  }
  if (process.env.EVENT_MODE === "malformed-label-element") {
    console.log(JSON.stringify({ ...validIssue, labels: [...validIssue.labels, { name: 42 }] }));
    process.exit(0);
  }
  console.log(JSON.stringify(validIssue));
} else if (endpoint.startsWith(eventsPrefix)) {
  const page = Number(endpoint.slice(eventsPrefix.length));
  if (page === 1 && process.env.EVENT_MODE === "api-failure") {
    console.log(JSON.stringify(productionHistory));
    process.exit(75);
  }
  if (page === 1 && process.env.EVENT_MODE === "multiple-documents") {
    console.log(JSON.stringify(productionHistory));
    console.log(JSON.stringify([
      { id: 30613232468, event: "unlabeled", label: { name: "approved-and-verified" }, actor: { login: incident.approver }, created_at: "2026-09-05T16:36:09Z" },
    ]));
    process.exit(0);
  }
  let events;
  if (process.env.EVENT_MODE === "pagination-limit") {
    events = Array.from({ length: 100 }, (_, index) => ({ event: "commented", page, index }));
  } else if (page !== 1) {
    events = [];
  } else if (process.env.EVENT_MODE === "ambiguous") {
    events = [
      { id: 99, event: "unlabeled", label: { name: "approved-and-verified" }, actor: { login: "other-maintainer" }, created_at: "2026-09-04T21:49:23Z" },
      { id: 100, event: "labeled", label: { name: "approved-and-verified" }, actor: { login: incident.approver }, created_at: "${firstTime}" },
    ];
  } else if (process.env.EVENT_MODE === "malformed") {
    events = [...productionHistory,
      { id: 30612835181, event: "labeled", actor: { login: incident.approver }, created_at: incident.triggeredAt }];
  } else if (process.env.EVENT_MODE === "withdrawn") {
    events = [...productionHistory,
      { id: 30613232468, event: "unlabeled", label: { name: "approved-and-verified" }, actor: { login: incident.approver }, created_at: "2026-09-05T16:36:09Z" }];
  } else if (process.env.EVENT_MODE === "newer-approval") {
    events = [...productionHistory,
      { id: 30613235058, event: "labeled", label: { name: "approved-and-verified" }, actor: { login: incident.approver }, created_at: "2026-09-05T16:36:15Z" }];
  } else if (process.env.EVENT_MODE === "wrong-actor") {
    events = productionHistory.map((event) => event.id === incident.eventId
      ? { ...event, actor: { login: "other-maintainer" } }
      : event);
  } else {
    events = productionHistory;
  }
  console.log(JSON.stringify(events));
} else if (endpoint === "repos/" + incident.repository + "/collaborators/" + incident.approver + "/permission") {
  console.log("write");
} else if (endpoint.startsWith(commentsPrefix)) {
  const page = Number(endpoint.slice(commentsPrefix.length));
  console.log(JSON.stringify(page === 1 ? [
    { id: 200, user: { login: "github-actions[bot]" }, body: "<!-- marketplace-security-baseline:v4 inert -->", created_at: "2026-09-04T21:40:00Z", updated_at: "2026-09-04T21:40:01Z" },
  ] : []));
} else if (endpoint === "repos/" + incident.submissionRepository + "/commits/HEAD") {
  console.log("a".repeat(40));
} else process.exit(92);
`);
    await writeFile(join(bin, "git"), `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.GIT_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "rev-parse" && args[1] === "HEAD") console.log("c".repeat(40));
else if (!args.includes("push")) process.exit(93);
`);
    await chmod(join(bin, "gh"), 0o755);
    await chmod(join(bin, "git"), 0o755);
    const run = (event, overrides) => spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail"],
      {
        input: script, encoding: "utf8", timeout: 10000, cwd: directory,
        env: {
          PATH: `${bin}:/usr/bin:/bin`, HOME: directory,
          GH_TOKEN: "inert-token", GITHUB_TOKEN: "inert-token",
          GH_CALLS: ghCalls, GIT_CALLS: gitCalls, GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: productionIssue.repository, ISSUE_NUMBER: productionIssue.number,
          APPROVED_ISSUE_TITLE: productionIssue.title, APPROVED_ISSUE_BODY: "approved body",
          EXPECTED_MANUAL_SETUP: String(productionIssue.manualSetup),
          APPROVER_LOGIN: productionIssue.approver,
          BASELINE_COMMENT_ID: "200", BASELINE_COMMENT_UPDATED_AT: "2026-09-04T21:40:01Z",
          SUBMISSION_REPOSITORY: productionIssue.submissionRepository,
          APPROVED_COMMIT: "a".repeat(40),
          PUBLICATION_KIND: "listing", EXPECTED_BASE_COMMIT: "b".repeat(40),
          EVENT_MODE: event,
          ...overrides,
        },
      },
    );
    const assertFinalRejected = async (
      eventMode,
      environment,
      errorPattern,
      expectedCallCount = 2,
    ) => {
      await writeFile(ghCalls, "");
      await writeFile(gitCalls, "");
      const result = run(eventMode, environment);
      assert.notEqual(result.status, 0, `${eventMode} unexpectedly passed`);
      assert.match(result.stderr, errorPattern);
      assert.doesNotMatch(await readFile(gitCalls, "utf8"), /push/);
      const calls = (await readFile(ghCalls, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(calls.length, expectedCallCount);
      return calls;
    };
    let calls = await assertFinalRejected("ambiguous", {
      APPROVAL_EVENT_ID: "100",
      APPROVAL_REQUESTED_AT: firstTime,
      APPROVAL_TRIGGERED_AT: firstTime,
    }, /initial approval event window became missing or ambiguous/i);
    assert.ok(calls[1].includes(
      `repos/${productionIssue.repository}/issues/${productionIssue.number}/events?per_page=100&page=1`,
    ));

    const productionEnvironment = {
      APPROVAL_EVENT_ID: String(productionIssue.eventId),
      APPROVAL_REQUESTED_AT: productionIssue.requestedAt,
      APPROVAL_TRIGGERED_AT: productionIssue.triggeredAt,
    };
    await assertFinalRejected(
      "multiple-issue-documents",
      productionEnvironment,
      /invalid final-check issue/i,
      1,
    );
    await assertFinalRejected(
      "issue-api-failure",
      productionEnvironment,
      /issue request failed during the final check/i,
      1,
    );
    for (const eventMode of ["labels-object", "malformed-label-element"]) {
      await assertFinalRejected(
        eventMode,
        productionEnvironment,
        /invalid final-check issue/i,
        1,
      );
    }
    await assertFinalRejected("malformed", productionEnvironment, /invalid label event/i);
    await assertFinalRejected(
      "multiple-documents",
      productionEnvironment,
      /invalid final-check page/i,
    );
    await assertFinalRejected(
      "api-failure",
      productionEnvironment,
      /page request failed during the final check/i,
    );
    for (const eventMode of ["withdrawn", "newer-approval", "wrong-actor"]) {
      await assertFinalRejected(
        eventMode,
        productionEnvironment,
        /approved-and-verified label event changed before publication/i,
      );
    }
    calls = await assertFinalRejected(
      "pagination-limit",
      productionEnvironment,
      /pagination exceeded the safe final-check limit/i,
      11,
    );
    assert.equal(calls.filter((call) => call.some((argument) => (
      argument.includes(`/issues/${productionIssue.number}/events?per_page=100&page=`)
    ))).length, 10);

    await writeFile(ghCalls, "");
    await writeFile(gitCalls, "");
    await writeFile(output, "");
    const production = run("production", productionEnvironment);
    assert.equal(production.status, 0, production.stderr);
    assert.match(await readFile(gitCalls, "utf8"), /"push","origin","HEAD:main"/);
    assert.match(await readFile(output, "utf8"), new RegExp(`commit=${"c".repeat(40)}`));
    calls = (await readFile(ghCalls, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 5);

    await writeFile(ghCalls, "");
    await writeFile(gitCalls, "");
    await writeFile(output, "");
    const production4116 = run("production", {
      ISSUE_NUMBER: productionIssue4116.number,
      APPROVED_ISSUE_TITLE: productionIssue4116.title,
      EXPECTED_MANUAL_SETUP: String(productionIssue4116.manualSetup),
      APPROVER_LOGIN: productionIssue4116.approver,
      SUBMISSION_REPOSITORY: productionIssue4116.submissionRepository,
      APPROVAL_EVENT_ID: String(productionIssue4116.eventId),
      APPROVAL_REQUESTED_AT: productionIssue4116.requestedAt,
      APPROVAL_TRIGGERED_AT: productionIssue4116.triggeredAt,
    });
    assert.equal(production4116.status, 0, production4116.stderr);
    assert.match(await readFile(gitCalls, "utf8"), /"push","origin","HEAD:main"/);
    calls = (await readFile(ghCalls, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure reporting cannot clear a newer approval or overwrite a newer report", async () => {
  const workflow = await readFile(new URL(".github/workflows/approve-submission.yml", root), "utf8");
  const script = stepScript(workflow, "Report actionable snapshot publication failure");
  const directory = await mkdtemp(join(tmpdir(), "approval-failure-race-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const statePath = join(directory, "state.json");
    const callsPath = join(directory, "calls.jsonl");
    const stub = join(bin, "gh");
    await writeFile(stub, `#!${process.execPath}
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(process.env.GH_STATE, "utf8"));
// Only an append-only historical comment is permitted. Any API deletion/patch fails.
if (args[0] !== "issue" || args[1] !== "comment" || args[2] !== "3380" || args[3] !== "--body-file" || args.length !== 5) process.exit(91);
state.comments.push(readFileSync(args[4], "utf8"));
writeFileSync(process.env.GH_STATE, JSON.stringify(state));
`);
    await chmod(stub, 0o755);
    for (const phase of ["approve", "publish", "deploy", "finalize"]) {
      const current = {
        approvalEvent: second,
        labels: ["submission", "validated", "approved-and-verified"],
        comments: ["Newer run B succeeded; do not overwrite this status."],
        registry: { commit: "b".repeat(40) },
      };
      await writeFile(statePath, JSON.stringify(current));
      await writeFile(callsPath, "");
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail"], {
        input: script, encoding: "utf8", timeout: 10000, cwd: directory,
        env: {
          PATH: `${bin}:/usr/bin:/bin`, HOME: directory,
          GH_TOKEN: "", GITHUB_TOKEN: "", GH_STATE: statePath, GH_CALLS: callsPath,
          RUNNER_TEMP: directory, GITHUB_RUN_ID: "33922836925", ISSUE_NUMBER: "3380",
          GITHUB_REPOSITORY: "example/marketplace", GH_REPO: "example/marketplace",
          RUN_URL: "https://github.com/example/marketplace/actions/runs/33922836925",
          APPROVE_RESULT: phase === "approve" ? "failure" : "success",
          PUBLISH_RESULT: phase === "publish" ? "failure" : "success",
          DEPLOY_RESULT: phase === "deploy" ? "failure" : "success",
        },
      });
      assert.equal(result.status, 0, result.stderr);
      const after = JSON.parse(await readFile(statePath, "utf8"));
      assert.deepEqual({ ...after, comments: after.comments.slice(0, 1) }, current);
      assert.equal(after.comments.length, 2);
      const report = after.comments[1];
      assert.match(report, /marketplace-publication-run:33922836925/);
      assert.match(report, /historical run report/);
      assert.match(report, /not any later approval or publication/);
      if (["approve", "publish"].includes(phase)) {
        assert.match(report, /approval was withdrawn.*do not restore/);
        assert.match(report, /remove any remaining.*set it last/);
      } else {
        assert.match(report, /Do not reapply/);
        assert.doesNotMatch(report, /set it last/);
      }
      const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].slice(0, 3), ["issue", "comment", "3380"]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("successful finalization preserves historical reports from multiple runs", async () => {
  const workflow = await readFile(new URL(".github/workflows/approve-submission.yml", root), "utf8");
  const finalize = workflow.slice(workflow.indexOf("\n  finalize:\n"), workflow.indexOf("\n  report-failure:\n"));
  assert.doesNotMatch(finalize, /marketplace-publication-status|clear-status|--method DELETE/);
  const directory = await mkdtemp(join(tmpdir(), "approval-finalize-history-"));
  try {
    const bin = join(directory, "bin");
    await mkdir(bin);
    const statePath = join(directory, "state.json");
    const historical = ["100", "102"].map((id) => `<!-- marketplace-publication-status -->\n<!-- marketplace-publication-run:${id} -->\nHistorical failure.`);
    await writeFile(statePath, JSON.stringify({ comments: historical, labels: ["submission", "validated", "approved-and-verified"], closed: false }));
    const stub = join(bin, "gh");
    await writeFile(stub, `#!${process.execPath}
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(process.env.GH_STATE, "utf8"));
if (args[0] === "api" && args.includes("--paginate")) {
  const query = args[args.indexOf("--jq") + 1];
  if (!query.includes('contains("<!-- marketplace-publication -->")')) process.exit(91);
  process.exit(0); // No existing success comment; both historical comments remain.
}
if (args[0] !== "issue" || args[2] !== "3380") process.exit(92);
if (args[1] === "edit" && args[3] === "--add-label" && args[4] === "listed") state.labels.push("listed");
else if (args[1] === "comment" && args[3] === "--body-file") state.comments.push(readFileSync(args[4], "utf8"));
else if (args[1] === "close" && args[3] === "--reason" && args[4] === "completed") state.closed = true;
else process.exit(93);
writeFileSync(process.env.GH_STATE, JSON.stringify(state));
`);
    await chmod(stub, 0o755);
    for (const step of finalize.split("      - name: ").slice(1)) {
      if (step.startsWith("Record finalization failure\n")) continue;
      const name = step.slice(0, step.indexOf("\n"));
      const script = step.includes("        run: |\n")
        ? stepScript(`      - name: ${step}`, name)
        : step.match(/        run: (.+)/)?.[1];
      assert.ok(script, name);
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail"], {
        input: script, encoding: "utf8", timeout: 10000, cwd: directory,
        env: {
          PATH: `${bin}:/usr/bin:/bin`, HOME: directory,
          GH_STATE: statePath, GH_TOKEN: "", GITHUB_TOKEN: "", RUNNER_TEMP: directory,
          GITHUB_REPOSITORY: "example/marketplace", ISSUE_NUMBER: "3380",
          PLUGIN_ID: "example.plugin", PLUGIN_NAME_MARKDOWN: "Example",
          VERIFICATION_METHOD: "automated", PUBLICATION_KIND: "listing",
        },
      });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    }
    const after = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(after.comments.slice(0, 2), historical);
    assert.equal(after.comments.length, 3);
    assert.match(after.comments[2], /<!-- marketplace-publication -->/);
    assert.equal(after.closed, true);
    assert.ok(after.labels.includes("approved-and-verified"));
    assert.ok(after.labels.includes("listed"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
