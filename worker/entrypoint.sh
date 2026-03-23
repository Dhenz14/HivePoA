#!/bin/bash
set -e

echo "============================================"
echo "  Spirit Bomb Worker"
echo "============================================"
echo ""

# Validate required env vars
if [ -z "$HIVEPOA_URL" ]; then
    echo "ERROR: HIVEPOA_URL is required (e.g., http://192.168.1.100:5000)"
    exit 1
fi
if [ -z "$HIVEPOA_API_KEY" ]; then
    echo "ERROR: HIVEPOA_API_KEY is required"
    exit 1
fi
if [ -z "$HIVEPOA_NODE_ID" ]; then
    echo "ERROR: HIVEPOA_NODE_ID is required"
    exit 1
fi

echo "  Pool:     $HIVEPOA_URL"
echo "  Node ID:  $HIVEPOA_NODE_ID"
echo "  CPU Only: $CPU_ONLY"
echo ""

# Step 1: Download model if not cached (GPU mode only)
if [ "$CPU_ONLY" != "true" ]; then
    MODEL_PATH="/models/${MODEL_FILE}"
    if [ ! -f "$MODEL_PATH" ]; then
        echo "[1/3] Downloading model ${MODEL_REPO}..."
        pip3 install -q huggingface-hub 2>/dev/null
        python3 -c "
from huggingface_hub import hf_hub_download
import os
path = hf_hub_download(
    repo_id=os.environ['MODEL_REPO'],
    filename=os.environ['MODEL_FILE'],
    local_dir='/models',
    local_dir_use_symlinks=False
)
print(f'Model downloaded: {path}')
"
    else
        echo "[1/3] Model cached: $MODEL_PATH"
    fi

    # Step 2: Start llama-server in background
    echo "[2/3] Starting llama-server (port $LLAMA_PORT, ngl=$NGL)..."
    llama-server \
        -m "$MODEL_PATH" \
        --port "$LLAMA_PORT" \
        --host 0.0.0.0 \
        -ngl "$NGL" \
        --ctx-size 4096 \
        --parallel 2 \
        > /var/log/llama-server.log 2>&1 &
    LLAMA_PID=$!

    # Wait for llama-server health
    echo -n "  Waiting for model load"
    for i in $(seq 1 120); do
        if curl -sf http://localhost:$LLAMA_PORT/health > /dev/null 2>&1; then
            echo " OK (${i}s)"
            break
        fi
        echo -n "."
        sleep 1
        if [ $i -eq 120 ]; then
            echo " TIMEOUT"
            echo "ERROR: llama-server did not start within 120s"
            cat /var/log/llama-server.log | tail -20
            exit 1
        fi
    done
else
    echo "[1/3] CPU-only mode — skipping model download"
    echo "[2/3] CPU-only mode — skipping llama-server"
fi

# Step 3: Start CPU worker (embedding + reranking + heartbeats)
echo "[3/3] Starting CPU worker (port $CPU_WORKER_PORT)..."
echo ""
echo "============================================"
echo "  Worker is LIVE"
echo "============================================"
echo "  Pool:       $HIVEPOA_URL"
echo "  CPU Worker: http://0.0.0.0:$CPU_WORKER_PORT"
if [ "$CPU_ONLY" != "true" ]; then
    echo "  GPU Server: http://0.0.0.0:$LLAMA_PORT"
fi
echo "============================================"
echo ""

# Run cpu_worker.py in foreground (handles heartbeats, embedding, reranking)
exec python3 /app/cpu_worker.py
