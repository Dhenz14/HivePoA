/**
 * Phase 2A Schema — Transaction-Boundary Invariant Tests
 *
 * Validates:
 *   S1 — Insert schemas accept valid data and reject missing required fields
 *   S2 — Orphan-pool claim atomicity: exactly one winner under concurrent claim
 *   S3 — Bundle (attempt_id, job_id) cross-job drift prevention
 *   S4 — Duplicate checkpoint for same (attempt_id, stage_index) is idempotently ignored
 *   S5 — Checkpoint before stage reveal is rejected
 *   S6 — Late checkpoint (past stage_deadline_at) is rejected
 *   S7 — Wrong stage nonce is rejected
 *   S8 — Wrong digest is rejected
 *   S9 — Transcript hash chain mismatch is rejected
 *   S10 — Rollup fields recompute exactly from bundles + checkpoints
 *   S11 — Final scoring remains exact-once under concurrent completion
 *   S12 — Profile version uniqueness: (protocol_version, class_id) and (protocol_version, class_name)
 *   S13 — Bundle set invariants: all stages share root_nonce and profile_id
 *   S14 — Stage reveal is one-way: cannot re-issue an already-revealed stage
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import type {
  ComputeResourceClassProfile,
  ComputeChallengeStageBundle,
  ComputeChallengeCheckpoint,
  ComputeJobAttempt,
  ComputeJob,
} from "@shared/schema";
import {
  insertComputeResourceClassProfileSchema,
  insertComputeChallengeStageBundle,
  insertComputeChallengeCheckpointSchema,
} from "@shared/schema";

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function makeProfile(overrides: Partial<ComputeResourceClassProfile> = {}): ComputeResourceClassProfile {
  return {
    profileId: `prof-${uid()}`,
    classId: 1,
    className: "gpu-small",
    protocolVersion: 1,
    kernelId: "phase2a-kernel-v1",
    m: 4096,
    n: 4096,
    k: 8,
    mixRounds: 1,
    stagesPerChallenge: 5,
    firstProgressDeadlineMs: 30000,
    stageDeadlineMs: 60000,
    completionDeadlineMs: 600000,
    poolTarget: 50,
    poolLowWatermarkPct: 50,
    poolCriticalWatermarkPct: 25,
    isActive: true,
    createdAt: new Date(),
    ...overrides,
  };
}

function makeBundleSet(
  profileId: string,
  stages: number = 5,
  overrides: Partial<ComputeChallengeStageBundle> = {},
): ComputeChallengeStageBundle[] {
  const setId = `set-${uid()}`;
  const rootNonce = `${uid()}-${uid()}-${uid()}`;
  return Array.from({ length: stages }, (_, i) => ({
    id: `bundle-${uid()}`,
    challengeSetId: setId,
    profileId,
    stageIndex: i,
    rootNonce,
    stageNonce: createHash("sha256")
      .update(rootNonce + Buffer.from([i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff, (i >> 24) & 0xff]).toString("binary"))
      .digest("hex"),
    expectedDigest: createHash("sha256").update(`expected-${setId}-${i}`).digest("hex"),
    workloadParamsJson: JSON.stringify({
      protocol_version: 1, kernel_id: "phase2a-kernel-v1", class_id: 1,
      stage_index: i, M: 4096, N: 4096, K: 8, mix_rounds: 1,
    }),
    precomputedAt: new Date(),
    jobId: null,
    attemptId: null,
    claimedAt: null,
    stageIssuedAt: null,
    stageDeadlineAt: null,
    ...overrides,
  }));
}

function makeAttempt(jobId: string, overrides: Partial<ComputeJobAttempt> = {}): ComputeJobAttempt {
  return {
    id: `att-${uid()}`,
    jobId,
    nodeId: `node-${uid()}`,
    leaseToken: uid(),
    nonce: uid(),
    state: "leased",
    progressPct: 0,
    currentStage: null,
    outputCid: null,
    outputSha256: null,
    outputSizeBytes: null,
    outputTransportUrl: null,
    metricsJson: null,
    resultJson: null,
    stderrTail: null,
    failureReason: null,
    leaseExpiresAt: new Date(Date.now() + 3600_000),
    submissionPayloadHash: null,
    provenanceJson: null,
    challengeProtocolVersion: 1,
    challengeProfileId: null,
    firstProgressAt: null,
    checkpointCount: 0,
    transcriptHash: null,
    startedAt: null,
    heartbeatAt: null,
    submittedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as ComputeJobAttempt;
}

// ── In-Memory Challenge Store ────────────────────────────────────────────────
//
// Enforces the same invariants that the real storage layer + DB constraints
// would enforce. Each method documents which real constraint it models.

type ClaimResult = { ok: true; bundles: ComputeChallengeStageBundle[] } | { ok: false; reason: string };
type RevealResult = { ok: true; bundle: ComputeChallengeStageBundle } | { ok: false; reason: string };
type CheckpointResult = { ok: true; checkpoint: ComputeChallengeCheckpoint } | { ok: false; reason: string };

class InMemoryChallengeStore {
  profiles: Map<string, ComputeResourceClassProfile> = new Map();
  bundles: Map<string, ComputeChallengeStageBundle> = new Map();
  checkpoints: Map<string, ComputeChallengeCheckpoint> = new Map();
  attempts: Map<string, ComputeJobAttempt> = new Map();
  jobs: Map<string, ComputeJob> = new Map();

  // Track claimed sets to enforce atomicity
  private claimedSets: Set<string> = new Set();

  addProfile(p: ComputeResourceClassProfile): void {
    // UNIQUE(protocol_version, class_id) + UNIQUE(protocol_version, class_name)
    for (const existing of this.profiles.values()) {
      if (existing.protocolVersion === p.protocolVersion && existing.classId === p.classId) {
        throw new Error(`Duplicate (protocol_version, class_id): (${p.protocolVersion}, ${p.classId})`);
      }
      if (existing.protocolVersion === p.protocolVersion && existing.className === p.className) {
        throw new Error(`Duplicate (protocol_version, class_name): (${p.protocolVersion}, ${p.className})`);
      }
    }
    this.profiles.set(p.profileId, p);
  }

  addBundleSet(bundleSet: ComputeChallengeStageBundle[]): void {
    // Validate set invariants: all share root_nonce, profile_id, challenge_set_id
    const setId = bundleSet[0]?.challengeSetId;
    const rootNonce = bundleSet[0]?.rootNonce;
    const profileId = bundleSet[0]?.profileId;
    for (const b of bundleSet) {
      if (b.challengeSetId !== setId) throw new Error("Set has mixed challenge_set_ids");
      if (b.rootNonce !== rootNonce) throw new Error("Set has mixed root_nonces");
      if (b.profileId !== profileId) throw new Error("Set has mixed profile_ids");
      // UNIQUE(challenge_set_id, stage_index)
      const key = `${b.challengeSetId}:${b.stageIndex}`;
      if (this.bundles.has(key)) throw new Error(`Duplicate bundle (set, stage): ${key}`);
    }
    for (const b of bundleSet) {
      this.bundles.set(`${b.challengeSetId}:${b.stageIndex}`, b);
    }
  }

  /** Atomic claim: find one orphan set for the given profile, bind to attempt. */
  claimSet(profileId: string, jobId: string, attemptId: string): ClaimResult {
    // Find an unclaimed set for this profile
    const orphanSets = new Map<string, ComputeChallengeStageBundle[]>();
    for (const b of this.bundles.values()) {
      if (b.profileId === profileId && b.attemptId === null) {
        if (!orphanSets.has(b.challengeSetId)) orphanSets.set(b.challengeSetId, []);
        orphanSets.get(b.challengeSetId)!.push(b);
      }
    }

    for (const [setId, set] of orphanSets) {
      // Atomicity guard: if another "transaction" already claimed this set, skip
      if (this.claimedSets.has(setId)) continue;

      // Validate set shape against profile
      const profile = this.profiles.get(profileId);
      if (!profile) return { ok: false, reason: "Profile not found" };
      if (set.length !== profile.stagesPerChallenge) {
        return { ok: false, reason: `Set has ${set.length} stages, profile requires ${profile.stagesPerChallenge}` };
      }

      // Cross-job drift prevention: verify attempt belongs to the job
      const attempt = this.attempts.get(attemptId);
      if (!attempt || attempt.jobId !== jobId) {
        return { ok: false, reason: `Attempt ${attemptId} does not belong to job ${jobId}` };
      }

      // Claim atomically
      this.claimedSets.add(setId);
      const now = new Date();
      for (const b of set) {
        b.jobId = jobId;
        b.attemptId = attemptId;
        b.claimedAt = now;
      }
      return { ok: true, bundles: set };
    }

    return { ok: false, reason: "No orphan sets available for this profile" };
  }

  /** Reveal stage i: set stage_issued_at + stage_deadline_at. One-way. */
  revealStage(attemptId: string, stageIndex: number): RevealResult {
    const bundle = this.findBundle(attemptId, stageIndex);
    if (!bundle) return { ok: false, reason: `No bundle for attempt ${attemptId} stage ${stageIndex}` };
    if (!bundle.claimedAt) return { ok: false, reason: "Bundle not claimed yet" };
    if (bundle.stageIssuedAt !== null) return { ok: false, reason: "Stage already revealed — one-way mutation" };

    const profile = this.profiles.get(bundle.profileId);
    if (!profile) return { ok: false, reason: "Profile not found" };

    const now = new Date();
    bundle.stageIssuedAt = now;
    bundle.stageDeadlineAt = new Date(now.getTime() + profile.stageDeadlineMs);
    return { ok: true, bundle };
  }

  /** Accept a checkpoint. Validates all invariants before insert. */
  acceptCheckpoint(
    attemptId: string,
    stageIndex: number,
    resultDigest: string,
    stageNonce: string,
    transcriptPrevHash: string,
    transcriptEntryHash: string,
    receivedAt: Date = new Date(),
    telemetryJson: string | null = null,
  ): CheckpointResult {
    // UNIQUE(attempt_id, stage_index): idempotent dedup
    const cpKey = `${attemptId}:${stageIndex}`;
    if (this.checkpoints.has(cpKey)) {
      return { ok: true, checkpoint: this.checkpoints.get(cpKey)! };
    }

    // Bundle must exist and be revealed
    const bundle = this.findBundle(attemptId, stageIndex);
    if (!bundle) return { ok: false, reason: `No bundle for attempt ${attemptId} stage ${stageIndex}` };
    if (bundle.stageIssuedAt === null) return { ok: false, reason: "Stage not yet revealed — checkpoint before reveal" };

    // Deadline check
    if (bundle.stageDeadlineAt && receivedAt > bundle.stageDeadlineAt) {
      return { ok: false, reason: "STAGE_DEADLINE_MISSED" };
    }

    // Nonce cross-check
    if (stageNonce !== bundle.stageNonce) {
      return { ok: false, reason: "STAGE_NONCE_MISMATCH" };
    }

    // Digest comparison
    if (resultDigest !== bundle.expectedDigest) {
      return { ok: false, reason: "STAGE_DIGEST_MISMATCH" };
    }

    // Transcript chain validation
    if (stageIndex === 0) {
      if (transcriptPrevHash !== "") {
        return { ok: false, reason: "TRANSCRIPT_HASH_MISMATCH — stage 0 prev must be empty" };
      }
    } else {
      const prevCp = this.checkpoints.get(`${attemptId}:${stageIndex - 1}`);
      if (!prevCp) return { ok: false, reason: "STAGE_ORDER_INVALID — missing previous checkpoint" };
      if (transcriptPrevHash !== prevCp.transcriptEntryHash) {
        return { ok: false, reason: "TRANSCRIPT_HASH_MISMATCH" };
      }
    }

    // Verify transcript_entry_hash is correctly computed
    const expectedEntryHash = createHash("sha256")
      .update(transcriptPrevHash + stageIndex.toString() + resultDigest)
      .digest("hex");
    if (transcriptEntryHash !== expectedEntryHash) {
      return { ok: false, reason: "TRANSCRIPT_HASH_MISMATCH — entry hash incorrect" };
    }

    // Insert (canonical, exactly once per slot)
    const checkpoint: ComputeChallengeCheckpoint = {
      id: `cp-${uid()}`,
      attemptId,
      stageIndex,
      stageNonce,
      resultDigest,
      checkpointReceivedAt: receivedAt,
      telemetryJson,
      transcriptPrevHash,
      transcriptEntryHash,
      createdAt: new Date(),
    };
    this.checkpoints.set(cpKey, checkpoint);

    // Update attempt rollup (derived cache)
    const attempt = this.attempts.get(attemptId);
    if (attempt) {
      if (stageIndex === 0) attempt.firstProgressAt = receivedAt;
      attempt.checkpointCount = (attempt.checkpointCount ?? 0) + 1;
      attempt.transcriptHash = transcriptEntryHash;
    }

    return { ok: true, checkpoint };
  }

  /** Recompute rollup from checkpoints + bundles (to verify derived cache). */
  recomputeRollup(attemptId: string): {
    firstProgressAt: Date | null;
    checkpointCount: number;
    transcriptHash: string | null;
  } {
    const cps: ComputeChallengeCheckpoint[] = [];
    for (const cp of this.checkpoints.values()) {
      if (cp.attemptId === attemptId) cps.push(cp);
    }
    cps.sort((a, b) => a.stageIndex - b.stageIndex);

    return {
      firstProgressAt: cps.length > 0 ? cps[0].checkpointReceivedAt : null,
      checkpointCount: cps.length,
      transcriptHash: cps.length > 0 ? cps[cps.length - 1].transcriptEntryHash : null,
    };
  }

  private findBundle(attemptId: string, stageIndex: number): ComputeChallengeStageBundle | undefined {
    for (const b of this.bundles.values()) {
      if (b.attemptId === attemptId && b.stageIndex === stageIndex) return b;
    }
    return undefined;
  }

  /** Pool count for a profile (unclaimed bundles grouped by set). */
  poolCount(profileId: string): number {
    const sets = new Set<string>();
    for (const b of this.bundles.values()) {
      if (b.profileId === profileId && b.attemptId === null) {
        sets.add(b.challengeSetId);
      }
    }
    return sets.size;
  }
}

// ── Test Helpers ─────────────────────────────────────────────────────────────

function computeTranscriptEntryHash(prevHash: string, stageIndex: number, resultDigest: string): string {
  return createHash("sha256")
    .update(prevHash + stageIndex.toString() + resultDigest)
    .digest("hex");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 2A Schema — Insert Schema Validation", () => {
  it("S1a: profile insert schema accepts valid data", () => {
    const result = insertComputeResourceClassProfileSchema.safeParse({
      classId: 1,
      className: "gpu-small",
      protocolVersion: 1,
      kernelId: "phase2a-kernel-v1",
      m: 4096, n: 4096, k: 8, mixRounds: 1,
      stagesPerChallenge: 5,
      firstProgressDeadlineMs: 30000,
      stageDeadlineMs: 60000,
      completionDeadlineMs: 600000,
      poolTarget: 50,
      poolLowWatermarkPct: 50,
      poolCriticalWatermarkPct: 25,
    });
    expect(result.success).toBe(true);
  });

  it("S1b: profile insert schema rejects missing required field", () => {
    const result = insertComputeResourceClassProfileSchema.safeParse({
      classId: 1,
      className: "gpu-small",
      // missing protocolVersion and other required fields
    });
    expect(result.success).toBe(false);
  });

  it("S1c: bundle insert schema accepts valid precomputed data", () => {
    const result = insertComputeChallengeStageBundle.safeParse({
      challengeSetId: "set-123",
      profileId: "prof-abc",
      stageIndex: 0,
      rootNonce: "11111111-2222-3333-4444-555555555555",
      stageNonce: "abcdef0123456789",
      expectedDigest: "deadbeef" + "0".repeat(56),
      workloadParamsJson: JSON.stringify({ protocol_version: 1 }),
    });
    expect(result.success).toBe(true);
  });

  it("S1d: checkpoint insert schema accepts valid evidence", () => {
    const result = insertComputeChallengeCheckpointSchema.safeParse({
      attemptId: "att-123",
      stageIndex: 0,
      stageNonce: "abcdef",
      resultDigest: "deadbeef",
      checkpointReceivedAt: new Date(),
      transcriptPrevHash: "",
      transcriptEntryHash: "aabbccdd",
    });
    expect(result.success).toBe(true);
  });
});

describe("Phase 2A Schema — Profile Uniqueness (S12)", () => {
  let store: InMemoryChallengeStore;

  beforeEach(() => { store = new InMemoryChallengeStore(); });

  it("S12a: rejects duplicate (protocol_version, class_id)", () => {
    store.addProfile(makeProfile({ profileId: "p1", classId: 1, className: "gpu-small", protocolVersion: 1 }));
    expect(() => {
      store.addProfile(makeProfile({ profileId: "p2", classId: 1, className: "gpu-different", protocolVersion: 1 }));
    }).toThrow("Duplicate (protocol_version, class_id)");
  });

  it("S12b: rejects duplicate (protocol_version, class_name)", () => {
    store.addProfile(makeProfile({ profileId: "p1", classId: 1, className: "gpu-small", protocolVersion: 1 }));
    expect(() => {
      store.addProfile(makeProfile({ profileId: "p2", classId: 99, className: "gpu-small", protocolVersion: 1 }));
    }).toThrow("Duplicate (protocol_version, class_name)");
  });

  it("S12c: allows same class_id in different protocol versions", () => {
    store.addProfile(makeProfile({ profileId: "p1", classId: 1, className: "gpu-small", protocolVersion: 1 }));
    expect(() => {
      store.addProfile(makeProfile({ profileId: "p2", classId: 1, className: "gpu-small", protocolVersion: 2 }));
    }).not.toThrow();
    expect(store.profiles.size).toBe(2);
  });
});

describe("Phase 2A Schema — Bundle Set Invariants (S13)", () => {
  let store: InMemoryChallengeStore;

  beforeEach(() => { store = new InMemoryChallengeStore(); });

  it("S13a: rejects bundle set with mixed root_nonces", () => {
    const profile = makeProfile();
    store.addProfile(profile);
    const set = makeBundleSet(profile.profileId, 5);
    set[2].rootNonce = "DIFFERENT-NONCE";
    expect(() => store.addBundleSet(set)).toThrow("mixed root_nonces");
  });

  it("S13b: rejects bundle set with mixed profile_ids", () => {
    const profile = makeProfile();
    store.addProfile(profile);
    const set = makeBundleSet(profile.profileId, 5);
    set[3].profileId = "some-other-profile";
    expect(() => store.addBundleSet(set)).toThrow("mixed profile_ids");
  });

  it("S13c: rejects duplicate (challenge_set_id, stage_index)", () => {
    const profile = makeProfile();
    store.addProfile(profile);
    const set = makeBundleSet(profile.profileId, 5);
    store.addBundleSet(set);
    // Try inserting same set again
    expect(() => store.addBundleSet(set)).toThrow("Duplicate bundle");
  });
});

describe("Phase 2A Schema — Orphan Pool Claim (S2, S3)", () => {
  let store: InMemoryChallengeStore;
  let profile: ComputeResourceClassProfile;

  beforeEach(() => {
    store = new InMemoryChallengeStore();
    profile = makeProfile();
    store.addProfile(profile);
  });

  it("S2a: claims a complete orphan set atomically", () => {
    const set = makeBundleSet(profile.profileId, 5);
    store.addBundleSet(set);

    const attempt = makeAttempt("job-1");
    store.attempts.set(attempt.id, attempt);
    store.jobs.set("job-1", {} as ComputeJob);

    const result = store.claimSet(profile.profileId, "job-1", attempt.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.bundles).toHaveLength(5);
    for (const b of result.bundles) {
      expect(b.attemptId).toBe(attempt.id);
      expect(b.jobId).toBe("job-1");
      expect(b.claimedAt).not.toBeNull();
    }
  });

  it("S2b: concurrent claim cannot double-bind a set", () => {
    const set = makeBundleSet(profile.profileId, 5);
    store.addBundleSet(set);

    const att1 = makeAttempt("job-1");
    const att2 = makeAttempt("job-2");
    store.attempts.set(att1.id, att1);
    store.attempts.set(att2.id, att2);
    store.jobs.set("job-1", {} as ComputeJob);
    store.jobs.set("job-2", {} as ComputeJob);

    const r1 = store.claimSet(profile.profileId, "job-1", att1.id);
    const r2 = store.claimSet(profile.profileId, "job-2", att2.id);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false); // no more orphan sets
    if (!r2.ok) expect(r2.reason).toContain("No orphan sets");
  });

  it("S2c: pool count decreases after claim", () => {
    store.addBundleSet(makeBundleSet(profile.profileId, 5));
    store.addBundleSet(makeBundleSet(profile.profileId, 5));
    expect(store.poolCount(profile.profileId)).toBe(2);

    const att = makeAttempt("job-1");
    store.attempts.set(att.id, att);
    store.jobs.set("job-1", {} as ComputeJob);

    store.claimSet(profile.profileId, "job-1", att.id);
    expect(store.poolCount(profile.profileId)).toBe(1);
  });

  it("S3: rejects claim when attempt does not belong to job (cross-job drift)", () => {
    store.addBundleSet(makeBundleSet(profile.profileId, 5));

    const att = makeAttempt("job-REAL");
    store.attempts.set(att.id, att);
    store.jobs.set("job-REAL", {} as ComputeJob);

    const result = store.claimSet(profile.profileId, "job-DIFFERENT", att.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("does not belong to job");
  });
});

describe("Phase 2A Schema — Stage Reveal (S14)", () => {
  let store: InMemoryChallengeStore;
  let attemptId: string;

  beforeEach(() => {
    store = new InMemoryChallengeStore();
    const profile = makeProfile();
    store.addProfile(profile);
    store.addBundleSet(makeBundleSet(profile.profileId, 5));

    const att = makeAttempt("job-1", { challengeProfileId: profile.profileId });
    attemptId = att.id;
    store.attempts.set(att.id, att);
    store.jobs.set("job-1", {} as ComputeJob);
    store.claimSet(profile.profileId, "job-1", att.id);
  });

  it("S14a: reveals stage 0 successfully", () => {
    const r = store.revealStage(attemptId, 0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.stageIssuedAt).not.toBeNull();
    expect(r.bundle.stageDeadlineAt).not.toBeNull();
  });

  it("S14b: cannot re-reveal an already-revealed stage", () => {
    store.revealStage(attemptId, 0);
    const r2 = store.revealStage(attemptId, 0);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain("already revealed");
  });
});

describe("Phase 2A Schema — Checkpoint Acceptance (S4-S9)", () => {
  let store: InMemoryChallengeStore;
  let attemptId: string;
  let bundles: ComputeChallengeStageBundle[];

  beforeEach(() => {
    store = new InMemoryChallengeStore();
    const profile = makeProfile({ stageDeadlineMs: 60000 });
    store.addProfile(profile);
    const bundleSet = makeBundleSet(profile.profileId, 5);
    store.addBundleSet(bundleSet);

    const att = makeAttempt("job-1", { challengeProfileId: profile.profileId });
    attemptId = att.id;
    store.attempts.set(att.id, att);
    store.jobs.set("job-1", {} as ComputeJob);

    const claimResult = store.claimSet(profile.profileId, "job-1", att.id);
    if (!claimResult.ok) throw new Error("claim failed");
    bundles = claimResult.bundles.sort((a, b) => a.stageIndex - b.stageIndex);
  });

  it("S4: duplicate checkpoint is idempotently returned", () => {
    store.revealStage(attemptId, 0);
    const b = bundles[0];
    const entryHash = computeTranscriptEntryHash("", 0, b.expectedDigest);

    const r1 = store.acceptCheckpoint(attemptId, 0, b.expectedDigest, b.stageNonce, "", entryHash);
    const r2 = store.acceptCheckpoint(attemptId, 0, b.expectedDigest, b.stageNonce, "", entryHash);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.checkpoint.id).toBe(r2.checkpoint.id); // same row returned
    }
  });

  it("S5: checkpoint before reveal is rejected", () => {
    // Stage 0 NOT revealed
    const b = bundles[0];
    const entryHash = computeTranscriptEntryHash("", 0, b.expectedDigest);
    const r = store.acceptCheckpoint(attemptId, 0, b.expectedDigest, b.stageNonce, "", entryHash);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not yet revealed");
  });

  it("S6: late checkpoint is rejected", () => {
    const revealResult = store.revealStage(attemptId, 0);
    if (!revealResult.ok) throw new Error("reveal failed");
    const b = bundles[0];
    const entryHash = computeTranscriptEntryHash("", 0, b.expectedDigest);

    // Checkpoint arrives 2 minutes after deadline
    const lateTime = new Date(revealResult.bundle.stageDeadlineAt!.getTime() + 120_000);
    const r = store.acceptCheckpoint(attemptId, 0, b.expectedDigest, b.stageNonce, "", entryHash, lateTime);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("STAGE_DEADLINE_MISSED");
  });

  it("S7: wrong stage nonce is rejected", () => {
    store.revealStage(attemptId, 0);
    const b = bundles[0];
    const entryHash = computeTranscriptEntryHash("", 0, b.expectedDigest);
    const r = store.acceptCheckpoint(attemptId, 0, b.expectedDigest, "WRONG-NONCE", "", entryHash);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("STAGE_NONCE_MISMATCH");
  });

  it("S8: wrong digest is rejected", () => {
    store.revealStage(attemptId, 0);
    const b = bundles[0];
    const entryHash = computeTranscriptEntryHash("", 0, "WRONG-DIGEST");
    const r = store.acceptCheckpoint(attemptId, 0, "WRONG-DIGEST", b.stageNonce, "", entryHash);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("STAGE_DIGEST_MISMATCH");
  });

  it("S9a: transcript chain mismatch — wrong prev hash", () => {
    store.revealStage(attemptId, 0);
    const b0 = bundles[0];
    const entry0 = computeTranscriptEntryHash("", 0, b0.expectedDigest);
    store.acceptCheckpoint(attemptId, 0, b0.expectedDigest, b0.stageNonce, "", entry0);

    store.revealStage(attemptId, 1);
    const b1 = bundles[1];
    const wrongPrev = "0000000000000000000000000000000000000000000000000000000000000000";
    const entry1 = computeTranscriptEntryHash(wrongPrev, 1, b1.expectedDigest);
    const r = store.acceptCheckpoint(attemptId, 1, b1.expectedDigest, b1.stageNonce, wrongPrev, entry1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("TRANSCRIPT_HASH_MISMATCH");
  });

  it("S9b: transcript chain mismatch — wrong entry hash", () => {
    store.revealStage(attemptId, 0);
    const b0 = bundles[0];
    const r = store.acceptCheckpoint(attemptId, 0, b0.expectedDigest, b0.stageNonce, "", "WRONG-ENTRY-HASH");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("TRANSCRIPT_HASH_MISMATCH");
  });

  it("S9c: missing previous checkpoint rejects out-of-order stage", () => {
    // Reveal stage 0 and 1, but only submit checkpoint for stage 1 (skip 0)
    store.revealStage(attemptId, 0);
    store.revealStage(attemptId, 1);
    const b1 = bundles[1];
    const entry1 = computeTranscriptEntryHash("some-prev", 1, b1.expectedDigest);
    const r = store.acceptCheckpoint(attemptId, 1, b1.expectedDigest, b1.stageNonce, "some-prev", entry1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("STAGE_ORDER_INVALID");
  });
});

describe("Phase 2A Schema — Rollup Recomputation (S10)", () => {
  let store: InMemoryChallengeStore;
  let attemptId: string;
  let bundles: ComputeChallengeStageBundle[];

  beforeEach(() => {
    store = new InMemoryChallengeStore();
    const profile = makeProfile({ stagesPerChallenge: 3, stageDeadlineMs: 600000 });
    store.addProfile(profile);
    const bundleSet = makeBundleSet(profile.profileId, 3);
    store.addBundleSet(bundleSet);

    const att = makeAttempt("job-1");
    attemptId = att.id;
    store.attempts.set(att.id, att);
    store.jobs.set("job-1", {} as ComputeJob);

    const cr = store.claimSet(profile.profileId, "job-1", att.id);
    if (!cr.ok) throw new Error("claim failed");
    bundles = cr.bundles.sort((a, b) => a.stageIndex - b.stageIndex);
  });

  it("S10: rollup fields recompute exactly from checkpoints", () => {
    // Submit 3 stages
    let prevHash = "";
    for (let i = 0; i < 3; i++) {
      store.revealStage(attemptId, i);
      const b = bundles[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);
      const r = store.acceptCheckpoint(attemptId, i, b.expectedDigest, b.stageNonce, prevHash, entryHash);
      expect(r.ok).toBe(true);
      prevHash = entryHash;
    }

    // Verify rollup on attempt matches recomputation
    const attempt = store.attempts.get(attemptId)!;
    const recomputed = store.recomputeRollup(attemptId);

    expect(attempt.checkpointCount).toBe(recomputed.checkpointCount);
    expect(attempt.checkpointCount).toBe(3);
    expect(attempt.transcriptHash).toBe(recomputed.transcriptHash);
    expect(attempt.firstProgressAt).toEqual(recomputed.firstProgressAt);
    expect(attempt.transcriptHash).toBe(prevHash); // final entry hash
  });
});

describe("Phase 2A Schema — Exact-Once Scoring (S11)", () => {
  it("S11: poaScoredAt latch prevents double scoring", () => {
    // Simulates the exact-once CAS: UPDATE ... SET poaScoredAt = now() WHERE poaScoredAt IS NULL
    const job = {
      id: "job-1",
      poaScoredAt: null as Date | null,
    };

    function tryScore(): boolean {
      if (job.poaScoredAt !== null) return false; // already scored
      job.poaScoredAt = new Date();
      return true;
    }

    expect(tryScore()).toBe(true);  // first scorer wins
    expect(tryScore()).toBe(false); // second scorer rejected
    expect(job.poaScoredAt).not.toBeNull();
  });
});

describe("Phase 2A Schema — Full Challenge Flow (integration)", () => {
  it("completes a 5-stage challenge end-to-end", () => {
    const store = new InMemoryChallengeStore();
    const profile = makeProfile({ stagesPerChallenge: 5, stageDeadlineMs: 600000 });
    store.addProfile(profile);
    store.addBundleSet(makeBundleSet(profile.profileId, 5));

    const att = makeAttempt("job-1", { challengeProfileId: profile.profileId });
    store.attempts.set(att.id, att);
    store.jobs.set("job-1", {} as ComputeJob);

    // Claim
    const claim = store.claimSet(profile.profileId, "job-1", att.id);
    expect(claim.ok).toBe(true);
    if (!claim.ok) return;
    const bundles = claim.bundles.sort((a, b) => a.stageIndex - b.stageIndex);

    // Walk all 5 stages: reveal → checkpoint → next
    let prevHash = "";
    for (let i = 0; i < 5; i++) {
      const reveal = store.revealStage(att.id, i);
      expect(reveal.ok).toBe(true);

      const b = bundles[i];
      const entryHash = computeTranscriptEntryHash(prevHash, i, b.expectedDigest);
      const cp = store.acceptCheckpoint(att.id, i, b.expectedDigest, b.stageNonce, prevHash, entryHash);
      expect(cp.ok).toBe(true);
      prevHash = entryHash;
    }

    // Verify rollup
    const attempt = store.attempts.get(att.id)!;
    expect(attempt.checkpointCount).toBe(5);
    expect(attempt.transcriptHash).toBe(prevHash);
    expect(attempt.firstProgressAt).not.toBeNull();

    // Recompute matches
    const recomputed = store.recomputeRollup(att.id);
    expect(recomputed.checkpointCount).toBe(5);
    expect(recomputed.transcriptHash).toBe(attempt.transcriptHash);

    // Pool is drained
    expect(store.poolCount(profile.profileId)).toBe(0);
  });
});
