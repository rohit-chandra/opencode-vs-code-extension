# Changelog

## 0.4.0

### Added

- **Hugging Face** for Direct BYOK: open models from the Hub through Inference Providers (one Hugging Face token, `HF_TOKEN` / `HUGGINGFACE_HUB_TOKEN` also read from the environment), your own dedicated Inference Endpoint, and a local Text Generation Inference server.
- **Ask / Auto** approvals. Ask (default) waits for your approval before commands, file edits and tool calls; Auto proceeds without asking, like the Claude app's auto mode. A shield button under the message box, `/auto`, `/ask`, **Switch to Auto** on approval cards, *OpenCode Hub: Toggle Auto Mode*, and the user-only setting `opencodeHub.approvals`.
- **Claude Code can ask for approval.** Tool calls that its permission mode does not already allow are shown in the chat (through `--permission-prompt-tool` and a small local MCP bridge), with Allow once, Always allow (for the rest of the session) and Deny.
- **Tokens for the open session** next to the model under the message box, with cost when known; hover for in/out and replies, click for details.
- A **per-reply** table in the usage panel's "This session" section: model, tokens in and out, and cost of each reply.
- **Claude Code and Codex list the models your plan includes, by their real names.** Claude Code's models come from the CLI itself for the signed-in account (for example *Default (Opus 5.5)*, *Fable 5.2*, *Opus 5.5*, *Sonnet 5.5*, *Haiku 5.5*) instead of the bare aliases `opus`, `sonnet`, `haiku`; Codex's come from `codex app-server` (the GPT models of your ChatGPT plan). The list refreshes after you sign in or switch to an API key. The model picker also shows a short description of each model.

- **One history for every engine.** The sessions panel lists every engine's saved sessions for the folder (All engines), labelled by engine; opening one switches engine. A tab shows only the current engine.
- `opencodeHub.sessions.keepDays` (default 30, like Claude Code): sessions unused for longer are deleted at start-up; `0` keeps everything.

### Fixed

- **Sessions no longer look lost after closing VS Code.** Conversations are saved when you send and every few seconds while a reply streams (before, only when the reply finished), VS Code waits for the last write on shutdown, and Claude Code / Codex conversation ids are kept from the first event so they resume after a restart. The last engine and session are remembered per folder in the profile, so they come back even in a window with no folder open.

### Changed

- Saved sessions are listed from a small index and a conversation is read from disk only when opened (at most 8 stay in memory), so memory no longer grows with the number of sessions. Session files are readable only by your user account on macOS and Linux.
- The token count moved from the top bar's usage icon to the session pill under the message box.
- In a typical side bar width, the Ask label and the session cost collapse into their tooltips so the model name keeps its room. Auto always stays labelled.

## 0.3.0

### Added

- A **Copy** button under every response. It copies the whole answer as Markdown (its text, without thinking or tool calls) and shows when the reply has finished.
- Claude Code and Codex sign in with your account by default. Picking either engine shows **Sign in with Claude** or **Sign in with ChatGPT**, which runs `claude auth login --claudeai` or `codex login` in a terminal and opens the browser; the chat picks up the sign-in by itself. Codex also offers a device-code sign-in for remote machines.
- **Use an API key instead** for both engines, with the key kept in VS Code Secret Storage. New settings `opencodeHub.claudeCode.auth` and `opencodeHub.codex.auth` (`subscription` by default, or `apiKey`).
- `/login` and **OpenCode Hub: Sign In / Manage Account** to sign in, switch between the account and an API key, remove the key or sign out. `/providers` opens the same options for these two engines.
- The signed-in account is shown on the start screen, and a warning appears when Codex or Claude Code is billing an API key while set to use your subscription.

### Changed

- In subscription mode, `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (Claude Code) and `CODEX_API_KEY` (Codex) are hidden from the CLI, so a key set in your shell for other tools can no longer silently switch you to per-token billing.
- Messages are not sent while Claude Code or Codex is signed out; the chat asks you to sign in instead of failing.

## 0.2.0

### Added

- A new Oki. The companion is now an original round character with a full set of feelings: it listens while you type, thinks, talks while text streams, puts on a hard hat and works while a tool runs (hammer for commands, pencil for edits, magnifier for searches), cheers with confetti when a turn with tools succeeds, tears up when something fails, waves when the agent needs your approval, and falls asleep after three minutes of quiet. Each finished or failed tool gets its own small reaction, and you can poke it.
- A minimal `dots` companion style with the same moods. `/avatar buddy` and `/avatar dots` switch between them.
- The chat can live on the right: **Move Chat to the Right (Secondary Side Bar)**, **Move Chat to the Left (Primary Side Bar)** and `/move [left|right|editor]`.
- **Open Chat in an Editor Tab**: a full-size chat that can be split, resized or moved to its own window, and is restored after a reload.
- Text size for the chat: `Ctrl+Alt+=`, `Ctrl+Alt+-`, `Ctrl+Alt+0`, `/zoom`, and the `opencodeHub.chat.zoom` setting.
- A context-window meter in the message box, with a warning at 75% and 90% of the model's limit.
- **Retry** under a reply that failed or was stopped.
- Recently used models at the top of the model picker.
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
