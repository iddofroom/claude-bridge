/**
 * Fire-and-forget push to the bridge running on the user's home machine.
 * Fast path. The bridge also has a slow safety net: it polls
 * /api/webhooks/bridge for queued rows. If the push fails, the queued
 * outbox row is picked up by the next poll cycle — nothing is lost.
 */
export async function pushToBridge(payload: {
  outboxId: string;
  workspace: string;
  prompt: string;
  conversationId?: string | null;
}): Promise<void> {
  const url = process.env.BRIDGE_PUSH_URL;
  const secret = process.env.BRIDGE_SECRET;
  if (!url || !secret) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(`${url.replace(/\/$/, "")}/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-secret": secret },
      body: JSON.stringify({
        id: payload.outboxId,
        workspace: payload.workspace,
        prompt: payload.prompt,
        conversation_id: payload.conversationId ?? null,
      }),
      signal: controller.signal,
    });
  } catch {
    // Best-effort. The outbox row will be picked up by the bridge's poll later.
  } finally {
    clearTimeout(timeout);
  }
}
