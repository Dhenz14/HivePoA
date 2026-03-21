/**
 * GPU Agent Communication — client-side helper for GPU contribution
 *
 * Communicates with the Desktop Agent's /api/gpu/* endpoints at port 5111.
 * Used by gpu-dashboard.tsx and community-cloud.tsx.
 */

const AGENT_URL = "http://127.0.0.1:5111";

export interface GpuDeps {
  nvidia: { ok: boolean; name?: string; vramGb?: number; driver?: string; error?: string };
  docker: { ok: boolean; version?: string; error?: string };
  toolkit: { ok: boolean; error?: string };
  vram: { ok: boolean; totalGb?: number; availableGb?: number; warning?: string };
  allOk: boolean;
}

export interface GpuMetrics {
  temperatureC: number;
  vramUsedMb: number;
  vramFreeMb: number;
  vramTotalMb: number;
  utilizationPct: number;
  fanSpeedPct: number;
  powerDrawW: number;
  powerLimitW: number;
  timestamp: number;
}

export interface GpuInfo {
  name: string;
  vramTotalMb: number;
  vramTotalGb: number;
  uuid: string;
  driverVersion: string;
  cudaVersion: string;
}

export interface GpuContributionStatus {
  state: "stopped" | "checking_deps" | "starting" | "running" | "paused" | "draining" | "gaming_mode" | "error";
  gpuInfo: GpuInfo | null;
  metrics: GpuMetrics | null;
  container: { state: string; containerId?: string; uptime?: string } | null;
  config: {
    enabled: boolean;
    mode: "local" | "pool" | "cluster" | "lend";
    vramUtilization: number;
    model: string;
    autoGamingMode: boolean;
    lendTargetIp: string | null;
  };
  uptimeMs: number;
  totalTokens: number;
  totalRequests: number;
  estimatedHbdEarned: number;
  error: string | null;
}

export interface GpuEarnings {
  totalTokens: number;
  totalRequests: number;
  estimatedHbdEarned: number;
  uptimeMs: number;
  state: string;
}

async function gpuFetch<T>(path: string, options?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${AGENT_URL}/api/gpu${path}`, {
      ...options,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

async function gpuPost<T>(path: string, body?: any): Promise<T | null> {
  return gpuFetch<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

/** Check if the GPU agent is reachable. */
export async function detectGpuAgent(): Promise<boolean> {
  const status = await gpuFetch<GpuContributionStatus>("/status");
  return status !== null;
}

/** Check all dependencies for GPU contribution. */
export async function checkGpuDeps(): Promise<GpuDeps | null> {
  return gpuFetch<GpuDeps>("/deps");
}

/** Get GPU hardware info. */
export async function getGpuInfo(): Promise<GpuInfo | null> {
  return gpuFetch<GpuInfo>("/info");
}

/** Get real-time GPU metrics (temp, VRAM, utilization). */
export async function getGpuMetrics(): Promise<GpuMetrics | null> {
  return gpuFetch<GpuMetrics>("/metrics");
}

/** Get full contribution status. */
export async function getGpuStatus(): Promise<GpuContributionStatus | null> {
  return gpuFetch<GpuContributionStatus>("/status");
}

/** Get earnings summary. */
export async function getGpuEarnings(): Promise<GpuEarnings | null> {
  return gpuFetch<GpuEarnings>("/earnings");
}

/** Start GPU contribution. */
export async function startGpuContribution(config?: {
  mode?: "local" | "pool" | "cluster" | "lend";
  vramUtilization?: number;
  model?: string;
  hiveUsername?: string;
  lendTargetIp?: string;
}): Promise<{ success: boolean; error?: string }> {
  const result = await gpuPost<{ success: boolean; error?: string }>("/start", config);
  return result || { success: false, error: "Agent not reachable" };
}

/** Stop GPU contribution. */
export async function stopGpuContribution(): Promise<{ success: boolean }> {
  const result = await gpuPost<{ success: boolean }>("/stop");
  return result || { success: false };
}

/** Pause GPU contribution. */
export async function pauseGpuContribution(): Promise<{ success: boolean }> {
  const result = await gpuPost<{ success: boolean }>("/pause");
  return result || { success: false };
}

/** Resume GPU contribution. */
export async function resumeGpuContribution(): Promise<{ success: boolean }> {
  const result = await gpuPost<{ success: boolean }>("/resume");
  return result || { success: false };
}

/** Enter gaming mode (manual trigger). */
export async function enterGamingMode(): Promise<{ success: boolean }> {
  const result = await gpuPost<{ success: boolean }>("/gaming-mode");
  return result || { success: false };
}

/** Update GPU contribution config. */
export async function updateGpuConfig(config: Record<string, any>): Promise<{ success: boolean }> {
  const result = await gpuPost<{ success: boolean }>("/config", config);
  return result || { success: false };
}
