import WebSocket from "ws";
import { createRandomHash } from "./poa-crypto";

export interface SPKNodeConfig {
  url: string;
  username: string;
}

export interface ValidationRequest {
  type: "RequestProof";
  Hash: string;
  CID: string;
  Status: string;
  User: string;
}

export interface ValidationResponse {
  status: "success" | "fail" | "timeout";
  name: string;
  elapsed: number;
  proofHash?: string;
}

export interface NodeStats {
  syncStatus: boolean;
  nodeType: string;
  peerCount: number;
  version: string;
}

export class SPKPoAClient {
  private config: SPKNodeConfig;
  private connected: boolean = false;
  private ws: WebSocket | null = null;
  private pendingValidations: Map<string, {
    resolve: (response: ValidationResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();

  constructor(config: SPKNodeConfig) {
    this.config = config;
  }

  get isConnected(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.config.url.replace(/^http/, "ws");
      this.ws = new WebSocket(`${wsUrl}/validate`);

      this.ws.on("open", () => {
        console.log(`[SPK PoA] Connected to ${this.config.url}`);
        this.connected = true;
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (err) {
          console.error("[SPK PoA] Failed to parse message:", err);
        }
      });

      this.ws.on("error", (err) => {
        console.error("[SPK PoA] WebSocket error:", err);
        if (!this.connected) {
          reject(err);
        }
      });

      this.ws.on("close", () => {
        console.log("[SPK PoA] Disconnected");
        this.connected = false;
        this.cleanupPendingValidations();
      });

      setTimeout(() => {
        if (!this.connected) {
          reject(new Error("Connection timeout"));
        }
      }, 10000);
    });
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.cleanupPendingValidations();
  }

  private cleanupPendingValidations(): void {
    this.pendingValidations.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    });
    this.pendingValidations.clear();
  }

  private handleMessage(message: any): void {
    const key = message.Hash || message.hash;
    if (key) {
      const pending = this.pendingValidations.get(key);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingValidations.delete(key);
        
        const response: ValidationResponse = {
          status: message.Status === "Success" || message.status === "success" ? "success" : "fail",
          name: message.User || message.name || "",
          elapsed: message.elapsed || message.Elapsed || 0,
          proofHash: message.proofHash || message.ProofHash,
        };
        pending.resolve(response);
      }
    }
  }

  async validate(cid: string, salt?: string): Promise<ValidationResponse> {
    if (!this.isConnected) {
      throw new Error("Not connected to SPK PoA node");
    }

    const validationHash = salt || createRandomHash();
    
    const request: ValidationRequest = {
      type: "RequestProof",
      Hash: validationHash,
      CID: cid,
      Status: "Pending",
      User: this.config.username,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingValidations.delete(validationHash);
        resolve({
          status: "timeout",
          name: this.config.username,
          elapsed: 30000,
        });
      }, 30000);

      this.pendingValidations.set(validationHash, { resolve, reject, timeout });
      
      this.ws!.send(JSON.stringify(request));
      console.log(`[SPK PoA] Sent validation request for CID: ${cid} with Hash: ${validationHash.slice(0, 16)}...`);
    });
  }

  async getStats(): Promise<NodeStats | null> {
    try {
      const response = await fetch(`${this.config.url}/getstats`);
      if (!response.ok) {
        return null;
      }
      return await response.json();
    } catch (err) {
      console.error("[SPK PoA] Failed to get stats:", err);
      return null;
    }
  }
}

export class MockSPKPoAClient {
  private config: SPKNodeConfig;
  private successRate: number = 0.85;

  constructor(config: SPKNodeConfig) {
    this.config = config;
  }

  get isConnected(): boolean {
    return true;
  }

  async connect(): Promise<void> {
    console.log(`[Mock SPK PoA] Simulating connection to ${this.config.url}`);
  }

  disconnect(): void {
    console.log("[Mock SPK PoA] Disconnected");
  }

  async validate(cid: string, salt?: string): Promise<ValidationResponse> {
    const elapsed = Math.floor(Math.random() * 2000) + 100;
    
    await new Promise(r => setTimeout(r, elapsed));
    
    const success = Math.random() < this.successRate;
    
    return {
      status: success ? "success" : "fail",
      name: this.config.username,
      elapsed,
      proofHash: success ? createRandomHash() : undefined,
    };
  }

  async getStats(): Promise<NodeStats> {
    return {
      syncStatus: true,
      nodeType: "validator",
      peerCount: Math.floor(Math.random() * 50) + 10,
      version: "v0.5.0",
    };
  }

  setSuccessRate(rate: number): void {
    this.successRate = Math.max(0, Math.min(1, rate));
  }
}

export function createSPKClient(config: SPKNodeConfig): SPKPoAClient | MockSPKPoAClient {
  if (process.env.SPK_POA_URL) {
    return new SPKPoAClient({
      url: process.env.SPK_POA_URL,
      username: config.username,
    });
  }
  return new MockSPKPoAClient(config);
}
