import { describe, it, expect } from "vitest";
import {
  hashFile,
  hashString,
  createRandomHash,
  getIntFromHash,
  createSaltWithEntropy,
  createProofHash,
  createProofRequest,
  verifyProofResponse,
} from "../poa-crypto";
import { MockIPFSClient } from "../ipfs-client";

describe("hashFile", () => {
  it("produces consistent SHA256 for the same input", () => {
    const buf = Buffer.from("hello world");
    const h1 = hashFile(buf);
    const h2 = hashFile(buf);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("produces different hashes for different inputs", () => {
    const h1 = hashFile(Buffer.from("hello"));
    const h2 = hashFile(Buffer.from("world"));
    expect(h1).not.toBe(h2);
  });

  it("matches known SHA256 for 'test'", () => {
    // SHA256 of "test" is well-known
    const hash = hashFile(Buffer.from("test"));
    expect(hash).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });
});

describe("hashString", () => {
  it("produces consistent SHA256 for the same string", () => {
    const h1 = hashString("hello");
    const h2 = hashString("hello");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("produces same result as hashFile for same content", () => {
    const str = "test data";
    expect(hashString(str)).toBe(hashFile(Buffer.from(str)));
  });
});

describe("createRandomHash", () => {
  it("returns a 64-char hex string", () => {
    const hash = createRandomHash();
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces unique hashes", () => {
    const hashes = new Set(Array.from({ length: 10 }, () => createRandomHash()));
    expect(hashes.size).toBe(10);
  });
});

describe("getIntFromHash", () => {
  it("returns 0 for length <= 1", () => {
    expect(getIntFromHash("abcdef", 1)).toBe(0);
    expect(getIntFromHash("abcdef", 0)).toBe(0);
  });

  it("returns valid index for small lengths (2-7)", () => {
    for (let len = 2; len <= 7; len++) {
      const idx = getIntFromHash("abcdef", len);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(len);
    }
  });

  it("is deterministic: same hash + length = same index", () => {
    const hash = "a1b2c3d4e5f6";
    const length = 100;
    const i1 = getIntFromHash(hash, length);
    const i2 = getIntFromHash(hash, length);
    expect(i1).toBe(i2);
  });

  it("returns a value within [0, length)", () => {
    for (let i = 0; i < 50; i++) {
      const hash = createRandomHash();
      const length = 100;
      const idx = getIntFromHash(hash, length);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(length);
    }
  });

  it("distributes across range (not always same value)", () => {
    const indices = new Set<number>();
    for (let i = 0; i < 100; i++) {
      indices.add(getIntFromHash(createRandomHash(), 100));
    }
    // Should have at least 10 different indices out of 100 trials
    expect(indices.size).toBeGreaterThan(10);
  });
});

describe("createSaltWithEntropy", () => {
  it("returns a 64-char hex string", () => {
    const salt = createSaltWithEntropy("0000000000000000000000000000000000000000");
    expect(salt).toHaveLength(64);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different salts for different block hashes", () => {
    const s1 = createSaltWithEntropy("aaaa");
    const s2 = createSaltWithEntropy("bbbb");
    expect(s1).not.toBe(s2);
  });

  it("produces different salts even with same block hash (due to randomBytes)", () => {
    const s1 = createSaltWithEntropy("same");
    const s2 = createSaltWithEntropy("same");
    expect(s1).not.toBe(s2);
  });
});

describe("createProofHash", () => {
  it("returns a hash for a file with no blocks", async () => {
    const ipfs = new MockIPFSClient();
    const content = Buffer.from("small file content");
    const cid = await ipfs.add(content);

    // With empty blockCids, should hash the file content + salt
    const proof = await createProofHash(ipfs, "testsalt", cid, []);
    expect(proof).toHaveLength(64);
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same inputs = same proof hash", async () => {
    const ipfs = new MockIPFSClient();
    const content = Buffer.from("deterministic test data that is long enough to have blocks".repeat(100));
    const cid = await ipfs.add(content);
    const blockCids = await ipfs.refs(cid);

    const proof1 = await createProofHash(ipfs, "salt123", cid, blockCids);
    const proof2 = await createProofHash(ipfs, "salt123", cid, blockCids);
    expect(proof1).toBe(proof2);
  });

  it("produces different proofs for different salts", async () => {
    const ipfs = new MockIPFSClient();
    // Need 8+ blocks (256KB each) so getIntFromHash can select different blocks per salt
    const content = Buffer.alloc(256 * 1024 * 10, 0);
    for (let i = 0; i < content.length; i++) content[i] = i % 256; // Varied content
    const cid = await ipfs.add(content);
    const blockCids = await ipfs.refs(cid);
    expect(blockCids.length).toBeGreaterThan(7);

    const proof1 = await createProofHash(ipfs, "salt_a", cid, blockCids);
    const proof2 = await createProofHash(ipfs, "salt_b", cid, blockCids);
    expect(proof1).not.toBe(proof2);
  });
});

describe("createProofRequest", () => {
  it("creates a well-formed proof request", () => {
    const req = createProofRequest("hash123", "QmCid123", "testuser");
    expect(req).toEqual({
      type: "RequestProof",
      Hash: "hash123",
      CID: "QmCid123",
      Status: "Pending",
      User: "testuser",
    });
  });
});

describe("verifyProofResponse", () => {
  it("returns success when proof matches", async () => {
    const ipfs = new MockIPFSClient();
    const content = Buffer.from("verification test content".repeat(500));
    const cid = await ipfs.add(content);
    const blockCids = await ipfs.refs(cid);

    // Compute the expected proof
    const expectedProof = await createProofHash(ipfs, "verify_salt", cid, blockCids);

    const result = await verifyProofResponse(ipfs, "verify_salt", cid, expectedProof);
    expect(result.success).toBe(true);
    expect(result.proofHash).toBe(expectedProof);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.errorMessage).toBeUndefined();
  });

  it("returns failure when proof mismatches", async () => {
    const ipfs = new MockIPFSClient();
    const content = Buffer.from("mismatch test".repeat(500));
    const cid = await ipfs.add(content);

    const result = await verifyProofResponse(ipfs, "salt", cid, "wrong_proof_hash");
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("Proof hash mismatch");
  });
});
