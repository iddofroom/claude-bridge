/**
 * Fire-and-forget callback to an external tool that asked to be notified when
 * Claude's response arrives, instead of polling /api/external/messages.
 * Receiver authenticates by checking that x-external-secret matches their copy
 * of EXTERNAL_API_SECRET. Failures are swallowed: the inbox row is persisted,
 * so a missed callback degrades to "the receiver can poll and still see it."
 */
export async function fireExternalCallback(
  callbackUrl: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const secret = process.env.EXTERNAL_API_SECRET;
  if (!secret) return;

  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-external-secret": secret,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Best-effort. Inbox row is the source of truth.
  } finally {
    clearTimeout(timeout);
  }
}
