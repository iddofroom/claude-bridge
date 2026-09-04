/**
 * claude-bridge — local bridge process.
 *
 * Runs on the same machine as `claude` (Claude Code CLI). Replaces a polling
 * loop with on-demand pushes from the deployed web app:
 *
 *   1. Web app inserts a queued row in claude_outbox and POSTs to
 *      {tunnel-url}/inject (this server, exposed via Cloudflare Tunnel /
 *      ngrok / Tailscale).
 *   2. Best-effort `git pull --ff-only` in the matching workspace dir (see
 *      syncWorkspace) — otherwise this checkout is only ever as fresh as the
 *      last manual pull, so Claude could draft/triage against stale code and
 *      re-suggest work that's already shipped (or already rejected) on the
 *      real dev machine. Skipped for non-git workspaces; a failed/diverged
 *      pull just logs a warning and falls through to whatever's on disk —
 *      never blocks the prompt. Disable with BRIDGE_GIT_SYNC=false.
 *   3. We spawn `claude --print --output-format json` in that workspace dir.
 *      If the request carries parent_session_id, we add `--resume <id>` so
 *      the conversation continues with memory.
 *   4. POST the response to {WEB_APP_URL}/api/webhooks/bridge — the JSON
 *      output gives us both the response text and the new session_id, which
 *      the web app stores so the next prompt on this thread can resume.
 *   5. PATCH the outbox row to 'sent' (or 'failed') so the UI knows.
 *
 * On startup we run a one-shot catchup against the queued outbox so any rows
 * inserted while the bridge was offline still get handled.
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import 'dotenv/config';

const PORT = parseInt(process.env.BRIDGE_PORT || '7777', 10);
const PUSH_SECRET = process.env.BRIDGE_SECRET;
const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || 'claude';
const PROJECT_DIRS = (process.env.PROJECT_DIRS || process.cwd())
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const WEB_APP_URL = process.env.WEB_APP_URL;
const CATCHUP_ON_STARTUP = process.env.BRIDGE_CATCHUP !== 'false';
const GIT_SYNC = process.env.BRIDGE_GIT_SYNC !== 'false';

if (!PUSH_SECRET) {
  console.error('BRIDGE_SECRET not set — refusing to start.');
  process.exit(1);
}
if (!WEB_APP_URL) {
  console.error('WEB_APP_URL not set — refusing to start.');
  process.exit(1);
}

function findProjectDir(workspace) {
  if (!workspace) {
    console.warn('[bridge] empty workspace, using first project dir');
    return PROJECT_DIRS[0];
  }
  for (const base of PROJECT_DIRS) {
    const candidate = path.join(base, workspace);
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
  }
  const target = path.join(PROJECT_DIRS[0], workspace);
  fs.mkdirSync(target, { recursive: true });
  console.log(`[bridge] created workspace dir: ${target}`);
  return target;
}

function isGitRepo(cwd) {
  try {
    fs.statSync(path.join(cwd, '.git'));
    return true;
  } catch {
    return false;
  }
}

// Best-effort `git pull --ff-only` in the workspace before every prompt, so
// Claude never analyzes/drafts against a checkout that's silently gone stale
// (this machine has no other sync mechanism — the workspace dir is otherwise
// only as fresh as the last time someone manually pulled it). Fast-forward
// only: never rewrites history or discards local state, so a workspace with
// diverged/uncommitted changes just logs a warning and runs against whatever
// is on disk rather than blocking or corrupting anything. Non-git workspaces
// (no .git) are skipped silently — not every workspace is a repo.
function syncWorkspace(cwd) {
  return new Promise((resolve) => {
    if (!GIT_SYNC || !isGitRepo(cwd)) {
      resolve({ ok: true, skipped: true });
      return;
    }
    const child = spawn('git', ['pull', '--ff-only'], { cwd, shell: true });
    let err = '';
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
    child.on('close', (code) => {
      if (code !== 0) resolve({ ok: false, error: err.trim().slice(0, 300) });
      else resolve({ ok: true });
    });
  });
}

function runClaude(cwd, prompt, parentSessionId, permissionMode) {
  return new Promise((resolve, reject) => {
    const args = ['--print', '--output-format', 'json'];
    if (permissionMode === 'read_only') {
      // Untrusted-input sessions (CS drafts / manager triage): plan-mode + no
      // write/shell/web tools — the model only reads context and returns JSON, so
      // a prompt-injection in the untrusted text cannot take any action. Trusted
      // human-triggered sessions (execute / Sentry) send no permission_mode ⇒
      // unrestricted, unchanged.
      args.push(
        '--permission-mode', 'plan',
        '--disallowedTools', 'Write,Edit,NotebookEdit,Bash,WebFetch,WebSearch',
      );
    }
    if (parentSessionId) args.push('--resume', parentSessionId);
    const child = spawn(CLAUDE_BIN, args, { cwd, shell: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${err.trim()}`));
        return;
      }
      const trimmed = out.trim();
      try {
        const parsed = JSON.parse(trimmed);
        const text = typeof parsed.result === 'string' ? parsed.result : trimmed;
        const sessionId =
          typeof parsed.session_id === 'string' ? parsed.session_id : null;
        resolve({ text, sessionId });
      } catch {
        // Fallback: plain-text output. No session id captured this turn.
        resolve({ text: trimmed, sessionId: null });
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function postInbox(workspace, response, sessionId, conversationId) {
  const url = new URL('/api/webhooks/bridge', WEB_APP_URL);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-secret': PUSH_SECRET },
    body: JSON.stringify({
      workspace,
      response,
      claude_session_id: sessionId ?? null,
      conversation_id: conversationId ?? null,
    }),
  });
  if (!res.ok) console.warn('[bridge] inbox post failed:', res.status, await res.text());
}

async function patchOutbox(id, status, error) {
  const url = new URL('/api/webhooks/bridge', WEB_APP_URL);
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-bridge-secret': PUSH_SECRET },
    body: JSON.stringify({ id, status, error: error ?? null }),
  });
  if (!res.ok) console.warn('[bridge] outbox patch failed:', res.status, await res.text());
}

async function processItem({
  id: outboxId,
  workspace,
  prompt,
  conversation_id,
  parent_session_id,
  permission_mode,
}) {
  const resumeNote = parent_session_id ? ` (resume ${parent_session_id.slice(0, 8)}…)` : '';
  const modeNote = permission_mode === 'read_only' ? ' [read-only]' : '';
  console.log(`[bridge] inject → ${workspace}${resumeNote}${modeNote} (${prompt.slice(0, 60).replace(/\s+/g, ' ')}…)`);
  const cwd = findProjectDir(workspace);
  const sync = await syncWorkspace(cwd);
  if (!sync.ok) {
    console.warn(`[bridge] git pull failed in ${workspace} (${cwd}) — continuing with existing checkout: ${sync.error}`);
  } else if (!sync.skipped) {
    console.log(`[bridge] synced → ${workspace}`);
  }
  try {
    const { text, sessionId } = await runClaude(cwd, prompt, parent_session_id, permission_mode);
    await postInbox(workspace, text, sessionId, conversation_id);
    if (outboxId) await patchOutbox(outboxId, 'sent');
    console.log(`[bridge] done → ${workspace}${sessionId ? ` (session ${sessionId.slice(0, 8)}…)` : ''}`);
  } catch (err) {
    console.error(`[bridge] failed → ${workspace}: ${err.message}`);
    if (outboxId) await patchOutbox(outboxId, 'failed', err.message);
  }
}

async function catchup() {
  try {
    const url = new URL('/api/webhooks/bridge?status=queued', WEB_APP_URL);
    const res = await fetch(url, { headers: { 'x-bridge-secret': PUSH_SECRET } });
    if (!res.ok) {
      console.warn('[bridge] catchup fetch failed:', res.status);
      return;
    }
    const data = await res.json();
    const items = data.items ?? [];
    if (items.length === 0) {
      console.log('[bridge] catchup: no queued items.');
      return;
    }
    console.log(`[bridge] catchup: ${items.length} queued items.`);
    for (const item of items) await processItem(item);
  } catch (err) {
    console.warn('[bridge] catchup error:', err.message);
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/inject') {
    res.writeHead(404).end();
    return;
  }
  if (req.headers['x-bridge-secret'] !== PUSH_SECRET) {
    res.writeHead(401).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400).end(JSON.stringify({ error: 'invalid json' }));
      return;
    }
    if (!payload.workspace || !payload.prompt) {
      res.writeHead(400).end(JSON.stringify({ error: 'workspace and prompt required' }));
      return;
    }
    // Reply 202 immediately and process in the background
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ accepted: true }));
    processItem(payload);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[bridge] listening on http://localhost:${PORT}`);
  console.log(`[bridge] dashboard: ${WEB_APP_URL}`);
  console.log(`[bridge] project dirs: ${PROJECT_DIRS.join(', ')}`);
  if (CATCHUP_ON_STARTUP) catchup();
});
