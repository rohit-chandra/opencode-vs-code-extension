## Your account or your key

- **Claude Code and Codex** sign in with your Claude or ChatGPT account by default, so your subscription is used instead of per-token billing. A terminal opens, your browser asks you to confirm, and the chat notices when you are done.
- **Direct BYOK** asks for an API key once and keeps it in your operating system's keychain (VS Code Secret Storage), never in a settings file. Local servers such as Ollama and LM Studio need no key.
- **opencode** connects providers with `/providers`.

Nothing is sent anywhere except to the engine and model you chose.
