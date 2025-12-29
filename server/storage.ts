// Integration: blueprint:javascript_database
import { 
  storageNodes, 
  files,
  validators,
  storageAssignments,
  poaChallenges,
  hiveTransactions,
  validatorBlacklists,
  type StorageNode,
  type InsertStorageNode,
  type File,
  type InsertFile,
  type Validator,
  type InsertValidator,
  type PoaChallenge,
  type InsertPoaChallenge,
  type HiveTransaction,
  type InsertHiveTransaction,
  type StorageAssignment,
  type ValidatorBlacklist,
  type InsertValidatorBlacklist,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, sql, ilike, or, notInArray } from "drizzle-orm";

export interface IStorage {
  // Storage Nodes
  getStorageNode(id: string): Promise<StorageNode | undefined>;
  getStorageNodeByPeerId(peerId: string): Promise<StorageNode | undefined>;
  getAllStorageNodes(): Promise<StorageNode[]>;
  createStorageNode(node: InsertStorageNode): Promise<StorageNode>;
  updateStorageNodeReputation(id: string, reputation: number, status: string): Promise<void>;
  
  // Files
  getFile(id: string): Promise<File | undefined>;
  getFileByCid(cid: string): Promise<File | undefined>;
  getAllFiles(): Promise<File[]>;
  createFile(file: InsertFile): Promise<File>;
  updateFileStatus(id: string, status: string, replicationCount: number, confidence: number): Promise<void>;
  
  // Validators
  getValidator(id: string): Promise<Validator | undefined>;
  getValidatorByUsername(username: string): Promise<Validator | undefined>;
  getAllValidators(): Promise<Validator[]>;
  createValidator(validator: InsertValidator): Promise<Validator>;
  updateValidatorStats(id: string, peerCount: number, performance: number): Promise<void>;
  
  // PoA Challenges
  createPoaChallenge(challenge: InsertPoaChallenge): Promise<PoaChallenge>;
  getRecentChallenges(limit: number): Promise<PoaChallenge[]>;
  updateChallengeResult(id: string, response: string, result: string, latencyMs: number): Promise<void>;
  
  // Hive Transactions
  createHiveTransaction(transaction: InsertHiveTransaction): Promise<HiveTransaction>;
  getRecentTransactions(limit: number): Promise<HiveTransaction[]>;
  
  // Storage Assignments
  assignFileToNode(fileId: string, nodeId: string): Promise<void>;
  getFileAssignments(fileId: string): Promise<StorageAssignment[]>;
  updateAssignmentProof(fileId: string, nodeId: string, success: boolean): Promise<void>;
  
  // Validator Blacklist
  searchStorageNodes(query: string): Promise<StorageNode[]>;
  getValidatorBlacklist(validatorId: string): Promise<ValidatorBlacklist[]>;
  addToBlacklist(entry: InsertValidatorBlacklist): Promise<ValidatorBlacklist>;
  removeFromBlacklist(validatorId: string, nodeId: string): Promise<void>;
  isNodeBlacklisted(validatorId: string, nodeId: string): Promise<boolean>;
  getEligibleNodesForValidator(validatorId: string): Promise<StorageNode[]>;
}

export class DatabaseStorage implements IStorage {
  // Storage Nodes
  async getStorageNode(id: string): Promise<StorageNode | undefined> {
    const [node] = await db.select().from(storageNodes).where(eq(storageNodes.id, id));
    return node || undefined;
  }

  async getStorageNodeByPeerId(peerId: string): Promise<StorageNode | undefined> {
    const [node] = await db.select().from(storageNodes).where(eq(storageNodes.peerId, peerId));
    return node || undefined;
  }

  async getAllStorageNodes(): Promise<StorageNode[]> {
    return await db.select().from(storageNodes).orderBy(desc(storageNodes.reputation));
  }

  async createStorageNode(node: InsertStorageNode): Promise<StorageNode> {
    const [created] = await db.insert(storageNodes).values(node).returning();
    return created;
  }

  async updateStorageNodeReputation(id: string, reputation: number, status: string): Promise<void> {
    await db.update(storageNodes)
      .set({ reputation, status, lastSeen: new Date() })
      .where(eq(storageNodes.id, id));
  }

  // Files
  async getFile(id: string): Promise<File | undefined> {
    const [file] = await db.select().from(files).where(eq(files.id, id));
    return file || undefined;
  }

  async getFileByCid(cid: string): Promise<File | undefined> {
    const [file] = await db.select().from(files).where(eq(files.cid, cid));
    return file || undefined;
  }

  async getAllFiles(): Promise<File[]> {
    return await db.select().from(files).orderBy(desc(files.createdAt));
  }

  async createFile(file: InsertFile): Promise<File> {
    const [created] = await db.insert(files).values(file).returning();
    return created;
  }

  async updateFileStatus(id: string, status: string, replicationCount: number, confidence: number): Promise<void> {
    await db.update(files)
      .set({ status, replicationCount, confidence })
      .where(eq(files.id, id));
  }

  // Validators
  async getValidator(id: string): Promise<Validator | undefined> {
    const [validator] = await db.select().from(validators).where(eq(validators.id, id));
    return validator || undefined;
  }

  async getValidatorByUsername(username: string): Promise<Validator | undefined> {
    const [validator] = await db.select().from(validators).where(eq(validators.hiveUsername, username));
    return validator || undefined;
  }

  async getAllValidators(): Promise<Validator[]> {
    return await db.select().from(validators).orderBy(desc(validators.performance));
  }

  async createValidator(validator: InsertValidator): Promise<Validator> {
    const [created] = await db.insert(validators).values(validator).returning();
    return created;
  }

  async updateValidatorStats(id: string, peerCount: number, performance: number): Promise<void> {
    await db.update(validators)
      .set({ peerCount, performance })
      .where(eq(validators.id, id));
  }

  // PoA Challenges
  async createPoaChallenge(challenge: InsertPoaChallenge): Promise<PoaChallenge> {
    const [created] = await db.insert(poaChallenges).values(challenge).returning();
    return created;
  }

  async getRecentChallenges(limit: number): Promise<PoaChallenge[]> {
    return await db.select().from(poaChallenges).orderBy(desc(poaChallenges.createdAt)).limit(limit);
  }

  async updateChallengeResult(id: string, response: string, result: string, latencyMs: number): Promise<void> {
    await db.update(poaChallenges)
      .set({ response, result, latencyMs })
      .where(eq(poaChallenges.id, id));
  }

  // Hive Transactions
  async createHiveTransaction(transaction: InsertHiveTransaction): Promise<HiveTransaction> {
    const [created] = await db.insert(hiveTransactions).values(transaction).returning();
    return created;
  }

  async getRecentTransactions(limit: number): Promise<HiveTransaction[]> {
    return await db.select().from(hiveTransactions).orderBy(desc(hiveTransactions.createdAt)).limit(limit);
  }

  // Storage Assignments
  async assignFileToNode(fileId: string, nodeId: string): Promise<void> {
    await db.insert(storageAssignments).values({ fileId, nodeId });
  }

  async getFileAssignments(fileId: string): Promise<StorageAssignment[]> {
    return await db.select().from(storageAssignments).where(eq(storageAssignments.fileId, fileId));
  }

  async updateAssignmentProof(fileId: string, nodeId: string, success: boolean): Promise<void> {
    const [assignment] = await db.select().from(storageAssignments)
      .where(and(
        eq(storageAssignments.fileId, fileId),
        eq(storageAssignments.nodeId, nodeId)
      ));

    if (assignment) {
      await db.update(storageAssignments)
        .set({
          proofCount: success ? assignment.proofCount + 1 : assignment.proofCount,
          failCount: success ? assignment.failCount : assignment.failCount + 1,
          lastProofAt: new Date(),
        })
        .where(eq(storageAssignments.id, assignment.id));
    }
  }

  // Validator Blacklist
  async searchStorageNodes(query: string): Promise<StorageNode[]> {
    if (!query.trim()) {
      return await db.select().from(storageNodes).orderBy(desc(storageNodes.reputation)).limit(50);
    }
    return await db.select().from(storageNodes)
      .where(or(
        ilike(storageNodes.hiveUsername, `%${query}%`),
        ilike(storageNodes.peerId, `%${query}%`)
      ))
      .orderBy(desc(storageNodes.reputation))
      .limit(50);
  }

  async getValidatorBlacklist(validatorId: string): Promise<ValidatorBlacklist[]> {
    return await db.select().from(validatorBlacklists)
      .where(and(
        eq(validatorBlacklists.validatorId, validatorId),
        eq(validatorBlacklists.active, true)
      ))
      .orderBy(desc(validatorBlacklists.createdAt));
  }

  async addToBlacklist(entry: InsertValidatorBlacklist): Promise<ValidatorBlacklist> {
    const existing = await db.select().from(validatorBlacklists)
      .where(and(
        eq(validatorBlacklists.validatorId, entry.validatorId),
        eq(validatorBlacklists.nodeId, entry.nodeId)
      ));
    
    if (existing.length > 0) {
      await db.update(validatorBlacklists)
        .set({ active: true, reason: entry.reason })
        .where(eq(validatorBlacklists.id, existing[0].id));
      return { ...existing[0], active: true, reason: entry.reason };
    }
    
    const [created] = await db.insert(validatorBlacklists).values(entry).returning();
    return created;
  }

  async removeFromBlacklist(validatorId: string, nodeId: string): Promise<void> {
    await db.update(validatorBlacklists)
      .set({ active: false })
      .where(and(
        eq(validatorBlacklists.validatorId, validatorId),
        eq(validatorBlacklists.nodeId, nodeId)
      ));
  }

  async isNodeBlacklisted(validatorId: string, nodeId: string): Promise<boolean> {
    const [entry] = await db.select().from(validatorBlacklists)
      .where(and(
        eq(validatorBlacklists.validatorId, validatorId),
        eq(validatorBlacklists.nodeId, nodeId),
        eq(validatorBlacklists.active, true)
      ));
    return !!entry;
  }

  async getEligibleNodesForValidator(validatorId: string): Promise<StorageNode[]> {
    const blacklistedNodeIds = await db.select({ nodeId: validatorBlacklists.nodeId })
      .from(validatorBlacklists)
      .where(and(
        eq(validatorBlacklists.validatorId, validatorId),
        eq(validatorBlacklists.active, true)
      ));
    
    const blacklistedIds = blacklistedNodeIds.map(b => b.nodeId);
    
    if (blacklistedIds.length === 0) {
      return await db.select().from(storageNodes)
        .where(eq(storageNodes.status, "active"))
        .orderBy(desc(storageNodes.reputation));
    }
    
    return await db.select().from(storageNodes)
      .where(and(
        eq(storageNodes.status, "active"),
        notInArray(storageNodes.id, blacklistedIds)
      ))
      .orderBy(desc(storageNodes.reputation));
  }
}

export const storage = new DatabaseStorage();
