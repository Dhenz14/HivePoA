import { useState, useEffect, useCallback } from "react";

const AGENT_URL = "http://127.0.0.1:5111";

export function useDesktopAgent() {
  const [isRunning, setIsRunning] = useState<boolean | null>(null);

  const check = useCallback(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${AGENT_URL}/api/status`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      setIsRunning(res.ok);
      return res.ok;
    } catch {
      setIsRunning(false);
      return false;
    }
  }, []);

  useEffect(() => {
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, [check]);

  return { isRunning, check };
}
