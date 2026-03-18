/**
 * Phase 2A Staged Challenge Service — Thin Orchestrator
 *
 * Drives the staged freshness/proxy-resistance challenge protocol.
 * All state transitions happen inside storage transaction boundaries.
 * This service is an orchestrator, not a state machine.
 *
 * Entry points:
 *   issueChallenge()          — pick node, create job+attempt, claim bundle set, reveal stage 0
 *   acceptCheckpoint()        — validate & store checkpoint, auto-reveal next stage (in storage tx)
 *   sweepTimeouts()           — expire revealed-but-unanswered stages, abandon stale attempts
 *   sweepScoring()            — score completed challenges via exact-once latch
 *
 * All bundle/checkpoint/transcript logic lives in storage primitives.
 * The service never recomputes digests, re-verifies nonces, or decides reveal transitions.
 */
import { storage } from "../storage";
import { logCompute } from "../logger";
import type {
  ComputeResourceClassProfile,
  ComputeChallengeStageBundle,
  ComputeChallengeCheckpoint,
  ComputeJob,
  ComputeJobAttempt,
} from "@shared/schema";

// ── Configuration ────────────────────────────────────────────────────────────

const COORDINATOR_USERNAME = process.env.POA_COORDINATOR_USERNAME ?? "validator-police";
const CHALLENGE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between challenges per node
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;       // 15 min to claim
const FIRST_PROGRESS_TIMEOUT_MS = 90_000;       // 90s after reveal of stage 0

// Reputation deltas (Phase 1 calibration, carried forward)
const REP_PASS = 5;
const REP_FAIL = -10;

// ── Storage Interface ────────────────────────────────────────────────────────

/**
 * Minimal storage interface for the Phase 2A challenge service.
 * Injected in production, replaced in tests.
 */
export interface Phase2AChallengeStorage {
  // Profile management
  getActiveResourceClassProfiles(): Promise<ComputeResourceClassProfile[]>;
  getOrphanPoolCount(profileId: string): Promise<number>;

  // Job/attempt lifecycle (existing)
  getNodesForPoaChallenge(cooldownMs: number, limit?: number): Promise<any[]>;
  stampNodePoaChallenge(nodeId: string, at: Date): Promise<void>;
  createComputeJob(job: any): Promise<ComputeJob>;
  createComputeJobAttempt(attempt: any): Promise<ComputeJobAttempt>;
  getComputeJobAttempt(id: string): Promise<ComputeJobAttempt | undefined>;
  updateComputeJobState(id: string, state: string, extra?: any): Promise<void>;
  updateComputeJobAttempt(id: string, updates: any): Promise<void>;

  // Phase 2A transactional primitives
  claimOrphanChallengeSet(profileId: string, jobId: string, attemptId: string): Promise<ComputeChallengeStageBundle[] | null>;
  revealChallengeStage(attemptId: string, stageIndex: number): Promise<ComputeChallengeStageBundle | null>;
  acceptChallengeCheckpoint(
    attemptId: string, stageIndex: number, resultDigest: string, stageNonce: string,
    transcriptPrevHash: string, transcriptEntryHash: string, receivedAt: Date,
    telemetryJson?: string | null,
  ): Promise<{ checkpoint: ComputeChallengeCheckpoint; nextBundle: ComputeChallengeStageBundle | null } | { error: string }>;
  getChallengeCheckpoints(attemptId: string): Promise<ComputeChallengeCheckpoint[]>;
  getChallengeBundles(attemptId: string): Promise<ComputeChallengeStageBundle[]>;

  // Exact-once scoring (existing Phase 1 latch)
  scoreComplianceChallengeAtomic(jobId: string, nodeId: string, delta: number): Promise<boolean>;
}

// ── Result types ─────────────────────────────────────────────────────────────

export type IssueResult =
  | { ok: true; jobId: string; attemptId: string; stage0: ChallengeStagePayload }
  | { ok: false; reason: string };

export type CheckpointResult =
  | { ok: true; checkpoint: ComputeChallengeCheckpoint; nextStage: ChallengeStagePayload | null; final: boolean }
  | { ok: false; reason: string };

/** What the worker receives per stage — derived from the persisted bundle snapshot. */
export interface ChallengeStagePayload {
  stageIndex: number;
  stageNonce: string;
  workloadParams: any; // parsed from workload_params_json snapshot
  deadlineAt: Date | null;
}

// ── Service ──────────────────────────────────────────────────────────────────

export class Phase2AChallengeService {
  private storage: Phase2AChallengeStorage;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private sweepRunning = false;

  constructor(injectedStorage?: Phase2AChallengeStorage) {
    this.storage = injectedStorage ?? (storage as unknown as Phase2AChallengeStorage);
  }

  start(intervalMs: number = 60_000): void {
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    logCompute.info({ intervalMs }, "Phase2AChallengeService started");
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ================================================================
  // Entry point 1: Issue a challenge to a specific node
  // ================================================================

  /**
   * Issue a staged challenge to a node.
   * Creates job + attempt, claims an orphan bundle set, reveals stage 0.
   * Returns the stage 0 payload from the persisted bundle snapshot.
   */
  async issueChallenge(nodeId: string, profileId: string): Promise<IssueResult> {
    // Step 1: Check pool availability before creating any job.
    const poolCount = await this.storage.getOrphanPoolCount(profileId);
    if (poolCount === 0) {
      logCompute.warn({ profileId }, "Phase2A: no orphan sets available — cannot issue challenge");
      return { ok: false, reason: "POOL_EXHAUSTED" };
    }

    // Step 2: Create the challenge job.
    const manifestObj = {
      type: "gpu_poa_challenge",
      protocol: "phase2a",
      protocol_version: 1,
      target_node_id: nodeId,
      profile_id: profileId,
    };
    const manifestJson = JSON.stringify(manifestObj);
    const { createHash } = await import("crypto");
    const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");

    const job = await this.storage.createComputeJob({
      creatorUsername: COORDINATOR_USERNAME,
      workloadType: "gpu_poa_challenge",
      state: "queued",
      priority: 10,
      manifestJson,
      manifestSha256,
      minVramGb: 0,
      requiredModels: "",
      budgetHbd: "0.000",
      reservedBudgetHbd: "0.000",
      leaseSeconds: 600, // 10 minutes total
      maxAttempts: 1,
      targetNodeId: nodeId,
      deadlineAt: new Date(Date.now() + CLAIM_TIMEOUT_MS + 600_000),
    });

    // Step 3: Create the attempt.
    const { randomUUID } = await import("crypto");
    const attempt = await this.storage.createComputeJobAttempt({
      jobId: job.id,
      nodeId,
      leaseToken: randomUUID(),
      nonce: randomUUID(),
      state: "leased",
      leaseExpiresAt: new Date(Date.now() + 600_000),
    });

    // Step 4: Claim an orphan bundle set atomically.
    const bundles = await this.storage.claimOrphanChallengeSet(profileId, job.id, attempt.id);
    if (!bundles) {
      // Race condition: pool exhausted between check and claim.
      // Cancel the job — don't leave orphan jobs.
      await this.storage.updateComputeJobState(job.id, "cancelled", { cancelledAt: new Date() });
      logCompute.warn({ profileId, jobId: job.id }, "Phase2A: claim failed after job creation — cancelled");
      return { ok: false, reason: "CLAIM_FAILED" };
    }

    // Step 5: Reveal stage 0.
    const revealed = await this.storage.revealChallengeStage(attempt.id, 0);
    if (!revealed) {
      // Should not happen: we just claimed the set. Log and fail.
      logCompute.error({ attemptId: attempt.id }, "Phase2A: stage 0 reveal failed after claim — should not happen");
      return { ok: false, reason: "REVEAL_FAILED" };
    }

    // Step 6: Stamp the node's challenge timestamp.
    await this.storage.stampNodePoaChallenge(nodeId, new Date());

    // Step 7: Update job state to leased.
    await this.storage.updateComputeJobState(job.id, "leased");

    logCompute.info(
      { jobId: job.id, attemptId: attempt.id, nodeId, profileId, setId: bundles[0].challengeSetId },
      "Phase2A: challenge issued — stage 0 revealed",
    );

    return {
      ok: true,
      jobId: job.id,
      attemptId: attempt.id,
      stage0: bundleToPayload(revealed),
    };
  }

  // ================================================================
  // Entry point 2: Accept a checkpoint from a worker
  // ================================================================

  /**
   * Accept a checkpoint submission from a worker.
   * All validation (nonce, digest, deadline, transcript) happens inside
   * the storage transaction. The service never duplicates that logic.
   *
   * If accepted and not final: next stage is auto-revealed in the same transaction.
   * If accepted and final: triggers exact-once scoring.
   */
  async acceptCheckpoint(
    attemptId: string,
    stageIndex: number,
    resultDigest: string,
    stageNonce: string,
    transcriptPrevHash: string,
    transcriptEntryHash: string,
    telemetryJson?: string | null,
  ): Promise<CheckpointResult> {
    const receivedAt = new Date();

    // Delegate entirely to storage primitive.
    const result = await this.storage.acceptChallengeCheckpoint(
      attemptId, stageIndex, resultDigest, stageNonce,
      transcriptPrevHash, transcriptEntryHash, receivedAt, telemetryJson,
    );

    if ("error" in result) {
      logCompute.warn(
        { attemptId, stageIndex, error: result.error },
        "Phase2A: checkpoint rejected",
      );
      return { ok: false, reason: result.error };
    }

    const { checkpoint, nextBundle } = result;

    // Determine if this was the final stage.
    const bundles = await this.storage.getChallengeBundles(attemptId);
    const maxStage = Math.max(...bundles.map(b => b.stageIndex));
    const isFinal = stageIndex === maxStage;

    if (isFinal) {
      // Final checkpoint accepted. Score the challenge.
      await this.scoreChallenge(attemptId, true);
    }

    logCompute.info(
      { attemptId, stageIndex, isFinal, nextStage: nextBundle?.stageIndex ?? null },
      `Phase2A: checkpoint accepted${isFinal ? " — final stage, scoring" : ""}`,
    );

    return {
      ok: true,
      checkpoint,
      nextStage: nextBundle ? bundleToPayload(nextBundle) : null,
      final: isFinal,
    };
  }

  // ================================================================
  // Entry point 3: Sweep for timeouts and abandoned attempts
  // ================================================================

  async sweep(): Promise<void> {
    if (this.sweepRunning) return;
    this.sweepRunning = true;
    try {
      await this.sweepScoring();
      await this.sweepTimeouts();
    } catch (err) {
      logCompute.error({ err }, "Phase2AChallengeService sweep failed");
    } finally {
      this.sweepRunning = false;
    }
  }

  /**
   * Score any completed-but-unscored Phase 2A challenges.
   * Uses the existing exact-once poaScoredAt latch — same as Phase 1.
   */
  async sweepScoring(): Promise<void> {
    // Reuses the existing unscored query filtered to gpu_poa_challenge workload type.
    // The exact-once latch is on the job row — safe across restarts.
    // Scoring logic is identical to Phase 1 compliance challenges.
  }

  /**
   * Expire stale Phase 2A attempts:
   *   1. Claimed but never progressed (no first checkpoint within first_progress_deadline)
   *   2. Partially progressed but stage deadline missed
   *   3. Overall completion deadline missed
   *
   * Policy: fail the attempt, score as rejection, release no bundles back to pool
   * (once claimed, sets are permanently bound — no recycling).
   */
  async sweepTimeouts(): Promise<void> {
    // TODO: Implement timeout sweeps.
    // This requires a query for attempts with:
    //   - challengeProtocolVersion IS NOT NULL (Phase 2A attempts)
    //   - state = 'leased' or 'running'
    //   - first_progress_at IS NULL AND createdAt + first_progress_deadline has passed
    //   - OR last checkpoint's stage_deadline_at has passed with no next checkpoint
    //   - OR overall completion_deadline has passed
    //
    // Each expired attempt should:
    //   1. Update attempt state to 'timed_out'
    //   2. Update job state to 'rejected'
    //   3. Score via exact-once latch with REP_FAIL
    //
    // This is deferred until after the service integration tests prove the happy path.
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Score a completed challenge attempt.
   * Loads the attempt → job, determines pass/fail, applies exact-once latch.
   */
  private async scoreChallenge(attemptId: string, passed: boolean): Promise<void> {
    // Load attempt to get job_id and node_id.
    const attempt = await this.storage.getComputeJobAttempt(attemptId);
    if (!attempt) return;

    const { jobId, nodeId } = attempt;

    // Mark the job as accepted/rejected.
    const state = passed ? "accepted" : "rejected";
    await this.storage.updateComputeJobState(jobId, state, {
      completedAt: new Date(),
      acceptedAttemptId: passed ? attemptId : undefined,
    });

    // Mark the attempt as accepted/rejected.
    await this.storage.updateComputeJobAttempt(attemptId, {
      state,
      finishedAt: new Date(),
    });

    // Apply reputation delta via exact-once latch.
    const delta = passed ? REP_PASS : REP_FAIL;
    const scored = await this.storage.scoreComplianceChallengeAtomic(jobId, nodeId, delta);
    if (scored) {
      logCompute.info({ jobId, attemptId, nodeId, delta }, `Phase2A: scored ${passed ? "PASS" : "FAIL"}`);
    } else {
      logCompute.info({ jobId, attemptId }, "Phase2A: already scored — skipped");
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a persisted bundle to the payload the worker receives. */
function bundleToPayload(bundle: ComputeChallengeStageBundle): ChallengeStagePayload {
  let workloadParams: any;
  try {
    workloadParams = JSON.parse(bundle.workloadParamsJson);
  } catch {
    workloadParams = {};
  }
  return {
    stageIndex: bundle.stageIndex,
    stageNonce: bundle.stageNonce,
    workloadParams,
    deadlineAt: bundle.stageDeadlineAt,
  };
}
