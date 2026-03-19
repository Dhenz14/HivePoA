/**
 * Spirit Bomb Community Cloud — Integration Tests
 *
 * Tests the HivePoA-side Spirit Bomb infrastructure:
 *   SB1 — Create GPU cluster and add members
 *   SB2 — Cluster stats auto-recalculate on member add/remove
 *   SB3 — Publish tier manifest and query latest
 *   SB4 — Create inference route and list active routes
 *   SB5 — Record inference contribution and query stats
 *   SB6 — Cross-cluster independence (different regions)
 *   SB7 — Tier derivation from GPU count
 *   SB8 — Manifest validation (tier/GPU mismatch rejected)
 *   SB9 — Dashboard data assembly
 *   SB10 — Contribution period aggregation
 */
import { describe, it, expect, beforeAll } from "vitest";
import { db } from "../../db";
import { sql } from "drizzle-orm";
import { DatabaseStorage } from "../../storage";
import { SpiritBombService } from "../spirit-bomb-service";

// ── Helpers ──────────────────────────────────────────────────────

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

let storage: DatabaseStorage;
let spiritBomb: SpiritBombService;
let testNodeId1: string;
let testNodeId2: string;

/** Create a test compute node. */
async function createTestNode(gpuModel: string, vramGb: number): Promise<string> {
  const id = `sb-node-${uid()}`;
  await db.execute(sql`
    INSERT INTO compute_nodes (id, node_instance_id, hive_username, status, gpu_model, gpu_vram_gb, supported_workloads, price_per_hour_hbd, reputation_score, total_jobs_completed, total_jobs_failed, total_hbd_earned, jobs_in_progress, created_at)
    VALUES (${id}, ${`inst-${uid()}`}, ${`user-${uid()}`}, 'online', ${gpuModel}, ${vramGb}, 'gpu_poa_challenge', '0.50', 50, 0, 0, '0', 0, now())
  `);
  return id;
}

/** Ensure Spirit Bomb tables exist. */
async function ensureTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS gpu_clusters (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      geo_hash TEXT,
      status TEXT NOT NULL DEFAULT 'forming',
      total_gpus INTEGER NOT NULL DEFAULT 0,
      total_vram_gb INTEGER NOT NULL DEFAULT 0,
      avg_latency_ms REAL,
      max_latency_ms REAL,
      can_tensor_parallel BOOLEAN NOT NULL DEFAULT false,
      can_pipeline_parallel BOOLEAN NOT NULL DEFAULT true,
      coordinator_node_id VARCHAR REFERENCES compute_nodes(id),
      last_health_check TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS gpu_cluster_members (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      cluster_id VARCHAR NOT NULL REFERENCES gpu_clusters(id),
      node_id VARCHAR NOT NULL REFERENCES compute_nodes(id),
      role TEXT NOT NULL DEFAULT 'worker',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_ping_ms REAL,
      gpu_model TEXT,
      vram_gb INTEGER,
      bandwidth_gbps REAL,
      status TEXT NOT NULL DEFAULT 'active'
    )
  `);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS gpu_cluster_member_unique_idx ON gpu_cluster_members(cluster_id, node_id)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS community_tier_manifests (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      tier INTEGER NOT NULL,
      total_gpus INTEGER NOT NULL,
      total_vram_gb INTEGER NOT NULL,
      active_clusters INTEGER NOT NULL DEFAULT 0,
      base_model TEXT NOT NULL,
      active_experts INTEGER NOT NULL,
      quantization TEXT NOT NULL,
      max_context_length INTEGER NOT NULL,
      estimated_tps REAL,
      speculative_decoding_enabled BOOLEAN NOT NULL DEFAULT false,
      ipfs_cid TEXT,
      hive_tx_id TEXT,
      published_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS inference_routes (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      cluster_id VARCHAR REFERENCES gpu_clusters(id),
      mode TEXT NOT NULL,
      model_name TEXT NOT NULL,
      pipeline_stages INTEGER NOT NULL DEFAULT 1,
      tensor_parallel_size INTEGER NOT NULL DEFAULT 1,
      total_requests INTEGER NOT NULL DEFAULT 0,
      avg_latency_ms REAL,
      avg_tps REAL,
      p99_latency_ms REAL,
      status TEXT NOT NULL DEFAULT 'active',
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS inference_contributions (
      id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      node_id VARCHAR NOT NULL REFERENCES compute_nodes(id),
      cluster_id VARCHAR REFERENCES gpu_clusters(id),
      total_tokens_generated BIGINT NOT NULL DEFAULT 0,
      total_inference_ms BIGINT NOT NULL DEFAULT 0,
      total_requests_served INTEGER NOT NULL DEFAULT 0,
      hbd_earned REAL NOT NULL DEFAULT 0,
      reputation_bonus INTEGER NOT NULL DEFAULT 0,
      period_start TIMESTAMPTZ NOT NULL,
      period_end TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ── Setup ────────────────────────────────────────────────────────

beforeAll(async () => {
  storage = new DatabaseStorage();
  spiritBomb = new SpiritBombService(storage);
  await ensureTables();
  testNodeId1 = await createTestNode("RTX 4090", 24);
  testNodeId2 = await createTestNode("RTX 4070 Ti SUPER", 16);
});

// ── Tests ────────────────────────────────────────────────────────

describe("Spirit Bomb Community Cloud", () => {
  let clusterId: string;

  it("SB1 — Create GPU cluster and add members", async () => {
    const cluster = await storage.createGpuCluster({
      name: `test-cluster-${uid()}`,
      region: "us-east",
      status: "forming",
    });
    expect(cluster.id).toBeTruthy();
    expect(cluster.region).toBe("us-east");
    clusterId = cluster.id;

    const member = await storage.addClusterMember({
      clusterId,
      nodeId: testNodeId1,
      role: "coordinator",
      gpuModel: "RTX 4090",
      vramGb: 24,
      lastPingMs: 5.0,
    });
    expect(member.nodeId).toBe(testNodeId1);
  });

  it("SB2 — Cluster stats auto-recalculate on member add", async () => {
    // Add second member
    await storage.addClusterMember({
      clusterId,
      nodeId: testNodeId2,
      role: "worker",
      gpuModel: "RTX 4070 Ti SUPER",
      vramGb: 16,
      lastPingMs: 8.0,
    });

    const cluster = await storage.getGpuCluster(clusterId);
    expect(cluster).toBeTruthy();
    expect(cluster!.totalGpus).toBe(2);
    expect(cluster!.totalVramGb).toBe(40); // 24 + 16
    expect(cluster!.status).toBe("active"); // 2+ members = active
  });

  it("SB3 — Publish tier manifest and query latest", async () => {
    const manifest = await storage.createTierManifest({
      tier: 1,
      totalGpus: 2,
      totalVramGb: 40,
      activeClusters: 1,
      baseModel: "Qwen3-14B",
      activeExperts: 2,
      quantization: "awq",
      maxContextLength: 32768,
      speculativeDecodingEnabled: false,
    });
    expect(manifest.tier).toBe(1);
    expect(manifest.baseModel).toBe("Qwen3-14B");

    const latest = await storage.getLatestTierManifest();
    expect(latest).toBeTruthy();
    expect(latest!.tier).toBe(1);
  });

  it("SB4 — Create inference route and list active", async () => {
    const route = await storage.upsertInferenceRoute({
      clusterId,
      mode: "cluster",
      modelName: "Qwen3-14B",
      pipelineStages: 2,
      tensorParallelSize: 1,
      status: "active",
      priority: 20,
    });
    expect(route.mode).toBe("cluster");

    const routes = await storage.listInferenceRoutes("cluster");
    expect(routes.length).toBeGreaterThanOrEqual(1);
    expect(routes.some(r => r.clusterId === clusterId)).toBe(true);
  });

  it("SB5 — Record inference contribution and query stats", async () => {
    const now = new Date();
    const contrib = await storage.recordInferenceContribution({
      nodeId: testNodeId1,
      clusterId,
      totalTokensGenerated: 10000,
      totalInferenceMs: 5000,
      totalRequestsServed: 50,
      hbdEarned: 0.01,
      reputationBonus: 1,
      periodStart: new Date(now.getTime() - 3600_000),
      periodEnd: now,
    });
    expect(contrib.totalTokensGenerated).toBe(10000);

    const stats = await storage.getInferenceContributionStats();
    expect(stats.totalTokens).toBeGreaterThanOrEqual(10000);
    expect(stats.totalRequests).toBeGreaterThanOrEqual(50);
    expect(stats.activeContributors).toBeGreaterThanOrEqual(1);
  });

  it("SB6 — Cross-cluster independence", async () => {
    const nodeEu = await createTestNode("RTX 3060", 12);
    const clusterEu = await storage.createGpuCluster({
      name: `eu-cluster-${uid()}`,
      region: "eu-west",
      status: "forming",
    });
    await storage.addClusterMember({
      clusterId: clusterEu.id,
      nodeId: nodeEu,
      role: "worker",
      vramGb: 12,
    });

    // EU cluster should be independent
    const euCluster = await storage.getGpuCluster(clusterEu.id);
    expect(euCluster!.totalGpus).toBe(1);

    // US cluster should still have 2
    const usCluster = await storage.getGpuCluster(clusterId);
    expect(usCluster!.totalGpus).toBe(2);
  });

  it("SB7 — Tier derivation from GPU count", () => {
    expect(spiritBomb.deriveTier(0).tier).toBe(1);
    expect(spiritBomb.deriveTier(5).tier).toBe(1);
    expect(spiritBomb.deriveTier(14).tier).toBe(1);
    expect(spiritBomb.deriveTier(15).tier).toBe(2);
    expect(spiritBomb.deriveTier(30).tier).toBe(2);
    expect(spiritBomb.deriveTier(39).tier).toBe(2);
    expect(spiritBomb.deriveTier(40).tier).toBe(3);
    expect(spiritBomb.deriveTier(100).tier).toBe(3);
  });

  it("SB8 — Manifest validation rejects tier/GPU mismatch", () => {
    // 5 GPUs should be tier 1, not tier 2
    const error = spiritBomb.validateManifest({
      tier: 2,
      totalGpus: 5,
      baseModel: "Qwen3-32B",
    } as any);
    expect(error).toBeTruthy();
    expect(error).toContain("mismatch");

    // Valid manifest
    const valid = spiritBomb.validateManifest({
      tier: 1,
      totalGpus: 5,
      baseModel: "Qwen3-14B",
    } as any);
    expect(valid).toBeNull();
  });

  it("SB9 — Member removal updates cluster stats", async () => {
    await storage.removeClusterMember(clusterId, testNodeId2);
    const cluster = await storage.getGpuCluster(clusterId);
    expect(cluster!.totalGpus).toBe(1);
    expect(cluster!.totalVramGb).toBe(24); // only node1 remains
  });

  it("SB10 — Node contribution history", async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const history = await storage.getNodeInferenceContributions(testNodeId1, since);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0].totalTokensGenerated).toBe(10000);
  });

  it("SB11 — Manifest history ordering", async () => {
    // Publish a second manifest
    await storage.createTierManifest({
      tier: 2,
      totalGpus: 20,
      totalVramGb: 320,
      activeClusters: 3,
      baseModel: "Qwen3-32B",
      activeExperts: 4,
      quantization: "awq",
      maxContextLength: 65536,
      speculativeDecodingEnabled: true,
    });

    const history = await storage.getTierManifestHistory(10);
    expect(history.length).toBeGreaterThanOrEqual(2);
    // Newest first
    const t0 = new Date(history[0].createdAt).getTime();
    const t1 = new Date(history[1].createdAt).getTime();
    expect(t0).toBeGreaterThanOrEqual(t1);
  });
});
