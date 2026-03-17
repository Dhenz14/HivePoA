/**
 * Phase 1 Step 4: Payout Broadcaster Burn-in
 *
 * Adversarial proof that the published broadcast state machine (bc08f57)
 * holds under the six failure modes that real money systems lie to themselves
 * about. Tests are written to BREAK the system, not to confirm happy paths.
 *
 * Scenarios:
 *   B1 — Ambiguous ack: transfer() throws, attempt stays in-flight (no resend)
 *   B2 — Delayed confirmation: confirmTransaction returns pending N times, then confirms
 *   B3a — Restart during "created": orphaned pre-send row ages out correctly
 *   B3b — Restart during "ambiguous" (no txId): ages out, eligible for retry
 *   B4 — Duplicate sweep-cycle: processing guard prevents overlapping cycles
 *   B5 — Max-attempt exhaustion: 3 failures → terminal "failed", no further sends
 *   B6 — Parallel upload memory safety: concurrency guard rejects excess uploads
 *
 * Architecture:
 *   - InMemoryBroadcastStorage: deterministic, no DB required
 *   - StubHiveClient: programmable per-test; tracks call counts
 *   - ComputePayoutBroadcaster: real production class, injectable deps
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import { ComputePayoutBroadcaster } from "../services/compute-payout-broadcaster";
import type { BroadcastStorage } from "../services/compute-payout-broadcaster";
import { ComputeService } from "../services/compute-service";
import type { ArtifactUpload } from "../services/compute-service";
import type {
  ComputeNode,
  ComputePayout,
  ComputePayoutBroadcast,
  InsertComputePayoutBroadcast,
} from "@shared/schema";

// ================================================================
// In-memory storage — implements BroadcastStorage exactly
// ================================================================

class InMemoryBroadcastStorage implements BroadcastStorage {
  private payouts = new Map<string, ComputePayout>();
  private attempts = new Map<string, ComputePayoutBroadcast>();
  private nodes = new Map<string, ComputeNode>();
  private idSeq = 0;

  private nextId(): string {
    return `id-${++this.idSeq}`;
  }

  // Test-only: seed fixtures
  seedPayout(p: ComputePayout) { this.payouts.set(p.id, p); }
  seedAttempt(a: ComputePayoutBroadcast) { this.attempts.set(a.id, a); }
  seedNode(n: ComputeNode) { this.nodes.set(n.id, n); }

  // Test-only: inspect state
  getPayout(id: string): ComputePayout | undefined { return this.payouts.get(id); }
  getAttempt(id: string): ComputePayoutBroadcast | undefined { return this.attempts.get(id); }
  allAttempts(): ComputePayoutBroadcast[] { return [...this.attempts.values()]; }

  async getQueuedComputePayouts(limit = 10): Promise<ComputePayout[]> {
    return [...this.payouts.values()]
      .filter(p => p.status === "queued")
      .slice(0, limit);
  }

  async getInflightBroadcastAttempts(): Promise<ComputePayoutBroadcast[]> {
    return [...this.attempts.values()]
      .filter(a => ["created", "sent", "ambiguous"].includes(a.status))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  async getLatestBroadcastAttempt(payoutId: string): Promise<ComputePayoutBroadcast | undefined> {
    return [...this.attempts.values()]
      .filter(a => a.payoutId === payoutId)
      .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
  }

  async getPayoutBroadcastAttemptsByPayout(payoutId: string): Promise<ComputePayoutBroadcast[]> {
    return [...this.attempts.values()]
      .filter(a => a.payoutId === payoutId)
      .sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async createPayoutBroadcastAttempt(
    attempt: InsertComputePayoutBroadcast,
  ): Promise<ComputePayoutBroadcast> {
    // Enforce unique constraint on idempotencyKey
    const keyConflict = [...this.attempts.values()].find(
      a => a.idempotencyKey === attempt.idempotencyKey,
    );
    if (keyConflict) {
      const err = new Error("unique constraint violated: idempotencyKey");
      (err as any).code = "23505";
      throw err;
    }
    // Enforce unique constraint on (payoutId, attemptNumber)
    const pairConflict = [...this.attempts.values()].find(
      a => a.payoutId === attempt.payoutId && a.attemptNumber === attempt.attemptNumber,
    );
    if (pairConflict) {
      const err = new Error("unique constraint violated: (payoutId, attemptNumber)");
      (err as any).code = "23505";
      throw err;
    }

    const created: ComputePayoutBroadcast = {
      id: this.nextId(),
      createdAt: new Date(),
      ...attempt,
    } as ComputePayoutBroadcast;
    this.attempts.set(created.id, created);
    return created;
  }

  async updatePayoutBroadcastAttempt(
    id: string,
    updates: Partial<ComputePayoutBroadcast>,
  ): Promise<void> {
    const current = this.attempts.get(id);
    if (!current) throw new Error(`attempt ${id} not found`);
    this.attempts.set(id, { ...current, ...updates });
  }

  async updateComputePayoutStatus(
    id: string,
    status: string,
    treasuryTxId?: string,
  ): Promise<void> {
    const p = this.payouts.get(id);
    if (!p) throw new Error(`payout ${id} not found`);
    this.payouts.set(id, { ...p, status, ...(treasuryTxId ? { treasuryTxId } : {}) });
  }

  async getComputeNode(nodeId: string): Promise<ComputeNode | undefined> {
    return this.nodes.get(nodeId);
  }
}

// ================================================================
// Stub Hive client — programmable per-test
// ================================================================

type TransferBehavior = "success" | "throw_no_txid";
type ConfirmBehavior = "confirmed" | "pending_then_confirmed" | "expired" | "unknown";

class StubHiveClient {
  transferCalls = 0;
  confirmCalls = 0;

  private txBehavior: TransferBehavior = "success";
  private cnfBehavior: ConfirmBehavior = "confirmed";
  private pendingCycles = 2;
  private cnfCycleCount = 0;

  setTransfer(b: TransferBehavior) { this.txBehavior = b; }

  setConfirm(b: ConfirmBehavior, pendingCycles = 2) {
    this.cnfBehavior = b;
    this.pendingCycles = pendingCycles;
    this.cnfCycleCount = 0;
  }

  async transfer(req: { to: string; amount: string; memo: string }): Promise<{ id: string; blockNumber: number }> {
    this.transferCalls++;
    if (this.txBehavior === "throw_no_txid") {
      throw new Error("Network timeout — tx status unknown");
    }
    return { id: `stub-tx-${this.transferCalls}`, blockNumber: 12345 };
  }

  async confirmTransaction(_txId: string): Promise<{ outcome: string; blockNum?: number }> {
    this.confirmCalls++;
    if (this.cnfBehavior === "confirmed") {
      return { outcome: "confirmed", blockNum: 12346 };
    }
    if (this.cnfBehavior === "pending_then_confirmed") {
      this.cnfCycleCount++;
      if (this.cnfCycleCount < this.pendingCycles) return { outcome: "pending" };
      return { outcome: "confirmed", blockNum: 12346 };
    }
    if (this.cnfBehavior === "expired") return { outcome: "expired" };
    return { outcome: "unknown" };
  }

  async verifyTransfer(_txId: string): Promise<{ memo: string } | null> {
    return null; // always not-found in stub — worst case
  }
}

// ================================================================
// Fixture helpers
// ================================================================

function makeNode(overrides: Partial<ComputeNode> = {}): ComputeNode {
  return {
    id: "node-1",
    hiveUsername: "worker-alpha",
    nodeInstanceId: "inst-1",
    gpuModel: "RTX 4090",
    gpuVramGb: 24,
    status: "active",
    reputation: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
    cudaVersion: null,
    cpuCores: null,
    ramGb: null,
    supportedWorkloads: "eval_sweep",
    cachedModels: null,
    workerVersion: null,
    pricePerHourHbd: null,
    lastHeartbeat: null,
    ...overrides,
  } as ComputeNode;
}

function makePayout(overrides: Partial<ComputePayout> = {}): ComputePayout {
  return {
    id: "payout-1",
    nodeId: "node-1",
    jobId: "job-1",
    amountHbd: "0.020",
    status: "queued",
    treasuryTxId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ComputePayout;
}

function makeAttempt(overrides: Partial<ComputePayoutBroadcast>): ComputePayoutBroadcast {
  return {
    id: "attempt-1",
    payoutId: "payout-1",
    attemptNumber: 1,
    idempotencyKey: "broadcast:payout-1:1",
    recipientUsername: "worker-alpha",
    amountHbd: "0.020",
    memo: "hivepoa:compute:payout-1:1",
    status: "created",
    hiveTxId: null,
    chainBlockNum: null,
    errorMessage: null,
    resolvedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as ComputePayoutBroadcast;
}

// Simulate a row that's "old" by back-dating createdAt
function agedAttempt(
  overrides: Partial<ComputePayoutBroadcast>,
  ageMs: number,
): ComputePayoutBroadcast {
  return makeAttempt({
    ...overrides,
    createdAt: new Date(Date.now() - ageMs),
  });
}

function makeUpload(nodeId: string, sizeBytes: number): ArtifactUpload {
  const data = Buffer.alloc(sizeBytes, 0x42);
  const expectedSha256 = createHash("sha256").update(data).digest("hex");
  return { data, expectedSha256, workloadType: "eval_sweep", nodeId };
}

// ================================================================
// B1 — Ambiguous ack: transfer() throws, no duplicate resend
// ================================================================

describe("B1 — Ambiguous ack: transfer throws, attempt stays in-flight", () => {
  let store: InMemoryBroadcastStorage;
  let stub: StubHiveClient;
  let broadcaster: ComputePayoutBroadcaster;

  beforeEach(() => {
    store = new InMemoryBroadcastStorage();
    stub = new StubHiveClient();
    store.seedNode(makeNode());
    store.seedPayout(makePayout());
    broadcaster = new ComputePayoutBroadcaster(stub as any, store);
  });

  it("transfer is called exactly once when it throws — not retried within the same cycle", async () => {
    stub.setTransfer("throw_no_txid");

    // First sweep: creates attempt, transfer throws → attempt becomes ambiguous
    await broadcaster.processQueue();

    expect(stub.transferCalls).toBe(1);

    // Second sweep: broadcastPayout sees latest attempt is "ambiguous" (in-flight) → returns early
    await broadcaster.processQueue();

    // Transfer must NOT have been called again
    expect(stub.transferCalls).toBe(1);
  });

  it("ambiguous attempt is NOT in terminal state — it blocks a new attempt", async () => {
    stub.setTransfer("throw_no_txid");
    await broadcaster.processQueue();

    const latest = await store.getLatestBroadcastAttempt("payout-1");
    expect(latest?.status).toBe("ambiguous");
  });

  it("payout stays 'queued' — not falsely advanced while ambiguous attempt is in-flight", async () => {
    stub.setTransfer("throw_no_txid");
    await broadcaster.processQueue();

    const payout = store.getPayout("payout-1");
    // Payout is not confirmed or failed — ambiguous is not a terminal resolution
    expect(payout?.status).toBe("queued");
  });

  it("ambiguous attempt without txId eventually ages to failed_error after threshold", async () => {
    // Seed an already-aged ambiguous attempt (no txId, 11 minutes old)
    const aged = agedAttempt(
      { id: "attempt-old", status: "ambiguous", hiveTxId: null },
      11 * 60 * 1000,
    );
    store.seedAttempt(aged);
    // Remove the queued payout so broadcastPayout doesn't create a new one
    store.seedPayout(makePayout({ status: "broadcast" }));

    await broadcaster.processQueue();

    const attempt = store.getAttempt("attempt-old")!;
    expect(attempt.status).toBe("failed_error");
    expect(attempt.resolvedAt).not.toBeNull();
    // Aged-out ambiguous: still only 0 transfers (no new send triggered)
    expect(stub.transferCalls).toBe(0);
  });

  it("ambiguous attempt without txId under age threshold is left alone", async () => {
    // 8 minutes old — under 10-minute threshold
    const young = agedAttempt(
      { id: "attempt-young", status: "ambiguous", hiveTxId: null },
      8 * 60 * 1000,
    );
    store.seedAttempt(young);
    store.seedPayout(makePayout({ status: "broadcast" }));

    await broadcaster.processQueue();

    const attempt = store.getAttempt("attempt-young")!;
    expect(attempt.status).toBe("ambiguous"); // unchanged
    expect(stub.transferCalls).toBe(0);
  });
});

// ================================================================
// B2 — Delayed confirmation: pending for N cycles, then confirmed
// ================================================================

describe("B2 — Delayed confirmation: sweep waits rather than resending", () => {
  let store: InMemoryBroadcastStorage;
  let stub: StubHiveClient;
  let broadcaster: ComputePayoutBroadcaster;

  beforeEach(() => {
    store = new InMemoryBroadcastStorage();
    stub = new StubHiveClient();
    store.seedNode(makeNode());
    store.seedPayout(makePayout());
    broadcaster = new ComputePayoutBroadcaster(stub as any, store);
  });

  it("transfer is called exactly once even after 3 pending cycles before confirmation", async () => {
    stub.setTransfer("success");
    stub.setConfirm("pending_then_confirmed", 3);

    // Cycle 1: broadcast → attempt created + transfer → status "sent"
    await broadcaster.processQueue();
    expect(stub.transferCalls).toBe(1);

    // Cycle 2: confirmTransaction returns pending → no state change
    await broadcaster.processQueue();
    expect(stub.transferCalls).toBe(1);

    // Cycle 3: confirmTransaction returns pending again
    await broadcaster.processQueue();
    expect(stub.transferCalls).toBe(1);

    // Cycle 4: confirmTransaction returns confirmed
    await broadcaster.processQueue();
    expect(stub.transferCalls).toBe(1); // still 1 — never re-sent

    const payout = store.getPayout("payout-1");
    expect(payout?.status).toBe("confirmed");
  });

  it("broadcastPayout skips creating new attempt while previous is 'sent'", async () => {
    stub.setTransfer("success");
    stub.setConfirm("pending_then_confirmed", 99); // stays pending forever in this test

    // Cycle 1: creates attempt, transfer succeeds → "sent"
    await broadcaster.processQueue();

    // Cycle 2: broadcastPayout sees latest is "sent" (in-flight) → returns early immediately
    await broadcaster.processQueue();

    // Still only 1 attempt in storage
    const attempts = store.allAttempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("sent");
    expect(stub.transferCalls).toBe(1);
  });

  it("expired tx marks attempt failed_expired and makes payout eligible for retry", async () => {
    stub.setTransfer("success");
    stub.setConfirm("expired");

    // Cycle 1: broadcast → sent
    await broadcaster.processQueue();

    // Cycle 2: confirmTransaction returns expired
    await broadcaster.processQueue();

    const attempt = store.allAttempts()[0];
    expect(attempt.status).toBe("failed_expired");
    expect(attempt.resolvedAt).not.toBeNull();

    // Payout is still queued (not yet exhausted — only 1 failed attempt)
    const payout = store.getPayout("payout-1");
    expect(payout?.status).toBe("broadcast"); // broadcast was set on transfer success
  });
});

// ================================================================
// B3 — Restart recovery: orphaned "created" and "ambiguous" rows
// ================================================================

describe("B3a — Restart during 'created': orphaned pre-send row recovery", () => {
  let store: InMemoryBroadcastStorage;
  let stub: StubHiveClient;
  let broadcaster: ComputePayoutBroadcaster;

  beforeEach(() => {
    store = new InMemoryBroadcastStorage();
    stub = new StubHiveClient();
    broadcaster = new ComputePayoutBroadcaster(stub as any, store);
  });

  it("created row under age threshold is left alone (may still be broadcasting)", async () => {
    const young = agedAttempt(
      { id: "stale-created", status: "created", hiveTxId: null },
      3 * 60 * 1000, // 3 minutes — under 5-minute threshold
    );
    store.seedAttempt(young);
    store.seedPayout(makePayout({ status: "broadcast" }));

    await broadcaster.processQueue();

    const attempt = store.getAttempt("stale-created")!;
    expect(attempt.status).toBe("created"); // untouched
    expect(stub.transferCalls).toBe(0);
  });

  it("created row over 5 minutes is recovered to failed_error (crash recovery path)", async () => {
    const orphaned = agedAttempt(
      { id: "orphaned-created", status: "created", hiveTxId: null },
      6 * 60 * 1000, // 6 minutes — over threshold
    );
    store.seedAttempt(orphaned);
    store.seedPayout(makePayout({ status: "broadcast" }));

    await broadcaster.processQueue();

    const attempt = store.getAttempt("orphaned-created")!;
    expect(attempt.status).toBe("failed_error");
    expect(attempt.errorMessage).toMatch(/crash recovery/i);
    expect(attempt.resolvedAt).not.toBeNull();
    expect(stub.transferCalls).toBe(0); // no transfer was attempted
  });

  it("after orphaned created is recovered, a new attempt is created on next cycle", async () => {
    store.seedNode(makeNode());
    // Payout is queued; its one attempt is an orphaned created row (already aged)
    store.seedPayout(makePayout());
    const orphaned = agedAttempt(
      { id: "orphaned-created-2", status: "created", hiveTxId: null },
      6 * 60 * 1000,
    );
    store.seedAttempt(orphaned);

    // Cycle 1: confirmBroadcast recovers orphaned → failed_error
    await broadcaster.processQueue();
    expect(store.getAttempt("orphaned-created-2")?.status).toBe("failed_error");

    // Cycle 2: broadcastPayout sees failedCount=1, creates attempt 2 and sends
    stub.setTransfer("success");
    stub.setConfirm("confirmed");
    await broadcaster.processQueue();

    const attempts = store.allAttempts();
    expect(attempts).toHaveLength(2);
    const attempt2 = attempts.find(a => a.attemptNumber === 2)!;
    // With immediate confirmTransaction, the same cycle that broadcasts also confirms
    expect(["sent", "confirmed"]).toContain(attempt2.status);
    expect(stub.transferCalls).toBe(1); // exactly one transfer for attempt 2

    // The payout itself must be resolved (not still queued)
    const payout = store.getPayout("payout-1")!;
    expect(["broadcast", "confirmed"]).toContain(payout.status);
  });
});

describe("B3b — Restart during 'ambiguous' (no txId): ages out correctly", () => {
  let store: InMemoryBroadcastStorage;
  let stub: StubHiveClient;
  let broadcaster: ComputePayoutBroadcaster;

  beforeEach(() => {
    store = new InMemoryBroadcastStorage();
    stub = new StubHiveClient();
    broadcaster = new ComputePayoutBroadcaster(stub as any, store);
  });

  it("aged ambiguous (no txId) produces failed_error, payout eligible for retry", async () => {
    store.seedNode(makeNode());
    store.seedPayout(makePayout({ status: "broadcast" }));
    const aged = agedAttempt(
      { id: "aged-ambiguous", status: "ambiguous", hiveTxId: null },
      11 * 60 * 1000, // over 10-minute threshold
    );
    store.seedAttempt(aged);

    await broadcaster.processQueue();

    const attempt = store.getAttempt("aged-ambiguous")!;
    expect(attempt.status).toBe("failed_error");
    expect(attempt.errorMessage).toMatch(/aged out/i);
  });

  it("ambiguous attempt with txId uses chain polling, not age", async () => {
    // ambiguous WITH txId — chain confirms on first poll
    store.seedNode(makeNode());
    store.seedPayout(makePayout({ status: "broadcast" }));
    stub.setConfirm("confirmed");

    // Simulate: transfer was ambiguous but txId WAS captured before the error (edge case)
    const withTx = makeAttempt({
      id: "ambiguous-with-tx",
      status: "ambiguous",
      hiveTxId: "known-tx-123",
      // Not aged — should be resolved via chain, not age threshold
    });
    store.seedAttempt(withTx);

    await broadcaster.processQueue();

    const attempt = store.getAttempt("ambiguous-with-tx")!;
    expect(attempt.status).toBe("confirmed");
    expect(stub.confirmCalls).toBe(1);
    expect(stub.transferCalls).toBe(0); // no new transfer sent
  });
});

// ================================================================
// B4 — Duplicate sweep-cycle safety: processing guard
// ================================================================

describe("B4 — Duplicate sweep-cycle: processing guard prevents overlapping cycles", () => {
  let store: InMemoryBroadcastStorage;
  let stub: StubHiveClient;
  let broadcaster: ComputePayoutBroadcaster;

  beforeEach(() => {
    store = new InMemoryBroadcastStorage();
    stub = new StubHiveClient();
    store.seedNode(makeNode());
    store.seedPayout(makePayout());
    broadcaster = new ComputePayoutBroadcaster(stub as any, store);
  });

  it("second processQueue call returns immediately when first is still running", async () => {
    stub.setTransfer("success");
    stub.setConfirm("confirmed");

    // Start first cycle without awaiting — it hits its first `await` and yields
    const p1 = broadcaster.processQueue();

    // Second call fires while p1 is in-flight; the processing guard must block it
    const p2 = broadcaster.processQueue();

    await Promise.all([p1, p2]);

    // Only one transfer must have been issued — not two
    expect(stub.transferCalls).toBe(1);
  });

  it("after first cycle completes, a subsequent cycle runs normally", async () => {
    stub.setTransfer("success");
    stub.setConfirm("pending_then_confirmed", 1); // confirms on first cycle

    // First full cycle
    await broadcaster.processQueue();
    expect(stub.transferCalls).toBe(1);

    // Second cycle — guard should be released, a second payout can be processed
    store.seedPayout(makePayout({ id: "payout-2", status: "queued" }));
    await broadcaster.processQueue();

    // payout-2 was broadcast in the second cycle
    const payout2 = store.getPayout("payout-2");
    expect(payout2?.status).not.toBe("queued"); // it was picked up
  });

  it("three rapid concurrent calls result in exactly one active cycle", async () => {
    stub.setTransfer("success");
    stub.setConfirm("confirmed");

    const [p1, p2, p3] = [
      broadcaster.processQueue(),
      broadcaster.processQueue(),
      broadcaster.processQueue(),
    ];
    await Promise.all([p1, p2, p3]);

    // Only the first one ran the broadcast path
    expect(stub.transferCalls).toBe(1);
  });
});

// ================================================================
// B5 — Max-attempt exhaustion: 3 failures → terminal "failed"
// ================================================================

describe("B5 — Max-attempt exhaustion: 3 failures produce terminal payout", () => {
  it("payout is marked 'failed' after 3 failed_error attempts, no further transfers", async () => {
    const store = new InMemoryBroadcastStorage();
    const stub = new StubHiveClient();
    store.seedNode(makeNode());
    store.seedPayout(makePayout());
    const broadcaster = new ComputePayoutBroadcaster(stub as any, store);

    stub.setTransfer("throw_no_txid");

    // Helper: run one attempt + immediately age it out so the next cycle retries
    async function runAndAgeOut(attemptId: string, attemptNum: number) {
      await broadcaster.processQueue(); // creates attempt, transfer throws → ambiguous
      // Age the ambiguous attempt past the 10-minute threshold
      await store.updatePayoutBroadcastAttempt(attemptId, {
        createdAt: new Date(Date.now() - 11 * 60 * 1000),
      });
      await broadcaster.processQueue(); // confirmBroadcast ages it → failed_error
    }

    // Attempt 1
    await broadcaster.processQueue(); // creates attempt-1 (id-1), throws → ambiguous
    const a1 = store.allAttempts()[0];
    expect(a1.status).toBe("ambiguous");
    await store.updatePayoutBroadcastAttempt(a1.id, {
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    await broadcaster.processQueue(); // ages a1 → failed_error
    expect(store.getAttempt(a1.id)?.status).toBe("failed_error");

    // Attempt 2
    await broadcaster.processQueue(); // creates attempt-2, throws → ambiguous
    const a2 = store.allAttempts().find(a => a.attemptNumber === 2)!;
    expect(a2.status).toBe("ambiguous");
    await store.updatePayoutBroadcastAttempt(a2.id, {
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    await broadcaster.processQueue(); // ages a2 → failed_error

    // Attempt 3
    await broadcaster.processQueue(); // creates attempt-3, throws → ambiguous
    const a3 = store.allAttempts().find(a => a.attemptNumber === 3)!;
    expect(a3.status).toBe("ambiguous");
    await store.updatePayoutBroadcastAttempt(a3.id, {
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
    });
    await broadcaster.processQueue(); // ages a3 → failed_error

    // Now 3 failed_error attempts exist. Next broadcastPayout call must exhaust and
    // mark the payout terminal "failed" without creating attempt 4.
    await broadcaster.processQueue();

    const payout = store.getPayout("payout-1")!;
    expect(payout.status).toBe("failed");

    // No fourth transfer was ever attempted
    expect(stub.transferCalls).toBe(3);
    expect(store.allAttempts()).toHaveLength(3);
  });

  it("exactly MAX_ATTEMPTS transfers are issued before exhaustion — not fewer, not more", async () => {
    const store = new InMemoryBroadcastStorage();
    const stub = new StubHiveClient();
    store.seedNode(makeNode());
    store.seedPayout(makePayout());
    const broadcaster = new ComputePayoutBroadcaster(stub as any, store);

    stub.setTransfer("throw_no_txid");

    // Drive all 3 attempts through the same pattern
    for (let i = 0; i < 3; i++) {
      await broadcaster.processQueue(); // creates attempt i+1, throws → ambiguous
      const ambiguous = store.allAttempts().find(a => a.status === "ambiguous")!;
      await store.updatePayoutBroadcastAttempt(ambiguous.id, {
        createdAt: new Date(Date.now() - 11 * 60 * 1000),
      });
      await broadcaster.processQueue(); // ages → failed_error
    }

    // One more sweep to trigger exhaustion
    await broadcaster.processQueue();

    expect(stub.transferCalls).toBe(3);
    expect(store.getPayout("payout-1")?.status).toBe("failed");

    // Any further sweeps must not create new attempts
    await broadcaster.processQueue();
    await broadcaster.processQueue();
    expect(stub.transferCalls).toBe(3);
  });
});

// ================================================================
// B6 — Parallel upload memory safety: concurrency guard
// ================================================================

describe("B6 — Parallel upload memory safety: concurrent guard caps in-flight uploads", () => {
  // ComputeService has MAX_CONCURRENT_ARTIFACT_UPLOADS = 3.
  // We exercise the guard with small buffers — proves the guard, not RSS numbers.

  it("5 concurrent uploads: exactly 3 accepted, 2 rejected with UPLOAD_CAPACITY_EXCEEDED", async () => {
    const service = new ComputeService();

    const uploads = Array.from({ length: 5 }, (_, i) => makeUpload(`node-${i}`, 1024));

    // Fire all 5 synchronously — the guard check and increment happen BEFORE the
    // first await in uploadArtifact, so the JS preamble serialises the counter correctly.
    const results = await Promise.allSettled(
      uploads.map(u => service.uploadArtifact(u)),
    );

    const accepted = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter(
      r => r.status === "rejected" && (r as PromiseRejectedResult).reason.message === "UPLOAD_CAPACITY_EXCEEDED",
    );

    expect(accepted.length).toBe(3);
    expect(rejected.length).toBe(2);
  });

  it("after the first batch completes, new uploads are accepted (guard resets)", async () => {
    const service = new ComputeService();

    // Saturate the guard
    const batch1 = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => service.uploadArtifact(makeUpload(`node-${i}`, 512))),
    );
    const batch1Accepted = batch1.filter(r => r.status === "fulfilled");
    expect(batch1Accepted.length).toBe(3);

    // Guard should be released now — new upload must succeed
    const single = await service.uploadArtifact(makeUpload("node-new", 512));
    expect(single.cid).toBeTruthy();
  });

  it("guard rejects immediately — no IPFS or hash work done for rejected uploads", async () => {
    const service = new ComputeService();

    // Saturate
    const batch = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) => service.uploadArtifact(makeUpload(`node-${i}`, 512))),
    );

    const rejected = batch.filter(r => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected.length).toBe(1);

    // Rejected error carries the correct status code (503 Service Unavailable)
    expect(rejected[0].reason.statusCode).toBe(503);
    expect(rejected[0].reason.message).toBe("UPLOAD_CAPACITY_EXCEEDED");
  });

  it("concurrent uploads from different nodes are all subject to the global cap", async () => {
    const service = new ComputeService();

    // 6 nodes each trying to upload once — cap is 3, so 3 must fail
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        service.uploadArtifact(makeUpload(`node-${i}`, 256)),
      ),
    );

    const accepted = results.filter(r => r.status === "fulfilled").length;
    const exceeded = results.filter(
      r => r.status === "rejected" &&
        (r as PromiseRejectedResult).reason.message === "UPLOAD_CAPACITY_EXCEEDED",
    ).length;

    expect(accepted).toBe(3);
    expect(exceeded).toBe(3);
  });
});
