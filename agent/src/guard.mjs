import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Write allowlist for anything the agent produces. Used by the write-time hook,
 * by gate G1, and by the publish job when it validates the patch.
 */
const WRITABLE = [
  /^backend\/tests\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.test\.ts$/,
  /^frontend\/src\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.test\.tsx?$/,
];

const READ_DENIED = [/(^|\/)\.env(\.|$)/, /\.pem$/, /(^|\/)\.git\//, /(^|\/)\.uta-runs\//];

/**
 * Normalize a path to repo-relative POSIX form, or return null if it escapes the root
 * or contains suspicious segments.
 * @param {string} root absolute repository root
 * @param {string} input absolute or relative path
 */
export function toRepoRelative(root, input) {
  if (typeof input !== 'string' || !input || input.includes('\0')) return null;
  const abs = isAbsolute(input) ? resolve(input) : resolve(root, input);
  let rel = relative(resolve(root), abs);
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(rel)) return null; // different drive
  rel = rel.split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  if (rel.split('/').some((part) => part === '..' || part === '')) return null;
  return rel;
}

/**
 * True if the nearest existing ancestor of `abs` resolves (through symlinks) inside the root.
 * @param {string} root
 * @param {string} abs
 */
function staysInsideRoot(root, abs) {
  const realRoot = realpathSync(root);
  let probe = abs;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return false;
    probe = parent;
  }
  const real = realpathSync(probe);
  const rel = relative(realRoot, real);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** @param {string} relPath repo-relative POSIX path */
export function isWritablePath(relPath) {
  return WRITABLE.some((re) => re.test(relPath));
}

/**
 * Decide whether a write is allowed.
 * @param {string} root
 * @param {string} input
 * @param {string[] | null} [onlyThese] optional narrower list (the current target's test path)
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function checkWrite(root, input, onlyThese = null) {
  const rel = toRepoRelative(root, input);
  if (!rel) return { ok: false, reason: `path escapes the repository: ${input}` };
  if (!isWritablePath(rel)) return { ok: false, reason: `not a writable test path: ${rel}` };
  if (onlyThese && !onlyThese.includes(rel)) {
    return { ok: false, reason: `outside the current target (allowed: ${onlyThese.join(', ')}): ${rel}` };
  }
  if (!staysInsideRoot(root, join(root, rel))) return { ok: false, reason: `path resolves outside the repository: ${rel}` };
  return { ok: true, path: rel };
}

/**
 * Decide whether a read is allowed.
 * @param {string} root
 * @param {string} input
 */
export function checkRead(root, input) {
  const rel = toRepoRelative(root, input);
  if (!rel) return { ok: false, reason: `path escapes the repository: ${input}` };
  if (READ_DENIED.some((re) => re.test(rel))) return { ok: false, reason: `reading this path is not allowed: ${rel}` };
  return { ok: true, path: rel };
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

/**
 * Evaluate a PreToolUse event (Claude Code / Agent SDK hook payload).
 * `active` is the content of `.uta-runs/.active` or null when no run awaits an author.
 * @param {string} root
 * @param {{ tool_name?: string, tool_input?: Record<string, any> }} event
 * @param {{ allowedWrites: string[] } | null} active
 * @returns {{ decision: 'allow' | 'deny', reason?: string }}
 */
export function evaluateToolUse(root, event, active) {
  if (!active) return { decision: 'allow' };
  // Which tools exist is decided by the SDK session options (no Bash, no web). This hook
  // narrows file access; writes that bypass it (an external author's shell) are caught by G1.
  const tool = event.tool_name ?? '';
  const input = event.tool_input ?? {};
  if (WRITE_TOOLS.has(tool)) {
    const target = input.file_path ?? input.notebook_path;
    const check = checkWrite(root, target, active.allowedWrites);
    return check.ok ? { decision: 'allow' } : { decision: 'deny', reason: check.reason };
  }
  if (READ_TOOLS.has(tool)) {
    const target = input.file_path ?? input.path;
    if (!target) return { decision: 'allow' };
    const check = checkRead(root, target);
    return check.ok ? { decision: 'allow' } : { decision: 'deny', reason: check.reason };
  }
  return { decision: 'allow' };
}

/** Read the active-run marker, or null. */
export function readActiveMarker(root) {
  const file = join(root, '.uta-runs', '.active');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // A corrupt marker must not open the gate: treat it as a run with nothing writable.
    return { allowedWrites: [] };
  }
}
