import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/delist-plugins.yml", import.meta.url), "utf8");

function jobSource(name, nextName = "") {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, `${name} job must exist`);
  const end = nextName ? workflow.indexOf(`\n  ${nextName}:\n`, start + 1) : -1;
  return end > start ? workflow.slice(start, end) : workflow.slice(start);
}

test("plugin delisting is manual, main-bound, and authorized only for HANCORE-linux", () => {
  const trigger = workflow.slice(workflow.indexOf("\non:\n"), workflow.indexOf("\npermissions:"));
  assert.match(trigger, /workflow_dispatch:/);
  assert.doesNotMatch(trigger, /schedule:|push:|pull_request|issues:/);
  assert.match(trigger, /plugin_ids:[\s\S]*required: true[\s\S]*confirm_delisting:[\s\S]*type: boolean/);
  assert.equal((workflow.match(/github\.actor == 'HANCORE-linux'/g) || []).length, 2);
  assert.equal((workflow.match(/github\.triggering_actor == 'HANCORE-linux'/g) || []).length, 2);
  assert.equal((workflow.match(/github\.repository == 'omacom\/omarchy-plugin-marketplace'/g) || []).length, 2);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /github\.run_attempt == 1/);
  assert.match(workflow, /inputs\.confirm_delisting == true/);
  assert.equal((workflow.match(/test "\$REPOSITORY" = omacom\/omarchy-plugin-marketplace/g) || []).length, 2);
  assert.equal((workflow.match(/test "\$ACTOR" = HANCORE-linux/g) || []).length, 2);
  assert.equal((workflow.match(/test "\$TRIGGERING_ACTOR" = HANCORE-linux/g) || []).length, 2);
  assert.equal((workflow.match(/test "\$REF" = refs\/heads\/main/g) || []).length, 2);
  assert.doesNotMatch(workflow, /HANCORE-linux\/omarchy-plugin-marketplace/);
  assert.match(workflow, /group: >-[\s\S]*plugin-catalog-writes[\s\S]*ignored-plugin-delisting/);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run/);
});

test("delisting analysis is read-only and builds one exact tested projection", () => {
  const delist = jobSource("delist", "publish");
  assert.match(delist, /permissions:\n      contents: read/);
  assert.match(delist, /ref: main\n          fetch-depth: 0\n          persist-credentials: false/);
  assert.match(delist, /MARKETPLACE_DELIST_PLUGIN_IDS: \$\{\{ inputs\.plugin_ids \}\}/);
  assert.match(delist, /node scripts\/delist-plugins\.mjs[\s\S]*--report="\$RUNNER_TEMP\/delisting-report\.json"/);
  assert.match(delist, /Apply exact static delisting projection[\s\S]*Build Explorer data[\s\S]*npm run build:explorer[\s\S]*npm test/);
  assert.match(delist, /git diff --exit-code -- \.[\s\S]*':!registry\.json'[\s\S]*':!site\/catalog\.json'[\s\S]*':!site\/explorer-data\.json'[\s\S]*':!site\/assets\/img\/plugins\/'/);
  assert.match(delist, /git ls-files --others --exclude-standard -- site[\s\S]*git ls-files --others --ignored --exclude-standard -- site/);
  assert.match(delist, /test "\$unexpected_site_files" = site\/deployment-id\.txt[\s\S]*test -f site\/deployment-id\.txt[\s\S]*test ! -L site\/deployment-id\.txt/);
  assert.match(delist, /find registry\.json delisting-report\.json site\/catalog\.json site\/explorer-data\.json site\/assets\/img\/plugins -type f -print0/);
  for (const output of ["registry_sha", "catalog_sha", "explorer_sha", "report_sha", "publication_sha"]) {
    assert.match(delist, new RegExp(`echo "${output}=\\$\\{${output}\\}"`));
  }
  assert.match(delist, /upload-artifact@[a-f0-9]{40}/);
  assert.match(delist, /upload-pages-artifact@[a-f0-9]{40}/);
  assert.doesNotMatch(delist, /contents: write/);
});

test("a read-only job replays and verifies the requested publication", () => {
  const verification = jobSource("verify_publication", "publish");
  assert.match(verification, /permissions:\n      actions: read\n      contents: read/);
  assert.match(verification, /ref: \$\{\{ needs\.delist\.outputs\.base_commit \}\}\n          fetch-depth: 0/);
  assert.match(verification, /actions\/setup-node@[a-f0-9]{40}[\s\S]*node-version: 24/);
  assert.match(verification, /unexpected symbolic link[\s\S]*unsupported file type[\s\S]*actual_files[\s\S]*expected_files/);
  assert.match(verification, /delisting-report\.json[\s\S]*sha256sum --check SHA256SUMS/);
  for (const expectedHash of ["EXPECTED_REGISTRY_SHA", "EXPECTED_CATALOG_SHA", "EXPECTED_EXPLORER_SHA", "EXPECTED_REPORT_SHA"]) {
    assert.match(verification, new RegExp(`${expectedHash}:`));
  }
  assert.match(verification, /recomputed-delisting[\s\S]*node scripts\/delist-plugins\.mjs[\s\S]*cmp -s "\$recomputed\/registry\.json"[\s\S]*cmp -s "\$recomputed\/site\/catalog\.json"/);
  assert.match(verification, /npm run build:explorer[\s\S]*cmp -s site\/explorer-data\.json "\$bundle\/site\/explorer-data\.json"/);
  assert.doesNotMatch(verification, /contents: write|push origin|git commit/);
});

test("the write-token job only applies verified files and performs one guarded push", () => {
  const publish = jobSource("publish", "deploy");
  assert.match(publish, /needs: \[delist, verify_publication\]/);
  assert.match(publish, /permissions:\n      actions: read\n      contents: write/);
  assert.match(publish, /unexpected symbolic link[\s\S]*unsupported file type[\s\S]*sha256sum --check SHA256SUMS/);
  assert.match(publish, /Reauthorize delisting before publication/);
  assert.match(publish, /git add registry\.json site\/catalog\.json site\/explorer-data\.json site\/assets\/img\/plugins\//);
  assert.match(publish, /remote_main[\s\S]*EXPECTED_BASE_COMMIT[\s\S]*refusing to publish stale artifacts/);
  assert.match(publish, /push origin HEAD:main/);
  assert.doesNotMatch(publish, /node |npm |scripts\/|git rebase|--force/);
});

test("delisting deployment binds authorization, marker, catalog, and Explorer identities", () => {
  const deploy = jobSource("deploy");
  assert.match(deploy, /if: >-[\s\S]*needs\.delist\.result == 'success'[\s\S]*needs\.publish\.result == 'success'/);
  for (const authorization of [
    "github.event_name == 'workflow_dispatch'",
    "github.repository == 'omacom/omarchy-plugin-marketplace'",
    "github.ref == 'refs/heads/main'",
    "github.actor == 'HANCORE-linux'",
    "github.triggering_actor == 'HANCORE-linux'",
    "github.run_attempt == 1",
    "inputs.confirm_delisting == true",
  ]) {
    assert.ok(deploy.includes(authorization), `deploy must enforce ${authorization}`);
  }
  assert.match(deploy, /group: github-pages-deployments[\s\S]*queue: max/);
  assert.match(deploy, /Verify tested commit is still current[\s\S]*EXPECTED_COMMIT/);
  for (const expectedIdentity of ["EXPECTED_DEPLOYMENT_ID", "EXPECTED_CATALOG_SHA", "EXPECTED_EXPLORER_SHA"]) {
    assert.match(deploy, new RegExp(`${expectedIdentity}:`));
  }
  assert.match(deploy, /deployment-id\.txt[\s\S]*catalog\.json[\s\S]*explorer-data\.json/);
  assert.match(deploy, /live_id == "\$EXPECTED_DEPLOYMENT_ID"[\s\S]*live_catalog_sha == "\$EXPECTED_CATALOG_SHA"[\s\S]*live_explorer_sha == "\$EXPECTED_EXPLORER_SHA"/);
});

test("all third-party workflow actions remain pinned to full commits", () => {
  const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
  assert.ok(actionReferences.length > 0);
  assert.ok(actionReferences.every((reference) => /@[a-f0-9]{40}$/.test(reference)));
});
