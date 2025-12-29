import { storage } from "../storage";
import crypto from "crypto";
import { getIPFSClient, IPFSClient } from "./ipfs-client";
import { createProofHash, createRandomHash } from "./poa-crypto";
import { createSPKClient, MockSPKPoAClient, SPKPoAClient } from "./spk-poa-client";
import { createHiveClient, HiveClient, MockHiveClient } from "./hive-client";

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
  private blocksCache: Map<string, string[]> = new Map();

  constructor(config?: Partial<PoAConfig>) {
    this.config = {
      validatorUsername: config?.validatorUsername || "validator-police",
      spkNodeUrl: config?.spkNodeUrl || process.env.SPK_POA_URL,
      ipfsApiUrl: config?.ipfsApiUrl || process.env.IPFS_API_URL,
      challengeIntervalMs: config?.challengeIntervalMs || 5000,
      useMockMode: config?.useMockMode ?? !process.env.SPK_POA_URL,
      broadcastToHive: config?.broadcastToHive ?? !!process.env.HIVE_POSTING_KEY,
    };
    this.ipfsClient = getIPFSClient();
    this.hiveClient = createHiveClient({ username: this.config.validatorUsername });
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

  private async runChallenge() {
    if (!this.validatorId) return;

    const nodes = await storage.getAllStorageNodes();
    if (nodes.length === 0) return;

    const randomNode = nodes[Math.floor(Math.random() * nodes.length)];

    const files = await storage.getAllFiles();
    if (files.length === 0) return;

    const randomFile = files[Math.floor(Math.random() * files.length)];

    const salt = createRandomHash();
    const challengeData = JSON.stringify({ 
      salt, 
      cid: randomFile.cid,
      method: this.config.useMockMode ? "simulation" : "spk-poa",
    });

    const challenge = await storage.createPoaChallenge({
      validatorId: this.validatorId,
      nodeId: randomNode.id,
      fileId: randomFile.id,
      challengeData,
      response: null,
      result: null,
      latencyMs: null,
    });

    if (this.config.useMockMode) {
      await this.processSimulatedChallenge(challenge.id, randomNode.id, randomFile.id, salt);
    } else {
      await this.processSPKChallenge(challenge.id, randomNode.id, randomFile.id, randomFile.cid, salt);
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

      if (this.spkClient && 'validate' in this.spkClient) {
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
        response = "NO_SPK_CLIENT";
        latencyMs = Date.now() - startTime;
      }
    } catch (err) {
      console.error(`[PoA Engine] SPK validation error:`, err);
      result = "fail";
      response = err instanceof Error ? err.message : "UNKNOWN_ERROR";
      latencyMs = Date.now() - startTime;
    }

    await this.recordChallengeResult(challengeId, nodeId, fileId, response, result, latencyMs);
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

    await storage.updateChallengeResult(challengeId, response, result, latencyMs);
    await storage.updateAssignmentProof(fileId, nodeId, result === "success");

    const newReputation = result === "success"
      ? Math.min(100, node.reputation + 1)
      : Math.max(0, node.reputation - 5);

    const newStatus = newReputation < 10 
      ? "banned" 
      : newReputation < 30 
      ? "probation" 
      : "active";

    await storage.updateStorageNodeReputation(node.id, newReputation, newStatus);

    console.log(`[PoA] Challenge ${result}: ${node.hiveUsername} (Rep: ${node.reputation} -> ${newReputation})`);

    const file = await storage.getFile(fileId);
    const cid = file?.cid || "";

    if (this.config.broadcastToHive) {
      try {
        if (result === "fail") {
          await this.hiveClient.broadcastReputationUpdate(
            node.hiveUsername,
            node.reputation,
            newReputation,
            "Failed PoA challenge"
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
          reason: "Failed PoA challenge",
          oldRep: node.reputation,
          newRep: newReputation,
        }),
        blockNumber: Math.floor(Date.now() / 1000),
      });
    } else {
      await storage.createHiveTransaction({
        type: "hbd_transfer",
        fromUser: this.config.validatorUsername,
        toUser: node.hiveUsername,
        payload: JSON.stringify({
          amount: "0.001 HBD",
          memo: `PoA Reward`,
        }),
        blockNumber: Math.floor(Date.now() / 1000),
      });
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
