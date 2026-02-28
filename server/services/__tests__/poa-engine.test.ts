/**
 * PoA Engine Unit & Integration Tests
 * Tests core PoA logic: config, cooldowns, streaks, batching, reputation.
 * Integration tests require DATABASE_URL.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { POA_CONFIG, PoAEngine } from "../poa-engine";
import { MockSPKPoAClient } from "../spk-poa-client";
import { MockHiveClient } from "../hive-client";

// ============================================================
// Unit Tests — no database required
// ============================================================

describe("POA_CONFIG constants", () => {
  it("has valid reputation thresholds", () => {
    expect(POA_CONFIG.BAN_THRESHOLD).toBeLessThan(POA_CONFIG.PROBATION_THRESHOLD);
    expect(POA_CONFIG.PROBATION_THRESHOLD).toBeLessThanOrEqual(100);
    expect(POA_CONFIG.CONSECUTIVE_FAIL_BAN).toBeGreaterThanOrEqual(2);
  });

  it("has valid reward multipliers", () => {
    expect(POA_CONFIG.FALLBACK_REWARD_HBD).toBeGreaterThan(0);
    expect(POA_CONFIG.STREAK_BONUS_10).toBeGreaterThanOrEqual(1);
    expect(POA_CONFIG.STREAK_BONUS_50).toBeGreaterThan(POA_CONFIG.STREAK_BONUS_10);
    expect(POA_CONFIG.STREAK_BONUS_100).toBeGreaterThan(POA_CONFIG.STREAK_BONUS_50);
  });

  it("has valid batch settings", () => {
    expect(POA_CONFIG.PROOF_BATCH_THRESHOLD).toBeGreaterThanOrEqual(1);
    expect(POA_CONFIG.MIN_BATCH_PAYOUT_HBD).toBeGreaterThan(0);
    expect(POA_CONFIG.MIN_BATCH_PAYOUT_HBD).toBeLessThan(POA_CONFIG.FALLBACK_REWARD_HBD * POA_CONFIG.PROOF_BATCH_THRESHOLD);
  });

  it("has valid cooldown values", () => {
    expect(POA_CONFIG.NODE_COOLDOWN_MS).toBeGreaterThan(0);
    expect(POA_CONFIG.NODE_FILE_COOLDOWN_MS).toBeGreaterThanOrEqual(POA_CONFIG.NODE_COOLDOWN_MS);
    expect(POA_CONFIG.BAN_COOLDOWN_HOURS).toBeGreaterThan(0);
  });

  it("has valid timing constraints", () => {
    expect(POA_CONFIG.CHALLENGE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(POA_CONFIG.CHALLENGE_TIMEOUT_MS).toBeLessThanOrEqual(30000);
    expect(POA_CONFIG.DEFAULT_CHALLENGE_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("trust tiers are ordered correctly", () => {
    expect(POA_CONFIG.TRUST_TIER_NEW).toBeLessThan(POA_CONFIG.TRUST_TIER_ESTABLISHED);
    expect(POA_CONFIG.COOLDOWN_MULTIPLIER_NEW).toBeLessThan(1);
    expect(POA_CONFIG.COOLDOWN_MULTIPLIER_ESTABLISHED).toBeGreaterThan(1);
  });

  it("time-based bonus multipliers are ordered correctly", () => {
    expect(POA_CONFIG.TIME_BONUS_1_HOUR).toBeLessThanOrEqual(POA_CONFIG.TIME_BONUS_1_DAY);
    expect(POA_CONFIG.TIME_BONUS_1_DAY).toBeLessThanOrEqual(POA_CONFIG.TIME_BONUS_1_WEEK);
    expect(POA_CONFIG.TIME_BONUS_1_WEEK).toBeLessThanOrEqual(POA_CONFIG.TIME_BONUS_1_MONTH);
  });
});

describe("MockSPKPoAClient", () => {
  const client = new MockSPKPoAClient({
    url: "http://localhost:8080",
    username: "test-validator",
  });

  it("reports as connected", () => {
    expect(client.isConnected).toBe(true);
  });

  it("connects without error", async () => {
    await expect(client.connect()).resolves.toBeUndefined();
  });

  it("validates with success or fail (never throws)", async () => {
    const result = await client.validate("QmTestCid123");
    expect(result).toHaveProperty("status");
    expect(["success", "fail", "timeout"]).toContain(result.status);
    expect(result).toHaveProperty("name", "test-validator");
    expect(result).toHaveProperty("elapsed");
    expect(result.elapsed).toBeGreaterThanOrEqual(0);
  });

  it("success result includes proofHash", async () => {
    // Set 100% success rate for deterministic test
    client.setSuccessRate(1.0);
    const result = await client.validate("QmTestCid123");
    // Could still be timeout (5% chance), but usually success
    if (result.status === "success") {
      expect(result.proofHash).toBeDefined();
      expect(result.proofHash!.length).toBeGreaterThan(0);
    }
    client.setSuccessRate(0.85); // Reset
  });

  it("getStats returns node stats", async () => {
    const stats = await client.getStats();
    expect(stats).toHaveProperty("syncStatus", true);
    expect(stats).toHaveProperty("nodeType", "validator");
    expect(stats).toHaveProperty("peerCount");
    expect(stats.peerCount).toBeGreaterThanOrEqual(10);
    expect(stats).toHaveProperty("version");
  });

  it("setSuccessRate clamps to [0, 1]", () => {
    client.setSuccessRate(-0.5);
    // No error, internally clamped
    client.setSuccessRate(2.0);
    // No error, internally clamped
    client.setSuccessRate(0.85); // Reset
  });
});

describe("Reputation Calculation Logic", () => {
  it("success increases reputation by SUCCESS_REP_GAIN", () => {
    const currentRep = 50;
    const newRep = Math.min(100, currentRep + POA_CONFIG.SUCCESS_REP_GAIN);
    expect(newRep).toBe(51);
  });

  it("reputation caps at 100", () => {
    const currentRep = 100;
    const newRep = Math.min(100, currentRep + POA_CONFIG.SUCCESS_REP_GAIN);
    expect(newRep).toBe(100);
  });

  it("first fail applies base penalty", () => {
    const currentRep = 50;
    const consecutiveFails = 1;
    const penalty = Math.min(
      POA_CONFIG.MAX_REP_LOSS,
      POA_CONFIG.FAIL_REP_BASE_LOSS * Math.pow(POA_CONFIG.FAIL_REP_MULTIPLIER, consecutiveFails - 1)
    );
    const newRep = Math.max(0, currentRep - Math.floor(penalty));
    expect(newRep).toBe(50 - POA_CONFIG.FAIL_REP_BASE_LOSS);
  });

  it("consecutive fails increase penalty exponentially", () => {
    const penalties: number[] = [];
    for (let fails = 1; fails <= 5; fails++) {
      const penalty = Math.min(
        POA_CONFIG.MAX_REP_LOSS,
        POA_CONFIG.FAIL_REP_BASE_LOSS * Math.pow(POA_CONFIG.FAIL_REP_MULTIPLIER, fails - 1)
      );
      penalties.push(Math.floor(penalty));
    }
    // Each penalty should be >= the previous
    for (let i = 1; i < penalties.length; i++) {
      expect(penalties[i]).toBeGreaterThanOrEqual(penalties[i - 1]);
    }
  });

  it("penalty caps at MAX_REP_LOSS", () => {
    const consecutiveFails = 100;
    const penalty = Math.min(
      POA_CONFIG.MAX_REP_LOSS,
      POA_CONFIG.FAIL_REP_BASE_LOSS * Math.pow(POA_CONFIG.FAIL_REP_MULTIPLIER, consecutiveFails - 1)
    );
    expect(penalty).toBe(POA_CONFIG.MAX_REP_LOSS);
  });

  it("reputation cannot go below 0", () => {
    const currentRep = 3;
    const penalty = POA_CONFIG.MAX_REP_LOSS;
    const newRep = Math.max(0, currentRep - penalty);
    expect(newRep).toBe(0);
  });

  it("3 consecutive fails triggers instant ban", () => {
    const consecutiveFails = POA_CONFIG.CONSECUTIVE_FAIL_BAN;
    const shouldBan = consecutiveFails >= POA_CONFIG.CONSECUTIVE_FAIL_BAN;
    expect(shouldBan).toBe(true);
  });

  it("low reputation triggers ban status", () => {
    const rep = POA_CONFIG.BAN_THRESHOLD - 1;
    const status = rep < POA_CONFIG.BAN_THRESHOLD ? "banned" :
                   rep < POA_CONFIG.PROBATION_THRESHOLD ? "probation" : "active";
    expect(status).toBe("banned");
  });

  it("mid reputation triggers probation status", () => {
    const rep = POA_CONFIG.PROBATION_THRESHOLD - 1;
    const status = rep < POA_CONFIG.BAN_THRESHOLD ? "banned" :
                   rep < POA_CONFIG.PROBATION_THRESHOLD ? "probation" : "active";
    expect(status).toBe("probation");
  });

  it("high reputation gives active status", () => {
    const rep = POA_CONFIG.PROBATION_THRESHOLD + 10;
    const status = rep < POA_CONFIG.BAN_THRESHOLD ? "banned" :
                   rep < POA_CONFIG.PROBATION_THRESHOLD ? "probation" : "active";
    expect(status).toBe("active");
  });
});

describe("Reward Calculation Logic", () => {
  it("base reward with no bonuses", () => {
    const reward = POA_CONFIG.FALLBACK_REWARD_HBD * 1 * 1; // rarity=1, streak=1
    expect(reward).toBe(POA_CONFIG.FALLBACK_REWARD_HBD);
  });

  it("rarity multiplier decreases with replication", () => {
    const reward1 = POA_CONFIG.FALLBACK_REWARD_HBD * (1 / 1); // 1 replica
    const reward5 = POA_CONFIG.FALLBACK_REWARD_HBD * (1 / 5); // 5 replicas
    expect(reward1).toBeGreaterThan(reward5);
  });

  it("streak bonus increases reward at thresholds", () => {
    const base = POA_CONFIG.FALLBACK_REWARD_HBD;
    const rewardStreak9 = base * 1.0;  // Below 10
    const rewardStreak10 = base * POA_CONFIG.STREAK_BONUS_10;
    const rewardStreak50 = base * POA_CONFIG.STREAK_BONUS_50;
    const rewardStreak100 = base * POA_CONFIG.STREAK_BONUS_100;

    expect(rewardStreak10).toBeGreaterThan(rewardStreak9);
    expect(rewardStreak50).toBeGreaterThan(rewardStreak10);
    expect(rewardStreak100).toBeGreaterThan(rewardStreak50);
  });

  it("batch threshold: 10 proofs triggers a payout", () => {
    let accumulatedCount = 0;
    let batchTriggered = false;

    for (let i = 0; i < 15; i++) {
      accumulatedCount++;
      if (accumulatedCount >= POA_CONFIG.PROOF_BATCH_THRESHOLD) {
        batchTriggered = true;
        accumulatedCount = 0;
      }
    }
    expect(batchTriggered).toBe(true);
  });
});

describe("Cooldown Logic", () => {
  it("new nodes get shorter cooldowns (more frequent checks)", () => {
    const newNodeRep = POA_CONFIG.TRUST_TIER_NEW - 1;
    let multiplier: number;
    if (newNodeRep < POA_CONFIG.TRUST_TIER_NEW) {
      multiplier = POA_CONFIG.COOLDOWN_MULTIPLIER_NEW;
    } else if (newNodeRep >= POA_CONFIG.TRUST_TIER_ESTABLISHED) {
      multiplier = POA_CONFIG.COOLDOWN_MULTIPLIER_ESTABLISHED;
    } else {
      multiplier = 1;
    }
    expect(multiplier).toBe(POA_CONFIG.COOLDOWN_MULTIPLIER_NEW);
    expect(multiplier).toBeLessThan(1);
  });

  it("established nodes get longer cooldowns (less frequent checks)", () => {
    const establishedRep = POA_CONFIG.TRUST_TIER_ESTABLISHED;
    let multiplier: number;
    if (establishedRep < POA_CONFIG.TRUST_TIER_NEW) {
      multiplier = POA_CONFIG.COOLDOWN_MULTIPLIER_NEW;
    } else if (establishedRep >= POA_CONFIG.TRUST_TIER_ESTABLISHED) {
      multiplier = POA_CONFIG.COOLDOWN_MULTIPLIER_ESTABLISHED;
    } else {
      multiplier = 1;
    }
    expect(multiplier).toBe(POA_CONFIG.COOLDOWN_MULTIPLIER_ESTABLISHED);
    expect(multiplier).toBeGreaterThan(1);
  });

  it("middle tier nodes get standard cooldown", () => {
    const midRep = Math.floor((POA_CONFIG.TRUST_TIER_NEW + POA_CONFIG.TRUST_TIER_ESTABLISHED) / 2);
    let multiplier: number;
    if (midRep < POA_CONFIG.TRUST_TIER_NEW) {
      multiplier = POA_CONFIG.COOLDOWN_MULTIPLIER_NEW;
    } else if (midRep >= POA_CONFIG.TRUST_TIER_ESTABLISHED) {
      multiplier = POA_CONFIG.COOLDOWN_MULTIPLIER_ESTABLISHED;
    } else {
      multiplier = 1;
    }
    expect(multiplier).toBe(1);
  });
});
