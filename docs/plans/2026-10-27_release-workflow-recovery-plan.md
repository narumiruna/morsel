# Release Workflow Recovery

## Goal

Restore automatic repository version PR creation. Use the published repository version as the baseline, reject older versions before processing changesets, and verify the Git CLI commit path in a new workflow run. Keep workspace versions unchanged and deployment manual.

Implementation and delivery as a new fix PR are authorized. Creating version tags, publishing artifacts, dispatching release workflows, and merging PRs are outside this execution. The final live verification remains blocked until the fix PR is merged and a new main-triggered Publish run exists.

## Context

- Verified `main`: `97ee706dd92794155286a7706fa3f961db2310b4`, which merged PR #130.
- The latest published stable release is `v0.1.0`, published on 2026-10-26. Root `package.json.version` and both root lockfile version fields are still `0.0.1`.
- [Failed job](https://github.com/narumiruna/morsel/actions/runs/40374581904/job/121754034542): `release:version` produced `0.0.2`; commit `01ca1298606c5c62fcb5fb83aadc1d1f023140b3` exists on `changeset-release/main`, but PR creation did not complete. The logs and annotations do not contain the underlying exception.
- `scripts/release.mjs` returns early for pending changesets before checking whether the root version is older than the latest tag.
- `.github/workflows/release.yml` uses the action's default API commit path. The job has `contents: write` and `pull-requests: write`; repository settings permit Actions-created PRs.
- Existing local tests use stubbed GitHub calls. They do not establish that a real version PR can be created.

## Unknowns

- The cause of the action failure is not established. `push-with-git-cli: true` changes the commit and push path; it does not remove the GitHub PR API call. Treat it as a workaround to verify, not a proven root-cause fix.
- The latest published version can change before implementation. Recheck it before editing; update the baseline and expected patch in this plan if needed.

## Plan

Implement only after authorization, on a new branch from current `main`, named `narumi/fix/release-version-pr`. Use a new fix PR; PR #130 is already merged.

- [x] Recheck the release baseline and failed version branch before editing. Confirmed main `97ee706dd92794155286a7706fa3f961db2310b4`, published stable release `v0.1.0`, and remote tag `v0.1.0` targeting `12a6758f2058fe6a0b5ed0b123913d2f691be3d4`. The managed version branch still points to `01ca1298606c5c62fcb5fb83aadc1d1f023140b3`; no version PR exists. Created `narumi/fix/release-version-pr` from refreshed `origin/main`; the untracked requested plan is preserved.
- [x] Synchronize only the root version metadata to `0.1.0`: `package.json.version`, `package-lock.json.version`, and `package-lock.json.packages[""].version`. The pending changeset and private-package policy are unchanged. `npm run changeset -- status` reports exactly one root release from `0.1.0` to `0.1.1`; the diff contains no workspace or dependency-entry changes.
- [x] Move root stable-version validation and the older-than-latest check before early returns that can permit version PR preparation in `scripts/release.mjs`. Validation now precedes GitHub API calls, recovery, and pending-changeset returns. Older and invalid stable versions fail with no tag/push calls; equal-baseline and valid unreleased ancestor recovery tests pass.
- [x] Add `push-with-git-cli: true` to the Changesets action step in `.github/workflows/release.yml`. The workflow contract test verifies the input; the custom version command, disabled built-in publisher/tag/release behavior, and job permissions are unchanged.
- [x] Add regression tests in `scripts/test-release.mjs`. Reproduced four expected failures before the fix: stale roots with published/unreleased tags, invalid stable-root recovery, and the missing Git CLI workflow input. After the fix, all 32 release tests pass, including equal-baseline `0.1.0` to root-only `0.1.1`, unchanged workspace metadata, recovery, and no-op cases.
- [x] Run local verification. `npm ci --no-audit --no-fund`, `npm run ci`, all 32 release tests on Node.js 24.15.0 and 26.10.0, checksum-verified Actionlint 1.7.7 for release/CI workflows, and `git diff --check` pass. Viewer browser checks pass 83 tests; only the production-only scenario is excluded. Strict metadata comparison confirms only the three root version fields changed, with unchanged workspace manifests, dependency entries, pending changeset, private-package policy, container/deployment workflows, and permissions. Publication tests use disposable fixtures and stubbed commands.
- [ ] Open a new fix PR with the confirmed baseline defect, the unconfirmed API failure, local test evidence, and the live verification requirement. Acceptance: the PR contains only intended paths and does not claim that mocked API tests prove real PR creation.
- [ ] Blocked: after the fix PR is merged, inspect the new main-triggered Publish run. Acceptance remains unchanged: Git CLI commit/push succeeds and a real root-only version PR proposes `0.1.1`, with no workspace version changes or new release tag. The current authorization requires PR delivery and prohibits release dispatch; no PR is merged or release workflow started during this execution. If the new run fails, obtain its debug logs after authorization. Do not rerun the old run to validate new configuration.

## Rollback / Recovery

- Do not modify or delete existing `v0.1.0` or other published tags and releases.
- Do not merge the stale `0.0.2` version branch. Let the action rebuild its managed branch from corrected main; do not delete or force-push it manually.
- Before merge, revert the implementation changes on the fix branch if needed. After merge, disable Publish before rollback if automation must stop. Keep the corrected version baseline and version guard; reverting the Git CLI transport setting alone restores the prior API path.
- Merging the fix starts Publish. Confirm the retained pending changeset and matching published baseline immediately before merge so this run prepares a version PR rather than publishing artifacts.
- Do not merge the generated version PR, publish packages or containers, dispatch release/deployment workflows, or deploy without separate authorization. Deployment remains manual.
- If the new run succeeds, record Git CLI transport as a verified workaround; do not claim that the original API exception was identified.

## Completion Checklist

- [x] Root version and lockfile metadata match the verified published baseline `0.1.0`.
- [x] Stale root versions cannot pass through pending-changeset or recovery paths into version PR preparation; regression tests cover both paths.
- [x] Regression tests, npm CI, supported Node checks, Actionlint, and diff checks pass; independent diff review found no material issue.
- [ ] A new fix PR clearly separates confirmed defects from the unconfirmed API failure.
- [ ] Blocked until merge: a new main workflow run creates the correct real version PR. Mocked API results are not used as evidence for this check.
- [x] Workspace versions, published tags/releases, and the manual deployment boundary are preserved. No release, publication, real version tag creation, workflow dispatch, or deployment was performed.

## Additional Verification Evidence

- Verified the exact shipped `changesets/action` revision `ae32849d5ba541f9ae29e40e22a623bc13562f51` in two isolated fixtures under Node.js 24.15.0. All 11 shipped bundle files matched upstream Git blob hashes and were unchanged.
- Real Git CLI commits and pushes to local bare fixture repositories passed for a fresh managed branch and a stale `0.0.2` managed branch. Both produced only root version `0.1.1`, root changelog/lockfile changes, and changeset removal. Workspace versions remained `0.1.0`; no Git tags were created.
- GitHub PR API responses were mocked and unexpected network calls were blocked. These checks establish local transport compatibility, not real GitHub PR authentication, repository permissions, or the cause of the original failure.

Keep this plan while implementation or live verification remains incomplete. Delete it only after every task and completion check is verified.
