# Separation of Concerns: HivePoA vs Hive-AI

## Iron Wall Rule

HivePoA and Hive-AI are separate projects with clearly defined lanes. **Never cross lanes.**

## HivePoA's Lane (GPU Infrastructure)

- GPU node registration, health monitoring, PoA challenges
- Pool/Cluster formation and load-balanced routing
- Tier system (Solo/Pool/Cluster based on GPU count)
- HBD reward calculation and distribution
- Storage validation (existing)
- Firewall, networking, Docker orchestration
- Desktop Agent for GPU contribution onboarding
- Community dashboard (GPU pool stats, earnings, tier status)

## Hive-AI's Lane (AI / Models)

- Model selection (which LLM to run)
- Model training, fine-tuning, LoRA adapters
- RAG pipeline, knowledge base, Golden Books
- Inference quality decisions
- Quantization choices
- Model evaluation and benchmarking
- The `/api/chat`, `/api/compute/inference`, `/api/compute/status` endpoints

## How They Work Together

```
User request
    |
    v
HivePoA (load balancer)
    |
    ├── Checks registered GPU nodes
    ├── Picks node with lowest load
    └── Forwards request to Hive-AI on that node
            |
            v
        Hive-AI (inference)
            ├── Classifies request
            ├── RAG retrieval (if needed)
            ├── Routes to model (its own decision)
            └── Returns response
```

HivePoA NEVER decides which model to run. It routes requests. Hive-AI NEVER manages GPU pools. It serves inference.

## Communication Protocol

- **Questions about models/AI:** Audit Hive-AI's repo first. If unclear, send a PR.
- **Questions about GPU infra:** Audit HivePoA's repo first. If unclear, send a PR.
- **Endpoint contracts:** Documented in `docs/HIVE_AI_POOL_ENDPOINTS.md` (from Hive-AI) and `docs/COMPUTE_API_CONTRACT.md` (from HivePoA).
- **Never assume** what the other project does. Read the code or ask via PR.

## Why This Matters

Without clear lanes, both projects duplicate work, make conflicting decisions (e.g., HivePoA picking Qwen3 while Hive-AI uses Qwen2.5), and step on each other's toes. The iron wall prevents this.
