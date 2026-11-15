# Feature proposal: subscription-aware routing and work sharing

T3 Code could help developers use their existing AI subscriptions more effectively and show what their agents accomplished. This fork explores account-aware model selection, recovery when an account hits a limit, and shareable work summaries.

This is an experimental fork proposal, not an upstream feature announcement or an upstream PR. The implementation is not verified across all supported clients.

## The problem

With several subscriptions, choosing an account is difficult when the model picker does not show remaining capacity. An unattended task can stop overnight even when another suitable account has capacity. Usage totals also do not explain what work was completed.

## Proposed experience and benefits

### Choose an account with capacity

Show each account's remaining session and weekly capacity in the model picker, using a compact label such as `50/80`. Hover details explain the percentages, reset times and applicable model-specific limits.

For automatic selection, prefer a starred, task-capable model with verified capacity on its exact account. Compare session, weekly and applicable model-specific limits. Never pool account quotas or treat stale, missing or unsupported readings as spare capacity. Preserve explicit user choices.

This should make manual selection easier and reduce unused subscription capacity without changing plans or enabling paid modes.

### Keep unattended work moving

With usage-aware routing enabled, recover from an account limit using a suitable account with available capacity. Make the account change visible and provide a switch-back action. If no suitable account is available, use the supported reset-time recovery path rather than inventing capacity.

The intended benefit is fewer overnight tasks stopped by an exhausted subscription. This is recovery between agent attempts, not a claim that a running provider session can change models in place.

### Show work completed and share it

Add a Work view with completed-run, worked-thread and PR totals for a selected period and project scope. Let the developer review the content, export a share card and open an X composer without posting automatically.

This gives indie developers a way to show progress without exposing private prompts or credentials. Sharing should be optional. Any project-star call to action should be optional and should not imply upstream endorsement.

## Implementation and verification status

The implementation snapshot is commit `fe939e90a59f97edceaa3440fc66a2f8658da055` on branch `t3/improve-usage-toolbar-prs`, recorded on November 15, 2026. It includes upstream through `3e7f5ecc55c532ce60e6b1c48f210e17f3c8c9d1`. This proposal does not claim later revisions have been verified.

| Area                       | Evidence available                                                                                                                                                                                      | Still required                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated checks           | Latest integration delta passed `check:changed`, including 299 tests in 14 files, 37 package typechecks, format, lint, knip, GraphQL and React compiler checks. Unaffected earlier evidence was reused. | This was not a fresh full-repository test or build run.                                                                                                 |
| Browser fixture isolation  | The corrected ChatView file passed all 13 tests. Five other fixture-consumer files passed six tests, and incremental checks passed.                                                                     | The earlier failed run must not be described as an entirely passing run.                                                                                |
| Independent review         | A read-only reviewer accepted the exact implementation snapshot with no defects found. Earlier feature and fixture revisions were separately reviewed.                                                  | Re-review affected code after further changes.                                                                                                          |
| Web Work and PNG export    | An isolated development app completed a free Replay run, displayed the resulting work totals and exported a PNG. This preceded the latest upstream merge, which did not change that path.               | No X post was made. Retained evidence does not establish that the X composer was opened.                                                                |
| Multi-account picker       | Automated fixture coverage passed.                                                                                                                                                                      | Demonstrate real two-account labels, details, freshness and switching in the actual client.                                                             |
| Routing and limit recovery | Focused automated routing and recovery tests passed.                                                                                                                                                    | Demonstrate starred-first selection and exhausted-account recovery through the application. Label simulated exhaustion clearly.                         |
| Desktop                    | Automated checks passed.                                                                                                                                                                                | Complete a separate Electron walkthrough.                                                                                                               |
| iOS and Android            | No native runtime evidence. Agent Device access was disabled in the development environment.                                                                                                            | The environment owner enables access; the agent installs the development clients and verifies applicable picker and switch-back paths.                  |
| Remote connections         | No retained integrated runtime evidence for relay or tunnel modes.                                                                                                                                      | Verify applicable paths or explain why a connection mode is unaffected.                                                                                 |
| Screenshots and video      | A share-card PNG and historical picker captures exist locally.                                                                                                                                          | Capture current before/after UI evidence. Historical captures do not establish the current integrated design. Add video for switching or timing claims. |
| Hosted CI                  | No hosted checks ran on the published implementation snapshot. The CI workflow does not trigger on this branch-only push.                                                                               | Do not describe hosted CI as passed.                                                                                                                    |

These checks were recorded by the development agent. Logs and images have not been uploaded as public evidence. No before/after screenshot set is attached to this proposal.

**Merge readiness: not ready.** The agent owns the remaining runtime demonstrations and visual evidence. Native verification first needs the environment owner to enable Device access. Publishing this proposal does not merge the implementation into the fork's default branch.

## Commit and contribution requirements

The repository's [agent instructions](../../AGENTS.md) and [contribution policy](../../CONTRIBUTING.md) are authoritative. For this work:

- Use focused changes and conventional commit titles.
- Run `vp run check:changed` before pushing, and add focused behavioral proof where needed. Passing checks alone does not demonstrate the user journey.
- Verify affected paths in the applicable real clients. Account for permissions, entry points, providers, reverse actions and connection modes.
- UI PRs need before and after screenshots. Motion or timing changes need a short video. Upload PR evidence instead of committing PR-only assets.
- Explain the problem, fix and verification in a PR, and identify the model and harness. No PR is created by publishing this proposal.
- External upstream PRs must fix one bug unless a maintainer explicitly requested the feature PR. A larger fix links its bug issue; an exception links the maintainer's request.
- This combined routing, dashboard and sharing proposal is feature work. It is not eligible for an unsolicited upstream feature PR merely because technical checks pass.

## Feedback requested

Would account capacity beside the model picker help you choose between subscriptions? Would you use opt-in automatic recovery when an account hits a limit? What completed-work information would make a share card useful rather than promotional?
