# Submit a plugin from the CLI or an AI agent

Use this guide to submit a public Omarchy plugin repository without the GitHub issue form. The marketplace applies the `submission` label and starts validation when the title and body match the format below.

## Check the repository

Before submitting, confirm that the repository:

- Is public and hosted at a GitHub repository root URL
- Contains one plugin with `manifest.json` in the repository root
- Contains a root README with installation and removal instructions
- Contains a root license file and documents external dependencies
- Uses a globally unique plugin ID outside the reserved `omarchy.*` namespace
- Optionally contains one root preview named `preview.png`, `preview.jpg`, `preview.jpeg`, `preview.webp`, or `preview.avif`

The marketplace removes preview metadata and generates optimized card and detail images automatically. Normal screenshots need no manual resizing or compression. Preview input is limited to 50 MB and 40 megapixels to protect the build runner from malformed or exceptionally large images.

Marketplace validation checks repository structure and Omarchy Quattro compatibility. It is not a security review, and plugins run as unsandboxed upstream code.

Plugin IDs are permanent marketplace identifiers and must be unique across all repositories, not only within your repository. IDs from retired or renamed listings remain unavailable and cannot be reused. Prefer a namespaced lowercase ID such as `io.github.yourname.plugin-name`. Before submission, search the marketplace for the intended ID. If you change it, also update commands and documentation that reference the old ID.

## Choose listing metadata

Choose one category:

- `Appearance`
- `Desktop`
- `Developer Tools`
- `Hardware`
- `Kids`
- `Productivity`
- `System`
- `Widgets`
- `Other`

Choose one to three tags:

- `ai`
- `bar`
- `education`
- `games`
- `hyprland`
- `kids`
- `launcher`
- `media`
- `power-management`
- `quickshell`
- `security`
- `system`
- `workspaces`

Copy category and tag values without the bullet marker or backticks. Categories are case-sensitive and must match the spelling above exactly. Tags may be comma-separated or entered one per line.

You may suggest one missing reusable tag under `Suggest a missing tag`. Reviewers decide whether to add it.

## Create the submission

Create a temporary issue body:

```bash
cat > /tmp/omarchy-plugin-submission.md <<'EOF'
### Repository URL

https://github.com/your_github_name/your_plugin_repository

### Category

selected_category

### Tags

selected_tag, another_selected_tag

### Suggest a missing tag

_No response_

### Maintainer notes

_No response_

### Submission checklist

- [x] The repository is public and contains installation and removal instructions.
- [x] I have documented the plugin license and any external dependencies.
- [x] I confirm that I own or have permission to submit this plugin and its preview assets.
- [x] The plugin does not overwrite user configuration without explicit consent.
- [x] I understand that approval is for listing and is not a security review.
EOF
```

Replace every placeholder before submitting:

- Replace the example repository URL with the public GitHub repository root URL, without a trailing slash or a path such as `/tree/main`
- Replace `selected_category` with one category exactly as written above, without backticks
- Replace both tag placeholders with one to three allowed tags, or remove the unused placeholder and comma
- Replace `plugin_name` in the command below with the plugin's human-readable name

Replace `_No response_` when you want to suggest a tag or add maintainer notes. Keep all six headings in their current order.

Review every checklist statement. Submit only if all five statements are true, then keep each checkbox checked.

Create the issue with an authenticated [GitHub CLI](https://cli.github.com/):

```bash
${EDITOR:-vi} /tmp/omarchy-plugin-submission.md

gh issue create \
  --repo omacom/omarchy-plugin-marketplace \
  --title "[Plugin]: plugin_name" \
  --body-file /tmp/omarchy-plugin-submission.md
```

Replace `plugin_name` with the plugin's human-readable name. Run `gh auth login` first if the GitHub CLI is not authenticated.

## Instructions for AI agents

When preparing a submission for someone:

1. Read the plugin repository's root `manifest.json`, README, and license file.
2. Use one category and one to three tags from the allowed values above.
3. Preserve every submission heading, its order, and the exact checklist text.
4. Ask the plugin owner to confirm the ownership statement and every other checklist item.
5. Show the completed title and body to the owner before creating the issue.
6. Create the GitHub issue only after the owner explicitly approves the submission.

After a correctly formatted issue opens, automated validation and the **Automated Security Baseline** post their results on the issue. The baseline statically checks the exact validated commit without executing plugin code and reports `passed`, `review-required`, or `needs-fixes`. A new listing can be published only through `approved-and-verified`. A current `passed` result becomes automatically `Verified`; under selective policy, a `review-required` disposition requires an authorized maintainer to accept the exact reported capabilities and non-selectively-blocking findings. Selectively blocking findings must be fixed in a new validated commit before initial publication, and scan failures remain fail closed because no complete result exists.

The baseline intentionally detects a small set of deterministic patterns, such as direct download-to-shell execution, unpinned external Git source execution, dangerous passwordless sudoers policies, and privileged process control sourced from predictable shared temporary state. It does not perform general data-flow analysis or attempt to detect every unsafe behavior. A maintainer must still review the exact checked commit and apply `approved-and-verified` before it appears in the marketplace. For a selective review result, that action records the accepted finding and capability sets in a commit-bound maintainer attestation after a fresh matching scan. Read the [security policy and baseline](SECURITY.md#automated-security-baseline) for the complete contributor policy, documented patterns, limits, and remediation requirements.

**This is not a security audit, certification, warranty, or endorsement.**

## Respond to validation and publication feedback

The marketplace bot keeps one validation comment and one automated-security-baseline comment on the issue and updates them after each retry. A failed status includes a concise reason and the next action. Correct the existing repository or issue instead of opening a duplicate submission, then edit the issue to run validation again.

Approval and publication failures append a historical, run-scoped status comment with the failed phase, a safe error summary, the required action, and a workflow link. An older run never overwrites a newer run's report or removes its approval label. Approval is bound to the exact validated commit and a bot-authored report that predates the `approved-and-verified` event. The workflow performs a fresh exact-commit scan. A matching `passed` result stores current automated facts; a matching selective `review-required` disposition also stores an exact-evidence maintainer attestation with accepted findings, capabilities, reviewer, label-event, report, rescan, and review times. Neither path creates an editable verification flag. Later scheduled catalog refreshes continue to inspect the repository's branch head for compatibility and do not rerun the snapshot security baseline. If a different upstream commit is observed, the marketplace shows `Update unverified`; the stored evidence continues to describe only the exact approved snapshot. When approval or publication fails before registration, the failure handler leaves `approved-and-verified` unchanged. A label left in place does not mean publication succeeded. Fix the reported problem and ask a maintainer to review the current report, finalize all setup labels (including `manual-setup`), then remove any remaining approval label and set `approved-and-verified` last. Do not restore a withdrawn approval while blockers remain. Rerunning the old failed workflow does not create a new request. If registration succeeded but deployment or issue finalization failed, do not resubmit the plugin or reapply the approval label: a maintainer must retry or complete the reported publication phase.

If no automated validation comment appears, edit the existing issue and verify that its title starts with `[Plugin]:`, all six headings remain in their original order, the category matches exactly, and all five checklist items are checked. Editing the issue runs submission detection again. `approved-for-listing` remains only on historical issues as a legacy audit label and no longer publishes new submissions.

## Update an existing listing

Use the single [**Plugin verification** issue form](https://github.com/omacom/omarchy-plugin-marketplace/issues/new?template=verify-plugin.yml), select **Verify and publish a newer upstream commit**, and enter the exact existing plugin ID, repository root URL, and full 40-character SHA of current repository HEAD. The update must preserve the configured plugin ID set; multi-plugin sources are promoted source-wide.

Compatibility validation and the Automated Security Baseline run against that exact commit without executing community code. The existing snapshot remains unchanged while the update is pending. A write-authorized maintainer applies `approved-and-verified` only after reviewing the current bot reports. Publication rescans the same commit and requires exact repository, plugin-set, policy, outcome, finding, capability, report, event, and reviewer binding. Selectively blocking findings and scan failures block promotion; non-selectively-blocking findings require exact maintainer attestation. A successful update atomically replaces the current marketplace snapshot and canonical evidence while retaining the superseded evidence in registry history.

## Verify an existing snapshot

Use the same [**Plugin verification** issue form](https://github.com/omacom/omarchy-plugin-marketplace/issues/new?template=verify-plugin.yml) and select **Verify the currently listed snapshot** for the commit already recorded by the listing. The request must identify the existing plugin ID, repository, and full `listingValidatedCommit` exactly. This path reruns the static baseline only for that recorded commit. A complete `passed` result with no findings or review capabilities publishes snapshot verification automatically. A write-authorized maintainer may also apply `maintainer-verified` after reviewing a bot-authored `review-required` report; publication then requires an exact match between that report and a fresh scan. For a different current HEAD commit, select the newer-upstream action in the same form. Findings, scan failures, stale evidence, and mismatches remain `Unverified`; this is not a claim that the plugin is malicious. Read [Plugin Verification](VERIFICATION.md) for the complete status definition, process, display states, and installation boundary.
