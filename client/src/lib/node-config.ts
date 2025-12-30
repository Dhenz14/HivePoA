/**
 * Node Configuration Manager
 * Manages connection settings for IPFS nodes - stored in localStorage
 */

export type ConnectionMode = "demo" | "local" | "remote";

export interface NodeConfig {
  mode: ConnectionMode;
  ipfsApiUrl: string;
  ipfsGatewayUrl: string;
  hiveUsername: string;
  isConnected: boolean;
  peerId: string | null;
  lastConnected: string | null;
}

const STORAGE_KEY = "hivepoa_node_config";

const DEFAULT_CONFIG: NodeConfig = {
  mode: "demo",
  ipfsApiUrl: "http://127.0.0.1:5001",
  ipfsGatewayUrl: "http://127.0.0.1:8080",
  hiveUsername: "",
  isConnected: false,
  peerId: null,
  lastConnected: null,
};

export function getNodeConfig(): NodeConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error("[NodeConfig] Failed to load config:", e);
  }
  return DEFAULT_CONFIG;
}

export function saveNodeConfig(config: Partial<NodeConfig>): NodeConfig {
  const current = getNodeConfig();
  const updated = { ...current, ...config };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error("[NodeConfig] Failed to save config:", e);
  }
  return updated;
}

export function clearNodeConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (e) {
    console.error("[NodeConfig] Failed to clear config:", e);
  }
}

export async function testIPFSConnection(apiUrl: string): Promise<{
  success: boolean;
  peerId?: string;
  error?: string;
}> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(`${apiUrl}/api/v0/id`, {
      method: "POST",
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }
    
    const data = await response.json();
    return { success: true, peerId: data.ID };
  } catch (e: any) {
    if (e.name === "AbortError") {
      return { success: false, error: "Connection timeout (10s)" };
    }
    return { success: false, error: e.message || "Connection failed" };
  }
}

export async function getIPFSStats(apiUrl: string): Promise<{
  repoSize: number;
  numObjects: number;
  peerId: string;
  addresses: string[];
} | null> {
  try {
    const [idRes, repoRes] = await Promise.all([
      fetch(`${apiUrl}/api/v0/id`, { method: "POST" }),
      fetch(`${apiUrl}/api/v0/repo/stat`, { method: "POST" }),
    ]);
    
    if (!idRes.ok || !repoRes.ok) return null;
    
    const id = await idRes.json();
    const repo = await repoRes.json();
    
    return {
      peerId: id.ID,
      addresses: id.Addresses || [],
      repoSize: repo.RepoSize || 0,
      numObjects: repo.NumObjects || 0,
    };
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${bytes} B`;
}
