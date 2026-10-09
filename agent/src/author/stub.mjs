import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkWrite } from '../guard.mjs';
import { HarnessError } from '../lib/errors.mjs';

/**
 * Stub driver: replays recorded author output. Used by the harness tests and for
 * reproducing a run without an LLM.
 *
 * Script format (JSON): { "<source path>": [ { "files": { "<path>": "<content>" }, "result": { ... } }, ... ] }
 * Entry N is used for attempt N. Writes go through the same guard as the real hook.
 * @param {string} scriptFile
 */
export function createStubDriver(scriptFile) {
  const script = JSON.parse(readFileSync(scriptFile, 'utf8'));
  return {
    kind: 'stub',
    async author({ root, target }) {
      const attempts = script[target.path] ?? [];
      const step = attempts[Math.min(target.attempts, attempts.length) - 1];
      if (!step) return {};
      if (step.throw) throw new Error(step.throw);
      for (const [path, content] of Object.entries(step.files ?? {})) {
        const check = checkWrite(root, path, [target.testPath]);
        if (!check.ok) throw new HarnessError('write_denied', check.reason);
        mkdirSync(dirname(join(root, check.path)), { recursive: true });
        writeFileSync(join(root, check.path), content);
      }
      return step.result ?? {};
    },
  };
}
