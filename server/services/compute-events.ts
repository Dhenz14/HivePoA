/**
 * Phase 0: Structured Compute Events
 *
 * Every event describes a COMMITTED FACT, not an attempted intention.
 * Events are emitted AFTER the corresponding state mutation is committed.
 *
 * Each event carries full correlation keys for lifecycle joining:
 * - jobId, attemptId, nodeId, nonce (where relevant)
 * - schemaVersion, eventVersion
 *
 * Event emission is idempotent: emitting the same event twice produces
 * duplicate log entries but no state change. Downstream consumers must
 * handle dedup by (jobId, attemptId, event, timestamp) or similar.
 */
import { logCompute } from "../logger";

// Event version — bump when correlation fields or semantics change
const EVENT_VERSION = 1;

interface BaseCorrelation {
  jobId: string;
  attemptId?: string;
  nodeId?: string;
  nonce?: string;
  schemaVersion?: number;
  eventVersion?: number;
}

function emit(event: string, correlation: BaseCorrelation, details?: Record<string, unknown>): void {
  logCompute.info({
    event,
    eventVersion: EVENT_VERSION,
    ...correlation,
    ...details,
  }, `compute:${event}`);
}

// ================================================================
// Claim & Nonce Events
// ================================================================

export function emitClaimIssued(p: {
  jobId: string;
  attemptId: string;
  nodeId: string;
  nonce: string;
  leaseSeconds: number;
  workloadType: string;
}): void {
  emit("claim_issued", {
    jobId: p.jobId,
    attemptId: p.attemptId,
    nodeId: p.nodeId,
    nonce: p.nonce,
  }, {
    leaseSeconds: p.leaseSeconds,
    workloadType: p.workloadType,
  });
}

// ================================================================
// Submit Events
// ================================================================

export function emitSubmitAccepted(p: {
  jobId: string;
  attemptId: string;
  nodeId: string;
  nonce: string;
  outputSha256: string;
  verificationScore: number;
  hasProvenance: boolean;
}): void {
  emit("submit_accepted", {
    jobId: p.jobId,
    attemptId: p.attemptId,
    nodeId: p.nodeId,
    nonce: p.nonce,
  }, {
    outputSha256: p.outputSha256,
    verificationScore: p.verificationScore,
    hasProvenance: p.hasProvenance,
  });
}

export function emitSubmitRejected(p: {
  jobId: string;
  attemptId: string;
  nonce: string;
  reason: string;
}): void {
  emit("submit_rejected", {
    jobId: p.jobId,
    attemptId: p.attemptId,
    nonce: p.nonce,
  }, { reason: p.reason });
}

export function emitSubmitIdempotent(p: {
  jobId: string;
  attemptId: string;
  nonce: string;
}): void {
  emit("submit_idempotent", {
    jobId: p.jobId,
    attemptId: p.attemptId,
    nonce: p.nonce,
  });
}

export function emitLateSubmitRejected(p: {
  jobId: string;
  attemptId: string;
  nonce: string;
  outputSha256?: string;
  leaseExpiresAt: Date;
  serverTime: Date;
}): void {
  emit("late_submit_rejected", {
    jobId: p.jobId,
    attemptId: p.attemptId,
    nonce: p.nonce,
  }, {
    outputSha256: p.outputSha256,
    leaseExpiresAt: p.leaseExpiresAt.toISOString(),
    serverTime: p.serverTime.toISOString(),
  });
}

// ================================================================
// Acceptance & Winner Events
// ================================================================

export function emitAttemptAccepted(p: {
  jobId: string;
  attemptId: string;
  nodeId: string;
  nonce: string;
  verificationScore: number;
  validityFee: string;
  completionFee: string;
  bonus: string;
}): void {
  emit("attempt_accepted", {
    jobId: p.jobId,
    attemptId: p.attemptId,
    nodeId: p.nodeId,
    nonce: p.nonce,
  }, {
    verificationScore: p.verificationScore,
    validityFee: p.validityFee,
    completionFee: p.completionFee,
    bonus: p.bonus,
  });
}

export function emitAttemptRejected(p: {
  jobId: string;
  attemptId: string;
  nodeId: string;
  reason: string;
}): void {
  emit("attempt_rejected", {
    jobId: p.jobId,
    attemptId: p.attemptId,
    nodeId: p.nodeId,
  }, { reason: p.reason });
}

export function emitAcceptanceIdempotent(p: {
  jobId: string;
  attemptId: string;
}): void {
  emit("acceptance_idempotent", {
    jobId: p.jobId,
    attemptId: p.attemptId,
  });
}

export function emitAcceptanceCASFailed(p: {
  jobId: string;
  attemptId: string;
  winnerId: string;
}): void {
  emit("acceptance_cas_failed", {
    jobId: p.jobId,
    attemptId: p.attemptId,
  }, { winnerId: p.winnerId });
}

// ================================================================
// Ownership & Validation Events
// ================================================================

export function emitNonceMismatch(p: {
  attemptId: string;
  expected: string;
  received: string;
}): void {
  emit("nonce_mismatch", {
    jobId: "",
    attemptId: p.attemptId,
  }, { expected: p.expected, received: p.received });
}

export function emitDivergentReplay(p: {
  attemptId: string;
  nonce: string;
}): void {
  emit("divergent_replay", {
    jobId: "",
    attemptId: p.attemptId,
    nonce: p.nonce,
  });
}

export function emitVersionMismatch(p: {
  attemptId: string;
  submittedVersion: number;
  requiredVersion: number;
}): void {
  emit("version_mismatch", {
    jobId: "",
    attemptId: p.attemptId,
  }, {
    submittedVersion: p.submittedVersion,
    requiredVersion: p.requiredVersion,
  });
}

// ================================================================
// Settlement Events
// ================================================================

export function emitSettlementAttempted(p: {
  jobId: string;
  payoutIds: string[];
  totalHbd: string;
}): void {
  emit("settlement_attempted", {
    jobId: p.jobId,
  }, {
    payoutIds: p.payoutIds,
    totalHbd: p.totalHbd,
  });
}

export function emitSettlementBlocked(p: {
  jobId: string;
  reason: string;
}): void {
  emit("settlement_blocked", {
    jobId: p.jobId,
  }, { reason: p.reason });
}

// ================================================================
// Lease Events
// ================================================================

export function emitLeaseExpired(p: {
  jobId: string;
  attemptId: string;
  nodeId: string;
  leaseExpiresAt: Date;
}): void {
  emit("lease_expired", {
    jobId: p.jobId,
    attemptId: p.attemptId,
    nodeId: p.nodeId,
  }, {
    leaseExpiresAt: p.leaseExpiresAt.toISOString(),
  });
}

// ================================================================
// Artifact Ingress Events
// ================================================================

export function emitArtifactUploaded(p: {
  nodeId: string;
  cid: string;
  sha256: string;
  sizeBytes: number;
  workloadType: string;
}): void {
  emit("artifact_uploaded", {
    jobId: "",
    nodeId: p.nodeId,
  }, {
    cid: p.cid,
    sha256: p.sha256,
    sizeBytes: p.sizeBytes,
    workloadType: p.workloadType,
  });
}

export function emitArtifactRejected(p: {
  nodeId: string;
  reason: string;
  workloadType?: string;
  expectedSha256?: string;
}): void {
  emit("artifact_rejected", {
    jobId: "",
    nodeId: p.nodeId,
  }, {
    reason: p.reason,
    workloadType: p.workloadType,
    expectedSha256: p.expectedSha256,
  });
}

// ================================================================
// Wallet Events
// ================================================================

export function emitDepositRecorded(p: {
  username: string;
  txHash: string;
  amountHbd: string;
  blockNum?: number;
}): void {
  emit("deposit_recorded", { jobId: "" }, {
    username: p.username,
    txHash: p.txHash,
    amountHbd: p.amountHbd,
    blockNum: p.blockNum,
  });
}

export function emitBudgetReserved(p: {
  jobId: string;
  username: string;
  amountHbd: string;
}): void {
  emit("budget_reserved", { jobId: p.jobId }, {
    username: p.username,
    amountHbd: p.amountHbd,
  });
}

export function emitBudgetReleased(p: {
  jobId: string;
  amountHbd: string;
  reason: string;
}): void {
  emit("budget_released", { jobId: p.jobId }, {
    amountHbd: p.amountHbd,
    reason: p.reason,
  });
}

export function emitInsufficientBalance(p: {
  username: string;
  required: string;
  available: string;
  jobId: string;
}): void {
  emit("insufficient_balance", { jobId: p.jobId }, {
    username: p.username,
    required: p.required,
    available: p.available,
  });
}

export function emitReconciliationCompleted(p: {
  processed: number;
  skipped: number;
  errors: number;
}): void {
  emit("reconciliation_completed", { jobId: "" }, {
    processed: p.processed,
    skipped: p.skipped,
    errors: p.errors,
  });
}
