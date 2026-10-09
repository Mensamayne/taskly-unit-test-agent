import { builtinModules } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

/**
 * Lightweight static checks on Vitest files. Regex based on purpose: the checks
 * must be fast, dependency-free, and conservative (false positives are acceptable,
 * a missed `.only` is not).
 */

const TITLE_RE = /\b(?:it|test|describe)(?:\.(?!each\b)\w+)*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const EACH_TITLE_RE = /\.each\s*(?:\([\s\S]*?\)|`[\s\S]*?`)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/** All test and describe titles in source order (deduplicated). */
export function extractTitles(source) {
  const titles = new Set();
  for (const re of [TITLE_RE, EACH_TITLE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) titles.add(m[2]);
  }
  return [...titles];
}

/** Focus, skip, todo, and expected-failure markers. */
export function findDisallowedMarkers(source) {
  const found = [];
  const patterns = [
    [/\b(?:it|test|describe)\.(only|skip|todo|fails|skipIf|runIf)\b/g, (m) => `.${m[1]}`],
    [/\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/g, (m) => m[0].replace(/\s*\($/, '')],
    [/@ts-(?:ignore|nocheck)\b/g, (m) => m[0]],
    [/\bas\s+any\b/g, () => 'as any'],
  ];
  for (const [re, label] of patterns) {
    let m;
    while ((m = re.exec(source))) found.push(label(m));
  }
  return [...new Set(found)];
}

/**
 * Sources of nondeterminism used without a stub. A test that depends on them can pass the
 * stability gate by luck, so they are rejected unless the file stubs them.
 */
export function unstubbedRandomness(source) {
  const found = [];
  if (/\bMath\.random\s*\(/.test(source) && !/vi\.spyOn\(\s*Math\s*,\s*['"]random['"]/.test(source)) found.push('Math.random()');
  if (/\brandomUUID\s*\(/.test(source) && !/vi\.(?:spyOn|mock|stubGlobal)\([^)]*(?:crypto|randomUUID)/.test(source)) found.push('randomUUID()');
  return found;
}

/**
 * Test blocks (text from one `it(`/`test(` to the next) that contain no assertion.
 * Returns the titles of offending blocks.
 */
export function blocksWithoutExpect(source) {
  const starts = [];
  const re = /\b(?:it|test)(?:\.(?!each\b)\w+)*(?:\.each\s*(?:\([\s\S]*?\)|`[\s\S]*?`))?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  let m;
  while ((m = re.exec(source))) starts.push({ index: m.index, bodyStart: m.index + m[0].length, title: m[2] });
  const offenders = [];
  for (let i = 0; i < starts.length; i++) {
    const body = source.slice(starts[i].bodyStart, starts[i + 1]?.index ?? source.length);
    if (!/\bexpect(?:\.\w+)?\s*\(|\bassert\b|\.rejects\b|\.resolves\b/.test(body)) offenders.push(starts[i].title);
  }
  return offenders;
}

/** Module specifiers from static imports, dynamic imports, vi.mock, and re-exports. */
export function importSpecifiers(source) {
  const specs = new Set();
  const res = [
    /\bimport\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bvi\.(?:mock|doMock|importActual|importMock)\s*\(\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[\w*{}\s,]+\s+from\s+['"]([^'"]+)['"]/g,
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(source))) specs.add(m[1]);
  }
  return [...specs];
}

const RELATIVE_EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx'];

/**
 * Specifiers that do not resolve: relative files that do not exist and bare packages
 * that are not installed in the package's node_modules.
 * @param {string} root repo root
 * @param {string} testPath repo-relative test file path
 * @param {string} source test file content
 */
export function unresolvedImports(root, testPath, source) {
  const side = testPath.split('/')[0];
  const bad = [];
  for (const spec of importSpecifiers(source)) {
    if (spec.startsWith('.')) {
      const base = posix.normalize(posix.join(posix.dirname(testPath), spec));
      const candidates = RELATIVE_EXTS.map((ext) => base + ext);
      if (/\.js$/.test(base)) candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'));
      if (!candidates.some((c) => existsSync(join(root, c)))) bad.push(spec);
      continue;
    }
    if (spec.startsWith('node:') || builtinModules.includes(spec)) continue;
    const parts = spec.split('/');
    const pkg = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (!existsSync(join(root, side, 'node_modules', pkg))) bad.push(spec);
  }
  return bad;
}

/**
 * Lines with assertions that existed before and are gone now (reported for human review).
 * @param {string | null} before
 * @param {string} after
 */
export function removedAssertionLines(before, after) {
  if (!before) return [];
  const afterLines = new Set(after.split(/\r?\n/).map((l) => l.trim()));
  return before
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /\bexpect\s*\(/.test(l) && !afterLines.has(l));
}

/** Directory of a repo-relative path (POSIX). */
export function dirOf(relPath) {
  return dirname(relPath).split('\\').join('/');
}
