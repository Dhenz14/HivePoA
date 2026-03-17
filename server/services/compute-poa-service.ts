/**
 * Directed Protocol-Conformance Challenge Service
 *
 * Periodically issues directed eval_sweep jobs to online GPU nodes to verify
 * that workers are correctly speaking the task protocol within the lease window.
 *
 * Current acceptance semantics: worker protocol conformance (claim, nonce, submit
 * within lease, structurally acceptable result). NOT hardware proof.
 * Hardware-capability verification is deferred to Phase 2.
 *
 * Challenge lifecycle:
 *   1. runSweep()                  — select cooldown-eligible nodes → issue one directed job each
 *   2. processResults()            — score accepted/rejected results → reputation delta (exact-once)
 *   3. processExpiredChallenges()  — cancel unclaimed jobs past timeout → log for human review
 *
 * Reputation effects (clamped [0, 100]):
 *   - Challenge accepted  → +5
 *   - Challenge rejected  → −10
 *   - Unclaimed (expired) → no change (conservative; left for human review)
 *
 * Exact-once scoring: each result is scored atomically via scoreComplianceChallengeAtomic(),
 * which commits poaScoredAt and the reputation mutation in a single transaction.
 * Safe on process restart — already-scored jobs are skipped by the DB filter.
 *
 * No HBD is transferred for compliance challenges (budgetHbd = "0.000").
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

// How long to wait for a node to claim a directed challenge before cancellation
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// Nodes to challenge per sweep cycle
const CHALLENGE_BATCH_SIZE = 10;

// Coordinator identity (mirrors poa-engine.ts pattern)
const COORDINATOR_USERNAME = process.env.POA_COORDINATOR_USERNAME ?? "validator-police";

// Reputation deltas
const REP_PASS = 5;
const REP_FAIL = -10;

/**
 * Minimal storage interface used by the challenge service.
 * Injected in production, replaced in tests.
 */
export interface ComplianceChallengeStorage {
  getNodesForPoaChallenge(cooldownMs: number, limit?: number): Promise<ComputeNode[]>;
  stampNodePoaChallenge(nodeId: string, at: Date): Promise<void>;
  createComputeJob(job: any): Promise<ComputeJob>;
  getUnscoredComplianceChallengeResults(coordinatorUsername: string): Promise<ComputeJob[]>;
  getExpiredPoaJobs(coordinatorUsername: string, claimTimeoutMs: number): Promise<ComputeJob[]>;
  updateComputeJobState(id: string, state: string, extra?: any): Promise<void>;
  scoreComplianceChallengeAtomic(jobId: string, nodeId: string, delta: number): Promise<boolean>;
}

/** Probe manifest for a directed compliance challenge. */
function makeChallengeManifest(nodeId: string, challengeNonce: string): { json: string; sha256: string } {
  const obj = {
    type: "eval_sweep",
    compliance_challenge: true,
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
  private storage: ComplianceChallengeStorage;
  private running = false;

  constructor(injectedStorage?: ComplianceChallengeStorage) {
    this.storage = injectedStorage ?? (storage as unknown as ComplianceChallengeStorage);
  }

  start(): void {
    const interval = process.env.NODE_ENV === "production"
      ? DEFAULT_SWEEP_INTERVAL_MS
      : DEV_SWEEP_INTERVAL_MS;

    this.sweepTimer = setInterval(() => this.sweep(), interval);
    logCompute.info({ interval }, "ComplianceChallengeService started");
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
      logCompute.error({ err }, "ComplianceChallengeService sweep failed");
    } finally {
      this.running = false;
    }
  }

  // ================================================================
  // Phase 1: Issue directed challenge jobs to cooldown-eligible nodes
  // ================================================================

  async runSweep(): Promise<void> {
    const nodes = await this.storage.getNodesForPoaChallenge(CHALLENGE_COOLDOWN_MS, CHALLENGE_BATCH_SIZE);
    if (nodes.length === 0) return;

    logCompute.info({ count: nodes.length }, "ComplianceChallenge: issuing directed challenge jobs");

    for (const node of nodes) {
      try {
        await this.issueChallenge(node);
      } catch (err) {
        logCompute.error({ err, nodeId: node.id }, "ComplianceChallenge: failed to issue challenge");
      }
    }
  }

  private async issueChallenge(node: ComputeNode): Promise<void> {
    const challengeNonce = `${node.id}:${Date.now()}`;
    const { json: manifestJson, sha256: manifestSha256 } = makeChallengeManifest(node.id, challengeNonce);

    await this.storage.createComputeJob({
      creatorUsername: COORDINATOR_USERNAME,
      workloadType: "eval_sweep",
      state: "queued",
      priority: 10, // Higher priority than regular market jobs so node sees it promptly
      manifestJson,
      manifestSha256,
      minVramGb: 0,  // Accept any VRAM — targeting a specific node
      requiredModels: "",
      budgetHbd: "0.000",
      reservedBudgetHbd: "0.000",
      leaseSeconds: 300, // 5 minutes to complete the probe
      maxAttempts: 1,    // Single-shot — no retry for compliance challenges
      targetNodeId: node.id,
      deadlineAt: new Date(Date.now() + CLAIM_TIMEOUT_MS + 300_000), // claim window + lease
    });

    await this.storage.stampNodePoaChallenge(node.id, new Date());

    logCompute.info(
      { nodeId: node.id, hiveUsername: node.hiveUsername },
      "ComplianceChallenge: directed challenge issued",
    );
  }

  // ================================================================
  // Phase 2: Score settled challenge results (exact-once via DB)
  // ================================================================

  async processResults(): Promise<void> {
    // getUnscoredComplianceChallengeResults filters by poaScoredAt IS NULL — restart-safe.
    // No in-memory watermark needed; the DB column is the durable dedup key.
    const unscored = await this.storage.getUnscoredComplianceChallengeResults(COORDINATOR_USERNAME);
    if (unscored.length === 0) return;

    logCompute.info({ count: unscored.length }, "ComplianceChallenge: scoring settled results");

    for (const job of unscored) {
      if (!job.targetNodeId) continue;
      try {
        await this.applyReputationDelta(job);
      } catch (err) {
        logCompute.error({ err, jobId: job.id }, "ComplianceChallenge: failed to score result");
      }
    }
  }

  private async applyReputationDelta(job: ComputeJob): Promise<void> {
    const nodeId = job.targetNodeId!;
    let delta: number;

    if (job.state === "accepted") {
      delta = REP_PASS;
    } else if (job.state === "rejected") {
      delta = REP_FAIL;
    } else {
      return;
    }

    // Atomic: poaScoredAt + reputation mutation in one transaction.
    // Returns false if already scored (e.g., restart raced with prior run).
    const scored = await this.storage.scoreComplianceChallengeAtomic(job.id, nodeId, delta);
    if (!scored) {
      logCompute.info({ jobId: job.id, nodeId }, "ComplianceChallenge: already scored — skipped");
      return;
    }

    if (delta > 0) {
      logCompute.info({ jobId: job.id, nodeId, delta }, "ComplianceChallenge: PASS → reputation +5");
    } else {
      logCompute.warn({ jobId: job.id, nodeId, delta }, "ComplianceChallenge: FAIL → reputation −10");
    }
  }

  // ================================================================
  // Phase 3: Cancel unclaimed challenges past timeout
  // ================================================================

  async processExpiredChallenges(): Promise<void> {
    const expired = await this.storage.getExpiredPoaJobs(COORDINATOR_USERNAME, CLAIM_TIMEOUT_MS);
    if (expired.length === 0) return;

    logCompute.warn({ count: expired.length }, "ComplianceChallenge: unclaimed directed challenges detected");

    for (const job of expired) {
      logCompute.warn(
        { jobId: job.id, nodeId: job.targetNodeId, createdAt: job.createdAt },
        "ComplianceChallenge: node did not claim challenge within timeout — node may be offline",
      );
      // Cancel to prevent queue accumulation; no reputation change (conservative default)
      await this.storage.updateComputeJobState(job.id, "cancelled", { cancelledAt: new Date() });
    }
  }
}

export const computePoaService = new ComputePoaService();
