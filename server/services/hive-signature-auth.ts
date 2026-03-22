/**
 * Hive Posting Key Signature Verification
 *
 * Verifies that a request was signed by the claimed Hive account's posting key.
 * Used for Level 3 cryptographic auth on quality feedback endpoints.
 *
 * Protocol:
 *   1. Client constructs payload hash: SHA256(JSON.stringify(body))
 *   2. Client signs hash with Hive posting key
 *   3. Client sends: { ...body, _auth: { hiveUsername, signature, nonce, timestamp } }
 *   4. Server verifies signature against on-chain posting key
 *   5. Server checks nonce replay + timestamp expiry
 *
 * Falls back gracefully: if _auth is absent, skips verification (backward compatible).
 * When _auth is present but invalid, returns 401.
 */

import { createHash } from "crypto";

// Lazy-import dhive to avoid crashing when Hive keys aren't configured
let dhiveLoaded = false;
let Signature: any;
let PublicKey: any;
let Client: any;
let hiveClient: any;

async function ensureDhive() {
  if (dhiveLoaded) return;
  try {
    const dhive = await import("@hiveio/dhive");
    Signature = dhive.Signature;
    PublicKey = dhive.PublicKey;
    Client = dhive.Client;
    hiveClient = new Client(["https://api.hive.blog", "https://api.deathwing.me", "https://anyx.io"]);
    dhiveLoaded = true;
  } catch {
    // dhive not available — verification will always return false
  }
}

// Nonce replay cache
const signatureNonceCache = new Map<string, number>();
const NONCE_CACHE_MAX = 5000;
const NONCE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

// Account key cache (avoid hitting Hive API for every request)
const accountKeyCache = new Map<string, { keys: string[]; cachedAt: number }>();
const KEY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface AuthPayload {
  hiveUsername: string;
  signature: string;
  nonce: string;
  timestamp: number;
}

/**
 * Verify a Hive posting key signature on a request body.
 * Returns { valid: true, username } on success, { valid: false, error } on failure.
 */
export async function verifyHiveSignature(
  body: any,
  auth: AuthPayload
): Promise<{ valid: boolean; username?: string; error?: string }> {
  await ensureDhive();
  if (!dhiveLoaded) {
    return { valid: false, error: "dhive not available — cannot verify Hive signatures" };
  }

  // Check timestamp expiry
  if (Math.abs(Date.now() - auth.timestamp) > NONCE_EXPIRY_MS) {
    return { valid: false, error: "Signature timestamp expired (>5 min)" };
  }

  // Check nonce replay
  if (signatureNonceCache.has(auth.nonce)) {
    return { valid: false, error: "Nonce already used (replay)" };
  }

  // Track nonce (LRU eviction)
  if (signatureNonceCache.size >= NONCE_CACHE_MAX) {
    const toDelete = Math.floor(NONCE_CACHE_MAX * 0.2);
    const keys = signatureNonceCache.keys();
    for (let i = 0; i < toDelete; i++) {
      const k = keys.next().value;
      if (k) signatureNonceCache.delete(k);
    }
  }
  signatureNonceCache.set(auth.nonce, Date.now());

  // Compute payload hash (exclude _auth from body to get the signed content)
  const { _auth, ...signedBody } = body;
  const payloadStr = JSON.stringify(signedBody) + "|" + auth.nonce + "|" + auth.timestamp;
  const payloadHash = createHash("sha256").update(payloadStr).digest();

  try {
    // Recover public key from signature
    const sig = Signature.fromString(auth.signature);
    const recovered = sig.recover(payloadHash);

    // Get account's posting keys (cached)
    const postingKeys = await getPostingKeys(auth.hiveUsername);
    if (postingKeys.length === 0) {
      return { valid: false, error: `Account @${auth.hiveUsername} not found or has no posting keys` };
    }

    // Check if recovered key matches any posting key
    const recoveredStr = recovered.toString();
    for (const keyStr of postingKeys) {
      if (recoveredStr === keyStr) {
        return { valid: true, username: auth.hiveUsername };
      }
    }

    return { valid: false, error: "Signature does not match posting key" };
  } catch (err: any) {
    return { valid: false, error: `Signature verification failed: ${err.message}` };
  }
}

/** Fetch posting keys for a Hive account (cached 5 min). */
async function getPostingKeys(username: string): Promise<string[]> {
  const cached = accountKeyCache.get(username);
  if (cached && Date.now() - cached.cachedAt < KEY_CACHE_TTL_MS) {
    return cached.keys;
  }

  try {
    const [account] = await hiveClient.database.getAccounts([username]);
    if (!account) return [];

    const keys = (account as any).posting.key_auths.map(([k]: [string]) => {
      return PublicKey.fromString(k).toString();
    });

    accountKeyCache.set(username, { keys, cachedAt: Date.now() });
    return keys;
  } catch {
    return [];
  }
}

/**
 * Express middleware: verify Hive signature if _auth is present.
 * If _auth absent: pass through (backward compatible).
 * If _auth present but invalid: 401.
 */
export function optionalHiveSignature(req: any, res: any, next: any) {
  const auth = req.body?._auth;
  if (!auth || !auth.hiveUsername || !auth.signature || !auth.nonce) {
    // No signature provided — allow (backward compatible with API key auth)
    return next();
  }

  verifyHiveSignature(req.body, auth).then((result) => {
    if (result.valid) {
      req.hiveSignatureVerified = true;
      req.hiveSignatureUsername = result.username;
      next();
    } else {
      res.status(401).json({ error: { code: "INVALID_HIVE_SIGNATURE", message: result.error } });
    }
  }).catch((err) => {
    res.status(500).json({ error: { code: "SIGNATURE_ERROR", message: err.message } });
  });
}
