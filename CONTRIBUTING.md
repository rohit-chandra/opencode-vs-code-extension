# Contributing

Thanks for helping. A few things make changes easy to review.

## Setup

```bash
npm ci
npm run watch      # then press F5 in VS Code to launch an Extension Development Host
```

Before opening a pull request, run `npm run lint`, `npm run typecheck` and `npm test`. If you touched an engine, also run `npm run test:e2e`; if you touched the chat view, `npm run test:ui` and look at the screenshots in `test-results/ui/`.

## Ground rules

- `src/core`, `src/engines/{opencode,direct,cli}`, `src/mcp`, `src/shared` and `src/ui/controller.ts` must not import `vscode`. They get what they need through `EngineContext` and `ControllerHost`, which is what lets the end-to-end tests run without an editor. ESLint enforces this.
- The webview and the extension host share only `src/shared`.
- Every engine maps its backend onto the types in `src/shared/types.ts`. The UI and the usage ledger never look at engine-specific data.
- Secrets go through `SecretStore`. Nothing sensitive is written to settings or logs.
- A change users will notice carries its own version: run `npm version patch --no-git-tag-version` (or `minor` for a feature) and put the notes under a `## vX.Y.Z` heading at the top of `CHANGELOG.md`. Once it is merged and CI is green, the release happens by itself. Changes users do not see need neither.
- Tests for an engine should talk to the real CLI or API shape. `test/fixtures/mock-llm.mjs` speaks OpenAI chat completions, Anthropic messages and OpenAI responses, so the real `opencode`, `claude` and `codex` binaries can run against it without an account.

## Adding an engine

1. Implement `Engine` from `src/core/engine.ts`. If your backend has no session storage, extend `LocalEngine` and implement `runTurn`; you get sessions, persistence, aborts, permissions, questions (`askQuestions`) and usage events for free. Optional parts of the interface: `efforts` on each `ModelInfo` when the backend has thinking levels (the chosen one arrives as `PromptInput.effort`), and `refreshModels()` when you keep a copy of the model list, so new models show up while VS Code stays open.
2. Add its id to `EngineId` and `ENGINE_LABELS` in `src/shared/types.ts`, and register it in `src/extension.ts`.
3. Add an end-to-end test next to the others in `test/e2e/`.
