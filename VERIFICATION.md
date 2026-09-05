# Plugin Verification

Plugin verification combines a deterministic, commit-bound source check with narrowly scoped maintainer-review paths for new submissions, existing community listings, and plugin updates.

**Verification is not a security audit, certification, warranty, endorsement, or guarantee that a plugin is safe.** Community plugins remain unsandboxed third-party code.

## Statuses

A community plugin has a verified snapshot only when the registry contains one of these exact-commit records:

- a complete current-version Automated Security Baseline result with outcome `passed`, no findings or review capabilities, no scan error, the current enforcement mode, and the exact `listingValidatedCommit`; or
- a canonical maintainer-review attestation for a complete baseline with a current selective `review-required` publication disposition and no scan error. Existing-snapshot `maintainer-verified` remains limited to capability-only `review-required` outcomes with no findings.

The maintainer attestation repeats and must exactly match the baseline repository, source plugin IDs, commit, policy version, enforcement mode, scan time, outcome, accepted finding set, and accepted capability set. It also records the authorized reviewer, exact label-event ID, label-request time, and review time.

The public display distinguishes that snapshot from later upstream code:

- `Snapshot verified` means the recorded marketplace snapshot has eligible exact-commit evidence and no different upstream commit was observed by the latest catalog check.
- `Update unverified` means the current observed upstream commit differs from the verified snapshot. The newer code is not covered by the old evidence.
- `Unverified` means no current automatic or maintainer-reviewed verification record is available for the exact marketplace snapshot.

`Unverified` and `Update unverified` do not mean that a plugin is malicious. Verification is derived from immutable snapshot, baseline, and review facts. The registry does not store a manually editable `verified` flag.

Catalog state schema 2 exposes `verificationSnapshotStatus` for the recorded evidence, `verificationCoverage` for the relationship to observed upstream code, and `verificationStatus` as the effective current catalog status. The Verified catalog filter includes only currently observed snapshots whose commit matches the verification record. A known newer upstream commit has `verificationCoverage: update-unverified` and is included under Unverified until it completes the update workflow.

## Verifying a new submission

Every new submission must be published through the explicit `approved-and-verified` label. `approved-for-listing` is retained only as a historical audit label and no longer triggers publication.

The workflow requires a current bot-authored baseline report to predate the label event, checks the actor's current write permission, verifies the exact issue and repository state, and performs a fresh static scan of the exact validated commit. A fresh `passed` result is stored as automatic verification. Under selective policy, a fresh `review-required` disposition for capabilities or non-selectively-blocking findings must match the complete report identity and evidence sets the maintainer accepted; the workflow then stores a canonical `maintainerVerificationReview`. Selectively blocking findings, incomplete scans, stale reports, changed commits, changed evidence sets, or event mismatches block initial publication.

For initial listings and plugin updates, finalize the issue and all setup labels before setting `approved-and-verified` last. The initial check resolves the triggering webhook's immutable `issue.updated_at` to exactly one approval-label transition and requires it to remain the latest transition by the triggering actor. GitHub may record that timeline event in the same UTC second or exactly one second before `issue.updated_at`; only initial resolution accepts those two timestamps. Every `approved-and-verified` transition in those two seconds counts toward ambiguity. Missing matches, multiple transitions, events after the webhook timestamp, and events at least two seconds earlier fail closed. Subsequent checks preserve the resolved event ID, actor, and actual event timestamp exactly, without tolerance, and require that event to remain the sole transition in the original two-second compatibility window. If a request is ambiguous, review the current evidence and create a separate approval event in a later second; do not rerun the old workflow.

Failed publication runs append historical reports without clearing approval labels or overwriting newer reports. A retained label is not proof of publication. Only after reviewing current evidence and resolving blockers should a maintainer remove any remaining approval label and set it last again. Deployment and finalization failures require recovery of the reported phase, not a new approval.

Listing, canonical verification evidence, catalog projection, testing, publication, and Pages deployment are one guarded workflow. A successfully published new community plugin therefore starts with a verified snapshot. This remains an exact-commit statement, not a security audit or guarantee.

## Promoting a plugin update

Use the [**Plugin verification** issue form](https://github.com/omacom/omarchy-plugin-marketplace/issues/new?template=verify-plugin.yml), select **Verify and publish a newer upstream commit**, and provide the existing plugin ID, repository root URL, and full 40-character SHA of the current repository HEAD. Multi-plugin repositories are updated source-wide and must retain the exact configured plugin ID set. Shell-suite listings are not supported by this workflow.

Opening or editing the issue runs compatibility validation and the Automated Security Baseline against that exact update commit without executing community code. The existing marketplace snapshot remains unchanged while the update is pending or blocked.

A write-authorized maintainer may apply `approved-and-verified` only after the current bot-authored reports are available. The publication workflow binds the exact label event, reviewer permission, issue body, repository, plugin set, commit, policy, enforcement mode, scan result, and report identity. It then performs a fresh matching scan:

- `passed` produces automatic exact-commit verification;
- selective `review-required` produces a canonical maintainer attestation for the exact accepted finding and capability sets; and
- selectively blocking findings, scan failures, stale reports, changed commits, changed plugin sets, or evidence mismatches block promotion.

An eligible update atomically replaces `listingValidatedCommit`, its canonical baseline and optional maintainer attestation, the source's generated catalog entries, previews, tested Pages artifact, and deployment. The superseded snapshot and its evidence are retained in `listingValidationHistory` for auditability. If publication or deployment fails, the previous marketplace snapshot remains authoritative unless the workflow explicitly reports that registry publication already succeeded.

## Requesting verification of the recorded snapshot

Use the [**Plugin verification** issue form](https://github.com/omacom/omarchy-plugin-marketplace/issues/new?template=verify-plugin.yml), select **Verify the currently listed snapshot**, and provide:

- the exact existing plugin ID,
- the existing repository root URL, and
- the full 40-character `listingValidatedCommit`; copy it from the target URL of the **Verified snapshot** or **Listing snapshot** GitHub commit link on the plugin detail page.

This verification path accepts only the commit already recorded by the listing. For a different current HEAD commit, edit the request and select **Verify and publish a newer upstream commit**. Multi-plugin repositories are verified source-wide: one request scans every configured plugin manifest at the listed commit and updates every catalog entry from that source. Shell-suite listings are not eligible for this first plugin-source workflow.

The workflow checks that the plugin ID, repository, and commit identify one existing registry source. It resolves every configured plugin ID directly in the exact listing snapshot and forces each declared entry point into the scan. Immutable registry manifest paths are used as hints when available; mutable refreshed catalog paths are never trusted as the authoritative snapshot location. It then reads the exact commit through the GitHub API and runs the Automated Security Baseline statically. Community repository files are treated only as data and are never imported, sourced, spawned, evaluated, or otherwise executed.

If the result is `passed`, the workflow records the canonical commit-bound baseline facts and publishes the derived snapshot status automatically. Initial approval, update promotion, and later verification use the same stored-record converter.

If the result is `review-required`, the bot report includes deterministic capability IDs, source evidence, reasons, and a machine-readable expectation. An authorized marketplace maintainer may inspect that evidence and apply the `maintainer-verified` label to the open verification issue. The workflow requires that exact bot report to predate the label, checks the actor's current write permission, rescans the exact listed commit, and publishes verification only if repository, plugin IDs, commit, policy, enforcement mode, outcome, empty findings, and capability IDs exactly match the report the maintainer saw. Any capability mismatch only publishes a new eligible report and requires a new decision; review that report, then remove and reapply the label. Findings, scan failures, and other ineligible results publish no review expectation. In those cases, edit the open issue or reopen it to run normal verification first, and only remove and reapply the label after the bot publishes a new eligible `review-required` report. The label remains on the issue as an audit trail. Workflow reruns cannot reuse its event. The resulting registry attestation and public catalog identify the verification method as `maintainer-reviewed`.

If a `maintainer-verified` label was applied in error and later removed, the `unlabeled` workflow path authenticates the maintainer event, binds it to the closed or open verification issue and current exact source, and publishes an exact event-bound revocation. The original review evidence remains preserved. The affected snapshot is projected as `Unverified`; a later review requires a fresh eligible bot report and a new label event after the revocation. A revocation never silently deletes historical evidence.

`needs-fixes`, findings, unavailable snapshots, invalid results, incomplete scans, and scan errors are never eligible for maintainer verification and remain fail closed.

Editing the issue retries a failed or corrected request. A successful, maintainer-reviewed, or already-current request is closed automatically.

## Publication safety

The registry is the only persistent source of verification facts. One shared pure projection derives all catalog verification fields for regular builds, failed refreshes, verification publications, and update promotions. Browser display logic additionally compares the observed upstream commit with the verification commit so later code cannot inherit an unqualified verified presentation.

Analysis runs with read-only marketplace permissions. An approval, review, or revocation request binds the latest applicable label transition to the exact event ID, actor, and timestamp, checks reviewer write permission, issue contents, the preceding bot report or current review, and the exact fresh scan result where applicable, and rechecks that mutable authorization before the publication push. Registry and catalog changes are produced and tested before entering a write-permission job. The write job does not install dependencies or execute marketplace or community repository code. It verifies the immutable publication artifact and refuses to publish if `main`, the issue, review label, reviewer permission, report identity, upstream commit, or expected listing changed after analysis.

Verification and update workflows preserve the marketplace's single-build and immutable-artifact publication rules. Scan failures and GitHub API limit failures remain fail closed.

## Installation boundary

Marketplace verification and Omarchy installation are separate trust boundaries. The current Omarchy command clones the repository's mutable current HEAD and does not accept an exact marketplace commit. Therefore the marketplace labels the action as a current-upstream command and explicitly states that it is not verification-bound. It may install a commit different from the verified snapshot, even when the last catalog check observed both at the same commit.

The marketplace can verify and promote exact update commits without Omarchy changes, but it cannot guarantee that `omarchy plugin add` or `omarchy plugin update` installs that commit. Users must inspect the installed commit before enabling it. Commit-bound installation remains unavailable until Omarchy provides an exact-SHA installation and update interface.

The verification form also provides a guarded standard-installation action for one listed root plugin that currently has an explicit manual-installation override. It requires an exact listed commit, the standard-installation acknowledgment, a passing automated baseline, and an authenticated `standard-installation-approved` label event applied by a maintainer with write permission; a maintainer review cannot override this requirement. Publication removes only that plugin's manual override and atomically projects the normal mutable `omarchy plugin add ... --enable` command into the catalog. This changes installation presentation and availability, not the verification boundary or the mutable upstream behavior.

## Display text

The status explanation is available to pointer, keyboard, touch, and assistive-technology users:

- automatic `Snapshot verified`: “Automated checks passed for this exact snapshot. The mutable upstream install command is not commit-bound. This is not a security audit.”
- maintainer-reviewed `Snapshot verified`: “A marketplace maintainer reviewed the reported findings and capabilities for this exact snapshot. The mutable upstream install command is not commit-bound. This is not a security audit.”
- `Update unverified`: “The current upstream commit differs from the verified snapshot. The update and mutable upstream install command are not covered by that verification.”
- `Unverified`: “No current verification record is available for the listed snapshot. This does not mean the plugin is malicious.”

Community plugin cards retain the existing single `Verified` or `Unverified` marker and use the effective current status, so an unverified upstream update appears as `Unverified` without adding a new card badge. The explanation remains available on hover, keyboard focus, and tap, and is included in the control's accessible name for screen readers. Detail pages alone distinguish `Snapshot verified` from `Update unverified`, identify the exact verified snapshot, separately show the last compatibility-checked upstream commit, and label installation as mutable current upstream.
