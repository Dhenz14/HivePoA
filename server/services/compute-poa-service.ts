/**
 * GPU Proof-of-Allocation (PoA) Challenge Service
 *
 * Periodically issues directed eval_sweep benchmark jobs to online GPU nodes
 * to verify they are actually running the hardware they claim to offer.
 *
 * Protocol:
 *   1. runSweep()             — select cooldown-eligible nodes, issue one challenge job each
 *   2. processResults()       — settle accepted/rejected challenge jobs → rep delta
 *   3. processExpiredChallenges() — unclaimed jobs past timeout → node warning
 *
 * Reputation effects (clamped [0, 100]):
 *   - Challenge accepted  → +5
 *   - Challenge rejected  → −10
 *   - Unclaimed (expired) → 0 (logged; left for human review)
 *
 * No HBD is transferred for PoA challenges (budgetHbd = "0.000").
 */
import { createHash } from "crypto";
import { storage } from "../storage";
import { logCompute } from "../logger";
import type { ComputeJob, ComputeNode } from "@shared/schema";

// Sweep intervals
const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes (prod)
const DEV_SWEEP_INTERVAL_MS = 2 * 60 * 1000;       // 2 minutes (dev)

// How long before a node is re-eligible for a challenge
const CHALLENGE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// How long to wait for a node to claim a directed challenge before logging it as expired
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// Nodes to challenge per sweep cycle
const CHALLENGE_BATCH_SIZE = 10;

// Coordinator identity (mirrors poa-engine.ts pattern)
const COORDINATOR_USERNAME = process.env.POA_COORDINATOR_USERNAME ?? "validator-police";

// Reputation deltas
const REP_PASS = 5;
const REP_FAIL = -10;

/**
 * Minimal storage interface used by the PoA service.
 * Injected in production, replaced in tests.
 */
export interface PoaStorage {
  getNodesForPoaChallenge(cooldownMs: number, limit?: number): Promise<ComputeNode[]>;
  stampNodePoaChallenge(nodeId: string, at: Date): Promise<void>;
  createComputeJob(job: any): Promise<ComputeJob>;
  getSettledPoaJobs(coordinatorUsername: string, since: Date): Promise<ComputeJob[]>;
  getExpiredPoaJobs(coordinatorUsername: string, claimTimeoutMs: number): Promise<ComputeJob[]>;
  updateComputeJobState(id: string, state: string, extra?: any): Promise<void>;
  adjustComputeNodeReputation(id: string, delta: number): Promise<void>;
}

/** Minimal probe manifest for a PoA challenge (immutable per version). */
function makePoaManifest(nodeId: string, challengeNonce: string): { json: string; sha256: string } {
  const obj = {
    type: "eval_sweep",
    poa_challenge: true,
    target_node_id: nodeId,
    challenge_nonce: challengeNonce,
    model: "poa-probe-v1",
    dataset_cid: null,
    runtime: "any",
    max_tokens: 128,
  };
  const json = JSON.stringify(obj);
  const sha256 = createHash("sha256").update(json).digest("hex");
  return { json, sha256 };
}

export class ComputePoaService {
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private storage: PoaStorage;
  private lastResultsSince: Date;
  private running = false;

  constructor(injectedStorage?: PoaStorage) {
    this.storage = injectedStorage ?? (storage as unknown as PoaStorage);
    // On startup look back 2 × cooldown so we don't miss any settled jobs from the previous session
    this.lastResultsSince = new Date(Date.now() - 2 * CHALLENGE_COOLDOWN_MS);
  }

  start(): void {
    const interval = process.env.NODE_ENV === "production"
      ? DEFAULT_SWEEP_INTERVAL_MS
      : DEV_SWEEP_INTERVAL_MS;

    this.sweepTimer = setInterval(() => this.sweep(), interval);
    logCompute.info({ interval }, "ComputePoaService started");
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Run all three phases in sequence. Called by the interval timer. */
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.processResults();
      await this.processExpiredChallenges();
      await this.runSweep();
    } catch (err) {
      logCompute.error({ err }, "ComputePoaService sweep failed");
    } finally {
      this.running = false;
    }
  }

  // ================================================================
  // Phase 1: Issue challenge jobs to cooldown-eligible nodes
  // ================================================================

  async runSweep(): Promise<void> {
    const nodes = await this.storage.getNodesForPoaChallenge(CHALLENGE_COOLDOWN_MS, CHALLENGE_BATCH_SIZE);
    if (nodes.length === 0) return;

    logCompute.info({ count: nodes.length }, "GPU PoA: issuing challenge jobs");

    for (const node of nodes) {
      try {
        await this.issueChallenge(node);
      } catch (err) {
        logCompute.error({ err, nodeId: node.id }, "GPU PoA: failed to issue challenge");
      }
    }
  }

  private async issueChallenge(node: ComputeNode): Promise<void> {
    const challengeNonce = `${node.id}:${Date.now()}`;
    const { json: manifestJson, sha256: manifestSha256 } = makePoaManifest(node.id, challengeNonce);

    await this.storage.createComputeJob({
      creatorUsername: COORDINATOR_USERNAME,
      workloadType: "eval_sweep",
      state: "queued",
      priority: 10, // Higher priority than regular market jobs so node sees it promptly
      manifestJson,
      manifestSha256,
      minVramGb: 0,  // Accept any VRAM — we're targeting a specific node
      requiredModels: "",
      budgetHbd: "0.000",
      reservedBudgetHbd: "0.000",
      leaseSeconds: 300, // 5 minutes to complete the probe
      maxAttempts: 1,    // Single-shot — no retry for PoA challenges
      targetNodeId: node.id,
      deadlineAt: new Date(Date.now() + CLAIM_TIMEOUT_MS + 300_000), // claim window + lease
    });

    await this.storage.stampNodePoaChallenge(node.id, new Date());

    logCompute.info(
      { nodeId: node.id, hiveUsername: node.hiveUsername },
      "GPU PoA: challenge issued",
    );
  }

  // ================================================================
  // Phase 2: Apply reputation effects from settled challenge jobs
  // ================================================================

  async processResults(): Promise<void> {
    const since = this.lastResultsSince;
    const now = new Date();
    const settled = await this.storage.getSettledPoaJobs(COORDINATOR_USERNAME, since);

    if (settled.length === 0) {
      this.lastResultsSince = now;
      return;
    }

    logCompute.info({ count: settled.length }, "GPU PoA: processing settled challenge jobs");

    for (const job of settled) {
      if (!job.targetNodeId) continue;
      try {
        await this.applyReputation(job);
      } catch (err) {
        logCompute.error({ err, jobId: job.id }, "GPU PoA: failed to apply reputation");
      }
    }

    this.lastResultsSince = now;
  }

  private async applyReputation(job: ComputeJob): Promise<void> {
    const nodeId = job.targetNodeId!;

    if (job.state === "accepted") {
      await this.storage.adjustComputeNodeReputation(nodeId, REP_PASS);
      logCompute.info({ jobId: job.id, nodeId, delta: REP_PASS }, "GPU PoA: PASS → reputation +5");
    } else if (job.state === "rejected") {
      await this.storage.adjustComputeNodeReputation(nodeId, REP_FAIL);
      logCompute.warn({ jobId: job.id, nodeId, delta: REP_FAIL }, "GPU PoA: FAIL → reputation −10");
    }
  }

  // ================================================================
  // Phase 3: Log nodes that never claimed their challenge
  // ================================================================

  async processExpiredChallenges(): Promise<void> {
    const expired = await this.storage.getExpiredPoaJobs(COORDINATOR_USERNAME, CLAIM_TIMEOUT_MS);
    if (expired.length === 0) return;

    logCompute.warn({ count: expired.length }, "GPU PoA: unclaimed challenge jobs detected");

    for (const job of expired) {
      logCompute.warn(
        { jobId: job.id, nodeId: job.targetNodeId, createdAt: job.createdAt },
        "GPU PoA: node did not claim challenge within timeout — node may be offline",
      );
      // Cancel the expired job so it doesn't accumulate in the queue
      await this.storage.updateComputeJobState(job.id, "cancelled", { cancelledAt: new Date() });
    }
  }
}

export const computePoaService = new ComputePoaService();
