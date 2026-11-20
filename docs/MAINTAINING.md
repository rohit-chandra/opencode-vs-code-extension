# Maintaining OpenCode Hub

For the person who owns the repository: publishing to the stores, seeing how many people use the extension, and the Claude agent that works on issues.

## Releasing a version

Releases are automatic. There is nothing to tag or draft.

1. A change that users will see raises `version` (`npm version patch --no-git-tag-version`, or `minor` for a feature) and puts its notes under a `## vX.Y.Z` heading at the top of `CHANGELOG.md`. Claude does this as part of the change, in a session and in the pull requests of the issue agent.
2. The change reaches `main` (a push, or a merged pull request) and CI runs.
3. When CI is green and that version has no release yet, the **Release** workflow creates the tag `vX.Y.Z` on that commit, builds `opencode-hub-X.Y.Z.vsix`, creates the GitHub release with the changelog section as its notes, attaches the file and its checksum, and publishes to the stores that are set up (below).

A push that does not change the version releases nothing. To see what happened, open **Actions → Release**; each run says in its summary whether it released, and why not when it did not.

| If | Then |
|---|---|
| CI is red | Nothing is released. Fix `main`; the next green run releases |
| You want to hold a version back | Leave `version` as it is until you are ready; several changes can share one version |
| A release run failed half-way | **Actions → Release → Run workflow** on `main` builds and attaches whatever is missing |
| You created a tag or a release by hand | It still works as long as the tag is `v` plus the `version` on that commit; otherwise the run fails and says which of the two to change |

### Prices that update themselves

Cost estimates use the list prices in `src/core/prices.json`. The **Model prices** workflow regenerates that file every Monday from the catalogue the `opencode` CLI carries. When a price changed or a model was added it commits the file to `main` as a patch version with a changelog line and starts CI; the release follows as above. A week without changes does nothing. To pause it, disable the workflow under **Actions → Model prices**; to run it now, **Run workflow** there. `npm run prices` does the same by hand.

Because that workflow commits to `main`, pull before you push after a Monday (`git pull --rebase`).

## Visual Studio Marketplace

This is what makes the extension show up when someone searches in the Extensions view of VS Code. It is set up once.

### 1. Create the publisher

1. Open <https://marketplace.visualstudio.com/manage> and sign in with a Microsoft account.
2. Choose **Create publisher**.
3. **ID:** `rohit-chandra`. It must be exactly the `publisher` in `package.json`, and it cannot be changed later. If that ID is taken, pick another and change `publisher` in `package.json` to match (the extension's id, `publisher.opencode-hub`, changes with it).
4. **Name:** what people see in the Marketplace, for example your name. Create.

### 2. Let the release workflow publish (Trusted Publishing)

Trusted Publishing lets GitHub Actions prove to the Marketplace which repository and workflow a run comes from, so no token is stored anywhere. It replaces Azure DevOps personal access tokens, which stop working for this on 1 December 2026.

1. On the publisher page, open **Trusted Publishing** and expand **Create**.
2. Fill in:

   | Field | Value |
   |---|---|
   | Policy name | `Release workflow` |
   | Repository owner | `rohit-chandra` |
   | Repository | `opencode-vs-code-extension` |
   | Workflow | `release.yml` |
   | Environment | leave empty |

3. In the GitHub repository: **Settings → Secrets and variables → Actions → Variables → New repository variable**, name `MARKETPLACE_TRUSTED_PUBLISHING`, value `true`.

From the next release on, the `publish` job runs `vsce publish --oidc`.

### 3. The first version

Let a version be released (above). If the Marketplace refuses the first upload from the workflow because the extension does not exist yet, upload it once by hand: on the publisher page choose **New extension → Visual Studio Code** and drop in the `.vsix` from the GitHub release. Later versions go through the workflow.

A new listing is usually searchable within a few minutes; the Marketplace scans every upload first.

To publish a release that already exists to a store you set up afterwards: **Actions → Release → Run workflow**, and tick **Publish again**. Versions that are already in a store are skipped.

## Open VSX (Cursor, VSCodium, Windsurf, Gitpod)

Editors that are not Microsoft's own search Open VSX instead of the Marketplace.

1. Sign in at <https://open-vsx.org> with GitHub, and sign the publisher agreement (it asks for an Eclipse account).
2. Create an access token under **Settings → Access Tokens**.
3. Create the namespace once: `npx ovsx create-namespace rohit-chandra -p <token>`.
4. Add the token to the GitHub repository as the secret `OVSX_PAT`.

## How many people use it

The extension has no telemetry, on purpose, so there is no count of active users and no usage tracking. What exists are the stores' own numbers:

| Where | What it shows |
|---|---|
| Marketplace publisher page → the extension → **Reports** | Installs and downloads per day, page views, the conversion from views to installs, uninstalls, ratings and reviews. Export to Excel from there |
| The extension's Marketplace page | The total install count, public |
| <https://open-vsx.org/extension/rohit-chandra/opencode-hub> | Downloads on Open VSX |
| GitHub → **Insights → Traffic** | Visitors and clones of the repository over the last 14 days |
| `npm run stats` | Marketplace installs, Open VSX downloads, `.vsix` downloads per GitHub release and stars, in one place |

Installs count machines that installed it, not people who use it every day. The other signals are the issues people open from `/feedback` and the ratings they leave.

If you ever want real usage numbers, the honest way is opt-in telemetry that respects VS Code's `telemetry.telemetryLevel` setting, said plainly in the README. It would end the "no telemetry" promise, so it is not built.

## The Claude agent

`.github/workflows/claude.yml` runs Claude Code in GitHub Actions on this repository.

| What you do | What happens |
|---|---|
| Add the label `claude-fix` to an issue | Claude reads the issue, reproduces the problem with a test where it can, fixes it on a branch named `claude/issue-<number>-…`, runs lint, type checks and unit tests, and comments with what it found. A pull request is opened that says `Fixes #<number>` |
| Open a bug report yourself (owner or collaborator) | The same, straight away, without the label |
| Write `@claude …` in a comment on an issue or pull request | Claude answers or makes the change you asked for |

Nothing is merged automatically. You review the pull request, CI runs on it, and you merge.

### Why issues from other people wait for the label

An issue is text from the internet, and the agent can push branches to this repository and uses your Claude subscription. If every new issue started the agent, anyone could try to steer it with a crafted issue, or simply use up your plan. So the action only starts for people with write access, and an issue from anyone else waits until you have read it and added the label. `triage.yml` posts a short welcome on those issues so the reporter knows what to expect. Please do not add `allowed_non_write_users` to the workflow.

Only your comments are passed to the agent as context (`include_comments_by_actor`), not comments from other people.

### Set-up, once

1. Install the Claude GitHub App on this repository: <https://github.com/apps/claude>.
2. On your computer, run `claude setup-token` and sign in. It prints a long-lived token for your Claude subscription.
3. Add it to the repository: **Settings → Secrets and variables → Actions → New repository secret**, name `CLAUDE_CODE_OAUTH_TOKEN`.
4. **Settings → Actions → General → Workflow permissions**: tick **Allow GitHub Actions to create and approve pull requests**, so the workflow can open the pull request for Claude's branch. Without it, Claude's comment on the issue still has a link that opens the pull request with one click.

Running `/install-github-app` inside Claude Code in a clone of the repository does steps 1 to 3 for you. To use an API key instead of a subscription, add the secret `ANTHROPIC_API_KEY` and change `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}` to `anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}` in both jobs.

Until the secret exists the workflow changes nothing; it says so in its log and in one comment on the issue.

`CLAUDE.md` in the repository root is what the agent reads first: the commands, the layout and the rules that are easy to break. Keep it short and current.

### Private vulnerability reports

`SECURITY.md` sends security reports to GitHub's private reporting form. Turn it on under **Settings → Code security → Private vulnerability reporting**.
