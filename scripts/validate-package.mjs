import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateManifestFiles, validateRepositoryDocs } from "./build-catalog.mjs";

// This is an additional local author/reviewer check. Listing and source review
// still use the existing exact-commit checks, including files excluded here.
export async function validatePackage(repository, revision = "HEAD") {
  const source = resolve(repository);
  const git = (...args) => execFileSync("git", ["-c", "core.attributesFile=/dev/null", "-C", source, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_ATTR_NOSYSTEM: "1" },
  }).trim();
  const commitSha = git("rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`);
  const temporary = await mkdtemp(join(tmpdir(), "omarchy-package-"));
  try {
    const archive = join(temporary, "package.tar");
    const destination = join(temporary, "files");
    await mkdir(destination);
    git("archive", "--format=tar", `--output=${archive}`, commitSha);
    execFileSync("tar", ["-xf", archive, "-C", destination]);

    const tree = [];
    async function collect(directory = "") {
      for (const name of (await readdir(join(destination, directory))).sort()) {
        const path = directory ? `${directory}/${name}` : name;
        const stat = await lstat(join(destination, path));
        if (stat.isSymbolicLink()) throw new Error(`Package contains a symlink: ${path}`);
        if (stat.isDirectory()) await collect(path);
        else if (stat.isFile()) tree.push({ path, type: "blob", mode: stat.mode & 0o111 ? "100755" : "100644", size: stat.size });
        else throw new Error(`Unsupported package file: ${path}`);
      }
    }
    await collect();
    if (tree.some((entry) => entry.path === ".omarchy-package.json" || entry.path.startsWith(".omarchy-package.json/"))) {
      throw new Error(".omarchy-package.json is reserved for Omarchy's installer");
    }
    const context = { repository: { slug: source }, tree, treeByPath: new Map(tree.map((entry) => [entry.path, entry])) };
    validateRepositoryDocs(context);
    const manifest = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
    validateManifestFiles(manifest, "manifest.json", context, { community: true });
    return { commitSha, pluginId: manifest.id, files: tree.map((entry) => entry.path).sort(), bytes: tree.reduce((sum, entry) => sum + entry.size, 0) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2] || process.argv.length > 4) throw new Error("Usage: npm run validate:package -- <local-repository> [commit]");
    console.log(JSON.stringify(await validatePackage(process.argv[2], process.argv[3]), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
