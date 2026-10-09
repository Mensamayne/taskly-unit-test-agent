import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { git, statusEntries } from './lib/git.mjs';

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

/**
 * Changes outside `allowed` made by running tests (a test that writes to production files,
 * deletes fixtures, or leaves files behind). Files that were clean when the snapshot was taken
 * are put back from git; new untracked files are removed. Files that were already dirty at the
 * snapshot cannot be restored and are reported as such.
 * @param {string} root
 * @param {{ dirty: Record<string, string> }} snapshot
 * @param {string[]} allowed repo-relative paths the run may change
 */
export async function revertSideEffects(root, snapshot, allowed) {
  const changed = (await changedSince(root, snapshot)).filter((p) => !allowed.includes(p));
  const restored = [];
  const unrestorable = [];
  for (const path of changed) {
    if (path in snapshot.dirty) {
      unrestorable.push(path);
      continue;
    }
    const tracked = (await git(root, ['ls-files', '--', path])).trim() !== '';
    if (tracked) await git(root, ['checkout', '--', path]);
    else rmSync(join(root, path), { force: true });
    restored.push(path);
  }
  return { changed, restored, unrestorable };
}

/** Content hash of a repo-relative file ('missing' if absent). */
export function fileHash(root, relPath) {
  return hashFile(join(root, relPath));
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
