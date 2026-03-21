# Universal GPU Onboarding — Any OS, Any GPU, One Pool

## Vision

Anyone with a GPU can contribute to the Spirit Bomb pool in under 2 minutes, regardless of operating system, GPU brand, or technical skill level. The onboarding experience is identical on every platform.

## Supported Platforms

| Platform | GPU | Inference Backend | Installer |
|----------|-----|-------------------|-----------|
| Windows 10/11 | NVIDIA (CUDA) | llama-server, Ollama, vLLM (Docker) | `.exe` installer |
| macOS (Apple Silicon) | M1/M2/M3/M4 (Metal) | llama-server, Ollama | `.dmg` or Homebrew |
| macOS (Intel) | AMD (Metal) | llama-server, Ollama | `.dmg` or Homebrew |
| Linux (Ubuntu/Debian) | NVIDIA (CUDA) | llama-server, Ollama, vLLM (native) | `.deb` package or `curl \| sh` |
| Linux (Fedora/Arch) | NVIDIA (CUDA) | llama-server, Ollama | `rpm` or `curl \| sh` |
| Linux | AMD (ROCm) | llama-server, Ollama | `curl \| sh` |
| Linux | Intel Arc (oneAPI) | llama-server | `curl \| sh` |
| WSL2 | NVIDIA (CUDA passthrough) | llama-server, vLLM | Same as Linux |

## The Universal Installer

### What It Does (Same On Every Platform)

```
Step 1: Detect OS + GPU
Step 2: Install inference backend (llama-server or Ollama)
Step 3: Download the community model (from Hive-AI — their decision)
Step 4: Start inference server
Step 5: Register with HivePoA coordinator
Step 6: Open firewall (platform-specific)
Step 7: Show dashboard link
```

### Platform-Specific Details

#### GPU Detection

| OS | Command | What We Get |
|----|---------|-------------|
| Windows | `nvidia-smi --query-gpu=name,memory.total --format=csv` | GPU name, VRAM |
| macOS | `system_profiler SPDisplaysDataType -json` | Chip name, memory |
| Linux NVIDIA | `nvidia-smi` (same as Windows) | GPU name, VRAM |
| Linux AMD | `rocm-smi --showmeminfo vram` | GPU name, VRAM |
| Linux Intel | `xpu-smi discovery` | GPU name, VRAM |

Unified output format:
```json
{
  "gpu_model": "NVIDIA GeForce RTX 4070 Ti SUPER",
  "vram_gb": 16,
  "gpu_type": "nvidia_cuda",
  "os": "windows",
  "arch": "x86_64"
}
```

#### Inference Backend Selection (Automatic)

| GPU Type | Best Backend | Why |
|----------|-------------|-----|
| NVIDIA CUDA | llama-server (CUDA) | Fastest, native CUDA kernels |
| Apple Silicon | llama-server (Metal) | Native Metal acceleration |
| AMD ROCm | llama-server (ROCm) or Ollama | ROCm support in llama.cpp |
| Intel Arc | llama-server (SYCL) | oneAPI/SYCL backend |
| CPU only | llama-server (CPU) | AVX2/AVX-512, slow but works |

The installer picks the best backend automatically. User never chooses.

#### Firewall Handling

| OS | Method | User Experience |
|----|--------|----------------|
| Windows | `netsh advfirewall` + UAC popup | User clicks "Yes" on one popup |
| macOS | `socketfilterfw` or app signing | macOS prompts "Allow incoming?" |
| Linux | `ufw allow` or `firewall-cmd` | Silent (usually no firewall on desktop Linux) |

#### Model Download

The model is Hive-AI's decision (their lane). The installer calls:
```
GET {HIVEPOA_URL}/api/gpu/recommended-model
```
Response:
```json
{
  "model_url": "https://huggingface.co/...",
  "model_name": "current_base.gguf",
  "size_gb": 9.9,
  "min_vram_gb": 6,
  "quantization": "Q5_K_M"
}
```

If the user's GPU can't fit the recommended model, the API returns a smaller one.

## Installer Distribution

### One URL, Every Platform

```
https://hivepoa.com/gpu
```

The webpage detects the OS and shows the right download:

| OS Detected | Shows |
|-------------|-------|
| Windows | "Download Spirit Bomb for Windows" → `.exe` |
| macOS | "Download Spirit Bomb for Mac" → `.dmg` |
| Linux | "Install with: `curl -fsSL https://hivepoa.com/install.sh \| sh`" |

### Package Managers

```bash
# macOS
brew install hivepoa/tap/spiritbomb

# Linux (Debian/Ubuntu)
curl -fsSL https://hivepoa.com/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/hivepoa.gpg
echo "deb [signed-by=/etc/apt/keyrings/hivepoa.gpg] https://hivepoa.com/apt stable main" | sudo tee /etc/apt/sources.list.d/hivepoa.list
sudo apt update && sudo apt install spiritbomb

# Linux (one-liner)
curl -fsSL https://hivepoa.com/install.sh | sh
```

### Windows Installer (.exe)

Built with Electron or NSIS. Includes:
- llama-server.exe (pre-compiled for Windows + CUDA)
- Node.js runtime (for the agent)
- Auto-updater
- System tray icon
- Uninstaller

### macOS Installer (.dmg)

Built with Electron or native Swift. Includes:
- llama-server (universal binary: ARM64 + x86_64)
- Agent service (launchd plist)
- Menu bar icon
- Auto-updater

## Architecture: Universal Agent

Every platform runs the same agent code (TypeScript/Node.js) with platform-specific adapters:

```
┌─────────────────────────────────────────┐
│           Spirit Bomb Agent             │
│                                         │
│  ┌─────────────┐  ┌─────────────────┐   │
│  │ GPU Detector │  │ Firewall Manager│   │
│  │ (per-OS)     │  │ (per-OS)        │   │
│  └──────┬──────┘  └────────┬────────┘   │
│         │                  │             │
│  ┌──────┴──────────────────┴────────┐   │
│  │        Core Agent Logic          │   │
│  │  - Register with HivePoA        │   │
│  │  - Start inference backend      │   │
│  │  - Health reporting             │   │
│  │  - Model management             │   │
│  └──────┬───────────────────────────┘   │
│         │                               │
│  ┌──────┴──────┐  ┌─────────────────┐   │
│  │ Inference   │  │ System Tray /   │   │
│  │ Backend     │  │ Menu Bar UI     │   │
│  │ (per-GPU)   │  │ (per-OS)        │   │
│  └─────────────┘  └─────────────────┘   │
└─────────────────────────────────────────┘
```

### Platform Adapters

```typescript
// gpu-detector.ts
interface GpuInfo {
  model: string;
  vramGb: number;
  type: "nvidia_cuda" | "apple_metal" | "amd_rocm" | "intel_arc" | "cpu_only";
  driverVersion?: string;
}

// Implementations:
// - gpu-detector-windows.ts (nvidia-smi)
// - gpu-detector-macos.ts (system_profiler)
// - gpu-detector-linux-nvidia.ts (nvidia-smi)
// - gpu-detector-linux-amd.ts (rocm-smi)

// firewall-manager.ts
interface FirewallManager {
  openPort(port: number): Promise<void>;
  checkPort(port: number): Promise<boolean>;
}

// Implementations:
// - firewall-windows.ts (netsh + UAC)
// - firewall-macos.ts (socketfilterfw)
// - firewall-linux.ts (ufw / firewall-cmd)

// inference-backend.ts
interface InferenceBackend {
  install(): Promise<void>;
  start(modelPath: string, port: number): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<boolean>;
}

// Implementations:
// - backend-llamaserver.ts (all platforms)
// - backend-ollama.ts (all platforms)
// - backend-vllm-docker.ts (Linux/Windows with Docker)
```

## The User Experience (Every Platform)

### First Launch

```
┌─────────────────────────────────────────┐
│                                         │
│  Welcome to Spirit Bomb                 │
│                                         │
│  Detected: NVIDIA RTX 4070 (12 GB)      │
│  OS: Windows 11                         │
│                                         │
│  Ready to contribute your GPU to the    │
│  community AI brain and earn HBD?       │
│                                         │
│          [ Start Contributing ]         │
│                                         │
│  Estimated earnings: ~1.2 HBD/day       │
│                                         │
└─────────────────────────────────────────┘
```

One click. Behind the scenes:
1. Installs llama-server (if needed) — 30 seconds
2. Downloads model — shows progress bar
3. Opens firewall — OS popup, user clicks Allow
4. Starts inference — green checkmark
5. Registers with HivePoA — instant
6. Shows dashboard — "You're contributing!"

### Ongoing (System Tray / Menu Bar)

```
  Spirit Bomb ● Online
  ─────────────────────
  GPU: RTX 4070 (12 GB)
  Pool: 5 nodes, 72 GB
  Earned today: 0.32 HBD
  ─────────────────────
  [ Pause ]  [ Dashboard ]
```

## Implementation Priority

| Phase | What | Effort |
|-------|------|--------|
| 1 | Windows installer (already 80% built as batch file) | Small |
| 2 | macOS installer (Homebrew + .dmg) | Medium |
| 3 | Linux one-liner (`curl \| sh`) | Small |
| 4 | Universal agent with platform adapters | Medium |
| 5 | Auto-updater across all platforms | Medium |
| 6 | Package manager distribution (brew, apt, winget) | Small |

## What HivePoA Needs to Add

| Endpoint | Purpose |
|----------|---------|
| `GET /api/gpu/recommended-model` | Returns best model for given VRAM (Hive-AI decides model, we route the request) |
| `POST /api/gpu/register` | Alias for /api/compute/nodes/register (already done) |
| `GET /api/gpu/installer/{os}` | Returns download URL for platform-specific installer |

## What's Already Done

- [x] Pool router (EMA scoring, health checks, failover, SSE streaming)
- [x] Node registration with inference endpoint
- [x] Windows batch file installer (start-hivepoa.bat, setup_computer_b.bat)
- [x] GPU detection (nvidia-smi)
- [x] Docker manager for vLLM
- [x] Health monitoring
- [x] /api/gpu/* endpoint aliases for Hive-AI
- [x] Firewall rules automation (Windows)

## What's NOT Done

- [ ] macOS GPU detection (system_profiler adapter)
- [ ] macOS firewall handling (socketfilterfw)
- [ ] Linux GPU detection (multi-vendor: NVIDIA/AMD/Intel)
- [ ] Electron/native installers (.exe, .dmg)
- [ ] System tray / menu bar UI (cross-platform)
- [ ] Auto-updater
- [ ] Model download progress UI
- [ ] `curl | sh` install script for Linux
- [ ] Homebrew tap
- [ ] Package signing (code signing for macOS, Authenticode for Windows)
