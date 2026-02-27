import { storage } from "./storage";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { logSeed } from "./logger";

export async function seedDatabase() {
  // Only seed if database is empty (prevents duplicate seed on every restart)
  try {
    const result = await db.execute(sql`SELECT COUNT(*)::int AS count FROM validators`);
    const count = (result.rows[0] as any)?.count ?? 0;
    if (count > 0) {
      logSeed.info(`[Seed] Database already has ${count} validators — skipping seed`);
      return;
    }
  } catch {
    // Table might not exist yet — proceed with seed
  }

  logSeed.info("[Seed] Empty database detected — seeding initial data...");

  // Create validators (Hive Witnesses)
  const validators = [
    {
      hiveUsername: "threespeak",
      hiveRank: 5,
      status: "online" as const,
      peerCount: 124,
      performance: 98,
      jobAllocation: 95,
      payoutRate: 1.00,
      version: "v0.1.0",
    },
    {
      hiveUsername: "arcange",
      hiveRank: 45,
      status: "online" as const,
      peerCount: 256,
      performance: 96,
      jobAllocation: 88,
      payoutRate: 1.00,
      version: "v0.1.0",
    },
    {
      hiveUsername: "hive-kings",
      hiveRank: 12,
      status: "online" as const,
      peerCount: 89,
      performance: 92,
      jobAllocation: 75,
      payoutRate: 0.95,
      version: "v0.1.0",
    },
    {
      hiveUsername: "pizza-witness",
      hiveRank: 88,
      status: "syncing" as const,
      peerCount: 12,
      performance: 78,
      jobAllocation: 25,
      payoutRate: 0.90,
      version: "v0.0.9",
    },
  ];

  for (const v of validators) {
    try {
      await storage.createValidator(v);
    } catch (e) {
      // Ignore duplicates
    }
  }

  // Create storage nodes
  const nodes = [
    {
      peerId: "QmZ9...4nPx",
      hiveUsername: "storage-pro",
      reputation: 98,
      status: "active" as const,
      totalProofs: 450,
      failedProofs: 2,
    },
    {
      peerId: "QmA1...5oQ",
      hiveUsername: "file-hoster",
      reputation: 92,
      status: "active" as const,
      totalProofs: 320,
      failedProofs: 8,
    },
    {
      peerId: "QmB2...6pR",
      hiveUsername: "node-runner",
      reputation: 45,
      status: "probation" as const,
      totalProofs: 120,
      failedProofs: 35,
    },
  ];

  for (const n of nodes) {
    try {
      await storage.createStorageNode(n);
    } catch (e) {
      // Ignore duplicates
    }
  }

  // Create files
  const files = [
    {
      cid: "QmX7...9jK",
      name: "project_specs_v2.pdf",
      size: "2.4 MB",
      uploaderUsername: "alice",
      status: "pinned" as const,
      replicationCount: 12,
      confidence: 98,
      poaEnabled: true,
    },
    {
      cid: "QmY8...2mL",
      name: "assets_bundle.zip",
      size: "156 MB",
      uploaderUsername: "bob",
      status: "pinned" as const,
      replicationCount: 8,
      confidence: 92,
      poaEnabled: true,
    },
    {
      cid: "QmZ9...4nPx",
      name: "intro_video.mp4",
      size: "45 MB",
      uploaderUsername: "charlie",
      status: "syncing" as const,
      replicationCount: 1,
      confidence: 0,
      poaEnabled: false,
    },
    {
      cid: "QmA1...5oQ",
      name: "dataset_01.json",
      size: "12 KB",
      uploaderUsername: "david",
      status: "pinned" as const,
      replicationCount: 45,
      confidence: 99,
      poaEnabled: true,
    },
  ];

  for (const f of files) {
    try {
      await storage.createFile(f);
    } catch (e) {
      // Ignore duplicates
    }
  }

  logSeed.info("[Seed] Database seeded successfully");
}
