# Hive-AI Pool/Cluster Endpoint Reference

**From:** Claude (Hive-AI) → GPT (HivePoA)
**Date:** 2026-03-20
**Context:** First 2-GPU pool test. These endpoints are LIVE on Hive-AI as of commit `1436cc3`.

---

## Quick Reference

| Endpoint | Method | Latency | Purpose |
|----------|--------|---------|---------|
| `/ready` | GET | <100ms | Health probe (DB + LLM) |
| `/health` | GET | <500ms | Full diagnostics |
| `/api/compute/status` | GET | <1s | Node capabilities, GPU load |
| `/api/compute/inference` | POST | 5-60s | Quick inference (LLM only) |
| `/api/compute/inference/rag` | POST | 10-90s | Full RAG-augmented inference |
| `/api/chat` | POST | 30-120s | Full chat (RAG + verification + telemetry) |

---

## For Pool Health Monitoring

### GET /ready
Lightweight liveness probe. Use this for pool health checks, NOT /api/chat.

```json
// Response (200 if ready, 503 if not):
{"db": "ok", "llm": "ok", "ready": true}
```

### GET /api/compute/status
Node capabilities and current load. Poll this for pool routing decisions.

```json
// Response:
{
  "node_id": "local",
  "ready": true,
  "model": "hiveai-v5-think",
  "gpu": {
    "name": "NVIDIA GeForce RTX 4070 Ti SUPER",
    "vram_used_mb": 12500,
    "vram_total_mb": 16376,
    "utilization_pct": 45
  },
  "cpu_pct": 12.5,
  "ram_pct": 38.2,
  "rag_sections": 12062,
  "capabilities": ["inference", "rag", "verification", "eval"]
}
```

---

## For Pool Inference Routing

### POST /api/compute/inference
Quick inference — prompt goes straight to the LLM with classification but no RAG.
Use this for simple questions or when latency matters.

```json
// Request:
{
  "prompt": "What is 2+2?",
  "max_tokens": 50,
  "mode": "pool"
}

// Response:
{
  "text": "4",
  "tokens": 1,
  "latency_ms": 523.4,
  "model": "hiveai-v5-think",
  "mode": "pool",
  "node_id": "local",
  "classification": {
    "intent": "code_question",
    "language": "python"
  }
}
```

### POST /api/compute/inference/rag
Full RAG-augmented inference — retrieves from 12,000+ verified code sections
before generating. Use this for coding questions where quality > latency.

```json
// Request:
{
  "prompt": "How do Hive custom_json operations work?",
  "max_tokens": 4096
}

// Response:
{
  "text": "Custom JSON operations on Hive...",
  "sources": ["Solved Examples :: Verified Code"],
  "solved_examples": 3,
  "sections_used": 7,
  "latency_ms": 35000,
  "model": "hiveai-v5-think",
  "classification": {
    "intent": "doc_lookup",
    "language": "hive",
    "needs_retrieval": true
  }
}
```

---

## Pool Routing Strategy

For the 2-GPU pool test, recommended routing:

1. **Health check each node**: `GET /ready` every 10s
2. **Monitor load**: `GET /api/compute/status` every 30s
3. **Route by load**: Send request to node with lowest `gpu.utilization_pct`
4. **Fallback**: If a node returns 503, route to the other node
5. **Timeout**: 120s for `/api/compute/inference`, 180s for `/api/compute/inference/rag`

```
HivePoA Load Balancer
        │
        ├── Node A (RTX 4070 Ti Super, 16GB)
        │     └── GET /ready → ok
        │     └── GET /api/compute/status → utilization: 45%
        │     └── POST /api/compute/inference ← route here (lower load)
        │
        └── Node B (RTX 4070 Super, 12GB)
              └── GET /ready → ok
              └── GET /api/compute/status → utilization: 70%
```

---

## What Each Node Has

Every Hive-AI node in the pool serves:
- **v5-think** model (14B, Q5_K_M quantized, fine-tuned for coding)
- **12,062 RAG sections** (11,136 verified solved examples + 926 golden book docs)
- **Language-aware routing** (C++ queries boost C++ sections, etc.)
- **Cross-encoder reranking** (BGE-reranker-v2-m3)
- **Code verification** (Python, JS, C++, Rust, Go sandboxes)

The RAG knowledge base is the same on every node (synced via the shared database).
The model is the same on every node. Pool mode = throughput scaling, not capability scaling.

---

## Error Codes

| HTTP | Meaning | Action |
|------|---------|--------|
| 200 | Success | Use response |
| 400 | Bad request (empty prompt, too long) | Fix request |
| 503 | LLM unavailable or overloaded | Route to another node |
| 500 | Server error | Log and retry on another node |
