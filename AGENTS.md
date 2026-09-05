# Repository guidelines

This file defines the working rules for the entire repository. Use it as the default context for future changes. Follow a direct user instruction when it conflicts with this file. Communicate with the maintainer in German unless they request another language. Keep source code, interface copy, and public project documentation in English.

## Product intent

Omarchy Plugins is an independent community marketplace at `omarchyplugins.com`. It helps people discover, inspect, and install plugins for Omarchy. It is not affiliated with Omarchy or 37signals.

Preserve these product qualities:

- Minimal, precise, technical, and aesthetically restrained
- Command-first, with source and trust information visible
- Fast, static, accessible, and usable without an application server
- Curated, while stating clearly that listing is not a security review

Do not introduce accounts, a database, a backend, a frontend framework, or a new dependency unless the maintainer explicitly approves that architectural change. The approved exception is the credential-free engagement feature under `worker/`: a narrowly scoped Cloudflare Worker and D1 database may store anonymous aggregate plugin detail views, successful command-copy actions, and hearts guarded by local browser storage. Hearts are anonymous reactions, not unique or verified votes. Ephemeral edge burst limits and Cache-API sliding windows may use the request address (IPv4 or IPv6 /64) as a rate-limit key; they must not persist addresses or other request-derived keys in D1. Do not expand it into identity, profiling, comments, scored ratings, installation telemetry, or general analytics without separate approval.

## Project structure and sources of truth

- `site/index.html` contains the marketplace and catalog interface
- `site/explore.html` contains the community graph and catalog growth interface
- `site/plugin.html` contains the plugin detail shell
- `site/publish.html` contains the publishing guide
- `site/assets/css/style.css` is the shared visual system
- `site/assets/css/explore.css` contains the Explore page layout and visualization styles
- `site/assets/js/shared.js` contains shared browser behavior
- `site/assets/js/engagement.js` contains the credential-free engagement API client
- `site/assets/js/search.js` contains shared catalog matching semantics
- `site/assets/js/app.js`, `plugin.js`, and `publish.js` contain page-specific behavior
- `site/assets/js/explore.js`, `explore-search.js`, and `growth-range.js` contain Explore rendering, matching integration, and date-range behavior
- `registry.json` is the curated registry and the source of marketplace metadata
- Upstream plugin `manifest.json` files are the source of plugin-owned metadata
- `scripts/build-catalog.mjs` combines registry and upstream data
- `scripts/build-explorer-data.mjs` derives graph, community, and daily growth data from the generated catalog and its Git history
- `site/catalog.json` and `site/assets/img/plugins/` are generated build outputs
- `site/explorer-data.json` is the generated Explore data output
- `test/explorer.test.js` covers Explore data integrity, search behavior, UI structure, and growth ranges
- `sharp` is the build-only image dependency; source previews are normalized into card and detail WebP variants
- `package.json` defines the Node.js engine, project commands, and direct development dependencies
- `package-lock.json` pins the complete transitive npm dependency graph and integrity hashes used by `npm ci`
- `SECURITY.md` is the unified security policy: it defines private vulnerability reporting, public reporting boundaries, high-level scope, and the deterministic scanner policy, limits, outcomes, enforcement, exact-SHA rules, and contributor requirements
- `VERIFICATION.md` defines the public meaning, request flow, publication safeguards, and display contract for `Verified` and `Unverified`
- `SUBMISSION.md` defines the public command-line and AI-assisted submission contract
- `worker/src/index.js`, `worker/migrations/`, and `worker/wrangler.example.jsonc` define the approved engagement service, D1 schema, and credential-free deployment template
- `PLAN.md` is the living implementation and security roadmap; current code, tests, workflows, and focused policy documents remain authoritative for implemented behavior

Do not manually edit generated catalog data or preview assets. Change their source or build logic, then regenerate them. Do not include unrelated catalog drift in a UI-only change.

Use `npm ci` for reproducible installs and CI. Do not hand-edit `package-lock.json`. When an explicitly approved dependency or other lockfile-represented field changes, update `package.json` and regenerate and review `package-lock.json` together. Script or metadata-only `package.json` changes may legitimately leave the lockfile unchanged. Do not commit a dependency change without its corresponding lockfile update, or a lockfile change that cannot be explained by the manifest.

## Change workflow

1. Run `git status --short --branch` before editing
2. Read the relevant source, tests, and nearby patterns
3. Make the smallest coherent change that solves the request
4. Preserve unrelated user changes in a dirty worktree
5. Verify the change according to its risk
6. Report changed behavior, verification, and remaining limitations

Avoid broad cleanup, formatting passes, renamed files, and dependency updates during a focused change. Ask before expanding the task into a redesign or architectural change.

## Review-only requests

When asked to inspect, audit, diagnose, or verify, do not edit files, regenerate outputs, commit, amend, or push unless explicitly requested. Read-only commands, tests, temporary local servers, and screenshots under `/tmp` are allowed when needed for verification. Stop temporary processes after the review.

## Frontend and design rules

Use the existing HTML, CSS, and JavaScript patterns. Reuse design tokens and existing components before adding new ones.

Preserve the visual language:

- Monospace typography for navigation, commands, identifiers, and technical metadata
- Black and neutral surfaces with restrained orange accents
- Thin borders, square controls, clear spacing, and no decorative clutter
- Strong information hierarchy without oversized promotional elements
- Existing dark and light themes

Keep interface copy short and functional. Match nearby capitalization and terminology. Do not translate the English interface unless the maintainer requests it.

The Ko-fi support action uses `https://ko-fi.com/hancore`. Keep it directly before **Browse plugins** in the desktop header. It uses the same dimensions and typography as the other navigation links, an orange status dot, and the established orange hover treatment. Keep **Browse plugins** visually primary; utility links may use the muted text color. Support is a desktop-header action; do not add it to the mobile bottom navigation unless the maintainer requests it.

External links that open a new tab must use `target="_blank"` and `rel="noreferrer"`. Add an accessible name when the visible label does not fully describe the destination.

## Responsive behavior

The header uses three intentional states:

- `0–760 px`: hide desktop navigation links and use the mobile bottom navigation
- `761–879 px`: keep desktop navigation on one line and hide the `PLUGIN MARKETPLACE` brand suffix
- `880 px` and wider: show the full brand and desktop navigation

Do not let navigation labels wrap. Keep arrows attached to their labels. Adding or renaming a navigation item requires a fresh width review.

For header or layout changes, render at least these widths:

- `320`, `375`, and `760 px`
- `761`, `800`, `850`, `879`, and `880 px`
- `1024` and `1440 px`

Check these invariants:

- No horizontal page scroll
- No overlap, clipping, or unexpected two-line controls
- No isolated arrows or detached icons
- Stable header and mobile navigation heights
- Visible hover and keyboard-focus states
- Usable dark and light themes
- Motion respects `prefers-reduced-motion`

Run `npm run dev` for local runtime review. The server listens on `http://127.0.0.1:4173`. Stop the server after the review unless the maintainer asks to keep it running.

## Accessibility and interaction

Use semantic HTML and native controls. Preserve the skip link, landmark structure, visible focus indicators, keyboard navigation, accessible names, live status messages, and reduced-motion behavior.

Do not encode meaning through color alone. Decorative icons and dots need `aria-hidden="true"`. Dynamic controls must expose their current state to assistive technology.

Verify hover, focus, active, empty, loading, error, and disabled states when a change affects them. Copy actions must keep visible and screen-reader-readable feedback.

## Asset cache busting

Static assets use a `?v=YYYYMMDD-NN` query string. Bump the version after the final asset change, not after each edit.

When CSS changes, update every HTML reference to `style.css` so all pages use the same version. When JavaScript changes, update every HTML or module import that references the changed file. Keep one version for coupled JavaScript changes.

Find all current references with:

```bash
rg -n '\?v=' site/*.html site/assets/js/*.js
```

Do not leave different cache versions for the same asset across pages.

## Catalog and submission safety

Plugins run as unsandboxed upstream code. Never describe marketplace validation or maintainer approval as a security review. Keep the existing disclaimer visible wherever installation trust is discussed.

Treat registry, catalog, submission, and upstream manifest values as untrusted input. Escape every dynamic value inserted into HTML with the existing `escapeHtml` helper. Encode URL path segments with `encodeURIComponent`, build query strings with `URLSearchParams`, and reject unsupported URL protocols. Never render raw HTML supplied by a plugin repository.

New automated submissions use one public GitHub repository per plugin, with `manifest.json`, README, and license files at the repository root. Preserve the exact submission headings, checklist, controlled categories, and tags defined in `SUBMISSION.md`.

The Automated Security Baseline statically scans the exact validated commit without executing plugin code. The **Automated Security Baseline** section in `SECURITY.md` is the public policy for all contributors; keep implementation, reports, tests, and contributor documentation aligned with it. Preserve deterministic outcomes (`passed`, `review-required`, and `needs-fixes`), evidence templates, exact-SHA binding, and the required disclaimer. Do not use AI to determine outcomes, enforcement, labels, or approval. Selective enforcement determines verified-publication label disposition: every new listing must be published through `approved-and-verified`, a current `passed` result is automatic, a complete review-required disposition for capabilities or non-selectively-blocking findings requires exact authorized maintainer attestation, and selectively blocking findings or scan failures block publication until resolved. Existing-snapshot `maintainer-verified` remains capability-only. Treat executable binaries as review capabilities, narrowly scoped root-owned helpers as review cases rather than automatic blockers, and execution sourced only from the submitted repository as self-installation requiring review rather than as external mutable-code rejection.

Security module boundaries are deliberate. `security-baseline-policy.mjs` is the single owner of policy version, marker protocol, finding/capability catalogs, outcome, enforcement, and label disposition. `security-baseline-record.mjs` is the only stored-record and marker converter, while `verification-review.mjs` exclusively validates maintainer-review attestations against canonical records. `security-github-snapshot.mjs` encapsulates bounded GitHub transport, `security-baseline-scope.mjs` owns deterministic file selection, `security-baseline-analysis.mjs` owns static findings and capabilities, and `security-baseline-scanner.mjs` only orchestrates scope plus analysis. `security-baseline.mjs` is the compatible CLI/facade. `verification-subject.mjs` resolves exact source-wide scan plans by configured plugin ID, and `catalog-verification.mjs` is the only catalog status projection. Manifest paths from mutable catalog refreshes are hints only. Catalog projection must require the exact registry plugin set for a source and fail closed on stale extra entries. Domain modules must not import filesystem APIs, `sharp`, workflows, or `build-catalog.mjs`. Approval and verification must persist identical canonical baseline records.

The registry stores automated baseline facts, including record schema, repository, affected plugin IDs, finding IDs, and capability IDs. Keep authorized maintainer verification separate as a canonical `maintainerVerificationReview` attestation bound to the exact bot-authored pre-label report, baseline repository, plugin IDs, commit, policy version, enforcement mode, prior and current scan times, outcome, accepted finding set, accepted capability set, and exact label-event identity and request time. Initial submissions and plugin updates use `approved-and-verified` and may attest complete selective review dispositions; existing-snapshot verification uses `maintainer-verified` and remains capability-only. All actions must reuse the same attestation validator and exact-evidence rules. Store the reviewer and review time for auditability, but never add a freely editable `verified` flag. Failed scans, stale evidence, mismatches, and selectively blocking findings have no review bypass. The baseline applies only to the current exact marketplace snapshot. Scheduled catalog refreshes still inspect upstream branch HEAD for compatibility and do not refresh the stored baseline. A different observed commit must display as `Update unverified`, while the old verified evidence remains attached to its snapshot. One public verification Issue form routes the recorded-snapshot and newer-upstream actions to separate internal workflows. Only the newer-upstream action may enter the guarded update workflow and promote a new commit; it preserves superseded evidence in `listingValidationHistory`. Derive snapshot verification from either a current-version `passed` baseline with empty finding and capability sets or an exact eligible maintainer-review attestation. Both paths describe only the exact listed commit, never trust or later upstream code. After a valid listing, update, or verification path succeeds, the responsible workflow automatically tests and publishes the canonical registry/catalog update and deploys the tested Pages artifact.

Root community plugins default to the generated standard Omarchy install command. Current Omarchy install and update commands obtain mutable upstream HEAD and do not accept an exact marketplace SHA, so UI copy must identify them as current-upstream and not verification-bound. Never imply that the command installs the verified snapshot. Use a manual installation override only when that command cannot produce a functioning plugin, such as when a required native binary is absent or a mandatory build must run before enablement. Optional feature setup, credentials, API configuration, data sources, bar placement, and layout customization do not make an otherwise functioning plugin manual. A curated `plugins.<id>.installation` override in `registry.json` must contain exactly `mode: "manual"` and a non-empty user-facing `note`. Manual overrides must not publish arbitrary installer commands, apply only to root plugin repositories, and must keep installation disabled and the curated note intact across passed, failed, and unreachable upstream checks. During automated listing review, finalize all setup labels, including adding or removing `manual-setup`, before setting `approved-and-verified` last; approval maps that maintainer decision to the registry override. Initial listing and update approval must resolve the immutable webhook `issue.updated_at` to exactly one approval-label transition and require that transition to remain current. Missing or ambiguous same-second transitions fail closed; later checks retain the exact selected event ID and timestamp. Failed publication runs must not remove approval labels or overwrite another run's status comment. They append explicitly historical, run-scoped reports instead; a maintainer must review current evidence before manually removing and reapplying the approval label. In the write-token job, prepare the tested commit and verify the expected base before the final mutable issue, approval, baseline, permission, and upstream checks; keep those checks and the guarded push in one shell step to minimize the unavoidable cross-system race window. `approved-for-listing` is a legacy audit label and must not publish new submissions.

Explorer growth uses Git committer timestamps normalized to UTC for completed daily catalog snapshots. The current catalog's `generatedAt` sets the logical day horizon: standalone or no-op rebuilds must exclude later Git days until a newer catalog is supplied, rather than advancing or inventing a catalog timestamp. Only the last point of the previously committed series is provisional: same-day builds may update it, and the first successful later-day build may finalize it from complete Git history while retaining its previous UTC date. All older points remain field-for-field immutable. Recompute daily deltas from consecutive totals, fill missing days, and reject shallow or truncated history before replacing Explorer output. The visible growth view must identify the latest point as provisional until a successful later-day build finalizes it. Cover builds generated before midnight but committed after midnight with deterministic `GIT_COMMITTER_DATE` fixtures; do not manually patch generated history.

The catalog build performs live GitHub requests and may change generated files when upstream repositories change. Run `npm run build` for catalog, registry, validation, or generation changes. Do not run it for a UI-only change unless the UI change depends on new generated output.

Full refreshes batch public repository metadata, configured/default branch identity, full commit SHA, and tree SHA through GraphQL before reading source content. Recursive REST trees and commit-bound raw files are required only for new or changed sources, prior non-passing checks, registry-fingerprint changes, or catalog source-validation policy changes. Reuse requires the exact complete source plugin set, prior `passed` state, commit, branch, source fingerprint, and validation version. Bump `catalogSourceValidationVersion` whenever catalog source validation, discovery, preview, or projection policy changes so unchanged commits are revalidated under the new policy. Missing repositories may retain their prior state only through an explicit alias-bound GraphQL `NOT_FOUND` result; ambiguous partial data and transport, quota, schema, or budget failures are globally fatal. GraphQL and REST budgets must retain their configured reserves, and a policy-wide revalidation must fit before any tree is fetched.

Approval builds refresh only the exact approved repository and preserve all unrelated catalog and preview state. Scheduled refreshes remain the only full-source catalog scan. Each workflow must build and test once, upload that exact `site/` tree as an immutable Pages artifact, and deploy without rebuilding. Manual plugin delisting uses `delist-plugins.yml` on `main` and is authorized only when both the original and triggering actor are `HANCORE-linux`; reruns and unconfirmed requests fail closed. Delisting is a static registry/catalog projection with no upstream execution or refresh, permanently adds every removed ID to `retiredPluginIds`, removes only previews referenced exclusively by those plugins, and requires complete removal of a multi-plugin source. Registry, catalog, Explorer data, previews, and the machine-readable delisting report must remain one recomputed, checksummed publication transaction. The report is an immutable verification artifact rather than a tracked site output; the retired IDs and resulting commit are the durable delisting record. Keep dependency installation and repository code out of write-token jobs. Never rebase generated changes after tests: if `main` moved, fail and rebuild from the new base.

Repository rename or transfer migrations require simultaneous old-path and canonical-path binding to the same GitHub GraphQL node ID and numeric database ID. Persist those immutable IDs on the active source and append the complete observation to top-level `repositoryMigrations`; redirects alone are not evidence. Keep historical security baselines, maintainer reviews, revocations, and listing history bound to the repository name they originally recorded. Normalize legacy active evidence to that historical name before migration, and use the validated migration chain only to recognize it as the same immutable repository. A migration must validate the exact current HEAD without promoting `listingValidated*` or security evidence, preserve every plugin ID and retired ID, refresh only the explicitly migrated sources, fail globally on any target or identity error, and leave all unrelated catalog objects, warnings, and preview bytes unchanged. Generate registry, catalog, Explorer data, previews, the ephemeral report, and checksums from an exact base into a temporary bundle before applying them to a PR worktree.

GitHub API rate-limit exhaustion and forbidden API access are fatal build errors; they must not degrade sources to `repository-unreachable` or produce a catalog artifact. Submission validation consumes pre-provisioned labels and must not rewrite repository label metadata on every run; use the maintainer-only `provision-labels.yml` workflow to create or repair the required labels. Pure submission and plugin-update analysis is serialized per issue with `queue: max`. After successful analysis, a strict live issue lookup may route ordinary feedback to `issue-validation-<number>`; analysis failure, an API or schema error, conflicting type labels, or any approval-sensitive label must route to `plugin-catalog-writes`. The selected group expression must clamp to exactly those two forms. Every issue write must recheck the exact live title, body, state, type labels, and approval-sensitive labels. If trust state appears while a per-issue job is queued or mutating, stop further writes and replay the same checksummed artifact through the globally locked fallback; failure compensation runs only there. Actual catalog publication, verification, delisting, refresh, and approval-sensitive validation remain in `plugin-catalog-writes`. Every admitted analysis generation is retained, and stale generations must not mutate current issue state. Before applying `approved-and-verified`, run `npm run check:catalog-write-admission` with a bounded token and exact `GITHUB_REPOSITORY`; the check fails closed unless the live group depth is at most 10, treats only an exact endpoint `404` as idle, and approvals stop entirely at 50 members. Add at most 5–10 approvals per admitted batch and use live depth rather than a fixed timer. Refresh failures are reconciled into one bot-authored operational issue with no labels and only bounded workflow metadata. `route-issue-automation.yml` is the only workflow with a direct `issues` trigger. It selects one reusable issue workflow for supported events, but it is not an authorization boundary: every called workflow must independently preserve its existing event, actor, issue-state, evidence, replay, and permission checks.

Optional source previews may use root `preview.png`, `preview.jpg`, `preview.jpeg`, `preview.webp`, or `preview.avif`. The build enforces a 50 MB and 40 megapixel input limit, strips metadata, and generates separate card and detail WebP files. Do not optimize source screenshots manually or preserve unreferenced generated previews.

Never commit credentials, GitHub tokens, temporary issue bodies, downloaded audit data, or local screenshots.

## Verification commands

Run the test suite for every code or content change:

```bash
npm test
```

Run every whitespace check that matches the current Git state:

- New untracked file: `git diff --no-index --check /dev/null path/to/file`; inspect the output because status `1` also means the files differ
- Uncommitted changes: `git diff --check`
- Staged changes: `git diff --cached --check`
- Unpublished committed changes: `git diff --check origin/main..HEAD`
- Single amended commit: `git diff --check HEAD^ HEAD`

Also run the relevant checks:

- UI or CSS: runtime review at the affected viewport matrix
- Catalog or registry: `npm run build`, then inspect generated changes and rerun tests
- Submission workflow: validate successful and rejected input paths
- GitHub Actions: preserve least-privilege permissions, pinned action commits, timeouts, and concurrency controls

Structural tests that match HTML, CSS, or JavaScript source do not replace runtime browser verification for visual or responsive changes.

Do not claim a check passed unless you ran it after the final change.

## Commits, pushes, and deployment

Do not commit, amend, push, open an issue, or create a pull request without explicit maintainer approval. Approval for one action does not authorize later actions.

Use concise imperative commit subjects. Stage only files that belong to the requested change. Do not amend a published commit or force-push `main`.

The scheduled catalog workflow can add commits to `main` at any time. Before every push:

1. Run `git fetch origin main`
2. Inspect `git status --short --branch` and the local/remote graph
3. Rebase the unpublished local commit onto `origin/main` when the histories diverge
4. Resolve conflicts without discarding remote catalog updates
5. Rerun tests and every applicable whitespace check
6. Push normally, never with force
7. Confirm that `git rev-list --left-right --count origin/main...main` reports `0 0`

A push to `main` triggers the GitHub Pages build, tests, and production deployment. Treat the push as a production change and report the final commit hash.

## Definition of done

A change is complete when:

- The requested behavior works in the relevant states and viewports
- Accessibility and existing visual conventions remain intact
- Cache-busting references match changed assets
- Tests and every applicable whitespace check pass
- Generated changes are intentional and reviewed
- The worktree contains no unintended files
- Commit, push, and deployment status are reported accurately

Update this file when a durable architecture, design, workflow, or maintainer decision changes.
