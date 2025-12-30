import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { 
  getNodeConfig, 
  saveNodeConfig, 
  testIPFSConnection,
  getIPFSStats,
  type NodeConfig, 
  type ConnectionMode 
} from "@/lib/node-config";

interface NodeConfigContextValue {
  config: NodeConfig;
  setMode: (mode: ConnectionMode) => void;
  updateConfig: (updates: Partial<NodeConfig>) => void;
  testConnection: () => Promise<{ success: boolean; error?: string }>;
  ipfsStats: {
    repoSize: number;
    numObjects: number;
    peerId: string;
    addresses: string[];
  } | null;
  isTesting: boolean;
  refreshStats: () => Promise<void>;
}

const NodeConfigContext = createContext<NodeConfigContextValue | null>(null);

export function NodeConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<NodeConfig>(getNodeConfig);
  const [isTesting, setIsTesting] = useState(false);
  const [ipfsStats, setIpfsStats] = useState<{
    repoSize: number;
    numObjects: number;
    peerId: string;
    addresses: string[];
  } | null>(null);

  const refreshStats = async () => {
    if (config.mode !== "demo" && config.isConnected) {
      const stats = await getIPFSStats(config.ipfsApiUrl);
      setIpfsStats(stats);
    }
  };

  useEffect(() => {
    refreshStats();
  }, [config.isConnected, config.mode]);

  const setMode = (mode: ConnectionMode) => {
    const updated = saveNodeConfig({ 
      mode, 
      isConnected: mode === "demo",
      peerId: mode === "demo" ? "demo-mode" : null,
    });
    setConfig(updated);
    setIpfsStats(null);
  };

  const updateConfig = (updates: Partial<NodeConfig>) => {
    const updated = saveNodeConfig({ ...updates, isConnected: false });
    setConfig(updated);
  };

  const testConnection = async () => {
    setIsTesting(true);
    
    const result = await testIPFSConnection(config.ipfsApiUrl);
    
    if (result.success) {
      const updated = saveNodeConfig({
        isConnected: true,
        peerId: result.peerId || null,
        lastConnected: new Date().toISOString(),
      });
      setConfig(updated);
      refreshStats();
    } else {
      const updated = saveNodeConfig({ isConnected: false, peerId: null });
      setConfig(updated);
    }
    
    setIsTesting(false);
    return result;
  };

  return (
    <NodeConfigContext.Provider value={{
      config,
      setMode,
      updateConfig,
      testConnection,
      ipfsStats,
      isTesting,
      refreshStats,
    }}>
      {children}
    </NodeConfigContext.Provider>
  );
}

export function useNodeConfig() {
  const context = useContext(NodeConfigContext);
  if (!context) {
    throw new Error("useNodeConfig must be used within a NodeConfigProvider");
  }
  return context;
}
