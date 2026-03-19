/**
 * SQLite implementation of IStorage — mirrors server/storage.ts (PostgreSQL)
 * but uses better-sqlite3 via Drizzle ORM for embedded desktop agent use.
 *
 * Key differences from the PostgreSQL version:
 *   - UUIDs generated in JS via crypto.randomUUID()
 *   - Timestamps stored as ISO 8601 text; converted to/from Date on read/write
 *   - PG-specific SQL replaced with SQLite equivalents
 *   - db.all() / db.get() / db.run() instead of db.execute()
 */

import { randomUUID } from "crypto";
import { eq, desc, and, sql, or, notInArray, gte, lte, lt } from "drizzle-orm";
import { getSQLiteDb } from "./db-sqlite";
import * as S from "../shared/schema-sqlite";

import type { IStorage } from "./storage";
import type {
  StorageNode, InsertStorageNode,
  File, InsertFile,
  Validator, InsertValidator,
  PoaChallenge, InsertPoaChallenge,
  HiveTransaction, InsertHiveTransaction,
  StorageAssignment,
  ValidatorBlacklist, InsertValidatorBlacklist,
  CdnNode, InsertCdnNode,
  CdnMetric, InsertCdnMetric,
  FileChunk, InsertFileChunk,
  StorageContract, InsertStorageContract,
  ContractEvent, InsertContractEvent,
  TranscodeJob, InsertTranscodeJob,
  EncoderNode, InsertEncoderNode,
  EncodingJob, InsertEncodingJob,
  BlocklistEntry, InsertBlocklistEntry,
  PlatformBlocklist, InsertPlatformBlocklist,
  Tag, InsertTag,
  FileTag, InsertFileTag,
  TagVote, InsertTagVote,
  UserKey, InsertUserKey,
  UserNodeSettings, InsertUserNodeSettings,
  ViewEvent, InsertViewEvent,
  BeneficiaryAllocation, InsertBeneficiaryAllocation,
  PayoutHistory, InsertPayoutHistory,
  WalletDeposit, InsertWalletDeposit,
  PayoutReport, InsertPayoutReport,
  PayoutLineItem, InsertPayoutLineItem,
  P2pSession, InsertP2pSession,
  P2pContribution, InsertP2pContribution,
  P2pRoom, InsertP2pRoom,
  P2pNetworkStats, InsertP2pNetworkStats,
  EncodingJobOffer, InsertEncodingJobOffer,
  WebOfTrust, InsertWebOfTrust,
  TreasurySigner, InsertTreasurySigner,
  TreasuryVouch, InsertTreasuryVouch,
  TreasuryTransaction, InsertTreasuryTransaction,
  TreasuryAuditLog, InsertTreasuryAuditLog,
  ContentFlag, InsertContentFlag,
  UploaderBan, InsertUploaderBan,
  ComputeNode, InsertComputeNode,
  ComputeJob, InsertComputeJob,
  ComputeJobAttempt, InsertComputeJobAttempt,
  ComputeVerification, InsertComputeVerification,
  ComputePayout, InsertComputePayout,
  ComputeWallet, InsertComputeWallet,
  ComputeWalletLedgerEntry, InsertComputeWalletLedgerEntry,
  ComputePayoutBroadcast, InsertComputePayoutBroadcast,
} from "@shared/schema";

// ============================================================
// Timestamp conversion helpers
// ============================================================

/** Convert a Date (or string) to an ISO string for SQLite storage. */
function toISO(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return d;
}

/** Convert an ISO string from SQLite back to a Date object. */
function toDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  return new Date(s);
}

/** Return current time as ISO string. */
function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Map a raw SQLite row, converting all known timestamp text columns back to Date objects.
 * This ensures the returned types match the PG interface (which uses Date).
 */
const TIMESTAMP_FIELDS: string[] = [
  "createdAt", "lastSeen", "lastHeartbeat", "lastProofAt",
  "uploadExpiresAt", "validatorApprovalAt", "startsAt", "expiresAt",
  "startedAt", "completedAt", "assignedAt", "leaseExpiresAt", "nextRetryAt",
  "executedAt", "periodStart", "periodEnd", "syncedAt",
  "joinedAt", "lastActiveAt", "disconnectedAt", "timestamp",
  "autoPinLastReset", "downloadLastReset", "updatedAt",
  "acceptedAt", "lastUsedAt", "revokedAt",
];

function mapRow<T>(row: any): T {
  if (!row) return row;
  const out: any = { ...row };
  for (let i = 0; i < TIMESTAMP_FIELDS.length; i++) {
    const key = TIMESTAMP_FIELDS[i];
    if (key in out && typeof out[key] === "string") {
      out[key] = new Date(out[key]);
    }
  }
  return out as T;
}

function mapRows<T>(rows: any[]): T[] {
  return rows.map(r => mapRow<T>(r));
}

/** Safely parse JSON text fields (signatures, metadata) on treasury transaction rows. */
function parseTxJsonFields(row: any): TreasuryTransaction {
  try {
    if (typeof row.signatures === "string") row.signatures = JSON.parse(row.signatures);
    else if (!row.signatures) row.signatures = {};
  } catch { row.signatures = {}; }
  try {
    if (row.metadata && typeof row.metadata === "string") row.metadata = JSON.parse(row.metadata);
  } catch { row.metadata = null; }
  return row as TreasuryTransaction;
}

// ============================================================
// Helper to get the DB lazily
// ============================================================
function db() {
  return getSQLiteDb();
}

// ============================================================
// SQLiteStorage class
// ============================================================

export class SQLiteStorage implements IStorage {

  // ============================================================
  // Storage Nodes
  // ============================================================

  async getStorageNode(id: string): Promise<StorageNode | undefined> {
    const [row] = await db().select().from(S.storageNodes).where(eq(S.storageNodes.id, id));
    return row ? mapRow<StorageNode>(row) : undefined;
  }

  async getStorageNodeByPeerId(peerId: string): Promise<StorageNode | undefined> {
    const [row] = await db().select().from(S.storageNodes).where(eq(S.storageNodes.peerId, peerId));
    return row ? mapRow<StorageNode>(row) : undefined;
  }

  async getAllStorageNodes(): Promise<StorageNode[]> {
    const rows = await db().select().from(S.storageNodes).orderBy(desc(S.storageNodes.reputation));
    return mapRows<StorageNode>(rows);
  }

  async createStorageNode(node: InsertStorageNode): Promise<StorageNode> {
    const n = node as any;
    const [created] = await db().insert(S.storageNodes).values({
      id: randomUUID(),
      ...n,
      lastSeen: toISO(n.lastSeen) ?? nowISO(),
      createdAt: toISO(n.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<StorageNode>(created);
  }

  async updateStorageNodeReputation(id: string, reputation: number, status: string, consecutiveFails?: number): Promise<void> {
    const clampedRep = Math.max(0, Math.min(100, reputation));
    const updateData: any = {
      reputation: sql`MAX(0, MIN(100, ${clampedRep}))`,
      status,
      lastSeen: nowISO(),
    };
    if (consecutiveFails !== undefined) {
      updateData.consecutiveFails = consecutiveFails;
    }
    await db().update(S.storageNodes)
      .set(updateData)
      .where(eq(S.storageNodes.id, id));
  }

  async updateNodeEarnings(id: string, hbdAmount: number): Promise<void> {
    await db().update(S.storageNodes)
      .set({
        totalEarnedHbd: sql`COALESCE(${S.storageNodes.totalEarnedHbd}, 0) + ${hbdAmount}`,
      })
      .where(eq(S.storageNodes.id, id));
  }

  async updateStorageNodeLastSeen(id: string): Promise<void> {
    await db().update(S.storageNodes)
      .set({ lastSeen: nowISO() })
      .where(eq(S.storageNodes.id, id));
  }

  async decayInactiveNodeReputation(inactiveDays: number, decayPerDay: number): Promise<number> {
    const cutoff = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000);
    const result = await db().update(S.storageNodes)
      .set({
        reputation: sql`MAX(0, reputation - ${decayPerDay})`,
      })
      .where(
        and(
          lt(S.storageNodes.lastSeen, toISO(cutoff)!),
          sql`${S.storageNodes.reputation} > 0`,
          sql`${S.storageNodes.status} != 'banned'`
        )
      )
      .returning({ id: S.storageNodes.id });
    return result.length;
  }

  // ============================================================
  // Files
  // ============================================================

  async getFile(id: string): Promise<File | undefined> {
    const [row] = await db().select().from(S.files).where(eq(S.files.id, id));
    return row ? mapRow<File>(row) : undefined;
  }

  async getFileByCid(cid: string): Promise<File | undefined> {
    const [row] = await db().select().from(S.files).where(eq(S.files.cid, cid));
    return row ? mapRow<File>(row) : undefined;
  }

  async getAllFiles(): Promise<File[]> {
    const rows = await db().select().from(S.files).orderBy(desc(S.files.createdAt));
    return mapRows<File>(rows);
  }

  async createFile(file: InsertFile): Promise<File> {
    const f = file as any;
    const [created] = await db().insert(S.files).values({
      id: randomUUID(),
      ...f,
      createdAt: toISO(f.createdAt) ?? nowISO(),
      uploadExpiresAt: toISO(f.uploadExpiresAt),
    } as any).returning();
    return mapRow<File>(created);
  }

  async getUserStorageUsed(username: string): Promise<number> {
    const result = await db().select({
      total: sql<number>`COALESCE(SUM(${S.files.sizeBytes}), 0)`,
    }).from(S.files).where(and(
      eq(S.files.uploaderUsername, username),
      sql`${S.files.status} IN ('pinned', 'syncing', 'warning')`,
    ));
    return Number(result[0]?.total || 0);
  }

  async getActiveUserTierContract(username: string): Promise<StorageContract | undefined> {
    const rows = await db().select().from(S.storageContracts)
      .where(and(
        eq(S.storageContracts.uploaderUsername, username),
        eq(S.storageContracts.status, "active"),
        sql`${S.storageContracts.storageTierId} IS NOT NULL`,
        sql`${S.storageContracts.expiresAt} > datetime('now')`,
      ))
      .orderBy(desc(S.storageContracts.createdAt))
      .limit(1);
    const mapped = mapRows<StorageContract>(rows);
    return mapped[0] || undefined;
  }

  async deleteFile(id: string): Promise<boolean> {
    // Delete contract events via subquery
    await db().run(sql`DELETE FROM contract_events WHERE contract_id IN (SELECT id FROM storage_contracts WHERE file_id = ${id})`);

    // Cascade deletes for dependent tables
    await db().delete(S.fileChunks).where(eq(S.fileChunks.fileId, id));
    await db().delete(S.fileTags).where(eq(S.fileTags.fileId, id));
    await db().delete(S.transcodeJobs).where(eq(S.transcodeJobs.fileId, id));
    await db().delete(S.viewEvents).where(eq(S.viewEvents.fileId, id));
    await db().delete(S.storageContracts).where(eq(S.storageContracts.fileId, id));

    const result = await db().delete(S.files).where(eq(S.files.id, id)).returning();
    return result.length > 0;
  }

  async updateFileStatus(id: string, status: string, replicationCount: number, confidence: number): Promise<void> {
    await db().update(S.files)
      .set({ status, replicationCount, confidence })
      .where(eq(S.files.id, id));
  }

  async updateFileCid(id: string, newCid: string): Promise<void> {
    await db().update(S.files)
      .set({ cid: newCid })
      .where(eq(S.files.id, id));
  }

  async updateFileEarnings(id: string, hbdAmount: number): Promise<void> {
    await db().update(S.files)
      .set({
        earnedHbd: sql`COALESCE(${S.files.earnedHbd}, 0) + ${hbdAmount}`,
      })
      .where(eq(S.files.id, id));
  }

  // ============================================================
  // Validators
  // ============================================================

  async getValidator(id: string): Promise<Validator | undefined> {
    const [row] = await db().select().from(S.validators).where(eq(S.validators.id, id));
    return row ? mapRow<Validator>(row) : undefined;
  }

  async getValidatorByUsername(username: string): Promise<Validator | undefined> {
    const [row] = await db().select().from(S.validators).where(eq(S.validators.hiveUsername, username));
    return row ? mapRow<Validator>(row) : undefined;
  }

  async getAllValidators(): Promise<Validator[]> {
    const rows = await db().select().from(S.validators).orderBy(desc(S.validators.performance));
    return mapRows<Validator>(rows);
  }

  async createValidator(validator: InsertValidator): Promise<Validator> {
    const v = validator as any;
    const [created] = await db().insert(S.validators).values({
      id: randomUUID(),
      ...v,
      createdAt: toISO(v.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<Validator>(created);
  }

  async updateValidatorStats(id: string, peerCount: number, performance: number): Promise<void> {
    await db().update(S.validators)
      .set({ peerCount, performance })
      .where(eq(S.validators.id, id));
  }

  // ============================================================
  // PoA Challenges
  // ============================================================

  async createPoaChallenge(challenge: InsertPoaChallenge): Promise<PoaChallenge> {
    const c = challenge as any;
    const [created] = await db().insert(S.poaChallenges).values({
      id: randomUUID(),
      ...c,
      createdAt: toISO(c.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<PoaChallenge>(created);
  }

  async getRecentChallenges(limit: number): Promise<PoaChallenge[]> {
    const rows = await db().select().from(S.poaChallenges).orderBy(desc(S.poaChallenges.createdAt)).limit(limit);
    return mapRows<PoaChallenge>(rows);
  }

  async updateChallengeResult(id: string, response: string, result: string, latencyMs: number): Promise<void> {
    await db().update(S.poaChallenges)
      .set({ response, result, latencyMs })
      .where(eq(S.poaChallenges.id, id));
  }

  // ============================================================
  // Hive Transactions
  // ============================================================

  async createHiveTransaction(transaction: InsertHiveTransaction): Promise<HiveTransaction> {
    const t = transaction as any;
    const [created] = await db().insert(S.hiveTransactions).values({
      id: randomUUID(),
      ...t,
      createdAt: toISO(t.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<HiveTransaction>(created);
  }

  async getRecentTransactions(limit: number): Promise<HiveTransaction[]> {
    const rows = await db().select().from(S.hiveTransactions).orderBy(desc(S.hiveTransactions.createdAt)).limit(limit);
    return mapRows<HiveTransaction>(rows);
  }

  // ============================================================
  // Storage Assignments
  // ============================================================

  async assignFileToNode(fileId: string, nodeId: string): Promise<void> {
    await db().insert(S.storageAssignments).values({
      id: randomUUID(),
      fileId,
      nodeId,
    } as any);
  }

  async getFileAssignments(fileId: string): Promise<StorageAssignment[]> {
    const rows = await db().select().from(S.storageAssignments).where(eq(S.storageAssignments.fileId, fileId));
    return mapRows<StorageAssignment>(rows);
  }

  async updateAssignmentProof(fileId: string, nodeId: string, success: boolean): Promise<void> {
    const [assignment] = await db().select().from(S.storageAssignments)
      .where(and(
        eq(S.storageAssignments.fileId, fileId),
        eq(S.storageAssignments.nodeId, nodeId)
      ));

    if (assignment) {
      await db().update(S.storageAssignments)
        .set({
          proofCount: success ? assignment.proofCount + 1 : assignment.proofCount,
          failCount: success ? assignment.failCount : assignment.failCount + 1,
          lastProofAt: nowISO(),
        })
        .where(eq(S.storageAssignments.id, assignment.id));
    }
  }

  // ============================================================
  // Validator Blacklist
  // ============================================================

  async searchStorageNodes(query: string): Promise<StorageNode[]> {
    if (!query.trim()) {
      const rows = await db().select().from(S.storageNodes).orderBy(desc(S.storageNodes.reputation)).limit(50);
      return mapRows<StorageNode>(rows);
    }
    const pattern = `%${query}%`;
    const rows = await db().select().from(S.storageNodes)
      .where(or(
        sql`${S.storageNodes.hiveUsername} LIKE ${pattern}`,
        sql`${S.storageNodes.peerId} LIKE ${pattern}`
      ))
      .orderBy(desc(S.storageNodes.reputation))
      .limit(50);
    return mapRows<StorageNode>(rows);
  }

  async getValidatorBlacklist(validatorId: string): Promise<ValidatorBlacklist[]> {
    const rows = await db().select().from(S.validatorBlacklists)
      .where(and(
        eq(S.validatorBlacklists.validatorId, validatorId),
        eq(S.validatorBlacklists.active, true)
      ))
      .orderBy(desc(S.validatorBlacklists.createdAt));
    return mapRows<ValidatorBlacklist>(rows);
  }

  async addToBlacklist(entry: InsertValidatorBlacklist): Promise<ValidatorBlacklist> {
    const [existing] = await db().select().from(S.validatorBlacklists)
      .where(and(
        eq(S.validatorBlacklists.validatorId, entry.validatorId),
        eq(S.validatorBlacklists.nodeId, entry.nodeId)
      ))
      .limit(1);

    if (existing) {
      const [updated] = await db().update(S.validatorBlacklists)
        .set({ active: true, reason: entry.reason })
        .where(eq(S.validatorBlacklists.id, existing.id))
        .returning();
      return mapRow<ValidatorBlacklist>(updated);
    }

    const [created] = await db().insert(S.validatorBlacklists).values({
      id: randomUUID(),
      ...entry,
      createdAt: nowISO(),
    } as any).returning();
    return mapRow<ValidatorBlacklist>(created);
  }

  async removeFromBlacklist(validatorId: string, nodeId: string): Promise<void> {
    await db().update(S.validatorBlacklists)
      .set({ active: false })
      .where(and(
        eq(S.validatorBlacklists.validatorId, validatorId),
        eq(S.validatorBlacklists.nodeId, nodeId),
        eq(S.validatorBlacklists.active, true)
      ));
  }

  async isNodeBlacklisted(validatorId: string, nodeId: string): Promise<boolean> {
    const [entry] = await db().select().from(S.validatorBlacklists)
      .where(and(
        eq(S.validatorBlacklists.validatorId, validatorId),
        eq(S.validatorBlacklists.nodeId, nodeId),
        eq(S.validatorBlacklists.active, true)
      ));
    return !!entry;
  }

  async getEligibleNodesForValidator(validatorId: string): Promise<StorageNode[]> {
    const blacklistedNodeIds = await db().select({ nodeId: S.validatorBlacklists.nodeId })
      .from(S.validatorBlacklists)
      .where(and(
        eq(S.validatorBlacklists.validatorId, validatorId),
        eq(S.validatorBlacklists.active, true)
      ));

    const blacklistedIds = blacklistedNodeIds.map(b => b.nodeId);

    if (blacklistedIds.length === 0) {
      const rows = await db().select().from(S.storageNodes)
        .where(eq(S.storageNodes.status, "active"))
        .orderBy(desc(S.storageNodes.reputation));
      return mapRows<StorageNode>(rows);
    }

    const rows = await db().select().from(S.storageNodes)
      .where(and(
        eq(S.storageNodes.status, "active"),
        notInArray(S.storageNodes.id, blacklistedIds)
      ))
      .orderBy(desc(S.storageNodes.reputation));
    return mapRows<StorageNode>(rows);
  }

  // ============================================================
  // Phase 1: CDN Nodes
  // ============================================================

  async getCdnNode(id: string): Promise<CdnNode | undefined> {
    const [row] = await db().select().from(S.cdnNodes).where(eq(S.cdnNodes.id, id));
    return row ? mapRow<CdnNode>(row) : undefined;
  }

  async getCdnNodeByPeerId(peerId: string): Promise<CdnNode | undefined> {
    const [row] = await db().select().from(S.cdnNodes).where(eq(S.cdnNodes.peerId, peerId));
    return row ? mapRow<CdnNode>(row) : undefined;
  }

  async getAllCdnNodes(): Promise<CdnNode[]> {
    const rows = await db().select().from(S.cdnNodes).orderBy(desc(S.cdnNodes.lastHeartbeat));
    return mapRows<CdnNode>(rows);
  }

  async getActiveCdnNodes(): Promise<CdnNode[]> {
    const rows = await db().select().from(S.cdnNodes)
      .where(or(eq(S.cdnNodes.status, "active"), eq(S.cdnNodes.status, "degraded")))
      .orderBy(desc(S.cdnNodes.lastHeartbeat));
    return mapRows<CdnNode>(rows);
  }

  async createCdnNode(node: InsertCdnNode): Promise<CdnNode> {
    const n = node as any;
    const [created] = await db().insert(S.cdnNodes).values({
      id: randomUUID(),
      ...n,
      lastHeartbeat: toISO(n.lastHeartbeat) ?? nowISO(),
      createdAt: toISO(n.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<CdnNode>(created);
  }

  async updateCdnNodeHeartbeat(id: string): Promise<void> {
    await db().update(S.cdnNodes)
      .set({ lastHeartbeat: nowISO() })
      .where(eq(S.cdnNodes.id, id));
  }

  async updateCdnNodeStatus(id: string, status: string): Promise<void> {
    await db().update(S.cdnNodes)
      .set({ status })
      .where(eq(S.cdnNodes.id, id));
  }

  async updateCdnNodeHealth(id: string, health: { healthScore: string; rawZScore: number; geoZScore: number }): Promise<void> {
    await db().update(S.cdnNodes)
      .set({
        healthScore: health.healthScore,
        rawZScore: health.rawZScore,
        geoZScore: health.geoZScore,
      })
      .where(eq(S.cdnNodes.id, id));
  }

  // ============================================================
  // Phase 1: CDN Metrics
  // ============================================================

  async createCdnMetric(metric: InsertCdnMetric): Promise<CdnMetric> {
    const m = metric as any;
    const [created] = await db().insert(S.cdnMetrics).values({
      id: randomUUID(),
      ...m,
      createdAt: toISO(m.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<CdnMetric>(created);
  }

  async getCdnNodeMetrics(nodeId: string, limit: number): Promise<CdnMetric[]> {
    const rows = await db().select().from(S.cdnMetrics)
      .where(eq(S.cdnMetrics.nodeId, nodeId))
      .orderBy(desc(S.cdnMetrics.createdAt))
      .limit(limit);
    return mapRows<CdnMetric>(rows);
  }

  // ============================================================
  // Phase 1: File Chunks
  // ============================================================

  async createFileChunk(chunk: InsertFileChunk): Promise<FileChunk> {
    const c = chunk as any;
    const [created] = await db().insert(S.fileChunks).values({
      id: randomUUID(),
      ...c,
      createdAt: toISO(c.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<FileChunk>(created);
  }

  async getFileChunks(fileId: string): Promise<FileChunk[]> {
    const rows = await db().select().from(S.fileChunks)
      .where(eq(S.fileChunks.fileId, fileId))
      .orderBy(S.fileChunks.chunkIndex);
    return mapRows<FileChunk>(rows);
  }

  async updateFileChunkStatus(id: string, status: string, checksum?: string): Promise<void> {
    const updates: Record<string, any> = { status };
    if (checksum) updates.checksum = checksum;
    await db().update(S.fileChunks).set(updates).where(eq(S.fileChunks.id, id));
  }

  // ============================================================
  // Phase 1: Storage Contracts
  // ============================================================

  async getStorageContract(id: string): Promise<StorageContract | undefined> {
    const [row] = await db().select().from(S.storageContracts).where(eq(S.storageContracts.id, id));
    return row ? mapRow<StorageContract>(row) : undefined;
  }

  async getStorageContractByCid(cid: string): Promise<StorageContract | undefined> {
    const [row] = await db().select().from(S.storageContracts).where(eq(S.storageContracts.fileCid, cid));
    return row ? mapRow<StorageContract>(row) : undefined;
  }

  async getAllStorageContracts(): Promise<StorageContract[]> {
    const rows = await db().select().from(S.storageContracts).orderBy(desc(S.storageContracts.createdAt));
    return mapRows<StorageContract>(rows);
  }

  async getActiveStorageContracts(): Promise<StorageContract[]> {
    const rows = await db().select().from(S.storageContracts)
      .where(eq(S.storageContracts.status, "active"))
      .orderBy(desc(S.storageContracts.createdAt));
    return mapRows<StorageContract>(rows);
  }

  async createStorageContract(contract: InsertStorageContract): Promise<StorageContract> {
    const c = contract as any;
    const [created] = await db().insert(S.storageContracts).values({
      id: randomUUID(),
      ...c,
      startsAt: toISO(c.startsAt) ?? nowISO(),
      expiresAt: toISO(c.expiresAt)!,
      validatorApprovalAt: toISO(c.validatorApprovalAt),
      createdAt: toISO(c.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<StorageContract>(created);
  }

  async updateStorageContractStatus(id: string, status: string): Promise<void> {
    await db().update(S.storageContracts)
      .set({ status })
      .where(eq(S.storageContracts.id, id));
  }

  async updateStorageContractCid(id: string, newCid: string): Promise<void> {
    await db().update(S.storageContracts)
      .set({ fileCid: newCid })
      .where(eq(S.storageContracts.id, id));
  }

  async getStorageContractsByFileId(fileId: string): Promise<StorageContract[]> {
    const rows = await db().select().from(S.storageContracts)
      .where(eq(S.storageContracts.fileId, fileId));
    return mapRows<StorageContract>(rows);
  }

  async getExpiredContracts(): Promise<StorageContract[]> {
    const rows = await db().select().from(S.storageContracts)
      .where(and(
        eq(S.storageContracts.status, "active"),
        lt(S.storageContracts.expiresAt, nowISO())
      ));
    return mapRows<StorageContract>(rows);
  }

  async getActiveTierContracts(): Promise<StorageContract[]> {
    const rows = await db().select().from(S.storageContracts)
      .where(and(
        eq(S.storageContracts.status, "active"),
        sql`${S.storageContracts.storageTierId} IS NOT NULL`,
        sql`CAST(${S.storageContracts.hbdSpent} AS REAL) < CAST(${S.storageContracts.hbdBudget} AS REAL)`,
        sql`${S.storageContracts.expiresAt} > datetime('now')`
      ));
    return mapRows<StorageContract>(rows);
  }

  async getActiveContractsForChallenge(): Promise<StorageContract[]> {
    const rows = await db().select().from(S.storageContracts)
      .where(and(
        eq(S.storageContracts.status, "active"),
        sql`CAST(${S.storageContracts.hbdSpent} AS REAL) < CAST(${S.storageContracts.hbdBudget} AS REAL)`,
        sql`${S.storageContracts.expiresAt} > datetime('now')`
      ))
      .orderBy(sql`RANDOM()`);
    return mapRows<StorageContract>(rows);
  }

  async updateStorageContractSpent(id: string, amount: number): Promise<boolean> {
    const result = await db().update(S.storageContracts)
      .set({
        hbdSpent: sql`CAST(CAST(${S.storageContracts.hbdSpent} AS REAL) + ${amount} AS TEXT)`,
      })
      .where(and(
        eq(S.storageContracts.id, id),
        sql`CAST(${S.storageContracts.hbdSpent} AS REAL) + ${amount} <= CAST(${S.storageContracts.hbdBudget} AS REAL)`
      ))
      .returning();
    return result.length > 0;
  }

  async getExhaustedContracts(): Promise<StorageContract[]> {
    const rows = await db().select().from(S.storageContracts)
      .where(and(
        eq(S.storageContracts.status, "active"),
        sql`CAST(${S.storageContracts.hbdSpent} AS REAL) >= CAST(${S.storageContracts.hbdBudget} AS REAL)`,
        sql`CAST(${S.storageContracts.hbdBudget} AS REAL) > 0`
      ));
    return mapRows<StorageContract>(rows);
  }

  async getActiveContractByCid(cid: string): Promise<StorageContract | undefined> {
    const [row] = await db().select().from(S.storageContracts)
      .where(and(
        eq(S.storageContracts.fileCid, cid),
        eq(S.storageContracts.status, "active"),
        sql`CAST(${S.storageContracts.hbdSpent} AS REAL) < CAST(${S.storageContracts.hbdBudget} AS REAL)`,
        sql`${S.storageContracts.expiresAt} > datetime('now')`
      ))
      .limit(1);
    return row ? mapRow<StorageContract>(row) : undefined;
  }

  // ============================================================
  // Phase 1: Contract Events
  // ============================================================

  async createContractEvent(event: InsertContractEvent): Promise<ContractEvent> {
    const e = event as any;
    const [created] = await db().insert(S.contractEvents).values({
      id: randomUUID(),
      ...e,
      createdAt: toISO(e.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<ContractEvent>(created);
  }

  async getContractEvents(contractId: string): Promise<ContractEvent[]> {
    const rows = await db().select().from(S.contractEvents)
      .where(eq(S.contractEvents.contractId, contractId))
      .orderBy(desc(S.contractEvents.createdAt));
    return mapRows<ContractEvent>(rows);
  }

  // ============================================================
  // Phase 2: Transcode Jobs
  // ============================================================

  async getTranscodeJob(id: string): Promise<TranscodeJob | undefined> {
    const [row] = await db().select().from(S.transcodeJobs).where(eq(S.transcodeJobs.id, id));
    return row ? mapRow<TranscodeJob>(row) : undefined;
  }

  async getTranscodeJobsByFile(fileId: string): Promise<TranscodeJob[]> {
    const rows = await db().select().from(S.transcodeJobs)
      .where(eq(S.transcodeJobs.fileId, fileId))
      .orderBy(desc(S.transcodeJobs.createdAt));
    return mapRows<TranscodeJob>(rows);
  }

  async getQueuedTranscodeJobs(): Promise<TranscodeJob[]> {
    const rows = await db().select().from(S.transcodeJobs)
      .where(eq(S.transcodeJobs.status, "queued"))
      .orderBy(S.transcodeJobs.createdAt);
    return mapRows<TranscodeJob>(rows);
  }

  async createTranscodeJob(job: InsertTranscodeJob): Promise<TranscodeJob> {
    const j = job as any;
    const [created] = await db().insert(S.transcodeJobs).values({
      id: randomUUID(),
      ...j,
      createdAt: toISO(j.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<TranscodeJob>(created);
  }

  async updateTranscodeJobStatus(id: string, status: string, progress?: number, outputCid?: string, errorMessage?: string): Promise<void> {
    const updates: Record<string, any> = { status };
    if (progress !== undefined) updates.progress = progress;
    if (outputCid) updates.outputCid = outputCid;
    if (errorMessage) updates.errorMessage = errorMessage;
    if (status === "processing") updates.startedAt = nowISO();
    if (status === "completed" || status === "failed") updates.completedAt = nowISO();
    await db().update(S.transcodeJobs).set(updates).where(eq(S.transcodeJobs.id, id));
  }

  async assignTranscodeJob(jobId: string, encoderNodeId: string): Promise<void> {
    await db().update(S.transcodeJobs)
      .set({ encoderNodeId, status: "assigned" })
      .where(eq(S.transcodeJobs.id, jobId));
  }

  // ============================================================
  // Phase 2: Encoder Nodes
  // ============================================================

  async getEncoderNode(id: string): Promise<EncoderNode | undefined> {
    const [row] = await db().select().from(S.encoderNodes).where(eq(S.encoderNodes.id, id));
    return row ? mapRow<EncoderNode>(row) : undefined;
  }

  async getAllEncoderNodes(): Promise<EncoderNode[]> {
    const rows = await db().select().from(S.encoderNodes).orderBy(desc(S.encoderNodes.rating));
    return mapRows<EncoderNode>(rows);
  }

  async getAvailableEncoderNodes(): Promise<EncoderNode[]> {
    const rows = await db().select().from(S.encoderNodes)
      .where(and(
        eq(S.encoderNodes.status, "active"),
        eq(S.encoderNodes.availability, "available")
      ))
      .orderBy(desc(S.encoderNodes.rating));
    return mapRows<EncoderNode>(rows);
  }

  async createEncoderNode(node: InsertEncoderNode): Promise<EncoderNode> {
    const n = node as any;
    const [created] = await db().insert(S.encoderNodes).values({
      id: randomUUID(),
      ...n,
      lastHeartbeat: toISO(n.lastHeartbeat) ?? nowISO(),
      createdAt: toISO(n.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<EncoderNode>(created);
  }

  async updateEncoderNodeAvailability(id: string, availability: string): Promise<void> {
    await db().update(S.encoderNodes)
      .set({ availability })
      .where(eq(S.encoderNodes.id, id));
  }

  async getMarketplaceEncoders(quality: string, sortBy: string): Promise<EncoderNode[]> {
    let orderClause;
    if (sortBy === "price") {
      const priceColumn = quality === "1080p" ? S.encoderNodes.price1080p :
                          quality === "720p" ? S.encoderNodes.price720p :
                          quality === "480p" ? S.encoderNodes.price480p :
                          S.encoderNodes.priceAllQualities;
      orderClause = priceColumn;
    } else {
      orderClause = desc(S.encoderNodes.reputationScore);
    }

    const rows = await db().select().from(S.encoderNodes)
      .where(and(
        eq(S.encoderNodes.status, "active"),
        eq(S.encoderNodes.availability, "available"),
        eq(S.encoderNodes.encoderType, "community")
      ))
      .orderBy(orderClause);
    return mapRows<EncoderNode>(rows);
  }

  // ============================================================
  // Phase 7: Encoding Jobs & Offers
  // ============================================================

  async createEncodingJob(job: InsertEncodingJob): Promise<EncodingJob> {
    const j = job as any;
    const [created] = await db().insert(S.encodingJobs).values({
      id: randomUUID(),
      ...j,
      createdAt: toISO(j.createdAt) ?? nowISO(),
      assignedAt: toISO(j.assignedAt),
      startedAt: toISO(j.startedAt),
      completedAt: toISO(j.completedAt),
      leaseExpiresAt: toISO(j.leaseExpiresAt),
      nextRetryAt: toISO(j.nextRetryAt),
    } as any).returning();
    return mapRow<EncodingJob>(created);
  }

  async updateEncodingJob(id: string, updates: Partial<EncodingJob>): Promise<void> {
    // Convert any Date fields to ISO strings for SQLite storage
    const mapped: any = { ...updates };
    for (let i = 0; i < TIMESTAMP_FIELDS.length; i++) {
      const key = TIMESTAMP_FIELDS[i];
      if (key in mapped && mapped[key] instanceof Date) {
        mapped[key] = (mapped[key] as Date).toISOString();
      }
    }
    await db().update(S.encodingJobs).set(mapped).where(eq(S.encodingJobs.id, id));
  }

  async createEncodingJobOffer(offer: InsertEncodingJobOffer): Promise<EncodingJobOffer> {
    const o = offer as any;
    const [created] = await db().insert(S.encodingJobOffers).values({
      id: randomUUID(),
      ...o,
      expiresAt: toISO(o.expiresAt)!,
      acceptedAt: toISO(o.acceptedAt),
      createdAt: toISO(o.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<EncodingJobOffer>(created);
  }

  async getEncodingJobOffers(status: string): Promise<EncodingJobOffer[]> {
    const rows = await db().select().from(S.encodingJobOffers)
      .where(eq(S.encodingJobOffers.status, status))
      .orderBy(desc(S.encodingJobOffers.createdAt));
    return mapRows<EncodingJobOffer>(rows);
  }

  async acceptEncodingJobOffer(id: string, encoderId: string): Promise<EncodingJobOffer | undefined> {
    const [updated] = await db().update(S.encodingJobOffers)
      .set({
        status: "accepted",
        acceptedEncoderId: encoderId,
        acceptedAt: nowISO(),
      })
      .where(and(
        eq(S.encodingJobOffers.id, id),
        eq(S.encodingJobOffers.status, "pending")
      ))
      .returning();
    return updated ? mapRow<EncodingJobOffer>(updated) : undefined;
  }

  async getUserEncodingOffers(username: string): Promise<EncodingJobOffer[]> {
    const rows = await db().select().from(S.encodingJobOffers)
      .where(eq(S.encodingJobOffers.owner, username))
      .orderBy(desc(S.encodingJobOffers.createdAt));
    return mapRows<EncodingJobOffer>(rows);
  }

  async cancelEncodingJobOffer(id: string, username: string): Promise<boolean> {
    const [updated] = await db().update(S.encodingJobOffers)
      .set({ status: "cancelled" })
      .where(and(
        eq(S.encodingJobOffers.id, id),
        eq(S.encodingJobOffers.owner, username),
        eq(S.encodingJobOffers.status, "pending")
      ))
      .returning();
    return !!updated;
  }

  // ============================================================
  // Phase 3: Blocklist Entries
  // ============================================================

  async getBlocklistEntries(scope: string, scopeOwnerId?: string): Promise<BlocklistEntry[]> {
    if (scopeOwnerId) {
      const rows = await db().select().from(S.blocklistEntries)
        .where(and(
          eq(S.blocklistEntries.scope, scope),
          eq(S.blocklistEntries.scopeOwnerId, scopeOwnerId),
          eq(S.blocklistEntries.active, true)
        ))
        .orderBy(desc(S.blocklistEntries.createdAt));
      return mapRows<BlocklistEntry>(rows);
    }
    const rows = await db().select().from(S.blocklistEntries)
      .where(and(
        eq(S.blocklistEntries.scope, scope),
        eq(S.blocklistEntries.active, true)
      ))
      .orderBy(desc(S.blocklistEntries.createdAt));
    return mapRows<BlocklistEntry>(rows);
  }

  async createBlocklistEntry(entry: InsertBlocklistEntry): Promise<BlocklistEntry> {
    const e = entry as any;
    const [created] = await db().insert(S.blocklistEntries).values({
      id: randomUUID(),
      ...e,
      expiresAt: toISO(e.expiresAt),
      createdAt: toISO(e.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<BlocklistEntry>(created);
  }

  async deactivateBlocklistEntry(id: string): Promise<void> {
    await db().update(S.blocklistEntries)
      .set({ active: false })
      .where(eq(S.blocklistEntries.id, id));
  }

  async getEffectiveBlocklist(scopes: { scope: string; scopeOwnerId?: string }[]): Promise<BlocklistEntry[]> {
    const results: BlocklistEntry[] = [];
    for (const s of scopes) {
      const entries = await this.getBlocklistEntries(s.scope, s.scopeOwnerId);
      results.push(...entries);
    }
    return results;
  }

  // ============================================================
  // Phase 3: Platform Blocklists
  // ============================================================

  async getPlatformBlocklist(platformId: string): Promise<PlatformBlocklist | undefined> {
    const [row] = await db().select().from(S.platformBlocklists)
      .where(eq(S.platformBlocklists.platformId, platformId));
    return row ? mapRow<PlatformBlocklist>(row) : undefined;
  }

  async getAllPlatformBlocklists(): Promise<PlatformBlocklist[]> {
    const rows = await db().select().from(S.platformBlocklists);
    return mapRows<PlatformBlocklist>(rows);
  }

  async createPlatformBlocklist(platform: InsertPlatformBlocklist): Promise<PlatformBlocklist> {
    const p = platform as any;
    const [created] = await db().insert(S.platformBlocklists).values({
      id: randomUUID(),
      ...p,
      createdAt: toISO(p.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<PlatformBlocklist>(created);
  }

  // ============================================================
  // Phase 3: Tags
  // ============================================================

  async getTag(id: string): Promise<Tag | undefined> {
    const [row] = await db().select().from(S.tags).where(eq(S.tags.id, id));
    return row ? mapRow<Tag>(row) : undefined;
  }

  async getTagByLabel(label: string): Promise<Tag | undefined> {
    const [row] = await db().select().from(S.tags).where(eq(S.tags.label, label));
    return row ? mapRow<Tag>(row) : undefined;
  }

  async getAllTags(): Promise<Tag[]> {
    const rows = await db().select().from(S.tags).orderBy(S.tags.label);
    return mapRows<Tag>(rows);
  }

  async createTag(tag: InsertTag): Promise<Tag> {
    const t = tag as any;
    const [created] = await db().insert(S.tags).values({
      id: randomUUID(),
      ...t,
      createdAt: toISO(t.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<Tag>(created);
  }

  // ============================================================
  // Phase 3: File Tags
  // ============================================================

  async getFileTags(fileId: string): Promise<FileTag[]> {
    const rows = await db().select().from(S.fileTags)
      .where(eq(S.fileTags.fileId, fileId))
      .orderBy(desc(S.fileTags.confidence));
    return mapRows<FileTag>(rows);
  }

  async createFileTag(fileTag: InsertFileTag): Promise<FileTag> {
    const ft = fileTag as any;
    const [created] = await db().insert(S.fileTags).values({
      id: randomUUID(),
      ...ft,
      createdAt: toISO(ft.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<FileTag>(created);
  }

  async updateFileTagVotes(id: string, votesUp: number, votesDown: number, confidence: number): Promise<void> {
    await db().update(S.fileTags)
      .set({ votesUp, votesDown, confidence })
      .where(eq(S.fileTags.id, id));
  }

  // ============================================================
  // Phase 3: Tag Votes
  // ============================================================

  async createTagVote(vote: InsertTagVote): Promise<TagVote> {
    const tv = vote as any;
    const [created] = await db().insert(S.tagVotes).values({
      id: randomUUID(),
      ...tv,
      createdAt: toISO(tv.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<TagVote>(created);
  }

  async getUserVoteOnFileTag(fileTagId: string, voterUsername: string): Promise<TagVote | undefined> {
    const [row] = await db().select().from(S.tagVotes)
      .where(and(
        eq(S.tagVotes.fileTagId, fileTagId),
        eq(S.tagVotes.voterUsername, voterUsername)
      ));
    return row ? mapRow<TagVote>(row) : undefined;
  }

  // ============================================================
  // Phase 4: User Keys
  // ============================================================

  async getUserKeys(username: string): Promise<UserKey[]> {
    const rows = await db().select().from(S.userKeys)
      .where(eq(S.userKeys.username, username));
    return mapRows<UserKey>(rows);
  }

  async createUserKey(key: InsertUserKey): Promise<UserKey> {
    const k = key as any;
    const [created] = await db().insert(S.userKeys).values({
      id: randomUUID(),
      ...k,
      createdAt: toISO(k.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<UserKey>(created);
  }

  // ============================================================
  // Phase 4: User Node Settings
  // ============================================================

  async getUserNodeSettings(username: string): Promise<UserNodeSettings | undefined> {
    const [row] = await db().select().from(S.userNodeSettings)
      .where(eq(S.userNodeSettings.username, username));
    return row ? mapRow<UserNodeSettings>(row) : undefined;
  }

  async createOrUpdateUserNodeSettings(settings: InsertUserNodeSettings): Promise<UserNodeSettings> {
    const existing = await this.getUserNodeSettings(settings.username);
    if (existing) {
      const [updated] = await db().update(S.userNodeSettings)
        .set({ ...settings, updatedAt: nowISO() } as any)
        .where(eq(S.userNodeSettings.id, existing.id))
        .returning();
      return mapRow<UserNodeSettings>(updated);
    }
    const [created] = await db().insert(S.userNodeSettings).values({
      id: randomUUID(),
      ...settings,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    } as any).returning();
    return mapRow<UserNodeSettings>(created);
  }

  // ============================================================
  // Phase 4: View Events
  // ============================================================

  async createViewEvent(event: InsertViewEvent): Promise<ViewEvent> {
    const ev = event as any;
    const [created] = await db().insert(S.viewEvents).values({
      id: randomUUID(),
      ...ev,
      createdAt: toISO(ev.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<ViewEvent>(created);
  }

  async getViewEventsForAutoPinning(): Promise<ViewEvent[]> {
    const rows = await db().select().from(S.viewEvents)
      .where(and(
        eq(S.viewEvents.completed, true),
        eq(S.viewEvents.autoPinTriggered, false)
      ))
      .orderBy(desc(S.viewEvents.createdAt))
      .limit(100);
    return mapRows<ViewEvent>(rows);
  }

  async markViewEventAutoPinTriggered(id: string): Promise<void> {
    await db().update(S.viewEvents)
      .set({ autoPinTriggered: true })
      .where(eq(S.viewEvents.id, id));
  }

  // ============================================================
  // Phase 4: Beneficiary Allocations
  // ============================================================

  async getBeneficiaryAllocations(fromUsername: string): Promise<BeneficiaryAllocation[]> {
    const rows = await db().select().from(S.beneficiaryAllocations)
      .where(and(
        eq(S.beneficiaryAllocations.fromUsername, fromUsername),
        eq(S.beneficiaryAllocations.active, true)
      ));
    return mapRows<BeneficiaryAllocation>(rows);
  }

  async createBeneficiaryAllocation(allocation: InsertBeneficiaryAllocation): Promise<BeneficiaryAllocation> {
    const a = allocation as any;
    const [created] = await db().insert(S.beneficiaryAllocations).values({
      id: randomUUID(),
      ...a,
      createdAt: toISO(a.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<BeneficiaryAllocation>(created);
  }

  async updateBeneficiaryAllocation(id: string, percentage: number): Promise<void> {
    await db().update(S.beneficiaryAllocations)
      .set({ percentage })
      .where(eq(S.beneficiaryAllocations.id, id));
  }

  async deactivateBeneficiaryAllocation(id: string): Promise<void> {
    await db().update(S.beneficiaryAllocations)
      .set({ active: false })
      .where(eq(S.beneficiaryAllocations.id, id));
  }

  // ============================================================
  // Phase 4: Payout History
  // ============================================================

  async createPayoutHistory(payout: InsertPayoutHistory): Promise<PayoutHistory> {
    const p = payout as any;
    const [created] = await db().insert(S.payoutHistory).values({
      id: randomUUID(),
      ...p,
      createdAt: toISO(p.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<PayoutHistory>(created);
  }

  async getPayoutHistory(username: string, limit: number): Promise<PayoutHistory[]> {
    const rows = await db().select().from(S.payoutHistory)
      .where(eq(S.payoutHistory.recipientUsername, username))
      .orderBy(desc(S.payoutHistory.createdAt))
      .limit(limit);
    return mapRows<PayoutHistory>(rows);
  }

  // ============================================================
  // Phase 5: Wallet Deposits
  // ============================================================

  async createWalletDeposit(deposit: InsertWalletDeposit): Promise<WalletDeposit> {
    const d = deposit as any;
    const [created] = await db().insert(S.walletDeposits).values({
      id: randomUUID(),
      ...d,
      createdAt: toISO(d.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<WalletDeposit>(created);
  }

  async getWalletDeposits(limit: number): Promise<WalletDeposit[]> {
    const rows = await db().select().from(S.walletDeposits)
      .orderBy(desc(S.walletDeposits.createdAt))
      .limit(limit);
    return mapRows<WalletDeposit>(rows);
  }

  async getWalletDepositsByUser(username: string): Promise<WalletDeposit[]> {
    const rows = await db().select().from(S.walletDeposits)
      .where(eq(S.walletDeposits.fromUsername, username))
      .orderBy(desc(S.walletDeposits.createdAt));
    return mapRows<WalletDeposit>(rows);
  }

  async getUnprocessedDeposits(): Promise<WalletDeposit[]> {
    const rows = await db().select().from(S.walletDeposits)
      .where(eq(S.walletDeposits.processed, false))
      .orderBy(desc(S.walletDeposits.createdAt));
    return mapRows<WalletDeposit>(rows);
  }

  async markDepositProcessed(id: string): Promise<void> {
    await db().update(S.walletDeposits)
      .set({ processed: true })
      .where(eq(S.walletDeposits.id, id));
  }

  async getWalletBalance(): Promise<{ totalDeposits: string; totalPaid: string; available: string }> {
    const depositsResult = await db().select({
      total: sql<string>`CAST(COALESCE(SUM(CAST(${S.walletDeposits.hbdAmount} AS REAL)), 0) AS TEXT)`,
    }).from(S.walletDeposits);

    const paidResult = await db().select({
      total: sql<string>`CAST(COALESCE(SUM(CAST(${S.payoutLineItems.hbdAmount} AS REAL)), 0) AS TEXT)`,
    }).from(S.payoutLineItems)
      .where(eq(S.payoutLineItems.paid, true));

    const totalDeposits = depositsResult[0]?.total || "0";
    const totalPaid = paidResult[0]?.total || "0";
    const available = (parseFloat(totalDeposits) - parseFloat(totalPaid)).toFixed(3);

    return { totalDeposits, totalPaid, available };
  }

  // ============================================================
  // Phase 5: Payout Reports
  // ============================================================

  async createPayoutReport(report: InsertPayoutReport): Promise<PayoutReport> {
    const r = report as any;
    const [created] = await db().insert(S.payoutReports).values({
      id: randomUUID(),
      ...r,
      periodStart: toISO(r.periodStart)!,
      periodEnd: toISO(r.periodEnd)!,
      executedAt: toISO(r.executedAt),
      createdAt: toISO(r.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<PayoutReport>(created);
  }

  async getPayoutReport(id: string): Promise<PayoutReport | undefined> {
    const [row] = await db().select().from(S.payoutReports).where(eq(S.payoutReports.id, id));
    return row ? mapRow<PayoutReport>(row) : undefined;
  }

  async getPayoutReports(limit: number): Promise<PayoutReport[]> {
    const rows = await db().select().from(S.payoutReports)
      .orderBy(desc(S.payoutReports.createdAt))
      .limit(limit);
    return mapRows<PayoutReport>(rows);
  }

  async getPayoutReportsByValidator(validatorUsername: string): Promise<PayoutReport[]> {
    const rows = await db().select().from(S.payoutReports)
      .where(eq(S.payoutReports.validatorUsername, validatorUsername))
      .orderBy(desc(S.payoutReports.createdAt));
    return mapRows<PayoutReport>(rows);
  }

  async updatePayoutReportStatus(id: string, status: string, executedTxHash?: string): Promise<void> {
    const updateData: any = { status };
    if (status === "executed") {
      updateData.executedAt = nowISO();
    }
    if (executedTxHash) {
      updateData.executedTxHash = executedTxHash;
    }
    await db().update(S.payoutReports)
      .set(updateData)
      .where(eq(S.payoutReports.id, id));
  }

  async getOverlappingPayoutReports(periodStart: Date, periodEnd: Date): Promise<PayoutReport[]> {
    const startISO = toISO(periodStart)!;
    const endISO = toISO(periodEnd)!;
    const rows = await db().select().from(S.payoutReports)
      .where(and(
        lt(S.payoutReports.periodStart, endISO),
        gte(S.payoutReports.periodEnd, startISO),
        sql`${S.payoutReports.status} != 'rejected'`,
      ));
    return mapRows<PayoutReport>(rows);
  }

  // ============================================================
  // Phase 5: Payout Line Items
  // ============================================================

  async createPayoutLineItem(item: InsertPayoutLineItem): Promise<PayoutLineItem> {
    const li = item as any;
    const [created] = await db().insert(S.payoutLineItems).values({
      id: randomUUID(),
      ...li,
      createdAt: toISO(li.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<PayoutLineItem>(created);
  }

  async createPayoutLineItems(items: InsertPayoutLineItem[]): Promise<PayoutLineItem[]> {
    if (items.length === 0) return [];
    const values = items.map(item => {
      const li = item as any;
      return {
        id: randomUUID(),
        ...li,
        createdAt: toISO(li.createdAt) ?? nowISO(),
      };
    });
    const created = await db().insert(S.payoutLineItems).values(values as any).returning();
    return mapRows<PayoutLineItem>(created);
  }

  async getPayoutLineItems(reportId: string): Promise<PayoutLineItem[]> {
    const rows = await db().select().from(S.payoutLineItems)
      .where(eq(S.payoutLineItems.reportId, reportId))
      .orderBy(desc(sql`CAST(${S.payoutLineItems.hbdAmount} AS REAL)`));
    return mapRows<PayoutLineItem>(rows);
  }

  async markLineItemPaid(id: string, txHash: string): Promise<void> {
    await db().update(S.payoutLineItems)
      .set({ paid: true, txHash })
      .where(eq(S.payoutLineItems.id, id));
  }

  async getPoaDataForPayout(startDate: Date, endDate: Date): Promise<{ username: string; proofCount: number; successRate: number; totalHbd: string }[]> {
    const startISO = toISO(startDate)!;
    const endISO = toISO(endDate)!;
    const results = await db().select({
      hiveUsername: S.storageNodes.hiveUsername,
      successCount: sql<number>`SUM(CASE WHEN ${S.poaChallenges.result} = 'success' THEN 1 ELSE 0 END)`,
      totalCount: sql<number>`COUNT(*)`,
    })
    .from(S.poaChallenges)
    .innerJoin(S.storageNodes, eq(S.poaChallenges.nodeId, S.storageNodes.id))
    .where(and(
      gte(S.poaChallenges.createdAt, startISO),
      lte(S.poaChallenges.createdAt, endISO)
    ))
    .groupBy(S.storageNodes.hiveUsername);

    const HBD_PER_PROOF = 0.001;

    return results.map(r => ({
      username: r.hiveUsername,
      proofCount: Number(r.successCount) || 0,
      successRate: (Number(r.totalCount) || 0) > 0 ? ((Number(r.successCount) || 0) / (Number(r.totalCount) || 1)) * 100 : 0,
      totalHbd: ((Number(r.successCount) || 0) * HBD_PER_PROOF).toFixed(3),
    }));
  }

  // ============================================================
  // Phase 6: P2P Sessions
  // ============================================================

  async createP2pSession(session: InsertP2pSession): Promise<P2pSession> {
    const s = session as any;
    const [created] = await db().insert(S.p2pSessions).values({
      id: randomUUID(),
      ...s,
      joinedAt: toISO(s.joinedAt) ?? nowISO(),
      lastActiveAt: toISO(s.lastActiveAt) ?? nowISO(),
      disconnectedAt: toISO(s.disconnectedAt),
    } as any).returning();
    return mapRow<P2pSession>(created);
  }

  async getP2pSession(id: string): Promise<P2pSession | undefined> {
    const [row] = await db().select().from(S.p2pSessions).where(eq(S.p2pSessions.id, id));
    return row ? mapRow<P2pSession>(row) : undefined;
  }

  async getP2pSessionByPeerId(peerId: string): Promise<P2pSession | undefined> {
    const [row] = await db().select().from(S.p2pSessions)
      .where(and(eq(S.p2pSessions.peerId, peerId), eq(S.p2pSessions.status, "active")));
    return row ? mapRow<P2pSession>(row) : undefined;
  }

  async getActiveP2pSessions(roomId?: string): Promise<P2pSession[]> {
    if (roomId) {
      const rows = await db().select().from(S.p2pSessions)
        .where(and(eq(S.p2pSessions.roomId, roomId), eq(S.p2pSessions.status, "active")));
      return mapRows<P2pSession>(rows);
    }
    const rows = await db().select().from(S.p2pSessions)
      .where(eq(S.p2pSessions.status, "active"));
    return mapRows<P2pSession>(rows);
  }

  async updateP2pSessionStats(
    id: string,
    bytesUploaded: number,
    bytesDownloaded: number,
    segmentsShared: number,
    peersConnected: number
  ): Promise<void> {
    await db().update(S.p2pSessions)
      .set({
        bytesUploaded,
        bytesDownloaded,
        segmentsShared,
        peersConnected,
        lastActiveAt: nowISO(),
      })
      .where(eq(S.p2pSessions.id, id));
  }

  async disconnectP2pSession(id: string): Promise<void> {
    await db().update(S.p2pSessions)
      .set({ status: "disconnected", disconnectedAt: nowISO() })
      .where(eq(S.p2pSessions.id, id));
  }

  async cleanupStaleSessions(): Promise<number> {
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000);
    const result = await db().update(S.p2pSessions)
      .set({ status: "disconnected", disconnectedAt: nowISO() })
      .where(and(
        eq(S.p2pSessions.status, "active"),
        lt(S.p2pSessions.lastActiveAt, toISO(staleThreshold)!)
      ))
      .returning({ id: S.p2pSessions.id });
    return result.length;
  }

  // ============================================================
  // Phase 6: P2P Contributions
  // ============================================================

  async createP2pContribution(contribution: InsertP2pContribution): Promise<P2pContribution> {
    const c = contribution as any;
    const [created] = await db().insert(S.p2pContributions).values({
      id: randomUUID(),
      ...c,
      createdAt: toISO(c.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<P2pContribution>(created);
  }

  async getP2pContributionsByPeerId(peerId: string): Promise<P2pContribution[]> {
    const rows = await db().select().from(S.p2pContributions)
      .where(eq(S.p2pContributions.peerId, peerId))
      .orderBy(desc(S.p2pContributions.createdAt));
    return mapRows<P2pContribution>(rows);
  }

  async getP2pContributionsByUsername(hiveUsername: string): Promise<P2pContribution[]> {
    const rows = await db().select().from(S.p2pContributions)
      .where(eq(S.p2pContributions.hiveUsername, hiveUsername))
      .orderBy(desc(S.p2pContributions.createdAt));
    return mapRows<P2pContribution>(rows);
  }

  async getTopContributors(limit: number): Promise<{ hiveUsername: string; totalBytesShared: number; totalSegments: number }[]> {
    const results = await db().select({
      hiveUsername: S.p2pContributions.hiveUsername,
      totalBytesShared: sql<number>`CAST(SUM(${S.p2pContributions.bytesShared}) AS INTEGER)`,
      totalSegments: sql<number>`CAST(SUM(${S.p2pContributions.segmentsShared}) AS INTEGER)`,
    })
    .from(S.p2pContributions)
    .where(sql`${S.p2pContributions.hiveUsername} IS NOT NULL`)
    .groupBy(S.p2pContributions.hiveUsername)
    .orderBy(desc(sql`SUM(${S.p2pContributions.bytesShared})`))
    .limit(limit);

    return results.map(r => ({
      hiveUsername: r.hiveUsername || "",
      totalBytesShared: r.totalBytesShared || 0,
      totalSegments: r.totalSegments || 0,
    }));
  }

  // ============================================================
  // Phase 6: P2P Rooms
  // ============================================================

  async getOrCreateP2pRoom(videoCid: string): Promise<P2pRoom> {
    const existing = await this.getP2pRoomByCid(videoCid);
    if (existing) return existing;

    const [created] = await db().insert(S.p2pRooms)
      .values({
        id: randomUUID(),
        videoCid,
        activePeers: 0,
        totalBytesShared: 0,
      } as any)
      .returning();
    return mapRow<P2pRoom>(created);
  }

  async getP2pRoom(id: string): Promise<P2pRoom | undefined> {
    const [row] = await db().select().from(S.p2pRooms).where(eq(S.p2pRooms.id, id));
    return row ? mapRow<P2pRoom>(row) : undefined;
  }

  async getP2pRoomByCid(videoCid: string): Promise<P2pRoom | undefined> {
    const [row] = await db().select().from(S.p2pRooms).where(eq(S.p2pRooms.videoCid, videoCid));
    return row ? mapRow<P2pRoom>(row) : undefined;
  }

  async updateP2pRoomStats(id: string, activePeers: number, bytesShared: number): Promise<void> {
    await db().update(S.p2pRooms)
      .set({
        activePeers,
        totalBytesShared: sql`${S.p2pRooms.totalBytesShared} + ${bytesShared}`,
        lastActivityAt: nowISO(),
      })
      .where(eq(S.p2pRooms.id, id));
  }

  async getActiveP2pRooms(): Promise<P2pRoom[]> {
    const rows = await db().select().from(S.p2pRooms)
      .where(sql`${S.p2pRooms.activePeers} > 0`)
      .orderBy(desc(S.p2pRooms.activePeers));
    return mapRows<P2pRoom>(rows);
  }

  // ============================================================
  // Phase 6: P2P Network Stats
  // ============================================================

  async createP2pNetworkStats(stats: InsertP2pNetworkStats): Promise<P2pNetworkStats> {
    const s = stats as any;
    const [created] = await db().insert(S.p2pNetworkStats).values({
      id: randomUUID(),
      ...s,
      timestamp: toISO(s.timestamp) ?? nowISO(),
    } as any).returning();
    return mapRow<P2pNetworkStats>(created);
  }

  async getP2pNetworkStats(limit: number): Promise<P2pNetworkStats[]> {
    const rows = await db().select().from(S.p2pNetworkStats)
      .orderBy(desc(S.p2pNetworkStats.timestamp))
      .limit(limit);
    return mapRows<P2pNetworkStats>(rows);
  }

  async getCurrentP2pNetworkStats(): Promise<{ activePeers: number; activeRooms: number; totalBytesShared: number; avgP2pRatio: number }> {
    const activeSessions = await db().select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(S.p2pSessions)
      .where(eq(S.p2pSessions.status, "active"));

    const activeRooms = await db().select({ count: sql<number>`CAST(COUNT(*) AS INTEGER)` })
      .from(S.p2pRooms)
      .where(sql`${S.p2pRooms.activePeers} > 0`);

    const totalShared = await db().select({ sum: sql<number>`CAST(COALESCE(SUM(${S.p2pContributions.bytesShared}), 0) AS INTEGER)` })
      .from(S.p2pContributions);

    const avgRatio = await db().select({ avg: sql<number>`COALESCE(AVG(${S.p2pContributions.p2pRatio}), 0)` })
      .from(S.p2pContributions);

    return {
      activePeers: activeSessions[0]?.count || 0,
      activeRooms: activeRooms[0]?.count || 0,
      totalBytesShared: totalShared[0]?.sum || 0,
      avgP2pRatio: avgRatio[0]?.avg || 0,
    };
  }

  // ============================================================
  // Analytics: Real performance data from PoA challenges
  // ============================================================

  async getChallengesLast24Hours(): Promise<{ hour: number; successCount: number; failCount: number; totalCount: number; avgLatency: number }[]> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sinceISO = toISO(since)!;
    const results = await db().select({
      hour: sql<number>`CAST(strftime('%H', ${S.poaChallenges.createdAt}) AS INTEGER)`,
      successCount: sql<number>`CAST(SUM(CASE WHEN ${S.poaChallenges.result} = 'success' THEN 1 ELSE 0 END) AS INTEGER)`,
      failCount: sql<number>`CAST(SUM(CASE WHEN ${S.poaChallenges.result} = 'fail' THEN 1 ELSE 0 END) AS INTEGER)`,
      totalCount: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      avgLatency: sql<number>`CAST(COALESCE(AVG(${S.poaChallenges.latencyMs}), 0) AS INTEGER)`,
    })
    .from(S.poaChallenges)
    .where(gte(S.poaChallenges.createdAt, sinceISO))
    .groupBy(sql`strftime('%H', ${S.poaChallenges.createdAt})`)
    .orderBy(sql`strftime('%H', ${S.poaChallenges.createdAt})`);

    return results;
  }

  async getPerformanceMetrics(): Promise<{
    totalChallenges: number;
    successRate: number;
    avgLatency: number;
    minLatency: number;
    maxLatency: number;
  }> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sinceISO = toISO(since)!;
    const results = await db().select({
      totalCount: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      successCount: sql<number>`CAST(SUM(CASE WHEN ${S.poaChallenges.result} = 'success' THEN 1 ELSE 0 END) AS INTEGER)`,
      avgLatency: sql<number>`CAST(COALESCE(AVG(${S.poaChallenges.latencyMs}), 0) AS INTEGER)`,
      minLatency: sql<number>`CAST(COALESCE(MIN(${S.poaChallenges.latencyMs}), 0) AS INTEGER)`,
      maxLatency: sql<number>`CAST(COALESCE(MAX(${S.poaChallenges.latencyMs}), 0) AS INTEGER)`,
    })
    .from(S.poaChallenges)
    .where(gte(S.poaChallenges.createdAt, sinceISO));

    const row = results[0];
    return {
      totalChallenges: row?.totalCount || 0,
      successRate: row?.totalCount ? ((row.successCount || 0) / row.totalCount) * 100 : 0,
      avgLatency: row?.avgLatency || 0,
      minLatency: row?.minLatency || 0,
      maxLatency: row?.maxLatency || 0,
    };
  }

  async getNodeHealthSummary(): Promise<{ active: number; probation: number; banned: number; total: number }> {
    const results = await db().select({
      status: S.storageNodes.status,
      count: sql<number>`CAST(COUNT(*) AS INTEGER)`,
    })
    .from(S.storageNodes)
    .groupBy(S.storageNodes.status);

    const summary = { active: 0, probation: 0, banned: 0, total: 0 };
    for (const row of results) {
      if (row.status === "active") summary.active = row.count;
      else if (row.status === "probation") summary.probation = row.count;
      else if (row.status === "banned") summary.banned = row.count;
      summary.total += row.count;
    }
    return summary;
  }

  async getViewEventStats(username: string): Promise<{ totalViews: number; completedViews: number; pinnedContent: number }> {
    const results = await db().select({
      totalViews: sql<number>`CAST(COUNT(*) AS INTEGER)`,
      completedViews: sql<number>`CAST(SUM(CASE WHEN ${S.viewEvents.completed} = 1 THEN 1 ELSE 0 END) AS INTEGER)`,
      pinnedContent: sql<number>`CAST(SUM(CASE WHEN ${S.viewEvents.autoPinTriggered} = 1 THEN 1 ELSE 0 END) AS INTEGER)`,
    })
    .from(S.viewEvents)
    .where(eq(S.viewEvents.viewerUsername, username));

    const row = results[0];
    return {
      totalViews: row?.totalViews || 0,
      completedViews: row?.completedViews || 0,
      pinnedContent: row?.pinnedContent || 0,
    };
  }

  async getRecentNodeLogs(limit: number = 50): Promise<{ timestamp: Date; level: string; message: string; source: string }[]> {
    const challenges = await db().select({
      createdAt: S.poaChallenges.createdAt,
      result: S.poaChallenges.result,
      latencyMs: S.poaChallenges.latencyMs,
      hiveUsername: S.storageNodes.hiveUsername,
    })
    .from(S.poaChallenges)
    .innerJoin(S.storageNodes, eq(S.poaChallenges.nodeId, S.storageNodes.id))
    .orderBy(desc(S.poaChallenges.createdAt))
    .limit(limit);

    return challenges.map(c => ({
      timestamp: toDate(c.createdAt)!,
      level: c.result === "success" ? "info" : "warn",
      message: c.result === "success"
        ? `PoA challenge passed for ${c.hiveUsername} (${c.latencyMs}ms)`
        : `PoA challenge failed for ${c.hiveUsername} (${c.latencyMs}ms)`,
      source: "poa-engine",
    }));
  }

  // ============================================================
  // Optimized aggregate methods (Phase 2 performance)
  // ============================================================

  async getStatsAggregated(): Promise<{
    files: { total: number; pinned: number; syncing: number };
    nodes: { total: number; active: number; probation: number; banned: number };
    validators: { total: number; online: number };
    challenges: { total: number; success: number; failed: number; successRate: string };
    rewards: { totalHBD: string; transactions: number };
    cdn: { total: number; active: number };
    contracts: { total: number; active: number };
    encoders: { total: number; available: number };
  }> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const fileStats = db().all<any>(sql`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'pinned' THEN 1 ELSE 0 END) as pinned,
        SUM(CASE WHEN status = 'syncing' THEN 1 ELSE 0 END) as syncing
      FROM files
    `);
    const nodeStats = db().all<any>(sql`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'probation' THEN 1 ELSE 0 END) as probation,
        SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) as banned
      FROM storage_nodes
    `);
    const validatorStats = db().all<any>(sql`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) as online
      FROM validators
    `);
    const challengeStats = db().all<any>(sql`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) as failed
      FROM poa_challenges WHERE created_at > ${sevenDaysAgo}
    `);
    const rewardStats = db().all<any>(sql`
      SELECT COUNT(*) as total FROM hive_transactions WHERE type = 'hbd_transfer' AND created_at > ${oneDayAgo}
    `);
    const cdnStats = db().all<any>(sql`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
      FROM cdn_nodes
    `);
    const contractStats = db().all<any>(sql`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active
      FROM storage_contracts
    `);
    const encoderStats = db().all<any>(sql`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN availability = 'available' THEN 1 ELSE 0 END) as available
      FROM encoder_nodes
    `);

    const f = fileStats[0] as any || {};
    const n = nodeStats[0] as any || {};
    const v = validatorStats[0] as any || {};
    const c = challengeStats[0] as any || {};
    const r = rewardStats[0] as any || {};
    const cd = cdnStats[0] as any || {};
    const co = contractStats[0] as any || {};
    const en = encoderStats[0] as any || {};

    const success = Number(c.success) || 0;
    const failed = Number(c.failed) || 0;
    const successRate = success + failed > 0 ? (success / (success + failed) * 100).toFixed(1) : "0.0";
    const hbdTxCount = Number(r.total) || 0;

    return {
      files: { total: Number(f.total) || 0, pinned: Number(f.pinned) || 0, syncing: Number(f.syncing) || 0 },
      nodes: { total: Number(n.total) || 0, active: Number(n.active) || 0, probation: Number(n.probation) || 0, banned: Number(n.banned) || 0 },
      validators: { total: Number(v.total) || 0, online: Number(v.online) || 0 },
      challenges: { total: Number(c.total) || 0, success, failed, successRate },
      rewards: { totalHBD: (hbdTxCount * 0.001).toFixed(3), transactions: hbdTxCount },
      cdn: { total: Number(cd.total) || 0, active: Number(cd.active) || 0 },
      contracts: { total: Number(co.total) || 0, active: Number(co.active) || 0 },
      encoders: { total: Number(en.total) || 0, available: Number(en.available) || 0 },
    };
  }

  async getStorageNodeByUsername(username: string): Promise<StorageNode | undefined> {
    const [row] = await db().select().from(S.storageNodes).where(eq(S.storageNodes.hiveUsername, username)).limit(1);
    return row ? mapRow<StorageNode>(row) : undefined;
  }

  async getNodeChallenges(nodeId: string, limit: number): Promise<PoaChallenge[]> {
    const rows = await db().select().from(S.poaChallenges)
      .where(eq(S.poaChallenges.nodeId, nodeId))
      .orderBy(desc(S.poaChallenges.createdAt))
      .limit(limit);
    return mapRows<PoaChallenge>(rows);
  }

  async getNodeEarnings(nodeUsername: string): Promise<number> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db().all<any>(sql`
      SELECT COUNT(*) as cnt FROM hive_transactions
      WHERE to_user = ${nodeUsername} AND type = 'hbd_transfer' AND created_at > ${sevenDaysAgo}
    `);
    return (Number((rows[0] as any)?.cnt) || 0) * 0.001;
  }

  async getMarketplaceFiles(): Promise<any[]> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = db().all<any>(sql`
      SELECT
        f.id, f.name, f.cid, f.size, f.status, f.replication_count, f.earned_hbd,
        COUNT(pc.id) as challenge_count,
        SUM(CASE WHEN pc.result = 'success' THEN 1 ELSE 0 END) as success_count
      FROM files f
      LEFT JOIN poa_challenges pc ON pc.file_id = f.id AND pc.created_at > ${sevenDaysAgo}
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `);
    return rows as any[];
  }

  // ============================================================
  // Paginated queries
  // ============================================================

  async getFilesPaginated(limit: number, offset: number): Promise<{ data: File[]; total: number }> {
    const data = await db().select().from(S.files).orderBy(desc(S.files.createdAt)).limit(limit).offset(offset);
    const countRows = db().all<any>(sql`SELECT COUNT(*) as total FROM files`);
    return { data: mapRows<File>(data), total: Number((countRows[0] as any)?.total) || 0 };
  }

  async getNodesPaginated(limit: number, offset: number): Promise<{ data: StorageNode[]; total: number }> {
    const data = await db().select().from(S.storageNodes).orderBy(desc(S.storageNodes.reputation)).limit(limit).offset(offset);
    const countRows = db().all<any>(sql`SELECT COUNT(*) as total FROM storage_nodes`);
    return { data: mapRows<StorageNode>(data), total: Number((countRows[0] as any)?.total) || 0 };
  }

  async getChallengesPaginated(limit: number, offset: number): Promise<{ data: PoaChallenge[]; total: number }> {
    const data = await db().select().from(S.poaChallenges).orderBy(desc(S.poaChallenges.createdAt)).limit(limit).offset(offset);
    const countRows = db().all<any>(sql`SELECT COUNT(*) as total FROM poa_challenges`);
    return { data: mapRows<PoaChallenge>(data), total: Number((countRows[0] as any)?.total) || 0 };
  }

  async getTransactionsPaginated(limit: number, offset: number): Promise<{ data: HiveTransaction[]; total: number }> {
    const data = await db().select().from(S.hiveTransactions).orderBy(desc(S.hiveTransactions.createdAt)).limit(limit).offset(offset);
    const countRows = db().all<any>(sql`SELECT COUNT(*) as total FROM hive_transactions`);
    return { data: mapRows<HiveTransaction>(data), total: Number((countRows[0] as any)?.total) || 0 };
  }

  // ============================================================
  // User Sessions (persistent, replaces in-memory Map)
  // ============================================================

  async createSession(token: string, username: string, expiresAt: Date, role: string = "user", validatorOptedIn?: boolean | null): Promise<void> {
    await db().insert(S.userSessions).values({
      token,
      username,
      expiresAt: toISO(expiresAt)!,
      role,
      validatorOptedIn: validatorOptedIn ?? null,
    } as any);
  }

  async getSession(token: string): Promise<{ username: string; expiresAt: Date; role: string; validatorOptedIn: boolean | null } | undefined> {
    const [row] = await db().select().from(S.userSessions).where(eq(S.userSessions.token, token)).limit(1);
    if (!row) return undefined;
    return {
      username: row.username,
      expiresAt: toDate(row.expiresAt as string)!,
      role: row.role,
      validatorOptedIn: row.validatorOptedIn,
    };
  }

  async updateSessionValidatorOptIn(token: string, optedIn: boolean): Promise<void> {
    await db().update(S.userSessions).set({ validatorOptedIn: optedIn }).where(eq(S.userSessions.token, token));
  }

  async deleteSession(token: string): Promise<void> {
    await db().delete(S.userSessions).where(eq(S.userSessions.token, token));
  }

  async cleanExpiredSessions(): Promise<void> {
    await db().delete(S.userSessions).where(lt(S.userSessions.expiresAt, nowISO()));
  }

  // ============================================================
  // Agent API Key CRUD
  // ============================================================

  async createAgentKey(apiKey: string, hiveUsername: string, label?: string): Promise<void> {
    await db().insert(S.agentKeys).values({
      id: randomUUID(),
      apiKey,
      hiveUsername,
      label: label ?? null,
    } as any);
  }

  async getAgentByKey(apiKey: string): Promise<{ hiveUsername: string; id: string } | undefined> {
    const [row] = await db().select().from(S.agentKeys).where(eq(S.agentKeys.apiKey, apiKey)).limit(1);
    if (!row) return undefined;
    // Update last used timestamp
    await db().update(S.agentKeys).set({ lastUsedAt: nowISO() }).where(eq(S.agentKeys.id, row.id));
    return { hiveUsername: row.hiveUsername, id: row.id };
  }

  async deleteAgentKey(id: string): Promise<void> {
    await db().delete(S.agentKeys).where(eq(S.agentKeys.id, id));
  }

  // ============================================================
  // File Refs — IPFS sub-block CID lists for lightweight PoA verification
  // ============================================================

  async getFileRefs(cid: string): Promise<string[] | null> {
    const [row] = await db().select().from(S.fileRefs).where(eq(S.fileRefs.cid, cid)).limit(1);
    if (!row) return null;
    try { return JSON.parse(row.blockCids); } catch { return null; }
  }

  async saveFileRefs(cid: string, blockCids: string[]): Promise<void> {
    const json = JSON.stringify(blockCids);
    const id = randomUUID();
    const now = nowISO();
    // Upsert: insert or update if CID already exists
    db().run(sql`
      INSERT INTO file_refs (id, cid, block_cids, block_count, synced_at)
      VALUES (${id}, ${cid}, ${json}, ${blockCids.length}, ${now})
      ON CONFLICT (cid) DO UPDATE SET block_cids = ${json}, block_count = ${blockCids.length}, synced_at = ${now}
    `);
  }

  async hasFileRefs(cid: string): Promise<boolean> {
    const rows = db().all<any>(sql`SELECT 1 FROM file_refs WHERE cid = ${cid} LIMIT 1`);
    return rows.length > 0;
  }

  // ============================================================
  // Phase 7: Web of Trust
  // ============================================================

  async getActiveVouch(sponsorUsername: string): Promise<WebOfTrust | undefined> {
    const [row] = await db().select().from(S.webOfTrust)
      .where(and(eq(S.webOfTrust.sponsorUsername, sponsorUsername), eq(S.webOfTrust.active, true)))
      .limit(1);
    return row ? mapRow<WebOfTrust>(row) : undefined;
  }

  async getVouchForUser(vouchedUsername: string): Promise<WebOfTrust | undefined> {
    const [row] = await db().select().from(S.webOfTrust)
      .where(and(eq(S.webOfTrust.vouchedUsername, vouchedUsername), eq(S.webOfTrust.active, true)))
      .limit(1);
    return row ? mapRow<WebOfTrust>(row) : undefined;
  }

  async getAllActiveVouches(): Promise<WebOfTrust[]> {
    const rows = await db().select().from(S.webOfTrust)
      .where(eq(S.webOfTrust.active, true))
      .orderBy(desc(S.webOfTrust.createdAt));
    return mapRows<WebOfTrust>(rows);
  }

  async createVouch(vouch: InsertWebOfTrust): Promise<WebOfTrust> {
    const v = vouch as any;
    const [created] = await db().insert(S.webOfTrust).values({
      id: randomUUID(),
      ...v,
      revokedAt: toISO(v.revokedAt),
      createdAt: toISO(v.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<WebOfTrust>(created);
  }

  async revokeVouch(sponsorUsername: string, reason: string): Promise<void> {
    await db().update(S.webOfTrust)
      .set({ active: false, revokedAt: nowISO(), revokeReason: reason })
      .where(and(eq(S.webOfTrust.sponsorUsername, sponsorUsername), eq(S.webOfTrust.active, true)));
  }

  async isVouchedValidator(username: string): Promise<boolean> {
    const vouch = await this.getVouchForUser(username);
    return !!vouch;
  }

  // ============================================================
  // Phase 8: Multisig Treasury — Signers
  // ============================================================
  async createTreasurySigner(signer: InsertTreasurySigner): Promise<TreasurySigner> {
    const s = signer as any;
    const [created] = await db().insert(S.treasurySigners).values({
      id: randomUUID(),
      ...s,
      joinedAt: toISO(s.joinedAt) ?? nowISO(),
      createdAt: toISO(s.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<TreasurySigner>(created);
  }

  async getTreasurySignerByUsername(username: string): Promise<TreasurySigner | undefined> {
    const [row] = await db().select().from(S.treasurySigners)
      .where(eq(S.treasurySigners.username, username))
      .limit(1);
    return row ? mapRow<TreasurySigner>(row) : undefined;
  }

  async getActiveTreasurySigners(): Promise<TreasurySigner[]> {
    const rows = await db().select().from(S.treasurySigners)
      .where(eq(S.treasurySigners.status, "active"))
      .orderBy(desc(S.treasurySigners.joinedAt));
    return mapRows<TreasurySigner>(rows);
  }

  async updateSignerStatus(username: string, status: string, extra?: Partial<TreasurySigner>): Promise<void> {
    const update: any = { status };
    if (extra) {
      if (extra.leftAt) update.leftAt = toISO(extra.leftAt as any);
      if (extra.cooldownUntil) update.cooldownUntil = toISO(extra.cooldownUntil as any);
      if (extra.optEvents !== undefined) update.optEvents = extra.optEvents;
    }
    await db().update(S.treasurySigners).set(update).where(eq(S.treasurySigners.username, username));
  }

  async updateSignerHeartbeat(username: string): Promise<void> {
    await db().update(S.treasurySigners)
      .set({ lastHeartbeat: nowISO() } as any)
      .where(eq(S.treasurySigners.username, username));
  }

  // ============================================================
  // Phase 8: Multisig Treasury — Vouches (WoT extension)
  // ============================================================
  async createTreasuryVouch(vouch: InsertTreasuryVouch): Promise<TreasuryVouch> {
    const v = vouch as any;
    const [created] = await db().insert(S.treasuryVouches).values({
      id: randomUUID(),
      ...v,
      createdAt: toISO(v.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<TreasuryVouch>(created);
  }

  async getActiveVouchesForCandidate(candidateUsername: string): Promise<TreasuryVouch[]> {
    const rows = await db().select().from(S.treasuryVouches)
      .where(and(eq(S.treasuryVouches.candidateUsername, candidateUsername), eq(S.treasuryVouches.active, true)))
      .orderBy(desc(S.treasuryVouches.createdAt));
    return mapRows<TreasuryVouch>(rows);
  }

  async getActiveVouchesByVoucher(voucherUsername: string): Promise<TreasuryVouch[]> {
    const rows = await db().select().from(S.treasuryVouches)
      .where(and(eq(S.treasuryVouches.voucherUsername, voucherUsername), eq(S.treasuryVouches.active, true)));
    return mapRows<TreasuryVouch>(rows);
  }

  async getAllActiveTreasuryVouches(): Promise<TreasuryVouch[]> {
    const rows = await db().select().from(S.treasuryVouches)
      .where(eq(S.treasuryVouches.active, true))
      .orderBy(desc(S.treasuryVouches.createdAt));
    return mapRows<TreasuryVouch>(rows);
  }

  async revokeTreasuryVouch(voucherUsername: string, candidateUsername: string, reason: string): Promise<void> {
    await db().update(S.treasuryVouches)
      .set({ active: false, revokedAt: nowISO(), revokeReason: reason } as any)
      .where(and(
        eq(S.treasuryVouches.voucherUsername, voucherUsername),
        eq(S.treasuryVouches.candidateUsername, candidateUsername),
        eq(S.treasuryVouches.active, true),
      ));
  }

  async revokeTreasuryVouchesByVoucher(voucherUsername: string, reason: string): Promise<void> {
    await db().update(S.treasuryVouches)
      .set({ active: false, revokedAt: nowISO(), revokeReason: reason } as any)
      .where(and(eq(S.treasuryVouches.voucherUsername, voucherUsername), eq(S.treasuryVouches.active, true)));
  }

  async countActiveVouchesForCandidate(candidateUsername: string): Promise<number> {
    const vouches = await this.getActiveVouchesForCandidate(candidateUsername);
    return vouches.length;
  }

  // ============================================================
  // Phase 8: Multisig Treasury — Transactions
  // ============================================================
  async createTreasuryTransaction(tx: InsertTreasuryTransaction): Promise<TreasuryTransaction> {
    const t = tx as any;
    const [created] = await db().insert(S.treasuryTransactions).values({
      id: randomUUID(),
      ...t,
      expiresAt: toISO(t.expiresAt) ?? nowISO(),
      signatures: typeof t.signatures === "object" ? JSON.stringify(t.signatures) : (t.signatures || "{}"),
      metadata: typeof t.metadata === "object" ? JSON.stringify(t.metadata) : t.metadata,
      createdAt: toISO(t.createdAt) ?? nowISO(),
    } as any).returning();
    return mapRow<TreasuryTransaction>(created);
  }

  async getTreasuryTransaction(id: string): Promise<TreasuryTransaction | undefined> {
    const [row] = await db().select().from(S.treasuryTransactions)
      .where(eq(S.treasuryTransactions.id, id))
      .limit(1);
    if (!row) return undefined;
    const mapped = mapRow<any>(row);
    return parseTxJsonFields(mapped);
  }

  async getRecentTreasuryTransactions(limit: number = 50): Promise<TreasuryTransaction[]> {
    const rows = await db().select().from(S.treasuryTransactions)
      .orderBy(desc(S.treasuryTransactions.createdAt))
      .limit(limit);
    return mapRows<any>(rows).map(parseTxJsonFields);
  }

  async updateTreasuryTxSignature(id: string, username: string, signature: string): Promise<void> {
    const tx = await this.getTreasuryTransaction(id);
    if (!tx) return;
    const sigs = (tx.signatures as Record<string, string>) || {};
    sigs[username] = signature;
    await db().update(S.treasuryTransactions)
      .set({ signatures: JSON.stringify(sigs), status: "signing" } as any)
      .where(eq(S.treasuryTransactions.id, id));
  }

  async updateTreasuryTxStatus(id: string, status: string, broadcastTxId?: string): Promise<void> {
    const update: any = { status };
    if (broadcastTxId) update.broadcastTxId = broadcastTxId;
    await db().update(S.treasuryTransactions).set(update).where(eq(S.treasuryTransactions.id, id));
  }

  // ============================================================
  // Content Moderation
  // ============================================================

  async createContentFlag(flag: InsertContentFlag): Promise<ContentFlag> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db().insert(S.contentFlags).values({ ...flag, id, createdAt: now } as any);
    return this.getContentFlagById(id) as Promise<ContentFlag>;
  }

  async getContentFlags(status?: string): Promise<ContentFlag[]> {
    if (status) {
      const rows = await db().select().from(S.contentFlags)
        .where(eq(S.contentFlags.status, status))
        .orderBy(desc(S.contentFlags.createdAt));
      return rows.map(r => mapRow<ContentFlag>(r)) as ContentFlag[];
    }
    const rows = await db().select().from(S.contentFlags).orderBy(desc(S.contentFlags.createdAt));
    return rows.map(r => mapRow<ContentFlag>(r)) as ContentFlag[];
  }

  async getContentFlagsByCid(cid: string): Promise<ContentFlag[]> {
    const rows = await db().select().from(S.contentFlags)
      .where(eq(S.contentFlags.cid, cid))
      .orderBy(desc(S.contentFlags.createdAt));
    return rows.map(r => mapRow<ContentFlag>(r)) as ContentFlag[];
  }

  async getContentFlagById(id: string): Promise<ContentFlag | undefined> {
    const [row] = await db().select().from(S.contentFlags).where(eq(S.contentFlags.id, id));
    return row ? mapRow<ContentFlag>(row) as ContentFlag : undefined;
  }

  async updateContentFlagStatus(id: string, status: string, reviewedBy: string): Promise<void> {
    await db().update(S.contentFlags)
      .set({ status, reviewedBy, reviewedAt: new Date().toISOString() } as any)
      .where(eq(S.contentFlags.id, id));
  }

  async incrementFlagCount(cid: string, reason: string): Promise<ContentFlag> {
    const [existing] = await db().select().from(S.contentFlags)
      .where(and(eq(S.contentFlags.cid, cid), eq(S.contentFlags.reason, reason), eq(S.contentFlags.status, "pending")));
    if (!existing) throw new Error("No pending flag found for this CID and reason");
    await db().update(S.contentFlags)
      .set({ flagCount: existing.flagCount + 1 } as any)
      .where(eq(S.contentFlags.id, existing.id));
    return mapRow<ContentFlag>({ ...existing, flagCount: existing.flagCount + 1 }) as ContentFlag;
  }

  async getFlaggedContentSummary(): Promise<{ cid: string; totalFlags: number; reasons: string[]; maxSeverity: string; status: string }[]> {
    const allFlags = await db().select().from(S.contentFlags).orderBy(desc(S.contentFlags.flagCount));
    const grouped = new Map<string, { totalFlags: number; reasons: Set<string>; maxSeverity: string; status: string }>();
    const severityOrder = ["low", "moderate", "severe", "critical"];
    for (const flag of allFlags) {
      const existing = grouped.get(flag.cid);
      if (existing) {
        existing.totalFlags += flag.flagCount;
        existing.reasons.add(flag.reason);
        if (severityOrder.indexOf(flag.severity) > severityOrder.indexOf(existing.maxSeverity)) existing.maxSeverity = flag.severity;
        if (flag.status === "pending" || existing.status === "pending") existing.status = "pending";
      } else {
        grouped.set(flag.cid, { totalFlags: flag.flagCount, reasons: new Set([flag.reason]), maxSeverity: flag.severity, status: flag.status });
      }
    }
    return Array.from(grouped.entries()).map(([cid, data]) => ({
      cid, totalFlags: data.totalFlags, reasons: Array.from(data.reasons), maxSeverity: data.maxSeverity, status: data.status,
    }));
  }

  async createUploaderBan(ban: InsertUploaderBan): Promise<UploaderBan> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db().insert(S.uploaderBans).values({ ...ban, id, createdAt: now } as any);
    const [row] = await db().select().from(S.uploaderBans).where(eq(S.uploaderBans.id, id));
    return mapRow<UploaderBan>(row) as UploaderBan;
  }

  async getUploaderBans(bannedBy?: string): Promise<UploaderBan[]> {
    if (bannedBy) {
      const rows = await db().select().from(S.uploaderBans)
        .where(and(eq(S.uploaderBans.bannedBy, bannedBy), eq(S.uploaderBans.active, true)))
        .orderBy(desc(S.uploaderBans.createdAt));
      return rows.map(r => mapRow<UploaderBan>(r)) as UploaderBan[];
    }
    const rows = await db().select().from(S.uploaderBans)
      .where(eq(S.uploaderBans.active, true))
      .orderBy(desc(S.uploaderBans.createdAt));
    return rows.map(r => mapRow<UploaderBan>(r)) as UploaderBan[];
  }

  async isUploaderBanned(username: string, bannedBy?: string): Promise<boolean> {
    const conditions = [eq(S.uploaderBans.bannedUsername, username), eq(S.uploaderBans.active, true)];
    if (bannedBy) conditions.push(eq(S.uploaderBans.bannedBy, bannedBy));
    const [result] = await db().select().from(S.uploaderBans).where(and(...conditions)).limit(1);
    return !!result;
  }

  async removeUploaderBan(id: string): Promise<void> {
    await db().update(S.uploaderBans).set({ active: false } as any).where(eq(S.uploaderBans.id, id));
  }

  async getActiveBansForNode(nodeOperator: string): Promise<UploaderBan[]> {
    const rows = await db().select().from(S.uploaderBans)
      .where(and(eq(S.uploaderBans.bannedBy, nodeOperator), eq(S.uploaderBans.active, true)))
      .orderBy(desc(S.uploaderBans.createdAt));
    return rows.map(r => mapRow<UploaderBan>(r)) as UploaderBan[];
  }

  async createTreasuryAuditLog(entry: InsertTreasuryAuditLog): Promise<TreasuryAuditLog> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const [row] = await db().insert(S.treasuryAuditLog).values({
      id,
      txId: entry.txId,
      signerUsername: entry.signerUsername,
      action: entry.action,
      nonce: entry.nonce ?? null,
      rejectReason: entry.rejectReason ?? null,
      txDigest: entry.txDigest ?? null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      createdAt: now,
    }).returning();
    return mapRow<TreasuryAuditLog>(row) as TreasuryAuditLog;
  }

  async getRecentTreasuryAuditLogs(limit = 50): Promise<TreasuryAuditLog[]> {
    const rows = await db().select().from(S.treasuryAuditLog)
      .orderBy(desc(S.treasuryAuditLog.createdAt))
      .limit(limit);
    return rows.map((r) => mapRow<TreasuryAuditLog>(r) as TreasuryAuditLog);
  }

  // Treasury Freeze State
  async getTreasuryFreezeState(): Promise<any | undefined> {
    const [row] = await db().select().from(S.treasuryFreezeState)
      .where(eq(S.treasuryFreezeState.id, "singleton")).limit(1);
    return row ? mapRow<any>(row) : undefined;
  }

  async setTreasuryFrozen(frozenBy: string, reason: string, unfreezeThreshold: number): Promise<void> {
    const existing = await this.getTreasuryFreezeState();
    const now = new Date().toISOString();
    if (existing) {
      await db().update(S.treasuryFreezeState).set({
        frozen: true, frozenBy, frozenAt: now, reason, unfreezeThreshold,
        unfreezeVotes: "[]", updatedAt: now,
      }).where(eq(S.treasuryFreezeState.id, "singleton"));
    } else {
      await db().insert(S.treasuryFreezeState).values({
        id: "singleton", frozen: true, frozenBy, frozenAt: now, reason,
        unfreezeThreshold, unfreezeVotes: "[]", updatedAt: now,
      });
    }
  }

  async addUnfreezeVote(username: string): Promise<{ frozen: boolean; voteCount: number; threshold: number }> {
    const state = await this.getTreasuryFreezeState();
    if (!state || !state.frozen) return { frozen: false, voteCount: 0, threshold: 0 };

    const votes: string[] = typeof state.unfreezeVotes === "string"
      ? JSON.parse(state.unfreezeVotes) : (state.unfreezeVotes || []);
    if (!votes.includes(username)) votes.push(username);
    const threshold = state.unfreezeThreshold || 1;

    if (votes.length >= threshold) {
      await this.clearTreasuryFreeze();
      return { frozen: false, voteCount: votes.length, threshold };
    }
    await db().update(S.treasuryFreezeState).set({
      unfreezeVotes: JSON.stringify(votes), updatedAt: new Date().toISOString(),
    }).where(eq(S.treasuryFreezeState.id, "singleton"));
    return { frozen: true, voteCount: votes.length, threshold };
  }

  async clearTreasuryFreeze(): Promise<void> {
    await db().update(S.treasuryFreezeState).set({
      frozen: false, frozenBy: null, frozenAt: null, unfreezeVotes: "[]",
      reason: null, unfreezeThreshold: null, updatedAt: new Date().toISOString(),
    }).where(eq(S.treasuryFreezeState.id, "singleton"));
  }

  // Treasury Transaction Extensions
  async updateTreasuryTxDelayed(id: string, broadcastAfter: Date, delaySeconds: number): Promise<void> {
    await db().update(S.treasuryTransactions).set({
      status: "delayed", broadcastAfter: broadcastAfter.toISOString(), delaySeconds,
    }).where(eq(S.treasuryTransactions.id, id));
  }

  async updateTreasuryTxSignatures(id: string, signatures: Record<string, string>): Promise<void> {
    await db().update(S.treasuryTransactions).set({ signatures: JSON.stringify(signatures) })
      .where(eq(S.treasuryTransactions.id, id));
  }

  async updateTreasuryTransaction(id: string, fields: Partial<{ operationsJson: string; txDigest: string; status: string; expiresAt: Date }>): Promise<void> {
    const sqlFields: any = { ...fields };
    if (fields.expiresAt) sqlFields.expiresAt = fields.expiresAt.toISOString();
    await db().update(S.treasuryTransactions).set(sqlFields).where(eq(S.treasuryTransactions.id, id));
  }

  async getDelayedTreasuryTransactions(): Promise<TreasuryTransaction[]> {
    const rows = await db().select().from(S.treasuryTransactions)
      .where(eq(S.treasuryTransactions.status, "delayed"));
    return rows.map(r => mapRow<TreasuryTransaction>(r)) as TreasuryTransaction[];
  }

  async hasReceivedTreasuryPayment(recipient: string): Promise<boolean> {
    const rows = await db().select({ id: S.treasuryTransactions.id })
      .from(S.treasuryTransactions)
      .where(and(
        eq(S.treasuryTransactions.status, "broadcast"),
        sql`json_extract(metadata, '$.recipient') = ${recipient}`,
      ))
      .limit(1);
    return rows.length > 0;
  }

  // ============================================================
  // Phase 10: GPU Compute Marketplace (stubs — desktop agent doesn't run marketplace)
  // ============================================================
  private computeNotSupported(): never { throw new Error("GPU Compute marketplace not supported on desktop agent (SQLite)"); }

  async getComputeNode(_id: string): Promise<ComputeNode | undefined> { return undefined; }
  async getComputeNodeByInstanceId(_instanceId: string): Promise<ComputeNode | undefined> { return undefined; }
  async getComputeNodesByUsername(_username: string): Promise<ComputeNode[]> { return []; }
  async getAllComputeNodes(): Promise<ComputeNode[]> { return []; }
  async getAvailableComputeNodes(_workloadType?: string, _minVramGb?: number): Promise<ComputeNode[]> { return []; }
  async createComputeNode(_node: InsertComputeNode): Promise<ComputeNode> { this.computeNotSupported(); }
  async updateComputeNode(_id: string, _updates: Partial<ComputeNode>): Promise<void> { }
  async updateComputeNodeHeartbeat(_id: string, _jobsInProgress: number): Promise<void> { }
  async decrementComputeNodeJobs(_id: string): Promise<void> { }
  async updateComputeNodeStats(_id: string, _completed: boolean, _hbdEarned?: string): Promise<void> { }

  async getComputeJob(_id: string): Promise<ComputeJob | undefined> { return undefined; }
  async getComputeJobsByCreator(_username: string, _limit?: number): Promise<ComputeJob[]> { return []; }
  async getQueuedComputeJobs(_workloadType?: string): Promise<ComputeJob[]> { return []; }
  async createComputeJob(_job: InsertComputeJob): Promise<ComputeJob> { this.computeNotSupported(); }
  async updateComputeJobState(_id: string, _state: string, _extra?: Partial<ComputeJob>): Promise<void> { }
  async touchActiveAttemptHeartbeats(_nodeId: string): Promise<void> { }
  async claimComputeJobAtomic(_nodeId: string, _allowedTypes: string[], _minVramGb: number, _cachedModelsList: string[], _leaseToken: string): Promise<{ job: ComputeJob; attempt: ComputeJobAttempt } | null> { return null; }
  async getExpiredComputeLeases(): Promise<ComputeJobAttempt[]> { return []; }

  async createComputeJobAttempt(_attempt: InsertComputeJobAttempt): Promise<ComputeJobAttempt> { this.computeNotSupported(); }
  async getComputeJobAttempt(_id: string): Promise<ComputeJobAttempt | undefined> { return undefined; }
  async getComputeJobAttempts(_jobId: string): Promise<ComputeJobAttempt[]> { return []; }
  async updateComputeJobAttempt(_id: string, _updates: Partial<ComputeJobAttempt>): Promise<void> { }

  async createComputeVerification(_verification: InsertComputeVerification): Promise<ComputeVerification> { this.computeNotSupported(); }
  async getComputeVerifications(_jobId: string): Promise<ComputeVerification[]> { return []; }

  async createComputePayout(_payout: InsertComputePayout): Promise<ComputePayout> { this.computeNotSupported(); }
  async getComputePayoutsByJob(_jobId: string): Promise<ComputePayout[]> { return []; }
  async getComputePayoutsByNode(_nodeId: string, _limit?: number): Promise<ComputePayout[]> { return []; }
  async updateComputePayoutStatus(_id: string, _status: string, _treasuryTxId?: string): Promise<void> { }

  async getComputeStats(): Promise<{ totalNodes: number; onlineNodes: number; totalJobs: number; completedJobs: number; totalHbdPaid: string }> {
    return { totalNodes: 0, onlineNodes: 0, totalJobs: 0, completedJobs: 0, totalHbdPaid: "0" };
  }

  // Phase 1 Step 2: Compute Wallets (stubs — compute not supported on SQLite desktop agent yet)
  async getComputeWalletByUsername(_username: string): Promise<ComputeWallet | undefined> { return undefined; }
  async createComputeWallet(_wallet: InsertComputeWallet): Promise<ComputeWallet> { this.computeNotSupported(); }
  async createWalletLedgerEntry(_entry: InsertComputeWalletLedgerEntry): Promise<ComputeWalletLedgerEntry> { this.computeNotSupported(); }
  async getWalletLedgerEntries(_walletId: string, _limit?: number, _offset?: number): Promise<ComputeWalletLedgerEntry[]> { return []; }
  async getComputeWalletBalance(_walletId: string): Promise<string> { return "0"; }
  async getWalletLedgerByIdempotencyKey(_key: string): Promise<ComputeWalletLedgerEntry | undefined> { return undefined; }
  async ensureWalletTables(): Promise<void> { }

  // Phase 1 Step 3: Payout Broadcasts (stubs)
  async getQueuedComputePayouts(_limit?: number): Promise<ComputePayout[]> { return []; }
  async createPayoutBroadcastAttempt(_attempt: InsertComputePayoutBroadcast): Promise<ComputePayoutBroadcast> { this.computeNotSupported(); }
  async getPayoutBroadcastAttempt(_id: string): Promise<ComputePayoutBroadcast | undefined> { return undefined; }
  async getLatestBroadcastAttempt(_payoutId: string): Promise<ComputePayoutBroadcast | undefined> { return undefined; }
  async getInflightBroadcastAttempts(): Promise<ComputePayoutBroadcast[]> { return []; }
  async updatePayoutBroadcastAttempt(_id: string, _updates: Partial<ComputePayoutBroadcast>): Promise<void> { }
  async getPayoutBroadcastAttemptsByPayout(_payoutId: string): Promise<ComputePayoutBroadcast[]> { return []; }
  async ensureBroadcastTables(): Promise<void> { }

  // Directed compliance-challenge — not implemented in SQLite (desktop agent is single-user)
  async adjustComputeNodeReputation(_id: string, _delta: number): Promise<void> { }
  async getNodesForPoaChallenge(_cooldownMs: number, _limit?: number): Promise<ComputeNode[]> { return []; }
  async stampNodePoaChallenge(_nodeId: string, _at: Date): Promise<void> { }
  async getUnscoredComplianceChallengeResults(_coordinatorUsername: string): Promise<ComputeJob[]> { return []; }
  async getExpiredPoaJobs(_coordinatorUsername: string, _claimTimeoutMs: number): Promise<ComputeJob[]> { return []; }
  async scoreComplianceChallengeAtomic(_jobId: string, _nodeId: string, _delta: number): Promise<boolean> { return false; }

  // Phase 2A: Staged Challenge Protocol — not available on SQLite (PG-only compute tables)
  async createResourceClassProfile(_profile: any): Promise<any> { throw new Error("Phase 2A: PG-only"); }
  async getActiveResourceClassProfiles(): Promise<any[]> { return []; }
  async insertPrecomputedBundleSet(_bundles: any[]): Promise<any[]> { throw new Error("Phase 2A: PG-only"); }
  async getOrphanPoolCount(_profileId: string): Promise<number> { return 0; }
  async claimOrphanChallengeSet(_profileId: string, _jobId: string, _attemptId: string): Promise<any> { return null; }
  async revealChallengeStage(_attemptId: string, _stageIndex: number): Promise<any> { return null; }
  async acceptChallengeCheckpoint(_attemptId: string, _stageIndex: number, _resultDigest: string, _stageNonce: string, _transcriptPrevHash: string, _transcriptEntryHash: string, _receivedAt: Date, _telemetryJson?: string | null): Promise<any> { return { error: "Phase 2A: PG-only" }; }
  async getChallengeCheckpoints(_attemptId: string): Promise<any[]> { return []; }
  async getChallengeBundles(_attemptId: string): Promise<any[]> { return []; }

  // Phase 2B: VRAM evidence stubs (PG-only)
  async insertVramClassEvidence(_evidence: any): Promise<any> { throw new Error("Phase 2B: PG-only"); }
  async getVramClassCertification(_nodeId: string, _profileId: string, _now?: Date): Promise<any> { return { state: "uncertified", latestPass: null, revokingObservation: null }; }
  async getVramClassEvidenceHistory(_nodeId: string, _profileId: string, _limit?: number): Promise<any[]> { return []; }

  // Spirit Bomb: Community Cloud stubs (PG-only)
  async createGpuCluster(_cluster: any): Promise<any> { throw new Error("Spirit Bomb: PG-only"); }
  async getGpuCluster(_id: string): Promise<any> { return undefined; }
  async listGpuClusters(_region?: string): Promise<any[]> { return []; }
  async updateGpuCluster(_id: string, _updates: any): Promise<void> {}
  async addClusterMember(_member: any): Promise<any> { throw new Error("Spirit Bomb: PG-only"); }
  async removeClusterMember(_clusterId: string, _nodeId: string): Promise<void> {}
  async getClusterMembers(_clusterId: string): Promise<any[]> { return []; }
  async getNodeClusters(_nodeId: string): Promise<any[]> { return []; }
  async createTierManifest(_manifest: any): Promise<any> { throw new Error("Spirit Bomb: PG-only"); }
  async getLatestTierManifest(): Promise<any> { return undefined; }
  async getTierManifestHistory(_limit?: number): Promise<any[]> { return []; }
  async upsertInferenceRoute(_route: any): Promise<any> { throw new Error("Spirit Bomb: PG-only"); }
  async listInferenceRoutes(_mode?: string): Promise<any[]> { return []; }
  async recordInferenceContribution(_contribution: any): Promise<any> { throw new Error("Spirit Bomb: PG-only"); }
  async getNodeInferenceContributions(_nodeId: string, _since: Date): Promise<any[]> { return []; }
  async getInferenceContributionStats(): Promise<any> { return { totalTokens: 0, totalRequests: 0, totalHbdEarned: 0, activeContributors: 0 }; }

  // Expert Weight Shards stubs (PG-only)
  async createExpertShard(_shard: any): Promise<any> { throw new Error("Spirit Bomb: PG-only"); }
  async getExpertShards(_modelName: string, _expertIndices?: number[]): Promise<any[]> { return []; }
  async getExpertShardByCid(_cid: string): Promise<any> { return undefined; }
}
