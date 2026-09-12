import { parseGitHubRepository } from "./github-repository.mjs";
import { SecurityBaselineError } from "./security-baseline-error.mjs";
import { securitySnapshotFileLimit } from "./security-baseline-limits.mjs";
import { assertFullCommitSha } from "./security-github-snapshot.mjs";
import { isRootReadme } from "./security-baseline-scope.mjs";
import {
  securityBaselineBlocksApproval,
  securityBaselineCapabilityCatalog as capabilityCatalog,
  securityBaselineDisposition,
  securityBaselineEnforcementMode,
  securityBaselineOutcome,
  securityBaselineRuleCatalog as ruleCatalog,
  securityBaselineVersion,
} from "./security-baseline-policy.mjs";

function isShellRuntimePath(path) {
  const normalized = String(path || "").replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1);
  if (/\.(?:ba|z|fi)?sh$/i.test(basename)) return true;
  if (!basename.includes(".") && /^(?:bin|scripts)\//i.test(normalized)) return true;
  return /(?:^|[-_])(install|installer|setup|uninstall)(?:[-_.]|$)/i.test(basename)
    && !/\.(?:md|json)$/i.test(basename);
}

function shellWordTokens(text) {
  return [...String(text || "").matchAll(/"([^"]+)"|'([^']+)'|([^\s|;&]+)/g)]
    .map((match) => normalizedShellToken(match[1] || match[2] || match[3]).replace(/^\.\//, ""))
    .filter(Boolean);
}

export function referencedSudoersPolicyPaths(files, tree) {
  const treePaths = new Set(tree.filter((entry) => entry.type === "blob" && entry.mode !== "120000")
    .map((entry) => entry.path));
  const referenced = new Set();
  for (const file of files.filter((entry) => (
    !entry.binary
    && (isShellRuntimePath(entry.path) || isExecutableTextFile(entry))
    && invokesSudoersModification(entry.content || "")
  ))) {
    for (const state of shellCommandStates(file)) {
      if (!writesSudoersDestination(state)) continue;
      for (const token of shellWordTokens(state.command.text)) {
        const sourceToken = token.match(/^(?:if|src|source)=(.+)$/)?.[1] || token;
        const resolved = resolvedShellToken(sourceToken, state.literals).replace(/^\.\//, "");
        if (treePaths.has(resolved)) referenced.add(resolved);
      }
    }
  }
  return referenced;
}

function logicalCommands(file) {
  const lines = String(file.content || "").split(/\r?\n/);
  const commands = [];
  let text = "";
  let startLine = 1;
  for (const [index, line] of lines.entries()) {
    if (!text) startLine = index + 1;
    const continued = /\\\s*$|(?:\||&&|\|\|)\s*$/.test(line);
    text += `${text ? " " : ""}${line.replace(/\\\s*$/, "").trim()}`;
    if (!continued) {
      commands.push({ path: file.path, line: startLine, text: text.trim() });
      text = "";
    }
  }
  if (text) commands.push({ path: file.path, line: startLine, text: text.trim() });
  return commands;
}

function isCommentOnly(command) {
  if (isRootReadme(command.path)) return false;
  return /^(?:#|\/\/|\/\*|\*|<!--)/.test(command.text.trim());
}

function evidence(command) {
  return {
    path: command.path,
    line: command.line,
    snippet: command.text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300),
  };
}

function commandSequence(file) {
  return logicalCommands(file).filter((command) => command.text && !isCommentOnly(command));
}

function literalCommit(argument) {
  const value = String(argument || "").replace(/^["']|["']$/g, "");
  return /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : "";
}

function assignedLiteralCommit(argument, file, beforeLine) {
  const value = String(argument || "").replace(/^["']|["']$/g, "");
  const variable = value.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/)?.slice(1).find(Boolean);
  if (!variable) return "";
  let possibilities = new Set([""]);
  for (const command of compoundSegments(file)) {
    if (command.line >= beforeLine) break;
    let mutation = null;
    const assignment = shellAssignment(command);
    if (assignment?.variable === variable) mutation = literalCommit(assignment.value);
    if (
      shellMutationVariables(command).includes(variable)
      || new RegExp(`^\\s*${variable}\\+=`).test(command.text)
      || new RegExp(`^\\s*(?:then|do|else)\\s+${variable}=`).test(command.text)
      || new RegExp(`(?:^|\\s)(?:let\\s+|\\(\\(\\s*)${variable}\\s*=`).test(command.text)
    ) mutation = "";
    if (mutation === null) continue;
    possibilities = ["&&", "||"].includes(command.previousOperator)
      ? new Set([...possibilities, mutation])
      : new Set([mutation]);
  }
  return possibilities.size === 1 ? [...possibilities][0] : "";
}

function stripInlineComment(text) {
  return String(text || "").replace(/\s+#.*$/, "").trim();
}

function commandTokenBasename(token) {
  return String(token || "").split("/").at(-1) || "";
}

function stripOuterTokenQuotes(value) {
  return String(value || "").replace(/^["']|["']$/g, "");
}

function stripCommandWrapper(value, name, optionsWithValues = new Set()) {
  const tokens = value.trim().split(/\s+/);
  if (commandTokenBasename(stripOuterTokenQuotes(tokens[0])) !== name) return value;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    const normalizedToken = stripOuterTokenQuotes(token);
    if (normalizedToken === "--") {
      index++;
      break;
    }
    if (!normalizedToken.startsWith("-")) break;
    const optionName = normalizedToken.split("=")[0];
    if (optionsWithValues.has(optionName) && !normalizedToken.includes("=")) index++;
    index++;
  }
  return tokens.slice(index).join(" ");
}

function stripEnvWrapper(value) {
  const tokens = value.trim().split(/\s+/);
  if (commandTokenBasename(stripOuterTokenQuotes(tokens[0])) !== "env") return value;
  const optionsWithValues = new Set(["-C", "--chdir", "-u", "--unset"]);
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    const normalizedToken = stripOuterTokenQuotes(token);
    if (normalizedToken === "--") return tokens.slice(index + 1).join(" ");
    if (/^-S.+/.test(normalizedToken)) {
      const payload = normalizedToken.slice(2);
      return normalizedShellToken(`${payload} ${tokens.slice(index + 1).join(" ")}`.trim());
    }
    if (normalizedToken.startsWith("--split-string=")) {
      const payload = normalizedToken.slice("--split-string=".length);
      return normalizedShellToken(`${payload} ${tokens.slice(index + 1).join(" ")}`.trim());
    }
    if (normalizedToken === "-S" || normalizedToken === "--split-string") {
      return normalizedShellToken(tokens.slice(index + 1).join(" "));
    }
    const optionName = normalizedToken.split("=")[0];
    if (optionsWithValues.has(optionName)) {
      if (!normalizedToken.includes("=")) index++;
      continue;
    }
    if (normalizedToken.startsWith("-")) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalizedToken)) continue;
    return tokens.slice(index).join(" ");
  }
  return "";
}

function stripTimeoutWrapper(value) {
  const strippedOptions = stripCommandWrapper(
    value,
    "timeout",
    new Set(["-k", "--kill-after", "-s", "--signal"]),
  );
  if (strippedOptions === value) return value;
  return strippedOptions.replace(/^\S+\s+/, "");
}

function shellExecutable(text) {
  let value = stripInlineComment(text)
    .replace(/^\s*[({]+\s*/, "")
    .replace(/^\s*(?:if|then|do)\s+/, "")
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*/, "");
  for (let attempts = 0; attempts < 12; attempts++) {
    const before = value;
    value = stripCommandWrapper(value, "command");
    value = stripCommandWrapper(value, "exec");
    value = stripCommandWrapper(value, "nohup");
    value = stripCommandWrapper(value, "sudo", new Set([
      "-C", "-D", "-g", "-h", "-p", "-R", "-r", "-T", "-t", "-U", "-u",
      "--chdir", "--close-from", "--group", "--host", "--other-user",
      "--prompt", "--role", "--root", "--type", "--user",
    ]));
    value = stripCommandWrapper(value, "pkexec", new Set(["-u", "--user"]));
    value = stripEnvWrapper(value);
    value = value.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]*\s+)*/, "");
    value = stripTimeoutWrapper(value);
    if (value === before) break;
  }
  const rawToken = value.match(/^([^\s;&|)]+)/)?.[1] || "";
  const token = stripOuterTokenQuotes(rawToken);
  return {
    token,
    basename: token.split("/").at(-1) || "",
    rest: value.slice(rawToken.length).trim(),
  };
}

function cargoGitFinding(command, file, submissionRepository = "") {
  const executable = shellExecutable(command.text);
  const cargoCommand = executable.rest.replace(/^\+[^\s]+\s+/, "");
  if (executable.basename !== "cargo" || !/^install\b/i.test(cargoCommand) || !/\s--git(?:\s|=)/i.test(` ${cargoCommand}`)) return null;
  const rev = cargoCommand.match(/(?:^|\s)--rev(?:\s+|=)([^\s;&|]+)/i)?.[1] || "";
  if (
    literalCommit(rev)
    || assignedLiteralCommit(rev, file, command.line)
    || commandUsesOnlySubmissionRepository(command, submissionRepository)
  ) return null;
  return {
    ruleId: "cargo-git-unpinned",
    ...ruleCatalog["cargo-git-unpinned"],
    evidence: [evidence(command)],
  };
}

function literalShellPayload(command) {
  const executable = shellExecutable(command.text);
  if (executable.basename === "eval") {
    return normalizedShellToken(executable.rest);
  }
  if (interpreterExecutables.test(executable.basename) && /^-c\s+/i.test(executable.rest)) {
    return normalizedShellToken(executable.rest.replace(/^-c\s+/i, ""));
  }
  return "";
}

function githubRepositoryFromUrl(value) {
  const raw = normalizedShellToken(value).replace(/(?:[),;]+|[.:!?]+$)/g, "");
  try {
    if (/^https:\/\/github\.com\//i.test(raw)) {
      return parseGitHubRepository(raw).slug.toLowerCase();
    }
    const url = new URL(raw);
    if (url.hostname.toLowerCase() !== "raw.githubusercontent.com") return "";
    const [owner, repository] = url.pathname.split("/").filter(Boolean);
    return owner && repository ? `${owner}/${repository}`.toLowerCase() : "";
  } catch {
    return "";
  }
}

function commandRemoteUrls(command) {
  const text = stripInlineComment(String(command?.text || command?.content || ""));
  return text.match(
    /(?:https?|git|ssh):\/\/[^\s"'`|;&)]+|git@[^\s:"'`|;&)]+:[^\s"'`|;&)]+/gi,
  ) || [];
}

function commandRemoteRepositories(command) {
  return new Set(commandRemoteUrls(command).map(githubRepositoryFromUrl).filter(Boolean));
}

function commandUsesOnlySubmissionRepository(command, submissionRepository) {
  const expected = String(submissionRepository || "").toLowerCase();
  const urls = commandRemoteUrls(command);
  if (!expected || !urls.length) return false;
  const repositories = urls.map(githubRepositoryFromUrl);
  return repositories.every((repository) => repository === expected);
}

function pipeToShellFinding(command, submissionRepository = "") {
  const text = stripInlineComment(command.text);
  const nestedPayload = literalShellPayload(command);
  if (nestedPayload && nestedPayload !== text) {
    const nested = pipeToShellFinding({ ...command, text: nestedPayload }, submissionRepository);
    if (nested) return { ...nested, evidence: [evidence(command)] };
  }
  const candidateSegments = text.split(/(?:&&|\|\||;)/).map((part) => part.trim()).filter(Boolean);
  for (const segment of candidateSegments) {
    if (segment !== text) {
      const nested = pipeToShellFinding({ ...command, text: segment }, submissionRepository);
      if (nested) return { ...nested, evidence: [evidence(command)] };
    }
  }
  const downloader = shellExecutable(text);
  const startsWithDownloader = ["curl", "wget"].includes(downloader.basename);
  const shell = "(?:/[^\\s;&|]*/)?(?:ba|z|fi|da|a|k)?sh";
  const pipedCommands = text.replace(/\|&/g, "|").split(/\|(?!\|)/).slice(1).map((part) => part.trim());
  const pipe = startsWithDownloader
    && pipedCommands.some((part) => interpreterExecutables.test(shellExecutable(part).basename));
  const substitution = new RegExp(
    `(?:${shell}|source|\\.)\\s+(?:<\\s*)?<\\(\\s*(?:curl|wget)\\b`,
    "i",
  ).test(text);
  const commandSubstitution = /(?:eval\s+|(?:ba|z|fi|da|a|k)?sh\s+-c\s+)["']?\$\(\s*(?:curl|wget)\b/i.test(text);
  if (!pipe && !substitution && !commandSubstitution) return null;
  if (commandUsesOnlySubmissionRepository(command, submissionRepository)) return null;
  return {
    ruleId: "curl-pipe-shell",
    ...ruleCatalog["curl-pipe-shell"],
    evidence: [evidence(command)],
  };
}

function compoundSegments(file) {
  const segments = [];
  let carriedOperator = "";
  let currentWorkingDirectory = "";
  let errexit = false;
  for (const [commandIndex, command] of commandSequence(file).entries()) {
    const parts = command.text.split(/(&&|\|\||;|&(?![&>]))/);
    let previousOperator = carriedOperator;
    let workingDirectory = currentWorkingDirectory;
    for (let index = 0; index < parts.length; index += 2) {
      const text = String(parts[index] || "").trim();
      const nextOperator = parts[index + 1] || "";
      if (!text) {
        previousOperator = nextOperator || previousOperator;
        continue;
      }
      const segment = {
        ...command,
        text,
        commandIndex,
        previousOperator,
        nextOperator,
        workingDirectory,
        errexit,
      };
      segments.push(segment);
      const executable = shellExecutable(text);
      if (executable.basename === "cd") {
        workingDirectory = normalizedShellToken(executable.rest.split(/\s/)[0]);
      }
      if (executable.basename === "set") {
        if (/(?:^|\s)-(?:[^\s]*e|o\s+errexit)(?:\s|$)/.test(executable.rest)) errexit = true;
        if (/(?:^|\s)\+(?:[^\s]*e|o\s+errexit)(?:\s|$)/.test(executable.rest)) errexit = false;
      }
      previousOperator = nextOperator;
    }
    currentWorkingDirectory = workingDirectory;
    carriedOperator = parts.at(-2) && /^(?:&&|\|\|)$/.test(parts.at(-2))
      ? parts.at(-2)
      : "";
  }
  return segments;
}

function gitSubcommand(rest) {
  const tokens = String(rest || "").split(/\s+/);
  const optionsWithValues = new Set([
    "-c", "-C", "--exec-path", "--git-dir", "--namespace", "--super-prefix", "--work-tree",
  ]);
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (optionsWithValues.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return { command: token, rest: tokens.slice(index + 1).join(" ") };
  }
  return { command: "", rest: "" };
}

function isGitAcquisition(command) {
  const executable = shellExecutable(command.text);
  if (executable.basename !== "git") return false;
  return /^(?:clone|fetch|pull)$/i.test(gitSubcommand(executable.rest).command);
}

const interpreterExecutables = /^(?:bash|sh|zsh|dash|ash|ksh|fish|python(?:[23](?:\.[0-9]+)?)?|node|ruby|perl|php|java|deno|dotnet)$/i;
const buildExecutables = /^(?:make|gmake|cmake|ninja|meson|gradle|gradlew|mvn|maven|go|cargo|npm|pnpm|yarn|bun)$/i;

function normalizedDirectoryReference(value) {
  return normalizedShellToken(value).replace(/^\.\//, "").replace(/\/$/, "");
}

function commandReferencesDirectory(command, directory) {
  const normalizedDirectory = normalizedDirectoryReference(directory);
  if (!normalizedDirectory) return false;
  const workingDirectory = normalizedDirectoryReference(command.workingDirectory);
  if (normalizedDirectory === "." || workingDirectory === normalizedDirectory) return true;
  return String(command.text || "").split(/[\s;&|()]+/).some((rawToken) => {
    const token = normalizedShellToken(rawToken).replace(/^\.\//, "").replace(/[,:]$/, "");
    const optionValue = token.includes("=") ? token.slice(token.indexOf("=") + 1) : "";
    return token === normalizedDirectory
      || token.startsWith(`${normalizedDirectory}/`)
      || token.includes(`/${normalizedDirectory}/`)
      || optionValue === normalizedDirectory
      || optionValue.startsWith(`${normalizedDirectory}/`);
  });
}

function executableReferencesDirectory(command, directory) {
  const normalizedDirectory = normalizedDirectoryReference(directory);
  const workingDirectory = normalizedDirectoryReference(command.workingDirectory);
  if (normalizedDirectory === "." || workingDirectory === normalizedDirectory) return true;
  const token = normalizedDirectoryReference(shellExecutable(command.text).token);
  return token === normalizedDirectory
    || token.startsWith(`${normalizedDirectory}/`)
    || token.includes(`/${normalizedDirectory}/`);
}

function isExecutionSink(command, directory = "") {
  const executable = shellExecutable(command.text);
  const { basename, rest, token } = executable;
  if (!basename) return false;
  let executes = interpreterExecutables.test(basename);
  if (buildExecutables.test(basename)) {
    executes = true;
    if (basename === "go") executes = /^run\b/i.test(rest);
    if (basename === "cargo") executes = /^(?:\+[^\s]+\s+)?(?:build|run)\b|^(?:\+[^\s]+\s+)?install\b[\s\S]*--path\b/i.test(rest);
    if (/^(?:npm|pnpm|yarn|bun)$/i.test(basename)) {
      executes = /(?:^|\s)(?:ci|install|run|build|start|test|exec|dlx)\b/i.test(rest);
    }
  }
  if (/^(?:source|\.)$/.test(basename)) executes = true;
  if (directory) return executes
    ? commandReferencesDirectory(command, directory)
    : token.includes("/") && executableReferencesDirectory(command, directory);
  return executes || (/^(?:\.{0,2}\/)/.test(token) && token.includes("/"));
}
function normalizedShellToken(value) {
  return String(value || "").replace(/^["']|["']$/g, "");
}

function gitAcquisitionDirectory(command) {
  const executable = shellExecutable(command.text);
  if (executable.basename !== "git") return "";
  const parsed = gitSubcommand(executable.rest);
  const explicitDirectory = executable.rest.match(/(?:^|\s)-C\s+([^\s]+)/)?.[1];
  if (/^(?:fetch|pull)$/i.test(parsed.command)) {
    return normalizedShellToken(explicitDirectory || command.workingDirectory || ".");
  }
  if (parsed.command !== "clone") return "";
  const rawCloneTokens = parsed.rest.split(/\s+/);
  const redirectionAt = rawCloneTokens.findIndex((token) => /^(?:\||&?>|\d*>)/.test(token));
  const cloneTokens = redirectionAt < 0
    ? rawCloneTokens
    : rawCloneTokens.slice(0, redirectionAt);
  const tokens = [];
  const optionsWithValues = new Set([
    "--branch", "-b", "--bundle-uri", "--config", "-c", "--depth", "--filter",
    "--jobs", "-j", "--origin", "-o", "--ref-format", "--reference",
    "--reference-if-able", "--revision", "--separate-git-dir", "--server-option",
    "--shallow-exclude", "--shallow-since", "--template", "--upload-pack", "-u",
  ]);
  for (let index = 0; index < cloneTokens.length; index++) {
    const token = cloneTokens[index];
    if (optionsWithValues.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith("-")) continue;
    tokens.push(token);
  }
  if (!tokens.length) return "";
  if (tokens.length > 1) return normalizedShellToken(tokens.at(-1));
  try {
    const repository = new URL(normalizedShellToken(tokens[0])).pathname.split("/").filter(Boolean).at(-1) || "";
    return repository.replace(/\.git$/i, "");
  } catch {
    return "";
  }
}

function repositoryMutation(segment, directory) {
  const executable = shellExecutable(segment.text);
  if (executable.basename !== "git") return null;
  const parsed = gitSubcommand(executable.rest);
  const explicitDirectory = executable.rest.match(/(?:^|\s)-C\s+([^\s]+)/)?.[1];
  const targetDirectory = normalizedShellToken(
    explicitDirectory || segment.workingDirectory || ".",
  );
  const command = /^(?:checkout|switch|reset|pull|merge|rebase|restore|cherry-pick|submodule)$/i.test(parsed.command)
    ? parsed.command
    : "";
  if (!command || targetDirectory !== directory) return null;
  const exactPin = /^(?:checkout|switch)$/i.test(command)
    && /(?:^|\s)--detach\s/i.test(parsed.rest)
    && literalCommit(parsed.rest.match(/(?:^|\s)--detach\s+([^\s;&|]+)/i)?.[1]);
  return {
    exactPin: Boolean(exactPin),
    reliable: (segment.nextOperator === "&&" || segment.errexit)
      && segment.previousOperator !== "||"
      && !/\|\|/.test(executable.rest),
  };
}

function downloadTarget(command) {
  if (!/\b(?:curl|wget)\b/i.test(command.text)) return "";
  const output = stripInlineComment(command.text).match(
    /(?:^|\s)(?:-o|--output(?:-document)?)(?:\s+|=)([^\s;&|]+)|(?:^|\s)-[A-Za-z]*o([^\s;&|]+)|>\s*([^\s;&|]+)/i,
  );
  return normalizedShellToken(output?.[1] || output?.[2] || output?.[3]);
}

function downloadedFileFindings(file, segments, submissionRepository = "") {
  const findings = [];
  for (const [index, command] of segments.entries()) {
    const target = downloadTarget(command);
    if (!target) continue;
    const sink = segments.slice(index + 1).find((candidate) => (
      isExecutionSink(candidate)
      && candidate.text.includes(target)
    ));
    if (!sink || commandUsesOnlySubmissionRepository(command, submissionRepository)) continue;
    findings.push({
      ruleId: "curl-pipe-shell",
      ...ruleCatalog["curl-pipe-shell"],
      title: "Downloaded content is executed without verification",
      evidence: [evidence(command), evidence(sink)],
    });
  }
  return findings;
}

function remoteGitExecutionFindings(file, submissionRepository = "") {
  const segments = compoundSegments(file).map((segment) => ({ ...segment, file }));
  const findings = [];
  const submissionDirectories = new Set();
  const documentedSubmissionCheckout = file.documentation
    && file.documentedRepositories?.includes(submissionRepository);
  for (const [index, acquisition] of segments.entries()) {
    if (!isGitAcquisition(acquisition)) continue;
    const directory = gitAcquisitionDirectory(acquisition);
    const acquisitionRemotes = commandRemoteUrls(acquisition);
    const explicitRemote = acquisitionRemotes.length > 0;
    const submissionSource = commandUsesOnlySubmissionRepository(acquisition, submissionRepository)
      || (!explicitRemote && submissionDirectories.has(directory))
      || (!explicitRemote && documentedSubmissionCheckout
        && /^(?:fetch|pull)$/i.test(gitSubcommand(shellExecutable(acquisition.text).rest).command));
    if (directory) {
      if (submissionSource) submissionDirectories.add(directory);
      else if (explicitRemote) submissionDirectories.delete(directory);
    }
    let pinned = false;
    let sourceIsSubmission = submissionSource;
    for (const segment of segments.slice(index + 1)) {
      const mutation = directory ? repositoryMutation(segment, directory) : null;
      if (mutation) {
        pinned = mutation.exactPin && mutation.reliable;
        continue;
      }
      const executable = shellExecutable(segment.text);
      const parsedGit = executable.basename === "git" ? gitSubcommand(executable.rest) : null;
      const remoteMutation = parsedGit?.command === "remote"
        && /^(?:add|set-url)\b/i.test(parsedGit.rest)
        && commandRemoteUrls(segment).length > 0;
      if (remoteMutation) {
        const remoteDirectory = normalizedDirectoryReference(
          executable.rest.match(/(?:^|\s)-C\s+([^\s]+)/)?.[1]
            || segment.workingDirectory
            || ".",
        );
        if (remoteDirectory === normalizedDirectoryReference(directory)) {
          // Remote mutation can revoke self provenance, but cannot promote an
          // external checkout to trusted self provenance without a new clone.
          sourceIsSubmission = sourceIsSubmission
            && commandUsesOnlySubmissionRepository(segment, submissionRepository);
          if (directory && !sourceIsSubmission) submissionDirectories.delete(directory);
          pinned = false;
        }
        continue;
      }
      if (isExecutionSink(segment, directory)) {
        if (!pinned && !sourceIsSubmission) {
          findings.push({
            ruleId: "remote-git-execution-unpinned",
            ...ruleCatalog["remote-git-execution-unpinned"],
            evidence: acquisition.line === segment.line
              ? [evidence(acquisition)]
              : [evidence(acquisition), evidence(segment)],
          });
          break;
        }
      }
      if (pinned && segment.nextOperator !== "&&") {
        // A successful checkout must remain in one fail-closed && chain until
        // every execution sink. Otherwise an intermediate failure can fall
        // through to a later build of the mutable clone.
        pinned = false;
      }
    }
  }
  findings.push(...downloadedFileFindings(file, segments, submissionRepository));
  return findings;
}
function dedupeFindings(findings) {
  const byRule = new Map();
  for (const finding of findings) {
    if (!byRule.has(finding.ruleId)) {
      byRule.set(finding.ruleId, { ...finding, evidence: [] });
    }
    const grouped = byRule.get(finding.ruleId);
    for (const item of finding.evidence) {
      if (!grouped.evidence.some((entry) => entry.path === item.path && entry.line === item.line)) {
        grouped.evidence.push(item);
      }
    }
  }
  return [...byRule.values()].map((finding) => ({
    ...finding,
    evidence: finding.evidence.slice(0, 8),
  }));
}

function isExecutableTextFile(file) {
  return file.mode === "100755"
    || file.entryPoint === true
    || /^#!.*(?:sh|bash|zsh|dash|ash|ksh|fish)\b/m.test(file.content || "");
}

function shellFenceFiles(file) {
  if (!isRootReadme(file.path)) return [];
  const files = [];
  const lines = String(file.content || "").split(/\r?\n/);
  let section = "";
  let paragraph = [];
  let previousParagraph = [];
  for (let index = 0; index < lines.length; index++) {
    const heading = lines[index].match(/^ {0,3}#{1,6}\s+(.+)$/);
    if (heading) {
      section = heading[1].trim().toLowerCase();
      paragraph = [];
      previousParagraph = [];
      continue;
    }
    const opening = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*(?:(?:ba|z|fi|da|a|k)?sh|shell)\s*$/i);
    if (!opening) {
      if (lines[index].trim()) {
        paragraph.push(lines[index]);
      } else if (paragraph.length) {
        previousParagraph = paragraph;
        paragraph = [];
      } else {
        previousParagraph = [];
      }
      continue;
    }
    const marker = opening[1][0];
    const minimumLength = opening[1].length;
    const body = [];
    for (index++; index < lines.length; index++) {
      const closing = lines[index].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (closing && closing[1][0] === marker && closing[1].length >= minimumLength) break;
      body.push(lines[index]);
    }
    const adjacentContext = paragraph.length ? paragraph : previousParagraph;
    const documentationContext = `${section}\n${adjacentContext.join("\n")}`;
    if (!/\b(?:development|contributing|contributors?|testing|tests?)\b/i.test(documentationContext)) {
      files.push({
        path: file.path,
        content: body.join("\n"),
        mode: "100755",
        documentation: true,
        documentedRepositories: file.documentedRepositories,
      });
    }
    paragraph = [];
    previousParagraph = [];
  }
  return files;
}

function decodeLiteral(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\(["'`\\])/g, "$1");
}

function quotedLiterals(value) {
  const literals = [];
  const text = String(value || "");
  for (let index = 0; index < text.length; index++) {
    const quote = text[index];
    if (!["\"", "'", "`"].includes(quote)) continue;
    let content = "";
    for (index++; index < text.length; index++) {
      if (text[index] === "\\" && index + 1 < text.length) {
        content += text[index] + text[++index];
      } else if (text[index] === quote) {
        break;
      } else {
        content += text[index];
      }
    }
    literals.push(decodeLiteral(content));
  }
  return literals;
}

function literalLauncherFiles(file) {
  if (!/\.(?:qml|js|mjs|cjs|py|desktop|service)$/i.test(file.path)) return [];
  const text = String(file.content || "");
  const payloads = [];
  const launcherCall = /\b(?:exec|execSync|execFile|execFileSync|execDetached|spawn|spawnSync|os\.system|subprocess\.(?:run|call|Popen|check_call|check_output)|command)\s*\(([\s\S]*?)\)/gi;
  for (const match of text.matchAll(launcherCall)) {
    const literals = quotedLiterals(match[1]);
    const shellIndex = literals.findIndex((literal) => interpreterExecutables.test(commandTokenBasename(literal)));
    if (shellIndex >= 0 && literals[shellIndex + 1] === "-c") {
      payloads.push(literals[shellIndex + 2] || "");
    } else if (literals.length) {
      payloads.push(literals.join(" "));
    }
  }
  const processCommand = /\bcommand\s*:\s*\[([\s\S]*?)\]/gi;
  for (const match of text.matchAll(processCommand)) {
    const literals = quotedLiterals(match[1]);
    if (literals.length) payloads.push(literals.join(" "));
  }
  for (const match of text.matchAll(/\bExec(?:Start)?=([^\r\n]+)/gi)) payloads.push(match[1]);
  if (!payloads.some((payload) => /\b(?:curl|wget|git|cargo)\b/i.test(payload))) return [];
  return [{ path: file.path, content: payloads.join("\n"), mode: "100755" }];
}

function literalShellPayloadFiles(file) {
  const payloads = [];
  for (const command of commandSequence(file)) {
    const payload = literalShellPayload(command);
    if (payload && payload !== command.text) {
      payloads.push({ path: file.path, content: payload, mode: "100755" });
    }
  }
  return payloads;
}

function expandedSecurityFiles(files) {
  const queue = (files || []).flatMap((file) => [
    file,
    ...shellFenceFiles(file),
    ...literalLauncherFiles(file),
  ]);
  const expanded = [];
  const seen = new Set();
  const expansionLimit = securitySnapshotFileLimit * 4;
  while (queue.length) {
    const file = queue.shift();
    const key = `${file.path}\0${file.content}`;
    if (seen.has(key)) continue;
    if (expanded.length >= expansionLimit) {
      throw new SecurityBaselineError(
        "security-baseline-scan-limit",
        "The static command expansion limit was exceeded",
      );
    }
    seen.add(key);
    expanded.push(file);
    queue.push(...literalShellPayloadFiles(file));
  }
  return expanded;
}

function isSudoersPolicyFile(file) {
  return /(?:^|\/)(?:sudoers(?:\.d)?(?:\/|$)|[^/]+\.sudoers$)/i.test(file.path);
}

function invokesSudoersModification(text) {
  return /\/etc\/sudoers(?:\.d)?(?:\/|\b)|\bvisudo\b|\bSUDOERS(?:_FILE)?\s*=/i.test(text);
}

function shellLiteralValue(value, literals = new Map()) {
  const raw = String(value || "").trim();
  const quoted = raw.length >= 2 && raw[0] === raw.at(-1) && ["\"", "'"].includes(raw[0]);
  let text = quoted ? decodeLiteral(raw.slice(1, -1)) : raw;
  if (!quoted && /[\s;&|()`]/.test(text)) return "";
  if (quoted && raw[0] === "'") return text;
  let unresolved = false;
  text = text.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced, plain) => {
    const name = braced || plain;
    if (!literals.has(name)) {
      unresolved = true;
      return match;
    }
    return literals.get(name);
  });
  return unresolved ? "" : text;
}

function mapStateKey(value) {
  return JSON.stringify([...value.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function uniqueMapStates(values, limit = 64) {
  const unique = [...new Map(values.map((value) => [mapStateKey(value), value])).values()];
  if (unique.length > limit) {
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      "The static shell-state expansion limit was exceeded",
    );
  }
  return unique;
}

function shellMutationVariables(command) {
  const executable = shellExecutable(command.text);
  if (executable.basename === "unset") {
    return shellWordTokens(executable.rest).filter((token) => !token.startsWith("-"));
  }
  if (executable.basename === "printf") {
    return [executable.rest.match(/(?:^|\s)-v\s+([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1]].filter(Boolean);
  }
  if (executable.basename === "read") {
    const beforeRedirect = executable.rest.split(/\s+</)[0];
    return shellWordTokens(beforeRedirect).filter((token) => (
      !token.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token)
    ));
  }
  return [];
}

function shellCommandStates(file) {
  let possibilities = [new Map()];
  const states = [];
  for (const command of compoundSegments(file)) {
    const assignment = shellAssignment(command);
    const mutations = shellMutationVariables(command);
    const conditional = ["&&", "||"].includes(command.previousOperator);
    const next = [];
    for (const previous of possibilities) {
      if (conditional && (assignment || mutations.length)) next.push(new Map(previous));
      const current = new Map(previous);
      if (assignment) {
        const literal = shellLiteralValue(assignment.value, current);
        if (literal) current.set(assignment.variable, literal);
        else current.delete(assignment.variable);
      }
      for (const variable of mutations) current.delete(variable);
      next.push(current);
    }
    possibilities = uniqueMapStates(next);
    for (const literals of possibilities) states.push({ command, literals: new Map(literals) });
  }
  return states;
}

function resolvedShellToken(token, literals) {
  const raw = stripOuterTokenQuotes(String(token || "").trim());
  const variable = raw.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/)?.slice(1).find(Boolean);
  return variable ? literals.get(variable) || "" : shellLiteralValue(raw, literals);
}

function sudoersDestination(command, literals) {
  const executable = shellExecutable(command.text);
  const outputTarget = commandOutputTarget(command);
  if (/\btee\b/i.test(command.text) && outputTarget) {
    return resolvedShellToken(outputTarget, literals);
  }
  if (["install", "cp", "mv"].includes(executable.basename)) {
    const withoutRedirects = executable.rest.split(/\s+\d*>|\s+>/)[0];
    const tokens = shellWordTokens(withoutRedirects);
    return resolvedShellToken(tokens.at(-1), literals);
  }
  return resolvedShellToken(commandOutputTarget(command), literals);
}

function writesSudoersDestination(state) {
  return /\/etc\/sudoers(?:\.d)?(?:\/|\b)/i.test(
    sudoersDestination(state.command, state.literals),
  );
}

function commandOutputTarget(command) {
  const tee = command.text.match(/\btee(?:\s+-[A-Za-z]+)*\s+("[^"]+"|'[^']+'|[^\s|;&]+)/i)?.[1];
  if (tee) return tee;
  const dd = command.text.match(/\bdd\b[^\n]*?(?:^|\s)of=("[^"]+"|'[^']+'|[^\s|;&]+)/i)?.[1];
  if (dd) return dd;
  return command.text.match(/(?:^|[^<])>{1,2}\s*("[^"]+"|'[^']+'|[^\s|;&]+)/)?.[1] || "";
}

function targetIsInstalledAsSudoers(target, currentState, laterStates) {
  if (!target) return false;
  const resolvedTarget = resolvedShellToken(target, currentState.literals);
  if (/\/etc\/sudoers(?:\.d)?(?:\/|\b)/i.test(resolvedTarget)) return true;
  const variable = stripOuterTokenQuotes(target)
    .match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/)
    ?.slice(1).find(Boolean);
  return laterStates.some((state) => (
    writesSudoersDestination(state)
    && (variable
      ? variableReference(state.command.text, variable)
      : shellWordTokens(state.command.text).some((token) => (
          resolvedShellToken(token, state.literals) === resolvedTarget
        )))
  ));
}

function commandPolicySources(file) {
  const states = shellCommandStates(file);
  const sources = [];
  for (const [index, state] of states.entries()) {
    const target = commandOutputTarget(state.command);
    if (!target || !targetIsInstalledAsSudoers(target, state, states.slice(index + 1))) continue;
    const literals = quotedLiterals(state.command.text)
      .filter((literal) => /\b(?:NOPASSWD|Cmnd_Alias)\b/i.test(literal));
    for (const literal of literals) sources.push({ text: literal, evidence: evidence(state.command) });
    for (const [name, literal] of state.literals) {
      if (
        /\b(?:NOPASSWD|Cmnd_Alias)\b/i.test(literal)
        && variableReference(state.command.text, name)
      ) sources.push({ text: literal, evidence: evidence(state.command) });
    }
  }
  return sources;
}

function expandKnownShellVariables(text, literals) {
  return String(text || "").replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, braced, plain) => literals.get(braced || plain) ?? match,
  );
}

function heredocPolicySources(file) {
  const lines = String(file.content || "").split(/\r?\n/);
  const states = shellCommandStates(file);
  const sources = [];
  for (let index = 0; index < lines.length; index++) {
    const delimiterMatch = lines[index].match(/<<-?\s*(?:(["'])([A-Za-z_][A-Za-z0-9_]*)\1|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/);
    if (!delimiterMatch) continue;
    const delimiter = delimiterMatch[2] || delimiterMatch[3] || delimiterMatch[4];
    const quotedDelimiter = Boolean(delimiterMatch[1] || delimiterMatch[3]);
    const openingLine = index + 1;
    const body = [];
    for (index++; index < lines.length && lines[index].replace(/^\t+/, "").trim() !== delimiter; index++) {
      body.push(lines[index]);
    }
    const state = [...states].reverse().find((entry) => entry.command.line <= openingLine)
      || { command: { path: file.path, line: openingLine, text: lines[openingLine - 1] }, literals: new Map() };
    const text = quotedDelimiter
      ? body.join("\n")
      : expandKnownShellVariables(body.join("\n"), state.literals);
    if (!/\b(?:NOPASSWD|Cmnd_Alias)\b/i.test(text)) continue;
    const opening = { path: file.path, line: openingLine, text: lines[openingLine - 1] };
    const openingState = { command: opening, literals: state.literals };
    const target = commandOutputTarget(opening);
    const laterStates = states.filter((entry) => entry.command.line > index + 1);
    if (targetIsInstalledAsSudoers(target, openingState, laterStates)) {
      sources.push({ text, evidence: evidence(opening) });
    }
  }
  return sources;
}

function commandReferencesRepositoryPath(state, path) {
  const normalizedPath = String(path || "").replace(/^\.\//, "");
  return shellWordTokens(state.command.text).some((token) => {
    const sourceToken = token.match(/^(?:if|src|source)=(.+)$/)?.[1] || token;
    return resolvedShellToken(sourceToken, state.literals).replace(/^\.\//, "") === normalizedPath;
  });
}

function sudoersPolicySources(files) {
  const sources = [];
  for (const file of files) {
    if (isSudoersPolicyFile(file)) {
      sources.push(...commandSequence(file).map((command) => ({ text: command.text, evidence: evidence(command) })));
      continue;
    }
    if (!isShellRuntimePath(file.path) && !isExecutableTextFile(file)) continue;
    if (
      !invokesSudoersModification(file.content || "")
      && !/\b(?:NOPASSWD|Cmnd_Alias)\b/i.test(file.content || "")
    ) continue;
    const states = shellCommandStates(file);
    for (const state of states) {
      if (!writesSudoersDestination(state)) continue;
      for (const candidate of files.filter((entry) => !entry.binary && entry !== file)) {
        if (
          /\b(?:NOPASSWD|Cmnd_Alias)\b/i.test(candidate.content || "")
          && commandReferencesRepositoryPath(state, candidate.path)
        ) {
          sources.push(...commandSequence(candidate).map((entry) => ({ text: entry.text, evidence: evidence(entry) })));
        }
      }
    }
    sources.push(...commandPolicySources(file));
    sources.push(...heredocPolicySources(file));
  }
  return sources;
}

function sudoersAliases(policySources) {
  const aliases = new Map();
  const text = policySources.map((source) => source.text).join("\n").replace(/\\\s*\n/g, " ");
  for (const line of text.split(/\r?\n/)) {
    const match = stripInlineComment(line).match(/^\s*Cmnd_Alias\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/i);
    if (match) aliases.set(match[1], match[2].split(",").map((entry) => entry.trim()).filter(Boolean));
  }
  return aliases;
}

function passwordlessSudoersEntries(text) {
  const active = new Map();
  const value = String(text || "").replace(/\\\s*\n/g, " ");
  for (const line of value.split(/\r?\n/)) {
    const policy = stripInlineComment(line);
    const tags = [...policy.matchAll(/\b(NOPASSWD|PASSWD)\s*:/gi)];
    if (!tags.length) continue;
    const prefix = policy.slice(0, tags[0].index).replace(/\s+/g, " ").trim();
    for (const [index, tag] of tags.entries()) {
      const start = tag.index + tag[0].length;
      const end = tags[index + 1]?.index ?? policy.length;
      const passwordless = tag[1].toUpperCase() === "NOPASSWD";
      for (const rawEntry of policy.slice(start, end).split(",")) {
        const entry = rawEntry.trim();
        if (!entry) continue;
        const negated = entry.startsWith("!");
        const normalized = (negated ? entry.slice(1) : entry).replace(/\s+/g, " ").trim();
        const key = `${prefix}\0${normalized}`;
        if (/^ALL(?:\s|$)/i.test(normalized) && (!passwordless || negated)) {
          for (const activeKey of [...active.keys()]) {
            if (activeKey.startsWith(`${prefix}\0`)) active.delete(activeKey);
          }
        } else if (passwordless && !negated) {
          active.set(key, entry);
        } else {
          active.delete(key);
        }
      }
    }
  }
  return [...active.values()];
}

function dangerousSudoersEntry(entry, aliases, visited = new Set()) {
  const value = entry.replace(/^[|\s]+|[|\s]+$/g, "");
  if (!value || value.startsWith("!")) return false;
  if (/^ALL(?:\s|$)/i.test(value)) return true;
  const alias = value.match(/^([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  if (alias && aliases.has(alias) && !visited.has(alias)) {
    const nextVisited = new Set(visited).add(alias);
    return aliases.get(alias).some((candidate) => dangerousSudoersEntry(candidate, aliases, nextVisited));
  }
  const executablePath = value.match(/\/[^\s,]+/)?.[0] || "";
  const unescapedGlob = (text) => /(^|[^\\])(?:\*|\?|\[)/.test(text);
  if (executablePath.startsWith("/") && unescapedGlob(executablePath)) return true;
  if (!executablePath) return false;
  const basename = executablePath.split("/").at(-1).toLowerCase();
  const knownCommand = new Set([
    "kill", "pkill", "systemctl", "systemd-run", "rm", "mv", "cp", "install", "tee",
    "chmod", "chown", "mount", "umount", "wg-quick", "sudo", "su", "env", "busybox",
    "toybox", "sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "perl", "ruby", "node",
    "php", "deno", "java", "dotnet",
  ]).has(basename) || /^python[0-9.]*$/.test(basename);
  if (!knownCommand) return false;
  const argumentsValue = value.slice(value.indexOf(executablePath) + executablePath.length).trim();
  if (argumentsValue === '""' || argumentsValue === "''") return false;
  if (["busybox", "toybox"].includes(basename)) {
    const shellApplet = argumentsValue.match(/^(?:ba|z|fi|da|a|k)?sh(?:\s+(.*))?$/i);
    if (shellApplet) return !shellApplet[1] || unescapedGlob(shellApplet[1]);
  }
  if (["sudo", "su", "env"].includes(basename)) return true;
  const interpreter = ["sh", "bash", "zsh", "fish", "dash", "ash", "ksh", "python", "python2", "python3", "perl", "ruby", "node", "php", "deno", "java", "dotnet"]
    .some((name) => basename === name || basename.startsWith(`${name}.`));
  if (interpreter) return !argumentsValue || unescapedGlob(argumentsValue);
  return !argumentsValue || unescapedGlob(argumentsValue);
}

function dangerousPasswordlessSudoersFindings(files) {
  const policySources = sudoersPolicySources(files);
  if (!policySources.length) return [];
  const aliases = sudoersAliases(policySources);
  return policySources.filter((source) => (
    passwordlessSudoersEntries(source.text).some((entry) => dangerousSudoersEntry(entry, aliases))
  )).map((source) => ({
    ruleId: "sudoers-dangerous-passwordless-command",
    ...ruleCatalog["sudoers-dangerous-passwordless-command"],
    evidence: [source.evidence],
  }));
}

function shellPrivilegeWrappers(file) {
  const wrappers = new Map();
  const text = String(file.content || "");
  const matches = [
    ...text.matchAll(/^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\))?\s*\{([^{}\n]*)\}\s*$/gm),
    ...text.matchAll(/^\s*(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\))?\s*\{([\s\S]*?)^\s*\}/gm),
  ];
  for (const match of matches) {
    const body = match[2].split(/\r?\n/).map(stripInlineComment).filter(Boolean).join("\n");
    const privilegeInvocation = /^\s*(?:(?:if|then|elif)\s+)?(?:(?:command|exec|env)\s+)*(?:\/usr\/bin\/)?(?:sudo|pkexec)\b/gm;
    if (!privilegeInvocation.test(body)) continue;
    privilegeInvocation.lastIndex = 0;
    wrappers.set(match[1], {
      fixedKill: new RegExp(`${privilegeInvocation.source}[^\\n]*\\b(?:\\/usr\\/bin\\/)?kill\\b`, "m").test(body),
    });
  }
  return wrappers;
}

function shellAssignment(command) {
  const match = command.text.match(
    /^\s*(?:(?:export|readonly|local|declare)(?:\s+-[A-Za-z]+)?\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/,
  );
  return match ? { variable: match[1], value: match[2] } : null;
}

function sharedTempPidValue(value) {
  return /\/tmp\//i.test(value)
    || /XDG_RUNTIME_DIR[^\n]*:-\/tmp(?:[}"']|\/)/i.test(value);
}

function variableReference(text, variable) {
  return new RegExp(`(?:\\$${variable}\\b|\\$\\{${variable}\\})`).test(text);
}

function privilegedKillCommand(command, wrappers) {
  const executable = shellExecutable(command.text);
  const text = stripInlineComment(command.text);
  if (/\b(?:sudo|pkexec)\b/.test(text)) {
    if (executable.basename === "kill") return true;
    const payload = literalShellPayload(command);
    if (payload && shellExecutable(payload).basename === "kill") return true;
  }
  const wrapper = wrappers.get(executable.basename);
  if (!wrapper) return false;
  if (wrapper.fixedKill) return true;
  return shellExecutable(executable.rest.replace(/^--\s+/, "")).basename === "kill";
}

function sharedPidSource(value, pidFiles, fallbackEvidence) {
  const source = stripOuterTokenQuotes(String(value || "").trim());
  const variable = source.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/)?.slice(1).find(Boolean);
  if (variable && pidFiles.has(variable)) {
    return { pidFile: variable, assignmentEvidence: pidFiles.get(variable).evidence };
  }
  if (/\.pid\b/.test(source) && sharedTempPidValue(source)) {
    return { pidFile: source, assignmentEvidence: fallbackEvidence };
  }
  return null;
}

function clonePidState(state) {
  return {
    pidFiles: new Map(state.pidFiles),
    processVariables: new Map(state.processVariables),
  };
}

function applyPidCommand(state, command, wrappers) {
  const { pidFiles, processVariables } = state;
  const assignment = shellAssignment(command);
  if (assignment) {
    const assignmentValue = stripOuterTokenQuotes(assignment.value);
    const read = assignmentValue.match(/^\$\(\s*(?:cat(?:\s+--)?\s+|<\s*)(.+?)\s*\)$/);
    const source = read ? sharedPidSource(read[1], pidFiles, evidence(command)) : null;
    if (source) {
      processVariables.set(assignment.variable, { ...source, readEvidence: evidence(command) });
    } else {
      processVariables.delete(assignment.variable);
    }
    if (/\.pid["']?\s*$/.test(assignment.value)) {
      if (sharedTempPidValue(assignment.value)) {
        pidFiles.set(assignment.variable, { evidence: evidence(command) });
      } else {
        pidFiles.delete(assignment.variable);
      }
    } else {
      pidFiles.delete(assignment.variable);
    }
  }

  const mutationVariables = shellMutationVariables(command);
  for (const variable of mutationVariables) {
    processVariables.delete(variable);
    pidFiles.delete(variable);
  }

  const readExecutable = shellExecutable(command.text);
  const readRedirect = readExecutable.basename === "read"
    ? readExecutable.rest.match(/^(.+?)\s*<\s*(.+?)\s*$/)
    : null;
  if (readRedirect) {
    const targets = shellWordTokens(readRedirect[1]).filter((token) => (
      !token.startsWith("-") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token)
    ));
    const source = sharedPidSource(readRedirect[2], pidFiles, evidence(command));
    for (const target of targets) {
      if (source) processVariables.set(target, { ...source, readEvidence: evidence(command) });
      else processVariables.delete(target);
    }
  }

  if (!privilegedKillCommand(command, wrappers)) return null;
  const processVariable = [...processVariables.keys()].find((name) => variableReference(command.text, name));
  const directRead = command.text.match(/\$\(\s*(?:cat(?:\s+--)?\s+|<\s*)(.+?)\s*\)/);
  const directSource = directRead
    ? sharedPidSource(directRead[1], pidFiles, evidence(command))
    : null;
  const sourceState = processVariable
    ? processVariables.get(processVariable)
    : directSource
      ? { ...directSource, readEvidence: evidence(command) }
      : null;
  if (!sourceState) return null;
  return {
    ruleId: "privileged-process-control-from-shared-temp",
    ...ruleCatalog["privileged-process-control-from-shared-temp"],
    evidence: [sourceState.assignmentEvidence, sourceState.readEvidence, evidence(command)],
  };
}

function clonePidPossibilities(values) {
  return values.map(clonePidState);
}

function uniquePidPossibilities(values) {
  const keyed = new Map(values.map((state) => [
    `${mapStateKey(state.pidFiles)}\0${mapStateKey(state.processVariables)}`,
    state,
  ]));
  const unique = [...keyed.values()];
  if (unique.length > 64) {
    throw new SecurityBaselineError(
      "security-baseline-scan-limit",
      "The static process-state expansion limit was exceeded",
    );
  }
  return unique;
}

function privilegedTempProcessFinding(file) {
  if (!isShellRuntimePath(file.path) && !isExecutableTextFile(file)) return null;
  const wrappers = shellPrivilegeWrappers(file);
  let possibilities = [{ pidFiles: new Map(), processVariables: new Map() }];
  const branches = [];
  for (const rawCommand of compoundSegments(file)) {
    let command = rawCommand;
    const control = command.text.trim();
    if (/^if(?:\s|$)/.test(control)) {
      const condition = control.replace(/^if\b/, "").trim();
      if (condition) {
        const next = [];
        const conditionCommand = { ...command, text: condition };
        for (const previous of possibilities) {
          const current = clonePidState(previous);
          const finding = applyPidCommand(current, conditionCommand, wrappers);
          if (finding) return finding;
          next.push(current);
        }
        possibilities = uniquePidPossibilities(next);
      }
      branches.push({ base: clonePidPossibilities(possibilities), then: null, inElse: false });
      continue;
    }
    if (/^then(?:\s|$)/.test(control)) {
      const remainder = control.replace(/^then\b/, "").trim();
      if (!remainder) continue;
      command = { ...command, text: remainder };
    }
    if (/^(?:else|elif)(?:\s|$)/.test(control) && branches.length) {
      const branch = branches.at(-1);
      branch.then = clonePidPossibilities(possibilities);
      branch.inElse = true;
      possibilities = clonePidPossibilities(branch.base);
      const remainder = control.replace(/^(?:else|elif)\b/, "").trim();
      if (!remainder || /^elif\b/.test(control)) continue;
      command = { ...command, text: remainder };
    }
    if (/^fi(?:\s|$)/.test(control) && branches.length) {
      const branch = branches.pop();
      possibilities = uniquePidPossibilities(branch.inElse
        ? [...(branch.then || []), ...possibilities]
        : [...branch.base, ...possibilities]);
      const remainder = control.replace(/^fi\b/, "").trim();
      if (!remainder) continue;
      command = { ...command, text: remainder };
    }

    const conditional = ["&&", "||"].includes(command.previousOperator);
    const mutatesState = Boolean(shellAssignment(command) || shellMutationVariables(command).length);
    const next = [];
    for (const previous of possibilities) {
      if (conditional && mutatesState) next.push(clonePidState(previous));
      const current = clonePidState(previous);
      const finding = applyPidCommand(current, command, wrappers);
      if (finding) return finding;
      next.push(current);
    }
    possibilities = uniquePidPossibilities(next);
  }
  return null;
}

export function detectUnsafeRemoteExecution(files, submissionRepository = "") {
  const findings = [];
  const preparedFiles = files.filter((entry) => !entry.binary).map((file) => ({
    ...file,
    ...(isRootReadme(file.path)
      ? { documentedRepositories: [...commandRemoteRepositories(file)] }
      : {}),
  }));
  const expandedFiles = expandedSecurityFiles(preparedFiles);
  for (const file of expandedFiles) {
    const commands = commandSequence(file);
    const runtime = isShellRuntimePath(file.path) || isExecutableTextFile(file);
    for (const command of commands) {
      if (runtime) {
        const pipe = pipeToShellFinding(command, submissionRepository);
        if (pipe) findings.push(pipe);
        const cargo = cargoGitFinding(command, file, submissionRepository);
        if (cargo) findings.push(cargo);
      }
    }
    if (runtime) {
      const sharedTemp = privilegedTempProcessFinding(file);
      if (sharedTemp) findings.push(sharedTemp);
      findings.push(...remoteGitExecutionFindings(file, submissionRepository));
    }
  }
  findings.push(...dangerousPasswordlessSudoersFindings(expandedFiles));
  return dedupeFindings(findings);
}

function capability(id, command) {
  return {
    id,
    ...capabilityCatalog[id],
    evidence: [evidence(command)],
  };
}

function installerEvidence(file) {
  const basename = file.path.split("/").at(-1);
  if (!/(?:^|[-_])(install|installer|setup|uninstall)(?:[-_.]|$)/i.test(basename)) return null;
  return { path: file.path, line: 1, snippet: "Installer or setup file" };
}

function invokesPrivilegeBoundary(text) {
  const names = "(?:sudo|pkexec)";
  const list = `${names}(?:\\s*(?:,|/|\\bor\\b|\\band\\b)\\s*${names})*`;
  const explicitNegativeList = `${names}(?:\\s*(?:/|\\bor\\b|\\band\\b)\\s*(?:no\\s+)?${names})*`;
  const negativePredicate = "\\s+(?:is|are)(?:\\s+not)?\\s+(?:required|needed)\\b";
  const notUsedPredicate = "\\s+(?:is|are)\\s+not\\s+used\\b";
  const noUsePredicate = "\\s+(?:is|are)(?:\\s+not)?\\s+used\\b";
  const terminal = "(?=\\s*(?:[.;!?]|,\\s*(?:no|without)\\b|$))";
  const value = stripInlineComment(text)
    .replace(new RegExp(`\\b(?:no|without)(?:\\s+(?:use\\s+of|using))?\\s+${explicitNegativeList}(?:${negativePredicate}|${noUsePredicate})`, "gi"), "")
    .replace(new RegExp(`\\b${list}(?:${notUsedPredicate}|\\s+(?:is|are)\\s+not\\s+(?:required|needed)\\b)`, "gi"), "")
    .replace(new RegExp(`\\b(?:no|without)(?:\\s+(?:use\\s+of|using))?\\s+${list}${terminal}`, "gi"), "")
    .replace(new RegExp(`\\b(?:does\\s+not|doesn't|do\\s+not|don't|never)\\s+(?:use|run|invoke|require|need)\\s+${list}${terminal}`, "gi"), "");
  return new RegExp(`\\b${names}\\b`, "i").test(value);
}

function dedupeCapabilities(capabilities) {
  const byId = new Map();
  for (const item of capabilities) {
    if (!byId.has(item.id)) {
      byId.set(item.id, { ...item, evidence: [...item.evidence] });
      continue;
    }
    const existing = byId.get(item.id);
    for (const itemEvidence of item.evidence) {
      if (!existing.evidence.some((entry) => entry.path === itemEvidence.path && entry.line === itemEvidence.line)) {
        existing.evidence.push(itemEvidence);
      }
    }
  }
  return [...byId.values()].map((item) => ({ ...item, evidence: item.evidence.slice(0, 5) }));
}

export function detectElevatedCapabilities(files, submissionRepository = "") {
  const capabilities = [];
  for (const binary of (files || []).filter((entry) => entry.binary && entry.mode === "100755")) {
    capabilities.push({
      id: "bundled-executable-binary",
      ...capabilityCatalog["bundled-executable-binary"],
      evidence: [{
        path: binary.path,
        line: 1,
        snippet: `${binary.format} executable binary (${binary.size} bytes)`,
      }],
    });
  }
  for (const file of expandedSecurityFiles((files || []).filter((entry) => !entry.binary))) {
    const installer = installerEvidence(file);
    if (installer) capabilities.push({ id: "installer", ...capabilityCatalog.installer, evidence: [installer] });
    if (isSudoersPolicyFile(file)) {
      capabilities.push({
        id: "sudoers-modification",
        ...capabilityCatalog["sudoers-modification"],
        evidence: [{ path: file.path, line: 1, snippet: "sudoers policy file" }],
      });
    }
    if (/\.service$/i.test(file.path)) {
      capabilities.push({
        id: "service-management",
        ...capabilityCatalog["service-management"],
        evidence: [{ path: file.path, line: 1, snippet: "systemd service unit" }],
      });
    }
    const commands = commandSequence(file);
    if (!isRootReadme(file.path) || file.documentation) {
      const segments = compoundSegments(file);
      for (const [index, command] of segments.entries()) {
        if (!isGitAcquisition(command)) continue;
        const directory = gitAcquisitionDirectory(command);
        if (segments.slice(index + 1).some((segment) => isExecutionSink(segment, directory))) {
          capabilities.push(capability("remote-build", command));
        }
      }
    }
    for (const command of commands) {
      const text = command.text;
      if (invokesSudoersModification(text)) capabilities.push(capability("sudoers-modification", command));
      if (
        commandUsesOnlySubmissionRepository(command, submissionRepository)
        && /\b(?:git\s+(?:clone|fetch|pull)|curl|wget)\b/i.test(text)
      ) capabilities.push(capability("remote-build", command));
      if (invokesPrivilegeBoundary(text)) capabilities.push(capability("privilege", command));
      if (
        /\bomarchy\s+pkg\s+(?:add|drop|remove|update)\b/i.test(text)
        || /\b(?:pacman|paru|yay|apt|apt-get|dnf|zypper|apk)\s+(?:-[A-Za-z]*[SRU]|install|remove|upgrade|add|del)\b/i.test(text)
        || /(?:^|[\s/'"])(?:pip|pip3|pipx)["']?\s+install\s+[-\w.\/]/i.test(text)
        || /\bpython[23]?(?:\.[0-9]+)?\s+-m\s+pip\s+install\b/i.test(text)
        || /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b/i.test(text)
        || /\bcargo\s+install\b/i.test(text)
        || /\bgo\s+install\b/i.test(text)
        || /\bgem\s+install\b/i.test(text)
        || /\bbrew\s+(?:install|uninstall|upgrade)\b/i.test(text)
      ) capabilities.push(capability("package-manager", command));
      if (/\bsystemctl\b|\bsystemd-run\b/i.test(text)) {
        capabilities.push(capability("service-management", command));
      }
      if (/\bcargo\s+install\b/i.test(text) && /\s--git(?:\s|=)/i.test(text)) {
        capabilities.push(capability("remote-build", command));
      }
    }
  }
  return dedupeCapabilities(capabilities);
}

export function buildSecurityBaseline({ repository, repoUrl, commitSha, files }, options = {}) {
  const commit = assertFullCommitSha(commitSha);
  const submissionRepository = parseGitHubRepository(repoUrl).slug.toLowerCase();
  if (String(repository || "").toLowerCase() !== submissionRepository) {
    throw new SecurityBaselineError("security-baseline-invalid", "Repository identity does not match its URL");
  }
  const findings = detectUnsafeRemoteExecution(files, submissionRepository);
  const capabilities = detectElevatedCapabilities(files, submissionRepository);
  const outcome = securityBaselineOutcome(findings, capabilities);
  const summary = {
    outcome,
    enforcementMode: securityBaselineEnforcementMode,
    findings,
    capabilities,
  };
  return {
    schemaVersion: 1,
    baselineVersion: securityBaselineVersion,
    repository,
    repoUrl,
    commitSha: commit,
    checkedAt: options.checkedAt || new Date().toISOString(),
    outcome,
    enforcementMode: securityBaselineEnforcementMode,
    disposition: securityBaselineDisposition(summary),
    blocksApproval: securityBaselineBlocksApproval(summary),
    findings,
    capabilities,
  };
}
