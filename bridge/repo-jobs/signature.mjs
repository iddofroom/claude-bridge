// Signed repo-job prompts (see README.md in this folder).
//
// A repo job runs with full permissions on the bridge machine, so the hub's shared secret is not
// enough to start one: any holder of that secret could name the lane and its source. The caller
// signs the prompt with an Ed25519 PRIVATE key that only it holds (bakbukim: a Worker secret); the
// poller verifies it with the PUBLIC key committed next to this file (<lane>.pub.pem). There is no
// secret on the bridge machine, and neither the hub nor a leaked hub secret can sign.
//
// The prompt ends with one line:
//   [[bridge-signature v1 ts=<ISO time> nonce=<id> sig=<base64url>]]
// signed over "bridge-signature v1\n<lane>\n<ts>\n<nonce>\n<body>", where body is everything
// before "\n\n[[bridge-signature". The lane is inside the signature, so a prompt signed for one
// lane cannot be replayed into another.
import crypto from 'node:crypto';

export const SIG_MARK = '\n\n[[bridge-signature ';
const SIG_LINE_RE = /^\[\[bridge-signature v1 ts=(\S+) nonce=([A-Za-z0-9-]{8,64}) sig=([A-Za-z0-9_-]+)\]\]\s*$/;

export function signedMessage(lane, ts, nonce, body) {
  return `bridge-signature v1\n${lane}\n${ts}\n${nonce}\n${body}`;
}

// For tests and as the reference for callers: returns the full prompt with its signature line.
export function signPrompt(body, lane, privateKey, { ts = new Date().toISOString(), nonce }) {
  const sig = crypto.sign(null, Buffer.from(signedMessage(lane, ts, nonce, body), 'utf8'), privateKey).toString('base64url');
  return `${body}${SIG_MARK}v1 ts=${ts} nonce=${nonce} sig=${sig}]]`;
}

// { ok: true, body, nonce } with the prompt minus its signature line, or { ok: false, why }.
// Checks shape, freshness and the signature; the caller checks that the nonce has not run before.
export function checkSignature(prompt, lane, publicKeyPem, maxAgeMs, now = Date.now()) {
  const text = String(prompt);
  const at = text.lastIndexOf(SIG_MARK);
  if (at < 0) return { ok: false, why: 'unsigned prompt' };
  const body = text.slice(0, at);
  const m = SIG_LINE_RE.exec(text.slice(at + 2));
  if (!m) return { ok: false, why: 'malformed signature line' };
  const [, ts, nonce, sig] = m;
  const when = Date.parse(ts);
  if (!Number.isFinite(when) || Math.abs(now - when) > maxAgeMs) return { ok: false, why: `signature time out of range (${ts})` };
  let key;
  try {
    key = crypto.createPublicKey(publicKeyPem);
  } catch (e) {
    return { ok: false, why: `unusable public key (${e.message})` };
  }
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(signedMessage(lane, ts, nonce, body), 'utf8'), key, Buffer.from(sig, 'base64url'));
  } catch {
    valid = false;
  }
  return valid ? { ok: true, body, nonce } : { ok: false, why: 'bad signature' };
}
