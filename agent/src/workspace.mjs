import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { statusEntries } from './lib/git.mjs';

function hashFile(abs) {
  if (!existsSync(abs)) return 'missing';
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

/**
 * Hashes of every dirty or untracked path, taken when a target is handed to an author.
 * Gate G1 compares against it to find every file the author touched, whoever the author is.
 * @param {string} root
 */
export async function takeSnapshot(root) {
  /** @type {Record<string, string>} */
  const dirty = {};
  for (const entry of await statusEntries(root)) {
    if (entry.path.startsWith('.uta-runs/')) continue;
    dirty[entry.path] = hashFile(join(root, entry.path));
  }
  return { dirty };
}

/**
 * Paths whose content differs from the snapshot (new edits, new files, reverts, deletions).
 * @param {string} root
 * @param {{ dirty: Record<string, string> }} snapshot
 */
export async function changedSince(root, snapshot) {
  const changed = new Set();
  const now = await statusEntries(root);
  const nowPaths = new Set();
  for (const entry of now) {
    if (entry.path.startsWith('.uta-runs/')) continue;
    nowPaths.add(entry.path);
    if (snapshot.dirty[entry.path] !== hashFile(join(root, entry.path))) changed.add(entry.path);
  }
  for (const [path, hash] of Object.entries(snapshot.dirty)) {
    if (!nowPaths.has(path) && hashFile(join(root, path)) !== hash) changed.add(path);
  }
  return [...changed].sort();
}

/** Current content of a repo-relative file, or null if it does not exist. */
export function readOptional(root, relPath) {
  const abs = join(root, relPath);
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
}

/** Put a file back to its recorded content (null means it did not exist). */
export function restoreFile(root, relPath, content) {
  const abs = join(root, relPath);
  if (content === null) {
    rmSync(abs, { force: true });
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}
