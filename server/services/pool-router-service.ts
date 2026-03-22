/**
 * Pool Router Service — Load-balanced inference routing across GPU nodes.
 *
 * Health-checks registered nodes, maintains EMA quality scores,
 * selects the best node for each inference request, and handles failover.
 */
import { type ComputeNode } from "@shared/schema";

const EMA_ALPHA = 0.1; // Slow-moving average (~10 request half-life)
const MAX_WEIGHT_CAP = 0.3; // No single node gets >30% of traffic
const IMMUNITY_FLOOR = 0.3; // Immune nodes get at least this weight
const HEALTH_CHECK_INTERVAL_MS = 10_000; // 10 seconds
const STATUS_CHECK_INTERVAL_MS = 30_000; // 30 seconds
const HEALTH_TIMEOUT_MS = 5_000;
const INFERENCE_TIMEOUT_MS = 120_000; // 2 min
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_FAILOVER_ATTEMPTS = 3;
const MAX_EXPECTED_LATENCY_MS = 60_000; // For EMA score calculation

interface PoolNodeState {
  nodeId: string;
  nodeInstanceId: string;
  inferenceEndpoint: string;
  healthy: boolean;
  lastHealthCheck: number;
  gpuUtilizationPct: number;
  emaScore: number;
  immuneUntil: number;
  consecutiveFailures: number;
  inFlightRequests: number;
  gpuModel: string;
  gpuVramGb: number;
  hivePower: number;
}

interface RoutingResult {
  nodeId: string;
  nodeInstanceId: string;
  response: any;
  latencyMs: number;
  routedVia: "pool" | "failover";
  attemptsUsed: number;
}

interface PoolStats {
  nodes: {
    id: string;
    instanceId: string;
    gpu: string;
    vramGb: number;
    healthy: boolean;
    emaScore: number;
    utilization: number;
    inFlight: number;
    immune: boolean;
  }[];
  healthyCount: number;
  totalVramGb: number;
}

// Logger — use console if pino not available
const log = {
  info: (msg: string, data?: any) => console.log(`[pool-router] ${msg}`, data || ""),
  warn: (msg: string, data?: any) => console.warn(`[pool-router] ${msg}`, data || ""),
  error: (msg: string, data?: any) => console.error(`[pool-router] ${msg}`, data || ""),
};

export class PoolRouterService {
  private nodes = new Map<string, PoolNodeState>();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private storage: any; // IStorage
  private running = false;

  constructor(storage: any) {
    this.storage = storage;
  }

  /** Start background health-check loops. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    log.info("Starting pool router service");

    // Initial load of nodes from DB
    await this.refreshNodes();

    // Health check every 10s
    this.healthTimer = setInterval(() => this.healthCheckAll(), HEALTH_CHECK_INTERVAL_MS);

    // GPU status poll every 30s
    this.statusTimer = setInterval(() => this.statusCheckAll(), STATUS_CHECK_INTERVAL_MS);

    log.info(`Pool router started with ${this.nodes.size} nodes`);
  }

  /** Stop background loops. */
  stop(): void {
    this.running = false;
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    log.info("Pool router stopped");
  }

  /** Refresh node list from database. */
  async refreshNodes(): Promise<void> {
    try {
      const dbNodes: ComputeNode[] = await this.storage.getPoolReadyNodes();
      const now = Date.now();

      for (const node of dbNodes) {
        if (!node.inferenceEndpoint) continue;

        const existing = this.nodes.get(node.id);
        if (existing) {
          // Update from DB but keep runtime state
          existing.inferenceEndpoint = node.inferenceEndpoint;
          existing.emaScore = node.emaScore;
          existing.immuneUntil = node.immunityExpiresAt?.getTime() ?? 0;
        } else {
          // New node
          this.nodes.set(node.id, {
            nodeId: node.id,
            nodeInstanceId: node.nodeInstanceId,
            inferenceEndpoint: node.inferenceEndpoint,
            healthy: false, // unknown until first health check
            lastHealthCheck: 0,
            gpuUtilizationPct: 0,
            emaScore: node.emaScore,
            immuneUntil: node.immunityExpiresAt?.getTime() ?? 0,
            consecutiveFailures: 0,
            inFlightRequests: 0,
            gpuModel: node.gpuModel,
            gpuVramGb: node.gpuVramGb,
            hivePower: (node as any).hivePower ?? 0,
          });
        }
      }

      // Remove nodes no longer in DB
      const dbNodeIds = new Set(dbNodes.map(n => n.id));
      this.nodes.forEach((_val, id) => {
        if (!dbNodeIds.has(id)) this.nodes.delete(id);
      });
    } catch (err) {
      log.error("Failed to refresh nodes from DB", err);
    }
  }

  /** Health-check all nodes — tries /ready, /health, then base URL. */
  private async healthCheckAll(): Promise<void> {
    await this.refreshNodes(); // Pick up new registrations

    const checks = Array.from(this.nodes.values()).map(async (node) => {
      // Try multiple health endpoints (Hive-AI uses /ready, llama-server uses /health)
      const endpoints = [
        `${node.inferenceEndpoint}/ready`,
        `${node.inferenceEndpoint}/health`,
        node.inferenceEndpoint,
      ];

      for (const url of endpoints) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timeout);

          if (res.ok) {
            node.healthy = true;
            node.consecutiveFailures = 0;
            node.lastHealthCheck = Date.now();
            return; // success — stop trying other endpoints
          }
        } catch {
          // try next endpoint
        }
      }

      // All endpoints failed
      this.markUnhealthy(node);
    });

    await Promise.allSettled(checks);
  }

  /** Poll GPU status from each node via GET /api/compute/status. */
  private async statusCheckAll(): Promise<void> {
    const checks = Array.from(this.nodes.values())
      .filter(n => n.healthy)
      .map(async (node) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);

          const res = await fetch(`${node.inferenceEndpoint}/api/compute/status`, {
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (res.ok) {
            const data = await res.json() as any;
            // If node reports busy (e.g., running eval), treat as 100% utilized
            // so the router avoids it but still considers it healthy
            node.gpuUtilizationPct = data.busy ? 100 : (data.gpu?.utilization_pct ?? 0);
          }
        } catch {
          // Status poll failure doesn't mark unhealthy — /ready is the authority
        }
      });

    await Promise.allSettled(checks);
  }

  private markUnhealthy(node: PoolNodeState): void {
    node.consecutiveFailures++;
    node.lastHealthCheck = Date.now();

    if (node.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      if (node.healthy) {
        log.warn(`Node ${node.nodeInstanceId} marked unhealthy after ${node.consecutiveFailures} failures`);
      }
      node.healthy = false;
    }
  }

  /** Select the best node for routing. Returns ordered list for failover. */
  selectNodes(): PoolNodeState[] {
    const now = Date.now();
    const healthy = Array.from(this.nodes.values()).filter(n => n.healthy);

    if (healthy.length === 0) return [];

    // Compute weights
    const weighted = healthy.map(node => {
      const isImmune = now < node.immuneUntil;
      const utilFactor = 1 - (node.gpuUtilizationPct / 100);
      const loadFactor = 1 / (1 + node.inFlightRequests);
      // Stake bonus: logarithmic to prevent plutocracy. 100 HP = 1x, 1000 HP = 1.3x, 10000 HP = 1.6x
      const stakeFactor = 1 + Math.log2(Math.max(node.hivePower, 100) / 100) * 0.1;
      let weight = node.emaScore * utilFactor * loadFactor * stakeFactor;

      // Immune nodes get a floor weight
      if (isImmune) weight = Math.max(weight, IMMUNITY_FLOOR);

      return { node, weight };
    });

    // Cap max weight
    const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
    if (totalWeight > 0) {
      for (const w of weighted) {
        if (w.weight / totalWeight > MAX_WEIGHT_CAP) {
          w.weight = totalWeight * MAX_WEIGHT_CAP;
        }
      }
    }

    // Weighted random selection — probabilistic, not deterministic
    // This ensures all healthy nodes get SOME traffic proportional to their weight
    const totalW = weighted.reduce((sum, w) => sum + w.weight, 0);
    if (totalW > 0) {
      const rand = Math.random() * totalW;
      let cumulative = 0;
      let selectedIdx = 0;
      for (let i = 0; i < weighted.length; i++) {
        cumulative += weighted[i].weight;
        if (rand <= cumulative) { selectedIdx = i; break; }
      }
      // Put selected first, rest as fallbacks sorted by weight
      const selected = weighted.splice(selectedIdx, 1)[0];
      weighted.sort((a, b) => b.weight - a.weight);
      weighted.unshift(selected);
    }

    return weighted.map(w => w.node);
  }

  /** Route an inference request with failover. */
  async routeInference(body: { prompt: string; max_tokens?: number; mode?: string }): Promise<RoutingResult> {
    const candidates = this.selectNodes();
    if (candidates.length === 0) {
      throw new Error("No healthy pool nodes available");
    }

    const startTime = Date.now();
    const errors: string[] = [];

    for (let attempt = 0; attempt < Math.min(candidates.length, MAX_FAILOVER_ATTEMPTS); attempt++) {
      const node = candidates[attempt];
      node.inFlightRequests++;

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);

        // Try Hive-AI format first, then OpenAI-compatible (llama-server/vLLM)
        let res: Response | null = null;
        let data: any = null;

        // Attempt 1: Hive-AI /api/compute/inference
        try {
          res = await fetch(`${node.inferenceEndpoint}/api/compute/inference`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (res.ok) {
            data = await res.json();
          }
        } catch { /* try next format */ }

        // Attempt 2: OpenAI-compatible /v1/chat/completions (llama-server, vLLM)
        if (!data) {
          try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), INFERENCE_TIMEOUT_MS);
            res = await fetch(`${node.inferenceEndpoint}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                messages: [{ role: "user", content: body.prompt }],
                max_tokens: body.max_tokens || 2048,
                stream: false,
              }),
              signal: controller2.signal,
            });
            clearTimeout(timeout2);
            if (res.ok) {
              const oaiData = await res.json();
              // Normalize OpenAI format to our format
              data = {
                text: oaiData.choices?.[0]?.message?.content || "",
                tokens: oaiData.usage?.completion_tokens || 0,
                model: oaiData.model || "llama-server",
              };
            }
          } catch { /* both formats failed */ }
        }

        clearTimeout(timeout);
        node.inFlightRequests = Math.max(0, node.inFlightRequests - 1);

        if (data) {
          const latencyMs = Date.now() - startTime;

          // Update EMA score (success)
          // Skip EMA update for cached responses (< 50ms = Hive-AI cache hit, not real GPU work)
          if (latencyMs >= 50) {
            const sampleScore = Math.max(0.1, Math.min(1.0, 1.0 - (latencyMs / MAX_EXPECTED_LATENCY_MS)));
            this.updateEma(node, sampleScore);
          }

          // Log routing decision
          this.logRouting(node.nodeId, candidates.slice(1).map(n => n.nodeId), latencyMs, true, null, attempt > 0 ? "failover" : "pool");

          return {
            nodeId: node.nodeId,
            nodeInstanceId: node.nodeInstanceId,
            response: data,
            latencyMs,
            routedVia: attempt > 0 ? "failover" : "pool",
            attemptsUsed: attempt + 1,
          };
        } else {
          const errText = res ? await res.text().catch(() => `HTTP ${res!.status}`) : "No response";
          errors.push(`${node.nodeInstanceId}: ${errText}`);
          this.updateEma(node, 0); // failure
        }
      } catch (err: any) {
        node.inFlightRequests = Math.max(0, node.inFlightRequests - 1);
        errors.push(`${node.nodeInstanceId}: ${err.message}`);
        this.updateEma(node, 0); // failure
      }
    }

    // All attempts failed
    const latencyMs = Date.now() - startTime;
    this.logRouting(candidates[0].nodeId, candidates.slice(1).map(n => n.nodeId), latencyMs, false, errors.join("; "), "failover");

    throw new Error(`All pool nodes failed: ${errors.join("; ")}`);
  }

  /** Update EMA score for a node. */
  private updateEma(node: PoolNodeState, sampleScore: number): void {
    node.emaScore = EMA_ALPHA * sampleScore + (1 - EMA_ALPHA) * node.emaScore;

    // Persist to DB periodically (fire-and-forget)
    this.storage.updateNodeEmaScore(node.nodeId, node.emaScore).catch(() => {});
  }

  /** Log a routing decision (fire-and-forget). */
  private logRouting(nodeId: string, fallbackIds: string[], latencyMs: number, success: boolean, errorCode: string | null, routedVia: string): void {
    this.storage.createInferenceRoutingLog({
      selectedNodeId: nodeId,
      fallbackNodeIds: JSON.stringify(fallbackIds),
      latencyMs,
      success,
      errorCode,
      routedVia,
    }).catch(() => {});
  }

  /** Get current pool stats for dashboard. */
  getStats(): PoolStats {
    const now = Date.now();
    const nodeList = Array.from(this.nodes.values());

    return {
      nodes: nodeList.map(n => ({
        id: n.nodeId,
        instanceId: n.nodeInstanceId,
        gpu: n.gpuModel,
        vramGb: n.gpuVramGb,
        healthy: n.healthy,
        emaScore: Math.round(n.emaScore * 100) / 100,
        utilization: n.gpuUtilizationPct,
        inFlight: n.inFlightRequests,
        immune: now < n.immuneUntil,
        hivePower: Math.round(n.hivePower),
      })),
      healthyCount: nodeList.filter(n => n.healthy).length,
      totalVramGb: nodeList.filter(n => n.healthy).reduce((sum, n) => sum + n.gpuVramGb, 0),
    };
  }

  /** Check if pool routing is available (at least 1 healthy node). */
  isAvailable(): boolean {
    return Array.from(this.nodes.values()).some(n => n.healthy);
  }
}
