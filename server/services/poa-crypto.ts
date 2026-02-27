import crypto from "crypto";
import { logPoA } from "../logger";
import { IPFSClient } from "./ipfs-client";

export function hashFile(fileContents: Buffer): string {
  const hash = crypto.createHash("sha256");
  hash.update(fileContents);
  return hash.digest("hex");
}

export function hashString(str: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(str, "utf-8");
  return hash.digest("hex");
}

export function createRandomHash(): string {
  const randomBytes = crypto.randomBytes(32);
  return crypto.createHash("sha256").update(randomBytes).digest("hex");
}

// Create salt with entropy from Hive block hash (prevents predictable challenges)
export function createSaltWithEntropy(hiveBlockHash: string): string {
  const randomBytes = crypto.randomBytes(16);
  const timestamp = Date.now().toString();
  const combined = Buffer.concat([
    randomBytes,
    Buffer.from(hiveBlockHash),
    Buffer.from(timestamp),
  ]);
  return crypto.createHash("sha256").update(combined).digest("hex");
}

export function getIntFromHash(hash: string, length: number): number {
  if (length <= 7) {
    return 1;
  }
  
  let h = 2166136261;
  for (let i = 0; i < hash.length; i++) {
    h ^= hash.charCodeAt(i);
    h = Math.imul(h, 16777619);
    h = h >>> 0;
  }
  
  return h % length;
}

export async function appendHashToBlock(
  ipfs: IPFSClient,
  hash: string,
  blockCid: string
): Promise<Buffer> {
  const blockBuffer = await ipfs.cat(blockCid);
  const combined = Buffer.concat([blockBuffer, Buffer.from(hash)]);
  return combined;
}

export async function createProofHash(
  ipfs: IPFSClient,
  hash: string,
  cid: string,
  blockCids: string[]
): Promise<string> {
  logPoA.info(`[PoA Crypto] Proof CID: ${cid}`);
  
  const length = blockCids.length;
  logPoA.info(`[PoA Crypto] Block count: ${length}`);
  
  if (length === 0) {
    const fileBuffer = await ipfs.cat(cid);
    const combined = Buffer.concat([fileBuffer, Buffer.from(hash)]);
    return hashFile(combined);
  }
  
  // OPTIMIZATION: Pre-calculate all block indices we'll need to check
  const blocksToFetch: number[] = [];
  let seed = getIntFromHash(hash, length);
  let tempProofHash = "";
  
  // Determine which blocks we need (max 5 blocks for efficiency)
  const maxBlocks = Math.min(5, length);
  for (let i = 0; i < maxBlocks && seed < length; i++) {
    blocksToFetch.push(seed);
    // Simulate the hash progression to get next seed
    const simulatedHash = hashString(`block_${seed}_${hash}`);
    tempProofHash += simulatedHash;
    seed = seed + getIntFromHash(hash + tempProofHash, length);
  }
  
  // OPTIMIZATION: Parallel block fetching with Promise.all
  logPoA.info(`[PoA Crypto] Fetching ${blocksToFetch.length} blocks in parallel: [${blocksToFetch.join(', ')}]`);
  
  try {
    const blockPromises = blocksToFetch.map(async (blockIndex) => {
      const blockBuffer = await ipfs.cat(blockCids[blockIndex]);
      return { index: blockIndex, buffer: blockBuffer };
    });
    
    const fetchedBlocks = await Promise.all(blockPromises);
    
    // Sort by index to maintain deterministic order
    fetchedBlocks.sort((a, b) => a.index - b.index);
    
    // Now compute proof hash with fetched blocks
    const proofHashes: string[] = [];
    for (const block of fetchedBlocks) {
      const combined = Buffer.concat([block.buffer, Buffer.from(hash)]);
      const blockHash = hashFile(combined);
      proofHashes.push(blockHash);
    }
    
    logPoA.info(`[PoA Crypto] Processed ${proofHashes.length} blocks in parallel`);
    
    const finalHash = hashString(proofHashes.join(''));
    logPoA.info(`[PoA Crypto] Proof Hash: ${finalHash}`);
    return finalHash;
    
  } catch (err) {
    logPoA.error(`[PoA Crypto] Failed to fetch blocks: ${err}`);
    return "";
  }
}

export interface ProofRequest {
  type: "RequestProof";
  Hash: string;
  CID: string;
  Status: string;
  User: string;
}

export function createProofRequest(hash: string, cid: string, user: string): ProofRequest {
  return {
    type: "RequestProof",
    Hash: hash,
    CID: cid,
    Status: "Pending",
    User: user,
  };
}

export interface ChallengeResult {
  success: boolean;
  proofHash: string;
  latencyMs: number;
  errorMessage?: string;
}

export async function verifyProofResponse(
  ipfs: IPFSClient,
  challengeHash: string,
  cid: string,
  expectedProofHash: string
): Promise<ChallengeResult> {
  const startTime = Date.now();
  
  try {
    const blockCids = await ipfs.refs(cid);
    const computedProofHash = await createProofHash(ipfs, challengeHash, cid, blockCids);
    const latencyMs = Date.now() - startTime;
    
    const success = computedProofHash === expectedProofHash;
    
    return {
      success,
      proofHash: computedProofHash,
      latencyMs,
      errorMessage: success ? undefined : "Proof hash mismatch",
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      success: false,
      proofHash: "",
      latencyMs,
      errorMessage: err instanceof Error ? err.message : "Unknown error",
    };
  }
}
