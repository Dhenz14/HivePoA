import crypto from "crypto";
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
  console.log(`[PoA Crypto] Proof CID: ${cid}`);
  
  const length = blockCids.length;
  console.log(`[PoA Crypto] Block count: ${length}`);
  
  if (length === 0) {
    const fileBuffer = await ipfs.cat(cid);
    const combined = Buffer.concat([fileBuffer, Buffer.from(hash)]);
    return hashFile(combined);
  }
  
  let proofHash = "";
  let seed = 0;
  
  if (length > 0) {
    seed = getIntFromHash(hash, length);
  }
  
  let blocksProcessed = 0;
  for (let i = 0; i <= length; i++) {
    if (seed >= length) {
      break;
    }
    
    if (i === seed) {
      try {
        const blockWithHash = await appendHashToBlock(ipfs, hash, blockCids[seed]);
        const blockHash = hashFile(blockWithHash);
        proofHash = proofHash + blockHash;
        blocksProcessed++;
        seed = seed + getIntFromHash(hash + proofHash, length);
      } catch (err) {
        console.error(`[PoA Crypto] Failed to fetch block ${blockCids[seed]}: ${err}`);
        return "";
      }
    }
  }
  
  console.log(`[PoA Crypto] Processed ${blocksProcessed} blocks`);
  
  const finalHash = hashString(proofHash);
  console.log(`[PoA Crypto] Proof Hash: ${finalHash}`);
  return finalHash;
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
