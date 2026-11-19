# Architecture

```
┌──────────────────────────── VS Code extension host ────────────────────────────┐
│                                                                                │
│  extension.ts ── wires VS Code APIs into two small interfaces                  │
│      │                                                                         │
│      ├── ChatController (ui/controller.ts)                                     │
│      │      owns the view state, reduces engine events, runs slash commands    │
│      │         │                    │                     │                    │
│      │         ▼                    ▼                     ▼                    │
│      │   Engine (×5)          UsageLedger           ControllerHost             │
│      │   core/engine.ts       core/usageLedger.ts   (pickers, dialogs, files)  │
│      │                                                                         │
│      └── ChatViewProvider (ui/chatView.ts) ── postMessage ──┐                  │
└─────────────────────────────────────────────────────────────┼──────────────────┘
                                                              ▼
                                     webview/ (Preact) — mirrors the view state,
                                     loads the Three.js companion on demand
```

## Engines

All engines implement `Engine` and emit the same `EngineEvent`s.

| Engine | File | Transport |
|---|---|---|
| opencode | `src/engines/opencode/` | Spawns `opencode serve` (or attaches to one), HTTP for requests, SSE (`/event`) for streaming. opencode owns sessions, tools, permissions, MCP and credentials |
| Direct BYOK | `src/engines/direct/` | `fetch` to `/chat/completions` or `/v1/messages`, SSE streaming, a tool loop over MCP tools |
| Claude Code | `src/engines/cli/claudeCode.ts` | One `claude -p --output-format stream-json` process per turn, `--resume` for continuity |
| Codex | `src/engines/cli/codex.ts` | One `codex exec --json` process per turn, `exec resume` for continuity |
| Copilot | `src/engines/vscodeLm/` | `vscode.lm` chat models, with a tool loop over MCP tools |

The last four extend `LocalEngine` (`src/core/localEngine.ts`), which stores sessions as JSON files in the extension's global storage, scoped per workspace.

## Data flow of one message

1. The webview posts `{ type: 'send', text }`.
2. `ChatController.send` handles built-in slash commands itself; otherwise it makes sure the engine is running, creates a session if needed and calls `engine.sendPrompt` (or `runCommand` for engine commands).
3. The engine emits `message.updated`, `part.updated`, `part.delta`, `session.status` and finally `usage`.
4. The controller applies message events with `applyMessageEvent` (`src/shared/reducer.ts`) and forwards the event itself to the webview, which runs the same reducer. Streaming therefore never re-sends whole messages.
5. `usage` events go to the `UsageLedger`, which is idempotent per message id: history reloads and repeated stream updates only apply the difference.

## Usage accounting

`TokenUsage` has exclusive buckets: uncached input, output, reasoning, cache read, cache write, and cost. Each engine normalizes its provider's numbers into those buckets (for example OpenAI's `prompt_tokens` includes cached tokens, Anthropic's `input_tokens` does not). The ledger keeps totals per engine/provider/model, per day and per session in VS Code's global state.

## Webview

- `webview/src/store.ts` mirrors `ViewState`; the host sends a full `state` once, then `patch`es and streaming `event`s.
- Markdown is rendered with marked and sanitized with DOMPurify. Links never navigate: clicks are posted to the host, which opens files in the editor or URLs in the browser.
- The content security policy allows only the extension's own scripts and styles and `data:`/`blob:` images.
- `webview/src/avatar/` is a separate bundle (Three.js) loaded after the chat is interactive.

## Tests

| Layer | Location | Notes |
|---|---|---|
| Unit | `test/unit` | Parsers, reducers, mapping, ledger, translators |
| End to end | `test/e2e` | Real `opencode`, `claude`, `codex` processes against `test/fixtures/mock-llm.mjs` and `mock-mcp.mjs` |
| UI | `test/ui` | Real webview bundle in headless Chrome with a mocked `acquireVsCodeApi` |
| Integration | `test/integration` | Inside VS Code through `@vscode/test-electron` |
