// node --test bridge/repo-jobs/
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  answerStatus, claimContinuation, isContinued, isJobWorktreePath, isNoSessionError, operationInProgress,
  parseContinue, parsePorcelain, prepareWorktree, readRecord, runGit, shouldPark, sweepMarked, sweepParked,
  syncWorktree, writeRecord,
} from './continuation.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cont-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {} });
const OF = '3f2a9c1e-0b7d-4e55-9a10-6c2b8d4e7f01';
const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';

test('parseContinue: only a well-formed marker on the very first line', () => {
  assert.deepEqual(parseContinue(`[[bridge-continue v1 of=${OF}]]\nהמשך`), { of: OF, body: 'המשך' });
  assert.equal(parseContinue(`[[bridge-continue v1 of=${OF.toUpperCase()}]]\r\nx`).of, OF);
  assert.equal(parseContinue(`שלום\n[[bridge-continue v1 of=${OF}]]\nx`).of, null);
  assert.equal(parseContinue(` [[bridge-continue v1 of=${OF}]]\nx`).of, null);
  assert.equal(parseContinue('[[bridge-continue v1 of=01HZX3K9QW7E5R2T8Y6U4I0OPA]]\nx').of, '01hzx3k9qw7e5r2t8y6u4i0opa'); // any signature nonce
  assert.equal(parseContinue('[[bridge-continue v1 of=short]]\nx').of, null);
  assert.equal(parseContinue('[[bridge-continue v1 of=../../etc]]\nx').of, null);
  assert.equal(parseContinue(`[[bridge-continue v2 of=${OF}]]\nx`).of, null);
  assert.equal(parseContinue(`[[bridge-continue v1 of=${OF}]]`).of, null); // no body line
  const plain = 'אתה Claude Code\nמשימה';
  assert.deepEqual(parseContinue(plain), { of: null, body: plain });
});

test('records: round trip, and refused unless lane, repo, path, branch and session check out', () => {
  const dir = path.join(tmp, 'records');
  const repoDir = path.join(tmp, 'somerepo');
  const want = { lane: 'bakbukim-tasks', repo: 'bakbukim', repoDir };
  const good = {
    v: 1, lane: 'bakbukim-tasks', repo: 'bakbukim', nonce: OF,
    worktree: path.join(repoDir, '.claude', 'worktrees', 'studio-2026-10-15-abcd1234'),
    branch: 'task/studio-2026-10-15-abcd1234', sessionId: SESSION, state: 'parked',
  };
  writeRecord(dir, good);
  assert.deepEqual(readRecord(dir, OF, want), good);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')).length, 0);
  const bad = [
    { lane: 'other' }, { repo: 'other' }, { nonce: 'deadbeef-0000-4000-8000-000000000000' }, { v: 2 },
    { worktree: path.join(repoDir, '.claude', 'worktrees', 'studio-x', '..', '..', '..', 'evil') },
    { worktree: path.join(repoDir, '.claude', 'worktrees', 'mine') },
    { worktree: path.join(tmp, 'elsewhere', '.claude', 'worktrees', 'studio-x') },
    { worktree: 'studio-x' },
    { branch: 'dev' }, { branch: 'task/studio-x; rm -rf /' }, { sessionId: 'abc' }, { sessionId: 7 },
  ];
  for (const change of bad) {
    writeRecord(dir, { ...good, ...change, nonce: OF });
    if (change.nonce) {
      fs.writeFileSync(path.join(dir, `${OF}.json`), JSON.stringify({ ...good, ...change }));
    }
    assert.equal(readRecord(dir, OF, want), null, JSON.stringify(change));
  }
  writeRecord(dir, { ...good, sessionId: null });
  assert.equal(readRecord(dir, OF, want).sessionId, null);
  assert.equal(readRecord(dir, '../x', want), null);
  assert.equal(isJobWorktreePath(good.worktree, repoDir), true);
});

test('claimContinuation: exactly one claim per task, with or without a record', () => {
  const dir = path.join(tmp, 'claims');
  const of = crypto.randomUUID();
  claimContinuation(dir, of, 'first');
  assert.equal(isContinued(dir, of), true);
  assert.throws(() => claimContinuation(dir, of, 'second'), (e) => e.code === 'EEXIST');
});

test('answerStatus and shouldPark', () => {
  assert.equal(answerStatus('{"status":"done","summary":"x"}'), 'done');
  assert.equal(answerStatus('סיימתי.\n```json\n{"status":"needs_input","summary":"x","question":"?"}\n```'), 'needs_input');
  assert.equal(answerStatus('הנה הדוח: {"status":"needs_review","summary":"a {b}"}'), 'needs_review');
  assert.equal(answerStatus(JSON.stringify({ timed_out: true, minutes: 240, stopped: 'hung', report: '' })), 'timed_out');
  assert.equal(answerStatus('{"status":"failed","summary":"x"}'), 'failed');
  assert.equal(answerStatus('{"status":"weird"}'), 'unknown');
  assert.equal(answerStatus('no json here'), 'unknown');
  assert.equal(answerStatus(''), 'unknown');
  assert.equal(shouldPark('done'), false);
  for (const s of ['needs_input', 'needs_review', 'failed', 'timed_out', 'unknown']) assert.equal(shouldPark(s), true);
});

test('only a positive "no such session" is retried', () => {
  assert.equal(isNoSessionError(new Error(`claude exited 1: No conversation found with session ID: ${SESSION}`)), true);
  assert.equal(isNoSessionError(new Error('claude exited 1: API Error 529 overloaded')), false);
  assert.equal(isNoSessionError(new Error('claude exited 137: ')), false);
});

test('parsePorcelain', () => {
  const text = 'worktree C:/r\nHEAD 1111\nbranch refs/heads/dev\n\nworktree C:/r/.claude/worktrees/studio-a\nHEAD 2222\nbranch refs/heads/task/studio-a\n\nworktree C:/r/.claude/worktrees/studio-b\nHEAD 3333\ndetached\nprunable gitdir file points to non-existent location\n';
  const st = parsePorcelain(text);
  assert.equal(st.length, 3);
  assert.equal(st[1].branch, 'refs/heads/task/studio-a');
  assert.equal(st[2].detached, true);
  assert.equal(st[2].prunable, true);
});

// ── the sweep and its protocol with a continuation ────────────────────────────
function sweepFixture(name, fields = {}) {
  const dir = path.join(tmp, name);
  const repoDir = path.join(tmp, `${name}-repo`);
  const nonce = crypto.randomUUID();
  const worktree = path.join(repoDir, '.claude', 'worktrees', 'studio-2026-10-01-aaaa0000');
  fs.mkdirSync(worktree, { recursive: true });
  const rec = {
    v: 1, lane: 'bakbukim-tasks', repo: 'bakbukim', nonce, worktree, branch: 'task/studio-2026-10-01-aaaa0000',
    sessionId: SESSION, state: 'parked', finishedAt: new Date(Date.now() - 10 * 86400000).toISOString(), ...fields,
  };
  writeRecord(dir, rec);
  const removed = [];
  const opts = {
    dir, parkDays: 7,
    resolveRepo: (lane) => (lane === 'bakbukim-tasks' ? { repo: 'bakbukim', repoDir } : null),
    isRunning: () => false,
    removeWorktree: async (_repo, wt) => { removed.push(wt); return true; },
  };
  return { dir, nonce, rec, removed, opts };
}
const readJson = (dir, nonce) => JSON.parse(fs.readFileSync(path.join(dir, `${nonce}.json`), 'utf8'));

test('sweep: an old parked worktree is removed, a recent one is kept', async () => {
  const old = sweepFixture('sweep-old');
  await sweepParked(old.opts);
  assert.deepEqual(old.removed, [old.rec.worktree]);
  assert.equal(readJson(old.dir, old.nonce).state, 'expired');
  const recent = sweepFixture('sweep-recent', { finishedAt: new Date().toISOString() });
  await sweepParked(recent.opts);
  assert.deepEqual(recent.removed, []);
  assert.equal(readJson(recent.dir, recent.nonce).state, 'parked');
});

test('sweep yields to a continuation that claimed first', async () => {
  const f = sweepFixture('sweep-claimed');
  claimContinuation(f.dir, f.nonce, 'next');
  await sweepParked(f.opts);
  assert.deepEqual(f.removed, []);
  assert.equal(fs.existsSync(path.join(f.dir, `sweep-${f.nonce}`)), false);
});

test('sweep yields when the continuation claims between its marker and its check', async () => {
  const f = sweepFixture('sweep-race');
  // The continuation claims right after the sweeper wrote sweep-<nonce>: simulated by claiming
  // inside isRunning, which the sweeper calls after its own marker and before removing.
  f.opts.isRunning = () => { try { claimContinuation(f.dir, f.nonce, 'next'); } catch {} return false; };
  await sweepParked(f.opts);
  assert.deepEqual(f.removed, []);
  assert.equal(fs.existsSync(path.join(f.dir, `sweep-${f.nonce}`)), false);
});

test('a continuation claiming after the sweeper checked sees its marker and gets the outcome', async () => {
  const f = sweepFixture('sweep-late');
  let sawMarker = null;
  const remove = f.opts.removeWorktree;
  f.opts.removeWorktree = async (repoDir, wt) => {
    claimContinuation(f.dir, f.nonce, 'next');
    sawMarker = sweepMarked(f.dir, f.nonce); // what the continuation checks right after its claim
    return remove(repoDir, wt);
  };
  await sweepParked(f.opts);
  assert.equal(sawMarker, true);
  assert.equal(readJson(f.dir, f.nonce).state, 'expired'); // the continuation waits for this, then re-adds from the branch
});

test('sweep: a worktree in use, a running job, or an unknown lane is never touched', async () => {
  const busy = sweepFixture('sweep-busy');
  busy.opts.isRunning = () => true;
  await sweepParked(busy.opts);
  assert.deepEqual(busy.removed, []);
  const running = sweepFixture('sweep-running', { state: 'running', finishedAt: null });
  await sweepParked(running.opts);
  assert.deepEqual(running.removed, []);
  const lane = sweepFixture('sweep-lane', { lane: 'pingo-build' });
  await sweepParked(lane.opts);
  assert.deepEqual(lane.removed, []);
});

test('prune: old finished records go, continued-* markers never do', async () => {
  const f = sweepFixture('sweep-prune', { state: 'removed', finishedAt: new Date(Date.now() - 40 * 86400000).toISOString() });
  claimContinuation(f.dir, f.nonce, 'next');
  await sweepParked(f.opts);
  assert.equal(fs.existsSync(path.join(f.dir, `${f.nonce}.json`)), false);
  assert.equal(isContinued(f.dir, f.nonce), true);
});

// ── git: a real repo with a bare origin ───────────────────────────────────────
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
});
const g = (cwd, ...args) => runGit(cwd, args);
const origin = path.join(tmp, 'origin.git');
const repo = path.join(tmp, 'repo');
const name = 'studio-2026-10-15-aaaa1111';
const wt = path.join(repo, '.claude', 'worktrees', name);
const branch = `task/${name}`;
const rec = { v: 1, lane: 'bakbukim-tasks', repo: 'repo', nonce: OF, worktree: wt, branch, sessionId: SESSION };
let freshCalls = 0;
const addFresh = async () => {
  freshCalls += 1;
  const n = `studio-2026-10-15-fresh${freshCalls}`;
  const d = path.join(repo, '.claude', 'worktrees', n);
  await g(repo, 'worktree', 'add', '--no-track', '-b', `task/${n}`, d, 'origin/dev');
  return { dir: d, branch: `task/${n}` };
};
const commit = async (cwd, file, text, msg) => {
  fs.writeFileSync(path.join(cwd, file), text);
  await g(cwd, 'add', file);
  await g(cwd, 'commit', '-q', '-m', msg);
};
const pushDev = async (file, text) => {
  await g(repo, 'checkout', '-q', 'dev');
  await commit(repo, file, text, `dev: ${file}`);
  await g(repo, 'push', '-q', 'origin', 'dev');
};

test('git setup: origin, repo and a --no-track job worktree with a commit', async () => {
  await g(tmp, 'init', '-q', '--bare', origin);
  await g(origin, 'symbolic-ref', 'HEAD', 'refs/heads/dev');
  fs.mkdirSync(repo);
  await g(repo, 'init', '-q');
  await g(repo, 'checkout', '-q', '-b', 'dev');
  await g(repo, 'remote', 'add', 'origin', origin);
  await commit(repo, 'a.txt', 'one\n', 'first');
  await g(repo, 'push', '-q', 'origin', 'dev');
  await g(repo, 'fetch', '-q', 'origin', 'dev');
  await g(repo, 'worktree', 'add', '--no-track', '-b', branch, wt, 'origin/dev');
  await commit(wt, 'b.txt', 'work\n', 'job work');
});

test('prepareWorktree: the registered worktree on its branch is reused', async () => {
  const w = await prepareWorktree(repo, rec, addFresh);
  assert.equal(w.how, 'same');
  assert.equal(w.dir, wt);
  assert.equal(freshCalls, 0);
});

test('syncWorktree: fetch + rebase onto the newer base', async () => {
  await pushDev('c.txt', 'newer\n');
  const s = await syncWorktree(wt, 'dev');
  assert.deepEqual(s, { rebase: 'ok', why: '' });
  assert.equal(fs.existsSync(path.join(wt, 'c.txt')), true);
  assert.equal(fs.existsSync(path.join(wt, 'b.txt')), true);
});

test('syncWorktree: uncommitted changes are not rebased', async () => {
  await pushDev('d.txt', 'more\n');
  fs.writeFileSync(path.join(wt, 'scratch.txt'), 'x');
  const s = await syncWorktree(wt, 'dev');
  assert.equal(s.rebase, 'skipped');
  assert.match(s.why, /uncommitted/);
  fs.unlinkSync(path.join(wt, 'scratch.txt'));
});

test('syncWorktree: a conflicting rebase is aborted and the branch is left as it was', async () => {
  await commit(wt, 'a.txt', 'job version\n', 'job edits a');
  const before = await g(wt, 'rev-parse', 'HEAD');
  await pushDev('a.txt', 'dev version\n');
  const s = await syncWorktree(wt, 'dev');
  assert.equal(s.rebase, 'failed');
  assert.equal(await operationInProgress(wt), null);
  assert.equal(await g(wt, 'rev-parse', 'HEAD'), before);
});

test('syncWorktree: a rebase refused before it starts (a hook) is a note, not a stopped job', async () => {
  await pushDev('e.txt', 'hooked\n');
  const hooks = path.join(tmp, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'pre-rebase'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await g(repo, 'config', 'core.hooksPath', hooks);
  try {
    const s = await syncWorktree(wt, 'dev');
    assert.equal(s.rebase, 'failed');
    assert.equal(await operationInProgress(wt), null);
  } finally {
    await g(repo, 'config', '--unset', 'core.hooksPath');
  }
});

test('an operation already in progress is detected and never aborted by the bridge', async () => {
  await assert.rejects(g(wt, 'rebase', 'origin/dev'));
  assert.match(await operationInProgress(wt), /^rebase-(merge|apply)$/);
  const s = await syncWorktree(wt, 'dev');
  assert.equal(s.rebase, 'skipped');
  assert.match(s.why, /in progress/);
  assert.match(await operationInProgress(wt), /^rebase-(merge|apply)$/); // still there: not ours to abort
  await g(wt, 'rebase', '--abort');
  // Settle the conflict for the tests below: drop the job's conflicting commit.
  await g(wt, 'reset', '-q', '--hard', 'HEAD~1');
  assert.equal((await syncWorktree(wt, 'dev')).rebase, 'ok');
});

test('prepareWorktree: a removed worktree is re-created at the same path from its branch', async () => {
  await g(repo, 'worktree', 'remove', wt);
  const w = await prepareWorktree(repo, rec, addFresh);
  assert.equal(w.how, 'readded');
  assert.equal(w.dir, wt);
  assert.equal(fs.existsSync(path.join(wt, 'b.txt')), true); // committed work is back
  assert.equal(freshCalls, 0);
});

test('prepareWorktree: a worktree switched to another branch is not reused', async () => {
  await g(wt, 'checkout', '-q', '-b', 'task/studio-other');
  const w = await prepareWorktree(repo, rec, addFresh);
  assert.equal(w.how, 'fresh');
  assert.match(w.why, /not task\/studio-2026-10-15-aaaa1111/);
  assert.equal(freshCalls, 1);
  await g(wt, 'checkout', '-q', branch);
});

test('prepareWorktree: an unregistered folder at the path is left untouched', async () => {
  await g(repo, 'worktree', 'remove', wt);
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, 'keep.txt'), 'mine');
  const w = await prepareWorktree(repo, rec, addFresh);
  assert.equal(w.how, 'fresh');
  assert.equal(fs.readFileSync(path.join(wt, 'keep.txt'), 'utf8'), 'mine');
  fs.rmSync(wt, { recursive: true, force: true });
});

test('prepareWorktree: a branch checked out elsewhere falls back to a fresh worktree', async () => {
  const other = path.join(repo, '.claude', 'worktrees', 'studio-holder');
  await g(repo, 'worktree', 'add', other, branch);
  const w = await prepareWorktree(repo, rec, addFresh);
  assert.equal(w.how, 'fresh');
  assert.match(w.why, /could not re-create/);
  assert.equal(fs.existsSync(path.join(wt, 'b.txt')), false);
  await g(repo, 'worktree', 'remove', other);
});

test('prepareWorktree: a deleted branch falls back to a fresh worktree', async () => {
  await g(repo, 'branch', '-D', branch);
  const w = await prepareWorktree(repo, rec, addFresh);
  assert.equal(w.how, 'fresh');
  assert.match(w.why, /no longer exists/);
});
