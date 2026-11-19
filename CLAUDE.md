# OpenCode Hub

A VS Code extension: one chat view in front of five interchangeable engines (opencode, Direct BYOK, Claude Code, Codex, Copilot / VS Code models). TypeScript, bundled with esbuild. The chat view is a Preact app in a webview; Oki, the 3D companion, is a separate Three.js bundle.

Read `docs/ARCHITECTURE.md` before a change that crosses layers, and `CONTRIBUTING.md` for how to add an engine.

## Commands

```bash
npm ci
npm run lint          # ESLint, including the import rules below
npm run typecheck     # extension host and webview
npm test              # unit tests (vitest), fast, no editor needed
npm run build         # bundles into dist/
npm run test:e2e      # real opencode / claude / codex CLIs against a local mock model server; suites skip when a CLI is missing
npm run test:ui       # the real webview bundle in headless Chrome; needs `npm run build` first and a Chrome install
npm run test:integration   # inside a real VS Code (Linux: xvfb-run -a ...)
```

Run lint, typecheck and unit tests before every commit. Run `test:e2e` after touching an engine, `test:ui` after touching `webview/`.

## Layout

| Path | What lives there |
|---|---|
| `src/extension.ts` | The only place that wires VS Code APIs into `EngineContext` and `ControllerHost` |
| `src/ui/controller.ts` | `ChatController`: owns the view state, runs slash commands, talks to engines |
| `src/ui/chatView.ts` | The webview host (side bar view and editor tab) |
| `src/core/` | Engine interface, local sessions, usage ledger, process helpers, slash commands |
| `src/engines/` | One folder per engine |
| `src/mcp/` | MCP client used by Direct BYOK and Copilot |
| `src/shared/` | Types, protocol and pure helpers shared with the webview |
| `webview/src/` | The chat UI and the companion |
| `test/` | `unit`, `e2e`, `ui`, `integration`, plus fixtures (mock model server, mock MCP server) |

## Rules that are easy to break

- `src/core`, `src/engines/{opencode,direct,cli}`, `src/mcp`, `src/shared` and `src/ui/controller.ts` must not import `vscode`. They get what they need through `EngineContext` and `ControllerHost`, so the tests run without an editor. ESLint enforces it.
- The webview and the host share only `src/shared`, and `src/shared` imports neither `vscode` nor Node modules.
- A new field in `ViewState` needs a default in three places: the controller's constructor, `webview/src/store.ts` and `test/ui/fixtures.mjs`. A new `ControllerHost` method needs an implementation in `src/extension.ts` and in `test/helpers/fakeHost.ts`.
- Every engine maps its backend onto `src/shared/types.ts`. The UI and the usage ledger never look at engine-specific data.
- Secrets go through `SecretStore` (VS Code Secret Storage). Nothing sensitive goes into settings, logs or diagnostics.
- Privacy is a feature: no telemetry, and no network request other than to the engine and model the user chose. Do not add either. Feedback opens a pre-filled GitHub issue in the user's browser and sends nothing by itself.
- It must work on Windows, macOS and Linux. Spawn CLIs through `spawnCli` and find them with `findExecutable` (`src/core/process.ts`); build paths with `node:path`; never assume a POSIX shell.
- Model output is untrusted: it is rendered through marked and DOMPurify, and links are posted to the host instead of navigating.
- User-facing text is plain and specific. Say what happened and what to do next.

## Tests

- Put a unit test next to the others in `test/unit` for parsers, reducers and other pure code.
- Engine tests talk to the real CLI or API shape through `test/fixtures/mock-llm.mjs`, not to hand-written fakes of the engine.
- Controller behaviour is tested in `test/e2e/controller.test.ts` with `FakeHost`, which mirrors what the webview would show.

## Changelog and versions

User-visible changes get a line in `CHANGELOG.md` under the topmost section. The maintainer bumps `version` in `package.json` and tags releases; do not do either in a fix.
