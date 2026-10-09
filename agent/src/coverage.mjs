import { readFileSync } from 'node:fs';
import { toRepoRelative } from './guard.mjs';

/**
 * @typedef {{ executable: Set<number>, covered: Set<number> }} LineCoverage
 */

/**
 * Line coverage per file from an Istanbul `coverage-final.json`.
 * A line is executable if a statement starts on it, covered if any such statement ran.
 * The key set doubles as "files with unit-test surface", because the project's own
 * Vitest coverage include/exclude decides which files appear.
 * @param {string} root
 * @param {string} file
 * @returns {Map<string, LineCoverage>}
 */
export function loadLineCoverage(root, file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  /** @type {Map<string, LineCoverage>} */
  const out = new Map();
  for (const [absPath, data] of Object.entries(raw)) {
    const rel = toRepoRelative(root, absPath);
    if (!rel) continue;
    const executable = new Set();
    const covered = new Set();
    for (const [id, loc] of Object.entries(data.statementMap ?? {})) {
      const line = loc.start.line;
      executable.add(line);
      if ((data.s?.[id] ?? 0) > 0) covered.add(line);
    }
    out.set(rel, { executable, covered });
  }
  return out;
}

/** @param {LineCoverage} cov */
export function uncoveredLines(cov) {
  return [...cov.executable].filter((l) => !cov.covered.has(l)).sort((a, b) => a - b);
}

/** @param {LineCoverage} cov */
export function linePercent(cov) {
  return cov.executable.size ? (100 * cov.covered.size) / cov.executable.size : 100;
}

/** Compress sorted line numbers into "3-7, 10" form. */
export function formatRanges(lines) {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? `${start}` : `${start}-${sorted[i]}`);
  }
  return parts.join(', ');
}

/** Serialize a coverage map for state.json. */
export function serializeCoverage(map) {
  return Object.fromEntries([...map].map(([k, v]) => [k, { executable: [...v.executable], covered: [...v.covered] }]));
}

/** Inverse of serializeCoverage. */
export function deserializeCoverage(obj) {
  return new Map(Object.entries(obj ?? {}).map(([k, v]) => [k, { executable: new Set(v.executable), covered: new Set(v.covered) }]));
}
