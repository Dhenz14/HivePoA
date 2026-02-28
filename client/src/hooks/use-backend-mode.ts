import { useState, useEffect } from "react";
import { type BackendMode, getBackendMode, onModeChange, detectBackendMode } from "@/lib/api-mode";

/**
 * React hook for backend mode detection.
 * Returns the current mode and whether detection is complete.
 */
export function useBackendMode(): { mode: BackendMode; isReady: boolean } {
  const [mode, setMode] = useState<BackendMode>(getBackendMode());

  useEffect(() => {
    // Subscribe to mode changes
    const unsub = onModeChange(setMode);

    // Trigger detection if not yet done
    if (mode === "checking") {
      detectBackendMode().then(setMode);
    }

    return unsub;
  }, []);

  return {
    mode,
    isReady: mode !== "checking",
  };
}
