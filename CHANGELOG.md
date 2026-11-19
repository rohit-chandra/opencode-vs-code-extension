# Changelog

## 0.2.0

### Added

- A new Oki. The companion is now an original round character with a full set of feelings: it listens while you type, thinks, talks while text streams, puts on a hard hat and works while a tool runs (hammer for commands, pencil for edits, magnifier for searches), cheers with confetti when a turn with tools succeeds, tears up when something fails, waves when the agent needs your approval, and falls asleep after three minutes of quiet. Each finished or failed tool gets its own small reaction, and you can poke it.
- A minimal `dots` companion style with the same moods. `/avatar buddy` and `/avatar dots` switch between them.
- The chat can live on the right: **Move Chat to the Right (Secondary Side Bar)**, **Move Chat to the Left (Primary Side Bar)** and `/move [left|right|editor]`.
- **Open Chat in an Editor Tab**: a full-size chat that can be split, resized or moved to its own window, and is restored after a reload.
- Text size for the chat: `Ctrl+Alt+=`, `Ctrl+Alt+-`, `Ctrl+Alt+0`, `/zoom`, and the `opencodeHub.chat.zoom` setting.
- README: system design diagram, a walkthrough of what happens when you send a message, and step-by-step installation.

### Changed

- Streaming is about six times faster to render. Tokens are grouped per frame, Markdown is parsed block by block, and finished messages are no longer re-rendered. A 977-chunk reply went from about 7.8 s to about 1.2 s in the UI benchmark.
- Off-screen messages are skipped during layout, and very large model lists are capped until you search.
- The companion renders only when something moves and stops completely when the chat is hidden.
- The conversation keeps a readable line length in wide panels and editor tabs.
- New extension icons that match the companion.
- `opencodeHub.avatar.style` is now `buddy` or `dots`. The old values `bot` and `orb` are still understood.

### Fixed

- A turn that an engine splits into several messages (a tool call, then the answer) is now judged as one turn by the companion.

## 0.1.0

First release.

- Chat view with five engines: opencode, Direct BYOK (OpenAI-compatible and Anthropic), Claude Code, Codex and VS Code language models (GitHub Copilot).
- Sessions: create, search, switch, rename, delete, fork and export to Markdown.
- Slash commands with autocomplete, including commands defined by the engine.
- Attachments: file picker, `@` mentions, drag and drop, pasted images, editor selections.
- MCP panel with live status and a toggle per server, for every engine.
- Token usage per reply, per session and overall by provider and model, kept across restarts.
- Permission and question prompts for opencode, and approval for MCP tool calls in Direct BYOK and Copilot.
- Oki, a 3D companion that reacts to the chat, with an orb style and a 2D fallback.
