// API client for HivePoA backend
const API_BASE = "/api";

export interface File {
  id: string;
  cid: string;
  name: string;
  size: string;
  uploaderUsername: string;
  status: string;
  replicationCount: number;
  confidence: number;
  poaEnabled: boolean;
  createdAt: string;
}

export interface StorageNode {
  id: string;
  peerId: string;
  hiveUsername: string;
  reputation: number;
  status: string;
  totalProofs: number;
  failedProofs: number;
  lastSeen: string;
  createdAt: string;
}

export interface Validator {
  id: string;
  hiveUsername: string;
  hiveRank: number;
  status: string;
  peerCount: number;
  performance: number;
  jobAllocation: number;
  payoutRate: number;
  version: string;
  createdAt: string;
}

export interface PoaChallenge {
  id: string;
  validatorId: string;
  nodeId: string;
  fileId: string;
  challengeData: string;
  response: string | null;
  result: string | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface HiveTransaction {
  id: string;
  type: string;
  fromUser: string;
  toUser: string | null;
  payload: string;
  blockNumber: number;
  createdAt: string;
}

export interface DashboardStats {
  files: {
    total: number;
    pinned: number;
    syncing: number;
  };
  nodes: {
    total: number;
    active: number;
    probation: number;
    banned: number;
  };
  validators: {
    total: number;
    online: number;
  };
  challenges: {
    total: number;
    success: number;
    failed: number;
    successRate: string;
  };
  rewards: {
    totalHBD: string;
    transactions: number;
  };
}

export interface ValidatorBlacklist {
  id: string;
  validatorId: string;
  nodeId: string;
  reason: string;
  active: boolean;
  createdAt: string;
}

export const api = {
  // Files
  async getFiles(): Promise<File[]> {
    const res = await fetch(`${API_BASE}/files`);
    return res.json();
  },

  async getFile(cid: string): Promise<File> {
    const res = await fetch(`${API_BASE}/files/${cid}`);
    return res.json();
  },

  async createFile(data: Partial<File>): Promise<File> {
    const res = await fetch(`${API_BASE}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async deleteFile(id: string): Promise<{ success: boolean; message: string }> {
    const res = await fetch(`${API_BASE}/files/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to delete file");
    }
    return res.json();
  },

  // Storage Nodes
  async getNodes(): Promise<StorageNode[]> {
    const res = await fetch(`${API_BASE}/nodes`);
    return res.json();
  },

  async searchNodes(query: string): Promise<StorageNode[]> {
    const res = await fetch(`${API_BASE}/nodes?search=${encodeURIComponent(query)}`);
    return res.json();
  },

  async getNode(peerId: string): Promise<StorageNode> {
    const res = await fetch(`${API_BASE}/nodes/${peerId}`);
    return res.json();
  },

  // Validators
  async getValidators(): Promise<Validator[]> {
    const res = await fetch(`${API_BASE}/validators`);
    return res.json();
  },

  async getValidator(username: string): Promise<Validator> {
    const res = await fetch(`${API_BASE}/validators/${username}`);
    return res.json();
  },

  // Validator Blacklist
  async getBlacklist(validatorUsername: string): Promise<ValidatorBlacklist[]> {
    const res = await fetch(`${API_BASE}/validators/${validatorUsername}/blacklist`);
    return res.json();
  },

  async addToBlacklist(validatorUsername: string, nodeId: string, reason: string): Promise<ValidatorBlacklist> {
    const res = await fetch(`${API_BASE}/validators/${validatorUsername}/blacklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId, reason }),
    });
    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.error || "Failed to blacklist node");
    }
    return res.json();
  },

  async removeFromBlacklist(validatorUsername: string, nodeId: string): Promise<void> {
    await fetch(`${API_BASE}/validators/${validatorUsername}/blacklist/${nodeId}`, {
      method: "DELETE",
    });
  },

  // PoA Challenges
  async getChallenges(limit: number = 50): Promise<PoaChallenge[]> {
    const res = await fetch(`${API_BASE}/challenges?limit=${limit}`);
    return res.json();
  },

  // Hive Transactions
  async getTransactions(limit: number = 50): Promise<HiveTransaction[]> {
    const res = await fetch(`${API_BASE}/transactions?limit=${limit}`);
    return res.json();
  },

  // Dashboard Stats
  async getStats(): Promise<DashboardStats> {
    const res = await fetch(`${API_BASE}/stats`);
    return res.json();
  },
};

// WebSocket connection for real-time updates
export function connectWebSocket(onMessage: (data: any) => void) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

  ws.onopen = () => {
    console.log("[WebSocket] Connected to HivePoA event stream");
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    onMessage(data);
  };

  ws.onerror = (error) => {
    console.error("[WebSocket] Error:", error);
  };

  ws.onclose = () => {
    console.log("[WebSocket] Disconnected. Reconnecting in 3s...");
    setTimeout(() => connectWebSocket(onMessage), 3000);
  };

  return ws;
}
