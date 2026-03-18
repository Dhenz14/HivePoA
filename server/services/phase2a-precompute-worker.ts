/**
 * Phase 2A Pool Precompute Worker
 *
 * Background worker that maintains the orphan bundle pool for Phase 2A challenges.
 * Monitors pool levels per active profile and generates new precomputed bundle sets
 * when the pool drops below the low watermark.
 *
 * Bundle generation calls the normative C99 reference kernel to produce
 * stage nonces and expected digests. The reference binary IS the spec —
 * the precompute worker does not reimplement kernel logic.
 *
 * Design constraints:
 *   - No workflow authority: worker only produces precomputed material
 *   - Bundles are insert-only orphans (attempt_id IS NULL) until claimed
 *   - Digest generation uses the reference binary, not a reimplementation
 *   - Pool levels are advisory: the worker refills, but claim contention
 *     is handled by the storage primitives
 */
import { storage } from "../storage";
import { logCompute } from "../logger";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import type { ComputeResourceClassProfile } from "@shared/schema";

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_REFILL_INTERVAL_MS = 30_000; // check pool every 30s
const DEFAULT_BATCH_SIZE = 5; // number of sets to precompute per refill cycle

// ── Reference kernel interface ───────────────────────────────────────────────

export interface KernelDigestResult {
  stageNonce: string; // 64-char hex
  digest: string;     // 64-char hex
}

/**
 * Compute a stage digest using the normative C99 reference kernel.
 * Shells out to the compiled binary via WSL.
 *
 * This is deliberately NOT a reimplementation — the C99 binary IS the spec.
 * Any divergence between this output and a worker's output is a worker bug.
 */
export function computeStageDigest(
  rootNonce: string,
  classId: number,
  stageIndex: number,
  M: number, N: number, K: number, mixRounds: number,
): KernelDigestResult {
  const evidenceDir = "/mnt/c/Users/theyc/Hive\\ AI/HivePoA/evidence/phase2a";
  const binary = `${evidenceDir}/phase2a_kernel_ref_v1`;

  const cmd = `${binary} --digest ${rootNonce} ${classId} ${stageIndex} ${M} ${N} ${K} ${mixRounds}`;

  const output = execSync(`wsl -d Ubuntu-24.04 -- bash -c "${cmd}"`, {
    encoding: "utf-8",
    timeout: 60_000, // generous timeout for large matrix computations
  });

  // Parse output: stage_nonce=<hex>\ndigest=<hex>\n
  const nonceMatch = output.match(/stage_nonce=([0-9a-f]{64})/);
  const digestMatch = output.match(/digest=([0-9a-f]{64})/);

  if (!nonceMatch || !digestMatch) {
    throw new Error(`Failed to parse kernel output: ${output.slice(0, 200)}`);
  }

  return {
    stageNonce: nonceMatch[1],
    digest: digestMatch[1],
  };
}

// ── Storage interface (subset needed by precompute worker) ───────────────────

export interface PrecomputeStorage {
  getActiveResourceClassProfiles(): Promise<ComputeResourceClassProfile[]>;
  getOrphanPoolCount(profileId: string): Promise<number>;
  insertPrecomputedBundleSet(bundles: any[]): Promise<any[]>;
}

// ── Worker ───────────────────────────────────────────────────────────────────

export class Phase2APrecomputeWorker {
  private storage: PrecomputeStorage;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private digestFn: typeof computeStageDigest;

  constructor(
    injectedStorage?: PrecomputeStorage,
    injectedDigestFn?: typeof computeStageDigest,
  ) {
    this.storage = injectedStorage ?? (storage as unknown as PrecomputeStorage);
    this.digestFn = injectedDigestFn ?? computeStageDigest;
  }

  start(intervalMs: number = DEFAULT_REFILL_INTERVAL_MS): void {
    if (this.timer) return; // idempotent
    this.timer = setInterval(() => this.refillCycle(), intervalMs);
    logCompute.info({ intervalMs }, "Phase2APrecomputeWorker started");
    // Run one cycle immediately
    this.refillCycle();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one refill cycle: check all profiles, refill any below watermark. */
  async refillCycle(): Promise<{ generated: number }> {
    if (this.running) return { generated: 0 };
    this.running = true;
    let totalGenerated = 0;
    try {
      const profiles = await this.storage.getActiveResourceClassProfiles();
      for (const profile of profiles) {
        const generated = await this.refillProfile(profile);
        totalGenerated += generated;
      }
    } catch (err) {
      logCompute.error({ err }, "Phase2APrecomputeWorker refill cycle failed");
    } finally {
      this.running = false;
    }
    return { generated: totalGenerated };
  }

  /** Refill a single profile's pool if below low watermark. */
  async refillProfile(profile: ComputeResourceClassProfile): Promise<number> {
    const poolCount = await this.storage.getOrphanPoolCount(profile.profileId);
    const lowThreshold = Math.ceil(profile.poolTarget * profile.poolLowWatermarkPct / 100);

    if (poolCount >= lowThreshold) {
      return 0; // pool is healthy
    }

    // How many sets to generate this cycle (capped by batch size)
    const deficit = profile.poolTarget - poolCount;
    const toGenerate = Math.min(deficit, DEFAULT_BATCH_SIZE);

    logCompute.info(
      { profileId: profile.profileId, className: profile.className, poolCount, lowThreshold, deficit, toGenerate },
      "Phase2APrecomputeWorker: pool below low watermark — generating",
    );

    let generated = 0;
    for (let i = 0; i < toGenerate; i++) {
      try {
        await this.generateBundleSet(profile);
        generated++;
      } catch (err) {
        logCompute.error(
          { err, profileId: profile.profileId, setNumber: i },
          "Phase2APrecomputeWorker: failed to generate bundle set",
        );
        break; // stop on first failure (likely kernel binary issue)
      }
    }

    if (generated > 0) {
      logCompute.info(
        { profileId: profile.profileId, generated },
        "Phase2APrecomputeWorker: generated bundle sets",
      );
    }

    return generated;
  }

  /** Generate one complete bundle set for a profile. */
  async generateBundleSet(profile: ComputeResourceClassProfile): Promise<void> {
    const rootNonce = randomUUID();
    const stages = profile.stagesPerChallenge;

    const bundles = [];
    for (let stageIndex = 0; stageIndex < stages; stageIndex++) {
      const result = this.digestFn(
        rootNonce,
        profile.classId,
        stageIndex,
        profile.m, profile.n, profile.k, profile.mixRounds,
      );

      bundles.push({
        challengeSetId: randomUUID(),
        profileId: profile.profileId,
        stageIndex,
        rootNonce,
        stageNonce: result.stageNonce,
        expectedDigest: result.digest,
        workloadParamsJson: JSON.stringify({
          protocol_version: profile.protocolVersion,
          kernel_id: profile.kernelId,
          class_id: profile.classId,
          stage_index: stageIndex,
          M: profile.m,
          N: profile.n,
          K: profile.k,
          mix_rounds: profile.mixRounds,
        }),
      });
    }

    // All stages in a set share the same challengeSetId
    const setId = bundles[0].challengeSetId;
    for (const b of bundles) {
      b.challengeSetId = setId;
    }

    await this.storage.insertPrecomputedBundleSet(bundles);
  }
}
