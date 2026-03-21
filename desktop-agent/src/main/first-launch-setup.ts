/**
 * first-launch-setup.ts — Grandma-proof first-time GPU setup
 *
 * On first launch:
 *   1. Detect GPU (any vendor, any OS)
 *   2. Check/install inference backend (Ollama)
 *   3. Open firewall ports (platform-specific)
 *   4. Pull recommended model
 *   5. Register with HivePoA pool
 *   6. Start inference backend
 *
 * Everything automatic — user just sees progress.
 */

import { detectGpus, type GpuDetection } from './gpu-detector';
import { openFirewallPorts, type FirewallResult } from './firewall-manager';
import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export interface SetupProgress {
  step: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
}

export interface SetupResult {
  success: boolean;
  gpu: GpuDetection;
  firewall: FirewallResult;
  modelReady: boolean;
  registered: boolean;
  inferencePort: number;
  nodeId: string;
  errors: string[];
}

type ProgressCallback = (progress: SetupProgress[]) => void;

const INSTALL_DIR = path.join(os.homedir(), '.spiritbomb');
const NODE_ID_FILE = path.join(INSTALL_DIR, '.node-id');

/**
 * Run the complete first-launch setup. Reports progress via callback.
 */
export async function runFirstLaunchSetup(
  hivpoaUrl: string,
  apiKey: string,
  onProgress?: ProgressCallback,
): Promise<SetupResult> {
  const errors: string[] = [];
  const steps: SetupProgress[] = [
    { step: 'Detecting GPU', status: 'pending' },
    { step: 'Opening firewall', status: 'pending' },
    { step: 'Installing inference engine', status: 'pending' },
    { step: 'Downloading AI model', status: 'pending' },
    { step: 'Starting inference', status: 'pending' },
    { step: 'Joining GPU pool', status: 'pending' },
  ];

  const update = (idx: number, status: SetupProgress['status'], detail?: string) => {
    steps[idx].status = status;
    if (detail) steps[idx].detail = detail;
    onProgress?.(steps);
  };

  // Ensure install dir exists
  fs.mkdirSync(INSTALL_DIR, { recursive: true });

  // Step 1: Detect GPU
  update(0, 'running');
  let gpu: GpuDetection;
  try {
    gpu = await detectGpus();
    if (gpu.bestGpu) {
      update(0, 'done', `${gpu.bestGpu.model} (${gpu.bestGpu.vramGb}GB)`);
    } else {
      update(0, 'done', 'No GPU — CPU mode');
    }
  } catch (err: any) {
    update(0, 'error', err.message);
    errors.push(`GPU detection: ${err.message}`);
    gpu = { platform: os.platform() === 'darwin' ? 'macos' : os.platform() === 'win32' ? 'windows' : 'linux', arch: os.arch(), gpus: [], bestGpu: null, recommendedBackend: 'ollama', canContribute: false };
  }

  // Step 2: Open firewall
  update(1, 'running');
  let firewall: FirewallResult;
  try {
    firewall = await openFirewallPorts();
    update(1, 'done', firewall.userActionRequired || `${firewall.portsOpened.length} ports opened`);
  } catch (err: any) {
    update(1, 'error', err.message);
    errors.push(`Firewall: ${err.message}`);
    firewall = { success: false, portsOpened: [], method: 'failed' };
  }

  // Step 3: Install Ollama (if not present)
  update(2, 'running');
  let ollamaInstalled = false;
  try {
    await execAsync('ollama --version', { timeout: 5000 });
    ollamaInstalled = true;
    update(2, 'done', 'Ollama already installed');
  } catch {
    try {
      update(2, 'running', 'Installing Ollama...');
      if (gpu.platform === 'macos') {
        await execAsync('brew install ollama 2>/dev/null || curl -fsSL https://ollama.com/install.sh | sh', { timeout: 300000 });
      } else if (gpu.platform === 'linux') {
        await execAsync('curl -fsSL https://ollama.com/install.sh | sh', { timeout: 300000 });
      } else {
        // Windows — Ollama is a GUI installer, check common paths
        const winPaths = [
          path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'),
          'C:\\Program Files\\Ollama\\ollama.exe',
        ];
        const found = winPaths.find(p => fs.existsSync(p));
        if (found) {
          ollamaInstalled = true;
          update(2, 'done', 'Ollama found at ' + found);
        } else {
          update(2, 'error', 'Install Ollama from ollama.com');
          errors.push('Ollama not installed — download from https://ollama.com');
        }
      }
      if (!ollamaInstalled) {
        await execAsync('ollama --version', { timeout: 5000 });
        ollamaInstalled = true;
        update(2, 'done', 'Ollama installed');
      }
    } catch (err: any) {
      update(2, 'error', 'Install Ollama from ollama.com');
      errors.push(`Ollama install: ${err.message}`);
    }
  }

  // Step 4: Pull model
  update(3, 'running');
  let modelReady = false;
  const vramGb = gpu.bestGpu?.vramGb ?? 4;
  const modelName = vramGb >= 12 ? 'qwen3:14b' : vramGb >= 6 ? 'qwen3.5:9b' : 'qwen3:1.7b';

  if (ollamaInstalled) {
    try {
      // Start Ollama if not running
      exec('ollama serve', { timeout: 5000 }).unref?.();
      await new Promise(r => setTimeout(r, 3000));

      update(3, 'running', `Pulling ${modelName}...`);
      await execAsync(`ollama pull ${modelName}`, { timeout: 600000 }); // 10 min max
      modelReady = true;
      update(3, 'done', modelName);
    } catch (err: any) {
      update(3, 'error', err.message);
      errors.push(`Model pull: ${err.message}`);
    }
  } else {
    update(3, 'error', 'Needs Ollama');
  }

  // Step 5: Start inference
  update(4, 'running');
  let inferencePort = 11434;
  try {
    // Check if Ollama is already serving
    const res = await fetch(`http://localhost:${inferencePort}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      update(4, 'done', `Ollama on port ${inferencePort}`);
    } else {
      throw new Error('Not responding');
    }
  } catch {
    try {
      exec('ollama serve', { timeout: 5000 }).unref?.();
      await new Promise(r => setTimeout(r, 5000));
      update(4, 'done', `Ollama started on port ${inferencePort}`);
    } catch (err: any) {
      update(4, 'error', err.message);
      errors.push(`Start inference: ${err.message}`);
    }
  }

  // Step 6: Register with pool
  update(5, 'running');
  let registered = false;
  let nodeId = getOrCreateNodeId();

  // Get local IP
  let localIp = '127.0.0.1';
  try {
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const addr of iface || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          localIp = addr.address;
          break;
        }
      }
      if (localIp !== '127.0.0.1') break;
    }
  } catch {}

  try {
    const res = await fetch(`${hivpoaUrl}/api/compute/nodes/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `ApiKey ${apiKey}`,
      },
      body: JSON.stringify({
        nodeInstanceId: nodeId,
        gpuModel: gpu.bestGpu?.model ?? 'CPU',
        gpuVramGb: gpu.bestGpu?.vramGb ?? 4,
        supportedWorkloads: 'inference',
        maxConcurrentJobs: 1,
        inferenceEndpoint: `http://${localIp}:${inferencePort}`,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      registered = true;
      update(5, 'done', `Registered as ${nodeId}`);
    } else {
      const err = await res.text();
      update(5, 'error', err);
      errors.push(`Registration: ${err}`);
    }
  } catch (err: any) {
    update(5, 'error', err.message);
    errors.push(`Registration: ${err.message}`);
  }

  return {
    success: errors.length === 0,
    gpu,
    firewall,
    modelReady,
    registered,
    inferencePort,
    nodeId,
    errors,
  };
}

function getOrCreateNodeId(): string {
  try {
    if (fs.existsSync(NODE_ID_FILE)) {
      return fs.readFileSync(NODE_ID_FILE, 'utf-8').trim();
    }
  } catch {}

  const id = `spiritbomb-${os.hostname()}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    fs.writeFileSync(NODE_ID_FILE, id);
  } catch {}
  return id;
}

/**
 * Check if this is the first launch (no node ID file exists).
 */
export function isFirstLaunch(): boolean {
  return !fs.existsSync(NODE_ID_FILE);
}
