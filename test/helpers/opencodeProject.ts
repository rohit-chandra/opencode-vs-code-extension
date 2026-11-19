import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A throw-away project configured so the real opencode server talks to the mock LLM,
 * with one MCP server, one custom command and `bash` set to ask for permission.
 * XDG dirs are redirected so the developer's own opencode data is never touched.
 */
export function makeOpencodeProject(mockPort: number): { dir: string; env: NodeJS.ProcessEnv; cleanup(): void } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ochub-oc-'));
  const dir = path.join(root, 'project');
  mkdirSync(path.join(dir, '.opencode', 'command'), { recursive: true });
  writeFileSync(
    path.join(dir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        model: 'mock/mock-small',
        small_model: 'mock/mock-small',
        autoupdate: false,
        share: 'disabled',
        permission: { bash: 'ask' },
        provider: {
          mock: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Mock Provider',
            options: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'sk-mock' },
            models: { 'mock-small': { name: 'Mock Small' }, 'mock-large': { name: 'Mock Large' } },
          },
        },
        mcp: { mockmcp: { type: 'local', command: [process.execPath, path.resolve('test/fixtures/mock-mcp.mjs')], enabled: true } },
      },
      null,
      2,
    ),
  );
  writeFileSync(path.join(dir, '.opencode', 'command', 'greet.md'), '---\ndescription: Greet someone\n---\nSay hello to $ARGUMENTS\n');
  writeFileSync(path.join(dir, 'hello.txt'), 'the secret word is pineapple\n');
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
  } catch {
    /* git is optional */
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_STATE_HOME: path.join(root, 'state'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
  };
  // Keep provider credentials of the host machine out of the test server.
  for (const k of Object.keys(env)) if (/^(AWS_|ANTHROPIC_|OPENAI_|GITHUB_TOKEN|GH_TOKEN|GOOGLE_|GEMINI_|OPENROUTER_)/.test(k)) delete env[k];
  return {
    dir,
    env,
    cleanup: () => {
      try {
        // The server may still be flushing files while it shuts down.
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* best effort: it is a temp directory */
      }
    },
  };
}
