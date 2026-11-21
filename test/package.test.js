import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePackage } from "../scripts/validate-package.mjs";

test("package validation uses committed export rules and preserves source files for review", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "plugin-package-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
  const commit = () => {
    git("add", "-A");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "example.package", name: "Package", version: "1.0.0",
    author: "Example", description: "Test plugin", kinds: ["bar-widget"],
    entryPoints: { barWidget: "Widget.qml" },
  }));
  await writeFile(join(directory, "Widget.qml"), "import QtQuick\nItem {}\n");
  await writeFile(join(directory, "README.md"), "Package documentation\n");
  await writeFile(join(directory, "LICENSE"), "MIT\n");
  await mkdir(join(directory, "tests"));
  await writeFile(join(directory, "tests", "fixture"), "Development only\n");
  const original = commit();
  assert.ok((await validatePackage(directory, original)).files.includes("tests/fixture"));

  await writeFile(join(directory, ".gitattributes"), "/tests export-ignore\n");
  assert.ok((await validatePackage(directory, original)).files.includes("tests/fixture"), "uncommitted attributes cannot change an exact-commit package");
  const exported = commit();
  const result = await validatePackage(directory, exported);
  assert.equal(result.commitSha, exported);
  assert.equal(result.pluginId, "example.package");
  assert.ok(result.files.includes("Widget.qml"));
  assert.ok(!result.files.includes("tests/fixture"));
  assert.ok(result.bytes > 0);
  assert.equal(git("show", `${exported}:tests/fixture`), "Development only", "excluded source remains available for review");

  for (const required of ["Widget.qml", "manifest.json", "README.md", "LICENSE"]) {
    await writeFile(join(directory, ".gitattributes"), `/${required} export-ignore\n`);
    const broken = commit();
    await assert.rejects(validatePackage(directory, broken), /entry point|manifest.json|README|license/);
  }
  await writeFile(join(directory, ".gitattributes"), "/tests export-ignore\n");
  await mkdir(join(directory, ".omarchy-package.json"));
  await writeFile(join(directory, ".omarchy-package.json", "file"), "Reserved directory");
  await assert.rejects(validatePackage(directory, commit()), /reserved/);
  await rm(join(directory, ".omarchy-package.json"), { recursive: true });
  await symlink("Widget.qml", join(directory, "linked.qml"));
  await assert.rejects(validatePackage(directory, commit()), /symlink/);
});
