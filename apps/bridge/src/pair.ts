import { decodeBridgeStamp, type BridgePairResponse, type BridgeStamp } from "@tik-live/shared";
import { openSync, readSync, closeSync, fstatSync } from "node:fs";

/** The app's address and pairing code the dashboard stamped onto this copy of the .exe, if any. */
export function readOwnStamp(exePath = process.execPath): BridgeStamp | null {
  try {
    const fd = openSync(exePath, "r");
    try {
      const size = fstatSync(fd).size;
      const tail = new Uint8Array(Math.min(size, 8192));
      readSync(fd, tail, 0, tail.length, size - tail.length);
      return decodeBridgeStamp(tail);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** The server couldn't be reached, so the code wasn't used. */
export class PairingNetworkError extends Error {}

/** Trades a pairing code for this PC's device token. Throws with a message to show. */
export async function pairWithCode(server: string, code: string, device: string): Promise<BridgePairResponse> {
  let res: Response;
  try {
    res = await fetch(new URL("/api/bridge/pair", server), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, device }),
    });
  } catch {
    throw new PairingNetworkError(`Não foi possível falar com ${new URL(server).host}. Confira a internet e tente de novo.`);
  }
  if (res.ok) return (await res.json()) as BridgePairResponse;
  const problem = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw new Error(problem?.error?.message ?? `O servidor recusou o pareamento (${res.status}).`);
}
