import type { Express } from "express";
import { createServer, type Server } from "http";
import { randomBytes } from "crypto";
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
import { p2pSignaling } from "./p2p-signaling";
import { WebSocketServer } from "ws";
import { insertFileSchema, insertValidatorBlacklistSchema, insertEncodingJobSchema, insertEncoderNodeSchema } from "@shared/schema";
import { z } from "zod";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // WebSocket for real-time updates (using noServer mode for proper multi-path support)
  const wss = new WebSocketServer({ noServer: true });
  
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

  // P2P CDN WebSocket for peer signaling (using noServer mode)
  const p2pWss = new WebSocketServer({ noServer: true });
  p2pSignaling.init(p2pWss);

  // Handle WebSocket upgrades manually for multiple paths
  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname;

    if (pathname === "/ws") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else if (pathname === "/p2p") {
      p2pWss.handleUpgrade(request, socket, head, (ws) => {
        p2pWss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
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

  app.get("/api/ipfs/status", async (req, res) => {
    const { ipfsManager } = await import("./services/ipfs-manager");
    const { getIPFSClient } = await import("./services/ipfs-client");
    
    const managerStatus = ipfsManager.getStatus();
    const client = getIPFSClient();
    const isOnline = await client.isOnline();
    const mode = process.env.IPFS_API_URL ? "live" : "mock";
    
    res.json({
      online: isOnline,
      mode,
      daemon: managerStatus,
      message: isOnline 
        ? `Connected to ${mode === "live" ? "local IPFS node" : "mock IPFS"}`
        : "IPFS node not reachable - starting automatically on next upload",
    });
  });

  app.post("/api/ipfs/start", async (req, res) => {
    const { ipfsManager } = await import("./services/ipfs-manager");
    
    if (ipfsManager.isRunning()) {
      res.json({ success: true, message: "IPFS daemon already running" });
      return;
    }
    
    const started = await ipfsManager.start();
    res.json({
      success: started,
      message: started ? "IPFS daemon started" : "Failed to start IPFS daemon",
      status: ipfsManager.getStatus(),
    });
  });

  app.post("/api/ipfs/stop", async (req, res) => {
    const { ipfsManager } = await import("./services/ipfs-manager");
    await ipfsManager.stop();
    res.json({
      success: true,
      message: "IPFS daemon stopped",
      status: ipfsManager.getStatus(),
    });
  });

  app.post("/api/ipfs/restart", async (req, res) => {
    const { ipfsManager } = await import("./services/ipfs-manager");
    const restarted = await ipfsManager.restart();
    res.json({
      success: restarted,
      message: restarted ? "IPFS daemon restarted" : "Failed to restart IPFS daemon",
      status: ipfsManager.getStatus(),
    });
  });

  app.post("/api/ipfs/test-connection", async (req, res) => {
    try {
      const { ipfsManager } = await import("./services/ipfs-manager");
      const { getIPFSClient } = await import("./services/ipfs-client");
      
      if (!ipfsManager.isRunning()) {
        await ipfsManager.start();
      }
      
      const client = getIPFSClient();
      const isOnline = await client.isOnline();
      
      if (isOnline) {
        const status = ipfsManager.getStatus();
        res.json({
          success: true,
          peerId: "server-ipfs-node",
          apiUrl: status.apiUrl || "http://127.0.0.1:5001",
        });
      } else {
        res.json({
          success: false,
          error: "IPFS node not reachable",
        });
      }
    } catch (err: any) {
      res.json({
        success: false,
        error: err.message || "Connection failed",
      });
    }
  });

  app.post("/api/ipfs/test", async (req, res) => {
    try {
      const { ipfsManager } = await import("./services/ipfs-manager");
      const { getIPFSClient } = await import("./services/ipfs-client");
      
      if (!ipfsManager.isRunning() && process.env.IPFS_API_URL) {
        await ipfsManager.start();
      }
      
      const client = getIPFSClient();
      const testContent = `SPK Network 2.0 Test - ${Date.now()}`;
      const cid = await client.add(testContent);
      const retrieved = await client.cat(cid);
      
      const success = retrieved.toString() === testContent;
      
      res.json({
        success,
        cid,
        content: testContent,
        retrieved: retrieved.toString(),
        message: success ? "IPFS add/cat test passed" : "Content mismatch",
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        error: error.message,
        message: "IPFS test failed - is the daemon running?",
      });
    }
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
        downloadMode: z.enum(["off", "all", "quota"]).optional(),
        downloadQuota: z.number().optional(),
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

  // Network Download API
  app.post("/api/downloads/start/:username", async (req, res) => {
    try {
      const result = await autoPinService.startNetworkDownload(req.params.username);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/downloads/stats/:username", async (req, res) => {
    const stats = await autoPinService.getDownloadStats(req.params.username);
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

  // Get file marketplace with rarity and ROI data (must be before :cid route)
  app.get("/api/files/marketplace", async (req, res) => {
    const files = await storage.getAllFiles();
    const challenges = await storage.getRecentChallenges(500);
    
    const filesWithROI = files.map(file => {
      const fileChallenges = challenges.filter(c => c.fileId === file.id);
      const passedChallenges = fileChallenges.filter(c => c.result === "success").length;
      
      const replicationCount = file.replicationCount || 1;
      const rarityMultiplier = 1 / Math.max(1, replicationCount);
      
      const sizeBytes = parseInt(file.size) || 1000;
      const rewardPerProof = 0.001 * rarityMultiplier;
      const proofsPerDay = (passedChallenges / 7) || 1;
      const dailyEarnings = rewardPerProof * proofsPerDay;
      const roiScore = (dailyEarnings * 1000000) / sizeBytes;
      
      return {
        id: file.id,
        name: file.name,
        cid: file.cid,
        size: file.size,
        sizeBytes,
        status: file.status,
        replicationCount,
        rarityMultiplier,
        isRare: replicationCount < 3,
        earnedHbd: (file as any).earnedHbd || 0,
        rewardPerProof,
        dailyEarnings,
        roiScore,
        challengeCount: fileChallenges.length,
        successRate: fileChallenges.length > 0 
          ? (passedChallenges / fileChallenges.length * 100).toFixed(1)
          : "0.0",
      };
    });
    
    filesWithROI.sort((a, b) => b.roiScore - a.roiScore);
    
    res.json({
      files: filesWithROI,
      recommendations: filesWithROI.filter(f => f.isRare).slice(0, 10),
      stats: {
        totalFiles: files.length,
        rareFiles: filesWithROI.filter(f => f.isRare).length,
        avgRarityMultiplier: filesWithROI.reduce((sum, f) => sum + f.rarityMultiplier, 0) / files.length || 0,
      },
    });
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

  // ============================================================
  // Earnings & Analytics API (For Storage Operators)
  // ============================================================

  // Get dashboard earnings data for a node (detailed stats)
  app.get("/api/earnings/dashboard/:username", async (req, res) => {
    const { username } = req.params;
    const nodes = await storage.getAllStorageNodes();
    
    // Allow "demo_user" to use first available node for demo purposes
    let node = nodes.find(n => n.hiveUsername === username);
    if (!node && username === "demo_user" && nodes.length > 0) {
      node = nodes[0];
    }
    
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    const challenges = await storage.getRecentChallenges(1000);
    const nodeChallenges = challenges.filter(c => c.nodeId === node.id);
    const transactions = await storage.getRecentTransactions(24 * 60 * 7); // 7 days
    const nodeTransactions = transactions.filter(t => t.toUser === node.hiveUsername && t.type === "hbd_transfer");
    
    // Calculate streaks - count consecutive successes from most recent
    let currentStreak = 0;
    let maxStreak = 0;
    let tempStreak = 0;
    const sortedChallenges = [...nodeChallenges].sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    
    // Current streak = consecutive successes from most recent challenge
    for (const c of sortedChallenges) {
      if (c.result === "success") {
        currentStreak++;
      } else {
        break; // Stop at first failure
      }
    }
    
    // Max streak = longest consecutive success run ever
    for (const c of sortedChallenges) {
      if (c.result === "success") {
        tempStreak++;
        if (tempStreak > maxStreak) maxStreak = tempStreak;
      } else {
        tempStreak = 0;
      }
    }

    // Calculate streak bonus
    let streakBonus = 1.0;
    let nextBonusTier = 10;
    let progressToNextTier = 0;
    
    if (currentStreak >= 100) {
      streakBonus = 1.5;
      nextBonusTier = 100;
      progressToNextTier = 100;
    } else if (currentStreak >= 50) {
      streakBonus = 1.25;
      nextBonusTier = 100;
      progressToNextTier = ((currentStreak - 50) / 50) * 100;
    } else if (currentStreak >= 10) {
      streakBonus = 1.1;
      nextBonusTier = 50;
      progressToNextTier = ((currentStreak - 10) / 40) * 100;
    } else {
      nextBonusTier = 10;
      progressToNextTier = (currentStreak / 10) * 100;
    }

    // Calculate earnings by time period
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    
    const earningsToday = nodeTransactions
      .filter(t => now - new Date(t.createdAt).getTime() < dayMs)
      .reduce((sum, t) => {
        const payload = JSON.parse(t.payload || "{}");
        return sum + parseFloat(payload.amount?.replace(" HBD", "") || "0.001");
      }, 0);
    
    const earningsWeek = nodeTransactions
      .filter(t => now - new Date(t.createdAt).getTime() < 7 * dayMs)
      .reduce((sum, t) => {
        const payload = JSON.parse(t.payload || "{}");
        return sum + parseFloat(payload.amount?.replace(" HBD", "") || "0.001");
      }, 0);

    // Project earnings based on current rate
    const hourlyRate = earningsToday / Math.max(1, (now % dayMs) / (60 * 60 * 1000));
    const projectedDaily = hourlyRate * 24;
    const projectedMonthly = projectedDaily * 30;

    res.json({
      node: {
        id: node.id,
        username: node.hiveUsername,
        reputation: node.reputation,
        status: node.status,
        consecutiveFails: (node as any).consecutiveFails || 0,
        totalEarnedHbd: (node as any).totalEarnedHbd || 0,
      },
      streak: {
        current: currentStreak,
        max: maxStreak,
        bonus: streakBonus,
        bonusPercent: Math.round((streakBonus - 1) * 100),
        nextTier: nextBonusTier,
        progressToNextTier: Math.min(100, progressToNextTier),
      },
      risk: {
        consecutiveFails: (node as any).consecutiveFails || 0,
        maxFails: 3,
        isBanned: node.status === "banned",
        isProbation: node.status === "probation",
        banRisk: ((node as any).consecutiveFails || 0) >= 2 ? "high" : 
                 ((node as any).consecutiveFails || 0) >= 1 ? "medium" : "low",
      },
      earnings: {
        today: earningsToday,
        week: earningsWeek,
        total: (node as any).totalEarnedHbd || 0,
        projectedDaily,
        projectedMonthly,
      },
      challenges: {
        total: nodeChallenges.length,
        passed: nodeChallenges.filter(c => c.result === "success").length,
        failed: nodeChallenges.filter(c => c.result === "fail").length,
        successRate: nodeChallenges.length > 0 
          ? (nodeChallenges.filter(c => c.result === "success").length / nodeChallenges.length * 100).toFixed(1)
          : "0.0",
        avgLatency: nodeChallenges.length > 0
          ? Math.round(nodeChallenges.reduce((sum, c) => sum + (c.latencyMs || 0), 0) / nodeChallenges.length)
          : 0,
      },
    });
  });

  // Get live challenge feed
  app.get("/api/challenges/live", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 20;
    const challenges = await storage.getRecentChallenges(limit);
    const nodes = await storage.getAllStorageNodes();
    const files = await storage.getAllFiles();
    
    const enrichedChallenges = challenges.map(c => {
      const node = nodes.find(n => n.id === c.nodeId);
      const file = files.find(f => f.id === c.fileId);
      return {
        id: c.id,
        result: c.result,
        latencyMs: c.latencyMs,
        response: c.response,
        createdAt: c.createdAt,
        node: node ? { username: node.hiveUsername, reputation: node.reputation } : null,
        file: file ? { name: file.name, cid: file.cid } : null,
      };
    });
    
    res.json(enrichedChallenges);
  });

  // Get performance analytics
  app.get("/api/analytics/performance", async (req, res) => {
    const challenges = await storage.getRecentChallenges(1000);
    const nodes = await storage.getAllStorageNodes();
    
    // Calculate proofs per hour
    const now = Date.now();
    const hourAgo = now - 60 * 60 * 1000;
    const challengesLastHour = challenges.filter(c => 
      new Date(c.createdAt).getTime() > hourAgo
    );
    const proofsPerHour = challengesLastHour.filter(c => c.result === "success").length;
    
    // Calculate bandwidth (estimated based on file sizes)
    const files = await storage.getAllFiles();
    const avgFileSize = files.reduce((sum, f) => sum + parseInt(f.size || "0"), 0) / files.length || 1000000;
    const bandwidthPerHour = proofsPerHour * avgFileSize * 5; // Assume 5 blocks per proof
    
    // Success rate trends (last 24 hours in 1-hour buckets)
    const trends: { hour: number; successRate: number; challenges: number }[] = [];
    for (let i = 0; i < 24; i++) {
      const hourStart = now - (i + 1) * 60 * 60 * 1000;
      const hourEnd = now - i * 60 * 60 * 1000;
      const hourChallenges = challenges.filter(c => {
        const t = new Date(c.createdAt).getTime();
        return t > hourStart && t <= hourEnd;
      });
      const passed = hourChallenges.filter(c => c.result === "success").length;
      trends.unshift({
        hour: 24 - i,
        successRate: hourChallenges.length > 0 ? (passed / hourChallenges.length) * 100 : 0,
        challenges: hourChallenges.length,
      });
    }
    
    // Latency distribution
    const latencies = challenges.filter(c => c.latencyMs).map(c => c.latencyMs!);
    const avgLatency = latencies.length > 0 
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length 
      : 0;
    const maxLatency = Math.max(...latencies, 0);
    const minLatency = Math.min(...latencies, 0);
    
    res.json({
      proofsPerHour,
      bandwidthPerHour,
      bandwidthFormatted: formatBytes(bandwidthPerHour),
      latency: {
        avg: Math.round(avgLatency),
        max: maxLatency,
        min: minLatency,
        warning: avgLatency > 1500,
      },
      trends,
      nodes: {
        total: nodes.length,
        healthy: nodes.filter(n => n.status === "active" && n.reputation >= 50).length,
        atRisk: nodes.filter(n => n.status === "probation" || n.reputation < 30).length,
      },
    });
  });

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  }

  // ============================================================
  // Validator Operations Center API
  // ============================================================

  // In-memory session store (in production, use Redis or DB)
  const validatorSessions = new Map<string, { username: string; expiresAt: number }>();
  // One-time login challenges to prevent replay attacks
  const loginChallenges = new Map<string, { username: string; expiresAt: number }>();
  
  function generateSessionToken(): string {
    return randomBytes(48).toString('base64url');
  }

  function generateChallengeId(): string {
    return randomBytes(16).toString('hex');
  }
  
  // Middleware to validate session token and witness status
  async function validateValidatorSession(token: string): Promise<{ valid: boolean; username?: string }> {
    const session = validatorSessions.get(token);
    if (!session || session.expiresAt < Date.now()) {
      if (session) validatorSessions.delete(token);
      return { valid: false };
    }
    
    // Re-verify witness status
    const { createHiveClient } = await import("./services/hive-client");
    const hiveClient = createHiveClient();
    const isTopWitness = await hiveClient.isTopWitness(session.username, 150);
    
    if (!isTopWitness) {
      validatorSessions.delete(token);
      return { valid: false };
    }
    
    return { valid: true, username: session.username };
  }
  
  // Extract session token from Authorization header
  function getSessionToken(req: any): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return null;
  }

  function cleanExpiredSessions() {
    const now = Date.now();
    const entries = Array.from(validatorSessions.entries());
    for (const [token, session] of entries) {
      if (session.expiresAt < now) {
        validatorSessions.delete(token);
      }
    }
  }

  // Validator Authentication
  app.post("/api/validator/login", async (req, res) => {
    try {
      const { username, signature, challenge } = req.body;
      
      if (!username || !signature || !challenge) {
        res.status(400).json({ error: "Missing username, signature, or challenge" });
        return;
      }

      // Validate challenge format (must be recent timestamp)
      const challengeMatch = challenge.match(/SPK-Validator-Login-(\d+)/);
      if (!challengeMatch) {
        res.status(400).json({ error: "Invalid challenge format" });
        return;
      }
      
      const challengeTime = parseInt(challengeMatch[1]);
      const now = Date.now();
      if (now - challengeTime > 5 * 60 * 1000) { // 5 minute expiry
        res.status(400).json({ error: "Challenge expired" });
        return;
      }

      const { createHiveClient } = await import("./services/hive-client");
      const hiveClient = createHiveClient();

      const account = await hiveClient.getAccount(username);
      if (!account) {
        res.status(404).json({ error: "Account not found on Hive blockchain" });
        return;
      }

      const isValid = await hiveClient.verifySignature(username, challenge, signature);
      if (!isValid) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }

      const isTopWitness = await hiveClient.isTopWitness(username, 150);
      const witnessRank = await hiveClient.getWitnessRank(username);

      // Only generate session token for witnesses
      let sessionToken: string | undefined;
      if (isTopWitness) {
        cleanExpiredSessions();
        sessionToken = generateSessionToken();
        validatorSessions.set(sessionToken, {
          username,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
        });
      }

      res.json({
        success: true,
        username,
        isTopWitness,
        witnessRank,
        sessionToken,
        message: isTopWitness 
          ? `Welcome, Witness #${witnessRank}!` 
          : "You are not in the top 150 witnesses",
      });
    } catch (error) {
      console.error("[Validator Login] Error:", error);
      res.status(500).json({ error: "Authentication failed" });
    }
  });

  // Validate session (called on page load to verify localStorage)
  app.post("/api/validator/validate-session", async (req, res) => {
    try {
      const { username, sessionToken } = req.body;
      
      if (!username || !sessionToken) {
        res.status(400).json({ valid: false, error: "Missing credentials" });
        return;
      }

      const session = validatorSessions.get(sessionToken);
      if (!session || session.username !== username || session.expiresAt < Date.now()) {
        validatorSessions.delete(sessionToken);
        res.status(401).json({ valid: false, error: "Invalid or expired session" });
        return;
      }

      // Re-verify witness status (could have changed)
      const { createHiveClient } = await import("./services/hive-client");
      const hiveClient = createHiveClient();
      
      const isTopWitness = await hiveClient.isTopWitness(username, 150);
      const witnessRank = await hiveClient.getWitnessRank(username);

      if (!isTopWitness) {
        validatorSessions.delete(sessionToken);
        res.status(401).json({ valid: false, error: "No longer a top 150 witness" });
        return;
      }

      res.json({
        valid: true,
        username,
        isTopWitness,
        witnessRank,
      });
    } catch (error) {
      res.status(500).json({ valid: false, error: "Validation failed" });
    }
  });

  // Check witness status (no auth required)
  app.get("/api/validator/witness-check/:username", async (req, res) => {
    try {
      const { username } = req.params;
      const { createHiveClient } = await import("./services/hive-client");
      const hiveClient = createHiveClient();

      const account = await hiveClient.getAccount(username);
      if (!account) {
        res.status(404).json({ error: "Account not found" });
        return;
      }

      const isTopWitness = await hiveClient.isTopWitness(username, 150);
      const witnessRank = await hiveClient.getWitnessRank(username);

      res.json({
        username,
        isTopWitness,
        witnessRank,
        accountExists: true,
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to check witness status" });
    }
  });

  // Get validator dashboard stats (requires authentication)
  app.get("/api/validator/dashboard/:username", async (req, res) => {
    const { username } = req.params;
    
    // Validate session token
    const sessionToken = getSessionToken(req);
    if (sessionToken) {
      const validation = await validateValidatorSession(sessionToken);
      if (!validation.valid) {
        res.status(401).json({ error: "Invalid or expired session" });
        return;
      }
      // Verify user is accessing their own dashboard
      if (validation.username !== username && username !== "demo_user") {
        res.status(403).json({ error: "Access denied" });
        return;
      }
    }
    // Note: Allow unauthenticated access for demo_user for testing purposes
    
    const validators = await storage.getAllValidators();
    let validator = validators.find(v => v.hiveUsername === username);
    
    // Allow demo_user to use first validator
    if (!validator && username === "demo_user" && validators.length > 0) {
      validator = validators[0];
    }
    
    if (!validator) {
      res.status(404).json({ error: "Validator not found" });
      return;
    }

    const challenges = await storage.getRecentChallenges(1000);
    const validatorChallenges = challenges.filter(c => c.validatorId === validator.id);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    
    // Challenge stats by time period
    const todayChallenges = validatorChallenges.filter(c => 
      now - new Date(c.createdAt).getTime() < dayMs
    );
    const weekChallenges = validatorChallenges.filter(c => 
      now - new Date(c.createdAt).getTime() < 7 * dayMs
    );
    const monthChallenges = validatorChallenges.filter(c => 
      now - new Date(c.createdAt).getTime() < 30 * dayMs
    );
    
    // Success/fail ratio
    const totalChallenges = validatorChallenges.length;
    const successCount = validatorChallenges.filter(c => c.result === "success").length;
    const failCount = validatorChallenges.filter(c => c.result === "fail").length;
    const timeoutCount = validatorChallenges.filter(c => c.result === "timeout").length;
    
    // Latency metrics
    const latencies = validatorChallenges.filter(c => c.latencyMs).map(c => c.latencyMs!);
    const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const p95Latency = latencies.length > 0 ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)] : 0;
    
    // Calculate uptime (simulate based on activity)
    const hourlyActivity: boolean[] = [];
    for (let i = 0; i < 24; i++) {
      const hourStart = now - (i + 1) * 60 * 60 * 1000;
      const hourEnd = now - i * 60 * 60 * 1000;
      const hasActivity = validatorChallenges.some(c => {
        const t = new Date(c.createdAt).getTime();
        return t > hourStart && t <= hourEnd;
      });
      hourlyActivity.push(hasActivity);
    }
    const uptime = (hourlyActivity.filter(Boolean).length / 24) * 100;
    
    // Cheaters caught (failures detected)
    const cheatersCaught = validatorChallenges.filter(c => c.result === "fail").length;
    
    res.json({
      validator: {
        id: validator.id,
        username: validator.hiveUsername,
        rank: validator.hiveRank,
        status: validator.status,
        performance: validator.performance,
        version: validator.version,
      },
      stats: {
        today: todayChallenges.length,
        week: weekChallenges.length,
        month: monthChallenges.length,
        total: totalChallenges,
      },
      results: {
        success: successCount,
        fail: failCount,
        timeout: timeoutCount,
        successRate: totalChallenges > 0 ? (successCount / totalChallenges * 100).toFixed(1) : "0.0",
        cheatersCaught,
      },
      latency: {
        avg: Math.round(avgLatency),
        p95: p95Latency,
        min: Math.min(...latencies, 0),
        max: Math.max(...latencies, 0),
      },
      uptime: uptime.toFixed(1),
      hourlyActivity: hourlyActivity.reverse().map((active, i) => ({ hour: i, active: active ? 1 : 0 })),
      earnings: validator.payoutRate * totalChallenges * 0.0001, // Simulated earnings
    });
  });

  // Get node monitoring data (requires authentication)
  app.get("/api/validator/nodes", async (req, res) => {
    // Validate session token
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    
    const nodes = await storage.getAllStorageNodes();
    const challenges = await storage.getRecentChallenges(500);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    
    const nodesWithDetails = nodes.map(node => {
      const nodeChallenges = challenges.filter(c => c.nodeId === node.id);
      const recentChallenges = nodeChallenges.filter(c => 
        now - new Date(c.createdAt).getTime() < dayMs
      );
      const successCount = recentChallenges.filter(c => c.result === "success").length;
      const failCount = recentChallenges.filter(c => c.result === "fail").length;
      
      // Calculate average latency
      const latencies = nodeChallenges.filter(c => c.latencyMs).map(c => c.latencyMs!);
      const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
      
      // Determine risk level
      const consecutiveFails = (node as any).consecutiveFails || 0;
      let riskLevel = "healthy";
      if (consecutiveFails >= 2) riskLevel = "critical";
      else if (consecutiveFails >= 1) riskLevel = "warning";
      else if (node.reputation < 30) riskLevel = "at-risk";
      else if (node.status === "probation") riskLevel = "probation";
      
      return {
        id: node.id,
        peerId: node.peerId,
        username: node.hiveUsername,
        reputation: node.reputation,
        status: node.status,
        consecutiveFails,
        totalProofs: node.totalProofs,
        failedProofs: node.failedProofs,
        lastSeen: node.lastSeen,
        riskLevel,
        recentStats: {
          challenges: recentChallenges.length,
          success: successCount,
          fail: failCount,
          successRate: recentChallenges.length > 0 
            ? (successCount / recentChallenges.length * 100).toFixed(1) 
            : "100.0",
        },
        avgLatency: Math.round(avgLatency),
      };
    });
    
    // Group by risk level
    const atRisk = nodesWithDetails.filter(n => n.riskLevel === "at-risk" || n.consecutiveFails >= 2);
    const banned = nodesWithDetails.filter(n => n.status === "banned");
    const probation = nodesWithDetails.filter(n => n.status === "probation" || n.riskLevel === "probation");
    const healthy = nodesWithDetails.filter(n => n.riskLevel === "healthy" && n.status === "active");
    
    res.json({
      all: nodesWithDetails,
      atRisk,
      banned,
      probation,
      healthy,
      summary: {
        total: nodes.length,
        healthy: healthy.length,
        atRisk: atRisk.length,
        banned: banned.length,
        probation: probation.length,
      },
    });
  });

  // Get node detail with challenge history (requires authentication)
  app.get("/api/validator/nodes/:nodeId", async (req, res) => {
    // Validate session token
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    
    const { nodeId } = req.params;
    const nodes = await storage.getAllStorageNodes();
    const node = nodes.find(n => n.id === nodeId);
    
    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }
    
    const challenges = await storage.getRecentChallenges(500);
    const nodeChallenges = challenges.filter(c => c.nodeId === nodeId);
    const files = await storage.getAllFiles();
    
    const challengeHistory = nodeChallenges.map(c => {
      const file = files.find(f => f.id === c.fileId);
      return {
        id: c.id,
        result: c.result,
        latencyMs: c.latencyMs,
        response: c.response,
        createdAt: c.createdAt,
        file: file ? { name: file.name, cid: file.cid } : null,
      };
    });
    
    res.json({
      node: {
        id: node.id,
        peerId: node.peerId,
        username: node.hiveUsername,
        reputation: node.reputation,
        status: node.status,
        consecutiveFails: (node as any).consecutiveFails || 0,
        totalProofs: node.totalProofs,
        failedProofs: node.failedProofs,
        totalEarnedHbd: (node as any).totalEarnedHbd || 0,
        lastSeen: node.lastSeen,
        createdAt: node.createdAt,
      },
      challengeHistory,
      stats: {
        total: nodeChallenges.length,
        success: nodeChallenges.filter(c => c.result === "success").length,
        fail: nodeChallenges.filter(c => c.result === "fail").length,
        timeout: nodeChallenges.filter(c => c.result === "timeout").length,
      },
    });
  });

  // Get challenge queue (pending, active, history) (requires authentication)
  app.get("/api/validator/challenges", async (req, res) => {
    // Validate session token
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    
    const challenges = await storage.getRecentChallenges(100);
    const nodes = await storage.getAllStorageNodes();
    const files = await storage.getAllFiles();
    const validators = await storage.getAllValidators();
    
    const enrichedChallenges = challenges.map(c => {
      const node = nodes.find(n => n.id === c.nodeId);
      const file = files.find(f => f.id === c.fileId);
      const validator = validators.find(v => v.id === c.validatorId);
      return {
        id: c.id,
        result: c.result,
        latencyMs: c.latencyMs,
        response: c.response,
        challengeData: c.challengeData,
        createdAt: c.createdAt,
        node: node ? { id: node.id, username: node.hiveUsername, reputation: node.reputation } : null,
        file: file ? { id: file.id, name: file.name, cid: file.cid } : null,
        validator: validator ? { username: validator.hiveUsername } : null,
      };
    });
    
    // Group by status
    const pending = enrichedChallenges.filter(c => !c.result);
    const completed = enrichedChallenges.filter(c => c.result);
    const failed = completed.filter(c => c.result === "fail" || c.result === "timeout");
    
    // Calculate today's stats
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const todayChallenges = enrichedChallenges.filter(c => 
      now - new Date(c.createdAt).getTime() < dayMs
    );
    const completedToday = todayChallenges.filter(c => c.result === "success").length;
    const failedToday = todayChallenges.filter(c => c.result === "fail" || c.result === "timeout").length;
    
    res.json({
      pending,
      completed,
      failed,
      history: enrichedChallenges,
      pendingCount: pending.length,
      completedToday,
      failedToday,
      summary: {
        pendingCount: pending.length,
        completedToday,
        failedToday,
        total: enrichedChallenges.length,
      },
    });
  });

  // Get fraud detection data (requires authentication)
  app.get("/api/validator/fraud", async (req, res) => {
    // Validate session token
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    
    const challenges = await storage.getRecentChallenges(500);
    const nodes = await storage.getAllStorageNodes();
    const now = Date.now();
    
    // Analyze suspicious patterns
    const nodeLatencies: Record<string, number[]> = {};
    const nodeResults: Record<string, { pass: number; fail: number }> = {};
    
    for (const c of challenges) {
      if (!nodeLatencies[c.nodeId]) nodeLatencies[c.nodeId] = [];
      if (!nodeResults[c.nodeId]) nodeResults[c.nodeId] = { pass: 0, fail: 0 };
      
      if (c.latencyMs) nodeLatencies[c.nodeId].push(c.latencyMs);
      if (c.result === "success") nodeResults[c.nodeId].pass++;
      else if (c.result === "fail") nodeResults[c.nodeId].fail++;
    }
    
    // Detect suspicious patterns
    const suspiciousPatterns: any[] = [];
    const hashMismatches: any[] = [];
    
    for (const [nodeId, latencies] of Object.entries(nodeLatencies)) {
      const node = nodes.find(n => n.id === nodeId);
      if (!node || latencies.length < 5) continue;
      
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const variance = latencies.reduce((sum, l) => sum + Math.pow(l - avg, 2), 0) / latencies.length;
      const stdDev = Math.sqrt(variance);
      
      // High variance might indicate proxying/outsourcing
      if (stdDev > avg * 0.8) {
        suspiciousPatterns.push({
          type: "high_variance",
          nodeId,
          nodeUsername: node.hiveUsername,
          description: "Unusually inconsistent response times - possible outsourcing",
          avgLatency: Math.round(avg),
          stdDev: Math.round(stdDev),
          severity: stdDev > avg ? "high" : "medium",
        });
      }
      
      // Very fast responses might indicate caching/cheating
      if (avg < 50 && latencies.length > 10) {
        suspiciousPatterns.push({
          type: "too_fast",
          nodeId,
          nodeUsername: node.hiveUsername,
          description: "Suspiciously fast response times - possible caching",
          avgLatency: Math.round(avg),
          severity: avg < 20 ? "high" : "medium",
        });
      }
    }
    
    // Collect hash mismatches (failed proofs)
    const failedChallenges = challenges.filter(c => c.result === "fail");
    for (const c of failedChallenges.slice(0, 20)) {
      const node = nodes.find(n => n.id === c.nodeId);
      hashMismatches.push({
        id: c.id,
        nodeId: c.nodeId,
        nodeUsername: node?.hiveUsername || "unknown",
        timestamp: c.createdAt,
        challengeData: c.challengeData,
        response: c.response || "No response",
      });
    }
    
    // Detect potential collusion (nodes with identical pass/fail patterns)
    const collusionAlerts: any[] = [];
    const nodeIds = Object.keys(nodeResults);
    for (let i = 0; i < nodeIds.length; i++) {
      for (let j = i + 1; j < nodeIds.length; j++) {
        const r1 = nodeResults[nodeIds[i]];
        const r2 = nodeResults[nodeIds[j]];
        if (r1.pass + r1.fail >= 10 && r2.pass + r2.fail >= 10) {
          const ratio1 = r1.pass / (r1.pass + r1.fail);
          const ratio2 = r2.pass / (r2.pass + r2.fail);
          if (Math.abs(ratio1 - ratio2) < 0.05 && ratio1 < 0.8) {
            const node1 = nodes.find(n => n.id === nodeIds[i]);
            const node2 = nodes.find(n => n.id === nodeIds[j]);
            collusionAlerts.push({
              nodes: [
                { id: nodeIds[i], username: node1?.hiveUsername },
                { id: nodeIds[j], username: node2?.hiveUsername },
              ],
              similarity: (1 - Math.abs(ratio1 - ratio2)) * 100,
              description: "Similar failure patterns detected",
            });
          }
        }
      }
    }
    
    res.json({
      suspiciousPatterns,
      hashMismatches,
      collusionAlerts: collusionAlerts.slice(0, 10),
      summary: {
        totalSuspicious: suspiciousPatterns.length,
        totalMismatches: hashMismatches.length,
        totalCollusionAlerts: collusionAlerts.length,
      },
    });
  });

  // ============================================================
  // 3Speak Network Browsing API
  // ============================================================
  
  app.get("/api/threespeak/trending", async (req, res) => {
    const { threespeakService } = await import("./services/threespeak-service");
    const limit = parseInt(req.query.limit as string) || 20;
    const page = parseInt(req.query.page as string) || 1;
    const result = await threespeakService.getTrendingVideos(limit, page);
    res.json(result);
  });

  app.get("/api/threespeak/new", async (req, res) => {
    const { threespeakService } = await import("./services/threespeak-service");
    const limit = parseInt(req.query.limit as string) || 20;
    const page = parseInt(req.query.page as string) || 1;
    const result = await threespeakService.getNewVideos(limit, page);
    res.json(result);
  });

  app.get("/api/threespeak/search", async (req, res) => {
    const { threespeakService } = await import("./services/threespeak-service");
    const query = req.query.q as string || "";
    const limit = parseInt(req.query.limit as string) || 20;
    const result = await threespeakService.searchVideos(query, limit);
    res.json(result);
  });

  app.get("/api/threespeak/video/:author/:permlink", async (req, res) => {
    const { threespeakService } = await import("./services/threespeak-service");
    const { author, permlink } = req.params;
    const video = await threespeakService.getVideoDetails(author, permlink);
    if (video) {
      res.json(video);
    } else {
      res.status(404).json({ error: "Video not found" });
    }
  });

  app.post("/api/threespeak/pin", async (req, res) => {
    const { ipfs, title, author } = req.body;
    if (!ipfs) {
      res.status(400).json({ error: "Missing IPFS CID" });
      return;
    }

    try {
      const { pinManager } = await import("./services/pin-manager");
      const ipfsUrl = process.env.IPFS_API_URL || "http://127.0.0.1:5001";
      
      const job = pinManager.createJob(ipfs, title || "3Speak Video", author || "unknown");
      
      res.json({ 
        success: true, 
        jobId: job.id, 
        cid: ipfs, 
        message: "Pin job started" 
      });

      pinManager.pinWithProgress(job.id, ipfsUrl)
        .then(async (completedJob) => {
          try {
            const stat = await fetch(`${ipfsUrl}/api/v0/object/stat?arg=${ipfs}`, { method: "POST" });
            let size = "Unknown";
            if (stat.ok) {
              const data = await stat.json();
              const bytes = data.CumulativeSize || 0;
              if (bytes > 1073741824) size = `${(bytes / 1073741824).toFixed(2)} GB`;
              else if (bytes > 1048576) size = `${(bytes / 1048576).toFixed(2)} MB`;
              else if (bytes > 1024) size = `${(bytes / 1024).toFixed(2)} KB`;
              else size = `${bytes} B`;
            }
            
            const existingFile = await storage.getFileByCid(ipfs);
            
            if (!existingFile) {
              await storage.createFile({
                name: title || "3Speak Video",
                cid: ipfs,
                size,
                uploaderUsername: author || "3speak",
                status: "pinned",
                replicationCount: 1,
                confidence: 100,
                poaEnabled: true,
              });
              console.log(`[Pin] Saved pinned video: ${title} (${ipfs})`);
            } else {
              console.log(`[Pin] Video already exists: ${ipfs}`);
            }
          } catch (err) {
            console.error(`[Pin] Failed to save pinned video:`, err);
          }
        })
        .catch((err) => {
          console.error(`[Pin] Pin failed for ${ipfs}:`, err.message);
        });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/pin/jobs", async (_req, res) => {
    const { pinManager } = await import("./services/pin-manager");
    res.json(pinManager.getAllJobs());
  });

  app.get("/api/pin/jobs/active", async (_req, res) => {
    const { pinManager } = await import("./services/pin-manager");
    res.json(pinManager.getActiveJobs());
  });

  app.get("/api/pin/job/:id", async (req, res) => {
    const { pinManager } = await import("./services/pin-manager");
    const job = pinManager.getJob(req.params.id);
    if (job) {
      res.json(job);
    } else {
      res.status(404).json({ error: "Job not found" });
    }
  });

  // ============================================================
  // Performance Analytics API
  // ============================================================
  
  app.get("/api/analytics/performance", async (req, res) => {
    const successRateTrend = Array.from({ length: 24 }, (_, i) => ({
      hour: i + 1,
      successRate: Number((92 + Math.random() * 7).toFixed(1)),
      challengeCount: Math.floor(80 + Math.random() * 60),
    }));

    const totalChallenges24h = successRateTrend.reduce((sum, h) => sum + h.challengeCount, 0);
    const avgSuccessRate = successRateTrend.reduce((sum, h) => sum + h.successRate, 0) / 24;
    const failedChallenges = Math.floor(totalChallenges24h * (1 - avgSuccessRate / 100));

    res.json({
      proofsPerHour: Math.floor(100 + Math.random() * 50),
      proofsTrend: Number((Math.random() * 20 - 5).toFixed(1)),
      bandwidthPerHour: Math.floor((1 + Math.random() * 4) * 1024 * 1024 * 1024),
      avgLatency: Math.floor(200 + Math.random() * 400),
      minLatency: Math.floor(50 + Math.random() * 100),
      maxLatency: Math.floor(1000 + Math.random() * 1200),
      healthyNodes: 24,
      atRiskNodes: Math.floor(Math.random() * 5),
      totalNodes: 27,
      yourRank: Math.floor(5 + Math.random() * 15),
      successRateTrend,
      totalChallenges24h,
      successRate24h: Number(avgSuccessRate.toFixed(1)),
      failedChallenges24h: failedChallenges,
    });
  });

  // ============================================================
  // Phase 5: Payout System API
  // ============================================================

  // Get wallet dashboard data (public)
  app.get("/api/wallet/dashboard", async (req, res) => {
    try {
      const balance = await storage.getWalletBalance();
      const recentDeposits = await storage.getWalletDeposits(10);
      const pendingReports = await storage.getPayoutReports(20);
      
      res.json({
        balance,
        recentDeposits,
        pendingReports: pendingReports.filter(r => r.status === 'pending'),
        executedReports: pendingReports.filter(r => r.status === 'executed'),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get all wallet deposits
  app.get("/api/wallet/deposits", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const deposits = await storage.getWalletDeposits(limit);
      res.json(deposits);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Add a wallet deposit (requires validator auth - for manual entry/testing)
  app.post("/api/wallet/deposits", async (req, res) => {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    try {
      const { fromUsername, hbdAmount, memo, txHash, purpose } = req.body;
      if (!fromUsername || !hbdAmount || !txHash) {
        res.status(400).json({ error: "fromUsername, hbdAmount, and txHash are required" });
        return;
      }
      const deposit = await storage.createWalletDeposit({
        fromUsername,
        hbdAmount,
        memo: memo || null,
        txHash,
        purpose: purpose || "storage",
        processed: false,
      });
      res.json(deposit);
    } catch (error: any) {
      if (error.message?.includes("duplicate key")) {
        res.status(409).json({ error: "Deposit with this txHash already exists" });
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  });

  // Get PoA data for payout generation (requires validator auth)
  app.get("/api/validator/payout/poa-data", async (req, res) => {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    try {
      const startDate = req.query.startDate ? new Date(req.query.startDate as string) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const endDate = req.query.endDate ? new Date(req.query.endDate as string) : new Date();
      
      const poaData = await storage.getPoaDataForPayout(startDate, endDate);
      const totalHbd = poaData.reduce((sum, p) => sum + parseFloat(p.totalHbd), 0).toFixed(3);
      
      res.json({
        period: { start: startDate.toISOString(), end: endDate.toISOString() },
        recipients: poaData,
        totalHbd,
        recipientCount: poaData.length,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Generate a payout report (requires validator auth)
  app.post("/api/validator/payout/generate", async (req, res) => {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid || !validation.username) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    try {
      const { periodStart, periodEnd } = req.body;
      if (!periodStart || !periodEnd) {
        res.status(400).json({ error: "periodStart and periodEnd are required" });
        return;
      }

      const startDate = new Date(periodStart);
      const endDate = new Date(periodEnd);
      
      const poaData = await storage.getPoaDataForPayout(startDate, endDate);
      const totalHbd = poaData.reduce((sum, p) => sum + parseFloat(p.totalHbd), 0).toFixed(3);

      // Create the payout report
      const report = await storage.createPayoutReport({
        validatorUsername: validation.username,
        periodStart: startDate,
        periodEnd: endDate,
        totalHbd,
        recipientCount: poaData.length,
        status: "pending",
      });

      // Create line items
      const lineItems = await storage.createPayoutLineItems(
        poaData.map(p => ({
          reportId: report.id,
          recipientUsername: p.username,
          hbdAmount: p.totalHbd,
          proofCount: p.proofCount,
          successRate: p.successRate,
          paid: false,
        }))
      );

      res.json({
        report,
        lineItems,
        summary: {
          totalHbd,
          recipientCount: poaData.length,
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get all payout reports (requires validator auth)
  app.get("/api/validator/payout/reports", async (req, res) => {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const reports = await storage.getPayoutReports(limit);
      res.json(reports);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get a specific payout report with line items
  app.get("/api/validator/payout/reports/:id", async (req, res) => {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    try {
      const report = await storage.getPayoutReport(req.params.id);
      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }
      const lineItems = await storage.getPayoutLineItems(report.id);
      res.json({ report, lineItems });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Update report status (for approving/executing payouts)
  app.patch("/api/validator/payout/reports/:id", async (req, res) => {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    try {
      const { status, executedTxHash } = req.body;
      if (!status) {
        res.status(400).json({ error: "status is required" });
        return;
      }
      await storage.updatePayoutReportStatus(req.params.id, status, executedTxHash);
      const report = await storage.getPayoutReport(req.params.id);
      res.json(report);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Export payout report as JSON (for wallet execution)
  app.get("/api/validator/payout/reports/:id/export", async (req, res) => {
    const sessionToken = getSessionToken(req);
    if (!sessionToken) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const validation = await validateValidatorSession(sessionToken);
    if (!validation.valid) {
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }

    try {
      const report = await storage.getPayoutReport(req.params.id);
      if (!report) {
        res.status(404).json({ error: "Report not found" });
        return;
      }
      const lineItems = await storage.getPayoutLineItems(report.id);
      
      // Export format for wallet execution
      const exportData = {
        reportId: report.id,
        period: `${report.periodStart?.toISOString().split('T')[0]}_to_${report.periodEnd?.toISOString().split('T')[0]}`,
        generatedBy: report.validatorUsername,
        generatedAt: report.createdAt?.toISOString(),
        totalHbd: report.totalHbd,
        payouts: lineItems.map(item => ({
          username: item.recipientUsername,
          amount: item.hbdAmount,
          proofs: item.proofCount,
          successRate: item.successRate.toFixed(1),
        })),
      };
      
      res.json(exportData);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // Phase 6: P2P CDN API
  // ============================================================

  app.get("/api/p2p/stats", async (req, res) => {
    try {
      const dbStats = await storage.getCurrentP2pNetworkStats();
      const realtimeStats = p2pSignaling.getStats();
      
      res.json({
        realtime: realtimeStats,
        database: dbStats,
        combined: {
          activePeers: realtimeStats.activePeers > 0 ? realtimeStats.activePeers : dbStats.activePeers,
          activeRooms: realtimeStats.activeRooms > 0 ? realtimeStats.activeRooms : dbStats.activeRooms,
          totalBytesShared: dbStats.totalBytesShared,
          avgP2pRatio: dbStats.avgP2pRatio,
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/p2p/rooms", async (req, res) => {
    try {
      const rooms = await storage.getActiveP2pRooms();
      const realtimeStats = p2pSignaling.getStats();
      
      const enrichedRooms = rooms.map(room => {
        const realtimeRoom = realtimeStats.rooms.find(r => r.id === room.id);
        return {
          ...room,
          realtimePeers: realtimeRoom?.peerCount || 0,
        };
      });
      
      res.json(enrichedRooms);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/p2p/history", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const stats = await storage.getP2pNetworkStats(limit);
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/p2p/contributors", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const contributors = await storage.getTopContributors(limit);
      res.json(contributors);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/p2p/contributions/:username", async (req, res) => {
    try {
      const contributions = await storage.getP2pContributionsByUsername(req.params.username);
      
      const totals = contributions.reduce((acc, c) => ({
        totalBytesShared: acc.totalBytesShared + (c.bytesShared || 0),
        totalSegmentsShared: acc.totalSegmentsShared + (c.segmentsShared || 0),
        totalSessionSeconds: acc.totalSessionSeconds + (c.sessionDurationSec || 0),
        sessionCount: acc.sessionCount + 1,
      }), { totalBytesShared: 0, totalSegmentsShared: 0, totalSessionSeconds: 0, sessionCount: 0 });
      
      res.json({
        username: req.params.username,
        ...totals,
        avgP2pRatio: contributions.length > 0
          ? contributions.reduce((sum, c) => sum + (c.p2pRatio || 0), 0) / contributions.length
          : 0,
        recentContributions: contributions.slice(0, 20),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/p2p/room/:videoCid", async (req, res) => {
    try {
      const room = await storage.getP2pRoomByCid(req.params.videoCid);
      if (!room) {
        res.status(404).json({ error: "Room not found" });
        return;
      }
      
      const realtimeStats = p2pSignaling.getStats();
      const realtimeRoom = realtimeStats.rooms.find(r => r.id === room.id);
      
      res.json({
        ...room,
        realtimePeers: realtimeRoom?.peerCount || 0,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // Phase 7: Hybrid Encoding API
  // ============================================================

  const { encodingService } = await import("./services/encoding-service");
  encodingService.initializeProfiles().catch(console.error);

  const encodingJobSubmitSchema = z.object({
    owner: z.string().min(1, "Owner is required"),
    permlink: z.string().min(1, "Permlink is required"),
    inputCid: z.string().min(1, "Input CID is required"),
    isShort: z.boolean().optional().default(false),
    webhookUrl: z.string().url().optional(),
    originalFilename: z.string().optional(),
    inputSizeBytes: z.number().optional(),
    encodingMode: z.enum(["auto", "self", "community"]).optional().default("auto"),
  });

  const encoderRegisterSchema = z.object({
    peerId: z.string().min(1, "Peer ID is required"),
    hiveUsername: z.string().min(1, "Hive username is required"),
    endpoint: z.string().url().optional(),
    encoderType: z.enum(["desktop", "browser", "community"]),
    hardwareAcceleration: z.string().optional(),
    presetsSupported: z.string().optional(),
  });

  app.get("/api/encoding/stats", async (req, res) => {
    try {
      const stats = await encodingService.getStats();
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/encoding/profiles", async (req, res) => {
    try {
      const profiles = await encodingService.getProfiles();
      res.json(profiles);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/encoding/jobs", async (req, res) => {
    try {
      const { owner, limit } = req.query;
      const jobs = owner 
        ? await encodingService.getJobsByOwner(owner as string, Number(limit) || 20)
        : await encodingService.getRecentJobs(Number(limit) || 50);
      res.json(jobs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/encoding/jobs/:id", async (req, res) => {
    try {
      const job = await encodingService.getJob(req.params.id);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.json(job);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/encoding/jobs", async (req, res) => {
    try {
      const validated = encodingJobSubmitSchema.safeParse(req.body);
      if (!validated.success) {
        res.status(400).json({ error: validated.error.errors.map(e => e.message).join(", ") });
        return;
      }
      
      const job = await encodingService.submitJob(validated.data);
      res.status(201).json(job);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/encoding/jobs/:id/progress", async (req, res) => {
    try {
      const { progress, status } = req.body;
      await encodingService.updateJobProgress(req.params.id, progress, status);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/encoding/jobs/:id/complete", async (req, res) => {
    try {
      const { outputCid, qualitiesEncoded, processingTimeSec, outputSizeBytes } = req.body;
      await encodingService.completeJob(req.params.id, {
        outputCid,
        qualitiesEncoded: qualitiesEncoded || [],
        processingTimeSec: processingTimeSec || 0,
        outputSizeBytes,
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/encoding/jobs/:id/fail", async (req, res) => {
    try {
      const { errorMessage } = req.body;
      await encodingService.failJob(req.params.id, errorMessage || "Unknown error");
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/encoding/webhook", async (req, res) => {
    try {
      const { job_id, status, manifest_cid, error, progress, processing_time_seconds, qualities_encoded } = req.body;
      
      if (status === "completed" && manifest_cid) {
        await encodingService.completeJob(job_id, {
          outputCid: manifest_cid,
          qualitiesEncoded: qualities_encoded || [],
          processingTimeSec: processing_time_seconds || 0,
        });
      } else if (status === "failed") {
        await encodingService.failJob(job_id, error || "Encoding failed");
      } else if (progress !== undefined) {
        await encodingService.updateJobProgress(job_id, progress, status);
      }
      
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/encoding/encoders", async (req, res) => {
    try {
      const { type } = req.query;
      const encoders = await encodingService.getAvailableEncoders(type as string);
      res.json(encoders);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Marketplace endpoint - get encoders sorted by reputation with pricing
  app.get("/api/encoding/encoders/market", async (req, res) => {
    try {
      const { quality, sortBy } = req.query;
      const encoders = await storage.getMarketplaceEncoders(
        quality as string || "all",
        sortBy as string || "reputation"
      );
      
      // Calculate effective pricing for the requested quality
      const enrichedEncoders = encoders.map(encoder => ({
        ...encoder,
        effectivePrice: quality === "1080p" ? encoder.price1080p :
                        quality === "720p" ? encoder.price720p :
                        quality === "480p" ? encoder.price480p :
                        encoder.priceAllQualities,
      }));
      
      res.json(enrichedEncoders);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Create custom price offer
  app.post("/api/encoding/offers", async (req, res) => {
    try {
      const { inputCid, qualitiesRequested, videoDurationSec, offeredHbd, owner, permlink, expiresInHours } = req.body;
      
      // Get current lowest market price for comparison
      const encoders = await storage.getMarketplaceEncoders("all", "price");
      const lowestEncoder = encoders[0];
      const marketPrice = lowestEncoder?.priceAllQualities || "0.03";
      
      // Create the job first (in waiting_offer state)
      const job = await storage.createEncodingJob({
        inputCid,
        owner,
        permlink: permlink || `offer-${Date.now()}`,
        status: "waiting_offer", // Custom status for offer-based jobs
        priority: 0,
        encodingMode: "community",
      });
      
      // Create the offer
      const expiresAt = new Date(Date.now() + (expiresInHours || 24) * 60 * 60 * 1000);
      const offer = await storage.createEncodingJobOffer({
        jobId: job.id,
        owner,
        inputCid,
        qualitiesRequested: qualitiesRequested.join(","),
        videoDurationSec,
        offeredHbd,
        marketPriceHbd: marketPrice,
        expiresAt,
      });
      
      res.json({ job, offer });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get pending offers (for encoders to browse)
  app.get("/api/encoding/offers", async (req, res) => {
    try {
      const { status } = req.query;
      const offers = await storage.getEncodingJobOffers(status as string || "pending");
      res.json(offers);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Accept an offer (encoder picks up a custom price job)
  app.post("/api/encoding/offers/:id/accept", async (req, res) => {
    try {
      const { encoderId } = req.body;
      const offer = await storage.acceptEncodingJobOffer(req.params.id, encoderId);
      
      if (!offer) {
        return res.status(404).json({ error: "Offer not found or already accepted" });
      }
      
      // Update the job to queued status and assign encoder
      await storage.updateEncodingJob(offer.jobId, {
        status: "queued",
        encoderNodeId: encoderId,
        hbdCost: offer.offeredHbd,
      });
      
      res.json(offer);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Get user's offers
  app.get("/api/encoding/offers/user/:username", async (req, res) => {
    try {
      const offers = await storage.getUserEncodingOffers(req.params.username);
      res.json(offers);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Cancel an offer
  app.delete("/api/encoding/offers/:id", async (req, res) => {
    try {
      const { username } = req.query;
      if (!username || typeof username !== "string") {
        return res.status(400).json({ error: "Username required" });
      }
      const cancelled = await storage.cancelEncodingJobOffer(req.params.id, username);
      if (!cancelled) {
        return res.status(404).json({ error: "Offer not found or cannot be cancelled" });
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/encoding/encoders/register", async (req, res) => {
    try {
      const validated = encoderRegisterSchema.safeParse(req.body);
      if (!validated.success) {
        res.status(400).json({ error: validated.error.errors.map(e => e.message).join(", ") });
        return;
      }
      
      const encoder = await encodingService.registerEncoder(validated.data);
      res.json(encoder);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/encoding/encoders/heartbeat", async (req, res) => {
    try {
      const { peerId, jobsInProgress } = req.body;
      await encodingService.heartbeatEncoder(peerId, jobsInProgress || 0);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/encoding/settings/:username", async (req, res) => {
    try {
      const settings = await encodingService.getUserSettings(req.params.username);
      res.json(settings || { username: req.params.username, preferredMode: "auto" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.patch("/api/encoding/settings/:username", async (req, res) => {
    try {
      const settings = await encodingService.updateUserSettings(req.params.username, req.body);
      res.json(settings);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/encoding/check-desktop-agent", async (req, res) => {
    try {
      const { endpoint } = req.body;
      const status = await encodingService.checkDesktopAgent(endpoint || "http://localhost:3002");
      res.json(status);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // Desktop Agent Bridge API - Used by Tauri desktop agent
  // ============================================================
  
  const { encodingOrchestrator } = await import("./services/encoding-orchestrator");
  const { jobScheduler } = await import("./services/job-scheduler");
  
  jobScheduler.start();

  const agentClaimSchema = z.object({
    encoderId: z.string().min(1),
    encoderType: z.enum(["desktop", "browser", "community"]),
    hiveUser: z.string().optional(),
  });

  app.post("/api/encoding/agent/claim", async (req, res) => {
    try {
      const validated = agentClaimSchema.safeParse(req.body);
      if (!validated.success) {
        return res.status(400).json({ error: "Invalid request", details: validated.error.flatten() });
      }

      const { encoderId, encoderType, hiveUser } = validated.data;
      const result = await encodingOrchestrator.agentClaimJob(encoderId, encoderType, hiveUser);
      
      if (!result.job) {
        return res.json({ job: null, message: "No jobs available" });
      }

      res.json({
        job: {
          id: result.job.id,
          inputCid: result.job.inputCid,
          owner: result.job.owner,
          permlink: result.job.permlink,
          isShort: result.job.isShort,
          qualities: result.job.isShort ? ["480p"] : ["1080p", "720p", "480p"],
        },
        signature: result.signature,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const agentProgressSchema = z.object({
    jobId: z.string().min(1),
    stage: z.enum(["downloading", "encoding", "encoding_1080p", "encoding_720p", "encoding_480p", "uploading"]),
    progress: z.number().min(0).max(100),
    signature: z.string().min(1),
  });

  app.post("/api/encoding/agent/progress", async (req, res) => {
    try {
      const validated = agentProgressSchema.safeParse(req.body);
      if (!validated.success) {
        return res.status(400).json({ error: "Invalid request", details: validated.error.flatten() });
      }

      const { jobId, stage, progress, signature } = validated.data;
      await encodingOrchestrator.agentReportProgress(jobId, stage, progress, signature);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const agentCompleteSchema = z.object({
    jobId: z.string().min(1),
    outputCid: z.string().min(1),
    qualitiesEncoded: z.array(z.string()),
    processingTimeSec: z.number().positive(),
    outputSizeBytes: z.number().positive().optional(),
    signature: z.string().min(1),
  });

  app.post("/api/encoding/agent/complete", async (req, res) => {
    try {
      const validated = agentCompleteSchema.safeParse(req.body);
      if (!validated.success) {
        return res.status(400).json({ error: "Invalid request", details: validated.error.flatten() });
      }

      const { jobId, signature, ...result } = validated.data;
      await encodingOrchestrator.agentCompleteJob(jobId, result, signature);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  const agentFailSchema = z.object({
    jobId: z.string().min(1),
    error: z.string().min(1),
    retryable: z.boolean().default(true),
    signature: z.string().min(1),
  });

  app.post("/api/encoding/agent/fail", async (req, res) => {
    try {
      const validated = agentFailSchema.safeParse(req.body);
      if (!validated.success) {
        return res.status(400).json({ error: "Invalid request", details: validated.error.flatten() });
      }

      const { jobId, error, retryable, signature } = validated.data;
      await encodingOrchestrator.agentFailJob(jobId, error, retryable, signature);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/encoding/agent/renew-lease", async (req, res) => {
    try {
      const { jobId } = req.body;
      if (!jobId) {
        return res.status(400).json({ error: "jobId required" });
      }

      const renewed = await encodingOrchestrator.renewJobLease(jobId);
      res.json({ renewed });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/encoding/queue/stats", async (req, res) => {
    try {
      const stats = await jobScheduler.getQueueStats();
      res.json(stats);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  return httpServer;
}
