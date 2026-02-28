import type { Express, Request, Response, NextFunction } from "express";
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
import { agentWSManager } from "./services/agent-ws-manager";
import { WebSocketServer } from "ws";
import { insertFileSchema, insertValidatorBlacklistSchema, insertEncodingJobSchema, insertEncoderNodeSchema } from "@shared/schema";
import { z } from "zod";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getIPFSClient } from "./services/ipfs-client";
import { logRoutes, logWS, logEncoding, logWoT } from "./logger";
import { createProofHash } from "./services/poa-crypto";

// Extend Express Request to carry authenticated user
declare global {
  namespace Express {
    interface Request {
      authenticatedUser?: string;
      authenticatedRole?: string;
    }
  }
}

/**
 * Strong auth middleware: validates Bearer session token from Authorization header.
 * Attaches `req.authenticatedUser` and `req.authenticatedRole` on success.
 */
async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication required — provide Authorization: Bearer <token>" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const session = await storage.getSession(token);
    if (!session || session.expiresAt.getTime() < Date.now()) {
      if (session) await storage.deleteSession(token);
      res.status(401).json({ error: "Invalid or expired session" });
      return;
    }
    req.authenticatedUser = session.username;
    req.authenticatedRole = session.role;
    next();
  } catch {
    res.status(500).json({ error: "Authentication check failed" });
  }
}

/**
 * Agent API key auth middleware: validates ApiKey from Authorization header.
 * Used by encoding agents that can't use Hive Keychain.
 */
async function requireAgentAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("ApiKey ")) {
    res.status(401).json({ error: "Agent authentication required — provide Authorization: ApiKey <key>" });
    return;
  }
  const apiKey = authHeader.slice(7);
  try {
    const agent = await storage.getAgentByKey(apiKey);
    if (!agent) {
      res.status(401).json({ error: "Invalid API key" });
      return;
    }
    req.authenticatedUser = agent.hiveUsername;
    req.authenticatedRole = "agent";
    next();
  } catch {
    res.status(500).json({ error: "Agent authentication check failed" });
  }
}

/**
 * Webhook HMAC verification middleware.
 * Verifies X-Webhook-Signature header against ENCODING_WEBHOOK_SECRET.
 */
function requireWebhookSignature(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.ENCODING_WEBHOOK_SECRET;
  if (!secret) {
    // No secret configured — skip verification (development mode)
    return next();
  }
  const signature = req.headers["x-webhook-signature"] as string | undefined;
  if (!signature) {
    res.status(401).json({ error: "Missing X-Webhook-Signature header" });
    return;
  }
  const rawBody = (req as any).rawBody;
  if (!rawBody) {
    res.status(400).json({ error: "Unable to verify signature — missing raw body" });
    return;
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.replace(/^sha256=/, "");
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided.padEnd(expected.length)))) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  next();
}

/** Validate Hive username format */
function isValidHiveUsername(username: string): boolean {
  return /^[a-z][a-z0-9.-]{2,15}$/.test(username);
}

/**
 * Lightweight auth middleware (DEPRECATED — use requireAuth for mutations).
 * Only checks for username presence. Use for analytics/soft-check endpoints.
 */
function requireHiveUser(req: Request, res: Response, next: NextFunction): void {
  const headerUser = req.headers["x-hive-username"] as string | undefined;
  const bodyUser = req.body?.username
    || req.body?.fromUsername
    || req.body?.addedBy
    || req.body?.voterUsername
    || req.body?.owner
    || req.body?.scopeOwnerId;
  if (headerUser || bodyUser) {
    return next();
  }
  res.status(401).json({ error: "Authentication required — provide x-hive-username header or username in body" });
}

/** Parse pagination query params with safe defaults */
function parsePagination(req: Request): { page: number; limit: number; offset: number } {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function paginatedResponse<T>(data: T[], total: number, page: number, limit: number) {
  return { data, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

/** Enrich a storage contract with computed budget fields */
function enrichContractResponse(contract: any) {
  const budget = parseFloat(contract.hbdBudget || '0');
  const spent = parseFloat(contract.hbdSpent || '0');
  const remaining = Math.max(0, budget - spent);
  const percentSpent = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;

  // Estimate exhaustion date based on spending rate
  let estimatedExhaustionDate: string | null = null;
  if (budget > 0 && spent > 0 && contract.status === 'active') {
    const contractAgeMs = Date.now() - new Date(contract.startsAt).getTime();
    if (contractAgeMs > 0) {
      const dailySpendRate = spent / (contractAgeMs / 86400000);
      if (dailySpendRate > 0) {
        const daysRemaining = remaining / dailySpendRate;
        estimatedExhaustionDate = new Date(Date.now() + daysRemaining * 86400000).toISOString();
      }
    }
  }

  return {
    ...contract,
    remainingBudget: remaining.toFixed(3),
    percentSpent: Math.round(percentSpent * 10) / 10,
    estimatedExhaustionDate,
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // WebSocket for real-time updates (using noServer mode for proper multi-path support)
  const wss = new WebSocketServer({ noServer: true });
  const WS_MAX_CONNECTIONS = 100;
  const VALIDATE_MAX_CONNECTIONS = 50;
  const WS_HEARTBEAT_INTERVAL = 30_000;
  const WS_HEARTBEAT_TIMEOUT = 10_000;

  // Heartbeat helper: pings clients, terminates unresponsive ones
  function setupHeartbeat(wsServer: InstanceType<typeof WebSocketServer>, label: string) {
    const interval = setInterval(() => {
      wsServer.clients.forEach((ws: any) => {
        if (ws.isAlive === false) {
          logRoutes.info(`[${label}] Terminating stale connection`);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, WS_HEARTBEAT_INTERVAL);

    wsServer.on("close", () => clearInterval(interval));
  }

  wss.on("connection", (ws: any) => {
    if (wss.clients.size > WS_MAX_CONNECTIONS) {
      ws.close(1013, "Max connections reached");
      return;
    }
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    storage.getRecentTransactions(10).then((txs) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "transactions", data: txs }));
      }
    });

    const handleTransaction = (event: any) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: "hive_event", data: event }));
      }
    };

    hiveSimulator.on("transaction", handleTransaction);

    ws.on("close", () => {
      hiveSimulator.off("transaction", handleTransaction);
    });
  });

  setupHeartbeat(wss, "WS");

  // P2P CDN WebSocket for peer signaling (using noServer mode)
  const p2pWss = new WebSocketServer({ noServer: true });
  p2pSignaling.init(p2pWss);

  // PoA Validation WebSocket for storage nodes to respond to challenges
  const validateWss = new WebSocketServer({ noServer: true });
  const poaIpfs = getIPFSClient();
  
  validateWss.on("connection", (ws: any) => {
    if (validateWss.clients.size > VALIDATE_MAX_CONNECTIONS) {
      ws.close(1013, "Max connections reached");
      return;
    }
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        // SPK PoA 2.0 Protocol: RequestProof — storage node computes proof hash
        if (message.type === "RequestProof") {
          const startTime = Date.now();
          const cid = message.CID;
          const salt = message.Hash;
          const user = message.User;

          try {
            let blockCids: string[] = [];
            try {
              blockCids = await poaIpfs.refs(cid);
            } catch {
              blockCids = [];
            }

            const proofHash = await createProofHash(poaIpfs, salt, cid, blockCids);
            const elapsed = Date.now() - startTime;

            ws.send(JSON.stringify({
              Hash: salt,
              CID: cid,
              User: user,
              Status: proofHash ? "Success" : "Fail",
              proofHash,
              elapsed,
            }));
            logRoutes.info(`[PoA Validate] Proof response (${elapsed}ms): ${proofHash ? "Success" : "Fail"}`);
          } catch (err) {
            ws.send(JSON.stringify({
              Hash: salt, CID: cid, User: user, Status: "Fail",
              error: err instanceof Error ? err.message : "Unknown error",
              elapsed: Date.now() - startTime,
            }));
          }
        }

        // SPK PoA 2.0 Protocol: RequestCIDS — validator asks node what it stores
        else if (message.type === "RequestCIDS") {
          try {
            const ipfs = getIPFSClient();
            const pins = await ipfs.pins();
            // Send chunked response (matches SPK 1.0 protocol)
            const CHUNK_SIZE = 50;
            const totalParts = Math.ceil(pins.length / CHUNK_SIZE);
            for (let i = 0; i < totalParts; i++) {
              const chunk = pins.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
              ws.send(JSON.stringify({
                type: "SendCIDS",
                pins: JSON.stringify(chunk),
                part: String(i + 1),
                totalParts: String(totalParts),
              }));
            }
            logRoutes.info(`[PoA Validate] Sent ${pins.length} CIDs in ${totalParts} parts`);
          } catch (err) {
            ws.send(JSON.stringify({ type: "SendCIDS", pins: "[]", part: "1", totalParts: "1" }));
          }
        }

        // SPK PoA 2.0 Protocol: PingPongPing — liveness check
        else if (message.type === "PingPongPing") {
          ws.send(JSON.stringify({ type: "PingPongPong", Hash: message.Hash }));
        }

      } catch (err) {
        logRoutes.error({ err }, "Failed to parse PoA validate message");
      }
    });

    ws.on("close", () => {});
  });

  setupHeartbeat(validateWss, "Validate");

  // Desktop Agent WebSocket for auto-registration and PoA challenges
  const agentWss = new WebSocketServer({ noServer: true });
  const AGENT_MAX_CONNECTIONS = 200;

  agentWss.on("connection", (ws: any) => {
    if (agentWss.clients.size > AGENT_MAX_CONNECTIONS) {
      ws.close(1013, "Max agent connections reached");
      return;
    }
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    agentWSManager.handleConnection(ws);
  });

  setupHeartbeat(agentWss, "Agent");

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
    } else if (pathname === "/validate") {
      validateWss.handleUpgrade(request, socket, head, (ws) => {
        validateWss.emit("connection", ws, request);
      });
    } else if (pathname === "/ws/agent") {
      agentWss.handleUpgrade(request, socket, head, (ws) => {
        agentWss.emit("connection", ws, request);
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

  app.post("/api/ipfs/start", requireAuth, async (req, res) => {
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

  app.post("/api/ipfs/stop", requireAuth, async (req, res) => {
    const { ipfsManager } = await import("./services/ipfs-manager");
    await ipfsManager.stop();
    res.json({
      success: true,
      message: "IPFS daemon stopped",
      status: ipfsManager.getStatus(),
    });
  });

  app.post("/api/ipfs/restart", requireAuth, async (req, res) => {
    const { ipfsManager } = await import("./services/ipfs-manager");
    const restarted = await ipfsManager.restart();
    res.json({
      success: restarted,
      message: restarted ? "IPFS daemon restarted" : "Failed to restart IPFS daemon",
      status: ipfsManager.getStatus(),
    });
  });

  app.post("/api/ipfs/test-connection", requireAuth, async (req, res) => {
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

  app.post("/api/ipfs/test", requireAuth, async (req, res) => {
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
      const schema = z.object({
        latency: z.number().nonnegative().optional(),
        requestCount: z.number().int().nonnegative().optional(),
      });
      const data = schema.parse(req.body);
      await cdnManager.processHeartbeat(req.params.nodeId, { latency: data.latency, requestCount: data.requestCount });
      res.json({ success: true });
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // ============================================================
  // Chunked Upload API (Phase 1)
  // ============================================================
  
  app.post("/api/upload/init", requireAuth, async (req, res) => {
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

  app.post("/api/upload/:sessionId/chunk/:chunkIndex", requireAuth, async (req, res) => {
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

  app.post("/api/upload/:sessionId/complete", requireAuth, async (req, res) => {
    try {
      const result = await uploadManager.completeUpload(req.params.sessionId);
      res.json(result);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/upload/:sessionId", requireAuth, async (req, res) => {
    const cancelled = await uploadManager.cancelUpload(req.params.sessionId);
    res.json({ success: cancelled });
  });

  // Simple single-file upload to IPFS (used by the Storage page upload button)
  app.post("/api/upload/simple", requireAuth, async (req, res) => {
    try {
      const data = req.body as Buffer;
      if (!data || data.length === 0) {
        res.status(400).json({ error: "No file data received" });
        return;
      }

      const fileName = (req.headers["x-file-name"] as string) || "untitled";
      const fileSize = data.length;

      const ipfs = getIPFSClient();
      const cid = await ipfs.addWithPin(data);

      // Register file in DB
      const file = await storage.createFile({
        name: fileName,
        cid,
        size: fileSize > 1024 * 1024
          ? `${(fileSize / (1024 * 1024)).toFixed(1)} MB`
          : `${(fileSize / 1024).toFixed(1)} KB`,
        uploaderUsername: req.authenticatedUser || "anonymous",
        status: "pinned",
        replicationCount: 1,
        confidence: 100,
        poaEnabled: true,
      });

      logRoutes.info({ cid, fileName, size: fileSize, user: req.authenticatedUser }, "File uploaded to IPFS");
      res.json({ success: true, file, cid });
    } catch (error: any) {
      logRoutes.error({ err: error }, "Simple upload failed");
      res.status(500).json({ error: "Upload failed: " + error.message });
    }
  });

  // ============================================================
  // Storage Contracts API (Phase 1)
  // ============================================================
  
  app.get("/api/contracts", async (req, res) => {
    const contracts = await storage.getAllStorageContracts();
    res.json(contracts.map(enrichContractResponse));
  });

  app.get("/api/contracts/active", async (req, res) => {
    const contracts = await storage.getActiveStorageContracts();
    res.json(contracts.map(enrichContractResponse));
  });

  app.get("/api/contracts/:id", async (req, res) => {
    const contract = await storage.getStorageContract(req.params.id);
    if (!contract) {
      return res.status(404).json({ error: "Contract not found" });
    }
    res.json(enrichContractResponse(contract));
  });

  app.get("/api/contracts/:id/events", async (req, res) => {
    const events = await storage.getContractEvents(req.params.id);
    res.json(events);
  });

  // ============================================================
  // Contract Creation, Funding & Cancellation
  // ============================================================

  /**
   * Create a storage contract for a CID.
   * Returns the contract with a depositMemo for Hive transfer.
   */
  app.post("/api/contracts/create", requireAuth, async (req, res) => {
    try {
      const schema = z.object({
        fileCid: z.string().min(1),
        hbdBudget: z.string().regex(/^\d+\.?\d{0,3}$/, "Invalid HBD amount"),
        durationDays: z.number().int().min(1).max(3650),
        requestedReplication: z.number().int().min(1).max(20).optional(),
      });
      const data = schema.parse(req.body);
      const username = req.authenticatedUser!;

      // Verify CID exists in files table
      const file = await storage.getFileByCid(data.fileCid);
      if (!file) {
        return res.status(404).json({ error: "File CID not found — upload the file first" });
      }

      const budget = parseFloat(data.hbdBudget);
      if (budget <= 0) {
        return res.status(400).json({ error: "Budget must be greater than 0" });
      }

      // Calculate suggested rewardPerChallenge based on budget and duration
      // Estimate ~1 challenge per 3 days per CID (conservative)
      const estimatedChallenges = Math.max(1, Math.floor(data.durationDays / 3));
      const rewardPerChallenge = Math.max(0.001, budget / estimatedChallenges);

      const expiresAt = new Date(Date.now() + data.durationDays * 24 * 60 * 60 * 1000);

      const contract = await storage.createStorageContract({
        fileId: file.id,
        fileCid: data.fileCid,
        uploaderUsername: username,
        requestedReplication: data.requestedReplication || 3,
        actualReplication: 0,
        status: 'pending',
        hbdBudget: budget.toFixed(3),
        hbdSpent: '0',
        rewardPerChallenge: rewardPerChallenge.toFixed(4),
        startsAt: new Date(),
        expiresAt,
      });

      // Create contract event
      await storage.createContractEvent({
        contractId: contract.id,
        eventType: 'created',
        payload: JSON.stringify({
          budget: data.hbdBudget,
          durationDays: data.durationDays,
          rewardPerChallenge: rewardPerChallenge.toFixed(4),
          estimatedChallenges,
        }),
      });

      const depositMemo = `hivepoa:contract:${contract.id}`;

      res.json({
        ...contract,
        depositMemo,
        estimatedChallenges,
        estimatedRewardPerChallenge: rewardPerChallenge.toFixed(4),
      });
    } catch (error: any) {
      logRoutes.error({ err: error }, "Failed to create contract");
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * Fund a contract by verifying a Hive HBD transfer.
   * Activates the contract after verifying the deposit.
   */
  app.post("/api/contracts/:id/fund", requireAuth, async (req, res) => {
    try {
      const schema = z.object({
        txHash: z.string().min(1),
      });
      const data = schema.parse(req.body);
      const username = req.authenticatedUser!;

      const contract = await storage.getStorageContract(req.params.id);
      if (!contract) {
        return res.status(404).json({ error: "Contract not found" });
      }
      if (contract.uploaderUsername !== username) {
        return res.status(403).json({ error: "Not the contract owner" });
      }
      if (contract.status !== 'pending') {
        return res.status(400).json({ error: `Contract is already ${contract.status}` });
      }

      // Verify the Hive transfer
      const { createHiveClient } = await import("./services/hive-client");
      const hiveClient = createHiveClient();
      const transfer = await hiveClient.verifyTransfer(data.txHash);

      if (!transfer) {
        return res.status(400).json({ error: "Transaction not found on Hive blockchain" });
      }

      // Validate transfer details
      const transferAmount = parseFloat(transfer.amount);
      const requiredAmount = parseFloat(contract.hbdBudget);
      if (transferAmount < requiredAmount) {
        return res.status(400).json({
          error: `Insufficient transfer: ${transfer.amount} sent, ${contract.hbdBudget} HBD required`,
        });
      }

      // Record the deposit
      await storage.createWalletDeposit({
        fromUsername: transfer.from,
        hbdAmount: transferAmount.toFixed(3),
        memo: transfer.memo,
        txHash: data.txHash,
        purpose: 'storage',
        processed: true,
      });

      // Activate the contract
      await storage.updateStorageContractStatus(contract.id, 'active');

      await storage.createContractEvent({
        contractId: contract.id,
        eventType: 'activated',
        payload: JSON.stringify({
          txHash: data.txHash,
          amount: transfer.amount,
          from: transfer.from,
        }),
      });

      const updatedContract = await storage.getStorageContract(contract.id);
      res.json(updatedContract);
    } catch (error: any) {
      logRoutes.error({ err: error }, "Failed to fund contract");
      res.status(400).json({ error: error.message });
    }
  });

  /**
   * Cancel a contract (owner only).
   */
  app.post("/api/contracts/:id/cancel", requireAuth, async (req, res) => {
    try {
      const username = req.authenticatedUser!;

      const contract = await storage.getStorageContract(req.params.id);
      if (!contract) {
        return res.status(404).json({ error: "Contract not found" });
      }
      if (contract.uploaderUsername !== username) {
        return res.status(403).json({ error: "Not the contract owner" });
      }
      if (contract.status !== 'pending' && contract.status !== 'active') {
        return res.status(400).json({ error: `Cannot cancel a ${contract.status} contract` });
      }

      const remainingBudget = parseFloat(contract.hbdBudget) - parseFloat(contract.hbdSpent);

      await storage.updateStorageContractStatus(contract.id, 'cancelled');

      await storage.createContractEvent({
        contractId: contract.id,
        eventType: 'cancelled',
        payload: JSON.stringify({
          cancelledBy: username,
          remainingBudget: remainingBudget.toFixed(3),
          hbdSpent: contract.hbdSpent,
        }),
      });

      res.json({
        success: true,
        contractId: contract.id,
        remainingBudget: remainingBudget.toFixed(3),
      });
    } catch (error: any) {
      logRoutes.error({ err: error }, "Failed to cancel contract");
      res.status(400).json({ error: error.message });
    }
  });

  // ============================================================
  // Transcoding API (Phase 2)
  // ============================================================
  
  app.get("/api/transcode/presets", (req, res) => {
    res.json(transcodingService.getPresets());
  });

  app.post("/api/transcode/submit", requireAuth, async (req, res) => {
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
  // Health Check (no auth required)
  // ============================================================
  app.get("/api/health", async (req, res) => {
    const checks: Record<string, { status: string; detail?: string }> = {};

    // Database connectivity
    try {
      const { pool } = await import("./db");
      await pool.query("SELECT 1");
      checks.database = { status: "ok" };
    } catch (e: any) {
      checks.database = { status: "error", detail: e.message };
    }

    // IPFS status
    const { ipfsManager } = await import("./services/ipfs-manager");
    const ipfsStatus = ipfsManager.getStatus();
    checks.ipfs = { status: ipfsStatus.ready ? "ok" : "degraded", detail: ipfsStatus.ready ? `API at ${ipfsStatus.apiUrl}` : "not ready" };

    // PoA engine status
    const poaStatus = poaEngine.getStatus();
    checks.poa = { status: poaStatus.running ? "ok" : "stopped", detail: `mode=${poaStatus.mode}` };

    const allOk = Object.values(checks).every(c => c.status === "ok");
    res.status(allOk ? 200 : 503).json({
      status: allOk ? "healthy" : "degraded",
      uptime: process.uptime(),
      checks,
    });
  });

  // ============================================================
  // Blocklist API (Phase 3)
  // ============================================================
  
  app.get("/api/blocklist/:scope", async (req, res) => {
    const scopeOwnerId = req.query.ownerId as string | undefined;
    const entries = await blocklistService.getBlocklist(req.params.scope as any, scopeOwnerId);
    res.json(entries);
  });

  app.post("/api/blocklist", requireAuth, async (req, res) => {
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

  app.delete("/api/blocklist/:id", requireAuth, async (req, res) => {
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

  app.post("/api/files/:fileId/tags", requireAuth, async (req, res) => {
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

  app.post("/api/tags/:fileTagId/vote", requireAuth, async (req, res) => {
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

  app.post("/api/encryption/keys", requireAuth, async (req, res) => {
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

  app.put("/api/settings/:username", requireAuth, async (req, res) => {
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

  app.post("/api/beneficiaries", requireAuth, async (req, res) => {
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

  app.put("/api/beneficiaries/:id", requireAuth, async (req, res) => {
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

  app.delete("/api/beneficiaries/:id", requireAuth, async (req, res) => {
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

  app.post("/api/payouts/calculate", requireAuth, async (req, res) => {
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
  
  // Files API (supports ?page=1&limit=50 pagination)
  app.get("/api/files", async (req, res) => {
    if (req.query.page) {
      const { page, limit, offset } = parsePagination(req);
      const result = await storage.getFilesPaginated(limit, offset);
      res.json(paginatedResponse(result.data, result.total, page, limit));
    } else {
      const files = await storage.getAllFiles();
      res.json(files);
    }
  });

  // Get file marketplace with rarity and ROI data — optimized with LEFT JOIN
  app.get("/api/files/marketplace", async (req, res) => {
    const rows = await storage.getMarketplaceFiles();

    const filesWithROI = rows.map((row: any) => {
      const replicationCount = Number(row.replication_count) || 1;
      const rarityMultiplier = 1 / Math.max(1, replicationCount);
      const sizeBytes = parseInt(row.size) || 1000;
      const challengeCount = Number(row.challenge_count) || 0;
      const successCount = Number(row.success_count) || 0;
      const rewardPerProof = 0.001 * rarityMultiplier;
      const proofsPerDay = (successCount / 7) || 1;
      const dailyEarnings = rewardPerProof * proofsPerDay;
      const roiScore = (dailyEarnings * 1000000) / sizeBytes;

      return {
        id: row.id,
        name: row.name,
        cid: row.cid,
        size: row.size,
        sizeBytes,
        status: row.status,
        replicationCount,
        rarityMultiplier,
        isRare: replicationCount < 3,
        earnedHbd: Number(row.earned_hbd) || 0,
        rewardPerProof,
        dailyEarnings,
        roiScore,
        challengeCount,
        successRate: challengeCount > 0
          ? (successCount / challengeCount * 100).toFixed(1) : "0.0",
      };
    });

    filesWithROI.sort((a: any, b: any) => b.roiScore - a.roiScore);

    res.json({
      files: filesWithROI,
      recommendations: filesWithROI.filter((f: any) => f.isRare).slice(0, 10),
      stats: {
        totalFiles: rows.length,
        rareFiles: filesWithROI.filter((f: any) => f.isRare).length,
        avgRarityMultiplier: rows.length > 0
          ? filesWithROI.reduce((sum: number, f: any) => sum + f.rarityMultiplier, 0) / rows.length : 0,
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

  app.post("/api/files", requireAuth, async (req, res) => {
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

      // SPK PoA 2.0: Sync refs list asynchronously (validator only needs metadata)
      poaEngine.syncFileRefsForCid(data.cid).catch((err) => logRoutes.warn({ err }, "Refs sync failed for uploaded file"));

      res.json(file);
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/files/:id", requireAuth, async (req, res) => {
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

  // Connected desktop agents monitoring
  app.get("/api/agents/connected", async (req, res) => {
    res.json({
      count: agentWSManager.getConnectedAgentCount(),
      agents: agentWSManager.getConnectedAgents(),
    });
  });

  // Storage Nodes API
  app.get("/api/nodes", async (req, res) => {
    const search = req.query.search as string | undefined;
    if (search) {
      const nodes = await storage.searchStorageNodes(search);
      res.json(nodes);
    } else if (req.query.page) {
      const { page, limit, offset } = parsePagination(req);
      const result = await storage.getNodesPaginated(limit, offset);
      res.json(paginatedResponse(result.data, result.total, page, limit));
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

  app.post("/api/validators/:username/blacklist", requireAuth, async (req, res) => {
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

  app.delete("/api/validators/:username/blacklist/:nodeId", requireAuth, async (req, res) => {
    const validator = await storage.getValidatorByUsername(req.params.username);
    if (!validator) {
      return res.status(404).json({ error: "Validator not found" });
    }
    
    await storage.removeFromBlacklist(validator.id, req.params.nodeId);
    res.json({ success: true });
  });

  // PoA Challenges API
  app.get("/api/challenges", async (req, res) => {
    if (req.query.page) {
      const { page, limit, offset } = parsePagination(req);
      const result = await storage.getChallengesPaginated(limit, offset);
      res.json(paginatedResponse(result.data, result.total, page, limit));
    } else {
      const limit = parseInt(req.query.limit as string) || 50;
      const challenges = await storage.getRecentChallenges(limit);
      res.json(challenges);
    }
  });

  // Hive Transactions API
  app.get("/api/transactions", async (req, res) => {
    if (req.query.page) {
      const { page, limit, offset } = parsePagination(req);
      const result = await storage.getTransactionsPaginated(limit, offset);
      res.json(paginatedResponse(result.data, result.total, page, limit));
    } else {
      const limit = parseInt(req.query.limit as string) || 50;
      const transactions = await storage.getRecentTransactions(limit);
      res.json(transactions);
    }
  });

  // Dashboard Stats API — optimized with SQL aggregates
  app.get("/api/stats", async (req, res) => {
    const stats = await storage.getStatsAggregated();
    res.json(stats);
  });

  // ============================================================
  // Earnings & Analytics API (For Storage Operators)
  // ============================================================

  // Get dashboard earnings data for a node (detailed stats)
  app.get("/api/earnings/dashboard/:username", async (req, res) => {
    const { username } = req.params;
    const node = await storage.getStorageNodeByUsername(username);

    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    // Targeted queries instead of loading all rows
    const [nodeChallenges, earningsWeek] = await Promise.all([
      storage.getNodeChallenges(node.id, 200),
      storage.getNodeEarnings(node.hiveUsername),
    ]);

    // Streaks from ordered node-specific challenges (already DESC by createdAt)
    let currentStreak = 0;
    let maxStreak = 0;
    let tempStreak = 0;
    for (const c of nodeChallenges) {
      if (c.result === "success") {
        if (tempStreak === currentStreak) currentStreak++;
        tempStreak++;
        if (tempStreak > maxStreak) maxStreak = tempStreak;
      } else {
        if (currentStreak === tempStreak) { /* first failure ends current streak tracking */ }
        tempStreak = 0;
      }
    }

    // Streak bonus tiers
    let streakBonus = 1.0;
    let nextBonusTier = 10;
    let progressToNextTier = 0;
    if (currentStreak >= 100) {
      streakBonus = 1.5; nextBonusTier = 100; progressToNextTier = 100;
    } else if (currentStreak >= 50) {
      streakBonus = 1.25; nextBonusTier = 100; progressToNextTier = ((currentStreak - 50) / 50) * 100;
    } else if (currentStreak >= 10) {
      streakBonus = 1.1; nextBonusTier = 50; progressToNextTier = ((currentStreak - 10) / 40) * 100;
    } else {
      progressToNextTier = (currentStreak / 10) * 100;
    }

    // Earnings from challenge count approximation
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const earningsToday = nodeChallenges
      .filter(c => c.result === "success" && (now - new Date(c.createdAt).getTime()) < dayMs)
      .length * 0.001;
    const hourlyRate = earningsToday / Math.max(1, (now % dayMs) / (60 * 60 * 1000));

    const passed = nodeChallenges.filter(c => c.result === "success").length;
    const failed = nodeChallenges.filter(c => c.result === "fail").length;

    res.json({
      node: {
        id: node.id,
        username: node.hiveUsername,
        reputation: node.reputation,
        status: node.status,
        consecutiveFails: node.consecutiveFails || 0,
        totalEarnedHbd: node.totalEarnedHbd || 0,
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
        consecutiveFails: node.consecutiveFails || 0,
        maxFails: 3,
        isBanned: node.status === "banned",
        isProbation: node.status === "probation",
        banRisk: (node.consecutiveFails || 0) >= 2 ? "high" :
                 (node.consecutiveFails || 0) >= 1 ? "medium" : "low",
      },
      earnings: {
        today: earningsToday,
        week: earningsWeek,
        total: node.totalEarnedHbd || 0,
        projectedDaily: hourlyRate * 24,
        projectedMonthly: hourlyRate * 24 * 30,
      },
      challenges: {
        total: nodeChallenges.length,
        passed,
        failed,
        successRate: nodeChallenges.length > 0
          ? (passed / nodeChallenges.length * 100).toFixed(1) : "0.0",
        avgLatency: nodeChallenges.length > 0
          ? Math.round(nodeChallenges.reduce((sum, c) => sum + (c.latencyMs || 0), 0) / nodeChallenges.length) : 0,
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

  // One-time login challenges to prevent replay attacks
  const loginChallenges = new Map<string, { username: string; expiresAt: number }>();

  function generateSessionToken(): string {
    return randomBytes(48).toString('base64url');
  }

  // Validate session token — reads from DB (persistent sessions)
  // Supports both direct witnesses and vouched validators (Web of Trust)
  async function validateValidatorSession(token: string): Promise<{
    valid: boolean;
    username?: string;
    isVouched?: boolean;
    sponsor?: string;
  }> {
    const session = await storage.getSession(token);
    if (!session || session.expiresAt.getTime() < Date.now()) {
      if (session) await storage.deleteSession(token);
      return { valid: false };
    }

    const { createHiveClient } = await import("./services/hive-client");
    const hiveClient = createHiveClient();

    // Fast path: check if user is a direct witness
    const isTopWitness = await hiveClient.isTopWitness(session.username, 150);
    if (isTopWitness) {
      return { valid: true, username: session.username, isVouched: false };
    }

    // Fallback: check Web of Trust — is this user vouched by a witness?
    const vouch = await storage.getVouchForUser(session.username);
    if (vouch && vouch.active) {
      // Verify the sponsor is still a top-150 witness (cascading revocation)
      const sponsorStillWitness = await hiveClient.isTopWitness(vouch.sponsorUsername, 150);
      if (sponsorStillWitness) {
        return { valid: true, username: session.username, isVouched: true, sponsor: vouch.sponsorUsername };
      }
      // Sponsor dropped out — auto-revoke vouch
      await storage.revokeVouch(vouch.sponsorUsername, "witness_dropped");
      logWoT.warn({ sponsor: vouch.sponsorUsername, vouched: session.username }, "Auto-revoked vouch — sponsor lost witness status");
    }

    // Neither a witness nor validly vouched
    await storage.deleteSession(token);
    return { valid: false };
  }

  // Extract session token from Authorization header
  function getSessionToken(req: any): string | null {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return authHeader.substring(7);
    }
    return null;
  }

  // ============================================================
  // General Hive Authentication (any Hive account)
  // ============================================================

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { username, signature, challenge } = req.body;

      if (!username || !signature || !challenge) {
        res.status(400).json({ error: "Missing username, signature, or challenge" });
        return;
      }

      if (!isValidHiveUsername(username)) {
        res.status(400).json({ error: "Invalid Hive username format" });
        return;
      }

      // Validate challenge format: SPK-Login-{timestamp}
      const challengeMatch = challenge.match(/SPK-(?:Validator-)?Login-(\d+)/);
      if (!challengeMatch) {
        res.status(400).json({ error: "Invalid challenge format" });
        return;
      }

      const challengeTime = parseInt(challengeMatch[1]);
      if (Date.now() - challengeTime > 5 * 60 * 1000) {
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

      await storage.cleanExpiredSessions();
      const sessionToken = generateSessionToken();
      await storage.createSession(sessionToken, username, new Date(Date.now() + 24 * 60 * 60 * 1000), "user");

      res.json({
        success: true,
        username,
        sessionToken,
        expiresIn: 86400,
      });
    } catch (error) {
      logRoutes.error({ err: error }, "Auth login error");
      res.status(500).json({ error: "Authentication failed" });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      await storage.deleteSession(token).catch((err) => logRoutes.warn({ err }, "Session delete failed during logout"));
    }
    res.json({ success: true });
  });

  app.get("/api/auth/me", requireAuth, async (req, res) => {
    res.json({ username: req.authenticatedUser, role: req.authenticatedRole });
  });

  // Register agent API key (requires Hive auth first)
  app.post("/api/auth/agent-key", requireAuth, async (req, res) => {
    try {
      const { label } = req.body;
      const apiKey = randomBytes(32).toString("hex");
      await storage.createAgentKey(apiKey, req.authenticatedUser!, label || "Default Agent");
      res.json({ apiKey, message: "Store this key securely — it cannot be retrieved again" });
    } catch (error) {
      res.status(500).json({ error: "Failed to create agent key" });
    }
  });

  // ============================================================
  // Validator Authentication (witnesses only — extends general auth)
  // ============================================================

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

      // Check Web of Trust if not a direct witness
      let isVouched = false;
      let vouchSponsor: string | undefined;
      if (!isTopWitness) {
        const vouch = await storage.getVouchForUser(username);
        if (vouch && vouch.active) {
          // Verify sponsor is still a witness (cascading check)
          const sponsorValid = await hiveClient.isTopWitness(vouch.sponsorUsername, 150);
          if (sponsorValid) {
            isVouched = true;
            vouchSponsor = vouch.sponsorUsername;
          } else {
            // Auto-revoke if sponsor dropped out
            await storage.revokeVouch(vouch.sponsorUsername, "witness_dropped");
            logWoT.warn({ sponsor: vouch.sponsorUsername, vouched: username }, "Auto-revoked vouch at login — sponsor lost witness status");
          }
        }
      }

      // Generate session token for any authenticated Hive user
      await storage.cleanExpiredSessions();
      const sessionToken = generateSessionToken();
      const role = (isTopWitness || isVouched) ? "validator" : "user";
      await storage.createSession(sessionToken, username, new Date(Date.now() + 24 * 60 * 60 * 1000), role);

      res.json({
        success: true,
        username,
        isTopWitness,
        isVouched,
        vouchSponsor,
        witnessRank: isTopWitness ? witnessRank : null,
        sessionToken,
        role,
        message: isTopWitness
          ? `Welcome, Witness #${witnessRank}!`
          : isVouched
            ? `Welcome, Vouched Validator! Sponsored by @${vouchSponsor}`
            : `Welcome, @${username}!`,
      });
    } catch (error) {
      logRoutes.error({ err: error }, "Validator login error");
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

      const session = await storage.getSession(sessionToken);
      if (!session || session.username !== username || session.expiresAt.getTime() < Date.now()) {
        await storage.deleteSession(sessionToken);
        res.status(401).json({ valid: false, error: "Invalid or expired session" });
        return;
      }

      // Check current witness/vouch status (may have changed since login)
      const { createHiveClient } = await import("./services/hive-client");
      const hiveClient = createHiveClient();

      const isTopWitness = await hiveClient.isTopWitness(username, 150);
      const witnessRank = isTopWitness ? await hiveClient.getWitnessRank(username) : null;

      let isVouched = false;
      let vouchSponsor: string | undefined;
      if (!isTopWitness) {
        const vouch = await storage.getVouchForUser(username);
        if (vouch && vouch.active) {
          const sponsorValid = await hiveClient.isTopWitness(vouch.sponsorUsername, 150);
          if (sponsorValid) {
            isVouched = true;
            vouchSponsor = vouch.sponsorUsername;
          } else {
            await storage.revokeVouch(vouch.sponsorUsername, "witness_dropped");
            logWoT.warn({ sponsor: vouch.sponsorUsername, vouched: username }, "Auto-revoked vouch during session validation");
          }
        }
      }

      // Session is valid for any authenticated Hive user; witness/vouch status is metadata
      res.json({ valid: true, username, isTopWitness, isVouched, vouchSponsor, witnessRank });
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
      const witnessRank = isTopWitness ? await hiveClient.getWitnessRank(username) : null;

      // Check Web of Trust status
      let isVouched = false;
      let vouchSponsor: string | null = null;
      if (!isTopWitness) {
        const vouch = await storage.getVouchForUser(username);
        if (vouch && vouch.active) {
          const sponsorValid = await hiveClient.isTopWitness(vouch.sponsorUsername, 150);
          if (sponsorValid) {
            isVouched = true;
            vouchSponsor = vouch.sponsorUsername;
          }
        }
      }

      res.json({
        username,
        isTopWitness,
        isVouched,
        vouchSponsor,
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
    
    // Validate session token — always required
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
    if (validation.username !== username) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const validators = await storage.getAllValidators();
    const validator = validators.find(v => v.hiveUsername === username);
    
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

  app.post("/api/threespeak/pin", requireAuth, async (req, res) => {
    const pinSchema = z.object({
      ipfs: z.string().min(1, "Missing IPFS CID"),
      title: z.string().optional(),
      author: z.string().optional(),
    });
    const parsed = pinSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid request" });
      return;
    }
    const { ipfs, title, author } = parsed.data;

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
              logRoutes.info(`[Pin] Saved pinned video: ${title} (${ipfs})`);
            } else {
              logRoutes.info(`[Pin] Video already exists: ${ipfs}`);
            }
          } catch (err) {
            logRoutes.error({ err }, "Failed to save pinned video");
          }
        })
        .catch((err) => {
          logRoutes.error({ err }, `Pin failed for ${ipfs}`);
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
    try {
      const hourlyData = await storage.getChallengesLast24Hours();
      const metrics = await storage.getPerformanceMetrics();
      const nodeHealth = await storage.getNodeHealthSummary();

      // Build 24-hour trend from real data, filling in empty hours with zeros
      const hourMap = new Map(hourlyData.map(h => [h.hour, h]));
      const successRateTrend = Array.from({ length: 24 }, (_, i) => {
        const data = hourMap.get(i);
        return {
          hour: i + 1,
          successRate: data && data.totalCount > 0
            ? Number(((data.successCount / data.totalCount) * 100).toFixed(1))
            : 0,
          challengeCount: data?.totalCount || 0,
        };
      });

      const totalChallenges24h = metrics.totalChallenges;
      const failedChallenges24h = totalChallenges24h - Math.round(totalChallenges24h * (metrics.successRate / 100));
      const proofsPerHour = totalChallenges24h > 0 ? Math.round(totalChallenges24h / 24) : 0;

      // Estimate bandwidth: ~1MB per challenge (3-5 IPFS blocks of ~256KB)
      const bandwidthPerHour = proofsPerHour * 1024 * 1024;

      res.json({
        proofsPerHour,
        proofsTrend: 0,
        bandwidthPerHour,
        avgLatency: metrics.avgLatency,
        minLatency: metrics.minLatency,
        maxLatency: metrics.maxLatency,
        healthyNodes: nodeHealth.active,
        atRiskNodes: nodeHealth.probation + nodeHealth.banned,
        totalNodes: nodeHealth.total,
        yourRank: 1,
        successRateTrend,
        totalChallenges24h,
        successRate24h: Number(metrics.successRate.toFixed(1)),
        failedChallenges24h,
      });
    } catch (error: any) {
      logRoutes.error({ err: error }, "Analytics performance query error");
      res.status(500).json({ error: error.message });
    }
  });

  // Node logs: real PoA challenge logs from database
  app.get("/api/node/logs", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const logs = await storage.getRecentNodeLogs(limit);
      res.json(logs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
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

  // Get personal wallet data for a Hive user (public — Hive balances are public)
  app.get("/api/wallet/user/:username", async (req, res) => {
    try {
      const { username } = req.params;
      if (!isValidHiveUsername(username)) {
        res.status(400).json({ error: "Invalid Hive username" });
        return;
      }

      const { createHiveClient } = await import("./services/hive-client");
      const hiveClient = createHiveClient();

      const [account, payoutHist, earnings] = await Promise.all([
        hiveClient.getAccount(username),
        storage.getPayoutHistory(username, 50),
        beneficiaryService.getTotalEarnings(username),
      ]);

      if (!account) {
        res.status(404).json({ error: "Hive account not found" });
        return;
      }

      const hbdBalance = account.hbd_balance?.toString() || "0.000 HBD";

      // Build unified transaction list from payout history
      const transactions = payoutHist.map((p: any) => ({
        id: p.id,
        type: p.payoutType === "storage" || p.payoutType === "validation" ? "reward" : p.payoutType,
        from: "hive.fund",
        to: username,
        amount: `+${parseFloat(p.hbdAmount).toFixed(3)} HBD`,
        hbdAmount: p.hbdAmount,
        date: p.createdAt,
        txHash: p.txHash,
        status: p.broadcastStatus || "confirmed",
      }));

      res.json({
        username,
        hbdBalance: parseFloat(hbdBalance.replace(" HBD", "")).toFixed(3),
        totalEarned: earnings.total || "0.000",
        earningsByType: {
          storage: earnings.storage,
          encoding: earnings.encoding,
          beneficiary: earnings.beneficiary,
          validation: earnings.validation,
        },
        transactions,
      });
    } catch (error: any) {
      logRoutes.error({ err: error }, "Failed to fetch user wallet");
      res.status(500).json({ error: "Failed to fetch wallet data" });
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
  app.post("/api/wallet/deposits", requireAuth, async (req, res) => {
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
      const depositSchema = z.object({
        fromUsername: z.string().min(1).regex(/^[a-z][a-z0-9.-]{2,15}$/, "Invalid Hive username"),
        hbdAmount: z.string().min(1).refine((v) => {
          const n = parseFloat(v);
          return !isNaN(n) && n > 0 && n <= 10000;
        }, "hbdAmount must be a positive number up to 10,000"),
        memo: z.string().nullable().optional(),
        txHash: z.string().min(1),
        purpose: z.string().optional().default("storage"),
      });
      const data = depositSchema.parse(req.body);
      const deposit = await storage.createWalletDeposit({
        fromUsername: data.fromUsername,
        hbdAmount: data.hbdAmount,
        memo: data.memo || null,
        txHash: data.txHash,
        purpose: data.purpose,
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

      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        res.status(400).json({ error: "Invalid date format for periodStart or periodEnd" });
        return;
      }
      if (endDate <= startDate) {
        res.status(400).json({ error: "periodEnd must be after periodStart" });
        return;
      }

      // Prevent overlapping reports (double-pay protection)
      const overlapping = await storage.getOverlappingPayoutReports(startDate, endDate);
      if (overlapping.length > 0) {
        res.status(409).json({
          error: "A payout report already exists for an overlapping period",
          existingReports: overlapping.map(r => ({
            id: r.id,
            periodStart: r.periodStart,
            periodEnd: r.periodEnd,
            status: r.status,
          })),
        });
        return;
      }

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

  // POST /api/p2p/report — Client reports P2P session stats on cleanup (no auth, rate limited by IP)
  const p2pReportLimiter = new Map<string, number[]>();
  app.post("/api/p2p/report", async (req, res) => {
    try {
      // Simple rate limit: max 30 reports per minute per IP
      const ip = req.ip || "unknown";
      const now = Date.now();
      const recent = (p2pReportLimiter.get(ip) || []).filter(t => now - t < 60000);
      if (recent.length >= 30) {
        res.status(429).json({ error: "Too many requests" });
        return;
      }
      recent.push(now);
      p2pReportLimiter.set(ip, recent);

      const { peerId, videoCid, bytesUploaded, bytesDownloaded, p2pRatio, hiveUsername } = req.body;
      if (!peerId || !videoCid) {
        res.status(400).json({ error: "peerId and videoCid required" });
        return;
      }

      await storage.createP2pContribution({
        peerId,
        videoCid,
        hiveUsername: hiveUsername || null,
        bytesShared: bytesUploaded || 0,
        segmentsShared: Math.floor((bytesUploaded || 0) / 65536),
        sessionDurationSec: 0,
        p2pRatio: p2pRatio || 0,
      });

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/p2p/popular — Returns CIDs with most active peers (for desktop agent auto-pin)
  app.get("/api/p2p/popular", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const rooms = await storage.getActiveP2pRooms();

      const popular = rooms
        .filter(r => (r.activePeers || 0) > 0)
        .sort((a, b) => (b.activePeers || 0) - (a.activePeers || 0))
        .slice(0, limit)
        .map(r => ({
          cid: r.videoCid,
          activePeers: r.activePeers,
          totalBytesShared: r.totalBytesShared,
        }));

      res.json(popular);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // ============================================================
  // Phase 7: Hybrid Encoding API
  // ============================================================

  const { encodingService } = await import("./services/encoding-service");
  encodingService.initializeProfiles().catch((err) => logEncoding.error({ err }, "Encoding profile init failed"));

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

  app.post("/api/encoding/jobs", requireAuth, async (req, res) => {
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

  app.patch("/api/encoding/jobs/:id/progress", requireAgentAuth, async (req, res) => {
    try {
      const { progress, status } = req.body;
      await encodingService.updateJobProgress(req.params.id, progress, status);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/encoding/jobs/:id/complete", requireAgentAuth, async (req, res) => {
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

  app.post("/api/encoding/jobs/:id/fail", requireAgentAuth, async (req, res) => {
    try {
      const { errorMessage } = req.body;
      await encodingService.failJob(req.params.id, errorMessage || "Unknown error");
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/encoding/webhook", requireWebhookSignature, async (req, res) => {
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
  app.post("/api/encoding/offers", requireAuth, async (req, res) => {
    try {
      const offerSchema = z.object({
        inputCid: z.string().min(1, "inputCid is required"),
        qualitiesRequested: z.array(z.string()).min(1, "At least one quality required"),
        videoDurationSec: z.number().int().positive(),
        offeredHbd: z.string().refine((v) => {
          const n = parseFloat(v);
          return !isNaN(n) && n > 0 && n <= 100;
        }, "offeredHbd must be a positive number up to 100 HBD"),
        owner: z.string().min(1).regex(/^[a-z][a-z0-9.-]{2,15}$/, "Invalid Hive username"),
        permlink: z.string().optional(),
        expiresInHours: z.number().positive().max(168).optional(), // max 7 days
      });
      const data = offerSchema.parse(req.body);

      // Get current lowest market price for comparison
      const encoders = await storage.getMarketplaceEncoders("all", "price");
      const lowestEncoder = encoders[0];
      const marketPrice = lowestEncoder?.priceAllQualities || "0.03";

      // Create the job first (in waiting_offer state)
      const job = await storage.createEncodingJob({
        inputCid: data.inputCid,
        owner: data.owner,
        permlink: data.permlink || `offer-${Date.now()}`,
        status: "waiting_offer", // Custom status for offer-based jobs
        priority: 0,
        encodingMode: "community",
      });

      // Create the offer
      const expiresAt = new Date(Date.now() + (data.expiresInHours || 24) * 60 * 60 * 1000);
      const offer = await storage.createEncodingJobOffer({
        jobId: job.id,
        owner: data.owner,
        inputCid: data.inputCid,
        qualitiesRequested: data.qualitiesRequested.join(","),
        videoDurationSec: data.videoDurationSec,
        offeredHbd: data.offeredHbd,
        marketPriceHbd: marketPrice,
        expiresAt,
      });

      res.json({ job, offer });
    } catch (error: any) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Validation failed", details: error.errors });
        return;
      }
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
  app.post("/api/encoding/offers/:id/accept", requireAgentAuth, async (req, res) => {
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
  app.delete("/api/encoding/offers/:id", requireAuth, async (req, res) => {
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

  app.post("/api/encoding/encoders/register", requireAuth, async (req, res) => {
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

  app.post("/api/encoding/encoders/heartbeat", requireAgentAuth, async (req, res) => {
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

  app.patch("/api/encoding/settings/:username", requireAuth, async (req, res) => {
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

  app.post("/api/encoding/agent/claim", requireAgentAuth, async (req, res) => {
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

  app.post("/api/encoding/agent/progress", requireAgentAuth, async (req, res) => {
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

  app.post("/api/encoding/agent/complete", requireAgentAuth, async (req, res) => {
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

  app.post("/api/encoding/agent/fail", requireAgentAuth, async (req, res) => {
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

  app.post("/api/encoding/agent/renew-lease", requireAgentAuth, async (req, res) => {
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

  // ============================================================
  // Web of Trust — Witness Vouching System
  // ============================================================

  // GET /api/wot — List all active vouches (public)
  app.get("/api/wot", async (_req, res) => {
    try {
      const vouches = await storage.getAllActiveVouches();
      res.json(vouches);
    } catch (error) {
      logWoT.error({ err: error }, "Failed to get active vouches");
      res.status(500).json({ error: "Failed to get vouches" });
    }
  });

  // GET /api/wot/:username — Check vouch status for a user (public)
  app.get("/api/wot/:username", async (req, res) => {
    try {
      const { username } = req.params;

      // Check if user is a sponsor
      const asVoucher = await storage.getActiveVouch(username);
      // Check if user is vouched
      const asVouched = await storage.getVouchForUser(username);

      res.json({
        username,
        isVoucher: !!asVoucher,
        vouchedUser: asVoucher?.vouchedUsername || null,
        isVouched: !!(asVouched && asVouched.active),
        vouchSponsor: asVouched?.active ? asVouched.sponsorUsername : null,
      });
    } catch (error) {
      logWoT.error({ err: error }, "Failed to check vouch status");
      res.status(500).json({ error: "Failed to check vouch status" });
    }
  });

  // POST /api/wot/vouch — Vouch for a non-witness user (witness-only)
  app.post("/api/wot/vouch", async (req, res) => {
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

    // Rule 5: Vouched validators cannot vouch for others
    if (validation.isVouched) {
      res.status(403).json({ error: "Vouched validators cannot vouch for others — only direct witnesses can vouch" });
      return;
    }

    try {
      const { username: targetUsername } = req.body;

      if (!targetUsername || typeof targetUsername !== "string") {
        res.status(400).json({ error: "Missing target username" });
        return;
      }

      if (!isValidHiveUsername(targetUsername)) {
        res.status(400).json({ error: "Invalid Hive username format" });
        return;
      }

      // Cannot self-vouch
      if (targetUsername === validation.username) {
        res.status(400).json({ error: "Cannot vouch for yourself" });
        return;
      }

      // Check if sponsor already has an active vouch
      const existingVouch = await storage.getActiveVouch(validation.username);
      if (existingVouch) {
        res.status(409).json({
          error: `You already have an active vouch for @${existingVouch.vouchedUsername}. Revoke it first to vouch for someone else.`,
        });
        return;
      }

      // Check if target is already vouched by someone else
      const targetVouch = await storage.getVouchForUser(targetUsername);
      if (targetVouch && targetVouch.active) {
        res.status(409).json({
          error: `@${targetUsername} is already vouched by @${targetVouch.sponsorUsername}`,
        });
        return;
      }

      // Check if target is already a top-150 witness (no need to vouch)
      const { createHiveClient } = await import("./services/hive-client");
      const hiveClient = createHiveClient();

      const targetAccount = await hiveClient.getAccount(targetUsername);
      if (!targetAccount) {
        res.status(404).json({ error: `Hive account @${targetUsername} not found` });
        return;
      }

      const targetIsWitness = await hiveClient.isTopWitness(targetUsername, 150);
      if (targetIsWitness) {
        res.status(400).json({ error: `@${targetUsername} is already a top-150 witness — no vouch needed` });
        return;
      }

      // Get sponsor's witness rank for audit trail
      const sponsorRank = await hiveClient.getWitnessRank(validation.username);

      const vouch = await storage.createVouch({
        sponsorUsername: validation.username,
        vouchedUsername: targetUsername,
        sponsorRankAtVouch: sponsorRank || 0,
        active: true,
      });

      logWoT.info({
        sponsor: validation.username,
        vouched: targetUsername,
        sponsorRank,
      }, "New vouch created");

      res.json({
        success: true,
        vouch,
        message: `@${validation.username} has vouched for @${targetUsername}`,
      });
    } catch (error: any) {
      // Handle UNIQUE constraint violations
      if (error.code === "23505") {
        res.status(409).json({ error: "Vouch conflict — duplicate sponsor or target" });
        return;
      }
      logWoT.error({ err: error }, "Failed to create vouch");
      res.status(500).json({ error: "Failed to create vouch" });
    }
  });

  // DELETE /api/wot/vouch — Revoke your vouch (witness-only)
  app.delete("/api/wot/vouch", async (req, res) => {
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
      const existingVouch = await storage.getActiveVouch(validation.username);
      if (!existingVouch) {
        res.status(404).json({ error: "No active vouch to revoke" });
        return;
      }

      await storage.revokeVouch(validation.username, "manual");

      logWoT.info({
        sponsor: validation.username,
        revoked: existingVouch.vouchedUsername,
      }, "Vouch manually revoked");

      res.json({
        success: true,
        message: `Vouch for @${existingVouch.vouchedUsername} has been revoked`,
      });
    } catch (error) {
      logWoT.error({ err: error }, "Failed to revoke vouch");
      res.status(500).json({ error: "Failed to revoke vouch" });
    }
  });

  // ===== Desktop Agent Downloads =====

  const DOWNLOADS_DIR = path.resolve(process.cwd(), "desktop-agent", "build");
  const ALLOWED_EXTENSIONS = [".exe", ".dmg", ".AppImage", ".deb", ".rpm", ".zip", ".tar.gz"];
  const GITHUB_REPO = "Dhenz14/HivePoA";

  // Cache GitHub release data for 5 minutes
  let ghReleaseCache: { data: any; expiresAt: number } | null = null;
  const GH_CACHE_TTL = 5 * 60 * 1000;

  async function fetchGitHubRelease(): Promise<{ files: any[]; version: string | null }> {
    const now = Date.now();
    if (ghReleaseCache && now < ghReleaseCache.expiresAt) {
      return ghReleaseCache.data;
    }

    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": "HivePoA-Server" } }
    );
    if (!response.ok) throw new Error(`GitHub API: ${response.status}`);

    const release = await response.json() as any;
    const version = release.tag_name?.replace(/^v/, '') || null;
    const files = (release.assets || [])
      .filter((asset: any) => {
        const name = asset.name.toLowerCase();
        return ALLOWED_EXTENSIONS.some(ext => name.endsWith(ext.toLowerCase()));
      })
      .map((asset: any) => ({
        name: asset.name,
        size: asset.size,
        sizeFormatted: formatFileSize(asset.size),
        url: asset.browser_download_url,
      }));

    const result = { files, version };
    ghReleaseCache = { data: result, expiresAt: now + GH_CACHE_TTL };
    return result;
  }

  // GET /api/downloads/list — List available installer files (GitHub Releases → local fallback)
  app.get("/api/downloads/list", async (_req, res) => {
    try {
      // Try GitHub Releases first
      const ghData = await fetchGitHubRelease();
      if (ghData.files.length > 0) {
        res.json(ghData);
        return;
      }
    } catch (err) {
      logRoutes.debug({ err }, "GitHub release fetch failed, trying local builds");
    }

    // Fallback: serve from local build directory
    try {
      if (!fs.existsSync(DOWNLOADS_DIR)) {
        res.json({ files: [], version: null });
        return;
      }

      const allFiles = fs.readdirSync(DOWNLOADS_DIR);
      const installerFiles = allFiles
        .filter(name => {
          const lower = name.toLowerCase();
          return ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext.toLowerCase()));
        })
        .map(name => {
          const filePath = path.join(DOWNLOADS_DIR, name);
          const stats = fs.statSync(filePath);
          return {
            name,
            size: stats.size,
            sizeFormatted: formatFileSize(stats.size),
            url: `/api/downloads/file/${encodeURIComponent(name)}`,
          };
        });

      let version: string | null = null;
      for (const f of installerFiles) {
        const m = f.name.match(/(\d+\.\d+\.\d+)/);
        if (m) { version = m[1]; break; }
      }

      res.json({ files: installerFiles, version });
    } catch (error) {
      logRoutes.error({ err: error }, "Failed to list downloads");
      res.status(500).json({ error: "Failed to list downloads" });
    }
  });

  // GET /api/downloads/file/:filename — Serve an installer file
  app.get("/api/downloads/file/:filename", (req, res) => {
    const { filename } = req.params;
    const decodedName = decodeURIComponent(filename);

    // Security: prevent path traversal
    if (decodedName.includes("..") || decodedName.includes("/") || decodedName.includes("\\")) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }

    // Only allow whitelisted extensions
    const lower = decodedName.toLowerCase();
    if (!ALLOWED_EXTENSIONS.some(ext => lower.endsWith(ext.toLowerCase()))) {
      res.status(403).json({ error: "File type not allowed" });
      return;
    }

    const filePath = path.join(DOWNLOADS_DIR, decodedName);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const stat = fs.statSync(filePath);
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="${decodedName}"`);
    res.setHeader("Content-Type", "application/octet-stream");

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });

  function formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  return httpServer;
}
