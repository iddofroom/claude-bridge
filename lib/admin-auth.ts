import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export const ADMIN_COOKIE = "claude_admin";
const SESSION_DAYS = 7;

function getAdminToken(): string {
  const t = process.env.ADMIN_TOKEN;
  if (!t || t.length < 16) {
    throw new Error(
      "ADMIN_TOKEN env var is not set or too short (minimum 16 chars).",
    );
  }
  return t;
}

const enc = new TextEncoder();

async function hmacHex(value: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(value));
  const bytes = new Uint8Array(sig);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function buildSessionCookie(): Promise<{ value: string; maxAge: number }> {
  const token = getAdminToken();
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 60 * 60;
  const payload = `${expiresAt}`;
  const sig = await hmacHex(payload, token);
  return {
    value: `${payload}.${sig}`,
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}

export async function verifySessionCookie(cookie: string | undefined): Promise<boolean> {
  if (!cookie) return false;
  const dot = cookie.indexOf(".");
  if (dot < 1) return false;
  const payload = cookie.slice(0, dot);
  const provided = cookie.slice(dot + 1);
  let token: string;
  try {
    token = getAdminToken();
  } catch {
    return false;
  }
  const expected = await hmacHex(payload, token);
  if (!constantTimeEqual(provided, expected)) return false;
  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt)) return false;
  return Math.floor(Date.now() / 1000) < expiresAt;
}

export function verifyAdminToken(provided: string): boolean {
  let expected: string;
  try {
    expected = getAdminToken();
  } catch {
    return false;
  }
  return constantTimeEqual(provided, expected);
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export async function requireAdmin(): Promise<NextResponse | null> {
  const store = await cookies();
  const cookie = store.get(ADMIN_COOKIE)?.value;
  if (!(await verifySessionCookie(cookie))) {
    return unauthorized();
  }
  return null;
}
