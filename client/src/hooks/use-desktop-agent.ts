import { useState, useEffect, useCallback, useRef } from "react";

const AGENT_URL = "http://127.0.0.1:5111";

export interface AgentStatus {
  running: boolean;
  peerId: string | null;
  stats: { repoSize: number; numObjects: number } | null;
  storageInfo?: {
    usedBytes: number;
    maxBytes: number;
    usedFormatted: string;
    maxFormatted: string;
    percentage: number;
  };
  config: {
    hiveUsername: string | null;
    autoStart: boolean;
    bandwidthLimitUp: number;
    bandwidthLimitDown: number;
    storageMaxGB: number;
    p2pMode: boolean;
    validatorEnabled: boolean;
    challengeIntervalMs: number;
  };
  network: {
    p2pMode: boolean;
    peerCount: number;
    validatorEnabled: boolean;
    validationStats: { issued: number; passed: number; failed: number; timeouts: number };
    hasPostingKey: boolean;
  };
  earnings: {
    totalHbd: number;
    challengesPassed: number;
    consecutivePasses: number;
  };
  version?: string;
}

/**
 * Desktop agent hook — auto-detects, polls status, and provides pin/unpin ops.
 * Polls every 5s. Returns full agent status for UI rendering.
 */
export function useDesktopAgent() {
  const [isRunning, setIsRunning] = useState<boolean | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [pins, setPins] = useState<string[]>([]);
  const pollingRef = useRef(false);

  const fetchStatus = useCallback(async (): Promise<boolean> => {
    if (pollingRef.current) return isRunning || false;
    pollingRef.current = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${AGENT_URL}/api/status`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) { setIsRunning(false); setStatus(null); return false; }
      const data: AgentStatus = await res.json();
      setIsRunning(data.running);
      setStatus(data);
      return data.running;
    } catch {
      setIsRunning(false);
      setStatus(null);
      return false;
    } finally {
      pollingRef.current = false;
    }
  }, [isRunning]);

  const fetchPins = useCallback(async (): Promise<string[]> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${AGENT_URL}/api/pins`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return [];
      const data = await res.json();
      const list: string[] = data.pins || [];
      setPins(list);
      return list;
    } catch { return []; }
  }, []);

  const pinCid = useCallback(async (cid: string): Promise<boolean> => {
    try {
      const res = await fetch(`${AGENT_URL}/api/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cid }),
      });
      if (res.ok) fetchPins();
      return res.ok;
    } catch { return false; }
  }, [fetchPins]);

  const unpinCid = useCallback(async (cid: string): Promise<boolean> => {
    try {
      const res = await fetch(`${AGENT_URL}/api/unpin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cid }),
      });
      if (res.ok) fetchPins();
      return res.ok;
    } catch { return false; }
  }, [fetchPins]);

  const check = useCallback(async (): Promise<boolean> => {
    return fetchStatus();
  }, [fetchStatus]);

  // Poll status every 5 seconds
  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  // Fetch pins once agent is detected
  useEffect(() => {
    if (isRunning) fetchPins();
  }, [isRunning, fetchPins]);

  return { isRunning, status, pins, check, pinCid, unpinCid, refreshPins: fetchPins };
}
