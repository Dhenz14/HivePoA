import * as crypto from 'crypto';
import axios from 'axios';

/**
 * Shared PoA proof computation module.
 * Algorithm must match server/services/poa-crypto.ts exactly.
 */

export function hashFile(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function hashString(str: string): string {
  return crypto.createHash('sha256').update(str, 'utf-8').digest('hex');
}

export function createRandomHash(): string {
  const randomBytes = crypto.randomBytes(32);
  return crypto.createHash('sha256').update(randomBytes).digest('hex');
}

/**
 * Create salt with entropy from Hive block hash (prevents predictable challenges).
 * Matches server/services/poa-crypto.ts createSaltWithEntropy().
 */
export function createSaltWithEntropy(hiveBlockHash: string): string {
  const randomBytes = crypto.randomBytes(16);
  const timestamp = Date.now().toString();
  const combined = Buffer.concat([
    randomBytes,
    Buffer.from(hiveBlockHash),
    Buffer.from(timestamp),
  ]);
  return crypto.createHash('sha256').update(combined).digest('hex');
}

/**
 * Validate CID format (CIDv0: Qm... or CIDv1: baf...).
 * Prevents injection attacks when CIDs are passed to IPFS API URLs.
 */
const CID_REGEX = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{56,})$/;

export function isValidCid(cid: string): boolean {
  return typeof cid === 'string' && CID_REGEX.test(cid);
}

/**
 * FNV-1a hash — must match getIntFromHash() in server/services/poa-crypto.ts exactly.
 */
export function getIntFromHash(hash: string, length: number): number {
  if (length <= 1) return 0;

  let h = 2166136261;
  for (let i = 0; i < hash.length; i++) {
    h ^= hash.charCodeAt(i);
    h = Math.imul(h, 16777619);
    h = h >>> 0;
  }
  return h % length;
}

/**
 * Fetch block CIDs for a file using IPFS refs command.
 * Returns empty array if the file has no sub-blocks (small file).
 */
export async function getBlockCids(kuboApiUrl: string, cid: string): Promise<string[]> {
  try {
    const response = await axios.post(
      `${kuboApiUrl}/api/v0/refs?arg=${cid}`,
      null,
      { timeout: 10000 }
    );

    const lines = response.data.toString().split('\n').filter((l: string) => l.trim());
    const refs: string[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.Ref) refs.push(parsed.Ref);
      } catch {}
    }

    return refs;
  } catch {
    return [];
  }
}

/**
 * Compute proof hash using the exact same algorithm as server/services/poa-crypto.ts createProofHash().
 * Uses Kubo HTTP API directly for IPFS block fetching.
 */
export async function computeProofHash(
  kuboApiUrl: string,
  salt: string,
  cid: string,
  blockCids: string[]
): Promise<string> {
  const length = blockCids.length;

  if (length === 0) {
    // Small file: SHA256(fileData + salt)
    const fileResponse = await axios.post(
      `${kuboApiUrl}/api/v0/cat?arg=${cid}`,
      null,
      { timeout: 15000, responseType: 'arraybuffer' }
    );
    const fileBuffer = Buffer.from(fileResponse.data);
    const combined = Buffer.concat([fileBuffer, Buffer.from(salt)]);
    return hashFile(combined);
  }

  // Multi-block file: deterministic block selection + parallel fetch
  const blocksToFetch: number[] = [];
  let seed = getIntFromHash(salt, length);
  let tempProofHash = '';

  const maxBlocks = Math.min(5, length);
  for (let i = 0; i < maxBlocks && seed < length; i++) {
    blocksToFetch.push(seed);
    const simulatedHash = hashString(`block_${seed}_${salt}`);
    tempProofHash += simulatedHash;
    seed = seed + getIntFromHash(salt + tempProofHash, length);
  }

  // Parallel block fetching
  const blockPromises = blocksToFetch.map(async (blockIndex) => {
    const blockResponse = await axios.post(
      `${kuboApiUrl}/api/v0/block/get?arg=${blockCids[blockIndex]}`,
      null,
      { timeout: 10000, responseType: 'arraybuffer' }
    );
    return { index: blockIndex, buffer: Buffer.from(blockResponse.data) };
  });

  const fetchedBlocks = await Promise.all(blockPromises);

  // Sort by index for deterministic order
  fetchedBlocks.sort((a, b) => a.index - b.index);

  // Compute per-block hashes
  const proofHashes: string[] = [];
  for (const block of fetchedBlocks) {
    const combined = Buffer.concat([block.buffer, Buffer.from(salt)]);
    proofHashes.push(hashFile(combined));
  }

  // Final hash = SHA256(allBlockHashesConcatenated)
  return hashString(proofHashes.join(''));
}

/**
 * Compute a commitment hash for the two-phase PoA protocol.
 * Phase 1 (commitment): node proves it has the block list locally by returning
 * a hash of the block CIDs. This is fast (~50ms) if data is pinned locally,
 * but too slow (~seconds) if the node needs to fetch from the IPFS network.
 *
 * Returns { blockCount, blockListHash, blockCids } for the validator to cache.
 */
export async function computeBlockListHash(
  kuboApiUrl: string,
  cid: string
): Promise<{ blockCount: number; blockListHash: string; blockCids: string[] }> {
  const blockCids = await getBlockCids(kuboApiUrl, cid);
  const blockCount = blockCids.length;

  // Hash the sorted block CID list — deterministic regardless of refs order
  const sorted = [...blockCids].sort();
  const blockListHash = hashString(sorted.join(':') + ':' + cid);

  return { blockCount, blockListHash, blockCids };
}

/**
 * Full verification: fetch refs + compute proof + compare against claimed hash.
 * Used by the validator to independently verify a peer's proof response.
 */
export async function verifyProof(
  kuboApiUrl: string,
  salt: string,
  cid: string,
  claimedProofHash: string
): Promise<{ valid: boolean; expectedHash: string; latencyMs: number }> {
  const startTime = Date.now();

  try {
    const blockCids = await getBlockCids(kuboApiUrl, cid);
    const expectedHash = await computeProofHash(kuboApiUrl, salt, cid, blockCids);
    const latencyMs = Date.now() - startTime;

    return {
      valid: expectedHash === claimedProofHash,
      expectedHash,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      valid: false,
      expectedHash: '',
      latencyMs,
    };
  }
}
