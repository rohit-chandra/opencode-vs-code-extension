#!/usr/bin/env node
// Runs the integration suite inside a real VS Code (or VSCodium) instance.
//   VSCODE_BIN      path to an existing VS Code/VSCodium executable (optional)
//   VSCODE_VERSION  version to download when VSCODE_BIN is not set, e.g. 1.98.2 (default: stable)
//   OPENCODE_BIN    path to the opencode CLI (optional; chat tests are skipped without it)
//   EXTENSION_PATH  folder of the extension to load (default: this repository). Point it at
//                   an unpacked .vsix to test the packaged artifact.
// On Linux without a display, run under xvfb:  xvfb-run -a npm run test:integration
import { runTests } from '@vscode/test-electron';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMockLlm } from '../fixtures/mock-llm.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, 'out', 'integration');

await build({
  entryPoints: [path.join(root, 'test/integration/suite/index.ts')],
  outfile: path.join(out, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode', 'mocha'],
  sourcemap: 'inline',
  logLevel: 'warning',
});

const findOnPath = (name) => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']) {
      const p = path.join(dir, name + ext);
      if (dir && existsSync(p)) return p;
    }
  }
  return undefined;
};
const opencodeBin = process.env.OPENCODE_BIN || findOnPath('opencode');

const mock = createMockLlm();
const port = await mock.listen();

// A throw-away workspace wired to the mock model, plus isolated opencode data and VS Code profile.
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ochub-vscode-'));
const workspace = path.join(tmp, 'workspace');
mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
mkdirSync(path.join(workspace, '.opencode', 'command'), { recursive: true });
writeFileSync(path.join(workspace, 'hello.txt'), 'the secret word is pineapple\nsecond line\n');
writeFileSync(path.join(workspace, '.opencode', 'command', 'greet.md'), '---\ndescription: Greet someone\n---\nSay hello to $ARGUMENTS\n');
writeFileSync(
  path.join(workspace, 'opencode.json'),
  JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: 'mock/mock-small',
    small_model: 'mock/mock-small',
    autoupdate: false,
    share: 'disabled',
    provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'Mock Provider', options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-mock' }, models: { 'mock-small': { name: 'Mock Small' }, 'mock-large': { name: 'Mock Large' } } } },
    mcp: { mockmcp: { type: 'local', command: [process.execPath, path.join(root, 'test/fixtures/mock-mcp.mjs')], enabled: true } },
  }),
);
writeFileSync(
  path.join(workspace, '.vscode', 'settings.json'),
  JSON.stringify({
    'opencodeHub.opencode.path': opencodeBin ?? '/nonexistent/opencode',
    'opencodeHub.claudeCode.path': '/nonexistent/claude',
    'opencodeHub.codex.path': '/nonexistent/codex',
    'security.workspace.trust.enabled': false,
  }),
);
try {
  execFileSync('git', ['init', '-q'], { cwd: workspace });
} catch {
  /* git is optional */
}

const env = {
  OCHUB_TEST_MOCK_PORT: String(port),
  OCHUB_TEST_HAS_OPENCODE: opencodeBin ? '1' : '',
  XDG_DATA_HOME: path.join(tmp, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(tmp, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(tmp, 'xdg', 'cache'),
  XDG_STATE_HOME: path.join(tmp, 'xdg', 'state'),
  OPENCODE_DISABLE_AUTOUPDATE: '1',
};
// Keep host credentials and agent-session variables away from the editor under test.
for (const k of Object.keys(process.env)) if (/^(AWS_|ANTHROPIC_|OPENAI_|GITHUB_TOKEN|GH_TOKEN|CLAUDE)/.test(k)) delete process.env[k];

const launchArgs = [workspace, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--user-data-dir', path.join(tmp, 'user-data'), '--extensions-dir', path.join(tmp, 'extensions')];
if (process.platform === 'linux') launchArgs.push('--no-sandbox', '--disable-gpu-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');

if (process.env.VSCODE_EXTRA_ARGS) launchArgs.push(...process.env.VSCODE_EXTRA_ARGS.split(' ').filter(Boolean));

let code = 0;
try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_BIN || undefined,
    version: process.env.VSCODE_BIN ? undefined : process.env.VSCODE_VERSION || 'stable',
    extensionDevelopmentPath: process.env.EXTENSION_PATH ? path.resolve(process.env.EXTENSION_PATH) : root,
    extensionTestsPath: process.env.OCHUB_TESTS_PATH || path.join(out, 'index.js'),
    extensionTestsEnv: env,
    launchArgs,
  });
} catch (err) {
  console.error(String(err?.message ?? err));
  code = 1;
} finally {
  await mock.close();
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* temp dir */
  }
}
process.exit(code);
