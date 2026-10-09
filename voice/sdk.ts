// jcode harness API via the official SDK. Attaches to the user's own jcode through `jcode api-bridge`
// (connect, never launch: launch would start a private instance with its own sessions).
import { JcodeClient } from "@1jehuang/jcode-sdk";

let client: Promise<JcodeClient> | null = null;

async function bridge(): Promise<JcodeClient> {
  if (!Bun.which("jcode")) throw new Error("jcode is not installed");
  if (!client) {
    client = JcodeClient.connect({}).then((c) => {
      c.on("close", () => { client = null; });
      return c;
    });
    client.catch(() => { client = null; });
  }
  try { return await client; } catch (e) {
    throw new Error(`jcode bridge is not running. Start it once with \`jcode api-bridge\` (${(e as Error).message.slice(0, 120)})`);
  }
}

/** Cancel the agent's current turn. The session stays open and keeps its history. */
export async function cancelTurn(sessionId: string): Promise<void> {
  const c = await bridge();
  await c.attachSession(sessionId);
  try { await c.cancel(sessionId); } finally { await c.detachSession(sessionId).catch(() => {}); }
}

export async function bridgeStatus(): Promise<{ ok: boolean; reason?: string }> {
  try { await (await bridge()).ping(); return { ok: true }; } catch (e) { return { ok: false, reason: (e as Error).message }; }
}
