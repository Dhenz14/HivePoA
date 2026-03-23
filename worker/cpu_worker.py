#!/usr/bin/env python3
"""
Lightweight CPU worker for HivePoA pool — serves embedding + reranking.

This is a standalone Flask app that only needs:
  pip install flask sentence-transformers psutil requests

No database, no RAG pipeline, no llama-server. Just BGE-M3 + cross-encoder.

Usage:
    # First time (downloads ~430MB of models):
    pip install flask sentence-transformers psutil requests

    # Run:
    export HIVEPOA_URL=http://<gateway>:5000
    export HIVEPOA_API_KEY=<your-key>
    export HIVEPOA_NODE_ID=<your-node-id>
    python scripts/cpu_worker.py

    # Or with custom port:
    python scripts/cpu_worker.py --port 5001

Models are cached in ~/.cache/huggingface/hub/ after first download.
Memory: ~2.8GB (2GB base + 800MB models).
CPU: 2+ cores recommended.
"""

import argparse
import logging
import os
import subprocess
import threading
import time

from flask import Flask, jsonify, request

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("cpu-worker")

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Model loading (lazy, thread-safe)
# ---------------------------------------------------------------------------

_embedding_model = None
_embedding_lock = threading.Lock()
_reranker_model = None
_reranker_lock = threading.Lock()

EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-m3")
RERANKER_MODEL = os.environ.get("RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")


def _configure_cpu_threads():
    """Cap PyTorch threads to avoid contention with llama-server on same machine."""
    import multiprocessing
    default_threads = max(2, multiprocessing.cpu_count() // 2)
    n = int(os.environ.get("EMBEDDING_THREADS", str(default_threads)))
    os.environ.setdefault("OMP_NUM_THREADS", str(n))
    os.environ.setdefault("MKL_NUM_THREADS", str(n))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    try:
        import torch
        torch.set_num_threads(n)
    except ImportError:
        pass
    return n


def _get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        with _embedding_lock:
            if _embedding_model is None:
                n = _configure_cpu_threads()
                from sentence_transformers import SentenceTransformer
                device = os.environ.get("EMBEDDING_DEVICE", "cpu")
                logger.info(f"Loading embedding model: {EMBEDDING_MODEL} on {device} (threads={n})")
                _embedding_model = SentenceTransformer(EMBEDDING_MODEL, device=device)
                dims = _embedding_model.get_sentence_embedding_dimension()
                logger.info(f"Embedding model loaded ({dims} dims)")
    return _embedding_model


def _get_reranker():
    global _reranker_model
    if _reranker_model is None:
        with _reranker_lock:
            if _reranker_model is None:
                from sentence_transformers import CrossEncoder
                logger.info(f"Loading reranker model: {RERANKER_MODEL}")
                _reranker_model = CrossEncoder(RERANKER_MODEL)
                logger.info("Reranker model loaded")
    return _reranker_model


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.route("/api/compute/embedding", methods=["POST"])
def compute_embedding():
    """Embed texts using BGE-M3. Max 512 texts per batch."""
    t0 = time.perf_counter()
    data = request.get_json()
    texts = data.get("texts", [])
    if not texts:
        return jsonify({"error": "texts array is required"}), 400
    if len(texts) > 512:
        return jsonify({"error": f"batch too large: {len(texts)} (max 512)"}), 400

    try:
        model = _get_embedding_model()
        embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False)
        emb_list = [e.tolist() for e in embeddings]
        latency_ms = round((time.perf_counter() - t0) * 1000)
        return jsonify({
            "embeddings": emb_list,
            "model": EMBEDDING_MODEL,
            "dimensions": len(emb_list[0]) if emb_list else 0,
            "count": len(emb_list),
            "latency_ms": latency_ms,
        })
    except Exception as e:
        logger.error(f"Embedding failed: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/compute/rerank", methods=["POST"])
def compute_rerank():
    """Rerank candidates against a query. Max 200 candidates."""
    t0 = time.perf_counter()
    data = request.get_json()
    query = data.get("query", "").strip()
    candidates = data.get("candidates", [])
    top_k = data.get("top_k", 8)
    if not query or not candidates:
        return jsonify({"error": "query and candidates are required"}), 400
    if len(candidates) > 200:
        return jsonify({"error": f"too many candidates: {len(candidates)} (max 200)"}), 400

    try:
        model = _get_reranker()
        pairs = [(query, c.get("text", "")[:1500]) for c in candidates]
        scores = model.predict(pairs)
        scored = sorted(
            [{"id": c.get("id", str(i)), "score": round(float(s), 6), "rank": 0}
             for i, (c, s) in enumerate(zip(candidates, scores))],
            key=lambda x: -x["score"],
        )
        for rank, item in enumerate(scored):
            item["rank"] = rank + 1
        latency_ms = round((time.perf_counter() - t0) * 1000)
        return jsonify({"ranked": scored[:top_k], "latency_ms": latency_ms})
    except Exception as e:
        logger.error(f"Reranking failed: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/api/compute/status")
def compute_status():
    """Health + resource telemetry for HivePoA routing."""
    try:
        import psutil
        cpu_pct = psutil.cpu_percent(interval=0)
        ram = psutil.virtual_memory()
        cpu_info = {
            "cores": psutil.cpu_count(),
            "usage_pct": round(cpu_pct, 1),
        }
        ram_info = {
            "total_gb": round(ram.total / (1024**3), 1),
            "used_gb": round(ram.used / (1024**3), 1),
            "usage_pct": round(ram.percent, 1),
        }
    except ImportError:
        cpu_info = {}
        ram_info = {}

    return jsonify({
        "status": "healthy",
        "busy": False,
        "cpu": cpu_info,
        "ram": ram_info,
        "models": {
            "embedding": EMBEDDING_MODEL,
            "reranker": RERANKER_MODEL,
        },
    })


@app.route("/health")
def health():
    return jsonify({"status": "ok", "role": "cpu-worker"})


# ---------------------------------------------------------------------------
# Heartbeat to HivePoA (registers CPU capabilities)
# ---------------------------------------------------------------------------

def _heartbeat_loop(port: int):
    """Send heartbeat with CPU/RAM telemetry + cpuEndpointUrl every 30s."""
    hivepoa_url = os.environ.get("HIVEPOA_URL")
    hivepoa_key = os.environ.get("HIVEPOA_API_KEY", "")
    node_id = os.environ.get("HIVEPOA_NODE_ID", "")
    if not hivepoa_url or not node_id:
        logger.warning("HIVEPOA_URL or HIVEPOA_NODE_ID not set — heartbeat disabled")
        return

    import requests as _req

    # Detect hardware once
    import multiprocessing
    cpu_cores = multiprocessing.cpu_count()
    try:
        import psutil
        ram_gb = int(psutil.virtual_memory().total / (1024**3))
    except ImportError:
        ram_gb = 0

    cpu_endpoint = os.environ.get("CPU_ENDPOINT_URL", f"http://localhost:{port}")

    time.sleep(10)  # Wait for Flask to start
    logger.info(f"Heartbeat started → {hivepoa_url} as {node_id} (cpu={cpu_cores}, ram={ram_gb}GB)")

    while True:
        try:
            payload = {
                "nodeInstanceId": node_id,
                "jobsInProgress": 0,
                "cpuCores": cpu_cores,
                "ramGb": ram_gb,
                "contributionTypes": ["embedding", "reranking", "ram"],
                "cpuEndpointUrl": cpu_endpoint,
            }
            # GPU telemetry (optional)
            try:
                nvidia_smi = "/usr/lib/wsl/lib/nvidia-smi" if os.path.exists("/usr/lib/wsl/lib/nvidia-smi") else "nvidia-smi"
                result = subprocess.run(
                    [nvidia_smi, "--query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu",
                     "--format=csv,noheader,nounits"],
                    capture_output=True, text=True, timeout=5,
                )
                if result.returncode == 0:
                    parts = [p.strip() for p in result.stdout.strip().split(",")]
                    if len(parts) >= 4:
                        payload["vramUsedMb"] = int(parts[0])
                        payload["vramTotalMb"] = int(parts[1])
                        payload["gpuUtilizationPct"] = int(parts[2])
                        payload["gpuTempC"] = int(parts[3])
                        payload["contributionTypes"].insert(0, "gpu_inference")
            except Exception:
                pass
            # CPU/RAM utilization
            try:
                import psutil
                payload["cpuPct"] = round(psutil.cpu_percent(interval=0), 1)
                _ram = psutil.virtual_memory()
                payload["ramUsedMb"] = int(_ram.used / (1024**2))
                payload["ramTotalMb"] = int(_ram.total / (1024**2))
                payload["ramPct"] = round(_ram.percent, 1)
            except ImportError:
                pass

            headers = {"Content-Type": "application/json"}
            if hivepoa_key:
                headers["Authorization"] = f"ApiKey {hivepoa_key}"
            _req.post(f"{hivepoa_url}/api/compute/nodes/heartbeat",
                      json=payload, headers=headers, timeout=5)
        except Exception:
            pass
        time.sleep(30)


# ---------------------------------------------------------------------------
# Warmup (background)
# ---------------------------------------------------------------------------

def _warmup():
    """Pre-load models so first request isn't slow."""
    logger.info("Warming up models...")
    try:
        m = _get_embedding_model()
        m.encode("warmup", show_progress_bar=False)
        _get_reranker()
        logger.info("Models warmed up")
    except Exception as e:
        logger.warning(f"Warmup failed (will lazy-load): {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="HiveAI CPU Worker — embedding + reranking")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "5001")))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--no-warmup", action="store_true", help="Skip model pre-loading")
    args = parser.parse_args()

    # Start heartbeat thread
    threading.Thread(target=_heartbeat_loop, args=(args.port,), daemon=True).start()

    # Warmup models in background
    if not args.no_warmup:
        threading.Thread(target=_warmup, daemon=True).start()

    logger.info(f"CPU worker starting on {args.host}:{args.port}")
    app.run(host=args.host, port=args.port, threaded=True)
