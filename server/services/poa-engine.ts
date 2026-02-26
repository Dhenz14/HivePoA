import { storage } from "../storage";
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

  // Rewards
  BASE_REWARD_HBD: 0.001,
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
  NODE_FILE_COOLDOWN_MS: envInt("POA_NODE_FILE_COOLDOWN_MS", 60_000, 14_400_000),     // dev: 1 min, prod: 4 hours
  NODE_COOLDOWN_MS: envInt("POA_NODE_COOLDOWN_MS", 30_000, 1_800_000),                // dev: 30s, prod: 30 min

  // Trust-based cooldown multipliers
  TRUST_TIER_NEW: 50,
  TRUST_TIER_ESTABLISHED: 75,
  COOLDOWN_MULTIPLIER_NEW: 0.5,
  COOLDOWN_MULTIPLIER_ESTABLISHED: 2,

  // Challenge batching
  CHALLENGES_PER_ROUND: 3,

  // Challenge interval — env var override with smart defaults
  DEFAULT_CHALLENGE_INTERVAL_MS: envInt("POA_CHALLENGE_INTERVAL_MS", 30_000, 1_800_000), // dev: 30s, prod: 30 min

  // Cache
  BLOCK_CACHE_TTL_MS: 3600000,
  BLOCK_CACHE_MAX_SIZE: 1000,

  // Timeouts
  CHALLENGE_TIMEOUT_MS: 2000,
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

  constructor(config?: Partial<PoAConfig>) {
    this.config = {
      validatorUsername: config?.validatorUsername || "validator-police",
      spkNodeUrl: config?.spkNodeUrl || process.env.SPK_POA_URL,
      ipfsApiUrl: config?.ipfsApiUrl || process.env.IPFS_API_URL,
      challengeIntervalMs: config?.challengeIntervalMs || POA_CONFIG.DEFAULT_CHALLENGE_INTERVAL_MS,
      useMockMode: config?.useMockMode ?? !process.env.SPK_POA_URL,
      broadcastToHive: config?.broadcastToHive ?? !!process.env.HIVE_POSTING_KEY,
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
    console.log(`[PoA Engine] Started for validator: ${this.config.validatorUsername}`);
    console.log(`[PoA Engine] Mode: ${this.config.useMockMode ? "SIMULATION" : "LIVE SPK INTEGRATION"}`);

    if (!this.config.useMockMode && this.config.spkNodeUrl) {
      try {
        this.spkClient = createSPKClient({
          url: this.config.spkNodeUrl,
          username: this.config.validatorUsername,
        });
        await this.spkClient.connect();
        console.log(`[PoA Engine] Connected to SPK PoA node at ${this.config.spkNodeUrl}`);
      } catch (err) {
        console.warn(`[PoA Engine] Failed to connect to SPK node, falling back to simulation:`, err);
        this.config.useMockMode = true;
      }
    }

    const ipfsOnline = await this.ipfsClient.isOnline();
    console.log(`[PoA Engine] IPFS status: ${ipfsOnline ? "ONLINE" : "OFFLINE (using mock)"}`);

    this.challengeInterval = setInterval(() => {
      this.runChallenge();
    }, this.config.challengeIntervalMs);
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

  private async runChallenge() {
    if (!this.validatorId) return;

    // Get only eligible nodes (excludes blacklisted ones)
    let nodes = await storage.getEligibleNodesForValidator(this.validatorId);
    if (nodes.length === 0) return;

    // Filter out nodes that are on cooldown (recently challenged)
    nodes = this.filterCooldownNodes(nodes);
    if (nodes.length === 0) {
      // All nodes are on cooldown, skip this round
      return;
    }

    const allFiles = await storage.getAllFiles();
    // Only challenge files that have PoA enabled (real CIDs that exist)
    const files = allFiles.filter(f => f.poaEnabled === true);
    if (files.length === 0) return;

    // OPTIMIZATION: Batch 3-5 challenges per round
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
        
        await this.executeChallenge(challenge.id, selectedNode, selectedFile, salt);
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
    salt: string
  ) {
    // LIVE MODE: If node has an endpoint, always use live validation
    if (node.endpoint) {
      await this.processSPKChallenge(challengeId, node.id, file.id, file.cid, salt);
    } else if (this.config.useMockMode) {
      await this.processSimulatedChallenge(challengeId, node.id, file.id, salt);
    } else {
      await this.processSPKChallenge(challengeId, node.id, file.id, file.cid, salt);
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
      // Compute expected proof hash from our IPFS
      let blockCids = this.blocksCache.get(cid);
      if (!blockCids) {
        try {
          blockCids = await this.ipfsClient.refs(cid);
          this.blocksCache.set(cid, blockCids);
        } catch {
          blockCids = [];
        }
      }

      const expectedProofHash = await createProofHash(this.ipfsClient, salt, cid, blockCids);

      // LIVE MODE: Connect directly to node's endpoint if available
      const nodeEndpoint = (node as any).endpoint;
      if (nodeEndpoint) {
        const nodeResponse = await this.challengeNodeDirectly(nodeEndpoint, cid, salt, this.config.validatorUsername);
        latencyMs = nodeResponse.elapsed || Date.now() - startTime;

        if (nodeResponse.status === "success") {
          if (nodeResponse.proofHash === expectedProofHash) {
            result = "success";
            response = nodeResponse.proofHash || "";
            console.log(`[PoA Engine] LIVE challenge PASSED: ${(node as any).hiveUsername} (${latencyMs}ms)`);
          } else {
            result = "fail";
            response = "PROOF_MISMATCH";
            console.log(`[PoA Engine] LIVE challenge FAILED: proof mismatch`);
          }
        } else if (nodeResponse.status === "timeout") {
          result = "fail";
          response = "TIMEOUT";
        } else {
          result = "fail";
          response = nodeResponse.error || "VALIDATION_FAILED";
        }
      }
      // Fallback to SPK client if no direct endpoint
      else if (this.spkClient && 'validate' in this.spkClient) {
        const spkResponse = await this.spkClient.validate(cid, salt);
        latencyMs = spkResponse.elapsed || Date.now() - startTime;

        if (spkResponse.status === "success") {
          if (spkResponse.proofHash === expectedProofHash) {
            result = "success";
            response = spkResponse.proofHash || "";
          } else {
            result = "fail";
            response = "PROOF_MISMATCH";
          }
        } else if (spkResponse.status === "timeout") {
          result = "fail";
          response = "TIMEOUT";
        } else {
          result = "fail";
          response = "VALIDATION_FAILED";
        }
      } else {
        result = "fail";
        response = "NO_ENDPOINT";
        latencyMs = Date.now() - startTime;
      }
    } catch (err) {
      console.error(`[PoA Engine] Validation error:`, err);
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
      console.log(`[PoA] INSTANT BAN: ${node.hiveUsername} - ${POA_CONFIG.CONSECUTIVE_FAIL_BAN} consecutive failures`);
    } else if (newReputation < POA_CONFIG.BAN_THRESHOLD) {
      newStatus = "banned";
    } else if (newReputation < POA_CONFIG.PROBATION_THRESHOLD) {
      newStatus = "probation";
    } else {
      newStatus = "active";
    }

    await storage.updateStorageNodeReputation(node.id, newReputation, newStatus, newConsecutiveFails);

    console.log(`[PoA] Challenge ${result}: ${node.hiveUsername} (Rep: ${node.reputation} -> ${newReputation}, Streak: ${newStreak}, Consecutive Fails: ${newConsecutiveFails})`);

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
        console.error(`[PoA] Failed to broadcast to Hive:`, err);
      }
    }

    if (result === "fail") {
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
      // OPTIMIZATION: Rarity-based reward multiplier
      const replicationCount = file?.replicationCount || 1;
      const baseReward = POA_CONFIG.BASE_REWARD_HBD;
      const rarityMultiplier = 1 / Math.max(1, replicationCount);
      
      // OPTIMIZATION: Streak bonus for consistent performance
      let streakBonus = 1.0;
      if (newStreak >= 100) {
        streakBonus = POA_CONFIG.STREAK_BONUS_100;
      } else if (newStreak >= 50) {
        streakBonus = POA_CONFIG.STREAK_BONUS_50;
      } else if (newStreak >= 10) {
        streakBonus = POA_CONFIG.STREAK_BONUS_10;
      }
      
      const reward = baseReward * rarityMultiplier * streakBonus;
      const rewardFormatted = reward.toFixed(4);

      // Update file earnings
      if (file) {
        await storage.updateFileEarnings(fileId, reward);
      }

      // Update node total earnings
      await storage.updateNodeEarnings(nodeId, reward);

      await storage.createHiveTransaction({
        type: "hbd_transfer",
        fromUser: this.config.validatorUsername,
        toUser: node.hiveUsername,
        payload: JSON.stringify({
          amount: `${rewardFormatted} HBD`,
          memo: `PoA Reward (rarity: ${rarityMultiplier.toFixed(2)}x, streak: ${streakBonus}x)`,
          cid: cid,
          streak: newStreak,
        }),
        blockNumber: Math.floor(Date.now() / 1000),
      });

      console.log(`[PoA] Reward: ${rewardFormatted} HBD to ${node.hiveUsername} (rarity: ${rarityMultiplier.toFixed(2)}x, streak: ${streakBonus}x)`);
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
