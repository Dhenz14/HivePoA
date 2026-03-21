/**
 * nvidia-monitor.ts — GPU health monitoring via nvidia-smi
 *
 * Polls nvidia-smi for real-time GPU metrics:
 *   - Temperature, VRAM usage, utilization, fan speed
 *   - Detects VRAM contention (gaming mode trigger)
 *   - Caches results to avoid excessive nvidia-smi calls
 *
 * Used by GpuContributionManager for health reporting and gaming mode detection.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execFileAsync = promisify(execFile);

export interface GpuInfo {
  name: string;
  vramTotalMb: number;
  vramTotalGb: number;
  uuid: string;
  driverVersion: string;
  cudaVersion: string;
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

export interface DependencyCheck {
  nvidia: { ok: boolean; name?: string; vramGb?: number; driver?: string; error?: string };
  docker: { ok: boolean; version?: string; error?: string };
  toolkit: { ok: boolean; error?: string };
  vram: { ok: boolean; totalGb?: number; availableGb?: number; warning?: string };
}

const NVIDIA_SMI_PATHS = [
  'nvidia-smi',
  'C:\\Windows\\System32\\nvidia-smi.exe',
  '/usr/bin/nvidia-smi',
];

const WINDOWS_VRAM_OVERHEAD_GB = 6.5;
const MIN_VRAM_GB = 6;
const MIN_DRIVER_VERSION = 535;

// Cache duration for nvidia-smi results
const METRICS_CACHE_MS = 10000; // 10s — GPU metrics don't need sub-second precision
const INFO_CACHE_MS = 30000;
const DEPS_CACHE_MS = 30000;

export class NvidiaMonitor {
  private smiPath: string | null = null;
  private infoCache: { data: GpuInfo; timestamp: number } | null = null;
  private metricsCache: { data: GpuMetrics; timestamp: number } | null = null;
  private depsCache: { data: DependencyCheck; timestamp: number } | null = null;

  /**
   * Find nvidia-smi binary path.
   */
  async findNvidiaSmi(): Promise<string | null> {
    if (this.smiPath) return this.smiPath;

    for (const candidate of NVIDIA_SMI_PATHS) {
      try {
        await execFileAsync(candidate, ['--query-gpu=name', '--format=csv,noheader'], { timeout: 5000 });
        this.smiPath = candidate;
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Get GPU info (cached 30s).
   */
  async getGpuInfo(): Promise<GpuInfo | null> {
    if (this.infoCache && Date.now() - this.infoCache.timestamp < INFO_CACHE_MS) {
      return this.infoCache.data;
    }

    const smi = await this.findNvidiaSmi();
    if (!smi) return null;

    try {
      const { stdout } = await execFileAsync(smi, [
        '--query-gpu=name,memory.total,uuid,driver_version',
        '--format=csv,noheader,nounits',
      ], { timeout: 10000 });

      const parts = stdout.trim().split('\n')[0].split(',').map(s => s.trim());
      if (parts.length < 4) return null;

      const info: GpuInfo = {
        name: parts[0].replace('NVIDIA ', '').replace('GeForce ', ''),
        vramTotalMb: parseInt(parts[1]) || 0,
        vramTotalGb: Math.round((parseInt(parts[1]) || 0) / 1024),
        uuid: parts[2],
        driverVersion: parts[3],
        cudaVersion: '', // filled from separate query
      };

      // Get CUDA version
      try {
        const { stdout: cudaOut } = await execFileAsync(smi, [], { timeout: 5000 });
        const cudaMatch = cudaOut.match(/CUDA Version:\s+([\d.]+)/);
        if (cudaMatch) info.cudaVersion = cudaMatch[1];
      } catch { /* ignore */ }

      this.infoCache = { data: info, timestamp: Date.now() };
      return info;
    } catch {
      return null;
    }
  }

  /**
   * Get real-time GPU metrics (cached 3s).
   */
  async getMetrics(): Promise<GpuMetrics | null> {
    if (this.metricsCache && Date.now() - this.metricsCache.timestamp < METRICS_CACHE_MS) {
      return this.metricsCache.data;
    }

    const smi = await this.findNvidiaSmi();
    if (!smi) return null;

    try {
      const { stdout } = await execFileAsync(smi, [
        '--query-gpu=temperature.gpu,memory.used,memory.free,memory.total,utilization.gpu,fan.speed,power.draw,power.limit',
        '--format=csv,noheader,nounits',
      ], { timeout: 5000 });

      const parts = stdout.trim().split('\n')[0].split(',').map(s => s.trim());
      if (parts.length < 8) return null;

      const metrics: GpuMetrics = {
        temperatureC: parseInt(parts[0]) || 0,
        vramUsedMb: parseInt(parts[1]) || 0,
        vramFreeMb: parseInt(parts[2]) || 0,
        vramTotalMb: parseInt(parts[3]) || 0,
        utilizationPct: parseInt(parts[4]) || 0,
        fanSpeedPct: parseInt(parts[5]) || 0,
        powerDrawW: parseFloat(parts[6]) || 0,
        powerLimitW: parseFloat(parts[7]) || 0,
        timestamp: Date.now(),
      };

      this.metricsCache = { data: metrics, timestamp: Date.now() };
      return metrics;
    } catch {
      return null;
    }
  }

  /**
   * Check all dependencies for GPU contribution (cached 30s).
   */
  async checkDependencies(): Promise<DependencyCheck> {
    if (this.depsCache && Date.now() - this.depsCache.timestamp < DEPS_CACHE_MS) {
      return this.depsCache.data;
    }

    const result: DependencyCheck = {
      nvidia: { ok: false },
      docker: { ok: false },
      toolkit: { ok: false },
      vram: { ok: false },
    };

    // 1. NVIDIA GPU
    const gpuInfo = await this.getGpuInfo();
    if (gpuInfo) {
      const driverMajor = parseInt(gpuInfo.driverVersion.split('.')[0]) || 0;
      result.nvidia = {
        ok: driverMajor >= MIN_DRIVER_VERSION,
        name: gpuInfo.name,
        vramGb: gpuInfo.vramTotalGb,
        driver: gpuInfo.driverVersion,
        error: driverMajor < MIN_DRIVER_VERSION
          ? `Driver ${gpuInfo.driverVersion} too old (need >= ${MIN_DRIVER_VERSION})`
          : undefined,
      };
    } else {
      result.nvidia = { ok: false, error: 'No NVIDIA GPU detected' };
    }

    // 2. Docker
    try {
      const { stdout } = await execFileAsync('docker', ['--version'], { timeout: 10000 });
      const match = stdout.match(/Docker version ([\d.]+)/);
      result.docker = { ok: true, version: match?.[1] || 'unknown' };
    } catch {
      result.docker = { ok: false, error: 'Docker not installed' };
    }

    // 3. NVIDIA Container Toolkit (test GPU access in Docker)
    if (result.docker.ok) {
      try {
        const { stdout } = await execFileAsync('docker', [
          'run', '--rm', '--gpus', 'all',
          'nvidia/cuda:12.4.0-base-ubuntu22.04', 'nvidia-smi', '--query-gpu=name', '--format=csv,noheader',
        ], { timeout: 60000 });
        result.toolkit = { ok: stdout.trim().length > 0 };
      } catch (err: any) {
        result.toolkit = { ok: false, error: 'GPU not accessible in Docker. Install NVIDIA Container Toolkit.' };
      }
    } else {
      result.toolkit = { ok: false, error: 'Docker required first' };
    }

    // 4. Available VRAM
    if (gpuInfo) {
      const availableGb = Math.max(0, gpuInfo.vramTotalGb - WINDOWS_VRAM_OVERHEAD_GB);
      result.vram = {
        ok: availableGb >= MIN_VRAM_GB,
        totalGb: gpuInfo.vramTotalGb,
        availableGb: Math.round(availableGb * 10) / 10,
        warning: availableGb < MIN_VRAM_GB
          ? `Only ${availableGb.toFixed(1)} GB available after Windows overhead`
          : undefined,
      };
    }

    this.depsCache = { data: result, timestamp: Date.now() };
    return result;
  }

  /**
   * Detect VRAM contention (gaming mode trigger).
   * Returns true if a non-AI process is using significant VRAM.
   */
  async detectVramContention(aiContainerVramMb: number = 0): Promise<boolean> {
    const metrics = await this.getMetrics();
    if (!metrics) return false;

    // VRAM used minus what AI container should be using
    const nonAiVram = metrics.vramUsedMb - aiContainerVramMb;
    // If non-AI processes are using >2GB, something heavy is running (game, video editor, etc.)
    return nonAiVram > 2048;
  }

  /**
   * Clear all caches (force fresh reads).
   */
  clearCache(): void {
    this.infoCache = null;
    this.metricsCache = null;
    this.depsCache = null;
  }
}
