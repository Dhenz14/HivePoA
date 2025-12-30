import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { hiveSimulator } from "./services/hive-simulator";
import { poaEngine } from "./services/poa-engine";
import { cdnManager } from "./services/cdn-manager";
import { uploadManager } from "./services/upload-manager";
import { transcodingService } from "./services/transcoding-service";
import { blocklistService } from "./services/blocklist-service";
import { encryptionService } from "./services/encryption-service";
import { autoPinService } from "./services/auto-pin-service";
import { beneficiaryService } from "./services/beneficiary-service";
import { ipfsGateway } from "./services/ipfs-gateway";
import { WebSocketServer } from "ws";
import { insertFileSchema, insertValidatorBlacklistSchema } from "@shared/schema";
import { z } from "zod";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // WebSocket for real-time updates
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  
  wss.on("connection", (ws) => {
    console.log("[WebSocket] Client connected");

    storage.getRecentTransactions(10).then((txs) => {
      ws.send(JSON.stringify({ type: "transactions", data: txs }));
    });

    const handleTransaction = (event: any) => {
      ws.send(JSON.stringify({ type: "hive_event", data: event }));
    };

    hiveSimulator.on("transaction", handleTransaction);

    ws.on("close", () => {
      hiveSimulator.off("transaction", handleTransaction);
      console.log("[WebSocket] Client disconnected");
    });
  });

  // Start background services
  hiveSimulator.start();
  poaEngine.start("validator-police");
  cdnManager.start();
  transcodingService.start();
  autoPinService.start();

  // Seed initial data for new features
  await cdnManager.seedSimulatedNodes();
  await transcodingService.seedEncoderNodes();
  await blocklistService.seedDefaultTags();
  await blocklistService.seedPlatformBlocklists();

  // ============================================================
  // IPFS Gateway API (Phase 1)
  // ============================================================
  
  app.get("/ipfs/:cid", ipfsGateway.createMiddleware());
  app.get("/ipfs/:cid/*", ipfsGateway.createMiddleware());

  app.get("/api/gateway/stats", async (req, res) => {
    const stats = await ipfsGateway.getStats();
    res.json(stats);
  });

  // ============================================================
  // CDN Nodes API (Phase 1)
  // ============================================================
  
  app.get("/api/cdn/nodes", async (req, res) => {
    const nodes = await storage.getActiveCdnNodes();
    res.json(nodes);
  });

  app.get("/api/cdn/nodes/all", async (req, res) => {
    const nodes = await storage.getAllCdnNodes();
    res.json(nodes);
  });

  app.get("/api/cdn/recommend/:cid", async (req, res) => {
    const region = req.query.region as string | undefined;
    const recommendations = await cdnManager.getRecommendedNodes(req.params.cid, region);
    res.json(recommendations);
  });

  app.post("/api/cdn/heartbeat/:nodeId", async (req, res) => {
    try {
      const { latency, requestCount } = req.body;
      await cdnManager.processHeartbeat(req.params.nodeId, { latency, requestCount });
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // ============================================================
  // Chunked Upload API (Phase 1)
  // ============================================================
  
  app.post("/api/upload/init", async (req, res) => {
    try {
      const schema = z.object({
        expectedCid: z.string(),
        fileName: z.string(),
        fileSize: z.number().positive(),
        uploaderUsername: z.string(),
        replicationCount: z.number().optional(),
        durationDays: z.number().optional(),
        hbdBudget: z.string().optional(),
      });
      const data = schema.parse(req.body);
      const session = await uploadManager.initializeUpload(data);
      res.json(session);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/upload/:sessionId/chunk/:chunkIndex", async (req, res) => {
    try {
      const chunkIndex = parseInt(req.params.chunkIndex);
      const data = req.body as Buffer;
      const result = await uploadManager.uploadChunk(req.params.sessionId, chunkIndex, data);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/upload/:sessionId/status", async (req, res) => {
    const status = await uploadManager.getUploadStatus(req.params.sessionId);
    res.json(status);
  });

  app.post("/api/upload/:sessionId/complete", async (req, res) => {
    try {
      const result = await uploadManager.completeUpload(req.params.sessionId);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/upload/:sessionId", async (req, res) => {
    const cancelled = await uploadManager.cancelUpload(req.params.sessionId);
    res.json({ success: cancelled });
  });

  // ============================================================
  // Storage Contracts API (Phase 1)
  // ============================================================
  
  app.get("/api/contracts", async (req, res) => {
    const contracts = await storage.getAllStorageContracts();
    res.json(contracts);
  });

  app.get("/api/contracts/active", async (req, res) => {
    const contracts = await storage.getActiveStorageContracts();
    res.json(contracts);
  });

  app.get("/api/contracts/:id", async (req, res) => {
    const contract = await storage.getStorageContract(req.params.id);
    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }
    res.json(contract);
  });

  app.get("/api/contracts/:id/events", async (req, res) => {
    const events = await storage.getContractEvents(req.params.id);
    res.json(events);
  });

  // ============================================================
  // Transcoding API (Phase 2)
  // ============================================================
  
  app.get("/api/transcode/presets", (req, res) => {
    res.json(transcodingService.getPresets());
  });

  app.post("/api/transcode/submit", async (req, res) => {
    try {
      const schema = z.object({
        fileId: z.string(),
        inputCid: z.string(),
        preset: z.string(),
        requestedBy: z.string(),
      });
      const data = schema.parse(req.body);
      const job = await transcodingService.submitJob(data);
      res.json(job);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/transcode/jobs/:fileId", async (req, res) => {
    const jobs = await storage.getTranscodeJobsByFile(req.params.fileId);
    res.json(jobs);
  });

  app.get("/api/transcode/job/:id", async (req, res) => {
    const status = await transcodingService.getJobStatus(req.params.id);
    res.json(status);
  });

  app.get("/api/transcode/estimate", (req, res) => {
    const fileSize = parseInt(req.query.fileSize as string) || 0;
    const preset = req.query.preset as string || 'mp4-720p';
    const estimate = transcodingService.estimateCost(fileSize, preset);
    res.json(estimate);
  });

  app.get("/api/encoders", async (req, res) => {
    const encoders = await storage.getAllEncoderNodes();
    res.json(encoders);
  });

  app.get("/api/encoders/available", async (req, res) => {
    const encoders = await storage.getAvailableEncoderNodes();
    res.json(encoders);
  });

  // ============================================================
  // Blocklist API (Phase 3)
  // ============================================================
  
  app.get("/api/blocklist/:scope", async (req, res) => {
    const scopeOwnerId = req.query.ownerId as string | undefined;
    const entries = await blocklistService.getBlocklist(req.params.scope as any, scopeOwnerId);
    res.json(entries);
  });

  app.post("/api/blocklist", async (req, res) => {
    try {
      const schema = z.object({
        scope: z.enum(['local', 'validator', 'platform']),
        scopeOwnerId: z.string(),
        targetType: z.enum(['account', 'cid', 'ipfs_hash', 'ssdeep_hash', 'tag']),
        targetValue: z.string(),
        reason: z.string().optional(),
        severity: z.enum(['low', 'moderate', 'severe', 'critical']).optional(),
      });
      const data = schema.parse(req.body);
      const entry = await blocklistService.addToBlocklist(data);
      res.json(entry);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/blocklist/:id", async (req, res) => {
    await blocklistService.removeFromBlocklist(req.params.id);
    res.json({ success: true });
  });

  app.post("/api/blocklist/check", async (req, res) => {
    try {
      const schema = z.object({
        targetType: z.enum(['account', 'cid', 'ipfs_hash', 'ssdeep_hash', 'tag']),
        targetValue: z.string(),
        username: z.string().optional(),
        platformId: z.string().optional(),
        validatorId: z.string().optional(),
      });
      const data = schema.parse(req.body);
      const result = await blocklistService.checkBlocked({
        targetType: data.targetType,
        targetValue: data.targetValue,
        userScopes: {
          username: data.username,
          platformId: data.platformId,
          validatorId: data.validatorId,
        },
      });
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // ============================================================
  // Tags API (Phase 3)
  // ============================================================
  
  app.get("/api/tags", async (req, res) => {
    const tags = await storage.getAllTags();
    res.json(tags);
  });

  app.get("/api/files/:fileId/tags", async (req, res) => {
    const fileTags = await storage.getFileTags(req.params.fileId);
    res.json(fileTags);
  });

  app.post("/api/files/:fileId/tags", async (req, res) => {
    try {
      const schema = z.object({
        tagLabel: z.string(),
        addedBy: z.string(),
      });
      const data = schema.parse(req.body);
      const fileTag = await blocklistService.addTagToFile({
        fileId: req.params.fileId,
        tagLabel: data.tagLabel,
        addedBy: data.addedBy,
      });
      res.json(fileTag);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/tags/:fileTagId/vote", async (req, res) => {
    try {
      const schema = z.object({
        voterUsername: z.string(),
        voteType: z.enum(['up', 'down']),
        voterReputation: z.number().optional(),
      });
      const data = schema.parse(req.body);
      await blocklistService.voteOnTag({
        fileTagId: req.params.fileTagId,
        voterUsername: data.voterUsername,
        voteType: data.voteType,
        voterReputation: data.voterReputation,
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/platforms", async (req, res) => {
    const platforms = await storage.getAllPlatformBlocklists();
    res.json(platforms);
  });

  // ============================================================
  // Encryption API (Phase 4)
  // ============================================================
  
  app.post("/api/encryption/generate-key", (req, res) => {
    const key = encryptionService.generateKey();
    res.json({ key });
  });

  app.post("/api/encryption/derive-key", (req, res) => {
    try {
      const schema = z.object({
        password: z.string(),
        salt: z.string().optional(),
      });
      const data = schema.parse(req.body);
      const result = encryptionService.deriveKeyFromPassword(data.password, data.salt);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/encryption/keys/:username", async (req, res) => {
    const keys = await encryptionService.getUserKeys(req.params.username);
    res.json(keys);
  });

  app.post("/api/encryption/keys", async (req, res) => {
    try {
      const schema = z.object({
        username: z.string(),
        publicKey: z.string(),
      });
      const data = schema.parse(req.body);
      const key = await encryptionService.storePublicKey(data.username, data.publicKey);
      res.json(key);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // ============================================================
  // Auto-Pin API (Phase 4)
  // ============================================================
  
  app.get("/api/settings/:username", async (req, res) => {
    const settings = await autoPinService.getUserSettings(req.params.username);
    res.json(settings);
  });

  app.put("/api/settings/:username", async (req, res) => {
    try {
      const schema = z.object({
        autoPinEnabled: z.boolean().optional(),
        autoPinMode: z.enum(["off", "all", "daily_limit"]).optional(),
        autoPinDailyLimit: z.number().optional(),
        autoPinThreshold: z.number().optional(),
        maxAutoPinSize: z.string().optional(),
        encryptByDefault: z.boolean().optional(),
      });
      const data = schema.parse(req.body);
      const settings = await autoPinService.updateUserSettings(req.params.username, data);
      res.json(settings);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/view", async (req, res) => {
    try {
      const schema = z.object({
        fileId: z.string(),
        viewerUsername: z.string(),
        viewDurationMs: z.number(),
        completed: z.boolean(),
      });
      const data = schema.parse(req.body);
      const event = await autoPinService.recordView(data);
      res.json(event);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/autopin/stats/:username", async (req, res) => {
    const stats = await autoPinService.getAutoPinStats(req.params.username);
    res.json(stats);
  });

  // ============================================================
  // Beneficiary API (Phase 4)
  // ============================================================
  
  app.get("/api/beneficiaries/:username", async (req, res) => {
    const result = await beneficiaryService.getBeneficiaries(req.params.username);
    res.json(result);
  });

  app.post("/api/beneficiaries", async (req, res) => {
    try {
      const schema = z.object({
        fromUsername: z.string(),
        toNodeId: z.string(),
        percentage: z.number().positive().max(100),
      });
      const data = schema.parse(req.body);
      const allocation = await beneficiaryService.addBeneficiary(data);
      res.json(allocation);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.put("/api/beneficiaries/:id", async (req, res) => {
    try {
      const schema = z.object({
        percentage: z.number().positive().max(100),
        fromUsername: z.string(),
      });
      const data = schema.parse(req.body);
      await beneficiaryService.updateBeneficiary({
        allocationId: req.params.id,
        percentage: data.percentage,
        fromUsername: data.fromUsername,
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/beneficiaries/:id", async (req, res) => {
    await beneficiaryService.removeBeneficiary(req.params.id);
    res.json({ success: true });
  });

  app.get("/api/payouts/:username", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const history = await beneficiaryService.getPayoutHistory(req.params.username, limit);
    res.json(history);
  });

  app.get("/api/earnings/:username", async (req, res) => {
    const earnings = await beneficiaryService.getTotalEarnings(req.params.username);
    res.json(earnings);
  });

  app.post("/api/payouts/calculate", async (req, res) => {
    try {
      const schema = z.object({
        fromUsername: z.string(),
        totalHbd: z.string(),
        payoutType: z.enum(['storage', 'encoding', 'beneficiary', 'validation']),
      });
      const data = schema.parse(req.body);
      const splits = await beneficiaryService.calculateSplits(data);
      res.json(splits);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // ============================================================
  // Original Core APIs
  // ============================================================
  
  // Files API
  app.get("/api/files", async (req, res) => {
    const files = await storage.getAllFiles();
    res.json(files);
  });

  app.get("/api/files/:cid", async (req, res) => {
    const file = await storage.getFileByCid(req.params.cid);
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }
    res.json(file);
  });

  app.post("/api/files", async (req, res) => {
    try {
      const data = insertFileSchema.parse(req.body);
      const file = await storage.createFile(data);

      await storage.createHiveTransaction({
        type: "spk_video_upload",
        fromUser: data.uploaderUsername,
        toUser: null,
        payload: JSON.stringify({
          cid: data.cid,
          name: data.name,
          size: data.size,
        }),
        blockNumber: Math.floor(Date.now() / 1000),
      });

      res.json(file);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/files/:id", async (req, res) => {
    try {
      const file = await storage.getFile(req.params.id);
      if (!file) {
        return res.status(404).json({ error: "File not found" });
      }
      
      const deleted = await storage.deleteFile(req.params.id);
      if (deleted) {
        await storage.createHiveTransaction({
          type: "spk_video_unpin",
          fromUser: file.uploaderUsername,
          toUser: null,
          payload: JSON.stringify({
            cid: file.cid,
            name: file.name,
            reason: "User requested deletion",
          }),
          blockNumber: Math.floor(Date.now() / 1000),
        });
        res.json({ success: true, message: "File unpinned and deleted" });
      } else {
        res.status(500).json({ error: "Failed to delete file" });
      }
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // Storage Nodes API
  app.get("/api/nodes", async (req, res) => {
    const search = req.query.search as string | undefined;
    if (search) {
      const nodes = await storage.searchStorageNodes(search);
      res.json(nodes);
    } else {
      const nodes = await storage.getAllStorageNodes();
      res.json(nodes);
    }
  });

  app.get("/api/nodes/:peerId", async (req, res) => {
    const node = await storage.getStorageNodeByPeerId(req.params.peerId);
    if (!node) {
      return res.status(404).json({ error: "Node not found" });
    }
    res.json(node);
  });

  // Validators API
  app.get("/api/validators", async (req, res) => {
    const validators = await storage.getAllValidators();
    res.json(validators);
  });

  app.get("/api/validators/:username", async (req, res) => {
    const validator = await storage.getValidatorByUsername(req.params.username);
    if (!validator) {
      return res.status(404).json({ error: "Validator not found" });
    }
    res.json(validator);
  });

  // Validator Blacklist API
  app.get("/api/validators/:username/blacklist", async (req, res) => {
    const validator = await storage.getValidatorByUsername(req.params.username);
    if (!validator) {
      return res.status(404).json({ error: "Validator not found" });
    }
    const blacklist = await storage.getValidatorBlacklist(validator.id);
    res.json(blacklist);
  });

  app.post("/api/validators/:username/blacklist", async (req, res) => {
    try {
      const validator = await storage.getValidatorByUsername(req.params.username);
      if (!validator) {
        return res.status(404).json({ error: "Validator not found" });
      }
      
      const schema = z.object({
        nodeId: z.string(),
        reason: z.string().min(1),
      });
      const { nodeId, reason } = schema.parse(req.body);
      
      const node = await storage.getStorageNode(nodeId);
      if (!node) {
        return res.status(404).json({ error: "Storage node not found" });
      }
      
      const isBlacklisted = await storage.isNodeBlacklisted(validator.id, nodeId);
      if (isBlacklisted) {
        return res.status(409).json({ error: "Node is already blacklisted" });
      }
      
      const entry = await storage.addToBlacklist({
        validatorId: validator.id,
        nodeId,
        reason,
        active: true,
      });
      
      res.json(entry);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/validators/:username/blacklist/:nodeId", async (req, res) => {
    const validator = await storage.getValidatorByUsername(req.params.username);
    if (!validator) {
      return res.status(404).json({ error: "Validator not found" });
    }
    
    await storage.removeFromBlacklist(validator.id, req.params.nodeId);
    res.json({ success: true });
  });

  // PoA Challenges API
  app.get("/api/challenges", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const challenges = await storage.getRecentChallenges(limit);
    res.json(challenges);
  });

  // Hive Transactions API
  app.get("/api/transactions", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const transactions = await storage.getRecentTransactions(limit);
    res.json(transactions);
  });

  // Dashboard Stats API
  app.get("/api/stats", async (req, res) => {
    const [files, nodes, validators, challenges, transactions, cdnNodes, contracts, encoders] = await Promise.all([
      storage.getAllFiles(),
      storage.getAllStorageNodes(),
      storage.getAllValidators(),
      storage.getRecentChallenges(100),
      storage.getRecentTransactions(24 * 60),
      storage.getAllCdnNodes(),
      storage.getAllStorageContracts(),
      storage.getAllEncoderNodes(),
    ]);

    const totalProofs = challenges.filter(c => c.result === "success").length;
    const failedProofs = challenges.filter(c => c.result === "fail").length;
    const successRate = totalProofs + failedProofs > 0 
      ? (totalProofs / (totalProofs + failedProofs) * 100).toFixed(1)
      : "0.0";

    const hbdTransfers = transactions.filter(t => t.type === "hbd_transfer");
    const totalPayouts = hbdTransfers.length * 0.001;

    res.json({
      files: {
        total: files.length,
        pinned: files.filter(f => f.status === "pinned").length,
        syncing: files.filter(f => f.status === "syncing").length,
      },
      nodes: {
        total: nodes.length,
        active: nodes.filter(n => n.status === "active").length,
        probation: nodes.filter(n => n.status === "probation").length,
        banned: nodes.filter(n => n.status === "banned").length,
      },
      validators: {
        total: validators.length,
        online: validators.filter(v => v.status === "online").length,
      },
      challenges: {
        total: challenges.length,
        success: totalProofs,
        failed: failedProofs,
        successRate,
      },
      rewards: {
        totalHBD: totalPayouts.toFixed(3),
        transactions: hbdTransfers.length,
      },
      cdn: {
        total: cdnNodes.length,
        active: cdnNodes.filter(n => n.status === "active").length,
      },
      contracts: {
        total: contracts.length,
        active: contracts.filter(c => c.status === "active").length,
      },
      encoders: {
        total: encoders.length,
        available: encoders.filter(e => e.availability === "available").length,
      },
    });
  });

  return httpServer;
}
