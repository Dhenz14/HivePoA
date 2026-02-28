import { WebSocket } from "ws";
import { storage } from "../storage";
import { logWS } from "../logger";

interface ConnectedAgent {
  ws: WebSocket;
  peerId: string;
  hiveUsername: string;
  nodeId: string;
  connectedAt: number;
  lastPong: number;
}

const MAX_PENDING_CHALLENGES = 5000;

class AgentWSManager {
  private agents: Map<string, ConnectedAgent> = new Map();
  private peerToNode: Map<string, string> = new Map();
  private pendingChallenges: Map<string, {
    resolve: (result: any) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  async handleConnection(ws: WebSocket): Promise<void> {
    let registered = false;

    // Store registration timeout so we can clean it up on close
    const registrationTimeout = setTimeout(() => {
      if (!registered && ws.readyState === WebSocket.OPEN) {
        ws.close(4001, "Registration timeout");
      }
    }, 10_000);

    ws.on("message", async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === "register") {
          await this.handleRegister(ws, message);
          registered = true;
        } else if (message.type === "ProofResponse") {
          // Validate required fields before processing
          if (typeof message.CID === "string" && typeof message.Hash === "string") {
            this.handleProofResponse(message);
          } else {
            logWS.warn("ProofResponse missing CID or Hash fields, dropping");
          }
        } else if (message.type === "SendCIDS") {
          logWS.debug({ parts: message.part }, "Received CID list from agent");
        } else if (message.type === "PingPongPong") {
          // Liveness response — handled by pong event
        }
      } catch (err) {
        logWS.error({ err }, "Failed to parse agent message");
      }
    });

    ws.on("close", () => {
      clearTimeout(registrationTimeout);

      // Clean up agent entry and any pending challenges for this agent
      const entries = Array.from(this.agents.entries());
      for (const [nodeId, agent] of entries) {
        if (agent.ws === ws) {
          logWS.info({ username: agent.hiveUsername, nodeId }, "Agent disconnected");
          this.agents.delete(nodeId);
          this.peerToNode.delete(agent.peerId);

          // Resolve any pending challenges for this node as failures
          const pendingEntries = Array.from(this.pendingChallenges.entries());
          for (const [key, pending] of pendingEntries) {
            if (key.startsWith(nodeId + ":")) {
              clearTimeout(pending.timeout);
              this.pendingChallenges.delete(key);
              pending.resolve({ status: "fail", elapsed: 0, error: "AGENT_DISCONNECTED" });
            }
          }
          break;
        }
      }
    });

    ws.on("pong", () => {
      const agents = Array.from(this.agents.values());
      for (const agent of agents) {
        if (agent.ws === ws) {
          agent.lastPong = Date.now();
          break;
        }
      }
    });
  }

  private async handleRegister(ws: WebSocket, message: any): Promise<void> {
    const { peerId, hiveUsername, version, storageMaxGB } = message;

    if (!peerId || !hiveUsername) {
      ws.send(JSON.stringify({ type: "error", message: "Missing peerId or hiveUsername" }));
      ws.close(4002, "Invalid registration");
      return;
    }

    // Validate Hive username format
    if (!/^[a-z][a-z0-9.-]{2,15}$/.test(hiveUsername)) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid Hive username format" }));
      ws.close(4003, "Invalid username");
      return;
    }

    // Verify Hive account exists on-chain
    try {
      const { createHiveClient } = await import("./hive-client");
      const hiveClient = createHiveClient();
      const account = await hiveClient.getAccount(hiveUsername);
      if (!account) {
        ws.send(JSON.stringify({ type: "error", message: "Hive account not found on-chain" }));
        ws.close(4004, "Account not found");
        return;
      }
    } catch (err) {
      // Allow registration even if Hive API is down
      logWS.warn({ err, hiveUsername }, "Hive verification failed, allowing registration");
    }

    // Create or update storageNode in DB using upsert to avoid TOCTOU race
    let node;
    try {
      node = await storage.getStorageNodeByPeerId(peerId);
      if (!node) {
        node = await storage.createStorageNode({
          peerId,
          hiveUsername,
          endpoint: null,
          reputation: 50,
          status: "active",
        });
        logWS.info({ hiveUsername, nodeId: node.id, peerId, version }, "New agent registered");
      } else {
        await storage.updateStorageNodeLastSeen(node.id);
        logWS.info({ hiveUsername, nodeId: node.id, peerId, version }, "Agent reconnected");
      }
    } catch (err: any) {
      // Handle unique constraint violation (concurrent registration with same peerId)
      if (err?.code === "23505") {
        node = await storage.getStorageNodeByPeerId(peerId);
        if (node) {
          await storage.updateStorageNodeLastSeen(node.id);
          logWS.info({ hiveUsername, nodeId: node.id, peerId, version }, "Agent reconnected (after race)");
        } else {
          logWS.error({ err, peerId }, "Failed to register agent after constraint violation");
          ws.close(4006, "Registration failed");
          return;
        }
      } else {
        logWS.error({ err, peerId }, "Failed to register agent");
        ws.close(4006, "Registration failed");
        return;
      }
    }

    // Close any existing connection for this node and clean up pending challenges
    const existing = this.agents.get(node.id);
    if (existing) {
      existing.ws.close(4005, "Replaced by new connection");
    }

    this.agents.set(node.id, {
      ws,
      peerId,
      hiveUsername,
      nodeId: node.id,
      connectedAt: Date.now(),
      lastPong: Date.now(),
    });
    this.peerToNode.set(peerId, node.id);

    ws.send(JSON.stringify({
      type: "registered",
      nodeId: node.id,
      message: `Welcome ${hiveUsername}! Your node is now receiving challenges.`,
    }));
  }

  private handleProofResponse(message: any): void {
    // Look up by nodeId-prefixed key — find the matching pending challenge
    // Agent sends back CID + Hash which we use to construct the key
    const suffix = `${message.CID}:${message.Hash}`;

    // Search pendingChallenges for a key ending with the suffix
    const entries = Array.from(this.pendingChallenges.entries());
    for (const [key, pending] of entries) {
      if (key.endsWith(suffix)) {
        clearTimeout(pending.timeout);
        this.pendingChallenges.delete(key);
        pending.resolve({
          status: message.Status === "Success" ? "success" : "fail",
          proofHash: message.proofHash,
          elapsed: message.elapsed || 0,
          error: message.error,
        });
        return;
      }
    }

    logWS.debug({ cid: message.CID }, "Received ProofResponse with no matching pending challenge");
  }

  /**
   * Send a PoA challenge to a connected agent and wait for the response.
   * Called by the PoA engine instead of opening a new outbound WebSocket.
   */
  async challengeAgent(
    nodeId: string,
    cid: string,
    salt: string,
    validatorUsername: string,
    timeoutMs: number = 30_000
  ): Promise<{ status: "success" | "fail" | "timeout"; proofHash?: string; elapsed: number; error?: string }> {
    const agent = this.agents.get(nodeId);
    if (!agent || agent.ws.readyState !== WebSocket.OPEN) {
      return { status: "fail", elapsed: 0, error: "AGENT_NOT_CONNECTED" };
    }

    // Cap pending challenges to prevent memory exhaustion
    if (this.pendingChallenges.size >= MAX_PENDING_CHALLENGES) {
      logWS.warn({ count: this.pendingChallenges.size }, "Pending challenges at capacity, rejecting new challenge");
      return { status: "fail", elapsed: 0, error: "TOO_MANY_PENDING_CHALLENGES" };
    }

    // Include nodeId in challenge key to prevent collisions
    const challengeKey = `${nodeId}:${cid}:${salt}`;

    // If a challenge with this key already exists, don't overwrite
    if (this.pendingChallenges.has(challengeKey)) {
      return { status: "fail", elapsed: 0, error: "DUPLICATE_CHALLENGE" };
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingChallenges.delete(challengeKey);
        resolve({ status: "timeout", elapsed: timeoutMs });
      }, timeoutMs);

      this.pendingChallenges.set(challengeKey, { resolve, timeout });

      // Send challenge in SPK PoA protocol format
      agent.ws.send(JSON.stringify({
        type: "RequestProof",
        Hash: salt,
        CID: cid,
        User: validatorUsername,
        Status: "Pending",
      }));
    });
  }

  isAgentConnected(nodeId: string): boolean {
    const agent = this.agents.get(nodeId);
    return !!agent && agent.ws.readyState === WebSocket.OPEN;
  }

  getConnectedAgentCount(): number {
    return this.agents.size;
  }

  getConnectedAgents(): Array<{ nodeId: string; hiveUsername: string; connectedAt: number }> {
    return Array.from(this.agents.values()).map((a) => ({
      nodeId: a.nodeId,
      hiveUsername: a.hiveUsername,
      connectedAt: a.connectedAt,
    }));
  }
}

export const agentWSManager = new AgentWSManager();
