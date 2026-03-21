/**
 * docker-manager.ts — Docker CLI wrapper for vLLM container management
 *
 * Handles the full container lifecycle:
 *   - Pull images (with progress tracking)
 *   - Run/stop/restart containers
 *   - Monitor container health and logs
 *   - Parse vLLM startup progress
 *
 * All Docker operations go through the CLI (no Docker API SDK needed).
 */

import { execFile, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const execFileAsync = promisify(execFile);

export interface ContainerConfig {
  name: string;
  image: string;
  gpuMemoryUtilization: number;  // 0.50-0.85
  maxModelLen: number;            // 512-8192
  model: string;                  // e.g., "Qwen/Qwen3-14B-AWQ"
  quantization: string;           // "awq_marlin"
  port: number;                   // host port (maps to container 8000)
}

export type ContainerState =
  | 'not_found'
  | 'pulling'
  | 'creating'
  | 'starting'
  | 'running'
  | 'loading_model'
  | 'healthy'
  | 'stopped'
  | 'error';

export interface ContainerStatus {
  state: ContainerState;
  containerId?: string;
  uptime?: string;
  error?: string;
  progress?: string;  // e.g., "Downloading model: 52%"
}

const DEFAULT_CONFIG: ContainerConfig = {
  name: 'spiritbomb-vllm',
  image: 'vllm/vllm-openai:latest',
  gpuMemoryUtilization: 0.90,  // Push to 90% — Windows overhead already factored out
  maxModelLen: 4096,            // FP8 KV cache makes 4096 fit on 16GB
  model: 'Qwen/Qwen3-14B-AWQ',
  quantization: 'awq_marlin',
  port: 8100,
};

export class DockerManager extends EventEmitter {
  private config: ContainerConfig;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private logProcess: ChildProcess | null = null;

  constructor(config: Partial<ContainerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if Docker is available.
   */
  async isDockerAvailable(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['info'], { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a specific image exists locally.
   */
  async hasImage(image?: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('docker', [
        'images', image || this.config.image, '-q',
      ], { timeout: 10000 });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Pull a Docker image with progress events.
   * Emits 'pull-progress' events with { layer, status, progress }.
   */
  async pullImage(image?: string): Promise<void> {
    const img = image || this.config.image;
    this.emit('state-change', 'pulling');

    return new Promise((resolve, reject) => {
      const proc = spawn('docker', ['pull', img]);
      let lastLine = '';

      proc.stdout.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) {
          lastLine = line;
          this.emit('pull-progress', { raw: line });
        }
      });

      proc.stderr.on('data', (data: Buffer) => {
        const line = data.toString().trim();
        if (line) this.emit('pull-progress', { raw: line });
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`docker pull failed (exit ${code}): ${lastLine}`));
        }
      });

      proc.on('error', reject);
    });
  }

  /**
   * Get the status of the managed container.
   */
  async getContainerStatus(): Promise<ContainerStatus> {
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect', '--format',
        '{{.State.Status}}|{{.State.StartedAt}}|{{.Id}}',
        this.config.name,
      ], { timeout: 5000 });

      const [status, startedAt, id] = stdout.trim().split('|');

      if (status === 'running') {
        // Check if vLLM is healthy (API responding)
        const healthy = await this.isVllmHealthy();
        return {
          state: healthy ? 'healthy' : 'loading_model',
          containerId: id?.slice(0, 12),
          uptime: startedAt,
        };
      }

      return {
        state: status === 'exited' ? 'stopped' : 'error',
        containerId: id?.slice(0, 12),
      };
    } catch {
      return { state: 'not_found' };
    }
  }

  /**
   * Start the vLLM container with the current config.
   */
  async startContainer(): Promise<string> {
    // Remove existing container if any
    await this.removeContainer().catch(() => {});

    this.emit('state-change', 'creating');

    const args = [
      'run', '-d',
      '--name', this.config.name,
      '--gpus', 'all',
      '-p', `${this.config.port}:8000`,
      '-v', 'hf_cache:/root/.cache/huggingface',
      '--ipc=host',
      this.config.image,
      '--model', this.config.model,
      '--quantization', this.config.quantization,
      '--gpu-memory-utilization', this.config.gpuMemoryUtilization.toString(),
      '--max-model-len', this.config.maxModelLen.toString(),
      '--kv-cache-dtype', 'fp8',         // FP8 KV cache — doubles effective context on Ada GPUs
      '--enable-prefix-caching',          // Reuse KV cache for shared system prompts (70-90% hit rate)
      '--max-num-seqs', '64',             // Concurrent request handling
      '--enforce-eager',                  // Skip CUDA graph compilation (WSL2 compatibility)
      '--host', '0.0.0.0',
      '--port', '8000',
    ];

    try {
      const { stdout } = await execFileAsync('docker', args, { timeout: 30000 });
      const containerId = stdout.trim().slice(0, 12);
      this.emit('state-change', 'starting');
      return containerId;
    } catch (err: any) {
      this.emit('state-change', 'error');
      throw new Error(`Failed to start container: ${err.message}`);
    }
  }

  /**
   * Stop the container gracefully (drain period).
   */
  async stopContainer(timeout: number = 30): Promise<void> {
    try {
      await execFileAsync('docker', ['stop', '-t', timeout.toString(), this.config.name], {
        timeout: (timeout + 10) * 1000,
      });
      this.emit('state-change', 'stopped');
    } catch {
      // Force kill
      await execFileAsync('docker', ['kill', this.config.name]).catch(() => {});
      this.emit('state-change', 'stopped');
    }
    this.stopHealthCheck();
    this.stopLogMonitor();
  }

  /**
   * Remove the container.
   */
  async removeContainer(): Promise<void> {
    await execFileAsync('docker', ['rm', '-f', this.config.name], { timeout: 10000 }).catch(() => {});
  }

  /**
   * Check if vLLM's health endpoint is responding.
   */
  async isVllmHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`http://localhost:${this.config.port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Wait for vLLM to become healthy (model loaded).
   * Emits 'health-check' events with { attempt, healthy }.
   * Resolves when healthy, rejects after maxAttempts.
   */
  async waitForHealthy(maxAttempts: number = 120, intervalMs: number = 5000): Promise<void> {
    this.emit('state-change', 'loading_model');

    for (let i = 0; i < maxAttempts; i++) {
      const healthy = await this.isVllmHealthy();
      this.emit('health-check', { attempt: i + 1, maxAttempts, healthy });

      if (healthy) {
        this.emit('state-change', 'healthy');
        return;
      }

      // Check if container is still running
      const status = await this.getContainerStatus();
      if (status.state === 'stopped' || status.state === 'error' || status.state === 'not_found') {
        throw new Error(`Container exited while waiting for health: ${status.state}`);
      }

      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(`vLLM did not become healthy after ${maxAttempts} attempts`);
  }

  /**
   * Start periodic health checking.
   */
  startHealthCheck(intervalMs: number = 15000): void {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(async () => {
      const status = await this.getContainerStatus();
      this.emit('health-status', status);
    }, intervalMs);
  }

  /**
   * Stop periodic health checking.
   */
  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  /**
   * Get container logs (last N lines).
   */
  async getLogs(lines: number = 50): Promise<string> {
    try {
      const { stdout, stderr } = await execFileAsync('docker', [
        'logs', '--tail', lines.toString(), this.config.name,
      ], { timeout: 5000 });
      return (stdout + stderr).trim();
    } catch {
      return '';
    }
  }

  /**
   * Start monitoring container logs in real-time.
   * Emits 'log' events with each line.
   */
  startLogMonitor(): void {
    this.stopLogMonitor();
    this.logProcess = spawn('docker', ['logs', '-f', '--tail', '0', this.config.name]);

    const handleData = (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        this.emit('log', line);
      }
    };

    this.logProcess.stdout?.on('data', handleData);
    this.logProcess.stderr?.on('data', handleData);
    this.logProcess.on('close', () => { this.logProcess = null; });
  }

  /**
   * Stop monitoring container logs.
   */
  stopLogMonitor(): void {
    if (this.logProcess) {
      this.logProcess.kill();
      this.logProcess = null;
    }
  }

  /**
   * Get the vLLM models list (OpenAI-compatible endpoint).
   */
  async getModels(): Promise<any[]> {
    try {
      const response = await fetch(`http://localhost:${this.config.port}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) return [];
      const data = await response.json() as any;
      return data.data || [];
    } catch {
      return [];
    }
  }

  /**
   * Get vLLM Prometheus metrics.
   */
  async getVllmMetrics(): Promise<string> {
    try {
      const response = await fetch(`http://localhost:${this.config.port}/metrics`, {
        signal: AbortSignal.timeout(3000),
      });
      return response.ok ? await response.text() : '';
    } catch {
      return '';
    }
  }

  /**
   * Update container config (requires restart to take effect).
   */
  updateConfig(updates: Partial<ContainerConfig>): void {
    Object.assign(this.config, updates);
  }

  /**
   * Get current config.
   */
  getConfig(): ContainerConfig {
    return { ...this.config };
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this.stopHealthCheck();
    this.stopLogMonitor();
    this.removeAllListeners();
  }
}
