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

import { createHash } from "crypto";
import { DatabaseStorage } from "../storage";
import type {
  GpuCluster,
  CommunityTierManifest,
} from "@shared/schema";
import type { CustomJsonRequest, HiveTransaction } from "./hive-client";

// ── Tier Configuration ──────────────────────────────────────────
// Tiers are ADDITIVE: more GPUs = more options, never removes what works.
// Tier 1 (Solo): Hive-AI's own stack (v5-think on llama-server) unchanged.
// Tier 2 (Pool): Multiple GPUs serve independent requests — throughput scaling.
// Tier 3 (Cluster): GPUs combine via vLLM PP for larger model — capability scaling.
//
// IMPORTANT: These configs must stay in sync with community_coordinator.py in Hive-AI.

const TIER_MODEL_CONFIG = {
  1: {
    mode: "solo" as const,
    baseModel: "hiveai-v5-think",
    description: "Local Hive-AI stack (llama-server + smart routing + MoLoRA)",
    activeExperts: 0,
    quantization: "gguf",
    maxContextLength: 32768,
    speculativeDecodingEnabled: false,
  },
  2: {
    mode: "pool" as const,
    baseModel: "hiveai-v5-think",
    description: "Independent GPUs serving parallel requests — throughput scaling",
    activeExperts: 0,
    quantization: "gguf",
    maxContextLength: 32768,
    speculativeDecodingEnabled: false,
  },
  3: {
    mode: "cluster" as const,
    baseModel: "Qwen3-32B",
    description: "Pipeline-parallel larger model via vLLM + local smart routing",
    activeExperts: 4,
    quantization: "awq",
    maxContextLength: 65536,
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
  mode: "solo" | "pool" | "cluster";
  description: string;
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
   * Derive the current community tier from pool state.
   *
   * Solo (1): 0-1 GPUs — Hive-AI's own stack unchanged
   * Pool (2): 2+ GPUs — each serves independent requests (throughput scaling)
   * Cluster (3): 2+ GPUs with low latency + enough VRAM — combine via vLLM PP
   *
   * @param hasQualifiedCluster - true if any cluster has <50ms latency + 24GB+ VRAM
   */
  deriveTier(totalGpus: number, hasQualifiedCluster: boolean = false): TierConfig {
    let tier = 1;

    if (totalGpus >= 2) {
      tier = 2; // Pool: multiple independent GPUs
    }
    if (totalGpus >= 2 && hasQualifiedCluster) {
      tier = 3; // Cluster: GPUs can combine (latency + VRAM qualified)
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

    // Check if any cluster qualifies for pipeline parallel (low latency + enough VRAM)
    const hasQualifiedCluster = clusters.some(
      (c: GpuCluster) => c.totalGpus >= 2 && c.totalVramGb >= 24
        && (c.canPipelineParallel === true || (c.avgLatencyMs != null && c.avgLatencyMs < 50)),
    );

    return {
      totalGpus,
      totalVramGb,
      onlineNodes: totalGpus, // 1 GPU per node for now
      activeClusters: clusters.length,
      currentTier: manifest?.tier ?? this.deriveTier(totalGpus, hasQualifiedCluster).tier,
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
    if (manifest.totalGpus === undefined || manifest.totalGpus < 0) {
      return "Invalid totalGpus: must be non-negative";
    }
    if (!manifest.baseModel) {
      return "Missing baseModel";
    }

    // Tier 2+ (Pool/Cluster) requires at least 2 GPUs
    if (manifest.tier >= 2 && manifest.totalGpus < 2) {
      return `Tier ${manifest.tier} requires at least 2 GPUs, got ${manifest.totalGpus}`;
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

  /**
   * Publish the latest tier manifest to Hive blockchain as a custom_json.
   *
   * Uses the existing HiveClient's broadcastCustomJson (or with reconciliation).
   * Rate-limited: skips if the manifest hasn't changed since last publish.
   *
   * @param hiveClient - HiveClient instance (real or mock)
   * @returns Transaction result, or null if skipped
   */
  async publishManifestToHive(
    hiveClient: { broadcastCustomJson(req: CustomJsonRequest): Promise<HiveTransaction> },
  ): Promise<{ hiveTxId: string; published: boolean; reason?: string } | null> {
    const manifest = await this.storage.getLatestTierManifest();
    if (!manifest) {
      return { hiveTxId: "", published: false, reason: "No manifest exists" };
    }

    // Skip if already published to Hive
    if (manifest.hiveTxId) {
      return { hiveTxId: manifest.hiveTxId, published: false, reason: "Already published" };
    }

    // Compute cluster topology hash
    const clusters = await this.storage.listGpuClusters();
    const topoData = clusters.map((c: GpuCluster) => `${c.id}:${c.totalGpus}`).sort().join(",");
    const topoHash = createHash("sha256").update(topoData).digest("hex").slice(0, 16);

    // Build compact on-chain payload (short keys to minimize storage)
    const payload = {
      v: 2,
      tier: manifest.tier,
      mode: (manifest as any).mode || "solo",
      gpus: manifest.totalGpus,
      vram: manifest.totalVramGb,
      clusters: manifest.activeClusters,
      model: manifest.baseModel,
      experts: manifest.activeExperts,
      quant: manifest.quantization,
      ctx: manifest.maxContextLength,
      spec: manifest.speculativeDecodingEnabled,
      tps: manifest.estimatedTps,
      topo: topoHash,
      ts: manifest.createdAt instanceof Date
        ? manifest.createdAt.toISOString()
        : new Date(manifest.createdAt).toISOString(),
    };

    try {
      const tx = await hiveClient.broadcastCustomJson({
        id: "spiritbomb_manifest",
        json: payload,
        requiredPostingAuths: undefined, // uses default from HiveClient config
      });

      // Store the tx ID on the manifest
      // (communityTierManifests.hiveTxId exists in schema but storage has no update method)
      // For now, return the tx ID for the caller to handle
      return { hiveTxId: tx.id, published: true };
    } catch (err: any) {
      return { hiveTxId: "", published: false, reason: `Broadcast failed: ${err.message}` };
    }
  }
}
