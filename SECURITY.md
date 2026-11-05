# Security Policy

## Report a Security Concern

Report suspected malicious, compromised, or otherwise unsafe marketplace plugins through [GitHub's private vulnerability reporting form](https://github.com/omacom/omarchy-plugin-marketplace/security/advisories/new).

Do not disclose credentials, exploit details, personal information, or other sensitive material in a public issue. Include the marketplace listing, plugin repository, relevant commit, observed behavior, and any safe reproduction details in the private report.

If the concern originates in an upstream plugin, also notify that plugin's maintainer privately when a suitable channel is available. The Marketplace may suspend or remove a listing while concerns are investigated.

For marketplace content that may affect copyright, trademark, privacy, or other rights rather than security, use the [rights or asset removal request](https://github.com/omacom/omarchy-plugin-marketplace/issues/new?template=rights-request.yml).

## Scope

Marketplace checks are limited automated compatibility and security-baseline checks on identified plugin commits, with manual review where required. They are not a security audit, certification, endorsement, or guarantee. Community plugins execute as unsandboxed third-party code.

## Automated Security Baseline

These guidelines apply to every plugin author, marketplace contributor, and maintainer who submits a plugin or changes submission, validation, approval, registry, or catalog behavior.

**This is not a security audit, certification, warranty, or endorsement.**

### Architecture and policy ownership

`security-baseline-policy.mjs` is the single deterministic owner of the active policy version, marker protocol, finding and capability catalogs, outcomes, enforcement, verified-publication eligibility, and workflow label disposition. Scanner, approval, verification, and workflows consume that policy rather than reconstructing it. `security-baseline-record.mjs` converts initial approval, plugin update, and later verification results into the same versioned registry record. `verification-review.mjs` validates the exact maintainer-review attestations used by `approved-and-verified` snapshot publication and `maintainer-verified` existing-snapshot verification. Catalog verification facts are a projection of registry evidence, while the public display also compares the observed upstream commit with the verification commit so later code cannot inherit an unqualified verified state.

Infrastructure boundaries are one-way: dependency-free repository, policy, record, status, subject, and projection modules do not import the catalog builder, image tooling, filesystem adapters, or workflows. The scanner reads community files only as static snapshot data. CLI and GitHub Actions remain outer adapters.

### Purpose and limits

The Automated Security Baseline is a deterministic snapshot-publication check. It identifies only the documented static patterns in this file. It does not perform general data-flow analysis, prove that a plugin is safe, or attempt to stop a motivated attacker.

The baseline does not execute plugin code. It reads selected files from the exact full commit SHA produced by submission, update, or existing-snapshot validation. Plugins remain unsandboxed upstream code, and users must still inspect the source and decide whether to trust it.

### Scan scope and limits

The scan includes recognized script and configuration formats, the root README, manifest entry points, executable files, and relevant extensionless files. Existing-listing verification resolves every configured plugin ID inside the exact requested commit and forces each declared entry point into the scan, including entry points under otherwise excluded directories. Immutable listing manifest paths are stored for new sources and used only as resolution hints; if an upstream refresh later moves a manifest, verification still discovers the configured ID in the listing snapshot rather than trusting the mutable catalog path. Test, fixture, dependency, generated-documentation, and similar excluded directories are not treated as runtime source unless a required entry point selects a file explicitly.

A complete result is limited to:

- 1,000 relevant files
- 8 MiB of relevant text in total
- 512 KiB per relevant text file

Names containing `install`, `installer`, `setup`, or `uninstall` remain candidates even when their extension is not a recognized source format. Known binary asset extensions are normally excluded by path classification, but setup-named paths are reintroduced as candidates and checked with bounded content probes within a 1 MiB aggregate probe budget. At most 256 such candidates are allowed. A complete binary asset with a setup-related name cannot be excluded from the static scan and fails closed; text-like or incomplete content with an asset extension remains in the scan or fails closed. Other binary assets remain excluded by their recognized asset extension. Forced manifest entry points and executable files are never excluded by this asset handling.

Executable files are probed for ELF, PE, and Mach-O formats. A detected executable binary produces the `bundled-executable-binary` capability and requires review; the scanner does not claim to inspect its behavior. Unsupported files, truncated trees, exceeded limits, unavailable snapshots, malformed bounded responses, and other incomplete scans fail closed. Approval is not possible without a complete baseline result.

### Deterministic findings

The following patterns produce findings:

- `curl-pipe-shell`: content downloaded with `curl` or `wget` is passed directly to a shell, invoked through an equivalent literal shell path, or written to a file that a later command executes without verification.
- `cargo-git-unpinned`: `cargo install --git` obtains an external repository without a full 40-character `--rev` commit.
- `remote-git-execution-unpinned`: code from an external Git repository is built or executed without first binding it to a full commit and checking out that commit in detached mode.
- `sudoers-dangerous-passwordless-command`: a `NOPASSWD` policy grants `ALL`, an unrestricted shell or interpreter, unrestricted `wg-quick`, or a broad wildcard command surface for high-risk system tools such as `kill`, `systemctl`, or file-management commands.
- `privileged-process-control-from-shared-temp`: a shell runtime reads a PID from a predictable `/tmp` PID file and passes it to privileged process control through `sudo`, `pkexec`, or a privilege wrapper.

External, unpinned remote execution remains a finding. A source or installation path that obtains code only from the submitted repository is not automatically rejected; it produces the `remote-build` capability and requires maintainer review. A passwordless rule for a root-owned purpose-built helper with a fixed command surface is not automatically blocked; it produces the `sudoers-modification` capability and requires complete manual review of the helper and its inputs.

Contributors should remove download-and-execute paths or pin external source to an immutable full commit before execution. Updating a dependency requires a new plugin commit and a new listing-time baseline result. Runtime PID state should use an owner-only directory such as `$XDG_RUNTIME_DIR`, and privileged process control must not trust mutable shared temporary files.

### Review capabilities

The following detected capabilities require maintainer review but are not findings by themselves:

- `installer`
- `package-manager`
- `privilege`: non-negated references to `sudo` or `pkexec`; clearly negated documentation such as “No sudo or pkexec is required” is excluded.
- `remote-build`
- `bundled-executable-binary`
- `service-management`: systemd service unit files and references to `systemctl` or `systemd-run`; ordinary properties or strings containing `.service` are excluded.
- `sudoers-modification`: sudoers policy files or commands and documentation that install, validate, or remove a sudoers policy.

Capabilities describe deterministic evidence, not intent or safety.

### Outcomes and selective enforcement

The outcome is derived only from findings and capabilities:

- `passed`: no documented finding or review capability was detected.
- `review-required`: one or more review capabilities were detected without a finding.
- `needs-fixes`: one or more documented findings were detected.

The baseline currently runs in `selective` enforcement mode. That mode still determines validation labels and preserves V3 outcome semantics:

- `review-required` adds `security-review-required` and remains eligible for exact capability acceptance.
- `needs-fixes` caused only by remote-execution findings adds `security-review-required` while those measured rules are refined.
- `needs-fixes` containing `sudoers-dangerous-passwordless-command` or `privileged-process-control-from-shared-temp` adds `security-needs-fixes`.
- Baseline scan failures remain fail closed.

Every new listing and promoted plugin update must have eligible exact-commit evidence when published. A current `passed` result is eligible automatically after explicit maintainer approval. Under the V3 selective policy, an authorized maintainer may accept a complete `review-required` disposition—including reported capabilities and non-selectively-blocking findings—through `approved-and-verified`; the attestation binds the exact finding and capability sets. Every selectively blocking `needs-fixes` disposition must be fixed in a new validated commit before publication. Existing-snapshot `maintainer-verified` remains capability-only and does not change. Incomplete scans, stale evidence, scan errors, and selectively blocking findings have no verification bypass. Implementations must not use AI to determine baseline outcomes, enforcement, labels, or approval. Outcomes and automated labels must remain deterministic code paths; snapshot approval and maintainer-reviewed verification must remain explicit authorized-maintainer actions.

### Exact-SHA binding

Validation, baseline scanning, `approved-and-verified`, exact catalog generation, and every pre-publication recheck must refer to the same exact full commit SHA. Initial listing and plugin update approval both perform a fresh scan and require it to match the bot-authored report that predates the exact label event. A changed branch head invalidates the recorded validation and requires a new run. Catalog generation must resolve the approved repository at that commit rather than at a mutable branch or tag.

The registry stores automated baseline facts needed to preserve that binding: record schema, baseline version, repository, affected plugin IDs, full commit, scan time, outcome, enforcement mode, finding IDs, and capability IDs. Legacy records created before the explicit schema and identity fields remain valid only through their containing registry source and exact marketplace snapshot. A maintainer-reviewed verification is stored separately as a canonical attestation containing the reviewer, exact label-event ID, label-request time, review time, and the pre-label report's scan time, while repeating the exact rescanned baseline identity and accepted finding and capability sets. The bot-authored pre-label report and post-label rescan must match on repository, plugin IDs, commit, policy version, enforcement mode, outcome, findings, and capabilities. New submissions and plugin updates bind publication to `approved-and-verified`; existing-snapshot verification binds review to `maintainer-verified`. Superseded update evidence is retained under `listingValidationHistory` but is never used to derive the current status. It is not a freely editable verification flag; every duplicated field must match the current automated record exactly.

### Snapshot check and upstream drift

The stored baseline applies only to the exact current `listingValidatedCommit`. Scheduled Catalog Refresh remains a separate compatibility process that reads upstream branch HEAD. It does not rerun or update stored baseline evidence. When it observes a different commit, the public state becomes `Update unverified`; the old snapshot remains recorded and verified, but the newer upstream code is not covered. Only the plugin update workflow may promote a new commit and replace the current canonical evidence. Each promotion preserves the superseded snapshot evidence in registry history.

### Plugin verification status

A community snapshot has eligible verification when its exact `listingValidatedCommit` has either a complete current-version baseline with outcome `passed`, the current enforcement mode, and empty finding and capability sets, or a valid maintainer-review attestation. Initial-listing and update attestations may cover a complete selective `review-required` publication disposition, including non-selectively-blocking findings; existing-snapshot `maintainer-verified` attestations remain limited to a complete `review-required` outcome with no findings. Every attestation must match the repository, source plugin set, commit, baseline version, enforcement mode, scan time, outcome, finding IDs, and capability IDs exactly. New submissions and promoted updates must establish one of these records atomically before publication. Existing records that are missing, stale, or ineligible project to `Unverified`; a known newer upstream commit projects to `Update unverified`. A maintainer review with an exact event-bound `approval-applied-in-error` revocation also projects to `Unverified` while preserving the original review and revocation in the registry and later listing history. A new review requires a fresh eligible report and a later label event. Neither state means that the plugin is malicious.

The unified verification form routes a recorded-snapshot request only to the repository and exact commit already recorded by the listing. A different current HEAD commit must use the newer-upstream action in that form and the separate guarded update approval process. Automated verification never executes community code and does not turn a baseline result into a security audit, certification, warranty, endorsement, or guarantee.

The current Omarchy install and update commands obtain mutable upstream HEAD and do not accept an exact marketplace SHA. Plugin detail pages therefore label those commands as current-upstream and not verification-bound. If installation obtains another commit, that installed code is not covered by snapshot verification. Commit-bound installation cannot be guaranteed by the marketplace without exact-SHA support in Omarchy.

### Contributor requirements

Changes to the baseline or its workflow must:

1. Preserve static analysis without executing plugin code.
2. Keep outcomes, labels, evidence, and reports deterministic and independent of AI decisions.
3. Preserve exact-SHA binding and fail-closed scan errors.
4. Document every detected pattern and accepted remediation in this file and in public feedback.
5. Add focused positive, negative, boundary, and tampering tests.
6. Keep the required disclaimer in every baseline result and relevant public documentation.
7. Preserve least-privilege workflow permissions, pinned actions, timeouts, and concurrency controls.
8. Backtest rule or scope changes against the existing registry and report outcome changes and scan failures before enforcement changes.
9. Treat a change to outcomes, enforcement, pattern meaning, or stored schema as a versioned policy decision requiring maintainer review.

Do not weaken, relabel, or manually fabricate a baseline result. Initial-listing and update review may accept only the exact evidence in an eligible selective review disposition; existing-snapshot `maintainer-verified` may accept only capabilities in an eligible exact-commit `review-required` record. Neither path may suppress selectively blocking findings or convert a failed or incomplete scan.
