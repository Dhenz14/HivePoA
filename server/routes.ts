import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { hiveSimulator } from "./services/hive-simulator";
import { poaEngine } from "./services/poa-engine";
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

    // Send recent transactions on connect
    storage.getRecentTransactions(10).then((txs) => {
      ws.send(JSON.stringify({ type: "transactions", data: txs }));
    });

    // Forward Hive events to connected clients
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

      // Broadcast upload event
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
      
      // Check if already actively blacklisted
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

  // Hive Transactions API (blockchain event log)
  app.get("/api/transactions", async (req, res) => {
    const limit = parseInt(req.query.limit as string) || 50;
    const transactions = await storage.getRecentTransactions(limit);
    res.json(transactions);
  });

  // Dashboard Stats API
  app.get("/api/stats", async (req, res) => {
    const [files, nodes, validators, challenges, transactions] = await Promise.all([
      storage.getAllFiles(),
      storage.getAllStorageNodes(),
      storage.getAllValidators(),
      storage.getRecentChallenges(100),
      storage.getRecentTransactions(24 * 60), // Last 24h worth (if 1/min)
    ]);

    const totalProofs = challenges.filter(c => c.result === "success").length;
    const failedProofs = challenges.filter(c => c.result === "fail").length;
    const successRate = totalProofs + failedProofs > 0 
      ? (totalProofs / (totalProofs + failedProofs) * 100).toFixed(1)
      : "0.0";

    const hbdTransfers = transactions.filter(t => t.type === "hbd_transfer");
    const totalPayouts = hbdTransfers.length * 0.001; // 0.001 HBD per reward

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
    });
  });

  return httpServer;
}
