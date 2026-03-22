/**
 * gpu-contribution.ts — GPU Contribution Lifecycle Manager
 *
 * Orchestrates the full lifecycle of GPU contribution:
 *   - Dependency checking
 *   - Container start/stop/restart
 *   - Health monitoring
 *   - Gaming mode (auto-pause/resume on VRAM contention)
 *   - Earnings tracking
 *   - Node registration with HivePoA
 *
 * State machine:
 *   stopped → starting → running → paused → running
 *                     ↘ error → stopped
 *   running → gaming_mode → running (auto-detect VRAM contention)
 *   running → draining → stopped
 */

import { EventEmitter } from 'events';
import { NvidiaMonitor, GpuInfo, GpuMetrics, DependencyCheck } from './nvidia-monitor';
import { DockerManager, ContainerConfig, ContainerStatus } from './docker-manager';

export type GpuContributionState =
  | 'stopped'
  | 'checking_deps'
  | 'starting'
  | 'running'
  | 'paused'
  | 'draining'
  | 'gaming_mode'
  | 'error';

export interface GpuContributionConfig {
  enabled: boolean;
  mode: 'local' | 'pool' | 'cluster' | 'lend';
  // Modes:
  //   local   — Ollama only, no sharing, no earnings
  //   pool    — GPU serves requests independently (throughput scaling)
  //   cluster — GPU combines with neighbors for bigger model (capability scaling)
  //   lend    — 100% GPU donated to a specific computer (becomes their remote GPU)
  vramUtilization: number;        // 0.50-0.95
  model: string;                  // e.g., "Qwen/Qwen3-14B-AWQ"
  maxModelLen: number;            // 512-8192
  autoGamingMode: boolean;        // detect VRAM contention
  scheduleEnabled: boolean;
  scheduleStart: string;          // "22:00"
  scheduleEnd: string;            // "08:00"
  hivePoaUrl: string;             // HivePoA server URL
  hiveUsername: string | null;
  lendTargetIp: string | null;    // IP of the computer to lend GPU to (lend mode only)
}

export interface GpuContributionStatus {
  state: GpuContributionState;
  gpuInfo: GpuInfo | null;
  metrics: GpuMetrics | null;
  container: ContainerStatus | null;
  config: GpuContributionConfig;
  uptimeMs: number;
  totalTokens: number;
  totalRequests: number;
  estimatedHbdEarned: number;
  error: string | null;
}

const DEFAULT_GPU_CONFIG: GpuContributionConfig = {
  enabled: false,
  mode: 'pool',
  vramUtilization: 0.90,
  model: 'Qwen/Qwen3-14B-AWQ',
  maxModelLen: 4096,
  autoGamingMode: true,
  scheduleEnabled: false,
  scheduleStart: '22:00',
  scheduleEnd: '08:00',
  hivePoaUrl: 'http://localhost:5000',
  hiveUsername: null,
  lendTargetIp: null,
};

const GAMING_CHECK_INTERVAL_MS = 10000;      // check VRAM every 10s
const GAMING_RESUME_CHECKS = 15;             // 15 consecutive checks (2.5 min) before auto-resume
const METRICS_POLL_INTERVAL_MS = 5000;       // GPU metrics every 5s
const HEARTBEAT_INTERVAL_MS = 60000;         // heartbeat to HivePoA every 60s
const MAX_CONSECUTIVE_FAILURES = 3;          // stop retrying after 3 crashes
const DRAIN_TIMEOUT_MS = 30000;              // 30s to drain in-flight requests
const SCHEDULE_CHECK_INTERVAL_MS = 60000;    // check schedule every 60s

export class GpuContributionManager extends EventEmitter {
  private state: GpuContributionState = 'stopped';
  private config: GpuContributionConfig;
  private nvidia: NvidiaMonitor;
  private docker: DockerManager;

  // Timers
  private gamingCheckTimer: ReturnType<typeof setInterval> | null = null;
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;

  // Stats
  private startTime: number = 0;
  private totalTokens: number = 0;
  private totalRequests: number = 0;
  private consecutiveFailures: number = 0;
  private gamingIdleChecks: number = 0;
  private lastError: string | null = null;

  constructor(config: Partial<GpuContributionConfig> = {}) {
    super();
    this.config = { ...DEFAULT_GPU_CONFIG, ...config };
    this.nvidia = new NvidiaMonitor();
    this.docker = new DockerManager({
      gpuMemoryUtilization: this.config.vramUtilization,
      maxModelLen: this.config.maxModelLen,
      model: this.config.model,
    });

    // Forward docker events
    this.docker.on('state-change', (state: string) => {
      this.emit('docker-state', state);
    });
    this.docker.on('health-check', (data: any) => {
      this.emit('health-check', data);
    });
  }

  /**
   * Get current status snapshot.
   */
  async getStatus(): Promise<GpuContributionStatus> {
    const [gpuInfo, metrics, container] = await Promise.all([
      this.nvidia.getGpuInfo(),
      this.nvidia.getMetrics(),
      this.docker.getContainerStatus(),
    ]);

    return {
      state: this.state,
      gpuInfo,
      metrics,
      container,
      config: { ...this.config },
      uptimeMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
      totalTokens: this.totalTokens,
      totalRequests: this.totalRequests,
      estimatedHbdEarned: this.totalTokens * 0.000001, // base rate
      error: this.lastError,
    };
  }

  /**
   * Check all dependencies.
   */
  async checkDependencies(): Promise<DependencyCheck> {
    this.setState('checking_deps');
    const deps = await this.nvidia.checkDependencies();
    this.setState('stopped');
    return deps;
  }

  /**
   * Start GPU contribution.
   */
  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') return;

    this.lastError = null;
    this.setState('starting');

    try {
      // 1. Check if image exists, pull if needed
      const hasImage = await this.docker.hasImage();
      if (!hasImage) {
        this.emit('progress', { step: 'pulling', message: 'Downloading vLLM image...' });
        await this.docker.pullImage();
      }

      // 2. Kill Ollama if running (mutual exclusion)
      await this.killOllama();

      // 3. Start the container
      this.emit('progress', { step: 'starting', message: 'Starting vLLM container...' });
      await this.docker.startContainer();

      // 4. Wait for model to load and become healthy
      this.emit('progress', { step: 'loading', message: 'Loading model into GPU...' });
      await this.docker.waitForHealthy(120, 5000);

      // 5. Register with HivePoA
      this.emit('progress', { step: 'registering', message: 'Registering with community pool...' });
      await this.registerNode();

      // 6. Start monitoring
      this.startTime = Date.now();
      this.consecutiveFailures = 0;
      this.startMonitoring();
      this.setState('running');
      this.emit('progress', { step: 'running', message: 'GPU is live and earning!' });

    } catch (err: any) {
      this.lastError = err.message;
      this.setState('error');
      this.emit('error', err.message);
      throw err;
    }
  }

  /**
   * Stop GPU contribution gracefully (drain first).
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped') return;

    this.setState('draining');
    this.stopMonitoring();

    // Wait briefly for in-flight requests
    await new Promise(resolve => setTimeout(resolve, Math.min(DRAIN_TIMEOUT_MS, 5000)));

    await this.docker.stopContainer();
    this.setState('stopped');
    this.startTime = 0;
  }

  /**
   * Pause contribution (stop container, free VRAM).
   */
  async pause(): Promise<void> {
    if (this.state !== 'running') return;

    this.stopMonitoring();
    await this.docker.stopContainer(10);
    this.setState('paused');
  }

  /**
   * Resume contribution (restart container).
   */
  async resume(): Promise<void> {
    if (this.state !== 'paused' && this.state !== 'gaming_mode') return;

    try {
      this.setState('starting');
      await this.docker.startContainer();
      await this.docker.waitForHealthy(60, 5000);
      this.startMonitoring();
      this.setState('running');
    } catch (err: any) {
      this.lastError = err.message;
      this.setState('error');
    }
  }

  /**
   * Enter gaming mode (auto-pause, will auto-resume when idle).
   */
  async enterGamingMode(): Promise<void> {
    if (this.state !== 'running') return;

    this.stopMonitoring();
    await this.docker.stopContainer(10);
    this.gamingIdleChecks = 0;
    this.setState('gaming_mode');
    this.emit('notification', {
      type: 'gaming_mode',
      message: 'Gaming detected — GPU freed. Will resume when idle.',
    });

    // Start checking for idle
    this.startGamingIdleCheck();
  }

  /**
   * Update configuration (may require restart).
   */
  updateConfig(updates: Partial<GpuContributionConfig>): void {
    const needsRestart = (
      updates.vramUtilization !== undefined && updates.vramUtilization !== this.config.vramUtilization ||
      updates.model !== undefined && updates.model !== this.config.model ||
      updates.maxModelLen !== undefined && updates.maxModelLen !== this.config.maxModelLen
    );

    const scheduleChanged = (
      updates.scheduleEnabled !== undefined && updates.scheduleEnabled !== this.config.scheduleEnabled ||
      updates.scheduleStart !== undefined && updates.scheduleStart !== this.config.scheduleStart ||
      updates.scheduleEnd !== undefined && updates.scheduleEnd !== this.config.scheduleEnd
    );

    Object.assign(this.config, updates);
    this.docker.updateConfig({
      gpuMemoryUtilization: this.config.vramUtilization,
      maxModelLen: this.config.maxModelLen,
      model: this.config.model,
    });

    if (needsRestart && this.state === 'running') {
      this.emit('notification', {
        type: 'config_change',
        message: 'Configuration changed. Restarting GPU container...',
      });
      this.stop().then(() => this.start()).catch(() => {});
    }

    // Restart schedule checker if schedule settings changed
    if (scheduleChanged) {
      this.startScheduleChecker();
    }
  }

  // ── Private Methods ──────────────────────────────────────────

  private setState(newState: GpuContributionState): void {
    const old = this.state;
    this.state = newState;
    this.emit('state-change', { from: old, to: newState });
  }

  private async killOllama(): Promise<void> {
    try {
      const response = await fetch('http://localhost:11434/api/tags', {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        // Ollama is running — unload all models
        const data = await response.json() as any;
        for (const model of (data.models || [])) {
          await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: model.name, keep_alive: 0 }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => {});
        }
      }
    } catch {
      // Ollama not running — good
    }
  }

  private async registerNode(): Promise<void> {
    if (!this.config.hiveUsername) return;

    const gpuInfo = await this.nvidia.getGpuInfo();
    if (!gpuInfo) return;

    try {
      await fetch(`${this.config.hivePoaUrl}/api/compute/nodes/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hiveUsername: this.config.hiveUsername,
          gpuModel: gpuInfo.name,
          gpuVramGb: gpuInfo.vramTotalGb,
          deviceUuid: gpuInfo.uuid,
          supportedWorkloads: 'inference',
          pricePerHourHbd: '0.10',
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err: any) {
      // Non-fatal — will retry on next heartbeat
      this.emit('warning', `Node registration failed: ${err.message}`);
    }
  }

  private startMonitoring(): void {
    this.stopMonitoring();

    // GPU metrics polling
    this.metricsTimer = setInterval(async () => {
      const metrics = await this.nvidia.getMetrics();
      if (metrics) this.emit('metrics', metrics);
    }, METRICS_POLL_INTERVAL_MS);

    // Heartbeat to HivePoA
    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    // Gaming mode detection
    if (this.config.autoGamingMode) {
      this.gamingCheckTimer = setInterval(async () => {
        if (this.state !== 'running') return;
        const contention = await this.nvidia.detectVramContention(
          this.config.vramUtilization * ((await this.nvidia.getGpuInfo())?.vramTotalMb || 16000),
        );
        if (contention) {
          await this.enterGamingMode();
        }
      }, GAMING_CHECK_INTERVAL_MS);
    }

    // Docker health monitoring
    this.docker.startHealthCheck(15000);
    this.docker.on('health-status', (status: ContainerStatus) => {
      if (status.state === 'error' || status.state === 'stopped') {
        this.handleContainerCrash();
      }
    });
  }

  private stopMonitoring(): void {
    if (this.metricsTimer) { clearInterval(this.metricsTimer); this.metricsTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.gamingCheckTimer) { clearInterval(this.gamingCheckTimer); this.gamingCheckTimer = null; }
    this.docker.stopHealthCheck();
  }

  private startGamingIdleCheck(): void {
    const timer = setInterval(async () => {
      if (this.state !== 'gaming_mode') {
        clearInterval(timer);
        return;
      }

      const contention = await this.nvidia.detectVramContention(0);
      if (!contention) {
        this.gamingIdleChecks++;
        if (this.gamingIdleChecks >= GAMING_RESUME_CHECKS) {
          clearInterval(timer);
          this.emit('notification', {
            type: 'gaming_resume',
            message: 'GPU idle detected. Resuming contribution...',
          });
          await this.resume();
        }
      } else {
        this.gamingIdleChecks = 0; // reset counter
      }
    }, GAMING_CHECK_INTERVAL_MS);
  }

  private async handleContainerCrash(): Promise<void> {
    this.consecutiveFailures++;

    if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      this.lastError = `Container crashed ${this.consecutiveFailures} times. Stopped retrying.`;
      this.setState('error');
      this.stopMonitoring();
      this.emit('notification', {
        type: 'error',
        message: this.lastError,
      });
      return;
    }

    this.emit('notification', {
      type: 'warning',
      message: `Container crashed (attempt ${this.consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}). Restarting...`,
    });

    // Auto-restart with slightly lower VRAM (in case of OOM)
    if (this.consecutiveFailures > 1) {
      this.config.vramUtilization = Math.max(0.50, this.config.vramUtilization - 0.05);
      this.docker.updateConfig({ gpuMemoryUtilization: this.config.vramUtilization });
    }

    try {
      await this.docker.startContainer();
      await this.docker.waitForHealthy(60, 5000);
      this.setState('running');
    } catch {
      this.handleContainerCrash();
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.config.hiveUsername) return;

    try {
      await fetch(`${this.config.hivePoaUrl}/api/compute/nodes/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hiveUsername: this.config.hiveUsername,
          state: this.state,
          uptimeMs: this.startTime > 0 ? Date.now() - this.startTime : 0,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // Non-fatal
    }
  }

  // ── Schedule System ────────────────────────────────────────

  /**
   * Check if the current time falls within the scheduled contribution window.
   * Handles overnight schedules (e.g., 22:00 → 08:00) correctly.
   */
  isWithinSchedule(): boolean {
    if (!this.config.scheduleEnabled) return true; // no schedule = always allowed

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = this.config.scheduleStart.split(':').map(Number);
    const [endH, endM] = this.config.scheduleEnd.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      // Same-day window (e.g., 09:00 → 17:00)
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      // Overnight window (e.g., 22:00 → 08:00)
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  }

  /**
   * Start the schedule checker. Runs every 60s to auto-start/stop based on time window.
   */
  startScheduleChecker(): void {
    this.stopScheduleChecker();
    if (!this.config.scheduleEnabled) return;

    // Check immediately on start
    this.checkSchedule();

    this.scheduleTimer = setInterval(() => {
      this.checkSchedule();
    }, SCHEDULE_CHECK_INTERVAL_MS);
  }

  stopScheduleChecker(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  private async checkSchedule(): Promise<void> {
    const inWindow = this.isWithinSchedule();

    if (inWindow && this.state === 'stopped') {
      // Time to start
      this.emit('notification', {
        type: 'schedule',
        message: `Scheduled contribution starting (${this.config.scheduleStart} — ${this.config.scheduleEnd})`,
      });
      try {
        await this.start();
      } catch (err: any) {
        this.emit('notification', {
          type: 'error',
          message: `Scheduled start failed: ${err.message}`,
        });
      }
    } else if (!inWindow && (this.state === 'running' || this.state === 'paused' || this.state === 'gaming_mode')) {
      // Time to stop
      this.emit('notification', {
        type: 'schedule',
        message: 'Schedule window ended. Stopping GPU contribution.',
      });
      await this.stop();
    }
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this.stopMonitoring();
    this.stopScheduleChecker();
    this.docker.destroy();
    this.removeAllListeners();
  }
}
