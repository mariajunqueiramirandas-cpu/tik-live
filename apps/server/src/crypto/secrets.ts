/**
 * Secrets at rest (ADR-0016): AES-256-GCM with per-purpose keys derived from
 * APP_SECRET via HKDF, a random 96-bit IV per value, and a key version
 * prefix so keys can be rotated later. Stage keys are looked up by HMAC so a
 * database leak alone doesn't yield working stage URLs.
 */

const VERSION = "v1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type SecretPurpose = "stage-key" | "stream-key" | "provider-key";

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Buffer.from(value, "base64url");
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

export class Secrets {
  private readonly master: Promise<CryptoKey>;
  private readonly keys = new Map<string, Promise<CryptoKey>>();
  private readonly hmacKey: Promise<CryptoKey>;

  constructor(appSecret: string) {
    this.master = crypto.subtle.importKey("raw", encoder.encode(appSecret), "HKDF", false, ["deriveKey"]);
    this.hmacKey = this.master.then((master) =>
      crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: encoder.encode("tik-live/lookup"), info: encoder.encode(VERSION) },
        master,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      ),
    );
  }

  private keyFor(purpose: SecretPurpose): Promise<CryptoKey> {
    let key = this.keys.get(purpose);
    if (!key) {
      key = this.master.then((master) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: encoder.encode(`tik-live/${purpose}`), info: encoder.encode(VERSION) },
          master,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
      this.keys.set(purpose, key);
    }
    return key;
  }

  async encrypt(purpose: SecretPurpose, plaintext: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.keyFor(purpose);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)));
    return `${VERSION}.${toBase64Url(iv)}.${toBase64Url(data)}`;
  }

  async decrypt(purpose: SecretPurpose, ciphertext: string): Promise<string> {
    const [version, iv, data] = ciphertext.split(".");
    if (version !== VERSION || !iv || !data) throw new Error("Unsupported ciphertext format");
    const key = await this.keyFor(purpose);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, key, fromBase64Url(data));
    return decoder.decode(plain);
  }

  /** Deterministic lookup hash for a secret token (e.g. stage keys). */
  async lookup(token: string): Promise<string> {
    const signature = await crypto.subtle.sign("HMAC", await this.hmacKey, encoder.encode(token));
    return toBase64Url(new Uint8Array(signature));
  }
}

/** A URL-safe random token with `bytes` of entropy (default 128 bits). */
export function randomToken(bytes = 16): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= (left[i] as number) ^ (right[i] as number);
  return diff === 0;
}
