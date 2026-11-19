#!/usr/bin/env node
// A stand-in for the `claude` CLI, for what cannot be tested against the real one: signing
// in with a subscription. It answers `--version`, `auth status --json` and the SDK
// `initialize` request from a JSON file (FAKE_CLAUDE_STATE) that the test rewrites:
//   { "loggedIn": true, "email": "…", "subscriptionType": "max", "models": [{ value, displayName, description }] }
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const state = () => {
  try {
    return JSON.parse(readFileSync(process.env.FAKE_CLAUDE_STATE, 'utf8'));
  } catch {
    return { loggedIn: false, models: [] };
  }
};

if (args.includes('--version')) {
  console.log('2.1.999 (Claude Code)');
} else if (args[0] === 'auth' && args[1] === 'status') {
  const s = state();
  console.log(JSON.stringify(s.loggedIn ? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: s.email, subscriptionType: s.subscriptionType } : { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }));
} else if (args.includes('-p')) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
        // One line per model listing, so a test can tell when the extension asked.
        appendFileSync(`${process.env.FAKE_CLAUDE_STATE}.log`, `${(state().models ?? []).length}\n`);
        console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { models: state().models ?? [], commands: [] } } }));
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
} else {
  process.exit(0);
}
