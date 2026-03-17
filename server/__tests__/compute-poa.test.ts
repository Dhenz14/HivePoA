/**
 * GPU PoA Challenge Service — Adversarial Tests
 *
 * Covers:
 *   P1 — Challenge directed to correct node only (targetNodeId enforcement)
 *   P2 — Reputation: accepted challenge → +5 (clamped at 100)
 *   P3 — Reputation: rejected challenge → −10 (clamped at 0)
 *   P4 — Expired unclaimed challenge → job cancelled, no rep change
 *   P5 — Cooldown: node not re-challenged within cooldown window
 *   P6 — Concurrency guard: sweep() is idempotent under re-entrant call
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ComputePoaService } from "../services/compute-poa-service";
import type { PoaStorage } from "../services/compute-poa-service";
import type { ComputeJob, ComputeNode } from "@shared/schema";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<ComputeNode> = {}): ComputeNode {
  return {
    id: `node-${Math.random().toString(36).slice(2)}`,
    nodeInstanceId: "inst-1",
    hiveUsername: "gpu-lender-1",
    status: "online",
    gpuModel: "RTX 4090",
    vramGb: 24,
    gpuCount: 1,
    cpuCores: 16,
    ramGb: 64,
    storageGb: 500,
    networkMbps: 1000,
    supportedWorkloadTypes: "eval_sweep,benchmark_run",
    pricePerHourHbd: "0.50",
    reputationScore: 50,
    totalJobsCompleted: 0,
    totalJobsFailed: 0,
    totalHbdEarned: "0",
    lastHeartbeatAt: null,
    lastPoaChallengeAt: null,
    jobsInProgress: 0,
    endpoint: null,
    createdAt: new Date(),
    ...overrides,
  } as ComputeNode;
}

function makeJob(overrides: Partial<ComputeJob> = {}): ComputeJob {
  return {
    id: `job-${Math.random().toString(36).slice(2)}`,
    creatorUsername: "validator-police",
    workloadType: "eval_sweep",
    state: "accepted",
    priority: 10,
    manifestJson: "{}",
    manifestSha256: "abc",
    minVramGb: 0,
    requiredModels: "",
    budgetHbd: "0.000",
    reservedBudgetHbd: "0.000",
    leaseSeconds: 300,
    maxAttempts: 1,
    attemptCount: 1,
    verificationPolicyJson: null,
    targetNodeId: null,
    acceptedAttemptId: null,
    deadlineAt: null,
    cancelledAt: null,
    completedAt: new Date(),
    createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago
    ...overrides,
  } as ComputeJob;
}

// ── In-memory PoaStorage ──────────────────────────────────────────────────────

class InMemoryPoaStorage implements PoaStorage {
  nodes: Map<string, ComputeNode> = new Map();
  jobs: ComputeJob[] = [];
  reputationAdjustments: Array<{ id: string; delta: number }> = [];
  cancelledJobs: string[] = [];
  stampedNodes: Array<{ nodeId: string; at: Date }> = [];
  createdJobs: any[] = [];

  async getNodesForPoaChallenge(cooldownMs: number, limit = 10): Promise<ComputeNode[]> {
    const cutoff = new Date(Date.now() - cooldownMs);
    return [...this.nodes.values()]
      .filter(n =>
        n.status === "online" &&
        (n.lastPoaChallengeAt === null || new Date(n.lastPoaChallengeAt) < cutoff),
      )
      .slice(0, limit);
  }

  async stampNodePoaChallenge(nodeId: string, at: Date): Promise<void> {
    this.stampedNodes.push({ nodeId, at });
    const node = this.nodes.get(nodeId);
    if (node) node.lastPoaChallengeAt = at;
  }

  async createComputeJob(job: any): Promise<ComputeJob> {
    const created = makeJob({ ...job, id: `job-${Math.random().toString(36).slice(2)}` });
    this.createdJobs.push(job);
    this.jobs.push(created);
    return created;
  }

  async getSettledPoaJobs(coordinatorUsername: string, since: Date): Promise<ComputeJob[]> {
    return this.jobs.filter(j =>
      j.creatorUsername === coordinatorUsername &&
      j.targetNodeId !== null &&
      (j.state === "accepted" || j.state === "rejected") &&
      j.completedAt !== null &&
      new Date(j.completedAt) >= since,
    );
  }

  async getExpiredPoaJobs(coordinatorUsername: string, claimTimeoutMs: number): Promise<ComputeJob[]> {
    const cutoff = new Date(Date.now() - claimTimeoutMs);
    return this.jobs.filter(j =>
      j.creatorUsername === coordinatorUsername &&
      j.targetNodeId !== null &&
      j.state === "queued" &&
      new Date(j.createdAt) < cutoff,
    );
  }

  async updateComputeJobState(id: string, state: string, extra?: any): Promise<void> {
    const job = this.jobs.find(j => j.id === id);
    if (job) {
      (job as any).state = state;
      if (extra?.cancelledAt) (job as any).cancelledAt = extra.cancelledAt;
      this.cancelledJobs.push(id);
    }
  }

  async adjustComputeNodeReputation(id: string, delta: number): Promise<void> {
    this.reputationAdjustments.push({ id, delta });
    const node = this.nodes.get(id);
    if (node) {
      node.reputationScore = Math.max(0, Math.min(100, node.reputationScore + delta));
    }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GPU PoA Challenge Service", () => {
  let store: InMemoryPoaStorage;
  let svc: ComputePoaService;

  beforeEach(() => {
    store = new InMemoryPoaStorage();
    svc = new ComputePoaService(store);
  });

  // P1 — runSweep: creates one directed job per eligible node
  describe("P1 — runSweep: directed challenge creation", () => {
    it("creates one job per eligible node with targetNodeId set", async () => {
      const n1 = makeNode({ id: "n1" });
      const n2 = makeNode({ id: "n2" });
      store.nodes.set("n1", n1);
      store.nodes.set("n2", n2);

      await svc.runSweep();

      expect(store.createdJobs).toHaveLength(2);
      const targets = store.createdJobs.map(j => j.targetNodeId);
      expect(targets).toContain("n1");
      expect(targets).toContain("n2");
    });

    it("sets budgetHbd = '0.000' — no payment for PoA challenges", async () => {
      store.nodes.set("n1", makeNode({ id: "n1" }));
      await svc.runSweep();
      expect(store.createdJobs[0].budgetHbd).toBe("0.000");
    });

    it("sets workloadType = 'eval_sweep'", async () => {
      store.nodes.set("n1", makeNode({ id: "n1" }));
      await svc.runSweep();
      expect(store.createdJobs[0].workloadType).toBe("eval_sweep");
    });

    it("stamps node lastPoaChallengeAt after issuing challenge", async () => {
      store.nodes.set("n1", makeNode({ id: "n1" }));
      await svc.runSweep();
      expect(store.stampedNodes).toHaveLength(1);
      expect(store.stampedNodes[0].nodeId).toBe("n1");
    });

    it("does not challenge offline nodes", async () => {
      store.nodes.set("n1", makeNode({ id: "n1", status: "offline" as any }));
      store.nodes.set("n2", makeNode({ id: "n2", status: "online" }));
      await svc.runSweep();
      expect(store.createdJobs).toHaveLength(1);
      expect(store.createdJobs[0].targetNodeId).toBe("n2");
    });

    it("does not re-challenge a node still within cooldown", async () => {
      const recent = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago (< 1 hr cooldown)
      store.nodes.set("n1", makeNode({ id: "n1", lastPoaChallengeAt: recent }));
      await svc.runSweep();
      expect(store.createdJobs).toHaveLength(0);
    });

    it("re-challenges a node whose cooldown has expired", async () => {
      const old = new Date(Date.now() - 90 * 60 * 1000); // 90 min ago (> 1 hr cooldown)
      store.nodes.set("n1", makeNode({ id: "n1", lastPoaChallengeAt: old }));
      await svc.runSweep();
      expect(store.createdJobs).toHaveLength(1);
    });

    it("skips nodes when no eligible nodes exist", async () => {
      await svc.runSweep();
      expect(store.createdJobs).toHaveLength(0);
    });
  });

  // P2/P3 — processResults: reputation deltas
  describe("P2/P3 — processResults: reputation effects", () => {
    it("P2: accepted challenge → reputation +5", async () => {
      store.nodes.set("n1", makeNode({ id: "n1", reputationScore: 50 }));
      store.jobs.push(makeJob({ state: "accepted", targetNodeId: "n1", completedAt: new Date() }));

      await svc.processResults();

      expect(store.reputationAdjustments).toHaveLength(1);
      expect(store.reputationAdjustments[0]).toEqual({ id: "n1", delta: 5 });
      expect(store.nodes.get("n1")!.reputationScore).toBe(55);
    });

    it("P3: rejected challenge → reputation −10", async () => {
      store.nodes.set("n1", makeNode({ id: "n1", reputationScore: 50 }));
      store.jobs.push(makeJob({ state: "rejected", targetNodeId: "n1", completedAt: new Date() }));

      await svc.processResults();

      expect(store.reputationAdjustments[0]).toEqual({ id: "n1", delta: -10 });
      expect(store.nodes.get("n1")!.reputationScore).toBe(40);
    });

    it("P2: reputation clamped at 100 for accepted", async () => {
      store.nodes.set("n1", makeNode({ id: "n1", reputationScore: 98 }));
      store.jobs.push(makeJob({ state: "accepted", targetNodeId: "n1", completedAt: new Date() }));

      await svc.processResults();

      // delta is applied; storage clamps; our in-memory impl clamps too
      const node = store.nodes.get("n1")!;
      expect(node.reputationScore).toBe(100);
    });

    it("P3: reputation clamped at 0 for rejected", async () => {
      store.nodes.set("n1", makeNode({ id: "n1", reputationScore: 5 }));
      store.jobs.push(makeJob({ state: "rejected", targetNodeId: "n1", completedAt: new Date() }));

      await svc.processResults();

      expect(store.nodes.get("n1")!.reputationScore).toBe(0);
    });

    it("ignores jobs without targetNodeId (non-PoA jobs)", async () => {
      store.jobs.push(makeJob({ state: "accepted", targetNodeId: null, completedAt: new Date() }));
      await svc.processResults();
      expect(store.reputationAdjustments).toHaveLength(0);
    });

    it("does not reprocess the same settled job on a second call", async () => {
      store.nodes.set("n1", makeNode({ id: "n1", reputationScore: 50 }));
      // Set completedAt 500ms in the past so the first call's "now" timestamp is clearly after it,
      // meaning the second call's `since = T_first` will be > completedAt.
      const settled = makeJob({
        state: "accepted",
        targetNodeId: "n1",
        completedAt: new Date(Date.now() - 500),
      });
      store.jobs.push(settled);

      await svc.processResults(); // processes the job, advances lastResultsSince to ~now
      await svc.processResults(); // job.completedAt < lastResultsSince → not reprocessed

      expect(store.reputationAdjustments).toHaveLength(1); // only once
    });
  });

  // P4 — processExpiredChallenges: unclaimed jobs cancelled, no rep change
  describe("P4 — processExpiredChallenges: unclaimed job handling", () => {
    it("cancels expired queued challenge jobs", async () => {
      const oldJob = makeJob({
        state: "queued",
        targetNodeId: "n1",
        createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 min ago > 15 min timeout
        completedAt: null,
      });
      store.jobs.push(oldJob);

      await svc.processExpiredChallenges();

      expect(store.cancelledJobs).toContain(oldJob.id);
      const job = store.jobs.find(j => j.id === oldJob.id)!;
      expect(job.state).toBe("cancelled");
    });

    it("does not cancel jobs still within claim timeout", async () => {
      const recentJob = makeJob({
        state: "queued",
        targetNodeId: "n1",
        createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 min ago < 15 min timeout
        completedAt: null,
      });
      store.jobs.push(recentJob);

      await svc.processExpiredChallenges();

      expect(store.cancelledJobs).toHaveLength(0);
    });

    it("does not apply reputation adjustment for expired/unclaimed jobs", async () => {
      const oldJob = makeJob({
        state: "queued",
        targetNodeId: "n1",
        createdAt: new Date(Date.now() - 20 * 60 * 1000),
        completedAt: null,
      });
      store.jobs.push(oldJob);

      await svc.processExpiredChallenges();

      expect(store.reputationAdjustments).toHaveLength(0);
    });
  });

  // P5 — Cooldown: stamp prevents re-challenge
  describe("P5 — Cooldown enforcement", () => {
    it("stamps prevent re-challenge within cooldown", async () => {
      store.nodes.set("n1", makeNode({ id: "n1" }));

      await svc.runSweep(); // issues challenge + stamps node

      store.createdJobs.length = 0; // clear tracking

      await svc.runSweep(); // second sweep — node is within cooldown

      expect(store.createdJobs).toHaveLength(0);
    });
  });

  // P6 — Concurrency guard
  describe("P6 — Concurrency guard", () => {
    it("concurrent sweep() calls are idempotent — second is a no-op", async () => {
      store.nodes.set("n1", makeNode({ id: "n1" }));

      // Simulate concurrent calls — both fire, but second should detect running=true
      const p1 = svc.sweep();
      const p2 = svc.sweep(); // should be a no-op since running=true
      await Promise.all([p1, p2]);

      // Only one sweep should have executed runSweep
      expect(store.createdJobs).toHaveLength(1);
    });
  });
});
