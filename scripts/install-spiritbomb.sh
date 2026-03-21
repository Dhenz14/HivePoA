#!/usr/bin/env bash
#
# Spirit Bomb Universal Installer
# curl -fsSL https://hivepoa.com/install.sh | sh
#
# Works on: macOS (Apple Silicon + Intel), Linux (Ubuntu, Debian, Fedora, Arch)
# Detects GPU, installs inference backend, registers with pool.
#

set -euo pipefail

HIVEPOA_URL="${HIVEPOA_URL:-http://localhost:5000}"
INSTALL_DIR="${HOME}/.spiritbomb"
LLAMASERVER_PORT=11435

# ── Colors ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

info()  { echo -e "${BLUE}[Spirit Bomb]${NC} $1"; }
ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ── Detect OS ───────────────────────────────────────────────────
detect_os() {
  case "$(uname -s)" in
    Darwin) OS="macos"; ARCH="$(uname -m)" ;;
    Linux)  OS="linux"; ARCH="$(uname -m)" ;;
    *)      fail "Unsupported OS: $(uname -s). Windows users: run start-hivepoa.bat instead." ;;
  esac
  ok "Detected: $OS ($ARCH)"
}

# ── Detect GPU ──────────────────────────────────────────────────
detect_gpu() {
  GPU_TYPE="cpu_only"
  GPU_NAME="CPU"
  GPU_VRAM=0

  # NVIDIA (Linux)
  if command -v nvidia-smi &>/dev/null; then
    GPU_INFO=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null || true)
    if [ -n "$GPU_INFO" ]; then
      GPU_NAME=$(echo "$GPU_INFO" | cut -d',' -f1 | xargs)
      GPU_VRAM=$(echo "$GPU_INFO" | cut -d',' -f2 | xargs)
      GPU_VRAM=$((GPU_VRAM / 1024))
      GPU_TYPE="nvidia_cuda"
      ok "GPU: $GPU_NAME (${GPU_VRAM}GB VRAM) — NVIDIA CUDA"
      return
    fi
  fi

  # Apple Silicon (macOS)
  if [ "$OS" = "macos" ]; then
    CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)
    if echo "$CHIP" | grep -qi "apple"; then
      GPU_NAME="$CHIP"
      # Apple Silicon unified memory — use 75% of total RAM
      TOTAL_MEM=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
      GPU_VRAM=$((TOTAL_MEM / 1024 / 1024 / 1024 * 75 / 100))
      GPU_TYPE="apple_metal"
      ok "GPU: $GPU_NAME (${GPU_VRAM}GB unified memory) — Apple Metal"
      return
    fi
  fi

  # AMD ROCm (Linux)
  if command -v rocm-smi &>/dev/null; then
    GPU_NAME=$(rocm-smi --showproductname 2>/dev/null | grep "Card" | head -1 | sed 's/.*: //' || echo "AMD GPU")
    GPU_VRAM=8  # conservative default
    GPU_TYPE="amd_rocm"
    ok "GPU: $GPU_NAME (${GPU_VRAM}GB estimated) — AMD ROCm"
    return
  fi

  # Intel Arc (Linux)
  if command -v xpu-smi &>/dev/null; then
    GPU_NAME=$(xpu-smi discovery 2>/dev/null | grep "Device Name" | head -1 | sed 's/.*: //' || echo "Intel Arc")
    GPU_VRAM=8
    GPU_TYPE="intel_arc"
    ok "GPU: $GPU_NAME (${GPU_VRAM}GB estimated) — Intel Arc"
    return
  fi

  warn "No GPU detected — CPU-only mode (slower but works)"
}

# ── Install Ollama (simplest cross-platform backend) ────────────
install_ollama() {
  if command -v ollama &>/dev/null; then
    ok "Ollama already installed: $(ollama --version 2>/dev/null || echo 'unknown')"
    return
  fi

  info "Installing Ollama..."
  if [ "$OS" = "macos" ]; then
    if command -v brew &>/dev/null; then
      brew install ollama
    else
      curl -fsSL https://ollama.com/install.sh | sh
    fi
  else
    curl -fsSL https://ollama.com/install.sh | sh
  fi
  ok "Ollama installed"
}

# ── Install llama-server (higher performance) ───────────────────
install_llamaserver() {
  if command -v llama-server &>/dev/null; then
    ok "llama-server already installed"
    return
  fi

  # Check if we have a pre-built binary
  if [ -f "$INSTALL_DIR/bin/llama-server" ]; then
    ok "llama-server found at $INSTALL_DIR/bin/llama-server"
    return
  fi

  info "llama-server not found — using Ollama as backend instead"
  BACKEND="ollama"
}

# ── Download Model ──────────────────────────────────────────────
download_model() {
  info "Checking recommended model for ${GPU_VRAM}GB VRAM..."

  # Ask HivePoA for the recommended model (Hive-AI decides, we just relay)
  RECOMMENDED=$(curl -s --max-time 5 "${HIVEPOA_URL}/api/gpu/recommended-model?vram_gb=${GPU_VRAM}" 2>/dev/null || echo "")

  if [ -n "$RECOMMENDED" ] && echo "$RECOMMENDED" | grep -q "model_name"; then
    MODEL_NAME=$(echo "$RECOMMENDED" | python3 -c "import sys,json; print(json.load(sys.stdin).get('model_name','qwen3:14b'))" 2>/dev/null || echo "qwen3:14b")
    info "HivePoA recommends: $MODEL_NAME"
  else
    # Default model based on VRAM
    if [ "$GPU_VRAM" -ge 12 ]; then
      MODEL_NAME="qwen3:14b"
    elif [ "$GPU_VRAM" -ge 6 ]; then
      MODEL_NAME="qwen3.5:9b"
    else
      MODEL_NAME="qwen3:1.7b"
    fi
    info "Using default model: $MODEL_NAME (based on ${GPU_VRAM}GB VRAM)"
  fi

  if [ "$BACKEND" = "ollama" ]; then
    info "Pulling model with Ollama (this may take a few minutes)..."
    ollama pull "$MODEL_NAME"
    ok "Model ready: $MODEL_NAME"
  fi
}

# ── Start Backend ───────────────────────────────────────────────
start_backend() {
  if [ "$BACKEND" = "ollama" ]; then
    info "Starting Ollama..."
    ollama serve &>/dev/null &
    BACKEND_PID=$!
    sleep 3

    # Verify it's running
    if curl -s --max-time 3 http://localhost:11434/api/tags &>/dev/null; then
      ok "Ollama running on port 11434"
      INFERENCE_PORT=11434
    else
      fail "Ollama failed to start"
    fi
  else
    info "Starting llama-server..."
    "$INSTALL_DIR/bin/llama-server" \
      -m "$INSTALL_DIR/models/$MODEL_NAME" \
      --host 0.0.0.0 --port $LLAMASERVER_PORT \
      -ngl 99 -c 4096 &>/dev/null &
    BACKEND_PID=$!
    sleep 5
    INFERENCE_PORT=$LLAMASERVER_PORT
    ok "llama-server running on port $INFERENCE_PORT"
  fi
}

# ── Register with HivePoA ──────────────────────────────────────
register_node() {
  info "Registering with Spirit Bomb pool..."

  # Generate stable node ID (persists across restarts)
  NODE_ID_FILE="$INSTALL_DIR/.node-id"
  if [ -f "$NODE_ID_FILE" ]; then
    NODE_ID=$(cat "$NODE_ID_FILE")
  else
    NODE_ID="spiritbomb-$(hostname)-$(openssl rand -hex 4 2>/dev/null || head -c 8 /dev/urandom | xxd -p)"
    echo "$NODE_ID" > "$NODE_ID_FILE"
  fi

  # Get local IP
  if [ "$OS" = "macos" ]; then
    LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1")
  else
    LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")
  fi

  RESULT=$(curl -s --max-time 10 -X POST "${HIVEPOA_URL}/api/compute/nodes/register" \
    -H "Content-Type: application/json" \
    -H "Authorization: ApiKey ${HIVEPOA_API_KEY:-}" \
    -d "{
      \"nodeInstanceId\": \"$NODE_ID\",
      \"gpuModel\": \"$GPU_NAME\",
      \"gpuVramGb\": $GPU_VRAM,
      \"supportedWorkloads\": \"inference\",
      \"maxConcurrentJobs\": 1,
      \"inferenceEndpoint\": \"http://${LOCAL_IP}:${INFERENCE_PORT}\"
    }" 2>/dev/null || echo "")

  if echo "$RESULT" | grep -q "nodeInstanceId"; then
    ok "Registered as: $NODE_ID"
    ok "Inference endpoint: http://${LOCAL_IP}:${INFERENCE_PORT}"
  else
    warn "Registration failed — pool routing will not include this node"
    warn "Set HIVEPOA_URL and HIVEPOA_API_KEY environment variables"
    echo "  Response: $RESULT"
  fi
}

# ── Main ────────────────────────────────────────────────────────
main() {
  echo ""
  echo -e "${BLUE}╔══════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║        Spirit Bomb Installer         ║${NC}"
  echo -e "${BLUE}║    Contribute Your GPU to the Pool   ║${NC}"
  echo -e "${BLUE}╚══════════════════════════════════════╝${NC}"
  echo ""

  BACKEND="llamaserver"  # default, may change to "ollama"

  mkdir -p "$INSTALL_DIR/bin" "$INSTALL_DIR/models"

  detect_os
  detect_gpu

  if [ "$GPU_VRAM" -lt 4 ] && [ "$GPU_TYPE" != "cpu_only" ]; then
    warn "GPU has less than 4GB VRAM — performance will be limited"
  fi

  install_ollama
  install_llamaserver
  download_model
  start_backend
  register_node

  echo ""
  echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
  echo -e "${GREEN}║      Spirit Bomb is Running!         ║${NC}"
  echo -e "${GREEN}║                                      ║${NC}"
  echo -e "${GREEN}║  GPU: $(printf '%-32s' "$GPU_NAME")  ║${NC}"
  echo -e "${GREEN}║  VRAM: ${GPU_VRAM}GB                           ║${NC}"
  echo -e "${GREEN}║  Pool: ${HIVEPOA_URL}   ║${NC}"
  echo -e "${GREEN}║                                      ║${NC}"
  echo -e "${GREEN}║  Your GPU is now earning HBD!        ║${NC}"
  echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
  echo ""
  echo "Press Ctrl+C to stop contributing."

  # Keep running
  wait $BACKEND_PID 2>/dev/null || true
}

main "$@"
