/**
 * Spirit Bomb Service — Community Cloud Coordination (HivePoA side)
 *
 * Server-side coordination logic for the Spirit Bomb community GPU cloud.
 * Handles:
 *   - Tier derivation from online compute node count
 *   - Cluster health monitoring (marks degraded/dissolved clusters)
 *   - Automatic stale cluster cleanup
 *   - Tier manifest validation
 *   - Pool statistics for the dashboard
 *
 * The Python-side CommunityCoordinator (in Hive-AI) is the active poller
 * that calls these APIs. This service provides the server-side validation
 * and automation that runs inside HivePoA.
 */

import { DatabaseStorage } from "../storage";
import type {
  GpuCluster,
  CommunityTierManifest,
} from "@shared/schema";

// ── Tier Configuration ──────────────────────────────────────────

const TIER_THRESHOLDS = {
  1: { minGpus: 0, maxGpus: 14 },
  2: { minGpus: 15, maxGpus: 39 },
  3: { minGpus: 40, maxGpus: Infinity },
} as const;

const TIER_MODEL_CONFIG = {
  1: {
    baseModel: "Qwen3-14B",
    activeExperts: 2,
    quantization: "awq",
    maxContextLength: 32768,
    speculativeDecodingEnabled: false,
  },
  2: {
    baseModel: "Qwen3-32B",
    activeExperts: 4,
    quantization: "awq",
    maxContextLength: 65536,
    speculativeDecodingEnabled: true,
  },
  3: {
    baseModel: "Qwen3-Coder-80B-MoE",
    activeExperts: 8,
    quantization: "fp16",
    maxContextLength: 131072,
    speculativeDecodingEnabled: true,
  },
} as const;

// Cluster health thresholds
const CLUSTER_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min without health check
const MANIFEST_EXPIRY_MS = 60 * 60 * 1000; // manifests expire after 1 hour

interface PoolSnapshot {
  totalGpus: number;
  totalVramGb: number;
  onlineNodes: number;
  activeClusters: number;
  currentTier: number;
}

interface TierConfig {
  tier: number;
  baseModel: string;
  activeExperts: number;
  quantization: string;
  maxContextLength: number;
  speculativeDecodingEnabled: boolean;
}

export class SpiritBombService {
  private storage: DatabaseStorage;
  private sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(storage: DatabaseStorage, sweepIntervalMs = 5 * 60 * 1000) {
    this.storage = storage;
    this.sweepIntervalMs = sweepIntervalMs;
  }

  /**
   * Start the background sweep loop for cluster health monitoring.
   */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweepStaleClusters().catch(() => {});
    }, this.sweepIntervalMs);
  }

  /**
   * Stop the background sweep loop.
   */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Derive the current community tier from online node count.
   */
  deriveTier(totalGpus: number): TierConfig {
    let tier = 1;
    for (const [t, thresholds] of Object.entries(TIER_THRESHOLDS)) {
      const tierNum = parseInt(t);
      if (totalGpus >= thresholds.minGpus) {
        tier = tierNum;
      }
    }

    const config = TIER_MODEL_CONFIG[tier as 1 | 2 | 3];
    return {
      tier,
      ...config,
    };
  }

  /**
   * Get a snapshot of the current community GPU pool.
   */
  async getPoolSnapshot(): Promise<PoolSnapshot> {
    const [clusters, manifest] = await Promise.all([
      this.storage.listGpuClusters(),
      this.storage.getLatestTierManifest(),
    ]);

    const totalGpus = clusters.reduce((sum: number, c: GpuCluster) => sum + c.totalGpus, 0);
    const totalVramGb = clusters.reduce((sum: number, c: GpuCluster) => sum + c.totalVramGb, 0);

    return {
      totalGpus,
      totalVramGb,
      onlineNodes: totalGpus, // 1 GPU per node for now
      activeClusters: clusters.length,
      currentTier: manifest?.tier ?? this.deriveTier(totalGpus).tier,
    };
  }

  /**
   * Validate a tier manifest before accepting it.
   * Returns null if valid, or an error message.
   */
  validateManifest(manifest: Partial<CommunityTierManifest>): string | null {
    if (!manifest.tier || manifest.tier < 1 || manifest.tier > 3) {
      return "Invalid tier: must be 1, 2, or 3";
    }
    if (!manifest.totalGpus || manifest.totalGpus < 0) {
      return "Invalid totalGpus: must be non-negative";
    }
    if (!manifest.baseModel) {
      return "Missing baseModel";
    }

    // Verify tier matches GPU count
    const expectedTier = this.deriveTier(manifest.totalGpus);
    if (manifest.tier !== expectedTier.tier) {
      return `Tier mismatch: ${manifest.totalGpus} GPUs should be tier ${expectedTier.tier}, not ${manifest.tier}`;
    }

    return null;
  }

  /**
   * Sweep stale clusters — mark as degraded or dissolved.
   */
  async sweepStaleClusters(): Promise<number> {
    const clusters = await this.storage.listGpuClusters();
    const now = Date.now();
    let swept = 0;

    for (const cluster of clusters) {
      if (cluster.status === "dissolved") continue;

      const lastCheck = cluster.lastHealthCheck
        ? new Date(cluster.lastHealthCheck).getTime()
        : new Date(cluster.createdAt).getTime();

      const staleness = now - lastCheck;

      if (staleness > CLUSTER_STALE_THRESHOLD_MS * 2) {
        // Very stale — dissolve
        await this.storage.updateGpuCluster(cluster.id, {
          status: "dissolved",
        });
        swept++;
      } else if (staleness > CLUSTER_STALE_THRESHOLD_MS) {
        // Moderately stale — mark degraded
        if (cluster.status !== "degraded") {
          await this.storage.updateGpuCluster(cluster.id, {
            status: "degraded",
          });
          swept++;
        }
      }
    }

    return swept;
  }

  /**
   * Get full dashboard data for the Spirit Bomb UI.
   */
  async getDashboard(): Promise<{
    pool: PoolSnapshot;
    tierConfig: TierConfig;
    latestManifest: CommunityTierManifest | undefined;
    manifestFresh: boolean;
    clusterHealth: { active: number; degraded: number; forming: number; dissolved: number };
    contributions: { totalTokens: number; totalRequests: number; totalHbdEarned: number; activeContributors: number };
  }> {
    const [pool, manifest, contribStats, allClusters] = await Promise.all([
      this.getPoolSnapshot(),
      this.storage.getLatestTierManifest(),
      this.storage.getInferenceContributionStats(),
      this.storage.listGpuClusters(), // includes all statuses
    ]);

    const tierConfig = this.deriveTier(pool.totalGpus);

    // Check manifest freshness
    const manifestFresh = manifest
      ? (Date.now() - new Date(manifest.createdAt).getTime()) < MANIFEST_EXPIRY_MS
      : false;

    // Cluster health breakdown
    const clusterHealth = {
      active: allClusters.filter((c: GpuCluster) => c.status === "active").length,
      degraded: allClusters.filter((c: GpuCluster) => c.status === "degraded").length,
      forming: allClusters.filter((c: GpuCluster) => c.status === "forming").length,
      dissolved: 0, // not returned by listGpuClusters (filters to active)
    };

    return {
      pool,
      tierConfig,
      latestManifest: manifest,
      manifestFresh,
      clusterHealth,
      contributions: contribStats,
    };
  }
}
