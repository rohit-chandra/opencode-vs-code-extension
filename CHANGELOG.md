# Changelog

## 0.5.1

### Fixed

- **Claude Code and Codex: the model list now follows your account.** After signing in with a subscription, the list could stay as it was before the sign-in: it was fetched once and kept for ten minutes, and right after a sign-in the CLI itself may not know the plan yet. The list is now fetched again after a sign-in (twice, a few seconds apart), after the first reply, and in the background whenever it is more than a minute old. A sign-in, sign-out or account switch made outside the chat (in a terminal, or by signing in again while signed in) is noticed when the window gets the focus back.
- Extra models in `opencodeHub.claudeCode.models` / `opencodeHub.codex.models` appear as soon as the setting changes, not after a restart.

### Added

- **Every Claude model can be picked in Claude Code.** After the list the CLI reports for your account come the model families it left out (Fable, Opus, Sonnet, Haiku) and **Opus Plan Mode**. **Add a model by name…** in the model picker (Claude Code and Codex) adds any other model the CLI accepts, such as an earlier version.

## 0.5.0

### Added

- **Send feedback from the chat.** `/feedback`, *OpenCode Hub: Send Feedback or Report a Problem…*, or **Report a problem** under a failed reply opens a short form (bug, idea or other). Continuing opens a pre-filled GitHub issue in your browser, which you review and submit yourself. Diagnostics (versions, operating system, engine status) are optional and shown before anything leaves; prompts, files, paths and keys are never included.
- **`/doctor`** and *OpenCode Hub: Run Doctor*: the extension and editor versions, your operating system, and the state and version of every engine, in the chat.
- **Cost for every engine that counts tokens.** Codex and Direct BYOK (OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, xAI, Together AI, Hugging Face) now show what each reply and session costs, estimated from list prices bundled with the extension, next to the costs opencode, Claude Code and OpenRouter already reported. Prices under `pricing` in `opencodeHub.providers` win; `opencodeHub.usage.estimateCost` turns estimates off.
- **Bring another session into a new chat.** The link icon in the sessions list, or `/context`, attaches a condensed copy of a saved session (from any engine) to your next message. Optional, never automatic, and no model is called to make it.
- **Long Direct BYOK conversations keep going.** When a provider reports that the context window is full, the oldest turns are left out of the request (whole turns, so tool calls keep their results) and the chat says so. `opencodeHub.direct.maxContextTokens` sets a budget up front for local servers that cut prompts silently.
- **Explain Selection** and **Fix Selection** in the editor's context menu, and **Fix with OpenCode Hub** in the lightbulb on errors and warnings (`opencodeHub.editor.quickFix`).
- A **Get Started** walkthrough (*OpenCode Hub: Get Started*).
- **The open file is one click away**, like Copilot's current file: a dashed chip above the message box shows the file you are editing (or its selected lines) and adds it as context when clicked.
- The output of `/help` and `/doctor` is a card with a **close button**.
- **The chat shows who you are talking to.** A strip along the top of the chat, the message box's border and a dot under the companion take the colour of the model's maker: orange for Claude, green for OpenAI, blue for Gemini, purple for Copilot, grey for local models. `opencodeHub.chat.providerColors` turns it off.

### Changed

- **Subscriptions first, API keys last, everywhere.** opencode's `/providers` now opens with **Sign in with a subscription**, lists opencode's own plan sign-ins (ChatGPT Plus/Pro, GitHub Copilot, GitLab Duo, …) and runs `opencode auth login` straight at the one you pick; an API key is the last option. Connecting a provider that has a plan offers the plan before the key. The engine picker lists the engines that sign in with a plan first and Direct BYOK (API keys only) last, and the Direct BYOK menu starts with *Use a subscription instead*.
- The model's name is no longer repeated under every reply; it is in the tooltip with the token breakdown.
- In a typical side bar width, the session pill shows the session's cost (tokens in its tooltip) instead of hiding the cost.
- **macOS and Linux:** the CLIs are also found where Homebrew, nvm, Volta, fnm, asdf, mise, pnpm, bun, Nix, Snap and Linuxbrew install them, so an editor started from the Dock or a desktop launcher (without your shell's `PATH`) finds them. The CLI's own folder is put on its `PATH` when it is started, so npm-installed CLIs that run on an nvm or Volta Node start too. Sign-in terminals use the full path when the plain command would not be found.
- CI runs the extension inside VS Code on macOS and Windows as well as Linux, and the engine tests with the real CLIs must pass on all three.
- The README's architecture diagrams are redesigned and rendered as images, so they also show on the Marketplace page.

### Fixed

- **opencode: models from an OpenCode Console sign-in (and other sign-ins of newer opencode CLIs) now show up.** Newer opencode keeps those sign-ins as "integrations" in its database, and lists their models only through its newer API; the chat read only the older list and the older `auth.json`, so it showed no models at all after such a sign-in. It now reads both lists and notices sign-ins in both places.
- **opencode: models from a subscription signed in in a terminal now appear by themselves.** After `opencode auth login` (ChatGPT Plus/Pro, GitHub Copilot or an API key), the running opencode server kept its old provider list until the engine was restarted, so the new models never showed up. The extension now notices the sign-in (or sign-out), has opencode reload its providers, and says which provider connected and how many models it brought.
- Fields the extension cleared (no session, no open file, a notice gone) could stay on screen, because VS Code's JSON transport to the chat view drops `undefined`. They are now sent as `null` and cleared in the view.
- Text attachments with no file on disk (a file dropped from outside VS Code) reached the opencode engine as a path it could not read.

### For maintainers

- The extension is ready for the Visual Studio Marketplace: the release workflow publishes with Trusted Publishing (no stored token) or `VSCE_PAT`, and to Open VSX with `OVSX_PAT`. See `docs/MAINTAINING.md`.
- `npm run stats` prints installs and downloads from the Marketplace, Open VSX and GitHub releases.
- A Claude agent workflow (`.github/workflows/claude.yml`) fixes issues labelled `claude-fix` and opens a pull request; issue forms, a pull request template, `SECURITY.md` and `CLAUDE.md` were added.

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
