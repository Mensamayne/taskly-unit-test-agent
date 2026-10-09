#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isWritablePath } from './guard.mjs';
import { HarnessError } from './lib/errors.mjs';
import { runCommand } from './lib/exec.mjs';
import { COMMENT_MARKER } from './report.mjs';

/**
 * Privileged publisher. Runs in a job that holds a write token but never executes
 * repository code: it validates the patch produced by the author job, applies it with
 * `git apply`, pushes, and upserts the sticky PR comment.
 */

const BOT = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };

/**
 * Validate a unified patch: only additions or modifications of allowlisted test files,
 * no renames, deletions, mode changes, symlinks, or binary content.
 * @param {string} patch
 * @returns {string[]} the paths the patch touches
 */
export function validatePatch(patch) {
  if (!patch.trim()) return [];
  const paths = new Set();
  const problems = [];
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m || m[1] !== m[2]) problems.push(`unexpected diff header: ${line}`);
      else paths.add(m[2]);
    } else if (/^(deleted file mode|rename from|rename to|copy from|copy to|old mode|new mode|similarity index)/.test(line)) {
      problems.push(`not allowed in a test patch: ${line}`);
    } else if (/^new file mode /.test(line) && line !== 'new file mode 100644') {
      problems.push(`unexpected file mode: ${line}`);
    } else if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
      problems.push('binary content is not allowed');
    } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      const p = line.slice(4).replace(/^b\//, '');
      if (!paths.has(p)) problems.push(`file header without diff header: ${p}`);
    }
  }
  for (const p of paths) if (!isWritablePath(p)) problems.push(`path outside the test allowlist: ${p}`);
  if (problems.length) throw new HarnessError('patch_rejected', problems.join('; '));
  return [...paths];
}

async function gh(args, { input, token } = {}) {
  const auth = token ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  // Without a token in the environment, gh falls back to its own stored login (local use).
  const env = auth ? { ...process.env, GH_TOKEN: auth } : process.env;
  const res = await runCommand('gh', args, { input, env, timeoutMs: 60_000 });
  if (res.exitCode !== 0) throw new HarnessError('gh_failed', `gh ${args.slice(0, 3).join(' ')}: ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout;
}

/** Commit identity: the Actions bot in CI, the local git configuration when publishing by hand. */
let identity = BOT;

async function git(cwd, args) {
  const who = identity ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`] : [];
  const res = await runCommand('git', [...who, ...args], { cwd, timeoutMs: 60_000 });
  if (res.exitCode !== 0) throw new HarnessError('git_failed', `git ${args[0]}: ${res.stderr.trim() || res.stdout.trim()}`);
  return res.stdout.trim();
}

/** Login of the account the token belongs to; the sticky comment is the one it wrote. */
async function currentLogin() {
  if (identity === BOT) return BOT.name;
  return (await gh(['api', 'user', '--jq', '.login'])).trim();
}

/** Create or update the single agent comment on a PR. */
async function upsertComment(repo, pr, body) {
  const login = await currentLogin();
  const comments = JSON.parse(await gh(['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments`]));
  const mine = comments.flat().find((c) => c.user?.login === login && typeof c.body === 'string' && c.body.includes(COMMENT_MARKER));
  const payload = JSON.stringify({ body });
  if (mine) {
    await gh(['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${mine.id}`, '--input', '-'], { input: payload });
    return { action: 'updated', id: mine.id };
  }
  const created = JSON.parse(await gh(['api', '-X', 'POST', `repos/${repo}/issues/${pr}/comments`, '--input', '-'], { input: payload }));
  return { action: 'created', id: created.id };
}

function commitMessage(run, paths) {
  const subject = run.mode === 'bootstrap' ? 'test: add unit tests for low-coverage modules' : 'test: add unit tests for changed code';
  return `${subject}\n\nAccepted by the unit-test agent (run ${run.runId}).\n\n${paths.map((p) => `- ${p}`).join('\n')}\n`;
}

/**
 * @param {{ runDir: string | null, mode: 'commit' | 'comment', repo: string, pr: string | null,
 *           workspace: string, runUrl: string, baseBranch: string }} opts
 */
export async function publish({ runDir, mode, repo, pr, workspace, runUrl, baseBranch, local = false }) {
  identity = local ? null : BOT;
  if (!runDir || !existsSync(join(runDir, 'run.json'))) {
    const body = `${COMMENT_MARKER}\n### Unit test agent\n\nThe agent run did not produce a result. See the workflow run: ${runUrl}\n`;
    if (pr) await upsertComment(repo, pr, body);
    return { published: 'failure-notice' };
  }
  const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'));
  const report = readFileSync(join(runDir, 'report.md'), 'utf8');
  const patch = readFileSync(join(runDir, 'tests.patch'), 'utf8');
  const paths = validatePatch(patch);
  const verified = run.stage === 'done' && Object.values(run.final ?? {}).every((f) => f.status === 'pass' && f.newTypeErrors === 0);

  const patchLocation = runUrl ? `attached to the workflow run as \`tests.patch\` (${runUrl})` : 'kept in the run directory as `tests.patch`';
  let note;
  let commitSha = null;
  if (!paths.length) {
    note = 'No test changes to publish.';
  } else if (mode !== 'commit') {
    note = `Mode comment: the accepted tests are ${patchLocation}.`;
  } else if (!verified) {
    note = `Tests were not committed because the final verification did not pass. The patch is ${patchLocation}.`;
  } else {
    if (pr) {
      // The pulls API can lag a push of the same branch for a moment (local dogfood, fast CI).
      // Retry before treating a mismatch as "the PR moved".
      let head = (await gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha'])).trim();
      if (head !== run.head) {
        await new Promise((r) => setTimeout(r, 2000));
        head = (await gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha'])).trim();
      }
      if (head !== run.head) {
        note = `Tests were not committed: the pull request moved from ${run.head.slice(0, 7)} to ${head.slice(0, 7)} during the run. A new run is triggered by the push.`;
      }
    }
    if (!note) {
      const patchFile = resolve(runDir, 'tests.patch');
      await git(workspace, ['apply', '--check', patchFile]);
      await git(workspace, ['apply', patchFile]);
      await git(workspace, ['add', '--', ...paths]);
      await git(workspace, ['commit', '-q', '-m', commitMessage(run, paths)]);
      commitSha = await git(workspace, ['rev-parse', 'HEAD']);
      if (pr) {
        await git(workspace, ['push', 'origin', 'HEAD']);
        note = `Committed ${paths.length} test file(s) to this pull request in ${commitSha.slice(0, 7)}.`;
      } else {
        const branch = `test-agent/${run.runId}`;
        await git(workspace, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
        const url = (await gh(['pr', 'create', '--repo', repo, '--base', baseBranch, '--head', branch, '--title', 'test: raise unit test coverage (unit-test agent bootstrap)', '--body-file', '-'], { input: `${report}\nWorkflow run: ${runUrl}\n` })).trim();
        note = `Opened ${url}.`;
      }
      // The push uses GITHUB_TOKEN, which does not trigger CI on the new commit; record what the author job verified.
      await gh(['api', '-X', 'POST', `repos/${repo}/statuses/${commitSha}`, '--input', '-'], {
        input: JSON.stringify({
          state: 'success',
          context: 'unit-test-agent/verified',
          description: 'Typecheck and full suites passed on this tree in the agent run',
          ...(runUrl ? { target_url: runUrl } : {}),
        }),
      });
    }
  }

  if (pr) await upsertComment(repo, pr, `${report}\n**Publish**: ${note}\n\nWorkflow run: ${runUrl}\n`);
  return { published: true, paths, commitSha, note };
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, token, i, all) => (token.startsWith('--') ? [...acc, [token.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1] ?? 'true']] : acc), []),
  );
  const result = await publish({
    runDir: args.run && args.run !== 'true' ? resolve(args.run) : null,
    mode: args.mode === 'comment' ? 'comment' : 'commit',
    repo: args.repo ?? process.env.GITHUB_REPOSITORY,
    pr: args.pr && args.pr !== 'true' ? args.pr : null,
    workspace: resolve(args.workspace ?? '.'),
    runUrl: args['run-url'] ?? '',
    baseBranch: args.base ?? 'main',
    local: args.identity === 'local',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY && result.note) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**Publish**: ${result.note}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('publish.mjs')) {
  main().catch((err) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: err.code ?? 'internal', message: err.message } }, null, 2)}\n`);
    process.exitCode = 1;
  });
}
