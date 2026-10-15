// Continuing a repo job (see "Continuing a job" in README.md in this folder).
//
// The owner, 2026-10-15: an answer from the phone to a finished task must resume THAT run (same
// Claude session, same worktree), not start a new one that has lost the work and the context.
//
// The caller asks for a continuation with a marker as the FIRST line of the SIGNED body:
//   [[bridge-continue v1 of=<the earlier task's nonce>]]
// It is honoured only after the signature verified, and only to look up this machine's OWN record of
// that earlier job (worktree, branch, session id). Nothing of that comes from the web, so the trust
// boundary stays the signature. One continuation per task: claimContinuation() is an exclusive
// file create that is never pruned.
//
// Records and markers live in a durable folder (not %TEMP%, which Storage Sense may empty):
//   <nonce>.json        the job's record, rewritten atomically (unique temp name, then rename)
//   continued-<nonce>   that job was continued (claimed by its continuation, never deleted)
//   sweep-<nonce>       the parked-worktree sweeper is removing / removed that job's worktree
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Any nonce the signature accepts. Nonces are compared lowercase everywhere here (records, markers):
// the caller's casing must not decide whether a run can be found again.
const CONTINUE_RE = /^\[\[bridge-continue v1 of=([A-Za-z0-9-]{8,64})\]\]\r?\n/;
export const nonceKey = (nonce) => String(nonce).toLowerCase();
const BRANCH_RE = /^task\/studio-[A-Za-z0-9-]+$/;
const WORKTREE_NAME_RE = /^studio-[A-Za-z0-9-]+$/;
const NONCE_RE = /^[A-Za-z0-9-]{8,64}$/; // = the signature's nonce charset (signature.mjs)
export const FINAL_STATES = ['parked', 'removed', 'kept', 'expired'];
export const STATUSES = ['done', 'needs_input', 'needs_review', 'failed'];

// { of, body }: `of` is the earlier task's nonce (nonceKey) when the body STARTS with the marker
// line, else null and the body is returned untouched. A marker anywhere else is just text.
export function parseContinue(body) {
  const text = String(body);
  const m = CONTINUE_RE.exec(text);
  if (!m) return { of: null, body: text };
  return { of: nonceKey(m[1]), body: text.slice(m[0].length) };
}

// A path as a comparable key: absolute, one separator, no trailing slash, case-folded on Windows.
export function normPath(p) {
  const s = path.resolve(String(p)).replace(/[\\/]+/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

// Only a folder the bridge itself creates for a job: <repoDir>\.claude\worktrees\studio-…
export function isJobWorktreePath(p, repoDir) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  const resolved = path.resolve(p);
  return normPath(path.dirname(resolved)) === normPath(path.join(repoDir, '.claude', 'worktrees'))
    && WORKTREE_NAME_RE.test(path.basename(resolved));
}

export function validRecord(rec, nonce, { lane, repo, repoDir }) {
  if (!rec || typeof rec !== 'object' || rec.v !== 1) return false;
  if (rec.nonce !== nonce || rec.lane !== lane || rec.repo !== repo) return false;
  if (!isJobWorktreePath(rec.worktree, repoDir)) return false;
  if (typeof rec.branch !== 'string' || !BRANCH_RE.test(rec.branch)) return false;
  if (rec.sessionId !== null && !(typeof rec.sessionId === 'string' && UUID_RE.test(rec.sessionId))) return false;
  return true;
}

const recordFile = (dir, nonce) => path.join(dir, `${nonce}.json`);

export function readRawRecord(dir, nonce) {
  if (!NONCE_RE.test(String(nonce))) return null;
  try { return JSON.parse(fs.readFileSync(recordFile(dir, nonce), 'utf8')); } catch { return null; }
}

// The record of job `nonce`, or null unless it is well-formed and belongs to this lane and repo.
export function readRecord(dir, nonce, want) {
  const rec = readRawRecord(dir, nonce);
  return rec && validRecord(rec, nonce, want) ? rec : null;
}

// Atomic: a reader sees the old record or the new one, never half of one. The temp name is unique
// per writer, so two processes writing at once cannot interleave in one temp file.
export function writeRecord(dir, rec) {
  if (!NONCE_RE.test(String(rec?.nonce))) throw new Error(`bad nonce ${rec?.nonce}`);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${rec.nonce}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  try {
    fs.renameSync(tmp, recordFile(dir, rec.nonce));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

const marker = (dir, kind, nonce) => path.join(dir, `${kind}-${nonce}`);
export const isContinued = (dir, nonce) => fs.existsSync(marker(dir, 'continued', nonce));
export const sweepMarked = (dir, nonce) => fs.existsSync(marker(dir, 'sweep', nonce));

// Exclusive create: of two continuations of one task, on any number of pollers, exactly one gets
// it. Throws EEXIST for the other. Never pruned.
export function claimContinuation(dir, of, by) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(marker(dir, 'continued', of), JSON.stringify({ by, at: new Date().toISOString() }), { flag: 'wx' });
}

// The status the job ended with, read from its answer the way the caller reads it: a bare JSON
// object, a fenced ```json block, or a JSON object closing the text. Anything else is 'unknown'.
export function answerStatus(text) {
  const obj = lastJsonObject(text);
  if (!obj) return 'unknown';
  if (obj.timed_out === true) return 'timed_out';
  return STATUSES.includes(obj.status) ? obj.status : 'unknown';
}

function lastJsonObject(text) {
  const s = String(text ?? '').trim();
  const asObject = (raw) => {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch { return null; }
  };
  const whole = asObject(s);
  if (whole) return whole;
  const fences = [...s.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const v = asObject(fences[i][1].trim());
    if (v) return v;
  }
  // A JSON object that ends the text: try each '{' in the last 20k characters, earliest first.
  const tail = s.slice(-20000);
  for (let i = tail.indexOf('{'); i >= 0; i = tail.indexOf('{', i + 1)) {
    const v = asObject(tail.slice(i));
    if (v) return v;
  }
  return null;
}

// A finished job keeps its worktree (parked) unless it is done: a question, a failure or a stop is
// exactly what the owner will answer.
export const shouldPark = (status) => status !== 'done';

// Only a positively identified "this session does not exist" is retried with a new session. Any
// other failure may have happened after tools already acted, so it is reported, never re-run.
export const isNoSessionError = (e) => /No conversation found with session ID/i.test(String(e?.message ?? e));

// git with an argument array and no shell; never prompts (no stdin, GIT_TERMINAL_PROMPT=0); killed
// after timeoutMs. Resolves with trimmed stdout, rejects with stderr on a nonzero exit.
export function runGit(cwd, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(reject, new Error(`git ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => (code === 0 ? finish(resolve, out.trim()) : finish(reject, new Error(`git ${args[0]} exited ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

// `git worktree list --porcelain` → [{ worktree, head, branch, detached, prunable }]
export function parsePorcelain(text) {
  return String(text).split(/\r?\n\r?\n/).map((block) => {
    const st = {};
    for (const line of block.split(/\r?\n/)) {
      const sp = line.indexOf(' ');
      const key = sp < 0 ? line : line.slice(0, sp);
      const val = sp < 0 ? '' : line.slice(sp + 1);
      if (key === 'worktree') st.worktree = val;
      else if (key === 'HEAD') st.head = val;
      else if (key === 'branch') st.branch = val;
      else if (key === 'detached') st.detached = true;
      else if (key === 'prunable') st.prunable = true;
    }
    return st;
  }).filter((st) => st.worktree);
}

// Is this checkout really the recorded worktree on the recorded branch? Asked of git in it.
async function checkoutIs(dir, branch) {
  try {
    const top = await runGit(dir, ['rev-parse', '--show-toplevel'], 30000);
    const head = await runGit(dir, ['symbolic-ref', 'HEAD'], 30000);
    return normPath(top) === normPath(dir) && head === `refs/heads/${branch}`;
  } catch {
    return false;
  }
}

// Where a continuation works, decided from LIVE git state, never from the record's state alone:
//   same     the recorded worktree is registered, on the recorded branch, and git agrees from inside
//   readded  it is gone but its branch is not: re-created at the SAME path from that branch
//   fresh    anything else: a new worktree from addFresh(), and nothing that exists is touched
// Returns { dir, branch, how, why }.
export async function prepareWorktree(repoDir, rec, addFresh) {
  const want = normPath(rec.worktree);
  const ref = `refs/heads/${rec.branch}`;
  const fresh = async (why) => ({ ...(await addFresh()), how: 'fresh', why });
  let stanzas = parsePorcelain(await runGit(repoDir, ['worktree', 'list', '--porcelain'], 30000));
  let hit = stanzas.find((st) => normPath(st.worktree) === want);
  const exists = fs.existsSync(rec.worktree);
  if (hit && exists) {
    if (hit.branch !== ref) return fresh(`the worktree ${rec.worktree} is now on ${hit.branch || 'a detached HEAD'}, not ${rec.branch}`);
    if (!(await checkoutIs(rec.worktree, rec.branch))) return fresh(`git inside ${rec.worktree} does not confirm branch ${rec.branch}`);
    return { dir: rec.worktree, branch: rec.branch, how: 'same', why: '' };
  }
  if (exists) return fresh(`${rec.worktree} exists but is not a registered worktree`);
  if (hit) {
    // Registered but its folder is gone: drop the stale entry (prune touches only missing folders).
    try { await runGit(repoDir, ['worktree', 'prune'], 60000); } catch {}
    stanzas = parsePorcelain(await runGit(repoDir, ['worktree', 'list', '--porcelain'], 30000));
    hit = stanzas.find((st) => normPath(st.worktree) === want);
    if (hit) return fresh(`git still lists the missing worktree ${rec.worktree}`);
  }
  try {
    await runGit(repoDir, ['rev-parse', '--verify', '--quiet', ref], 30000);
  } catch {
    return fresh(`branch ${rec.branch} no longer exists`);
  }
  try {
    await runGit(repoDir, ['worktree', 'add', rec.worktree, rec.branch]);
  } catch (e) {
    return fresh(`could not re-create the worktree from ${rec.branch} (${e.message})`);
  }
  if (!(await checkoutIs(rec.worktree, rec.branch))) return fresh(`the re-created worktree ${rec.worktree} is not on ${rec.branch}`);
  return { dir: rec.worktree, branch: rec.branch, how: 'readded', why: '' };
}

// The name of a git operation already in progress in this checkout, or null.
export async function operationInProgress(dir) {
  for (const name of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const p = await runGit(dir, ['rev-parse', '--git-path', name], 30000);
    if (fs.existsSync(path.resolve(dir, p))) return name;
  }
  return null;
}

// The owner's rule: latest git before every action. Fetch the base (a failure throws: the job must
// not run on a stale base without knowing), then rebase the task branch onto it when that is safe.
// Returns { rebase: 'ok'|'skipped'|'failed', why }. Throws when a rebase the bridge started could not
// be aborted: Claude must not run in a half-rebased checkout.
export async function syncWorktree(dir, base) {
  await runGit(dir, ['fetch', 'origin', base, '--quiet']);
  const busy = await operationInProgress(dir);
  if (busy) return { rebase: 'skipped', why: `a git operation is already in progress (${busy})` };
  if (await runGit(dir, ['status', '--porcelain'], 60000)) return { rebase: 'skipped', why: 'uncommitted changes' };
  try {
    await runGit(dir, ['rebase', `origin/${base}`], 300000);
    return { rebase: 'ok', why: '' };
  } catch (e) {
    try {
      await runGit(dir, ['rebase', '--abort'], 120000);
    } catch (abortError) {
      // A rebase that failed before it started (a hook, a lock) leaves nothing to abort: fine.
      // Only a rebase that is still in progress after the abort stops the job.
      if (await operationInProgress(dir).catch(() => 'unknown')) {
        throw new Error(`rebase onto origin/${base} failed and could not be aborted (${abortError.message}); the worktree ${dir} needs a look`);
      }
    }
    return { rebase: 'failed', why: e.message };
  }
}

// Remove worktrees that stayed parked longer than parkDays, and prune old finished records.
// Cross-process safe against a continuation: each side writes its own marker before reading the
// other's, so at least one sees the other, and the sweeper always yields. Branches are never
// deleted, continued-* markers never pruned. Injected: resolveRepo(lane) → { repo, repoDir } of the
// lane as configured now, or null; isRunning(worktree) → this process is using it;
// removeWorktree(repoDir, dir) → true if removed (never forced).
export async function sweepParked({ dir, parkDays, resolveRepo, isRunning, removeWorktree, log = () => {}, now = Date.now(), keepDays = 30 }) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const full = path.join(dir, name);
    if (name.endsWith('.tmp')) {
      try { if (now - fs.statSync(full).mtimeMs > 86400000) fs.unlinkSync(full); } catch {}
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const nonce = name.slice(0, -5);
    const rec = readRawRecord(dir, nonce);
    if (!rec) continue;
    const finishedAt = Date.parse(rec.finishedAt || '') || 0;
    if (!finishedAt) continue; // running, or never finished: not ours to touch
    const age = now - finishedAt;
    const continued = isContinued(dir, nonce);
    if (rec.state === 'parked' && !continued && age > parkDays * 86400000) {
      const target = resolveRepo(rec.lane);
      if (!target || !validRecord(rec, nonce, { lane: rec.lane, repo: target.repo, repoDir: target.repoDir })) continue;
      try {
        fs.writeFileSync(marker(dir, 'sweep', nonce), String(now), { flag: 'wx' });
      } catch { continue; } // another sweeper has it
      // A continuation that claims after this check sees sweep-<nonce> and waits for the outcome.
      if (isRunning(rec.worktree) || isContinued(dir, nonce)) {
        try { fs.unlinkSync(marker(dir, 'sweep', nonce)); } catch {}
        continue;
      }
      const removed = !fs.existsSync(rec.worktree) || await removeWorktree(target.repoDir, rec.worktree);
      try {
        writeRecord(dir, { ...rec, state: removed ? 'expired' : 'kept', sweptAt: new Date(now).toISOString() });
      } catch (e) { log(`sweep: could not update the record of ${nonce} (${e.message})`); }
      log(`sweep: ${removed ? 'removed' : 'kept (git refused)'} the worktree of ${nonce}, parked ${Math.round(age / 86400000)} days`);
      continue;
    }
    const finished = ['removed', 'expired'].includes(rec.state) || (continued && rec.state !== 'running' && rec.state !== 'finishing');
    if (finished && age > keepDays * 86400000) {
      try { fs.unlinkSync(full); } catch {}
      try { fs.unlinkSync(marker(dir, 'sweep', nonce)); } catch {}
    }
  }
}
