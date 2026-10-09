import { runCommand } from './exec.mjs';
import { HarnessError } from './errors.mjs';

/**
 * @param {string} root
 * @param {string[]} args
 * @param {{ allowExit?: number[] }} [opts]
 */
export async function git(root, args, opts = {}) {
  const allowed = opts.allowExit ?? [0];
  const result = await runCommand('git', ['-c', 'core.quotepath=off', ...args], { cwd: root });
  if (!allowed.includes(result.exitCode)) {
    throw new HarnessError('git_failed', `git ${args.join(' ')}: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

/** Resolve a ref to a full commit SHA. */
export async function resolveCommit(root, ref) {
  return (await git(root, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
}

/**
 * Changed files between the merge base of `base` and `head`.
 * @returns {Promise<Array<{ status: string, path: string, from: string | null }>>}
 */
export async function changedFiles(root, base, head) {
  const out = await git(root, ['diff', '--name-status', '--find-renames', '--no-color', `${base}...${head}`]);
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = (parts[0] ?? 'M')[0];
    if (status === 'R' || status === 'C') files.push({ status, path: parts[2], from: parts[1] });
    else files.push({ status, path: parts[1], from: null });
  }
  return files;
}

/**
 * Parse `git diff -U0` output into added line numbers per new-side path.
 * @param {string} diffText
 * @returns {Map<string, number[]>}
 */
export function parseAddedLines(diffText) {
  /** @type {Map<string, number[]>} */
  const byPath = new Map();
  let current = null;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current && !byPath.has(current)) byPath.set(current, []);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const lines = byPath.get(current);
      for (let n = start; n < start + count; n++) lines.push(n);
    }
  }
  return byPath;
}

/** Added line numbers per path between merge base and head. */
export async function addedLines(root, base, head) {
  const out = await git(root, ['diff', '-U0', '--find-renames', '--no-color', '--no-ext-diff', `${base}...${head}`]);
  return parseAddedLines(out);
}

/**
 * Porcelain status, including untracked files.
 * @returns {Promise<Array<{ code: string, path: string }>>}
 */
export async function statusEntries(root, paths = []) {
  const out = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths]);
  const entries = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    if (!item) continue;
    const code = item.slice(0, 2);
    entries.push({ code, path: item.slice(3) });
    if (code[0] === 'R' || code[0] === 'C') i++; // skip rename source
  }
  return entries;
}

/** Author email of a commit. */
export async function commitAuthorEmail(root, ref) {
  return (await git(root, ['log', '-1', '--format=%ae', ref])).trim();
}

/**
 * Unified patch for a set of repo-relative paths (tracked edits and new untracked files).
 * @param {string} root
 * @param {string[]} paths
 */
export async function patchFor(root, paths) {
  const chunks = [];
  for (const path of paths) {
    const tracked = (await git(root, ['ls-files', '--', path])).trim() !== '';
    if (tracked) {
      chunks.push(await git(root, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', path]));
    } else {
      chunks.push(await git(root, ['diff', '--no-color', '--no-index', '--', '/dev/null', path], { allowExit: [0, 1] }));
    }
  }
  return chunks.filter(Boolean).join('');
}
