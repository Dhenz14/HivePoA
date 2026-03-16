/**
 * Storage Tier Definitions — v1.1
 *
 * Fixed annual pricing in HBD (HBD ≈ $1 USD peg, no oracle needed).
 * Users pick a tier → server creates a 365-day storage contract with
 * the tier's budget. PoA engine distributes rewards over the year.
 *
 * Users can also:
 * - Top up an existing contract at any time (extend duration or add budget)
 * - Overpay beyond the base price to increase economic incentive for storage nodes
 *   (higher rewardPerChallenge → more nodes are economically motivated to store the file)
 *
 * NOTE: Overpay increases incentive, not a guaranteed redundancy SLA.
 * More reward makes files more attractive to store, but actual replica count
 * depends on network participation and node availability.
 *
 * KNOWN CONSTRAINTS (v1.1.x):
 *
 * Challenge weighting: Tier contracts make ALL of a user's files eligible for
 * PoA challenges. Challenge selection is implicitly file-count weighted — a user
 * with 1000 small files gets more challenge entries than a user with 1 large file
 * in the same tier. This is acceptable for v1.1 but a v1.2 design review should
 * decide whether challenge scheduling should be per-file, per-byte, or per-user.
 *
 * Status trust boundary: Quota accounting only counts files with status in
 * (pinned, syncing, warning). If a file gets stuck in a non-counted status
 * (e.g., "uploading" due to a failed cleanup), quota can be bypassed
 * operationally. File status correctness is now part of quota correctness.
 */

export interface StorageTier {
  id: string;
  name: string;
  storageLimitBytes: number;
  storageLimitLabel: string;
  hbdPrice: string;         // Base annual price in HBD
  durationDays: number;     // Always 365 for v1.1
  description: string;
}

const GB = 1024 * 1024 * 1024;

export const STORAGE_TIERS: StorageTier[] = [
  {
    id: "starter",
    name: "Starter",
    storageLimitBytes: 5 * GB,
    storageLimitLabel: "5 GB",
    hbdPrice: "3.999",
    durationDays: 365,
    description: "The price of a digital movie rental, but for a year.",
  },
  {
    id: "standard",
    name: "Standard",
    storageLimitBytes: 10 * GB,
    storageLimitLabel: "10 GB",
    hbdPrice: "6.999",
    durationDays: 365,
    description: "Competitive with essential cloud tiers.",
  },
  {
    id: "creator",
    name: "Creator",
    storageLimitBytes: 20 * GB,
    storageLimitLabel: "20 GB",
    hbdPrice: "11.999",
    durationDays: 365,
    description: "Undercuts the Big Tech entry price.",
  },
];

export function getTierById(tierId: string): StorageTier | undefined {
  return STORAGE_TIERS.find(t => t.id === tierId);
}

/**
 * Calculate rewardPerChallenge for a given budget and duration.
 * Assumes ~1 challenge per 3 days per file.
 * Minimum reward is 0.001 HBD to stay above dust threshold.
 */
export function calculateRewardPerChallenge(hbdBudget: string, durationDays: number): string {
  const budget = parseFloat(hbdBudget);
  const estimatedChallenges = Math.max(1, Math.floor(durationDays / 3));
  const reward = Math.max(0.001, budget / estimatedChallenges);
  return reward.toFixed(3);
}
