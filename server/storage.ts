// Integration: blueprint:javascript_database
import { createRequire } from "module";
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
  encodingJobs,
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
  // Phase 5: Payout System
  walletDeposits,
  payoutReports,
  payoutLineItems,
  // Phase 6: P2P CDN
  p2pSessions,
  p2pContributions,
  p2pRooms,
  p2pNetworkStats,
  // User Sessions & Agent Keys
  userSessions,
  agentKeys,
  // File Refs (PoA 2.0)
  fileRefs,
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
  type EncodingJob,
  type InsertEncodingJob,
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
  // Phase 5: Payout System Types
  type WalletDeposit,
  type InsertWalletDeposit,
  type PayoutReport,
  type InsertPayoutReport,
  type PayoutLineItem,
  type InsertPayoutLineItem,
  // Phase 6: P2P CDN Types
  type P2pSession,
  type InsertP2pSession,
  type P2pContribution,
  type InsertP2pContribution,
  type P2pRoom,
  type InsertP2pRoom,
  type P2pNetworkStats,
  type InsertP2pNetworkStats,
  // Phase 7: Encoding Job Offers
  encodingJobOffers,
  type EncodingJobOffer,
  type InsertEncodingJobOffer,
  // Phase 7: Web of Trust
  webOfTrust,
  type WebOfTrust,
  type InsertWebOfTrust,
  // Phase 8: Multisig Treasury
  treasurySigners,
  treasuryVouches,
  treasuryTransactions,
  treasuryAuditLog,
  treasuryFreezeState,
  type TreasurySigner,
  type InsertTreasurySigner,
  type TreasuryVouch,
  type InsertTreasuryVouch,
  type TreasuryTransaction,
  type InsertTreasuryTransaction,
  type TreasuryAuditLog,
  type InsertTreasuryAuditLog,
  // Phase 9: Content Moderation
  contentFlags,
  uploaderBans,
  type ContentFlag,
  type InsertContentFlag,
  type UploaderBan,
  type InsertUploaderBan,
  // Phase 10: GPU Compute Marketplace
  computeNodes,
  computeJobs,
  computeJobAttempts,
  computeVerifications,
  computePayouts,
  type ComputeNode,
  type InsertComputeNode,
  type ComputeJob,
  type InsertComputeJob,
  type ComputeJobAttempt,
  type InsertComputeJobAttempt,
  type ComputeVerification,
  type InsertComputeVerification,
  type ComputePayout,
  type InsertComputePayout,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, sql, ilike, or, notInArray, gte, lte, lt } from "drizzle-orm";

export interface IStorage {
  // Storage Nodes
  getStorageNode(id: string): Promise<StorageNode | undefined>;
  getStorageNodeByPeerId(peerId: string): Promise<StorageNode | undefined>;
  getAllStorageNodes(): Promise<StorageNode[]>;
  createStorageNode(node: InsertStorageNode): Promise<StorageNode>;
  updateStorageNodeReputation(id: string, reputation: number, status: string, consecutiveFails?: number): Promise<void>;
  updateNodeEarnings(id: string, hbdAmount: number): Promise<void>;
  updateStorageNodeLastSeen(id: string): Promise<void>;
  decayInactiveNodeReputation(inactiveDays: number, decayPerDay: number): Promise<number>;

  // Files
  getFile(id: string): Promise<File | undefined>;
  getFileByCid(cid: string): Promise<File | undefined>;
  getAllFiles(): Promise<File[]>;
  createFile(file: InsertFile): Promise<File>;
  updateFileStatus(id: string, status: string, replicationCount: number, confidence: number): Promise<void>;
  updateFileCid(id: string, newCid: string): Promise<void>;
  updateFileEarnings(id: string, hbdAmount: number): Promise<void>;
  deleteFile(id: string): Promise<boolean>;
  
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
  updateStorageContractCid(id: string, newCid: string): Promise<void>;
  getStorageContractsByFileId(fileId: string): Promise<StorageContract[]>;
  getExpiredContracts(): Promise<StorageContract[]>;
  getActiveContractsForChallenge(): Promise<StorageContract[]>;
  updateStorageContractSpent(id: string, amount: number): Promise<boolean>;
  getExhaustedContracts(): Promise<StorageContract[]>;
  getActiveContractByCid(cid: string): Promise<StorageContract | undefined>;

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
  getMarketplaceEncoders(quality: string, sortBy: string): Promise<EncoderNode[]>;
  
  // Encoding Jobs (new hybrid encoding system)
  createEncodingJob(job: InsertEncodingJob): Promise<EncodingJob>;
  updateEncodingJob(id: string, updates: Partial<EncodingJob>): Promise<void>;
  
  // Encoding Job Offers (custom price offers)
  createEncodingJobOffer(offer: InsertEncodingJobOffer): Promise<EncodingJobOffer>;
  getEncodingJobOffers(status: string): Promise<EncodingJobOffer[]>;
  acceptEncodingJobOffer(id: string, encoderId: string): Promise<EncodingJobOffer | undefined>;
  getUserEncodingOffers(username: string): Promise<EncodingJobOffer[]>;
  cancelEncodingJobOffer(id: string, username: string): Promise<boolean>;
  
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

  // Phase 5: Wallet Deposits
  createWalletDeposit(deposit: InsertWalletDeposit): Promise<WalletDeposit>;
  getWalletDeposits(limit: number): Promise<WalletDeposit[]>;
  getWalletDepositsByUser(username: string): Promise<WalletDeposit[]>;
  getUnprocessedDeposits(): Promise<WalletDeposit[]>;
  markDepositProcessed(id: string): Promise<void>;
  getWalletBalance(): Promise<{ totalDeposits: string; totalPaid: string; available: string }>;

  // Phase 5: Payout Reports
  createPayoutReport(report: InsertPayoutReport): Promise<PayoutReport>;
  getPayoutReport(id: string): Promise<PayoutReport | undefined>;
  getPayoutReports(limit: number): Promise<PayoutReport[]>;
  getPayoutReportsByValidator(validatorUsername: string): Promise<PayoutReport[]>;
  updatePayoutReportStatus(id: string, status: string, executedTxHash?: string): Promise<void>;
  getOverlappingPayoutReports(periodStart: Date, periodEnd: Date): Promise<PayoutReport[]>;

  // Phase 5: Payout Line Items
  createPayoutLineItem(item: InsertPayoutLineItem): Promise<PayoutLineItem>;
  createPayoutLineItems(items: InsertPayoutLineItem[]): Promise<PayoutLineItem[]>;
  getPayoutLineItems(reportId: string): Promise<PayoutLineItem[]>;
  markLineItemPaid(id: string, txHash: string): Promise<void>;
  getPoaDataForPayout(startDate: Date, endDate: Date): Promise<{ username: string; proofCount: number; successRate: number; totalHbd: string }[]>;

  // Phase 6: P2P Sessions
  createP2pSession(session: InsertP2pSession): Promise<P2pSession>;
  getP2pSession(id: string): Promise<P2pSession | undefined>;
  getP2pSessionByPeerId(peerId: string): Promise<P2pSession | undefined>;
  getActiveP2pSessions(roomId?: string): Promise<P2pSession[]>;
  updateP2pSessionStats(id: string, bytesUploaded: number, bytesDownloaded: number, segmentsShared: number, peersConnected: number): Promise<void>;
  disconnectP2pSession(id: string): Promise<void>;
  cleanupStaleSessions(): Promise<number>;

  // Phase 6: P2P Contributions
  createP2pContribution(contribution: InsertP2pContribution): Promise<P2pContribution>;
  getP2pContributionsByPeerId(peerId: string): Promise<P2pContribution[]>;
  getP2pContributionsByUsername(hiveUsername: string): Promise<P2pContribution[]>;
  getTopContributors(limit: number): Promise<{ hiveUsername: string; totalBytesShared: number; totalSegments: number }[]>;

  // Phase 6: P2P Rooms
  getOrCreateP2pRoom(videoCid: string): Promise<P2pRoom>;
  getP2pRoom(id: string): Promise<P2pRoom | undefined>;
  getP2pRoomByCid(videoCid: string): Promise<P2pRoom | undefined>;
  updateP2pRoomStats(id: string, activePeers: number, bytesShared: number): Promise<void>;
  getActiveP2pRooms(): Promise<P2pRoom[]>;

  // Phase 6: P2P Network Stats
  createP2pNetworkStats(stats: InsertP2pNetworkStats): Promise<P2pNetworkStats>;
  getP2pNetworkStats(limit: number): Promise<P2pNetworkStats[]>;
  getCurrentP2pNetworkStats(): Promise<{ activePeers: number; activeRooms: number; totalBytesShared: number; avgP2pRatio: number }>;

  // Phase 7: Web of Trust
  getActiveVouch(sponsorUsername: string): Promise<WebOfTrust | undefined>;
  getVouchForUser(vouchedUsername: string): Promise<WebOfTrust | undefined>;
  getAllActiveVouches(): Promise<WebOfTrust[]>;
  createVouch(vouch: InsertWebOfTrust): Promise<WebOfTrust>;
  revokeVouch(sponsorUsername: string, reason: string): Promise<void>;
  isVouchedValidator(username: string): Promise<boolean>;

  // Phase 8: Multisig Treasury — Signers
  createTreasurySigner(signer: InsertTreasurySigner): Promise<TreasurySigner>;
  getTreasurySignerByUsername(username: string): Promise<TreasurySigner | undefined>;
  getActiveTreasurySigners(): Promise<TreasurySigner[]>;
  updateSignerStatus(username: string, status: string, extra?: Partial<TreasurySigner>): Promise<void>;
  updateSignerHeartbeat(username: string): Promise<void>;

  // Phase 8: Multisig Treasury — Vouches (WoT extension)
  createTreasuryVouch(vouch: InsertTreasuryVouch): Promise<TreasuryVouch>;
  getActiveVouchesForCandidate(candidateUsername: string): Promise<TreasuryVouch[]>;
  getActiveVouchesByVoucher(voucherUsername: string): Promise<TreasuryVouch[]>;
  getAllActiveTreasuryVouches(): Promise<TreasuryVouch[]>;
  revokeTreasuryVouch(voucherUsername: string, candidateUsername: string, reason: string): Promise<void>;
  revokeTreasuryVouchesByVoucher(voucherUsername: string, reason: string): Promise<void>;
  countActiveVouchesForCandidate(candidateUsername: string): Promise<number>;

  // Phase 8: Multisig Treasury — Transactions
  createTreasuryTransaction(tx: InsertTreasuryTransaction): Promise<TreasuryTransaction>;
  getTreasuryTransaction(id: string): Promise<TreasuryTransaction | undefined>;
  getRecentTreasuryTransactions(limit?: number): Promise<TreasuryTransaction[]>;
  updateTreasuryTxSignature(id: string, username: string, signature: string): Promise<void>;
  updateTreasuryTxStatus(id: string, status: string, broadcastTxId?: string): Promise<void>;

  // User Sessions (persistent, survives server restarts)
  createSession(token: string, username: string, expiresAt: Date, role?: string, validatorOptedIn?: boolean | null): Promise<void>;
  getSession(token: string): Promise<{ username: string; expiresAt: Date; role: string; validatorOptedIn: boolean | null } | undefined>;
  updateSessionValidatorOptIn(token: string, optedIn: boolean): Promise<void>;
  deleteSession(token: string): Promise<void>;
  cleanExpiredSessions(): Promise<void>;

  // Agent API Keys
  createAgentKey(apiKey: string, hiveUsername: string, label?: string): Promise<void>;
  getAgentByKey(apiKey: string): Promise<{ hiveUsername: string; id: string } | undefined>;
  deleteAgentKey(id: string): Promise<void>;

  // File Refs (PoA 2.0)
  getFileRefs(cid: string): Promise<string[] | null>;
  saveFileRefs(cid: string, blockCids: string[]): Promise<void>;
  hasFileRefs(cid: string): Promise<boolean>;

  // Analytics
  getChallengesLast24Hours(): Promise<{ hour: number; successCount: number; failCount: number; totalCount: number; avgLatency: number }[]>;
  getPerformanceMetrics(): Promise<{ totalChallenges: number; successRate: number; avgLatency: number; minLatency: number; maxLatency: number }>;
  getNodeHealthSummary(): Promise<{ active: number; probation: number; banned: number; total: number }>;
  getViewEventStats(username: string): Promise<{ totalViews: number; completedViews: number; pinnedContent: number }>;
  getRecentNodeLogs(limit?: number): Promise<{ timestamp: Date; level: string; message: string; source: string }[]>;
  getStatsAggregated(): Promise<any>;
  getStorageNodeByUsername(username: string): Promise<StorageNode | undefined>;
  getNodeChallenges(nodeId: string, limit: number): Promise<PoaChallenge[]>;
  getNodeEarnings(nodeUsername: string): Promise<number>;
  getMarketplaceFiles(): Promise<any[]>;

  // Paginated queries
  getFilesPaginated(limit: number, offset: number): Promise<{ data: File[]; total: number }>;
  getNodesPaginated(limit: number, offset: number): Promise<{ data: StorageNode[]; total: number }>;
  getChallengesPaginated(limit: number, offset: number): Promise<{ data: PoaChallenge[]; total: number }>;
  getTransactionsPaginated(limit: number, offset: number): Promise<{ data: HiveTransaction[]; total: number }>;

  // Content Moderation
  createContentFlag(flag: InsertContentFlag): Promise<ContentFlag>;
  getContentFlags(status?: string): Promise<ContentFlag[]>;
  getContentFlagsByCid(cid: string): Promise<ContentFlag[]>;
  getContentFlagById(id: string): Promise<ContentFlag | undefined>;
  updateContentFlagStatus(id: string, status: string, reviewedBy: string): Promise<void>;
  incrementFlagCount(cid: string, reason: string): Promise<ContentFlag>;
  getFlaggedContentSummary(): Promise<{ cid: string; totalFlags: number; reasons: string[]; maxSeverity: string; status: string }[]>;
  createUploaderBan(ban: InsertUploaderBan): Promise<UploaderBan>;
  getUploaderBans(bannedBy?: string): Promise<UploaderBan[]>;
  isUploaderBanned(username: string, bannedBy?: string): Promise<boolean>;
  removeUploaderBan(id: string): Promise<void>;
  getActiveBansForNode(nodeOperator: string): Promise<UploaderBan[]>;
  // Treasury Audit Log
  createTreasuryAuditLog(entry: InsertTreasuryAuditLog): Promise<TreasuryAuditLog>;
  getRecentTreasuryAuditLogs(limit?: number): Promise<TreasuryAuditLog[]>;
  // Treasury Freeze State
  getTreasuryFreezeState(): Promise<any | undefined>;
  setTreasuryFrozen(frozenBy: string, reason: string, unfreezeThreshold: number): Promise<void>;
  addUnfreezeVote(username: string): Promise<{ frozen: boolean; voteCount: number; threshold: number }>;
  clearTreasuryFreeze(): Promise<void>;
  // Treasury Transaction Extensions (delay + veto)
  updateTreasuryTxDelayed(id: string, broadcastAfter: Date, delaySeconds: number): Promise<void>;
  updateTreasuryTxSignatures(id: string, signatures: Record<string, string>): Promise<void>;
  updateTreasuryTransaction(id: string, fields: Partial<{ operationsJson: string; txDigest: string; status: string; expiresAt: Date }>): Promise<void>;
  getDelayedTreasuryTransactions(): Promise<TreasuryTransaction[]>;
  // Anomaly Detection
  hasReceivedTreasuryPayment(recipient: string): Promise<boolean>;

  // Phase 10: GPU Compute Marketplace — Nodes
  getComputeNode(id: string): Promise<ComputeNode | undefined>;
  getComputeNodeByInstanceId(instanceId: string): Promise<ComputeNode | undefined>;
  getComputeNodesByUsername(username: string): Promise<ComputeNode[]>;
  getAllComputeNodes(): Promise<ComputeNode[]>;
  getAvailableComputeNodes(workloadType?: string, minVramGb?: number): Promise<ComputeNode[]>;
  createComputeNode(node: InsertComputeNode): Promise<ComputeNode>;
  updateComputeNode(id: string, updates: Partial<ComputeNode>): Promise<void>;
  updateComputeNodeHeartbeat(id: string, jobsInProgress: number): Promise<void>;
  updateComputeNodeStats(id: string, completed: boolean, hbdEarned?: string): Promise<void>;

  // Phase 10: GPU Compute Marketplace — Jobs
  getComputeJob(id: string): Promise<ComputeJob | undefined>;
  getComputeJobsByCreator(username: string, limit?: number): Promise<ComputeJob[]>;
  getQueuedComputeJobs(workloadType?: string): Promise<ComputeJob[]>;
  createComputeJob(job: InsertComputeJob): Promise<ComputeJob>;
  updateComputeJobState(id: string, state: string, extra?: Partial<ComputeJob>): Promise<void>;
  touchActiveAttemptHeartbeats(nodeId: string): Promise<void>;
  claimComputeJobAtomic(nodeId: string, allowedTypes: string[], minVramGb: number, cachedModelsList: string[], leaseToken: string): Promise<{ job: ComputeJob; attempt: ComputeJobAttempt } | null>;
  getExpiredComputeLeases(): Promise<ComputeJobAttempt[]>;

  // Phase 10: GPU Compute Marketplace — Attempts
  createComputeJobAttempt(attempt: InsertComputeJobAttempt): Promise<ComputeJobAttempt>;
  getComputeJobAttempt(id: string): Promise<ComputeJobAttempt | undefined>;
  getComputeJobAttempts(jobId: string): Promise<ComputeJobAttempt[]>;
  updateComputeJobAttempt(id: string, updates: Partial<ComputeJobAttempt>): Promise<void>;

  // Phase 10: GPU Compute Marketplace — Verifications
  createComputeVerification(verification: InsertComputeVerification): Promise<ComputeVerification>;
  getComputeVerifications(jobId: string): Promise<ComputeVerification[]>;

  // Phase 10: GPU Compute Marketplace — Payouts
  createComputePayout(payout: InsertComputePayout): Promise<ComputePayout>;
  getComputePayoutsByJob(jobId: string): Promise<ComputePayout[]>;
  getComputePayoutsByNode(nodeId: string, limit?: number): Promise<ComputePayout[]>;
  updateComputePayoutStatus(id: string, status: string, treasuryTxId?: string): Promise<void>;

  // Phase 10: GPU Compute Marketplace — Stats
  getComputeStats(): Promise<{ totalNodes: number; onlineNodes: number; totalJobs: number; completedJobs: number; totalHbdPaid: string }>;
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

  async updateStorageNodeReputation(id: string, reputation: number, status: string, consecutiveFails?: number): Promise<void> {
    // SECURITY: Use atomic SQL to prevent race conditions from concurrent validators.
    // The reputation value is applied as an absolute value clamped to [0, 100] at the DB level.
    const clampedRep = Math.max(0, Math.min(100, reputation));
    const updateData: any = {
      reputation: sql`GREATEST(0, LEAST(100, ${clampedRep}))`,
      status,
      lastSeen: new Date(),
    };
    if (consecutiveFails !== undefined) {
      updateData.consecutiveFails = consecutiveFails;
    }
    await db.update(storageNodes)
      .set(updateData)
      .where(eq(storageNodes.id, id));
  }

  async updateNodeEarnings(id: string, hbdAmount: number): Promise<void> {
    await db.update(storageNodes)
      .set({
        totalEarnedHbd: sql`COALESCE(${storageNodes.totalEarnedHbd}, 0) + ${hbdAmount}`
      })
      .where(eq(storageNodes.id, id));
  }

  async updateStorageNodeLastSeen(id: string): Promise<void> {
    await db.update(storageNodes)
      .set({ lastSeen: new Date() })
      .where(eq(storageNodes.id, id));
  }

  /**
   * Decay reputation for nodes inactive longer than `inactiveDays`.
   * Each day of inactivity costs `decayPerDay` rep points.
   * Returns the number of nodes affected.
   */
  async decayInactiveNodeReputation(inactiveDays: number, decayPerDay: number): Promise<number> {
    const cutoff = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000);
    // Atomic: reduce reputation by (days_inactive - threshold) * decayPerDay, clamped to [0, 100]
    // Only apply to active/probation nodes with rep > 0
    const result = await db.update(storageNodes)
      .set({
        reputation: sql`GREATEST(0, reputation - ${decayPerDay})`,
      })
      .where(
        and(
          lt(storageNodes.lastSeen, cutoff),
          sql`${storageNodes.reputation} > 0`,
          sql`${storageNodes.status} != 'banned'`
        )
      )
      .returning({ id: storageNodes.id });
    return result.length;
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

  async deleteFile(id: string): Promise<boolean> {
    // Delete contract events via subquery (fixes N+1)
    await db.execute(sql`DELETE FROM contract_events WHERE contract_id IN (SELECT id FROM storage_contracts WHERE file_id = ${id})`);

    // Parallel cascade deletes for independent tables
    await Promise.all([
      db.delete(fileChunks).where(eq(fileChunks.fileId, id)),
      db.delete(fileTags).where(eq(fileTags.fileId, id)),
      db.delete(transcodeJobs).where(eq(transcodeJobs.fileId, id)),
      db.delete(viewEvents).where(eq(viewEvents.fileId, id)),
      db.delete(storageContracts).where(eq(storageContracts.fileId, id)),
    ]);

    const result = await db.delete(files).where(eq(files.id, id)).returning();
    return result.length > 0;
  }

  async updateFileStatus(id: string, status: string, replicationCount: number, confidence: number): Promise<void> {
    await db.update(files)
      .set({ status, replicationCount, confidence })
      .where(eq(files.id, id));
  }

  async updateFileCid(id: string, newCid: string): Promise<void> {
    await db.update(files)
      .set({ cid: newCid })
      .where(eq(files.id, id));
  }

  async updateFileEarnings(id: string, hbdAmount: number): Promise<void> {
    await db.update(files)
      .set({ 
        earnedHbd: sql`COALESCE(${files.earnedHbd}, 0) + ${hbdAmount}` 
      })
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
    
    const blacklistedIds = blacklistedNodeIds.map((b: any) => b.nodeId);
    
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

  async updateStorageContractCid(id: string, newCid: string): Promise<void> {
    await db.update(storageContracts)
      .set({ fileCid: newCid })
      .where(eq(storageContracts.id, id));
  }

  async getStorageContractsByFileId(fileId: string): Promise<StorageContract[]> {
    return await db.select().from(storageContracts)
      .where(eq(storageContracts.fileId, fileId));
  }

  async getExpiredContracts(): Promise<StorageContract[]> {
    return await db.select().from(storageContracts)
      .where(and(
        eq(storageContracts.status, 'active'),
        lt(storageContracts.expiresAt, new Date())
      ));
  }

  /**
   * Get contracts that are active, funded (spent < budget), and not expired.
   * Used by PoA engine to select CIDs for challenge rounds.
   */
  async getActiveContractsForChallenge(): Promise<StorageContract[]> {
    return await db.select().from(storageContracts)
      .where(and(
        eq(storageContracts.status, 'active'),
        sql`CAST(${storageContracts.hbdSpent} AS DECIMAL) < CAST(${storageContracts.hbdBudget} AS DECIMAL)`,
        sql`${storageContracts.expiresAt} > NOW()`
      ))
      .orderBy(sql`RANDOM()`);
  }

  /**
   * Atomically deduct reward from contract budget.
   * Returns true if deduction succeeded (budget not exceeded), false otherwise.
   */
  async updateStorageContractSpent(id: string, amount: number): Promise<boolean> {
    const result = await db.update(storageContracts)
      .set({
        hbdSpent: sql`CAST(CAST(${storageContracts.hbdSpent} AS DECIMAL) + ${amount} AS TEXT)`,
      })
      .where(and(
        eq(storageContracts.id, id),
        sql`CAST(${storageContracts.hbdSpent} AS DECIMAL) + ${amount} <= CAST(${storageContracts.hbdBudget} AS DECIMAL)`
      ))
      .returning();
    return result.length > 0;
  }

  /**
   * Get contracts where hbdSpent >= hbdBudget (budget exhausted).
   */
  async getExhaustedContracts(): Promise<StorageContract[]> {
    return await db.select().from(storageContracts)
      .where(and(
        eq(storageContracts.status, 'active'),
        sql`CAST(${storageContracts.hbdSpent} AS DECIMAL) >= CAST(${storageContracts.hbdBudget} AS DECIMAL)`,
        sql`CAST(${storageContracts.hbdBudget} AS DECIMAL) > 0`
      ));
  }

  /**
   * Get contract by CID (for PoA engine to look up reward).
   */
  async getActiveContractByCid(cid: string): Promise<StorageContract | undefined> {
    const [contract] = await db.select().from(storageContracts)
      .where(and(
        eq(storageContracts.fileCid, cid),
        eq(storageContracts.status, 'active'),
        sql`CAST(${storageContracts.hbdSpent} AS DECIMAL) < CAST(${storageContracts.hbdBudget} AS DECIMAL)`,
        sql`${storageContracts.expiresAt} > NOW()`
      ))
      .limit(1);
    return contract || undefined;
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

  async getMarketplaceEncoders(quality: string, sortBy: string): Promise<EncoderNode[]> {
    let orderClause;
    if (sortBy === "price") {
      // Sort by price for the specific quality
      const priceColumn = quality === "1080p" ? encoderNodes.price1080p :
                          quality === "720p" ? encoderNodes.price720p :
                          quality === "480p" ? encoderNodes.price480p :
                          encoderNodes.priceAllQualities;
      orderClause = priceColumn;
    } else {
      // Default: sort by reputation (higher is better)
      orderClause = desc(encoderNodes.reputationScore);
    }
    
    return await db.select().from(encoderNodes)
      .where(and(
        eq(encoderNodes.status, "active"),
        eq(encoderNodes.availability, "available"),
        eq(encoderNodes.encoderType, "community")
      ))
      .orderBy(orderClause);
  }

  // ============================================================
  // Phase 7: Encoding Jobs & Offers
  // ============================================================
  async createEncodingJob(job: InsertEncodingJob): Promise<EncodingJob> {
    const [created] = await db.insert(encodingJobs).values(job).returning();
    return created;
  }

  async updateEncodingJob(id: string, updates: Partial<EncodingJob>): Promise<void> {
    await db.update(encodingJobs).set(updates).where(eq(encodingJobs.id, id));
  }

  async createEncodingJobOffer(offer: InsertEncodingJobOffer): Promise<EncodingJobOffer> {
    const [created] = await db.insert(encodingJobOffers).values(offer).returning();
    return created;
  }

  async getEncodingJobOffers(status: string): Promise<EncodingJobOffer[]> {
    return await db.select().from(encodingJobOffers)
      .where(eq(encodingJobOffers.status, status))
      .orderBy(desc(encodingJobOffers.createdAt));
  }

  async acceptEncodingJobOffer(id: string, encoderId: string): Promise<EncodingJobOffer | undefined> {
    const [updated] = await db.update(encodingJobOffers)
      .set({
        status: "accepted",
        acceptedEncoderId: encoderId,
        acceptedAt: new Date(),
      })
      .where(and(
        eq(encodingJobOffers.id, id),
        eq(encodingJobOffers.status, "pending")
      ))
      .returning();
    return updated || undefined;
  }

  async getUserEncodingOffers(username: string): Promise<EncodingJobOffer[]> {
    return await db.select().from(encodingJobOffers)
      .where(eq(encodingJobOffers.owner, username))
      .orderBy(desc(encodingJobOffers.createdAt));
  }

  async cancelEncodingJobOffer(id: string, username: string): Promise<boolean> {
    const [updated] = await db.update(encodingJobOffers)
      .set({ status: "cancelled" })
      .where(and(
        eq(encodingJobOffers.id, id),
        eq(encodingJobOffers.owner, username),
        eq(encodingJobOffers.status, "pending")
      ))
      .returning();
    return !!updated;
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

  // ============================================================
  // Phase 5: Wallet Deposits
  // ============================================================
  async createWalletDeposit(deposit: InsertWalletDeposit): Promise<WalletDeposit> {
    const [created] = await db.insert(walletDeposits).values(deposit).returning();
    return created;
  }

  async getWalletDeposits(limit: number): Promise<WalletDeposit[]> {
    return await db.select().from(walletDeposits)
      .orderBy(desc(walletDeposits.createdAt))
      .limit(limit);
  }

  async getWalletDepositsByUser(username: string): Promise<WalletDeposit[]> {
    return await db.select().from(walletDeposits)
      .where(eq(walletDeposits.fromUsername, username))
      .orderBy(desc(walletDeposits.createdAt));
  }

  async getUnprocessedDeposits(): Promise<WalletDeposit[]> {
    return await db.select().from(walletDeposits)
      .where(eq(walletDeposits.processed, false))
      .orderBy(desc(walletDeposits.createdAt));
  }

  async markDepositProcessed(id: string): Promise<void> {
    await db.update(walletDeposits)
      .set({ processed: true })
      .where(eq(walletDeposits.id, id));
  }

  async getWalletBalance(): Promise<{ totalDeposits: string; totalPaid: string; available: string }> {
    const depositsResult = await db.select({
      total: sql<string>`COALESCE(SUM(CAST(${walletDeposits.hbdAmount} AS DECIMAL)), 0)::TEXT`
    }).from(walletDeposits);

    const paidResult = await db.select({
      total: sql<string>`COALESCE(SUM(CAST(${payoutLineItems.hbdAmount} AS DECIMAL)), 0)::TEXT`
    }).from(payoutLineItems)
      .where(eq(payoutLineItems.paid, true));

    const totalDeposits = depositsResult[0]?.total || "0";
    const totalPaid = paidResult[0]?.total || "0";
    const available = (parseFloat(totalDeposits) - parseFloat(totalPaid)).toFixed(3);

    return { totalDeposits, totalPaid, available };
  }

  // ============================================================
  // Phase 5: Payout Reports
  // ============================================================
  async createPayoutReport(report: InsertPayoutReport): Promise<PayoutReport> {
    const [created] = await db.insert(payoutReports).values(report).returning();
    return created;
  }

  async getPayoutReport(id: string): Promise<PayoutReport | undefined> {
    const [report] = await db.select().from(payoutReports).where(eq(payoutReports.id, id));
    return report || undefined;
  }

  async getPayoutReports(limit: number): Promise<PayoutReport[]> {
    return await db.select().from(payoutReports)
      .orderBy(desc(payoutReports.createdAt))
      .limit(limit);
  }

  async getPayoutReportsByValidator(validatorUsername: string): Promise<PayoutReport[]> {
    return await db.select().from(payoutReports)
      .where(eq(payoutReports.validatorUsername, validatorUsername))
      .orderBy(desc(payoutReports.createdAt));
  }

  async updatePayoutReportStatus(id: string, status: string, executedTxHash?: string): Promise<void> {
    const updateData: any = { status };
    if (status === 'executed') {
      updateData.executedAt = new Date();
    }
    if (executedTxHash) {
      updateData.executedTxHash = executedTxHash;
    }
    await db.update(payoutReports)
      .set(updateData)
      .where(eq(payoutReports.id, id));
  }

  async getOverlappingPayoutReports(periodStart: Date, periodEnd: Date): Promise<PayoutReport[]> {
    // Find any non-rejected reports whose period overlaps [periodStart, periodEnd]
    return await db.select().from(payoutReports)
      .where(and(
        lt(payoutReports.periodStart, periodEnd),
        gte(payoutReports.periodEnd, periodStart),
        sql`${payoutReports.status} != 'rejected'`,
      ));
  }

  // ============================================================
  // Phase 5: Payout Line Items
  // ============================================================
  async createPayoutLineItem(item: InsertPayoutLineItem): Promise<PayoutLineItem> {
    const [created] = await db.insert(payoutLineItems).values(item).returning();
    return created;
  }

  async createPayoutLineItems(items: InsertPayoutLineItem[]): Promise<PayoutLineItem[]> {
    if (items.length === 0) return [];
    return await db.insert(payoutLineItems).values(items).returning();
  }

  async getPayoutLineItems(reportId: string): Promise<PayoutLineItem[]> {
    return await db.select().from(payoutLineItems)
      .where(eq(payoutLineItems.reportId, reportId))
      .orderBy(desc(sql`CAST(${payoutLineItems.hbdAmount} AS DECIMAL)`));
  }

  async markLineItemPaid(id: string, txHash: string): Promise<void> {
    await db.update(payoutLineItems)
      .set({ paid: true, txHash })
      .where(eq(payoutLineItems.id, id));
  }

  async getPoaDataForPayout(startDate: Date, endDate: Date): Promise<{ username: string; proofCount: number; successRate: number; totalHbd: string }[]> {
    const results = await db.select({
      hiveUsername: storageNodes.hiveUsername,
      successCount: sql<number>`COUNT(CASE WHEN ${poaChallenges.result} = 'success' THEN 1 END)::INTEGER`,
      totalCount: sql<number>`COUNT(*)::INTEGER`,
    })
    .from(poaChallenges)
    .innerJoin(storageNodes, eq(poaChallenges.nodeId, storageNodes.id))
    .where(and(
      gte(poaChallenges.createdAt, startDate),
      lte(poaChallenges.createdAt, endDate)
    ))
    .groupBy(storageNodes.hiveUsername);

    const HBD_PER_PROOF = 0.001;

    return results.map((r: any) => ({
      username: r.hiveUsername,
      proofCount: r.successCount,
      successRate: r.totalCount > 0 ? (r.successCount / r.totalCount) * 100 : 0,
      totalHbd: (r.successCount * HBD_PER_PROOF).toFixed(3)
    }));
  }

  // ============================================================
  // Phase 6: P2P Sessions
  // ============================================================
  async createP2pSession(session: InsertP2pSession): Promise<P2pSession> {
    const [created] = await db.insert(p2pSessions).values(session).returning();
    return created;
  }

  async getP2pSession(id: string): Promise<P2pSession | undefined> {
    const [session] = await db.select().from(p2pSessions).where(eq(p2pSessions.id, id));
    return session || undefined;
  }

  async getP2pSessionByPeerId(peerId: string): Promise<P2pSession | undefined> {
    const [session] = await db.select().from(p2pSessions)
      .where(and(eq(p2pSessions.peerId, peerId), eq(p2pSessions.status, 'active')));
    return session || undefined;
  }

  async getActiveP2pSessions(roomId?: string): Promise<P2pSession[]> {
    if (roomId) {
      return await db.select().from(p2pSessions)
        .where(and(eq(p2pSessions.roomId, roomId), eq(p2pSessions.status, 'active')));
    }
    return await db.select().from(p2pSessions)
      .where(eq(p2pSessions.status, 'active'));
  }

  async updateP2pSessionStats(
    id: string, 
    bytesUploaded: number, 
    bytesDownloaded: number, 
    segmentsShared: number, 
    peersConnected: number
  ): Promise<void> {
    await db.update(p2pSessions)
      .set({ 
        bytesUploaded, 
        bytesDownloaded, 
        segmentsShared, 
        peersConnected,
        lastActiveAt: new Date()
      })
      .where(eq(p2pSessions.id, id));
  }

  async disconnectP2pSession(id: string): Promise<void> {
    await db.update(p2pSessions)
      .set({ status: 'disconnected', disconnectedAt: new Date() })
      .where(eq(p2pSessions.id, id));
  }

  async cleanupStaleSessions(): Promise<number> {
    const staleThreshold = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes
    const result = await db.update(p2pSessions)
      .set({ status: 'disconnected', disconnectedAt: new Date() })
      .where(and(
        eq(p2pSessions.status, 'active'),
        lt(p2pSessions.lastActiveAt, staleThreshold)
      ));
    return 0; // Drizzle doesn't return affected count easily
  }

  // ============================================================
  // Phase 6: P2P Contributions
  // ============================================================
  async createP2pContribution(contribution: InsertP2pContribution): Promise<P2pContribution> {
    const [created] = await db.insert(p2pContributions).values(contribution).returning();
    return created;
  }

  async getP2pContributionsByPeerId(peerId: string): Promise<P2pContribution[]> {
    return await db.select().from(p2pContributions)
      .where(eq(p2pContributions.peerId, peerId))
      .orderBy(desc(p2pContributions.createdAt));
  }

  async getP2pContributionsByUsername(hiveUsername: string): Promise<P2pContribution[]> {
    return await db.select().from(p2pContributions)
      .where(eq(p2pContributions.hiveUsername, hiveUsername))
      .orderBy(desc(p2pContributions.createdAt));
  }

  async getTopContributors(limit: number): Promise<{ hiveUsername: string; totalBytesShared: number; totalSegments: number }[]> {
    const results = await db.select({
      hiveUsername: p2pContributions.hiveUsername,
      totalBytesShared: sql<number>`SUM(${p2pContributions.bytesShared})::INTEGER`,
      totalSegments: sql<number>`SUM(${p2pContributions.segmentsShared})::INTEGER`,
    })
    .from(p2pContributions)
    .where(sql`${p2pContributions.hiveUsername} IS NOT NULL`)
    .groupBy(p2pContributions.hiveUsername)
    .orderBy(desc(sql`SUM(${p2pContributions.bytesShared})`))
    .limit(limit);

    return results.map((r: any) => ({
      hiveUsername: r.hiveUsername || '',
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

    const [created] = await db.insert(p2pRooms)
      .values({ videoCid, activePeers: 0, totalBytesShared: 0 })
      .returning();
    return created;
  }

  async getP2pRoom(id: string): Promise<P2pRoom | undefined> {
    const [room] = await db.select().from(p2pRooms).where(eq(p2pRooms.id, id));
    return room || undefined;
  }

  async getP2pRoomByCid(videoCid: string): Promise<P2pRoom | undefined> {
    const [room] = await db.select().from(p2pRooms).where(eq(p2pRooms.videoCid, videoCid));
    return room || undefined;
  }

  async updateP2pRoomStats(id: string, activePeers: number, bytesShared: number): Promise<void> {
    await db.update(p2pRooms)
      .set({ 
        activePeers, 
        totalBytesShared: sql`${p2pRooms.totalBytesShared} + ${bytesShared}`,
        lastActivityAt: new Date()
      })
      .where(eq(p2pRooms.id, id));
  }

  async getActiveP2pRooms(): Promise<P2pRoom[]> {
    return await db.select().from(p2pRooms)
      .where(sql`${p2pRooms.activePeers} > 0`)
      .orderBy(desc(p2pRooms.activePeers));
  }

  // ============================================================
  // Phase 6: P2P Network Stats
  // ============================================================
  async createP2pNetworkStats(stats: InsertP2pNetworkStats): Promise<P2pNetworkStats> {
    const [created] = await db.insert(p2pNetworkStats).values(stats).returning();
    return created;
  }

  async getP2pNetworkStats(limit: number): Promise<P2pNetworkStats[]> {
    return await db.select().from(p2pNetworkStats)
      .orderBy(desc(p2pNetworkStats.timestamp))
      .limit(limit);
  }

  async getCurrentP2pNetworkStats(): Promise<{ activePeers: number; activeRooms: number; totalBytesShared: number; avgP2pRatio: number }> {
    const activeSessions = await db.select({ count: sql<number>`COUNT(*)::INTEGER` })
      .from(p2pSessions)
      .where(eq(p2pSessions.status, 'active'));

    const activeRooms = await db.select({ count: sql<number>`COUNT(*)::INTEGER` })
      .from(p2pRooms)
      .where(sql`${p2pRooms.activePeers} > 0`);

    const totalShared = await db.select({ sum: sql<number>`COALESCE(SUM(${p2pContributions.bytesShared}), 0)::INTEGER` })
      .from(p2pContributions);

    const avgRatio = await db.select({ avg: sql<number>`COALESCE(AVG(${p2pContributions.p2pRatio}), 0)::REAL` })
      .from(p2pContributions);

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
    const results = await db.select({
      hour: sql<number>`EXTRACT(HOUR FROM ${poaChallenges.createdAt})::INTEGER`,
      successCount: sql<number>`COUNT(CASE WHEN ${poaChallenges.result} = 'success' THEN 1 END)::INTEGER`,
      failCount: sql<number>`COUNT(CASE WHEN ${poaChallenges.result} = 'fail' THEN 1 END)::INTEGER`,
      totalCount: sql<number>`COUNT(*)::INTEGER`,
      avgLatency: sql<number>`COALESCE(AVG(${poaChallenges.latencyMs}), 0)::INTEGER`,
    })
    .from(poaChallenges)
    .where(gte(poaChallenges.createdAt, since))
    .groupBy(sql`EXTRACT(HOUR FROM ${poaChallenges.createdAt})`)
    .orderBy(sql`EXTRACT(HOUR FROM ${poaChallenges.createdAt})`);

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
    const results = await db.select({
      totalCount: sql<number>`COUNT(*)::INTEGER`,
      successCount: sql<number>`COUNT(CASE WHEN ${poaChallenges.result} = 'success' THEN 1 END)::INTEGER`,
      avgLatency: sql<number>`COALESCE(AVG(${poaChallenges.latencyMs}), 0)::INTEGER`,
      minLatency: sql<number>`COALESCE(MIN(${poaChallenges.latencyMs}), 0)::INTEGER`,
      maxLatency: sql<number>`COALESCE(MAX(${poaChallenges.latencyMs}), 0)::INTEGER`,
    })
    .from(poaChallenges)
    .where(gte(poaChallenges.createdAt, since));

    const row = results[0];
    return {
      totalChallenges: row?.totalCount || 0,
      successRate: row?.totalCount ? (row.successCount / row.totalCount) * 100 : 0,
      avgLatency: row?.avgLatency || 0,
      minLatency: row?.minLatency || 0,
      maxLatency: row?.maxLatency || 0,
    };
  }

  async getNodeHealthSummary(): Promise<{ active: number; probation: number; banned: number; total: number }> {
    const results = await db.select({
      status: storageNodes.status,
      count: sql<number>`COUNT(*)::INTEGER`,
    })
    .from(storageNodes)
    .groupBy(storageNodes.status);

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
    const results = await db.select({
      totalViews: sql<number>`COUNT(*)::INTEGER`,
      completedViews: sql<number>`COUNT(CASE WHEN ${viewEvents.completed} = true THEN 1 END)::INTEGER`,
      pinnedContent: sql<number>`COUNT(CASE WHEN ${viewEvents.autoPinTriggered} = true THEN 1 END)::INTEGER`,
    })
    .from(viewEvents)
    .where(eq(viewEvents.viewerUsername, username));

    const row = results[0];
    return {
      totalViews: row?.totalViews || 0,
      completedViews: row?.completedViews || 0,
      pinnedContent: row?.pinnedContent || 0,
    };
  }

  async getRecentNodeLogs(limit: number = 50): Promise<{ timestamp: Date; level: string; message: string; source: string }[]> {
    const challenges = await db.select({
      createdAt: poaChallenges.createdAt,
      result: poaChallenges.result,
      latencyMs: poaChallenges.latencyMs,
      hiveUsername: storageNodes.hiveUsername,
    })
    .from(poaChallenges)
    .innerJoin(storageNodes, eq(poaChallenges.nodeId, storageNodes.id))
    .orderBy(desc(poaChallenges.createdAt))
    .limit(limit);

    return challenges.map((c: any) => ({
      timestamp: c.createdAt,
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
    const [fileStats, nodeStats, validatorStats, challengeStats, rewardStats, cdnStats, contractStats, encoderStats] = await Promise.all([
      db.execute(sql`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'pinned') as pinned, COUNT(*) FILTER (WHERE status = 'syncing') as syncing FROM files`),
      db.execute(sql`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'active') as active, COUNT(*) FILTER (WHERE status = 'probation') as probation, COUNT(*) FILTER (WHERE status = 'banned') as banned FROM storage_nodes`),
      db.execute(sql`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'online') as online FROM validators`),
      db.execute(sql`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE result = 'success') as success, COUNT(*) FILTER (WHERE result = 'fail') as failed FROM poa_challenges WHERE created_at > NOW() - INTERVAL '7 days'`),
      db.execute(sql`SELECT COUNT(*) as total FROM hive_transactions WHERE type = 'hbd_transfer' AND created_at > NOW() - INTERVAL '24 hours'`),
      db.execute(sql`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'active') as active FROM cdn_nodes`),
      db.execute(sql`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'active') as active FROM storage_contracts`),
      db.execute(sql`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE availability = 'available') as available FROM encoder_nodes`),
    ]);

    const f = fileStats.rows[0] as any;
    const n = nodeStats.rows[0] as any;
    const v = validatorStats.rows[0] as any;
    const c = challengeStats.rows[0] as any;
    const r = rewardStats.rows[0] as any;
    const cd = cdnStats.rows[0] as any;
    const co = contractStats.rows[0] as any;
    const en = encoderStats.rows[0] as any;

    const success = Number(c.success) || 0;
    const failed = Number(c.failed) || 0;
    const successRate = success + failed > 0 ? (success / (success + failed) * 100).toFixed(1) : "0.0";
    const hbdTxCount = Number(r.total) || 0;

    return {
      files: { total: Number(f.total), pinned: Number(f.pinned), syncing: Number(f.syncing) },
      nodes: { total: Number(n.total), active: Number(n.active), probation: Number(n.probation), banned: Number(n.banned) },
      validators: { total: Number(v.total), online: Number(v.online) },
      challenges: { total: Number(c.total), success, failed, successRate },
      rewards: { totalHBD: (hbdTxCount * 0.001).toFixed(3), transactions: hbdTxCount },
      cdn: { total: Number(cd.total), active: Number(cd.active) },
      contracts: { total: Number(co.total), active: Number(co.active) },
      encoders: { total: Number(en.total), available: Number(en.available) },
    };
  }

  async getStorageNodeByUsername(username: string): Promise<StorageNode | undefined> {
    const [node] = await db.select().from(storageNodes).where(eq(storageNodes.hiveUsername, username)).limit(1);
    return node;
  }

  async getNodeChallenges(nodeId: string, limit: number): Promise<PoaChallenge[]> {
    return db.select().from(poaChallenges).where(eq(poaChallenges.nodeId, nodeId)).orderBy(desc(poaChallenges.createdAt)).limit(limit);
  }

  async getNodeEarnings(nodeUsername: string): Promise<number> {
    const result = await db.execute(sql`SELECT COUNT(*) as cnt FROM hive_transactions WHERE to_user = ${nodeUsername} AND type = 'hbd_transfer' AND created_at > NOW() - INTERVAL '7 days'`);
    return (Number((result.rows[0] as any).cnt) || 0) * 0.001;
  }

  async getMarketplaceFiles(): Promise<any[]> {
    const result = await db.execute(sql`
      SELECT
        f.id, f.name, f.cid, f.size, f.status, f.replication_count, f.earned_hbd,
        COUNT(pc.id) as challenge_count,
        COUNT(pc.id) FILTER (WHERE pc.result = 'success') as success_count
      FROM files f
      LEFT JOIN poa_challenges pc ON pc.file_id = f.id AND pc.created_at > NOW() - INTERVAL '7 days'
      GROUP BY f.id
      ORDER BY f.created_at DESC
    `);
    return result.rows as any[];
  }

  // Paginated queries
  async getFilesPaginated(limit: number, offset: number): Promise<{ data: File[]; total: number }> {
    const [data, countResult] = await Promise.all([
      db.select().from(files).orderBy(desc(files.createdAt)).limit(limit).offset(offset),
      db.execute(sql`SELECT COUNT(*) as total FROM files`),
    ]);
    return { data, total: Number((countResult.rows[0] as any).total) };
  }

  async getNodesPaginated(limit: number, offset: number): Promise<{ data: StorageNode[]; total: number }> {
    const [data, countResult] = await Promise.all([
      db.select().from(storageNodes).orderBy(desc(storageNodes.reputation)).limit(limit).offset(offset),
      db.execute(sql`SELECT COUNT(*) as total FROM storage_nodes`),
    ]);
    return { data, total: Number((countResult.rows[0] as any).total) };
  }

  async getChallengesPaginated(limit: number, offset: number): Promise<{ data: PoaChallenge[]; total: number }> {
    const [data, countResult] = await Promise.all([
      db.select().from(poaChallenges).orderBy(desc(poaChallenges.createdAt)).limit(limit).offset(offset),
      db.execute(sql`SELECT COUNT(*) as total FROM poa_challenges`),
    ]);
    return { data, total: Number((countResult.rows[0] as any).total) };
  }

  async getTransactionsPaginated(limit: number, offset: number): Promise<{ data: HiveTransaction[]; total: number }> {
    const [data, countResult] = await Promise.all([
      db.select().from(hiveTransactions).orderBy(desc(hiveTransactions.createdAt)).limit(limit).offset(offset),
      db.execute(sql`SELECT COUNT(*) as total FROM hive_transactions`),
    ]);
    return { data, total: Number((countResult.rows[0] as any).total) };
  }

  // User session CRUD (persistent, replaces in-memory Map)
  async createSession(token: string, username: string, expiresAt: Date, role: string = "user", validatorOptedIn?: boolean | null): Promise<void> {
    await db.insert(userSessions).values({ token, username, expiresAt, role, validatorOptedIn: validatorOptedIn ?? null });
  }

  async getSession(token: string): Promise<{ username: string; expiresAt: Date; role: string; validatorOptedIn: boolean | null } | undefined> {
    const [row] = await db.select().from(userSessions).where(eq(userSessions.token, token)).limit(1);
    if (!row) return undefined;
    return { username: row.username, expiresAt: row.expiresAt, role: row.role, validatorOptedIn: row.validatorOptedIn };
  }

  async updateSessionValidatorOptIn(token: string, optedIn: boolean): Promise<void> {
    await db.update(userSessions).set({ validatorOptedIn: optedIn }).where(eq(userSessions.token, token));
  }

  async deleteSession(token: string): Promise<void> {
    await db.delete(userSessions).where(eq(userSessions.token, token));
  }

  async cleanExpiredSessions(): Promise<void> {
    await db.delete(userSessions).where(lt(userSessions.expiresAt, new Date()));
  }

  // Agent API Key CRUD
  async createAgentKey(apiKey: string, hiveUsername: string, label?: string): Promise<void> {
    await db.insert(agentKeys).values({ apiKey, hiveUsername, label });
  }

  async getAgentByKey(apiKey: string): Promise<{ hiveUsername: string; id: string } | undefined> {
    const [row] = await db.select().from(agentKeys).where(eq(agentKeys.apiKey, apiKey)).limit(1);
    if (!row) return undefined;
    // Update last used timestamp
    await db.update(agentKeys).set({ lastUsedAt: new Date() }).where(eq(agentKeys.id, row.id));
    return { hiveUsername: row.hiveUsername, id: row.id };
  }

  async deleteAgentKey(id: string): Promise<void> {
    await db.delete(agentKeys).where(eq(agentKeys.id, id));
  }

  // File Refs — IPFS sub-block CID lists for lightweight PoA verification
  async getFileRefs(cid: string): Promise<string[] | null> {
    const [row] = await db.select().from(fileRefs).where(eq(fileRefs.cid, cid)).limit(1);
    if (!row) return null;
    try { return JSON.parse(row.blockCids); } catch { return null; }
  }

  async saveFileRefs(cid: string, blockCids: string[]): Promise<void> {
    const json = JSON.stringify(blockCids);
    // Upsert: insert or update if CID already exists
    await db.execute(sql`
      INSERT INTO file_refs (id, cid, block_cids, block_count, synced_at)
      VALUES (gen_random_uuid(), ${cid}, ${json}, ${blockCids.length}, NOW())
      ON CONFLICT (cid) DO UPDATE SET block_cids = ${json}, block_count = ${blockCids.length}, synced_at = NOW()
    `);
  }

  async hasFileRefs(cid: string): Promise<boolean> {
    const result = await db.execute(sql`SELECT 1 FROM file_refs WHERE cid = ${cid} LIMIT 1`);
    return result.rows.length > 0;
  }

  // ============================================================
  // Phase 7: Web of Trust
  // ============================================================
  async getActiveVouch(sponsorUsername: string): Promise<WebOfTrust | undefined> {
    const [row] = await db.select().from(webOfTrust)
      .where(and(eq(webOfTrust.sponsorUsername, sponsorUsername), eq(webOfTrust.active, true)))
      .limit(1);
    return row || undefined;
  }

  async getVouchForUser(vouchedUsername: string): Promise<WebOfTrust | undefined> {
    const [row] = await db.select().from(webOfTrust)
      .where(and(eq(webOfTrust.vouchedUsername, vouchedUsername), eq(webOfTrust.active, true)))
      .limit(1);
    return row || undefined;
  }

  async getAllActiveVouches(): Promise<WebOfTrust[]> {
    return await db.select().from(webOfTrust)
      .where(eq(webOfTrust.active, true))
      .orderBy(desc(webOfTrust.createdAt));
  }

  async createVouch(vouch: InsertWebOfTrust): Promise<WebOfTrust> {
    const [created] = await db.insert(webOfTrust).values(vouch).returning();
    return created;
  }

  async revokeVouch(sponsorUsername: string, reason: string): Promise<void> {
    await db.update(webOfTrust)
      .set({ active: false, revokedAt: new Date(), revokeReason: reason })
      .where(and(eq(webOfTrust.sponsorUsername, sponsorUsername), eq(webOfTrust.active, true)));
  }

  async isVouchedValidator(username: string): Promise<boolean> {
    const vouch = await this.getVouchForUser(username);
    return !!vouch;
  }

  // ============================================================
  // Phase 8: Multisig Treasury — Signers
  // ============================================================
  async createTreasurySigner(signer: InsertTreasurySigner): Promise<TreasurySigner> {
    const [created] = await db.insert(treasurySigners).values(signer).returning();
    return created;
  }

  async getTreasurySignerByUsername(username: string): Promise<TreasurySigner | undefined> {
    const [row] = await db.select().from(treasurySigners)
      .where(eq(treasurySigners.username, username))
      .limit(1);
    return row || undefined;
  }

  async getActiveTreasurySigners(): Promise<TreasurySigner[]> {
    return await db.select().from(treasurySigners)
      .where(eq(treasurySigners.status, "active"))
      .orderBy(desc(treasurySigners.joinedAt));
  }

  async updateSignerStatus(username: string, status: string, extra?: Partial<TreasurySigner>): Promise<void> {
    await db.update(treasurySigners)
      .set({ status, ...extra })
      .where(eq(treasurySigners.username, username));
  }

  async updateSignerHeartbeat(username: string): Promise<void> {
    await db.update(treasurySigners)
      .set({ lastHeartbeat: new Date() })
      .where(eq(treasurySigners.username, username));
  }

  // ============================================================
  // Phase 8: Multisig Treasury — Vouches (WoT extension)
  // ============================================================
  async createTreasuryVouch(vouch: InsertTreasuryVouch): Promise<TreasuryVouch> {
    const [created] = await db.insert(treasuryVouches).values(vouch).returning();
    return created;
  }

  async getActiveVouchesForCandidate(candidateUsername: string): Promise<TreasuryVouch[]> {
    return await db.select().from(treasuryVouches)
      .where(and(eq(treasuryVouches.candidateUsername, candidateUsername), eq(treasuryVouches.active, true)))
      .orderBy(desc(treasuryVouches.createdAt));
  }

  async getActiveVouchesByVoucher(voucherUsername: string): Promise<TreasuryVouch[]> {
    return await db.select().from(treasuryVouches)
      .where(and(eq(treasuryVouches.voucherUsername, voucherUsername), eq(treasuryVouches.active, true)));
  }

  async getAllActiveTreasuryVouches(): Promise<TreasuryVouch[]> {
    return await db.select().from(treasuryVouches)
      .where(eq(treasuryVouches.active, true))
      .orderBy(desc(treasuryVouches.createdAt));
  }

  async revokeTreasuryVouch(voucherUsername: string, candidateUsername: string, reason: string): Promise<void> {
    await db.update(treasuryVouches)
      .set({ active: false, revokedAt: new Date(), revokeReason: reason })
      .where(and(
        eq(treasuryVouches.voucherUsername, voucherUsername),
        eq(treasuryVouches.candidateUsername, candidateUsername),
        eq(treasuryVouches.active, true),
      ));
  }

  async revokeTreasuryVouchesByVoucher(voucherUsername: string, reason: string): Promise<void> {
    await db.update(treasuryVouches)
      .set({ active: false, revokedAt: new Date(), revokeReason: reason })
      .where(and(eq(treasuryVouches.voucherUsername, voucherUsername), eq(treasuryVouches.active, true)));
  }

  async countActiveVouchesForCandidate(candidateUsername: string): Promise<number> {
    const vouches = await this.getActiveVouchesForCandidate(candidateUsername);
    return vouches.length;
  }

  // ============================================================
  // Phase 8: Multisig Treasury — Transactions
  // ============================================================
  async createTreasuryTransaction(tx: InsertTreasuryTransaction): Promise<TreasuryTransaction> {
    const [created] = await db.insert(treasuryTransactions).values(tx).returning();
    return created;
  }

  async getTreasuryTransaction(id: string): Promise<TreasuryTransaction | undefined> {
    const [row] = await db.select().from(treasuryTransactions)
      .where(eq(treasuryTransactions.id, id))
      .limit(1);
    return row || undefined;
  }

  async getRecentTreasuryTransactions(limit: number = 50): Promise<TreasuryTransaction[]> {
    return await db.select().from(treasuryTransactions)
      .orderBy(desc(treasuryTransactions.createdAt))
      .limit(limit);
  }

  async updateTreasuryTxSignature(id: string, username: string, signature: string): Promise<void> {
    const tx = await this.getTreasuryTransaction(id);
    if (!tx) return;
    const sigs = (tx.signatures as Record<string, string>) || {};
    sigs[username] = signature;
    await db.update(treasuryTransactions)
      .set({ signatures: sigs, status: "signing" })
      .where(eq(treasuryTransactions.id, id));
  }

  async updateTreasuryTxStatus(id: string, status: string, broadcastTxId?: string): Promise<void> {
    const update: any = { status };
    if (broadcastTxId) update.broadcastTxId = broadcastTxId;
    await db.update(treasuryTransactions)
      .set(update)
      .where(eq(treasuryTransactions.id, id));
  }

  // ============================================================
  // Content Moderation
  // ============================================================

  async createContentFlag(flag: InsertContentFlag): Promise<ContentFlag> {
    const [created] = await db.insert(contentFlags).values(flag).returning();
    return created;
  }

  async getContentFlags(status?: string): Promise<ContentFlag[]> {
    if (status) {
      return db.select().from(contentFlags)
        .where(eq(contentFlags.status, status))
        .orderBy(desc(contentFlags.createdAt));
    }
    return db.select().from(contentFlags).orderBy(desc(contentFlags.createdAt));
  }

  async getContentFlagsByCid(cid: string): Promise<ContentFlag[]> {
    return db.select().from(contentFlags)
      .where(eq(contentFlags.cid, cid))
      .orderBy(desc(contentFlags.createdAt));
  }

  async getContentFlagById(id: string): Promise<ContentFlag | undefined> {
    const [flag] = await db.select().from(contentFlags).where(eq(contentFlags.id, id));
    return flag;
  }

  async updateContentFlagStatus(id: string, status: string, reviewedBy: string): Promise<void> {
    await db.update(contentFlags)
      .set({ status, reviewedBy, reviewedAt: new Date() })
      .where(eq(contentFlags.id, id));
  }

  async incrementFlagCount(cid: string, reason: string): Promise<ContentFlag> {
    // Check if there's an existing pending flag for this CID + reason
    const [existing] = await db.select().from(contentFlags)
      .where(and(
        eq(contentFlags.cid, cid),
        eq(contentFlags.reason, reason),
        eq(contentFlags.status, "pending")
      ));
    if (existing) {
      await db.update(contentFlags)
        .set({ flagCount: existing.flagCount + 1 })
        .where(eq(contentFlags.id, existing.id));
      return { ...existing, flagCount: existing.flagCount + 1 };
    }
    // Should not reach here — caller should create first
    throw new Error("No pending flag found for this CID and reason");
  }

  async getFlaggedContentSummary(): Promise<{ cid: string; totalFlags: number; reasons: string[]; maxSeverity: string; status: string }[]> {
    const allFlags = await db.select().from(contentFlags).orderBy(desc(contentFlags.flagCount));
    const grouped = new Map<string, { totalFlags: number; reasons: Set<string>; maxSeverity: string; status: string }>();
    const severityOrder = ["low", "moderate", "severe", "critical"];

    for (const flag of allFlags) {
      const existing = grouped.get(flag.cid);
      if (existing) {
        existing.totalFlags += flag.flagCount;
        existing.reasons.add(flag.reason);
        if (severityOrder.indexOf(flag.severity) > severityOrder.indexOf(existing.maxSeverity)) {
          existing.maxSeverity = flag.severity;
        }
        // Worst status wins
        if (flag.status === "pending" || existing.status === "pending") existing.status = "pending";
      } else {
        grouped.set(flag.cid, {
          totalFlags: flag.flagCount,
          reasons: new Set([flag.reason]),
          maxSeverity: flag.severity,
          status: flag.status,
        });
      }
    }

    return Array.from(grouped.entries()).map(([cid, data]) => ({
      cid,
      totalFlags: data.totalFlags,
      reasons: Array.from(data.reasons),
      maxSeverity: data.maxSeverity,
      status: data.status,
    }));
  }

  async createUploaderBan(ban: InsertUploaderBan): Promise<UploaderBan> {
    const [created] = await db.insert(uploaderBans).values(ban).returning();
    return created;
  }

  async getUploaderBans(bannedBy?: string): Promise<UploaderBan[]> {
    if (bannedBy) {
      return db.select().from(uploaderBans)
        .where(and(eq(uploaderBans.bannedBy, bannedBy), eq(uploaderBans.active, true)))
        .orderBy(desc(uploaderBans.createdAt));
    }
    return db.select().from(uploaderBans)
      .where(eq(uploaderBans.active, true))
      .orderBy(desc(uploaderBans.createdAt));
  }

  async isUploaderBanned(username: string, bannedBy?: string): Promise<boolean> {
    const conditions = [eq(uploaderBans.bannedUsername, username), eq(uploaderBans.active, true)];
    if (bannedBy) conditions.push(eq(uploaderBans.bannedBy, bannedBy));
    const [result] = await db.select().from(uploaderBans).where(and(...conditions)).limit(1);
    return !!result;
  }

  async removeUploaderBan(id: string): Promise<void> {
    await db.update(uploaderBans).set({ active: false }).where(eq(uploaderBans.id, id));
  }

  async getActiveBansForNode(nodeOperator: string): Promise<UploaderBan[]> {
    return db.select().from(uploaderBans)
      .where(and(
        eq(uploaderBans.bannedBy, nodeOperator),
        eq(uploaderBans.active, true)
      ))
      .orderBy(desc(uploaderBans.createdAt));
  }

  async createTreasuryAuditLog(entry: InsertTreasuryAuditLog): Promise<TreasuryAuditLog> {
    const [row] = await db.insert(treasuryAuditLog).values(entry).returning();
    return row;
  }

  async getRecentTreasuryAuditLogs(limit = 50): Promise<TreasuryAuditLog[]> {
    return db.select().from(treasuryAuditLog)
      .orderBy(desc(treasuryAuditLog.createdAt))
      .limit(limit);
  }

  // Treasury Freeze State
  async getTreasuryFreezeState(): Promise<any | undefined> {
    const [row] = await db.select().from(treasuryFreezeState).where(eq(treasuryFreezeState.id, "singleton")).limit(1);
    return row || undefined;
  }

  async setTreasuryFrozen(frozenBy: string, reason: string, unfreezeThreshold: number): Promise<void> {
    const existing = await this.getTreasuryFreezeState();
    if (existing) {
      await db.update(treasuryFreezeState).set({
        frozen: true, frozenBy, frozenAt: new Date(), reason, unfreezeThreshold,
        unfreezeVotes: [], updatedAt: new Date(),
      }).where(eq(treasuryFreezeState.id, "singleton"));
    } else {
      await db.insert(treasuryFreezeState).values({
        id: "singleton", frozen: true, frozenBy, frozenAt: new Date(), reason,
        unfreezeThreshold, unfreezeVotes: [], updatedAt: new Date(),
      });
    }
  }

  async addUnfreezeVote(username: string): Promise<{ frozen: boolean; voteCount: number; threshold: number }> {
    const state = await this.getTreasuryFreezeState();
    if (!state || !state.frozen) return { frozen: false, voteCount: 0, threshold: 0 };

    const votes: string[] = Array.isArray(state.unfreezeVotes) ? state.unfreezeVotes : [];
    if (!votes.includes(username)) votes.push(username);
    const threshold = state.unfreezeThreshold || 1;

    if (votes.length >= threshold) {
      await this.clearTreasuryFreeze();
      return { frozen: false, voteCount: votes.length, threshold };
    }
    await db.update(treasuryFreezeState).set({ unfreezeVotes: votes, updatedAt: new Date() })
      .where(eq(treasuryFreezeState.id, "singleton"));
    return { frozen: true, voteCount: votes.length, threshold };
  }

  async clearTreasuryFreeze(): Promise<void> {
    await db.update(treasuryFreezeState).set({
      frozen: false, frozenBy: null, frozenAt: null, unfreezeVotes: [], reason: null,
      unfreezeThreshold: null, updatedAt: new Date(),
    }).where(eq(treasuryFreezeState.id, "singleton"));
  }

  // Treasury Transaction Extensions (delay + veto)
  async updateTreasuryTxDelayed(id: string, broadcastAfter: Date, delaySeconds: number): Promise<void> {
    await db.update(treasuryTransactions).set({
      status: "delayed", broadcastAfter, delaySeconds,
    }).where(eq(treasuryTransactions.id, id));
  }

  async updateTreasuryTxSignatures(id: string, signatures: Record<string, string>): Promise<void> {
    await db.update(treasuryTransactions).set({ signatures })
      .where(eq(treasuryTransactions.id, id));
  }

  async updateTreasuryTransaction(id: string, fields: Partial<{ operationsJson: string; txDigest: string; status: string; expiresAt: Date }>): Promise<void> {
    await db.update(treasuryTransactions).set(fields).where(eq(treasuryTransactions.id, id));
  }

  async getDelayedTreasuryTransactions(): Promise<TreasuryTransaction[]> {
    return db.select().from(treasuryTransactions)
      .where(eq(treasuryTransactions.status, "delayed"));
  }

  // Anomaly Detection
  async hasReceivedTreasuryPayment(recipient: string): Promise<boolean> {
    const rows = await db.select({ id: treasuryTransactions.id })
      .from(treasuryTransactions)
      .where(and(
        eq(treasuryTransactions.status, "broadcast"),
        sql`metadata->>'recipient' = ${recipient}`,
      ))
      .limit(1);
    return rows.length > 0;
  }

  // ============================================================
  // Phase 10: GPU Compute Marketplace
  // ============================================================

  // --- Nodes ---
  async getComputeNode(id: string): Promise<ComputeNode | undefined> {
    const [node] = await db.select().from(computeNodes).where(eq(computeNodes.id, id));
    return node || undefined;
  }

  async getComputeNodeByInstanceId(instanceId: string): Promise<ComputeNode | undefined> {
    const [node] = await db.select().from(computeNodes).where(eq(computeNodes.nodeInstanceId, instanceId));
    return node || undefined;
  }

  async getComputeNodesByUsername(username: string): Promise<ComputeNode[]> {
    return db.select().from(computeNodes)
      .where(eq(computeNodes.hiveUsername, username))
      .orderBy(desc(computeNodes.lastHeartbeatAt));
  }

  async getAllComputeNodes(): Promise<ComputeNode[]> {
    return db.select().from(computeNodes).orderBy(desc(computeNodes.reputationScore));
  }

  async getAvailableComputeNodes(workloadType?: string, minVramGb?: number): Promise<ComputeNode[]> {
    const conditions = [
      eq(computeNodes.status, "online"),
    ];
    if (minVramGb) {
      conditions.push(gte(computeNodes.gpuVramGb, minVramGb));
    }
    const nodes = await db.select().from(computeNodes)
      .where(and(...conditions))
      .orderBy(desc(computeNodes.reputationScore));

    if (workloadType) {
      return nodes.filter((n: ComputeNode) => n.supportedWorkloads.split(",").includes(workloadType));
    }
    return nodes;
  }

  async createComputeNode(node: InsertComputeNode): Promise<ComputeNode> {
    const [created] = await db.insert(computeNodes).values(node).returning();
    return created;
  }

  async updateComputeNode(id: string, updates: Partial<ComputeNode>): Promise<void> {
    await db.update(computeNodes).set(updates).where(eq(computeNodes.id, id));
  }

  async updateComputeNodeHeartbeat(id: string, jobsInProgress: number): Promise<void> {
    await db.update(computeNodes).set({
      lastHeartbeatAt: new Date(),
      jobsInProgress,
    }).where(eq(computeNodes.id, id));
  }

  async updateComputeNodeStats(id: string, completed: boolean, hbdEarned?: string): Promise<void> {
    if (completed) {
      await db.update(computeNodes).set({
        totalJobsCompleted: sql`${computeNodes.totalJobsCompleted} + 1`,
        ...(hbdEarned ? { totalHbdEarned: sql`(CAST(${computeNodes.totalHbdEarned} AS NUMERIC) + ${parseFloat(hbdEarned)})::TEXT` } : {}),
      }).where(eq(computeNodes.id, id));
    } else {
      await db.update(computeNodes).set({
        totalJobsFailed: sql`${computeNodes.totalJobsFailed} + 1`,
      }).where(eq(computeNodes.id, id));
    }
  }

  // --- Jobs ---
  async getComputeJob(id: string): Promise<ComputeJob | undefined> {
    const [job] = await db.select().from(computeJobs).where(eq(computeJobs.id, id));
    return job || undefined;
  }

  async getComputeJobsByCreator(username: string, limit = 50): Promise<ComputeJob[]> {
    return db.select().from(computeJobs)
      .where(eq(computeJobs.creatorUsername, username))
      .orderBy(desc(computeJobs.createdAt))
      .limit(limit);
  }

  async getQueuedComputeJobs(workloadType?: string): Promise<ComputeJob[]> {
    const conditions = [eq(computeJobs.state, "queued")];
    if (workloadType) {
      conditions.push(eq(computeJobs.workloadType, workloadType));
    }
    return db.select().from(computeJobs)
      .where(and(...conditions))
      .orderBy(desc(computeJobs.priority), computeJobs.createdAt);
  }

  async createComputeJob(job: InsertComputeJob): Promise<ComputeJob> {
    const [created] = await db.insert(computeJobs).values(job).returning();
    return created;
  }

  async updateComputeJobState(id: string, state: string, extra?: Partial<ComputeJob>): Promise<void> {
    await db.update(computeJobs).set({ state, ...extra }).where(eq(computeJobs.id, id));
  }

  async touchActiveAttemptHeartbeats(nodeId: string): Promise<void> {
    await db.update(computeJobAttempts).set({ heartbeatAt: new Date() })
      .where(and(
        eq(computeJobAttempts.nodeId, nodeId),
        or(
          eq(computeJobAttempts.state, "leased"),
          eq(computeJobAttempts.state, "running"),
        ),
      ));
  }

  /**
   * Atomically claim the best eligible job for a node.
   * Uses SELECT ... FOR UPDATE SKIP LOCKED to prevent race conditions.
   * Ranks jobs by: cache match (desc) → priority (desc) → created_at (asc).
   */
  async claimComputeJobAtomic(
    nodeId: string,
    allowedTypes: string[],
    minVramGb: number,
    cachedModelsList: string[],
    leaseToken: string,
  ): Promise<{ job: ComputeJob; attempt: ComputeJobAttempt } | null> {
    // Build a raw SQL query with FOR UPDATE SKIP LOCKED
    // This atomically selects and locks one eligible job row
    const typePlaceholders = allowedTypes.map(t => `'${t.replace(/'/g, "")}'`).join(",");
    const now = new Date();

    // Cache-aware scoring: jobs whose requiredModels are in cachedModelsList get priority
    // We use a simple boolean score: 1 if all required models cached, 0 otherwise
    const cacheCheck = cachedModelsList.length > 0
      ? cachedModelsList.map(m => `'${m.replace(/'/g, "")}'`).join(",")
      : "''";

    const result = await db.execute(sql`
      WITH eligible AS (
        SELECT id,
          CASE
            WHEN required_models = '' OR required_models IS NULL THEN 1
            WHEN required_models = ANY(ARRAY[${sql.raw(cacheCheck)}]) THEN 1
            ELSE 0
          END AS cache_score
        FROM compute_jobs
        WHERE state = 'queued'
          AND workload_type IN (${sql.raw(typePlaceholders)})
          AND min_vram_gb <= ${minVramGb}
          AND attempt_count < max_attempts
          AND (deadline_at IS NULL OR deadline_at > ${now})
        ORDER BY cache_score DESC, priority DESC, created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE compute_jobs
      SET state = 'leased', attempt_count = attempt_count + 1
      FROM eligible
      WHERE compute_jobs.id = eligible.id
      RETURNING compute_jobs.*
    `);

    if (!result.rows || result.rows.length === 0) return null;

    // Raw SQL returns snake_case columns — re-fetch via Drizzle ORM for proper camelCase mapping
    const rawRow = result.rows[0] as any;
    const claimedJob = await this.getComputeJob(rawRow.id);
    if (!claimedJob) return null;

    // Create the attempt in the same logical operation
    const attempt = await this.createComputeJobAttempt({
      jobId: claimedJob.id,
      nodeId,
      leaseToken,
      state: "leased",
      progressPct: 0,
      startedAt: now,
      heartbeatAt: now,
    });

    return { job: claimedJob, attempt };
  }

  async getExpiredComputeLeases(): Promise<ComputeJobAttempt[]> {
    return db.select().from(computeJobAttempts)
      .where(and(
        or(
          eq(computeJobAttempts.state, "leased"),
          eq(computeJobAttempts.state, "running"),
        ),
        // Heartbeat older than 2 minutes = stale
        lte(computeJobAttempts.heartbeatAt, new Date(Date.now() - 2 * 60 * 1000)),
      ));
  }

  // --- Attempts ---
  async createComputeJobAttempt(attempt: InsertComputeJobAttempt): Promise<ComputeJobAttempt> {
    const [created] = await db.insert(computeJobAttempts).values(attempt).returning();
    return created;
  }

  async getComputeJobAttempt(id: string): Promise<ComputeJobAttempt | undefined> {
    const [attempt] = await db.select().from(computeJobAttempts).where(eq(computeJobAttempts.id, id));
    return attempt || undefined;
  }

  async getComputeJobAttempts(jobId: string): Promise<ComputeJobAttempt[]> {
    return db.select().from(computeJobAttempts)
      .where(eq(computeJobAttempts.jobId, jobId))
      .orderBy(desc(computeJobAttempts.createdAt));
  }

  async updateComputeJobAttempt(id: string, updates: Partial<ComputeJobAttempt>): Promise<void> {
    await db.update(computeJobAttempts).set(updates).where(eq(computeJobAttempts.id, id));
  }

  // --- Verifications ---
  async createComputeVerification(verification: InsertComputeVerification): Promise<ComputeVerification> {
    const [created] = await db.insert(computeVerifications).values(verification).returning();
    return created;
  }

  async getComputeVerifications(jobId: string): Promise<ComputeVerification[]> {
    return db.select().from(computeVerifications)
      .where(eq(computeVerifications.jobId, jobId))
      .orderBy(desc(computeVerifications.createdAt));
  }

  // --- Payouts ---
  async createComputePayout(payout: InsertComputePayout): Promise<ComputePayout> {
    const [created] = await db.insert(computePayouts).values(payout).returning();
    return created;
  }

  async getComputePayoutsByJob(jobId: string): Promise<ComputePayout[]> {
    return db.select().from(computePayouts)
      .where(eq(computePayouts.jobId, jobId))
      .orderBy(desc(computePayouts.createdAt));
  }

  async getComputePayoutsByNode(nodeId: string, limit = 50): Promise<ComputePayout[]> {
    return db.select().from(computePayouts)
      .where(eq(computePayouts.nodeId, nodeId))
      .orderBy(desc(computePayouts.createdAt))
      .limit(limit);
  }

  async updateComputePayoutStatus(id: string, status: string, treasuryTxId?: string): Promise<void> {
    await db.update(computePayouts).set({
      status,
      ...(treasuryTxId ? { treasuryTxId } : {}),
    }).where(eq(computePayouts.id, id));
  }

  // --- Stats ---
  async getComputeStats(): Promise<{ totalNodes: number; onlineNodes: number; totalJobs: number; completedJobs: number; totalHbdPaid: string }> {
    const [nodeStats] = await db.select({
      total: sql<number>`count(*)`,
      online: sql<number>`sum(case when ${computeNodes.status} = 'online' then 1 else 0 end)`,
    }).from(computeNodes);

    const [jobStats] = await db.select({
      total: sql<number>`count(*)`,
      completed: sql<number>`sum(case when ${computeJobs.state} = 'accepted' then 1 else 0 end)`,
    }).from(computeJobs);

    const [payoutStats] = await db.select({
      totalPaid: sql<string>`COALESCE(SUM(CAST(${computePayouts.amountHbd} AS NUMERIC)), 0)::TEXT`,
    }).from(computePayouts).where(eq(computePayouts.status, "confirmed"));

    return {
      totalNodes: Number(nodeStats?.total) || 0,
      onlineNodes: Number(nodeStats?.online) || 0,
      totalJobs: Number(jobStats?.total) || 0,
      completedJobs: Number(jobStats?.completed) || 0,
      totalHbdPaid: payoutStats?.totalPaid || "0",
    };
  }
}

// Factory: SQLite when SQLITE_DB_PATH is set (desktop agent), PostgreSQL otherwise
// Uses createRequire for compatibility with both ESM (tsx dev) and CJS (esbuild prod)
let _storageInstance: DatabaseStorage | null = null;

function createStorage(): DatabaseStorage {
  if (_storageInstance) return _storageInstance;

  if (process.env.SQLITE_DB_PATH) {
    const _require = createRequire(import.meta.url ?? __filename);
    const { initSQLite, createSQLiteTables } = _require("./db-sqlite");
    initSQLite(process.env.SQLITE_DB_PATH);
    createSQLiteTables(process.env.SQLITE_DB_PATH);
    const { SQLiteStorage } = _require("./storage-sqlite");
    _storageInstance = new SQLiteStorage() as unknown as DatabaseStorage;
  } else {
    _storageInstance = new DatabaseStorage();
  }
  return _storageInstance;
}

export const storage = createStorage();
