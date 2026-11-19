import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Attachment } from '../../src/shared/types';

/**
 * Three attachments at once, the way a user adds them: two whole files (from @, the paperclip
 * or a drop) and a selection from the editor. Each carries a distinct marker so a test can
 * check that all of them reached the model as part of the same prompt.
 */
export function multiAttachments(dir: string): { attachments: Attachment[]; markers: string[]; paths: string[] } {
  mkdirSync(dir, { recursive: true });
  const a = path.join(dir, 'alpha.ts');
  const b = path.join(dir, 'beta.md');
  const c = path.join(dir, 'gamma.py');
  writeFileSync(a, 'export const ALPHA_MARKER = 1;\n');
  writeFileSync(b, '# BETA_MARKER notes\n');
  writeFileSync(c, 'def f():\n    return "GAMMA_MARKER"\n');
  return {
    attachments: [
      { id: 'att_a', kind: 'file', name: 'alpha.ts', mime: 'text/plain', path: a },
      { id: 'att_b', kind: 'file', name: 'beta.md', mime: 'text/markdown', path: b },
      { id: 'att_c', kind: 'selection', name: 'gamma.py:2-2', mime: 'text/plain', path: c, text: '    return "GAMMA_MARKER"', range: { startLine: 2, endLine: 2 } },
    ],
    markers: ['ALPHA_MARKER', 'BETA_MARKER', 'GAMMA_MARKER'],
    paths: [a, b, c],
  };
}
