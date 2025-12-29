// Integration: blueprint:javascript_database
import { 
  storageNodes, 
  files,
  validators,
  storageAssignments,
  poaChallenges,
  hiveTransactions,
  validatorBlacklists,
  // Phase 1: CDN & Storage
  cdnNodes,
  cdnMetrics,
  fileChunks,
  storageContracts,
  contractEvents,
  // Phase 2: Transcoding
  transcodeJobs,
  encoderNodes,
  // Phase 3: Blocklists
  blocklistEntries,
  platformBlocklists,
  tags,
  fileTags,
  tagVotes,
  // Phase 4: Desktop Parity
  userKeys,
  userNodeSettings,
  viewEvents,
  beneficiaryAllocations,
  payoutHistory,
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
  type CdnNode,
  type InsertCdnNode,
  type CdnMetric,
  type InsertCdnMetric,
  type FileChunk,
  type InsertFileChunk,
  type StorageContract,
  type InsertStorageContract,
  type ContractEvent,
  type InsertContractEvent,
  type TranscodeJob,
  type InsertTranscodeJob,
  type EncoderNode,
  type InsertEncoderNode,
  type BlocklistEntry,
  type InsertBlocklistEntry,
  type PlatformBlocklist,
  type InsertPlatformBlocklist,
  type Tag,
  type InsertTag,
  type FileTag,
  type InsertFileTag,
  type TagVote,
  type InsertTagVote,
  type UserKey,
  type InsertUserKey,
  type UserNodeSettings,
  type InsertUserNodeSettings,
  type ViewEvent,
  type InsertViewEvent,
  type BeneficiaryAllocation,
  type InsertBeneficiaryAllocation,
  type PayoutHistory,
  type InsertPayoutHistory,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, sql, ilike, or, notInArray, gte, lte, lt } from "drizzle-orm";

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

  // Phase 1: CDN Nodes
  getCdnNode(id: string): Promise<CdnNode | undefined>;
  getCdnNodeByPeerId(peerId: string): Promise<CdnNode | undefined>;
  getAllCdnNodes(): Promise<CdnNode[]>;
  getActiveCdnNodes(): Promise<CdnNode[]>;
  createCdnNode(node: InsertCdnNode): Promise<CdnNode>;
  updateCdnNodeHeartbeat(id: string): Promise<void>;
  updateCdnNodeStatus(id: string, status: string): Promise<void>;
  updateCdnNodeHealth(id: string, health: { healthScore: string; rawZScore: number; geoZScore: number }): Promise<void>;
  
  // Phase 1: CDN Metrics
  createCdnMetric(metric: InsertCdnMetric): Promise<CdnMetric>;
  getCdnNodeMetrics(nodeId: string, limit: number): Promise<CdnMetric[]>;
  
  // Phase 1: File Chunks
  createFileChunk(chunk: InsertFileChunk): Promise<FileChunk>;
  getFileChunks(fileId: string): Promise<FileChunk[]>;
  updateFileChunkStatus(id: string, status: string, checksum?: string): Promise<void>;
  
  // Phase 1: Storage Contracts
  getStorageContract(id: string): Promise<StorageContract | undefined>;
  getStorageContractByCid(cid: string): Promise<StorageContract | undefined>;
  getAllStorageContracts(): Promise<StorageContract[]>;
  getActiveStorageContracts(): Promise<StorageContract[]>;
  createStorageContract(contract: InsertStorageContract): Promise<StorageContract>;
  updateStorageContractStatus(id: string, status: string): Promise<void>;
  getExpiredContracts(): Promise<StorageContract[]>;
  
  // Phase 1: Contract Events
  createContractEvent(event: InsertContractEvent): Promise<ContractEvent>;
  getContractEvents(contractId: string): Promise<ContractEvent[]>;
  
  // Phase 2: Transcode Jobs
  getTranscodeJob(id: string): Promise<TranscodeJob | undefined>;
  getTranscodeJobsByFile(fileId: string): Promise<TranscodeJob[]>;
  getQueuedTranscodeJobs(): Promise<TranscodeJob[]>;
  createTranscodeJob(job: InsertTranscodeJob): Promise<TranscodeJob>;
  updateTranscodeJobStatus(id: string, status: string, progress?: number, outputCid?: string, errorMessage?: string): Promise<void>;
  assignTranscodeJob(jobId: string, encoderNodeId: string): Promise<void>;
  
  // Phase 2: Encoder Nodes
  getEncoderNode(id: string): Promise<EncoderNode | undefined>;
  getAllEncoderNodes(): Promise<EncoderNode[]>;
  getAvailableEncoderNodes(): Promise<EncoderNode[]>;
  createEncoderNode(node: InsertEncoderNode): Promise<EncoderNode>;
  updateEncoderNodeAvailability(id: string, availability: string): Promise<void>;
  
  // Phase 3: Blocklist Entries
  getBlocklistEntries(scope: string, scopeOwnerId?: string): Promise<BlocklistEntry[]>;
  createBlocklistEntry(entry: InsertBlocklistEntry): Promise<BlocklistEntry>;
  deactivateBlocklistEntry(id: string): Promise<void>;
  getEffectiveBlocklist(scopes: { scope: string; scopeOwnerId?: string }[]): Promise<BlocklistEntry[]>;
  
  // Phase 3: Platform Blocklists
  getPlatformBlocklist(platformId: string): Promise<PlatformBlocklist | undefined>;
  getAllPlatformBlocklists(): Promise<PlatformBlocklist[]>;
  createPlatformBlocklist(platform: InsertPlatformBlocklist): Promise<PlatformBlocklist>;
  
  // Phase 3: Tags
  getTag(id: string): Promise<Tag | undefined>;
  getTagByLabel(label: string): Promise<Tag | undefined>;
  getAllTags(): Promise<Tag[]>;
  createTag(tag: InsertTag): Promise<Tag>;
  
  // Phase 3: File Tags
  getFileTags(fileId: string): Promise<FileTag[]>;
  createFileTag(fileTag: InsertFileTag): Promise<FileTag>;
  updateFileTagVotes(id: string, votesUp: number, votesDown: number, confidence: number): Promise<void>;
  
  // Phase 3: Tag Votes
  createTagVote(vote: InsertTagVote): Promise<TagVote>;
  getUserVoteOnFileTag(fileTagId: string, voterUsername: string): Promise<TagVote | undefined>;
  
  // Phase 4: User Keys
  getUserKeys(username: string): Promise<UserKey[]>;
  createUserKey(key: InsertUserKey): Promise<UserKey>;
  
  // Phase 4: User Node Settings
  getUserNodeSettings(username: string): Promise<UserNodeSettings | undefined>;
  createOrUpdateUserNodeSettings(settings: InsertUserNodeSettings): Promise<UserNodeSettings>;
  
  // Phase 4: View Events
  createViewEvent(event: InsertViewEvent): Promise<ViewEvent>;
  getViewEventsForAutoPinning(): Promise<ViewEvent[]>;
  markViewEventAutoPinTriggered(id: string): Promise<void>;
  
  // Phase 4: Beneficiary Allocations
  getBeneficiaryAllocations(fromUsername: string): Promise<BeneficiaryAllocation[]>;
  createBeneficiaryAllocation(allocation: InsertBeneficiaryAllocation): Promise<BeneficiaryAllocation>;
  updateBeneficiaryAllocation(id: string, percentage: number): Promise<void>;
  deactivateBeneficiaryAllocation(id: string): Promise<void>;
  
  // Phase 4: Payout History
  createPayoutHistory(payout: InsertPayoutHistory): Promise<PayoutHistory>;
  getPayoutHistory(username: string, limit: number): Promise<PayoutHistory[]>;
}

export class DatabaseStorage implements IStorage {
  // ============================================================
  // Storage Nodes
  // ============================================================
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

  // ============================================================
  // Files
  // ============================================================
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

  // ============================================================
  // Validators
  // ============================================================
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

  // ============================================================
  // PoA Challenges
  // ============================================================
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

  // ============================================================
  // Hive Transactions
  // ============================================================
  async createHiveTransaction(transaction: InsertHiveTransaction): Promise<HiveTransaction> {
    const [created] = await db.insert(hiveTransactions).values(transaction).returning();
    return created;
  }

  async getRecentTransactions(limit: number): Promise<HiveTransaction[]> {
    return await db.select().from(hiveTransactions).orderBy(desc(hiveTransactions.createdAt)).limit(limit);
  }

  // ============================================================
  // Storage Assignments
  // ============================================================
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

  // ============================================================
  // Validator Blacklist
  // ============================================================
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
    const [existing] = await db.select().from(validatorBlacklists)
      .where(and(
        eq(validatorBlacklists.validatorId, entry.validatorId),
        eq(validatorBlacklists.nodeId, entry.nodeId)
      ))
      .limit(1);
    
    if (existing) {
      const [updated] = await db.update(validatorBlacklists)
        .set({ active: true, reason: entry.reason })
        .where(eq(validatorBlacklists.id, existing.id))
        .returning();
      return updated;
    }
    
    const [created] = await db.insert(validatorBlacklists).values(entry).returning();
    return created;
  }

  async removeFromBlacklist(validatorId: string, nodeId: string): Promise<void> {
    await db.update(validatorBlacklists)
      .set({ active: false })
      .where(and(
        eq(validatorBlacklists.validatorId, validatorId),
        eq(validatorBlacklists.nodeId, nodeId),
        eq(validatorBlacklists.active, true)
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

  // ============================================================
  // Phase 1: CDN Nodes
  // ============================================================
  async getCdnNode(id: string): Promise<CdnNode | undefined> {
    const [node] = await db.select().from(cdnNodes).where(eq(cdnNodes.id, id));
    return node || undefined;
  }

  async getCdnNodeByPeerId(peerId: string): Promise<CdnNode | undefined> {
    const [node] = await db.select().from(cdnNodes).where(eq(cdnNodes.peerId, peerId));
    return node || undefined;
  }

  async getAllCdnNodes(): Promise<CdnNode[]> {
    return await db.select().from(cdnNodes).orderBy(desc(cdnNodes.lastHeartbeat));
  }

  async getActiveCdnNodes(): Promise<CdnNode[]> {
    return await db.select().from(cdnNodes)
      .where(or(eq(cdnNodes.status, 'active'), eq(cdnNodes.status, 'degraded')))
      .orderBy(desc(cdnNodes.lastHeartbeat));
  }

  async createCdnNode(node: InsertCdnNode): Promise<CdnNode> {
    const [created] = await db.insert(cdnNodes).values(node).returning();
    return created;
  }

  async updateCdnNodeHeartbeat(id: string): Promise<void> {
    await db.update(cdnNodes)
      .set({ lastHeartbeat: new Date() })
      .where(eq(cdnNodes.id, id));
  }

  async updateCdnNodeStatus(id: string, status: string): Promise<void> {
    await db.update(cdnNodes)
      .set({ status })
      .where(eq(cdnNodes.id, id));
  }

  async updateCdnNodeHealth(id: string, health: { healthScore: string; rawZScore: number; geoZScore: number }): Promise<void> {
    await db.update(cdnNodes)
      .set({ 
        healthScore: health.healthScore,
        rawZScore: health.rawZScore,
        geoZScore: health.geoZScore
      })
      .where(eq(cdnNodes.id, id));
  }

  // ============================================================
  // Phase 1: CDN Metrics
  // ============================================================
  async createCdnMetric(metric: InsertCdnMetric): Promise<CdnMetric> {
    const [created] = await db.insert(cdnMetrics).values(metric).returning();
    return created;
  }

  async getCdnNodeMetrics(nodeId: string, limit: number): Promise<CdnMetric[]> {
    return await db.select().from(cdnMetrics)
      .where(eq(cdnMetrics.nodeId, nodeId))
      .orderBy(desc(cdnMetrics.createdAt))
      .limit(limit);
  }

  // ============================================================
  // Phase 1: File Chunks
  // ============================================================
  async createFileChunk(chunk: InsertFileChunk): Promise<FileChunk> {
    const [created] = await db.insert(fileChunks).values(chunk).returning();
    return created;
  }

  async getFileChunks(fileId: string): Promise<FileChunk[]> {
    return await db.select().from(fileChunks)
      .where(eq(fileChunks.fileId, fileId))
      .orderBy(fileChunks.chunkIndex);
  }

  async updateFileChunkStatus(id: string, status: string, checksum?: string): Promise<void> {
    const updates: Record<string, any> = { status };
    if (checksum) updates.checksum = checksum;
    await db.update(fileChunks).set(updates).where(eq(fileChunks.id, id));
  }

  // ============================================================
  // Phase 1: Storage Contracts
  // ============================================================
  async getStorageContract(id: string): Promise<StorageContract | undefined> {
    const [contract] = await db.select().from(storageContracts).where(eq(storageContracts.id, id));
    return contract || undefined;
  }

  async getStorageContractByCid(cid: string): Promise<StorageContract | undefined> {
    const [contract] = await db.select().from(storageContracts).where(eq(storageContracts.fileCid, cid));
    return contract || undefined;
  }

  async getAllStorageContracts(): Promise<StorageContract[]> {
    return await db.select().from(storageContracts).orderBy(desc(storageContracts.createdAt));
  }

  async getActiveStorageContracts(): Promise<StorageContract[]> {
    return await db.select().from(storageContracts)
      .where(eq(storageContracts.status, 'active'))
      .orderBy(desc(storageContracts.createdAt));
  }

  async createStorageContract(contract: InsertStorageContract): Promise<StorageContract> {
    const [created] = await db.insert(storageContracts).values(contract).returning();
    return created;
  }

  async updateStorageContractStatus(id: string, status: string): Promise<void> {
    await db.update(storageContracts)
      .set({ status })
      .where(eq(storageContracts.id, id));
  }

  async getExpiredContracts(): Promise<StorageContract[]> {
    return await db.select().from(storageContracts)
      .where(and(
        eq(storageContracts.status, 'active'),
        lt(storageContracts.expiresAt, new Date())
      ));
  }

  // ============================================================
  // Phase 1: Contract Events
  // ============================================================
  async createContractEvent(event: InsertContractEvent): Promise<ContractEvent> {
    const [created] = await db.insert(contractEvents).values(event).returning();
    return created;
  }

  async getContractEvents(contractId: string): Promise<ContractEvent[]> {
    return await db.select().from(contractEvents)
      .where(eq(contractEvents.contractId, contractId))
      .orderBy(desc(contractEvents.createdAt));
  }

  // ============================================================
  // Phase 2: Transcode Jobs
  // ============================================================
  async getTranscodeJob(id: string): Promise<TranscodeJob | undefined> {
    const [job] = await db.select().from(transcodeJobs).where(eq(transcodeJobs.id, id));
    return job || undefined;
  }

  async getTranscodeJobsByFile(fileId: string): Promise<TranscodeJob[]> {
    return await db.select().from(transcodeJobs)
      .where(eq(transcodeJobs.fileId, fileId))
      .orderBy(desc(transcodeJobs.createdAt));
  }

  async getQueuedTranscodeJobs(): Promise<TranscodeJob[]> {
    return await db.select().from(transcodeJobs)
      .where(eq(transcodeJobs.status, 'queued'))
      .orderBy(transcodeJobs.createdAt);
  }

  async createTranscodeJob(job: InsertTranscodeJob): Promise<TranscodeJob> {
    const [created] = await db.insert(transcodeJobs).values(job).returning();
    return created;
  }

  async updateTranscodeJobStatus(id: string, status: string, progress?: number, outputCid?: string, errorMessage?: string): Promise<void> {
    const updates: Record<string, any> = { status };
    if (progress !== undefined) updates.progress = progress;
    if (outputCid) updates.outputCid = outputCid;
    if (errorMessage) updates.errorMessage = errorMessage;
    if (status === 'processing') updates.startedAt = new Date();
    if (status === 'completed' || status === 'failed') updates.completedAt = new Date();
    await db.update(transcodeJobs).set(updates).where(eq(transcodeJobs.id, id));
  }

  async assignTranscodeJob(jobId: string, encoderNodeId: string): Promise<void> {
    await db.update(transcodeJobs)
      .set({ encoderNodeId, status: 'assigned' })
      .where(eq(transcodeJobs.id, jobId));
  }

  // ============================================================
  // Phase 2: Encoder Nodes
  // ============================================================
  async getEncoderNode(id: string): Promise<EncoderNode | undefined> {
    const [node] = await db.select().from(encoderNodes).where(eq(encoderNodes.id, id));
    return node || undefined;
  }

  async getAllEncoderNodes(): Promise<EncoderNode[]> {
    return await db.select().from(encoderNodes).orderBy(desc(encoderNodes.rating));
  }

  async getAvailableEncoderNodes(): Promise<EncoderNode[]> {
    return await db.select().from(encoderNodes)
      .where(and(
        eq(encoderNodes.status, 'active'),
        eq(encoderNodes.availability, 'available')
      ))
      .orderBy(desc(encoderNodes.rating));
  }

  async createEncoderNode(node: InsertEncoderNode): Promise<EncoderNode> {
    const [created] = await db.insert(encoderNodes).values(node).returning();
    return created;
  }

  async updateEncoderNodeAvailability(id: string, availability: string): Promise<void> {
    await db.update(encoderNodes)
      .set({ availability })
      .where(eq(encoderNodes.id, id));
  }

  // ============================================================
  // Phase 3: Blocklist Entries
  // ============================================================
  async getBlocklistEntries(scope: string, scopeOwnerId?: string): Promise<BlocklistEntry[]> {
    if (scopeOwnerId) {
      return await db.select().from(blocklistEntries)
        .where(and(
          eq(blocklistEntries.scope, scope),
          eq(blocklistEntries.scopeOwnerId, scopeOwnerId),
          eq(blocklistEntries.active, true)
        ))
        .orderBy(desc(blocklistEntries.createdAt));
    }
    return await db.select().from(blocklistEntries)
      .where(and(
        eq(blocklistEntries.scope, scope),
        eq(blocklistEntries.active, true)
      ))
      .orderBy(desc(blocklistEntries.createdAt));
  }

  async createBlocklistEntry(entry: InsertBlocklistEntry): Promise<BlocklistEntry> {
    const [created] = await db.insert(blocklistEntries).values(entry).returning();
    return created;
  }

  async deactivateBlocklistEntry(id: string): Promise<void> {
    await db.update(blocklistEntries)
      .set({ active: false })
      .where(eq(blocklistEntries.id, id));
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
    const [platform] = await db.select().from(platformBlocklists)
      .where(eq(platformBlocklists.platformId, platformId));
    return platform || undefined;
  }

  async getAllPlatformBlocklists(): Promise<PlatformBlocklist[]> {
    return await db.select().from(platformBlocklists);
  }

  async createPlatformBlocklist(platform: InsertPlatformBlocklist): Promise<PlatformBlocklist> {
    const [created] = await db.insert(platformBlocklists).values(platform).returning();
    return created;
  }

  // ============================================================
  // Phase 3: Tags
  // ============================================================
  async getTag(id: string): Promise<Tag | undefined> {
    const [tag] = await db.select().from(tags).where(eq(tags.id, id));
    return tag || undefined;
  }

  async getTagByLabel(label: string): Promise<Tag | undefined> {
    const [tag] = await db.select().from(tags).where(eq(tags.label, label));
    return tag || undefined;
  }

  async getAllTags(): Promise<Tag[]> {
    return await db.select().from(tags).orderBy(tags.label);
  }

  async createTag(tag: InsertTag): Promise<Tag> {
    const [created] = await db.insert(tags).values(tag).returning();
    return created;
  }

  // ============================================================
  // Phase 3: File Tags
  // ============================================================
  async getFileTags(fileId: string): Promise<FileTag[]> {
    return await db.select().from(fileTags)
      .where(eq(fileTags.fileId, fileId))
      .orderBy(desc(fileTags.confidence));
  }

  async createFileTag(fileTag: InsertFileTag): Promise<FileTag> {
    const [created] = await db.insert(fileTags).values(fileTag).returning();
    return created;
  }

  async updateFileTagVotes(id: string, votesUp: number, votesDown: number, confidence: number): Promise<void> {
    await db.update(fileTags)
      .set({ votesUp, votesDown, confidence })
      .where(eq(fileTags.id, id));
  }

  // ============================================================
  // Phase 3: Tag Votes
  // ============================================================
  async createTagVote(vote: InsertTagVote): Promise<TagVote> {
    const [created] = await db.insert(tagVotes).values(vote).returning();
    return created;
  }

  async getUserVoteOnFileTag(fileTagId: string, voterUsername: string): Promise<TagVote | undefined> {
    const [vote] = await db.select().from(tagVotes)
      .where(and(
        eq(tagVotes.fileTagId, fileTagId),
        eq(tagVotes.voterUsername, voterUsername)
      ));
    return vote || undefined;
  }

  // ============================================================
  // Phase 4: User Keys
  // ============================================================
  async getUserKeys(username: string): Promise<UserKey[]> {
    return await db.select().from(userKeys)
      .where(eq(userKeys.username, username));
  }

  async createUserKey(key: InsertUserKey): Promise<UserKey> {
    const [created] = await db.insert(userKeys).values(key).returning();
    return created;
  }

  // ============================================================
  // Phase 4: User Node Settings
  // ============================================================
  async getUserNodeSettings(username: string): Promise<UserNodeSettings | undefined> {
    const [settings] = await db.select().from(userNodeSettings)
      .where(eq(userNodeSettings.username, username));
    return settings || undefined;
  }

  async createOrUpdateUserNodeSettings(settings: InsertUserNodeSettings): Promise<UserNodeSettings> {
    const existing = await this.getUserNodeSettings(settings.username);
    if (existing) {
      const [updated] = await db.update(userNodeSettings)
        .set({ ...settings, updatedAt: new Date() })
        .where(eq(userNodeSettings.id, existing.id))
        .returning();
      return updated;
    }
    const [created] = await db.insert(userNodeSettings).values(settings).returning();
    return created;
  }

  // ============================================================
  // Phase 4: View Events
  // ============================================================
  async createViewEvent(event: InsertViewEvent): Promise<ViewEvent> {
    const [created] = await db.insert(viewEvents).values(event).returning();
    return created;
  }

  async getViewEventsForAutoPinning(): Promise<ViewEvent[]> {
    return await db.select().from(viewEvents)
      .where(and(
        eq(viewEvents.completed, true),
        eq(viewEvents.autoPinTriggered, false)
      ))
      .orderBy(desc(viewEvents.createdAt))
      .limit(100);
  }

  async markViewEventAutoPinTriggered(id: string): Promise<void> {
    await db.update(viewEvents)
      .set({ autoPinTriggered: true })
      .where(eq(viewEvents.id, id));
  }

  // ============================================================
  // Phase 4: Beneficiary Allocations
  // ============================================================
  async getBeneficiaryAllocations(fromUsername: string): Promise<BeneficiaryAllocation[]> {
    return await db.select().from(beneficiaryAllocations)
      .where(and(
        eq(beneficiaryAllocations.fromUsername, fromUsername),
        eq(beneficiaryAllocations.active, true)
      ));
  }

  async createBeneficiaryAllocation(allocation: InsertBeneficiaryAllocation): Promise<BeneficiaryAllocation> {
    const [created] = await db.insert(beneficiaryAllocations).values(allocation).returning();
    return created;
  }

  async updateBeneficiaryAllocation(id: string, percentage: number): Promise<void> {
    await db.update(beneficiaryAllocations)
      .set({ percentage })
      .where(eq(beneficiaryAllocations.id, id));
  }

  async deactivateBeneficiaryAllocation(id: string): Promise<void> {
    await db.update(beneficiaryAllocations)
      .set({ active: false })
      .where(eq(beneficiaryAllocations.id, id));
  }

  // ============================================================
  // Phase 4: Payout History
  // ============================================================
  async createPayoutHistory(payout: InsertPayoutHistory): Promise<PayoutHistory> {
    const [created] = await db.insert(payoutHistory).values(payout).returning();
    return created;
  }

  async getPayoutHistory(username: string, limit: number): Promise<PayoutHistory[]> {
    return await db.select().from(payoutHistory)
      .where(eq(payoutHistory.recipientUsername, username))
      .orderBy(desc(payoutHistory.createdAt))
      .limit(limit);
  }
}

export const storage = new DatabaseStorage();
