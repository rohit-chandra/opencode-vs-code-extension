## What changed and why

<!-- One or two sentences. Link the issue: "Fixes #123". -->

## How it was checked

- [ ] `npm run lint && npm run typecheck && npm test`
- [ ] `npm run test:e2e` (if an engine changed)
- [ ] `npm run test:ui` (if the chat view changed; screenshots in `test-results/ui/`)
- [ ] For anything a user would notice: the version is raised (`npm version patch --no-git-tag-version`, or `minor` for a feature) and `CHANGELOG.md` has the notes under a `## vX.Y.Z` heading at the top. Merging then releases it automatically
