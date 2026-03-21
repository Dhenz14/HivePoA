/**
 * gpu-detector.ts — Universal GPU detection across all platforms
 *
 * Detects GPUs on:
 *   - Windows/Linux: NVIDIA (nvidia-smi), AMD (rocm-smi)
 *   - macOS: Apple Silicon (system_profiler), AMD (system_profiler)
 *   - Fallback: CPU-only mode
 *
 * Returns a unified GpuDetection result regardless of platform.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';

const execFileAsync = promisify(execFile);

export type GpuType = 'nvidia_cuda' | 'apple_metal' | 'amd_rocm' | 'intel_arc' | 'cpu_only';

export interface DetectedGpu {
  model: string;
  vramGb: number;
  type: GpuType;
  driverVersion?: string;
  uuid?: string;
}

export interface GpuDetection {
  platform: 'windows' | 'macos' | 'linux';
  arch: string;
  gpus: DetectedGpu[];
  bestGpu: DetectedGpu | null;
  recommendedBackend: 'llamaserver_cuda' | 'llamaserver_metal' | 'llamaserver_rocm' | 'llamaserver_cpu' | 'ollama';
  canContribute: boolean;
  reason?: string;
}

/**
 * Detect all available GPUs on this machine.
 */
export async function detectGpus(): Promise<GpuDetection> {
  const platform = os.platform() === 'darwin' ? 'macos' : os.platform() === 'win32' ? 'windows' : 'linux';
  const arch = os.arch();
  const gpus: DetectedGpu[] = [];

  // Try each detector in parallel
  const [nvidia, apple, amd, intel] = await Promise.allSettled([
    detectNvidia(),
    detectAppleSilicon(),
    detectAmdRocm(),
    detectIntelArc(),
  ]);

  if (nvidia.status === 'fulfilled' && nvidia.value.length > 0) gpus.push(...nvidia.value);
  if (apple.status === 'fulfilled' && apple.value.length > 0) gpus.push(...apple.value);
  if (amd.status === 'fulfilled' && amd.value.length > 0) gpus.push(...amd.value);
  if (intel.status === 'fulfilled' && intel.value.length > 0) gpus.push(...intel.value);

  const bestGpu = gpus.length > 0 ? gpus.reduce((a, b) => a.vramGb >= b.vramGb ? a : b) : null;

  let recommendedBackend: GpuDetection['recommendedBackend'] = 'llamaserver_cpu';
  if (bestGpu) {
    switch (bestGpu.type) {
      case 'nvidia_cuda': recommendedBackend = 'llamaserver_cuda'; break;
      case 'apple_metal': recommendedBackend = 'llamaserver_metal'; break;
      case 'amd_rocm': recommendedBackend = 'llamaserver_rocm'; break;
      default: recommendedBackend = 'ollama'; break;
    }
  }

  const canContribute = bestGpu !== null && bestGpu.vramGb >= 4;

  return {
    platform,
    arch,
    gpus,
    bestGpu,
    recommendedBackend,
    canContribute,
    reason: !canContribute ? (bestGpu ? 'GPU has less than 4GB VRAM' : 'No compatible GPU detected') : undefined,
  };
}

// ── NVIDIA (Windows + Linux) ───────────────────────────────────

async function detectNvidia(): Promise<DetectedGpu[]> {
  const paths = ['nvidia-smi', 'C:\\Windows\\System32\\nvidia-smi.exe', '/usr/bin/nvidia-smi'];

  for (const smiPath of paths) {
    try {
      const { stdout } = await execFileAsync(smiPath, [
        '--query-gpu=name,memory.total,driver_version,uuid',
        '--format=csv,noheader,nounits',
      ], { timeout: 10000 });

      return stdout.trim().split('\n').filter(Boolean).map(line => {
        const [name, vramMb, driver, uuid] = line.split(', ').map(s => s.trim());
        return {
          model: name,
          vramGb: Math.round(parseInt(vramMb) / 1024),
          type: 'nvidia_cuda' as GpuType,
          driverVersion: driver,
          uuid,
        };
      });
    } catch {
      continue;
    }
  }
  return [];
}

// ── Apple Silicon (macOS) ──────────────────────────────────────

async function detectAppleSilicon(): Promise<DetectedGpu[]> {
  if (os.platform() !== 'darwin') return [];

  try {
    const { stdout } = await execFileAsync('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 10000 });
    const data = JSON.parse(stdout);
    const displays = data?.SPDisplaysDataType || [];

    return displays.map((display: any) => {
      const name = display.sppci_model || display._name || 'Unknown Apple GPU';
      // Apple reports VRAM in the display info, but for unified memory
      // we use total system RAM as the available pool
      let vramMb = 0;
      const vramStr = display.spdisplays_vram || display.spdisplays_vram_shared || '';
      if (vramStr.includes('GB')) {
        vramMb = parseFloat(vramStr) * 1024;
      } else if (vramStr.includes('MB')) {
        vramMb = parseFloat(vramStr);
      } else {
        // Apple Silicon unified memory — use ~75% of total RAM as "VRAM"
        vramMb = Math.round(os.totalmem() / (1024 * 1024) * 0.75);
      }

      return {
        model: name,
        vramGb: Math.round(vramMb / 1024),
        type: 'apple_metal' as GpuType,
      };
    }).filter((g: DetectedGpu) => g.vramGb > 0);
  } catch {
    return [];
  }
}

// ── AMD ROCm (Linux) ───────────────────────────────────────────

async function detectAmdRocm(): Promise<DetectedGpu[]> {
  if (os.platform() === 'darwin') return []; // macOS AMD uses Metal, not ROCm

  try {
    const { stdout } = await execFileAsync('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--csv'], { timeout: 10000 });
    const lines = stdout.trim().split('\n');
    const gpus: DetectedGpu[] = [];

    // Parse CSV output
    let currentGpu: Partial<DetectedGpu> = {};
    for (const line of lines) {
      if (line.includes('GPU')) {
        const nameMatch = line.match(/card\d+.*?:\s*(.+)/i);
        if (nameMatch) currentGpu.model = nameMatch[1].trim();
      }
      if (line.includes('Total Memory')) {
        const memMatch = line.match(/(\d+)/);
        if (memMatch) {
          currentGpu.vramGb = Math.round(parseInt(memMatch[1]) / (1024 * 1024));
          currentGpu.type = 'amd_rocm';
          if (currentGpu.model) {
            gpus.push(currentGpu as DetectedGpu);
            currentGpu = {};
          }
        }
      }
    }

    // Fallback: try rocminfo for basic detection
    if (gpus.length === 0) {
      try {
        const { stdout: infoOut } = await execFileAsync('rocminfo', [], { timeout: 10000 });
        const gpuMatch = infoOut.match(/Name:\s+(gfx\w+)/);
        if (gpuMatch) {
          gpus.push({
            model: `AMD GPU (${gpuMatch[1]})`,
            vramGb: 8, // conservative default
            type: 'amd_rocm',
          });
        }
      } catch { /* no rocminfo */ }
    }

    return gpus;
  } catch {
    return [];
  }
}

// ── Intel Arc (Linux) ──────────────────────────────────────────

async function detectIntelArc(): Promise<DetectedGpu[]> {
  try {
    const { stdout } = await execFileAsync('xpu-smi', ['discovery'], { timeout: 10000 });

    const gpus: DetectedGpu[] = [];
    const deviceBlocks = stdout.split(/Device ID/);

    for (const block of deviceBlocks.slice(1)) {
      const nameMatch = block.match(/Device Name\s*:\s*(.+)/);
      const memMatch = block.match(/Memory Physical Size\s*:\s*(\d+)/);
      if (nameMatch) {
        gpus.push({
          model: nameMatch[1].trim(),
          vramGb: memMatch ? Math.round(parseInt(memMatch[1]) / (1024 * 1024 * 1024)) : 8,
          type: 'intel_arc',
        });
      }
    }

    return gpus;
  } catch {
    return [];
  }
}
