# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

1. Open the repository's **Security** tab and choose **Report a vulnerability**, or go straight to <https://github.com/rohit-chandra/opencode-vs-code-extension/security/advisories/new>.
2. Describe what you found, the version of OpenCode Hub and your operating system, and how to reproduce it.

You will get an answer as soon as the maintainer has looked at it. Please give a fix a reasonable amount of time before publishing details.

## What is in scope

- The extension host code in `src/` and the chat view in `webview/`.
- The way the extension starts and talks to the engines' CLIs, stores API keys (VS Code Secret Storage) and renders model output.
- The repository's GitHub Actions workflows.

Problems in opencode, Claude Code, Codex, GitHub Copilot or a model provider belong to those projects.

## How the extension is built to be safe

The short version is in the README under *Security and privacy*: no telemetry, no network requests other than to the engine and model you chose, keys in the operating system keychain, sanitized model output, and nothing started in untrusted workspaces.
