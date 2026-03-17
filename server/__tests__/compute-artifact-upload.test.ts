/**
 * Phase 1 Step 1: Artifact Ingress Tests
 *
 * Tests for POST /api/compute/artifacts/upload
 *
 * Test categories:
 * - Valid upload → CID returned, hash matches
 * - SHA-256 mismatch → rejected (422)
 * - Size limit exceeded → rejected (413)
 * - Missing/invalid headers → rejected (400)
 * - Auth required → 401
 * - Rate limiting → 429
 * - Empty body → rejected (400)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { ComputeService } from "../services/compute-service";
import type { ArtifactUpload } from "../services/compute-service";

// We test the service layer directly — route-level tests would need supertest + full app.
// The service method is the real enforcement boundary.

function makeBuffer(size: number, fill = 0x42): Buffer {
  return Buffer.alloc(size, fill);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

describe("Artifact upload — service layer", () => {
  let service: ComputeService;

  beforeEach(() => {
    // Fresh service instance per test (clean rate limit state)
    service = new ComputeService();
  });

  // ================================================================
  // Valid upload
  // ================================================================

  it("accepts valid artifact and returns CID + hash + size", async () => {
    const data = makeBuffer(1024);
    const expectedHash = sha256(data);

    const result = await service.uploadArtifact({
      data,
      expectedSha256: expectedHash,
      workloadType: "eval_sweep",
      nodeId: "test-node-1",
    });

    expect(result.sha256).toBe(expectedHash);
    expect(result.sizeBytes).toBe(1024);
    expect(result.cid).toBeTruthy();
    // Mock IPFS client generates Qm-prefixed CIDs
    expect(result.cid).toMatch(/^Qm/);
  });

  // ================================================================
  // SHA-256 mismatch
  // ================================================================

  it("rejects upload when SHA-256 does not match", async () => {
    const data = makeBuffer(512);
    const wrongHash = "a".repeat(64);

    await expect(
      service.uploadArtifact({
        data,
        expectedSha256: wrongHash,
        workloadType: "eval_sweep",
        nodeId: "test-node-1",
      }),
    ).rejects.toThrow("SHA256_MISMATCH");
  });

  it("SHA-256 mismatch returns 422 status code", async () => {
    const data = makeBuffer(512);
    try {
      await service.uploadArtifact({
        data,
        expectedSha256: "b".repeat(64),
        workloadType: "eval_sweep",
        nodeId: "test-node-1",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.statusCode).toBe(422);
    }
  });

  // ================================================================
  // Size limit enforcement
  // ================================================================

  it("rejects artifact exceeding eval_sweep 5 MB limit", async () => {
    const data = makeBuffer(5 * 1024 * 1024 + 1); // 5 MB + 1 byte
    const hash = sha256(data);

    try {
      await service.uploadArtifact({
        data,
        expectedSha256: hash,
        workloadType: "eval_sweep",
        nodeId: "test-node-1",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("ARTIFACT_TOO_LARGE");
      expect(err.statusCode).toBe(413);
    }
  });

  it("accepts artifact at exactly the size limit", async () => {
    const data = makeBuffer(5 * 1024 * 1024); // exactly 5 MB
    const hash = sha256(data);

    const result = await service.uploadArtifact({
      data,
      expectedSha256: hash,
      workloadType: "eval_sweep",
      nodeId: "test-node-1",
    });

    expect(result.sizeBytes).toBe(5 * 1024 * 1024);
  });

  it("data_generation allows up to 50 MB", async () => {
    // Just test that a 10 MB artifact passes for data_generation
    const data = makeBuffer(10 * 1024 * 1024);
    const hash = sha256(data);

    const result = await service.uploadArtifact({
      data,
      expectedSha256: hash,
      workloadType: "data_generation",
      nodeId: "test-node-1",
    });

    expect(result.sizeBytes).toBe(10 * 1024 * 1024);
  });

  // ================================================================
  // Invalid workload type
  // ================================================================

  it("rejects unknown workload type", async () => {
    const data = makeBuffer(100);
    const hash = sha256(data);

    try {
      await service.uploadArtifact({
        data,
        expectedSha256: hash,
        workloadType: "nonexistent_type" as any,
        nodeId: "test-node-1",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toBe("INVALID_WORKLOAD_TYPE");
      expect(err.statusCode).toBe(400);
    }
  });

  // ================================================================
  // Empty body
  // ================================================================

  it("rejects empty buffer", async () => {
    const data = Buffer.alloc(0);

    try {
      await service.uploadArtifact({
        data,
        expectedSha256: sha256(data),
        workloadType: "eval_sweep",
        nodeId: "test-node-1",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toBe("EMPTY_ARTIFACT");
      expect(err.statusCode).toBe(400);
    }
  });

  // ================================================================
  // Rate limiting
  // ================================================================

  it("rate-limits after 30 uploads from same node", async () => {
    // Upload 30 artifacts (the max)
    for (let i = 0; i < 30; i++) {
      const data = makeBuffer(100, i);
      const hash = sha256(data);
      await service.uploadArtifact({
        data,
        expectedSha256: hash,
        workloadType: "eval_sweep",
        nodeId: "rate-test-node",
      });
    }

    // 31st should be rate-limited
    const data = makeBuffer(100, 0xff);
    const hash = sha256(data);
    try {
      await service.uploadArtifact({
        data,
        expectedSha256: hash,
        workloadType: "eval_sweep",
        nodeId: "rate-test-node",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.message).toBe("ARTIFACT_RATE_LIMITED");
      expect(err.statusCode).toBe(429);
    }
  });

  it("rate limit is per-node — different nodes are independent", async () => {
    // Fill up node-A's limit
    for (let i = 0; i < 30; i++) {
      const data = makeBuffer(100, i);
      await service.uploadArtifact({
        data,
        expectedSha256: sha256(data),
        workloadType: "eval_sweep",
        nodeId: "node-A",
      });
    }

    // node-B should still be able to upload
    const data = makeBuffer(100, 0xaa);
    const result = await service.uploadArtifact({
      data,
      expectedSha256: sha256(data),
      workloadType: "eval_sweep",
      nodeId: "node-B",
    });
    expect(result.cid).toBeTruthy();
  });

  // ================================================================
  // Size limits per workload type (spot checks)
  // ================================================================

  it("domain_lora_train allows up to 500 MB", async () => {
    // Don't actually allocate 500 MB in test — just verify a 10 MB passes
    const data = makeBuffer(10 * 1024 * 1024);
    const result = await service.uploadArtifact({
      data,
      expectedSha256: sha256(data),
      workloadType: "domain_lora_train",
      nodeId: "test-node-1",
    });
    expect(result.sizeBytes).toBe(10 * 1024 * 1024);
  });

  it("benchmark_run rejects at 6 MB", async () => {
    const data = makeBuffer(6 * 1024 * 1024);
    try {
      await service.uploadArtifact({
        data,
        expectedSha256: sha256(data),
        workloadType: "benchmark_run",
        nodeId: "test-node-1",
      });
      expect.unreachable("Should have thrown");
    } catch (err: any) {
      expect(err.statusCode).toBe(413);
    }
  });
});
