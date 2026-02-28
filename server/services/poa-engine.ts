import { storage } from "../storage";
import { logPoA } from "../logger";
import crypto from "crypto";
import { getIPFSClient, IPFSClient } from "./ipfs-client";
import { createProofHash, createRandomHash, createSaltWithEntropy } from "./poa-crypto";
import { createSPKClient, MockSPKPoAClient, SPKPoAClient } from "./spk-poa-client";
import { createHiveClient, HiveClient, MockHiveClient } from "./hive-client";

// ============================================================
// Configuration Constants (moved from magic numbers)
// ============================================================
const isProduction = process.env.NODE_ENV === "production";

// Parse env var as integer with fallback
function envInt(key: string, devDefault: number, prodDefault: number): number {
  const val = process.env[key];
  if (val) return parseInt(val, 10);
  return isProduction ? prodDefault : devDefault;
}

export const POA_CONFIG = {
  // Reputation
  SUCCESS_REP_GAIN: 1,
  FAIL_REP_BASE_LOSS: 5,
  FAIL_REP_MULTIPLIER: 1.5,
  MAX_REP_LOSS: 20,
  BAN_THRESHOLD: 10,
  PROBATION_THRESHOLD: 30,
  CONSECUTIVE_FAIL_BAN: 3,

  // Rewards — contract-funded (rewardPerChallenge from storage contract)
  // FALLBACK_REWARD_HBD used only for files without an active contract
  FALLBACK_REWARD_HBD: 0.005,
  STREAK_BONUS_10: 1.1,
  STREAK_BONUS_50: 1.25,
  STREAK_BONUS_100: 1.5,

  // Time-based reward multipliers (SPK Network style)
  TIME_BONUS_1_HOUR: 1.0,
  TIME_BONUS_1_DAY: 1.25,
  TIME_BONUS_1_WEEK: 1.5,
  TIME_BONUS_1_MONTH: 2.0,

  // Cooldown — environment-aware with env var overrides
  BAN_COOLDOWN_HOURS: 24,
  NODE_FILE_COOLDOWN_MS: envInt("POA_NODE_FILE_COOLDOWN_MS", 60_000, 43_200_000),    // dev: 1 min, prod: 12 hours
  NODE_COOLDOWN_MS: envInt("POA_NODE_COOLDOWN_MS", 30_000, 7_200_000),               // dev: 30s, prod: 2 hours

  // Trust-based cooldown multipliers
  TRUST_TIER_NEW: 50,
  TRUST_TIER_ESTABLISHED: 75,
  COOLDOWN_MULTIPLIER_NEW: 0.5,
  COOLDOWN_MULTIPLIER_ESTABLISHED: 2,

  // Challenge batching — 5 per round, 6 rounds/day = 30 challenges/day (was 144)
  CHALLENGES_PER_ROUND: 5,

  // Micropayment batching — reduced threshold since challenges are less frequent
  PROOF_BATCH_THRESHOLD: 5,
  MIN_BATCH_PAYOUT_HBD: 0.001, // Don't issue payouts below dust threshold

  // Spending safety limits
  MAX_SINGLE_PAYOUT_HBD: 1.0,   // Max per-batch payout (sanity cap)
  MAX_DAILY_SPEND_HBD: 50.0,    // Max total spend per 24 hours
  MIN_BALANCE_RESERVE_HBD: 1.0, // Keep at least this much in the wallet

  // Challenge interval — 4 hours production (was 30 min), 2 min dev (was 30s)
  // Reduces Hive API load by ~77%: ~36 calls/day vs ~158
  DEFAULT_CHALLENGE_INTERVAL_MS: envInt("POA_CHALLENGE_INTERVAL_MS", 120_000, 14_400_000), // dev: 2 min, prod: 4 hours

  // Cache
  BLOCK_CACHE_TTL_MS: 3600000,
  BLOCK_CACHE_MAX_SIZE: 1000,

  // Timeouts — must exceed anti-cheat window (25s) to give agents time to compute proofs
  CHALLENGE_TIMEOUT_MS: 30_000,
};

// LRU Cache with TTL for block CIDs
interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }
}

export interface PoAConfig {
  validatorUsername: string;
  spkNodeUrl?: string;
  ipfsApiUrl?: string;
  challengeIntervalMs: number;
  useMockMode: boolean;
  broadcastToHive: boolean;
}

export class PoAEngine {
  private challengeInterval: NodeJS.Timeout | null = null;
  private validatorId: string | null = null;
  private config: PoAConfig;
  private ipfsClient: IPFSClient;
  private spkClient: SPKPoAClient | MockSPKPoAClient | null = null;
  private hiveClient: HiveClient | MockHiveClient;
  private blocksCache: LRUCache<string[]>;
  private currentHiveBlockHash: string = "";

  // Track consecutive successes for streak bonuses
  private nodeStreaks: Map<string, number> = new Map();
  
  // Cooldown tracking: prevents re-challenging same node+file too quickly
  // Key: `${nodeId}:${fileId}`, Value: timestamp of last challenge
  private nodeFileCooldowns: Map<string, number> = new Map();
  // Key: nodeId, Value: timestamp of last challenge (any file)
  private nodeCooldowns: Map<string, number> = new Map();

  // Micropayment batching: accumulate rewards until threshold, then issue one payout
  // SPK 1.0 spec: 10 proofs = 1 combined transaction (reduces chain bloat)
  private proofAccumulator: Map<string, {
    count: number;
    totalReward: number;
    cids: string[];
    nodeUsername: string;
  }> = new Map();

  // Financial safety: track daily spend and prevent concurrent flushes
  private dailySpendHbd: number = 0;
  private dailySpendResetAt: number = Date.now() + 86400000;
  private flushingNodes: Set<string> = new Set(); // Mutex: nodes currently being flushed

  // Contract references: map challengeId → contract for reward calculation
  private challengeContracts: Map<string, any> = new Map();

  constructor(config?: Partial<PoAConfig>) {
    this.config = {
      validatorUsername: config?.validatorUsername || "validator-police",
      spkNodeUrl: config?.spkNodeUrl || process.env.SPK_POA_URL,
      ipfsApiUrl: config?.ipfsApiUrl || process.env.IPFS_API_URL,
      challengeIntervalMs: config?.challengeIntervalMs || POA_CONFIG.DEFAULT_CHALLENGE_INTERVAL_MS,
      useMockMode: config?.useMockMode ?? !process.env.SPK_POA_URL,
      broadcastToHive: config?.broadcastToHive ?? !!process.env.HIVE_ACTIVE_KEY,
    };
    this.ipfsClient = getIPFSClient();
    this.hiveClient = createHiveClient({ username: this.config.validatorUsername });
    this.blocksCache = new LRUCache<string[]>(
      POA_CONFIG.BLOCK_CACHE_MAX_SIZE,
      POA_CONFIG.BLOCK_CACHE_TTL_MS
    );
    
    // Fetch Hive block hashes every 3 seconds (matches Hive block time)
    this.updateHiveBlockHash();
    setInterval(() => this.updateHiveBlockHash(), 3000);
  }

  private async updateHiveBlockHash(): Promise<void> {
    try {
      const hash = await this.hiveClient.getLatestBlockHash();
      if (hash) {
        this.currentHiveBlockHash = hash;
      }
    } catch {
      // Fallback to timestamp-based hash if Hive API is unreachable
      this.currentHiveBlockHash = crypto
        .createHash("sha256")
        .update(`hive-block-${Math.floor(Date.now() / 3000)}`)
        .digest("hex");
    }
  }

  async start(validatorUsername?: string) {
    if (validatorUsername) {
      this.config.validatorUsername = validatorUsername;
    }

    let validator = await storage.getValidatorByUsername(this.config.validatorUsername);
    if (!validator) {
      validator = await storage.createValidator({
        hiveUsername: this.config.validatorUsername,
        hiveRank: 42,
        status: "online",
        peerCount: 0,
        performance: 75,
        jobAllocation: 50,
        payoutRate: 1.0,
        version: "v0.5.0-spk",
      });
    }

    this.validatorId = validator.id;
    logPoA.info(`[PoA Engine] Started for validator: ${this.config.validatorUsername}`);
    logPoA.info(`[PoA Engine] Mode: ${this.config.useMockMode ? "SIMULATION" : "LIVE SPK INTEGRATION"}`);

    if (!this.config.useMockMode && this.config.spkNodeUrl) {
      try {
        this.spkClient = createSPKClient({
          url: this.config.spkNodeUrl,
          username: this.config.validatorUsername,
        });
        await this.spkClient.connect();
        logPoA.info(`[PoA Engine] Connected to SPK PoA node at ${this.config.spkNodeUrl}`);
      } catch (err) {
        logPoA.warn({ err }, "Failed to connect to SPK node, falling back to simulation");
        this.config.useMockMode = true;
      }
    }

    const ipfsOnline = await this.ipfsClient.isOnline();
    logPoA.info(`[PoA Engine] IPFS status: ${ipfsOnline ? "ONLINE" : "OFFLINE (using mock)"}`);

    // Pre-sync refs lists for all tracked files (lightweight metadata only)
    if (ipfsOnline) {
      this.syncAllFileRefs().catch(err =>
        logPoA.warn(`[PoA Engine] Refs sync warning: ${err.message}`)
      );
    }

    this.challengeInterval = setInterval(() => {
      this.runChallenge();
    }, this.config.challengeIntervalMs);
  }

  /**
   * SPK PoA 2.0: Sync IPFS sub-block CID lists for all tracked files.
   * The validator stores ONLY the refs list (metadata), NOT the actual file data.
   * This enables lightweight verification: ~200KB metadata per 1GB file.
   */
  private async syncAllFileRefs(): Promise<void> {
    const allFiles = await storage.getAllFiles();
    let synced = 0;
    for (const file of allFiles) {
      if (!file.poaEnabled || !file.cid) continue;
      const hasRefs = await storage.hasFileRefs(file.cid);
      if (hasRefs) continue;

      try {
        const blockCids = await this.ipfsClient.refs(file.cid);
        await storage.saveFileRefs(file.cid, blockCids);
        synced++;
        logPoA.info(`[PoA Engine] Synced refs for ${file.cid.substring(0, 12)}... (${blockCids.length} blocks)`);
      } catch (err) {
        logPoA.warn(`[PoA Engine] Failed to sync refs for ${file.cid}: ${err}`);
      }
    }
    if (synced > 0) logPoA.info(`[PoA Engine] Refs sync complete: ${synced} new files indexed`);
  }

  /**
   * Sync refs for a single CID (called when new files are registered).
   */
  async syncFileRefsForCid(cid: string): Promise<void> {
    try {
      const blockCids = await this.ipfsClient.refs(cid);
      await storage.saveFileRefs(cid, blockCids);
    } catch (err) {
      logPoA.warn(`[PoA Engine] Failed to sync refs for ${cid}: ${err}`);
    }
  }

  stop() {
    if (this.challengeInterval) {
      clearInterval(this.challengeInterval);
      this.challengeInterval = null;
    }
    if (this.spkClient) {
      this.spkClient.disconnect();
      this.spkClient = null;
    }
  }

  // Weighted selection: prioritize low-reputation nodes for more frequent auditing
  private selectWeightedNode(nodes: any[]): any {
    // Filter out nodes in cooldown
    const now = Date.now();
    const eligibleNodes = nodes.filter(node => {
      if (node.status !== "banned") return true;
      // Check cooldown for banned nodes
      const lastSeenTime = new Date(node.lastSeen).getTime();
      const cooldownMs = POA_CONFIG.BAN_COOLDOWN_HOURS * 60 * 60 * 1000;
      return now - lastSeenTime > cooldownMs;
    });
    
    if (eligibleNodes.length === 0) return nodes[0]; // Fallback
    
    // Weight: lower reputation = higher chance of selection
    const weights = eligibleNodes.map(node => {
      const repWeight = Math.max(1, 101 - node.reputation); // 1-100 inverted
      const streakPenalty = (this.nodeStreaks.get(node.id) || 0) > 50 ? 0.5 : 1; // Less challenges for reliable nodes
      return repWeight * streakPenalty;
    });
    
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;
    
    for (let i = 0; i < eligibleNodes.length; i++) {
      random -= weights[i];
      if (random <= 0) return eligibleNodes[i];
    }
    
    return eligibleNodes[eligibleNodes.length - 1];
  }

  // Weighted file selection: prioritize high-value/less-verified files
  private selectWeightedFile(files: any[]): any {
    const weights = files.map(file => {
      const sizeWeight = Math.log10(Math.max(1, file.sizeBytes || 1000)) / 10; // Larger files
      const verifyWeight = Math.max(1, 10 - (file.replicationCount || 1)); // Less replicated
      const ageWeight = 1; // Could add time-based weighting
      return sizeWeight + verifyWeight + ageWeight;
    });
    
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    let random = Math.random() * totalWeight;
    
    for (let i = 0; i < files.length; i++) {
      random -= weights[i];
      if (random <= 0) return files[i];
    }
    
    return files[files.length - 1];
  }

  // Get cooldown multiplier based on node reputation (trust level)
  private getCooldownMultiplier(reputation: number): number {
    if (reputation < POA_CONFIG.TRUST_TIER_NEW) {
      // New/low-rep nodes: shorter cooldown = more frequent checks
      return POA_CONFIG.COOLDOWN_MULTIPLIER_NEW;
    } else if (reputation >= POA_CONFIG.TRUST_TIER_ESTABLISHED) {
      // Established nodes: longer cooldown = less frequent checks
      return POA_CONFIG.COOLDOWN_MULTIPLIER_ESTABLISHED;
    }
    // Middle tier: standard cooldown
    return 1;
  }

  // Check if a node is on cooldown (recently challenged)
  // Takes reputation into account - trusted nodes have longer cooldowns
  private isNodeOnCooldown(nodeId: string, reputation: number = 50): boolean {
    const lastChallenge = this.nodeCooldowns.get(nodeId);
    if (!lastChallenge) return false;
    const cooldownMs = POA_CONFIG.NODE_COOLDOWN_MS * this.getCooldownMultiplier(reputation);
    return Date.now() - lastChallenge < cooldownMs;
  }

  // Check if a specific node+file combo is on cooldown
  private isNodeFileComboCooldown(nodeId: string, fileId: string, reputation: number = 50): boolean {
    const key = `${nodeId}:${fileId}`;
    const lastChallenge = this.nodeFileCooldowns.get(key);
    if (!lastChallenge) return false;
    const cooldownMs = POA_CONFIG.NODE_FILE_COOLDOWN_MS * this.getCooldownMultiplier(reputation);
    return Date.now() - lastChallenge < cooldownMs;
  }

  // Record that a challenge was issued (update cooldowns)
  private recordChallengeCooldown(nodeId: string, fileId: string): void {
    const now = Date.now();
    this.nodeCooldowns.set(nodeId, now);
    this.nodeFileCooldowns.set(`${nodeId}:${fileId}`, now);
    
    // Clean up old cooldown entries periodically (keep maps from growing)
    if (this.nodeFileCooldowns.size > 1000) {
      const cutoff = now - POA_CONFIG.NODE_FILE_COOLDOWN_MS;
      Array.from(this.nodeFileCooldowns.entries()).forEach(([key, timestamp]) => {
        if (timestamp < cutoff) this.nodeFileCooldowns.delete(key);
      });
    }
    if (this.nodeCooldowns.size > 500) {
      const cutoff = now - POA_CONFIG.NODE_COOLDOWN_MS;
      Array.from(this.nodeCooldowns.entries()).forEach(([key, timestamp]) => {
        if (timestamp < cutoff) this.nodeCooldowns.delete(key);
      });
    }
  }

  // Filter nodes that are not on cooldown (reputation-aware)
  private filterCooldownNodes(nodes: any[]): any[] {
    return nodes.filter(node => !this.isNodeOnCooldown(node.id, node.reputation));
  }

  /**
   * Sweep contract lifecycle: mark expired and budget-exhausted contracts.
   * Runs at the start of each challenge round.
   */
  private async sweepContractLifecycle(): Promise<void> {
    try {
      // Mark time-expired contracts
      const expired = await storage.getExpiredContracts();
      for (const contract of expired) {
        await storage.updateStorageContractStatus(contract.id, 'expired');
        const remaining = parseFloat(contract.hbdBudget) - parseFloat(contract.hbdSpent);
        logPoA.info(`[PoA] Contract ${contract.id} expired (CID: ${contract.fileCid.substring(0, 12)}..., remaining: ${remaining.toFixed(3)} HBD)`);
      }

      // Mark budget-exhausted contracts
      const exhausted = await storage.getExhaustedContracts();
      for (const contract of exhausted) {
        await storage.updateStorageContractStatus(contract.id, 'completed');
        logPoA.info(`[PoA] Contract ${contract.id} completed — budget fully spent (CID: ${contract.fileCid.substring(0, 12)}...)`);
      }
    } catch (err) {
      logPoA.error({ err }, "Failed to sweep contract lifecycle");
    }
  }

  private async runChallenge() {
    if (!this.validatorId) return;

    // Sweep expired and exhausted contracts before selecting challenges
    await this.sweepContractLifecycle();

    // Get only eligible nodes (excludes blacklisted ones)
    let nodes = await storage.getEligibleNodesForValidator(this.validatorId);
    if (nodes.length === 0) return;

    // Filter out nodes that are on cooldown (recently challenged)
    nodes = this.filterCooldownNodes(nodes);
    if (nodes.length === 0) {
      // All nodes are on cooldown, skip this round
      return;
    }

    // CONTRACT-FUNDED: Prefer files with active, funded contracts
    const activeContracts = await storage.getActiveContractsForChallenge();
    const contractCids = new Set(activeContracts.map(c => c.fileCid));

    const allFiles = await storage.getAllFiles();
    // Only challenge files that have PoA enabled (real CIDs that exist)
    const poaFiles = allFiles.filter(f => f.poaEnabled === true);
    if (poaFiles.length === 0) return;

    // Prioritize contract-funded files, but allow unfunded files as fallback
    const fundedFiles = poaFiles.filter(f => contractCids.has(f.cid));
    const files = fundedFiles.length > 0 ? fundedFiles : poaFiles;

    // OPTIMIZATION: Batch 5 challenges per round (was 3)
    const batchSize = Math.min(
      POA_CONFIG.CHALLENGES_PER_ROUND,
      nodes.length,
      files.length
    );

    const challengePromises: Promise<void>[] = [];
    const challengedNodes = new Set<string>(); // Track nodes challenged this round

    for (let i = 0; i < batchSize; i++) {
      // OPTIMIZATION: Weighted selection for nodes and files
      // Also filter out nodes already challenged this round
      const availableNodes = nodes.filter(n => !challengedNodes.has(n.id));
      if (availableNodes.length === 0) break;

      const selectedNode = this.selectWeightedNode(availableNodes);

      // Find a file that hasn't been challenged with this node recently
      let selectedFile = this.selectWeightedFile(files);
      let attempts = 0;
      while (this.isNodeFileComboCooldown(selectedNode.id, selectedFile.id, selectedNode.reputation) && attempts < 5) {
        selectedFile = this.selectWeightedFile(files);
        attempts++;
      }

      // Look up contract for this file's CID (for reward calculation)
      const contract = activeContracts.find(c => c.fileCid === selectedFile.cid);

      // Mark node as challenged this round
      challengedNodes.add(selectedNode.id);

      // Record cooldown
      this.recordChallengeCooldown(selectedNode.id, selectedFile.id);

      // OPTIMIZATION: Add Hive block hash entropy to salt
      const salt = createSaltWithEntropy(this.currentHiveBlockHash);
      const challengeData = JSON.stringify({
        salt,
        cid: selectedFile.cid,
        method: this.config.useMockMode ? "simulation" : "spk-poa",
        blockHash: this.currentHiveBlockHash.slice(0, 16), // Include for verification
        contractId: contract?.id || null,
      });

      const challengePromise = (async () => {
        const challenge = await storage.createPoaChallenge({
          validatorId: this.validatorId!,
          nodeId: selectedNode.id,
          fileId: selectedFile.id,
          challengeData,
          response: null,
          result: null,
          latencyMs: null,
        });

        await this.executeChallenge(challenge.id, selectedNode, selectedFile, salt, contract);
      })();

      challengePromises.push(challengePromise);
    }

    // Execute all challenges in parallel
    await Promise.allSettled(challengePromises);
  }

  private async executeChallenge(
    challengeId: string,
    node: any,
    file: any,
    salt: string,
    contract?: any
  ) {
    // Store contract reference for reward calculation in handleChallengeResult
    if (contract) {
      this.challengeContracts.set(challengeId, contract);
    }

    // AGENT-WS MODE: If node is connected via WebSocket, use that channel
    const { agentWSManager } = await import("./agent-ws-manager");
    if (agentWSManager.isAgentConnected(node.id)) {
      logPoA.info(`[PoA] AGENT-WS challenge → node=${node.hiveUsername || node.id} file=${file.cid?.substring(0, 12)}... contract=${contract?.id || 'none'}`);
      await this.processAgentWSChallenge(challengeId, node, file, salt);
      return;
    }

    // LIVE MODE: If node has an endpoint, always use live validation
    if (node.endpoint) {
      logPoA.info(`[PoA] LIVE challenge → node=${node.hiveUsername || node.id} file=${file.cid?.substring(0, 12)}... contract=${contract?.id || 'none'}`);
      await this.processSPKChallenge(challengeId, node.id, file.id, file.cid, salt);
    } else if (this.config.useMockMode) {
      logPoA.info(`[PoA] SIMULATION challenge → node=${node.hiveUsername || node.id} (no endpoint, mock mode)`);
      await this.processSimulatedChallenge(challengeId, node.id, file.id, salt);
    } else {
      logPoA.info(`[PoA] SPK challenge → node=${node.hiveUsername || node.id} file=${file.cid?.substring(0, 12)}... contract=${contract?.id || 'none'}`);
      await this.processSPKChallenge(challengeId, node.id, file.id, file.cid, salt);
    }
  }

  /**
   * Challenge a desktop agent over its persistent WebSocket connection.
   * The agent computes the proof locally and sends it back on the same WS.
   */
  private async processAgentWSChallenge(
    challengeId: string,
    node: any,
    file: any,
    salt: string
  ): Promise<void> {
    const { agentWSManager } = await import("./agent-ws-manager");
    const startTime = Date.now();

    try {
      const result = await agentWSManager.challengeAgent(
        node.id,
        file.cid,
        salt,
        this.config.validatorUsername,
        POA_CONFIG.CHALLENGE_TIMEOUT_MS
      );

      // Use server-measured elapsed time (don't trust agent-reported timing)
      const serverElapsed = Date.now() - startTime;

      if (result.status === "timeout") {
        await this.recordChallengeResult(challengeId, node.id, file.id, "TIMEOUT", "fail", serverElapsed);
        return;
      }

      if (result.status !== "success") {
        await this.recordChallengeResult(challengeId, node.id, file.id, result.error || "VALIDATION_FAILED", "fail", serverElapsed);
        return;
      }

      // Anti-cheat timing check (25s max — proves data was pre-stored)
      // Uses server-side measurement to prevent agents from lying about elapsed time
      if (serverElapsed >= 25_000) {
        logPoA.info(`[PoA] TIMING FAIL: ${node.hiveUsername} took ${serverElapsed}ms server-side (>25s limit)`);
        await this.recordChallengeResult(challengeId, node.id, file.id, "TOO_SLOW", "fail", serverElapsed);
        return;
      }

      // Verify proof hash independently
      let blockCids = this.blocksCache.get(file.cid);
      if (!blockCids) {
        blockCids = await storage.getFileRefs(file.cid) ?? undefined;
        if (!blockCids) {
          try {
            blockCids = await this.ipfsClient.refs(file.cid);
            await storage.saveFileRefs(file.cid, blockCids);
          } catch {
            blockCids = [];
          }
        }
        if (blockCids && blockCids.length > 0) {
          this.blocksCache.set(file.cid, blockCids);
        }
      }

      const expectedProofHash = await createProofHash(this.ipfsClient, salt, file.cid, blockCids || []);

      if (result.proofHash && result.proofHash === expectedProofHash) {
        logPoA.info(`[PoA] AGENT-WS PASSED: ${node.hiveUsername} (${serverElapsed}ms)`);
        await this.recordChallengeResult(challengeId, node.id, file.id, result.proofHash, "success", serverElapsed);
      } else {
        logPoA.info(`[PoA] AGENT-WS FAILED: proof mismatch for ${node.hiveUsername}`);
        await this.recordChallengeResult(challengeId, node.id, file.id, "PROOF_MISMATCH", "fail", serverElapsed);
      }
    } catch (err) {
      logPoA.error({ err }, "Agent WS challenge error");
      await this.recordChallengeResult(challengeId, node.id, file.id, "ERROR", "fail", Date.now() - startTime);
    }
  }

  private async processSimulatedChallenge(
    challengeId: string, 
    nodeId: string, 
    fileId: string, 
    salt: string
  ) {
    const node = await storage.getStorageNode(nodeId);
    if (!node) return;

    const successRate = node.reputation > 60 ? 0.8 : 0.4;
    const success = Math.random() < successRate;
    
    const latencyMs = Math.floor(Math.random() * 1000 + 100);
    const response = success ? crypto.randomBytes(32).toString("hex") : "TIMEOUT";
    const result = success ? "success" : "fail";

    await this.recordChallengeResult(challengeId, nodeId, fileId, response, result, latencyMs);
  }

  /**
   * SPK PoA 2.0 Challenge — refs-only verification.
   *
   * KEY DESIGN: The validator does NOT need the file pinned locally.
   * It stores only the refs list (sub-block CIDs) in the database.
   * During verification, it fetches the needed sub-blocks on-demand
   * from the IPFS network (served by the storage node being tested).
   *
   * Flow:
   *  1. Load refs list from DB (or sync if missing)
   *  2. Send challenge to storage node
   *  3. Storage node computes proof hash from its local IPFS blocks
   *  4. Validator independently computes expected proof hash by
   *     fetching the same sub-blocks on-demand from IPFS
   *  5. Compare hashes. If they match AND elapsed < 25s, PASS.
   */
  private async processSPKChallenge(
    challengeId: string,
    nodeId: string,
    fileId: string,
    cid: string,
    salt: string
  ) {
    const node = await storage.getStorageNode(nodeId);
    if (!node) return;

    const startTime = Date.now();
    let result: "success" | "fail" = "fail";
    let response = "NO_RESPONSE";
    let latencyMs = 0;

    try {
      // Step 1: Load refs from DB (lightweight metadata, NOT the actual file data)
      let blockCids = this.blocksCache.get(cid);
      if (!blockCids) {
        blockCids = await storage.getFileRefs(cid) ?? undefined;
        if (!blockCids) {
          // Refs not yet synced — fetch now and persist
          try {
            blockCids = await this.ipfsClient.refs(cid);
            await storage.saveFileRefs(cid, blockCids);
          } catch {
            blockCids = [];
          }
        }
        if (blockCids && blockCids.length > 0) {
          this.blocksCache.set(cid, blockCids);
        }
      }

      // Step 2: Challenge the storage node
      const nodeEndpoint = (node as any).endpoint;
      let nodeProofHash: string | undefined;
      let challengeElapsed = 0;

      if (nodeEndpoint) {
        const nodeResponse = await this.challengeNodeDirectly(nodeEndpoint, cid, salt, this.config.validatorUsername);
        challengeElapsed = nodeResponse.elapsed;

        if (nodeResponse.status === "timeout") {
          result = "fail";
          response = "TIMEOUT";
          latencyMs = challengeElapsed;
          await this.recordChallengeResult(challengeId, nodeId, fileId, response, result, latencyMs);
          return;
        }
        if (nodeResponse.status !== "success") {
          result = "fail";
          response = nodeResponse.error || "VALIDATION_FAILED";
          latencyMs = challengeElapsed;
          await this.recordChallengeResult(challengeId, nodeId, fileId, response, result, latencyMs);
          return;
        }
        nodeProofHash = nodeResponse.proofHash;
      } else if (this.spkClient && 'validate' in this.spkClient) {
        const spkResponse = await this.spkClient.validate(cid, salt);
        challengeElapsed = spkResponse.elapsed || Date.now() - startTime;

        if (spkResponse.status !== "success") {
          result = "fail";
          response = spkResponse.status === "timeout" ? "TIMEOUT" : "VALIDATION_FAILED";
          latencyMs = challengeElapsed;
          await this.recordChallengeResult(challengeId, nodeId, fileId, response, result, latencyMs);
          return;
        }
        nodeProofHash = spkResponse.proofHash;
      } else {
        result = "fail";
        response = "NO_ENDPOINT";
        latencyMs = Date.now() - startTime;
        await this.recordChallengeResult(challengeId, nodeId, fileId, response, result, latencyMs);
        return;
      }

      // Step 3: Anti-cheat timing check (SPK Network spec: 25 second max)
      // If the node took too long, it may be fetching data on-demand rather
      // than having it stored locally. Reject.
      if (challengeElapsed >= 25_000) {
        result = "fail";
        response = "TOO_SLOW";
        latencyMs = challengeElapsed;
        logPoA.info(`[PoA Engine] TIMING FAIL: ${node.hiveUsername} took ${challengeElapsed}ms (>25s limit)`);
        await this.recordChallengeResult(challengeId, nodeId, fileId, response, result, latencyMs);
        return;
      }

      // Step 4: Validator independently computes the expected proof hash.
      // Fetches the same sub-blocks on-demand from IPFS — the validator does NOT
      // need the file pinned. It only needs the refs list (which blocks to fetch).
      const expectedProofHash = await createProofHash(this.ipfsClient, salt, cid, blockCids || []);
      latencyMs = challengeElapsed;

      // Step 5: Compare
      if (nodeProofHash && nodeProofHash === expectedProofHash) {
        result = "success";
        response = nodeProofHash;
        logPoA.info(`[PoA Engine] LIVE challenge PASSED: ${node.hiveUsername} (${latencyMs}ms)`);
      } else {
        result = "fail";
        response = "PROOF_MISMATCH";
        logPoA.info(`[PoA Engine] LIVE challenge FAILED: proof mismatch for ${node.hiveUsername} (expected=${expectedProofHash?.substring(0, 16)}... got=${nodeProofHash?.substring(0, 16)}...)`);
      }
    } catch (err) {
      logPoA.error({ err }, "Validation error");
      result = "fail";
      response = err instanceof Error ? err.message : "UNKNOWN_ERROR";
      latencyMs = Date.now() - startTime;
    }

    await this.recordChallengeResult(challengeId, nodeId, fileId, response, result, latencyMs);
  }

  // Direct WebSocket challenge to a storage node
  private async challengeNodeDirectly(
    endpoint: string,
    cid: string,
    salt: string,
    validatorUsername: string
  ): Promise<{ status: "success" | "fail" | "timeout"; proofHash?: string; elapsed: number; error?: string }> {
    const WebSocket = (await import("ws")).default;
    const wsUrl = endpoint.replace(/^http/, "ws");
    const timeoutMs = POA_CONFIG.CHALLENGE_TIMEOUT_MS;
    const startTime = Date.now();

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ws.close();
        resolve({ status: "timeout", elapsed: timeoutMs });
      }, timeoutMs);

      let ws: InstanceType<typeof WebSocket>;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        clearTimeout(timeout);
        resolve({ status: "fail", elapsed: Date.now() - startTime, error: "CONNECT_FAILED" });
        return;
      }

      ws.on("open", () => {
        const request = {
          type: "RequestProof",
          Hash: salt,
          CID: cid,
          User: validatorUsername,
          Status: "Pending",
        };
        ws.send(JSON.stringify(request));
      });

      ws.on("message", (data: Buffer) => {
        clearTimeout(timeout);
        try {
          const response = JSON.parse(data.toString());
          const elapsed = Date.now() - startTime;
          
          if (response.Status === "Success" || response.status === "success") {
            resolve({
              status: "success",
              proofHash: response.proofHash || response.ProofHash,
              elapsed,
            });
          } else {
            resolve({
              status: "fail",
              elapsed,
              error: response.error || "VALIDATION_FAILED",
            });
          }
        } catch {
          resolve({ status: "fail", elapsed: Date.now() - startTime, error: "PARSE_ERROR" });
        }
        ws.close();
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        resolve({ status: "fail", elapsed: Date.now() - startTime, error: err.message });
      });
    });
  }

  private async recordChallengeResult(
    challengeId: string,
    nodeId: string,
    fileId: string,
    response: string,
    result: "success" | "fail",
    latencyMs: number
  ) {
    const node = await storage.getStorageNode(nodeId);
    if (!node) return;

    const file = await storage.getFile(fileId);
    const cid = file?.cid || "";

    await storage.updateChallengeResult(challengeId, response, result, latencyMs);
    await storage.updateAssignmentProof(fileId, nodeId, result === "success");

    // OPTIMIZATION: Track consecutive fails - 3 in a row = instant ban
    const currentConsecutiveFails = (node as any).consecutiveFails || 0;
    let newConsecutiveFails = result === "success" ? 0 : currentConsecutiveFails + 1;
    
    // Track streak for bonuses
    const currentStreak = this.nodeStreaks.get(nodeId) || 0;
    const newStreak = result === "success" ? currentStreak + 1 : 0;
    this.nodeStreaks.set(nodeId, newStreak);
    
    // Calculate reputation change using config constants
    let newReputation: number;
    let newStatus: string;
    
    if (result === "success") {
      newReputation = Math.min(100, node.reputation + POA_CONFIG.SUCCESS_REP_GAIN);
    } else {
      // Exponential penalty for consecutive fails
      const penalty = Math.min(
        POA_CONFIG.MAX_REP_LOSS, 
        POA_CONFIG.FAIL_REP_BASE_LOSS * Math.pow(POA_CONFIG.FAIL_REP_MULTIPLIER, newConsecutiveFails - 1)
      );
      newReputation = Math.max(0, node.reputation - Math.floor(penalty));
    }

    // OPTIMIZATION: 3 consecutive fails = instant ban (per SPK Network spec)
    if (newConsecutiveFails >= POA_CONFIG.CONSECUTIVE_FAIL_BAN) {
      newStatus = "banned";
      newReputation = 0;
      logPoA.info(`[PoA] INSTANT BAN: ${node.hiveUsername} - ${POA_CONFIG.CONSECUTIVE_FAIL_BAN} consecutive failures`);
    } else if (newReputation < POA_CONFIG.BAN_THRESHOLD) {
      newStatus = "banned";
    } else if (newReputation < POA_CONFIG.PROBATION_THRESHOLD) {
      newStatus = "probation";
    } else {
      newStatus = "active";
    }

    await storage.updateStorageNodeReputation(node.id, newReputation, newStatus, newConsecutiveFails);

    logPoA.info(`[PoA] Challenge ${result}: ${node.hiveUsername} (Rep: ${node.reputation} -> ${newReputation}, Streak: ${newStreak}, Consecutive Fails: ${newConsecutiveFails})`);

    if (this.config.broadcastToHive) {
      try {
        if (result === "fail") {
          await this.hiveClient.broadcastReputationUpdate(
            node.hiveUsername,
            node.reputation,
            newReputation,
            newConsecutiveFails >= POA_CONFIG.CONSECUTIVE_FAIL_BAN ? "BANNED: 3 consecutive PoA failures" : "Failed PoA challenge"
          );
        } else {
          await this.hiveClient.broadcastPoAResult(
            node.hiveUsername,
            cid,
            true,
            latencyMs,
            response
          );
        }
      } catch (err) {
        logPoA.error({ err }, "Failed to broadcast to Hive");
      }
    }

    if (result === "fail") {
      // Clean up contract reference on failure
      this.challengeContracts.delete(challengeId);

      await storage.createHiveTransaction({
        type: "spk_reputation_slash",
        fromUser: this.config.validatorUsername,
        toUser: node.hiveUsername,
        payload: JSON.stringify({
          reason: newConsecutiveFails >= POA_CONFIG.CONSECUTIVE_FAIL_BAN ? "BANNED: 3 consecutive failures" : "Failed PoA challenge",
          oldRep: node.reputation,
          newRep: newReputation,
          consecutiveFails: newConsecutiveFails,
        }),
        blockNumber: Math.floor(Date.now() / 1000),
      });
    } else {
      // CONTRACT-FUNDED REWARDS: Use contract's rewardPerChallenge if available
      const contract = this.challengeContracts.get(challengeId);
      const contractReward = contract ? parseFloat(contract.rewardPerChallenge) : 0;
      const baseReward = contractReward > 0 ? contractReward : POA_CONFIG.FALLBACK_REWARD_HBD;

      // Rarity-based reward multiplier
      const replicationCount = file?.replicationCount || 1;
      const rarityMultiplier = 1 / Math.max(1, replicationCount);

      // Streak bonus for consistent performance
      let streakBonus = 1.0;
      if (newStreak >= 100) {
        streakBonus = POA_CONFIG.STREAK_BONUS_100;
      } else if (newStreak >= 50) {
        streakBonus = POA_CONFIG.STREAK_BONUS_50;
      } else if (newStreak >= 10) {
        streakBonus = POA_CONFIG.STREAK_BONUS_10;
      }

      const reward = baseReward * rarityMultiplier * streakBonus;

      // Deduct from contract budget if contract-funded
      if (contract) {
        const deducted = await storage.updateStorageContractSpent(contract.id, reward);
        if (!deducted) {
          logPoA.warn(`[PoA] Contract ${contract.id} budget exhausted during reward for ${node.hiveUsername}`);
          // Budget exhausted — mark completed, but still pay this last reward
          await storage.updateStorageContractStatus(contract.id, 'completed');
        }
      }

      // Update file earnings immediately (internal accounting)
      if (file) {
        await storage.updateFileEarnings(fileId, reward);
      }

      // Update node total earnings immediately (internal accounting)
      await storage.updateNodeEarnings(nodeId, reward);

      // MICROPAYMENT BATCHING: Accumulate rewards, payout at threshold (5 proofs = 1 Hive tx)
      await this.accumulateProofReward(nodeId, node.hiveUsername, cid, reward, newStreak, rarityMultiplier, streakBonus);

      // Clean up contract reference
      this.challengeContracts.delete(challengeId);
    }
  }

  /**
   * SPK 1.0-style micropayment batching.
   * Accumulates proof rewards per node. When a node hits the threshold
   * (default: 10 successful proofs), issues a single combined Hive transaction.
   * This reduces blockchain transaction volume by ~90%.
   */
  private async accumulateProofReward(
    nodeId: string,
    nodeUsername: string,
    cid: string,
    reward: number,
    streak: number,
    rarityMultiplier: number,
    streakBonus: number
  ): Promise<void> {
    const acc = this.proofAccumulator.get(nodeId) || {
      count: 0,
      totalReward: 0,
      cids: [],
      nodeUsername,
    };

    acc.count++;
    acc.totalReward += reward;
    if (!acc.cids.includes(cid)) {
      acc.cids.push(cid);
    }
    this.proofAccumulator.set(nodeId, acc);

    logPoA.info(`[PoA] Proof ${acc.count}/${POA_CONFIG.PROOF_BATCH_THRESHOLD} for ${nodeUsername} (+${reward.toFixed(4)} HBD, batch total: ${acc.totalReward.toFixed(4)} HBD)`);

    // Check if batch threshold reached
    if (acc.count >= POA_CONFIG.PROOF_BATCH_THRESHOLD) {
      await this.flushProofBatch(nodeId);
    }
  }

  /**
   * Flush accumulated proofs for a node into a single Hive transaction.
   *
   * FINANCIAL SAFETY:
   * - Mutex lock prevents concurrent double-flush for the same node
   * - Daily spending cap prevents runaway payouts
   * - Per-batch sanity cap rejects absurd amounts
   * - Balance pre-check ensures sufficient funds before transfer
   * - Audit trail records success/failure status of on-chain broadcast
   */
  private async flushProofBatch(nodeId: string): Promise<void> {
    // Mutex: prevent concurrent flush for the same node
    if (this.flushingNodes.has(nodeId)) return;

    const acc = this.proofAccumulator.get(nodeId);
    if (!acc || acc.totalReward < POA_CONFIG.MIN_BATCH_PAYOUT_HBD) return;

    this.flushingNodes.add(nodeId);

    try {
      const rewardAmount = acc.totalReward;
      const rewardFormatted = rewardAmount.toFixed(3);

      // Sanity cap: reject absurdly large single payouts
      if (rewardAmount > POA_CONFIG.MAX_SINGLE_PAYOUT_HBD) {
        logPoA.error(`[PoA] BLOCKED: Batch payout ${rewardFormatted} HBD to ${acc.nodeUsername} exceeds max single payout (${POA_CONFIG.MAX_SINGLE_PAYOUT_HBD} HBD)`);
        this.proofAccumulator.delete(nodeId);
        return;
      }

      // Daily spend cap: reset counter if day has passed
      if (Date.now() > this.dailySpendResetAt) {
        this.dailySpendHbd = 0;
        this.dailySpendResetAt = Date.now() + 86400000;
      }
      if (this.dailySpendHbd + rewardAmount > POA_CONFIG.MAX_DAILY_SPEND_HBD) {
        logPoA.warn(`[PoA] PAUSED: Daily spend limit reached (${this.dailySpendHbd.toFixed(3)}/${POA_CONFIG.MAX_DAILY_SPEND_HBD} HBD). Batch for ${acc.nodeUsername} deferred.`);
        return; // Don't delete accumulator — retry next cycle
      }

      // Record transaction intent in DB BEFORE attempting broadcast
      let broadcastStatus: "pending" | "success" | "failed" | "skipped" = "pending";
      let txHash: string | undefined;

      // Broadcast actual Hive transfer if configured
      if (this.config.broadcastToHive) {
        // Balance pre-check: verify sufficient funds
        try {
          const balanceStr = await this.hiveClient.getHBDBalance(this.config.validatorUsername);
          const balance = parseFloat(balanceStr);
          if (balance < rewardAmount + POA_CONFIG.MIN_BALANCE_RESERVE_HBD) {
            logPoA.error(`[PoA] BLOCKED: Insufficient balance (${balanceStr}) for payout ${rewardFormatted} HBD to ${acc.nodeUsername} (reserve: ${POA_CONFIG.MIN_BALANCE_RESERVE_HBD} HBD)`);
            broadcastStatus = "failed";
          }
        } catch (err) {
          logPoA.warn({ err }, "Balance check failed, proceeding with caution");
        }

        if (broadcastStatus !== "failed") {
          try {
            const tx = await this.hiveClient.transfer({
              to: acc.nodeUsername,
              amount: `${rewardFormatted} HBD`,
              memo: `SPK PoA 2.0 batch reward: ${acc.count} proofs verified`,
            });
            txHash = tx.id;
            broadcastStatus = "success";
            this.dailySpendHbd += rewardAmount;
          } catch (err) {
            logPoA.error({ err }, `Batch payout broadcast FAILED for ${acc.nodeUsername}`);
            broadcastStatus = "failed";
          }
        }
      } else {
        broadcastStatus = "skipped";
      }

      // Write audit record with broadcast result
      await storage.createHiveTransaction({
        type: "hbd_transfer",
        fromUser: this.config.validatorUsername,
        toUser: acc.nodeUsername,
        payload: JSON.stringify({
          amount: `${rewardFormatted} HBD`,
          memo: `PoA Batch Reward: ${acc.count} proofs across ${acc.cids.length} files`,
          proofCount: acc.count,
          fileCount: acc.cids.length,
          cids: acc.cids.slice(0, 10),
          broadcastStatus,
          txHash: txHash || null,
        }),
        blockNumber: Math.floor(Date.now() / 1000),
      });

      if (broadcastStatus === "success" || broadcastStatus === "skipped") {
        logPoA.info(`[PoA] BATCH PAYOUT: ${rewardFormatted} HBD to ${acc.nodeUsername} (${acc.count} proofs, status=${broadcastStatus})`);
        this.proofAccumulator.delete(nodeId);
      } else {
        // Failed: keep accumulator for manual retry, but log clearly
        logPoA.error(`[PoA] BATCH PAYOUT FAILED: ${rewardFormatted} HBD to ${acc.nodeUsername} NOT sent. Accumulator preserved for retry.`);
      }
    } finally {
      this.flushingNodes.delete(nodeId);
    }
  }

  /**
   * Flush all pending proof batches (called on shutdown to prevent lost rewards).
   */
  async flushAllPendingBatches(): Promise<void> {
    const nodeIds = Array.from(this.proofAccumulator.keys());
    for (const nodeId of nodeIds) {
      await this.flushProofBatch(nodeId);
    }
    if (nodeIds.length > 0) {
      logPoA.info(`[PoA] Flushed ${nodeIds.length} pending proof batches on shutdown`);
    }
  }

  getStatus(): {
    running: boolean;
    mode: string;
    validator: string | null;
    spkConnected: boolean;
    ipfsOnline: boolean;
  } {
    return {
      running: this.challengeInterval !== null,
      mode: this.config.useMockMode ? "simulation" : "spk-live",
      validator: this.config.validatorUsername,
      spkConnected: this.spkClient?.isConnected ?? false,
      ipfsOnline: false,
    };
  }
}

export const poaEngine = new PoAEngine();
