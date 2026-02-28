/**
 * Backend mode detection for dual-mode operation.
 *
 * In development: API calls go to the same origin (Express server).
 * On GitHub Pages: API calls go to localhost:5111 (desktop agent).
 *
 * The mode is detected once on app init by probing the desktop agent.
 * If the agent is running, all API calls are routed through it.
 * If not, the app runs in "standalone" mode with limited functionality.
 */

const AGENT_URL = "http://127.0.0.1:5111";

export type BackendMode = "agent" | "server" | "standalone" | "checking";

let _mode: BackendMode = "checking";
let _modePromise: Promise<BackendMode> | null = null;
const _listeners: Array<(mode: BackendMode) => void> = [];

/**
 * Detect backend mode by probing the desktop agent and checking
 * if we're running on the same origin as an Express server.
 */
export async function detectBackendMode(): Promise<BackendMode> {
  if (_mode !== "checking") return _mode;
  if (_modePromise) return _modePromise;

  _modePromise = (async () => {
    // If we're on localhost with the Express server (dev mode), use same-origin
    const isLocalDev = typeof window !== "undefined" &&
      (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
      window.location.port !== "";

    // Try to detect the desktop agent
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${AGENT_URL}/api/status`, {
        signal: controller.signal,
        mode: "cors",
      });
      clearTimeout(timeout);
      if (res.ok) {
        _mode = "agent";
        notifyListeners();
        return _mode;
      }
    } catch {
      // Agent not available
    }

    // No agent — check if we're in local dev with Express server
    if (isLocalDev) {
      _mode = "server";
    } else {
      _mode = "standalone";
    }
    notifyListeners();
    return _mode;
  })();

  return _modePromise;
}

function notifyListeners() {
  for (const fn of _listeners) {
    fn(_mode);
  }
}

/** Subscribe to mode changes. Returns unsubscribe function. */
export function onModeChange(fn: (mode: BackendMode) => void): () => void {
  _listeners.push(fn);
  return () => {
    const idx = _listeners.indexOf(fn);
    if (idx >= 0) _listeners.splice(idx, 1);
  };
}

/** Get current backend mode (may be "checking" if not yet detected). */
export function getBackendMode(): BackendMode {
  return _mode;
}

/**
 * Get the API base URL for fetch calls.
 * - "agent" mode: http://127.0.0.1:5111
 * - "server" mode: "" (same-origin, relative URLs)
 * - "standalone" mode: "" (calls will fail gracefully)
 */
export function getApiBase(): string {
  if (_mode === "agent") return AGENT_URL;
  return "";
}

/** Check if a backend is available (either agent or server). */
export function hasBackend(): boolean {
  return _mode === "agent" || _mode === "server";
}
