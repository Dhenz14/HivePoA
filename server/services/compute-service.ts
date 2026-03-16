import { randomBytes, createHash } from "crypto";
import { storage } from "../storage";
import { logCompute } from "../logger";
import type {
  ComputeNode,
  ComputeJob,
  ComputeJobAttempt,
  ComputeVerification,
  ComputePayout,
} from "@shared/schema";

// Valid workload types for V1
const VALID_WORKLOAD_TYPES = [
  "eval_sweep",
  "benchmark_run",
  "weakness_targeted_generation",
  "domain_lora_train",
  "adapter_validation",
] as const;

export type WorkloadType = typeof VALID_WORKLOAD_TYPES[number];

// Minimum reputation to accept high-value workloads
const WARMUP_REPUTATION_THRESHOLD = 20;
const WARMUP_WORKLOADS: WorkloadType[] = ["eval_sweep", "benchmark_run", "adapter_validation"];

// Lease sweep interval: check for expired leases every 30 seconds
const LEASE_SWEEP_INTERVAL_MS = 30 * 1000;

export interface JobManifest {
  schema_version: number;
  workload_type: WorkloadType;
  executor_type: string;
  executor_version: string;
  base_model?: {
    id: string;
    sha256: string;
  };
  training_config?: Record<string, unknown>;
  data?: {
    input_cids: string[];
    expected_records?: number;
  };
  runtime?: {
    python?: string;
    torch?: string;
    cuda?: string;
    [key: string]: string | undefined;
  };
  outputs?: {
    required: string[];
  };
  [key: string]: unknown;
}

export interface NodeRegistration {
  hiveUsername: string;
  nodeInstanceId: string;
  gpuModel: string;
  gpuVramGb: number;
  cudaVersion?: string;
  cpuCores?: number;
  ramGb?: number;
  supportedWorkloads: string;
  cachedModels?: string;
  workerVersion?: string;
  pricePerHourHbd?: string;
  maxConcurrentJobs?: number;
}

export interface JobCreation {
  creatorUsername: string;
  workloadType: WorkloadType;
  manifest: JobManifest;
  budgetHbd: string;
  priority?: number;
  minVramGb?: number;
  requiredModels?: string;
  leaseSeconds?: number;
  maxAttempts?: number;
  deadlineAt?: Date;
  verificationPolicy?: Record<string, unknown>;
}

export interface JobSubmission {
  outputCid: string;
  outputSha256: string;
  outputSizeBytes?: number;
  outputTransportUrl?: string;
  metricsJson?: string;
  resultJson?: string;
  // Phase 0: Transaction integrity
  nonce: string; // echo back server-issued nonce from claim
  provenanceJson?: string; // structured provenance metadata (optional in v1, required in v2)
}

// Phase 0: Provenance size limit
const MAX_PROVENANCE_SIZE = 64 * 1024; // 64 KB

export class ComputeService {
  private leaseSweepTimer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    this.leaseSweepTimer = setInterval(() => this.sweepExpiredLeases(), LEASE_SWEEP_INTERVAL_MS);
    logCompute.info("ComputeService started — lease sweeper active");
  }

  stop(): void {
    if (this.leaseSweepTimer) {
      clearInterval(this.leaseSweepTimer);
      this.leaseSweepTimer = null;
    }
  }

  // ============================================================
  // Node Operations
  // ============================================================

  async registerNode(reg: NodeRegistration): Promise<ComputeNode> {
    // Lookup by stable node instance ID (not username — one account can have many nodes)
    const existing = await storage.getComputeNodeByInstanceId(reg.nodeInstanceId);
    if (existing) {
      // Verify ownership: the same Hive account must own the instance
      if (existing.hiveUsername !== reg.hiveUsername) {
        throw new Error("Node instance ID is already registered to a different Hive account");
      }
      await storage.updateComputeNode(existing.id, {
        status: "online",
        gpuModel: reg.gpuModel,
        gpuVramGb: reg.gpuVramGb,
        cudaVersion: reg.cudaVersion || existing.cudaVersion,
        cpuCores: reg.cpuCores || existing.cpuCores,
        ramGb: reg.ramGb || existing.ramGb,
        supportedWorkloads: reg.supportedWorkloads,
        cachedModels: reg.cachedModels || existing.cachedModels,
        workerVersion: reg.workerVersion || existing.workerVersion,
        pricePerHourHbd: reg.pricePerHourHbd || existing.pricePerHourHbd,
        maxConcurrentJobs: reg.maxConcurrentJobs || existing.maxConcurrentJobs,
        lastHeartbeatAt: new Date(),
      });
      logCompute.info({ nodeId: existing.id, instanceId: reg.nodeInstanceId, username: reg.hiveUsername }, "Compute node re-registered");
      return (await storage.getComputeNode(existing.id))!;
    }

    const node = await storage.createComputeNode({
      nodeInstanceId: reg.nodeInstanceId,
      hiveUsername: reg.hiveUsername,
      gpuModel: reg.gpuModel,
      gpuVramGb: reg.gpuVramGb,
      cudaVersion: reg.cudaVersion,
      cpuCores: reg.cpuCores,
      ramGb: reg.ramGb,
      supportedWorkloads: reg.supportedWorkloads,
      cachedModels: reg.cachedModels || "",
      workerVersion: reg.workerVersion,
      pricePerHourHbd: reg.pricePerHourHbd || "0.50",
      maxConcurrentJobs: reg.maxConcurrentJobs || 1,
      status: "online",
      reputationScore: 0,
      jobsInProgress: 0,
    });

    logCompute.info({ nodeId: node.id, instanceId: reg.nodeInstanceId, username: reg.hiveUsername, gpu: reg.gpuModel }, "New compute node registered");
    return node;
  }

  async heartbeat(nodeId: string, jobsInProgress: number): Promise<void> {
    await storage.updateComputeNodeHeartbeat(nodeId, jobsInProgress);
    // Also update heartbeatAt on any active attempts for this node
    // This prevents the lease sweeper from expiring active leases
    // when the worker sends node-level heartbeats but not attempt-level progress
    await storage.touchActiveAttemptHeartbeats(nodeId);
  }

  async drainNode(nodeId: string): Promise<void> {
    await storage.updateComputeNode(nodeId, { status: "draining" });
    logCompute.info({ nodeId }, "Compute node draining");
  }

  // ============================================================
  // Job Operations
  // ============================================================

  async createJob(params: JobCreation): Promise<ComputeJob> {
    if (!VALID_WORKLOAD_TYPES.includes(params.workloadType)) {
      throw new Error(`Invalid workload type: ${params.workloadType}. Must be one of: ${VALID_WORKLOAD_TYPES.join(", ")}`);
    }

    const manifestStr = JSON.stringify(params.manifest);
    const manifestSha256 = createHash("sha256").update(manifestStr).digest("hex");

    if (params.manifest.schema_version !== 1) {
      throw new Error("Unsupported manifest schema_version. Expected 1.");
    }
    if (params.manifest.workload_type !== params.workloadType) {
      throw new Error("Manifest workload_type does not match job workload_type");
    }

    const job = await storage.createComputeJob({
      creatorUsername: params.creatorUsername,
      workloadType: params.workloadType,
      state: "queued",
      priority: params.priority || 0,
      manifestJson: manifestStr,
      manifestSha256,
      minVramGb: params.minVramGb || 16,
      requiredModels: params.requiredModels || "",
      budgetHbd: params.budgetHbd,
      reservedBudgetHbd: params.budgetHbd,
      leaseSeconds: params.leaseSeconds || 3600,
      maxAttempts: params.maxAttempts || 3,
      deadlineAt: params.deadlineAt || null,
      verificationPolicyJson: params.verificationPolicy ? JSON.stringify(params.verificationPolicy) : null,
    });

    logCompute.info({ jobId: job.id, type: params.workloadType, budget: params.budgetHbd }, "Compute job created");
    return job;
  }

  /**
   * Atomically claim the next eligible job for a node.
   * Uses SELECT ... FOR UPDATE SKIP LOCKED to prevent race conditions.
   * Ranking: cache match → priority → age (FIFO anti-starvation).
   */
  async claimNextJob(nodeId: string): Promise<{ job: ComputeJob; attempt: ComputeJobAttempt } | null> {
    const node = await storage.getComputeNode(nodeId);
    if (!node || node.status !== "online") {
      return null;
    }

    // Enforce max concurrent jobs per node
    if (node.jobsInProgress >= node.maxConcurrentJobs) {
      return null;
    }

    // Parse capabilities once at ingress (not repeated comma-split in loop)
    const supportedTypes = node.supportedWorkloads.split(",").filter(Boolean);
    const cachedModelsList = node.cachedModels.split(",").filter(Boolean);

    // Enforce warm-up policy: low-rep nodes only get low-stakes workloads
    const allowedTypes = node.reputationScore < WARMUP_REPUTATION_THRESHOLD
      ? supportedTypes.filter(t => WARMUP_WORKLOADS.includes(t as WorkloadType))
      : supportedTypes;

    if (allowedTypes.length === 0) return null;

    // Atomic claim: SELECT FOR UPDATE SKIP LOCKED + state flip in one operation
    const leaseToken = randomBytes(32).toString("hex");
    const result = await storage.claimComputeJobAtomic(
      nodeId,
      allowedTypes,
      node.gpuVramGb,
      cachedModelsList,
      leaseToken,
    );

    if (!result) return null;

    // Update node job count
    await storage.updateComputeNodeHeartbeat(nodeId, node.jobsInProgress + 1);

    logCompute.info({ jobId: result.job.id, nodeId, attemptId: result.attempt.id }, "Job claimed atomically");
    return result;
  }

  async startJob(attemptId: string, leaseToken: string): Promise<void> {
    const attempt = await storage.getComputeJobAttempt(attemptId);
    if (!attempt || attempt.leaseToken !== leaseToken) {
      throw new Error("Invalid attempt or lease token");
    }
    if (attempt.state !== "leased") {
      throw new Error(`Cannot start attempt in state: ${attempt.state}`);
    }

    await storage.updateComputeJobAttempt(attemptId, {
      state: "running",
      startedAt: new Date(),
      heartbeatAt: new Date(),
    });
    await storage.updateComputeJobState(attempt.jobId, "running");
    logCompute.info({ jobId: attempt.jobId, attemptId }, "Job started");
  }

  async reportProgress(attemptId: string, leaseToken: string, progressPct: number, currentStage?: string): Promise<void> {
    const attempt = await storage.getComputeJobAttempt(attemptId);
    if (!attempt || attempt.leaseToken !== leaseToken) {
      throw new Error("Invalid attempt or lease token");
    }
    if (attempt.state !== "running" && attempt.state !== "leased") {
      throw new Error(`Cannot report progress for attempt in state: ${attempt.state}`);
    }

    await storage.updateComputeJobAttempt(attemptId, {
      progressPct: Math.max(0, Math.min(100, progressPct)),
      currentStage: currentStage || attempt.currentStage,
      heartbeatAt: new Date(),
    });
  }

  async submitResult(attemptId: string, leaseToken: string, submission: JobSubmission): Promise<ComputeJobAttempt> {
    const attempt = await storage.getComputeJobAttempt(attemptId);
    if (!attempt || attempt.leaseToken !== leaseToken) {
      throw new Error("Invalid attempt or lease token");
    }

    // Phase 0: Nonce validation — must match server-issued nonce
    if (submission.nonce !== attempt.nonce) {
      logCompute.warn({ attemptId, expected: attempt.nonce, received: submission.nonce }, "Nonce mismatch");
      throw Object.assign(new Error("NONCE_MISMATCH"), { statusCode: 409 });
    }

    // Phase 0: Compute payload hash for idempotency/divergent-replay detection
    const payloadHash = createHash("sha256")
      .update(submission.outputSha256 || "")
      .update(submission.resultJson || "")
      .digest("hex");

    // Phase 0: Idempotent replay — if already submitted, check for exact vs divergent replay
    if (attempt.state === "submitted" || attempt.state === "accepted" || attempt.state === "rejected") {
      if (attempt.submissionPayloadHash === payloadHash) {
        // Exact replay — return existing result idempotently
        logCompute.info({ attemptId, nonce: submission.nonce }, "Idempotent submit replay");
        return attempt;
      } else {
        // Divergent replay — same (attemptId, nonce) but different payload
        logCompute.warn({ attemptId, nonce: submission.nonce }, "Divergent payload on replay");
        throw Object.assign(new Error("SUBMISSION_PAYLOAD_MISMATCH"), { statusCode: 409 });
      }
    }

    // State must be "running" for a fresh submission
    if (attempt.state !== "running") {
      throw Object.assign(
        new Error(`Cannot submit result for attempt in state: ${attempt.state}`),
        { statusCode: 409 },
      );
    }

    // Phase 0: Late-submit check — server receipt time vs lease expiry
    const now = new Date();
    if (attempt.leaseExpiresAt && now > attempt.leaseExpiresAt) {
      logCompute.warn({
        attemptId, nonce: submission.nonce,
        leaseExpiresAt: attempt.leaseExpiresAt, serverTime: now,
        outputSha256: submission.outputSha256,
      }, "Late submit rejected");
      throw Object.assign(new Error("LEASE_EXPIRED"), { statusCode: 409 });
    }

    // Phase 0: Provenance validation (optional in v1, structural checks always)
    if (submission.provenanceJson !== undefined) {
      if (Buffer.byteLength(submission.provenanceJson, "utf8") > MAX_PROVENANCE_SIZE) {
        throw Object.assign(new Error("PROVENANCE_TOO_LARGE"), { statusCode: 400 });
      }
      try {
        JSON.parse(submission.provenanceJson);
      } catch {
        throw Object.assign(new Error("PROVENANCE_INVALID_JSON"), { statusCode: 400 });
      }
    }

    await storage.updateComputeJobAttempt(attemptId, {
      state: "submitted",
      progressPct: 100,
      outputCid: submission.outputCid,
      outputSha256: submission.outputSha256,
      outputSizeBytes: submission.outputSizeBytes,
      outputTransportUrl: submission.outputTransportUrl,
      metricsJson: submission.metricsJson,
      resultJson: submission.resultJson,
      submissionPayloadHash: payloadHash,
      provenanceJson: submission.provenanceJson,
      submittedAt: now,
      heartbeatAt: now,
    });

    await storage.updateComputeJobState(attempt.jobId, "submitted");

    logCompute.info({ jobId: attempt.jobId, attemptId, nonce: submission.nonce, cid: submission.outputCid }, "Job result submitted");

    // Trigger verification (inline for V1)
    await this.runVerification(attempt.jobId, attemptId);

    return (await storage.getComputeJobAttempt(attemptId))!;
  }

  async failJob(attemptId: string, leaseToken: string, reason: string, stderrTail?: string): Promise<void> {
    const attempt = await storage.getComputeJobAttempt(attemptId);
    if (!attempt || attempt.leaseToken !== leaseToken) {
      throw new Error("Invalid attempt or lease token");
    }

    await storage.updateComputeJobAttempt(attemptId, {
      state: "failed",
      failureReason: reason,
      stderrTail: stderrTail?.slice(-4000),
      finishedAt: new Date(),
    });

    await storage.updateComputeNodeStats(attempt.nodeId, false);
    await storage.decrementComputeNodeJobs(attempt.nodeId);

    const job = await storage.getComputeJob(attempt.jobId);
    if (job && job.attemptCount < job.maxAttempts) {
      await storage.updateComputeJobState(attempt.jobId, "queued");
      logCompute.info({ jobId: attempt.jobId, attemptId, reason }, "Job attempt failed, re-queued");
    } else {
      await storage.updateComputeJobState(attempt.jobId, "rejected", { completedAt: new Date() });
      logCompute.warn({ jobId: attempt.jobId, attemptId, reason }, "Job exhausted all attempts");
    }
  }

  async cancelJob(jobId: string, username: string): Promise<void> {
    const job = await storage.getComputeJob(jobId);
    if (!job) throw new Error("Job not found");
    if (job.creatorUsername !== username) throw new Error("Not authorized to cancel this job");
    if (["accepted", "rejected", "cancelled"].includes(job.state)) {
      throw new Error(`Cannot cancel job in state: ${job.state}`);
    }

    // If there's a running attempt, compute elapsed-fraction payout
    if (job.state === "running" || job.state === "leased") {
      const attempts = await storage.getComputeJobAttempts(jobId);
      const activeAttempt = attempts.find(a => a.state === "running" || a.state === "leased");
      if (activeAttempt && activeAttempt.startedAt) {
        const elapsedMs = Date.now() - new Date(activeAttempt.startedAt).getTime();
        const leaseMs = job.leaseSeconds * 1000;
        // Elapsed fraction of lease, capped at 80% (never pay full budget on cancellation)
        const elapsedFraction = Math.min(0.8, elapsedMs / leaseMs);
        // Validity portion (30% of budget) prorated by elapsed time
        const proratedAmount = (parseFloat(job.budgetHbd) * 0.3 * elapsedFraction).toFixed(3);

        if (parseFloat(proratedAmount) > 0) {
          await storage.createComputePayout({
            jobId,
            attemptId: activeAttempt.id,
            nodeId: activeAttempt.nodeId,
            amountHbd: proratedAmount,
            reason: "cancellation_refund",
            status: "pending",
          });
          logCompute.info({ jobId, nodeId: activeAttempt.nodeId, amount: proratedAmount, elapsedFraction }, "Elapsed-fraction payout for cancelled job");
        }

        await storage.updateComputeJobAttempt(activeAttempt.id, {
          state: "failed",
          failureReason: "Cancelled by creator",
          finishedAt: new Date(),
        });

        // Update node job count
        const node = await storage.getComputeNode(activeAttempt.nodeId);
        if (node) {
          await storage.updateComputeNodeHeartbeat(activeAttempt.nodeId, Math.max(0, node.jobsInProgress - 1));
        }
      }
    }

    await storage.updateComputeJobState(jobId, "cancelled", { cancelledAt: new Date() });
    logCompute.info({ jobId, username }, "Job cancelled");
  }

  // ============================================================
  // Verification (V1: inline in HivePoA, workload-specific)
  // ============================================================

  async runVerification(jobId: string, attemptId: string): Promise<void> {
    const job = await storage.getComputeJob(jobId);
    const attempt = await storage.getComputeJobAttempt(attemptId);
    if (!job || !attempt) return;

    await storage.updateComputeJobState(jobId, "verifying");

    // Stage 1: Structural verification (always runs)
    const structuralResult = await this.verifyStructural(job, attempt);
    await storage.createComputeVerification({
      jobId,
      attemptId,
      verifierType: "structural",
      verifierVersion: "1.0.0",
      result: structuralResult.pass ? "pass" : "fail",
      score: structuralResult.score,
      detailsJson: JSON.stringify(structuralResult.details),
    });

    if (!structuralResult.pass) {
      await this.rejectAttempt(job, attempt, "Failed structural verification");
      return;
    }

    // Stage 2: Workload-specific verification
    const semanticResult = await this.verifyWorkloadSpecific(job, attempt);
    await storage.createComputeVerification({
      jobId,
      attemptId,
      verifierType: "workload_specific",
      verifierVersion: "1.0.0",
      result: semanticResult.pass ? "pass" : "fail",
      score: semanticResult.score,
      detailsJson: JSON.stringify(semanticResult.details),
    });

    if (!semanticResult.pass) {
      await this.rejectAttempt(job, attempt, "Failed workload-specific verification");
      return;
    }

    // All verification passed — accept
    await this.acceptAttempt(job, attempt, structuralResult.score);
  }

  private async verifyStructural(
    job: ComputeJob,
    attempt: ComputeJobAttempt
  ): Promise<{ pass: boolean; score: number; details: Record<string, unknown> }> {
    const checks: Record<string, boolean> = {};

    checks.hasOutputCid = !!attempt.outputCid;
    checks.hasOutputSha256 = !!attempt.outputSha256;

    const recomputedHash = createHash("sha256").update(job.manifestJson).digest("hex");
    checks.manifestIntegrity = recomputedHash === job.manifestSha256;

    if (attempt.metricsJson) {
      try { JSON.parse(attempt.metricsJson); checks.validMetrics = true; }
      catch { checks.validMetrics = false; }
    } else {
      checks.validMetrics = true;
    }

    if (attempt.resultJson) {
      try { JSON.parse(attempt.resultJson); checks.validResult = true; }
      catch { checks.validResult = false; }
    } else {
      checks.validResult = true;
    }

    const manifest = JSON.parse(job.manifestJson) as JobManifest;
    if (manifest.outputs?.required) {
      checks.hasRequiredOutputs = manifest.outputs.required.length > 0
        ? !!attempt.outputCid
        : true;
    }

    const allPassed = Object.values(checks).every(Boolean);
    const score = Object.values(checks).filter(Boolean).length / Object.values(checks).length;

    return { pass: allPassed, score, details: checks };
  }

  private async verifyWorkloadSpecific(
    job: ComputeJob,
    attempt: ComputeJobAttempt
  ): Promise<{ pass: boolean; score: number; details: Record<string, unknown> }> {
    const type = job.workloadType as WorkloadType;

    switch (type) {
      case "eval_sweep":
      case "benchmark_run": {
        if (!attempt.resultJson) return { pass: false, score: 0, details: { error: "Missing result JSON" } };
        try {
          const result = JSON.parse(attempt.resultJson);
          const hasScores = typeof result.scores === "object" || typeof result.score === "number";
          return { pass: hasScores, score: hasScores ? 0.8 : 0, details: { hasScores } };
        } catch {
          return { pass: false, score: 0, details: { error: "Invalid result JSON" } };
        }
      }
      case "weakness_targeted_generation": {
        if (!attempt.outputCid) return { pass: false, score: 0, details: { error: "Missing output CID" } };
        return { pass: true, score: 0.7, details: { note: "Full quality check deferred to coordinator" } };
      }
      case "domain_lora_train":
      case "adapter_validation": {
        if (!attempt.outputCid) return { pass: false, score: 0, details: { error: "Missing adapter CID" } };
        let hasLoss = false;
        if (attempt.metricsJson) {
          try {
            const metrics = JSON.parse(attempt.metricsJson);
            hasLoss = typeof metrics.final_loss === "number" && metrics.final_loss > 0 && metrics.final_loss < 10;
          } catch { /* ignore */ }
        }
        return {
          pass: !!attempt.outputCid,
          score: hasLoss ? 0.8 : 0.5,
          details: { hasAdapter: true, hasValidLoss: hasLoss },
        };
      }
      default:
        return { pass: true, score: 0.5, details: { note: "Unknown workload type, basic pass" } };
    }
  }

  private async acceptAttempt(job: ComputeJob, attempt: ComputeJobAttempt, verificationScore: number): Promise<void> {
    // Phase 0 invariant: exactly one accepted attempt per job
    if (job.acceptedAttemptId) {
      logCompute.warn({ jobId: job.id, attemptId: attempt.id, existingWinner: job.acceptedAttemptId },
        "Attempt acceptance blocked — job already has an accepted attempt");
      return;
    }

    await storage.updateComputeJobAttempt(attempt.id, {
      state: "accepted",
      finishedAt: new Date(),
    });
    // Set acceptedAttemptId atomically — single-winner identity
    await storage.updateComputeJobState(job.id, "accepted", {
      completedAt: new Date(),
      acceptedAttemptId: attempt.id,
    });

    // Update node stats and reputation
    await storage.updateComputeNodeStats(attempt.nodeId, true);
    const node = await storage.getComputeNode(attempt.nodeId);
    if (node) {
      const newRep = Math.min(100, node.reputationScore + 2);
      await storage.updateComputeNode(attempt.nodeId, {
        reputationScore: newRep,
        jobsInProgress: Math.max(0, node.jobsInProgress - 1),
      });
    }

    // Three-stage payouts
    const budget = parseFloat(job.budgetHbd);
    const validityFee = (budget * 0.3).toFixed(3);
    const completionFee = (budget * 0.4).toFixed(3);
    const bonus = (budget * 0.3 * verificationScore).toFixed(3);

    await storage.createComputePayout({
      jobId: job.id, attemptId: attempt.id, nodeId: attempt.nodeId,
      amountHbd: validityFee, reason: "validity_fee", status: "pending",
    });
    await storage.createComputePayout({
      jobId: job.id, attemptId: attempt.id, nodeId: attempt.nodeId,
      amountHbd: completionFee, reason: "completion_fee", status: "pending",
    });
    if (parseFloat(bonus) > 0) {
      await storage.createComputePayout({
        jobId: job.id, attemptId: attempt.id, nodeId: attempt.nodeId,
        amountHbd: bonus, reason: "bonus", status: "pending",
      });
    }

    logCompute.info({
      jobId: job.id, attemptId: attempt.id, nodeId: attempt.nodeId,
      validity: validityFee, completion: completionFee, bonus,
    }, "Job accepted — payouts staged");
  }

  private async rejectAttempt(job: ComputeJob, attempt: ComputeJobAttempt, reason: string): Promise<void> {
    await storage.updateComputeJobAttempt(attempt.id, {
      state: "rejected",
      failureReason: reason,
      finishedAt: new Date(),
    });

    const node = await storage.getComputeNode(attempt.nodeId);
    if (node) {
      const newRep = Math.max(0, node.reputationScore - 5);
      await storage.updateComputeNode(attempt.nodeId, { reputationScore: newRep });
    }

    await storage.decrementComputeNodeJobs(attempt.nodeId);
    await storage.updateComputeNodeStats(attempt.nodeId, false);

    if (job.attemptCount < job.maxAttempts) {
      await storage.updateComputeJobState(job.id, "queued");
      logCompute.info({ jobId: job.id, reason }, "Attempt rejected, job re-queued");
    } else {
      await storage.updateComputeJobState(job.id, "rejected", { completedAt: new Date() });
      logCompute.warn({ jobId: job.id, reason }, "Job rejected — all attempts exhausted");
    }
  }

  // ============================================================
  // Lease Sweeper
  // ============================================================

  private async sweepExpiredLeases(): Promise<void> {
    try {
      const stale = await storage.getExpiredComputeLeases();
      for (const attempt of stale) {
        logCompute.warn({ jobId: attempt.jobId, attemptId: attempt.id, nodeId: attempt.nodeId }, "Lease expired — timed out");
        await storage.updateComputeJobAttempt(attempt.id, {
          state: "timed_out",
          failureReason: "Heartbeat timeout",
          finishedAt: new Date(),
        });

        const node = await storage.getComputeNode(attempt.nodeId);
        if (node) {
          await storage.updateComputeNode(attempt.nodeId, {
            jobsInProgress: Math.max(0, node.jobsInProgress - 1),
          });
        }

        const job = await storage.getComputeJob(attempt.jobId);
        if (job && job.attemptCount < job.maxAttempts) {
          await storage.updateComputeJobState(attempt.jobId, "queued");
        } else if (job) {
          await storage.updateComputeJobState(attempt.jobId, "expired", { completedAt: new Date() });
        }
      }
    } catch (err) {
      logCompute.error({ err }, "Lease sweep failed");
    }
  }

  // ============================================================
  // Cost Estimation
  // ============================================================

  async estimateCost(workloadType: WorkloadType, minVramGb: number): Promise<{ estimatedHbd: string; availableNodes: number }> {
    const nodes = await storage.getAvailableComputeNodes(workloadType, minVramGb);
    if (nodes.length === 0) {
      return { estimatedHbd: "0", availableNodes: 0 };
    }
    const prices = nodes.map((n: ComputeNode) => parseFloat(n.pricePerHourHbd)).sort((a: number, b: number) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    return {
      estimatedHbd: median.toFixed(3),
      availableNodes: nodes.length,
    };
  }

  // ============================================================
  // Settle Payouts
  // ============================================================

  async settlePayouts(jobId: string): Promise<ComputePayout[]> {
    const payouts = await storage.getComputePayoutsByJob(jobId);
    const pending = payouts.filter((p: ComputePayout) => p.status === "pending");

    for (const payout of pending) {
      await storage.updateComputePayoutStatus(payout.id, "queued");
    }

    logCompute.info({ jobId, count: pending.length }, "Payouts settled");
    return pending;
  }
}

export const computeService = new ComputeService();
