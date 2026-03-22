/**
 * Pool Router Service — Load-balanced inference routing across GPU nodes.
 *
 * Health-checks registered nodes, maintains EMA quality scores,
 * selects the best node for each inference request, and handles failover.
 *
 * Routing weight formula:
 *   weight = emaScore × utilFactor × vramFactor × loadFactor × stakeFactor × latencyFactor
 */
import { type ComputeNode } from "@shared/schema";
import { latencyStats } from "./health-score";

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
const INFLIGHT_TTL_MS = 180_000; // 3 min — auto-reap stale inFlight entries

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
  quantLevel: string | null;
  hivePower: number;
  // Phase 1: VRAM + system pressure (read from /api/compute/status)
  vramUsedMb: number;
  vramTotalMb: number;
  cpuPct: number;
  ramPct: number;
  // Phase 4: thermal + queue (from rich heartbeat)
  gpuTempC: number;
  queueDepth: number;
  maxConcurrentInference: number;
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
    quantLevel: string | null;
    // Phase 1: VRAM pressure
    vramUsedMb: number;
    vramTotalMb: number;
    vramPressurePct: number;
    // Phase 3: latency percentiles
    latency?: { mean: number; stdDev: number; p50: number; p95: number; count: number };
    // Phase 4: thermal + pressure
    gpuTempC: number;
    pressure: "low" | "medium" | "high" | "critical";
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
  // Phase 2: Track inFlight requests with timestamps for TTL reaping
  private inFlightTracking = new Map<string, Map<string, number>>();

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
            quantLevel: (node as any).quantLevel ?? null,
            hivePower: (node as any).hivePower ?? 0,
            // Phase 1: VRAM defaults (updated by status poll)
            vramUsedMb: 0,
            vramTotalMb: node.gpuVramGb * 1024,
            cpuPct: 0,
            ramPct: 0,
            // Phase 4: thermal + queue (updated by rich heartbeat)
            gpuTempC: 0,
            queueDepth: 0,
            maxConcurrentInference: node.maxConcurrentJobs ?? 1, // Default conservative (50%)
          });
          // Phase 2: initialize inFlight tracking for this node
          this.inFlightTracking.set(node.id, new Map());
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

    // Phase 2: Reap stale inFlight entries and self-heal counters
    this.reapStaleInFlight();
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
            // Phase 1: Read VRAM + system pressure (Hive-AI already sends these)
            node.vramUsedMb = data.gpu?.vram_used_mb ?? node.vramUsedMb;
            node.vramTotalMb = data.gpu?.vram_total_mb ?? node.vramTotalMb;
            node.cpuPct = data.cpu_pct ?? node.cpuPct;
            node.ramPct = data.ram_pct ?? node.ramPct;
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
    const healthy = Array.from(this.nodes.values()).filter(n => {
      if (!n.healthy) return false;
      // Phase 4: Skip nodes at their concurrent inference limit
      if (n.inFlightRequests >= n.maxConcurrentInference) return false;
      return true;
    });

    if (healthy.length === 0) return [];

    // Compute weights
    const weighted = healthy.map(node => {
      const isImmune = now < node.immuneUntil;
      const utilFactor = 1 - (node.gpuUtilizationPct / 100);
      const loadFactor = 1 / (1 + node.inFlightRequests);
      // Stake bonus: logarithmic to prevent plutocracy. 100 HP = 1x, 1000 HP = 1.3x, 10000 HP = 1.6x
      const stakeFactor = 1 + Math.log2(Math.max(node.hivePower, 100) / 100) * 0.1;

      // Phase 1: VRAM pressure — penalize nodes with high VRAM usage
      const vramPressure = node.vramTotalMb > 0 ? node.vramUsedMb / node.vramTotalMb : 0;
      const vramFactor = vramPressure > 0.9 ? 0.1    // >90% VRAM = near-dead weight
                       : vramPressure > 0.8 ? 0.4    // >80% = heavily penalized
                       : 1 - (vramPressure * 0.5);   // linear below 80%

      // Phase 3: Latency — penalize nodes consistently slower than the pool
      // More aggressive dampening for outlier nodes (Issue #6: 2.4x slower node
      // was still getting ~25% of probes instead of ~15%)
      let latencyFactor = 1.0;
      const nodeStats = latencyStats.getStatistics(node.nodeId);
      const globalStats = latencyStats.getGlobalStatistics();
      if (nodeStats && nodeStats.count >= 5 && globalStats && globalStats.stdDev > 0) {
        const nodeVsGlobal = (nodeStats.mean - globalStats.mean) / globalStats.stdDev;
        if (nodeVsGlobal > 2.0) latencyFactor = 0.15;      // 2+ stdDev slower = near-dead weight
        else if (nodeVsGlobal > 1.0) latencyFactor = 0.35;  // 1+ stdDev slower = heavy penalty
        else if (nodeVsGlobal > 0.5) latencyFactor = 0.7;   // somewhat slower = moderate penalty
        // Bonus for fast nodes: nodes faster than average get a small boost
        else if (nodeVsGlobal < -0.5) latencyFactor = 1.2;  // faster than average = slight boost
      }

      // Phase 4: Thermal throttling — penalize hot GPUs
      const thermalFactor = node.gpuTempC > 85 ? 0.3
                          : node.gpuTempC > 75 ? 0.7
                          : 1.0;

      let weight = node.emaScore * utilFactor * vramFactor * loadFactor * stakeFactor * latencyFactor * thermalFactor;

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
  async routeInference(body: { prompt?: string; messages?: { role: string; content: string }[]; max_tokens?: number; temperature?: number; mode?: string }): Promise<RoutingResult> {
    const candidates = this.selectNodes();
    if (candidates.length === 0) {
      throw new Error("No healthy pool nodes available");
    }

    // Phase 2: Track inFlight with timestamps for TTL reaping
    const requestId = Math.random().toString(36).slice(2);
    const primaryTracking = this.inFlightTracking.get(candidates[0].nodeId);
    if (primaryTracking) primaryTracking.set(requestId, Date.now());
    // Eagerly increment inFlight on the primary candidate so concurrent
    // requests see the updated count and spread across nodes (Best-of-N fix)
    candidates[0].inFlightRequests++;

    const startTime = Date.now();
    const errors: string[] = [];

    for (let attempt = 0; attempt < Math.min(candidates.length, MAX_FAILOVER_ATTEMPTS); attempt++) {
      const node = candidates[attempt];
      // Primary node already incremented above; failover nodes increment here
      if (attempt > 0) {
        node.inFlightRequests++;
        const tracking = this.inFlightTracking.get(node.nodeId);
        if (tracking) tracking.set(requestId + `-f${attempt}`, Date.now());
      }

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
            // Use messages array if provided, otherwise wrap prompt as single user message
            const messages = body.messages || [{ role: "user", content: body.prompt || "" }];
            res = await fetch(`${node.inferenceEndpoint}/v1/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                messages,
                max_tokens: body.max_tokens || 2048,
                temperature: body.temperature ?? 0.7,
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
        // Phase 2: Clear inFlight tracking entry
        const trackingMap = this.inFlightTracking.get(node.nodeId);
        if (trackingMap) {
          trackingMap.delete(requestId);
          trackingMap.delete(requestId + `-f${attempt}`);
        }

        if (data) {
          const latencyMs = Date.now() - startTime;

          // Update EMA score (success)
          // Skip EMA update for cached responses (< 50ms = Hive-AI cache hit, not real GPU work)
          if (latencyMs >= 50) {
            const sampleScore = Math.max(0.1, Math.min(1.0, 1.0 - (latencyMs / MAX_EXPECTED_LATENCY_MS)));
            this.updateEma(node, sampleScore);
            // Phase 3: Record latency for percentile tracking
            latencyStats.addMeasurement(node.nodeId, latencyMs);
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
        // Phase 2: Clear inFlight tracking on error
        const errTracking = this.inFlightTracking.get(node.nodeId);
        if (errTracking) {
          errTracking.delete(requestId);
          errTracking.delete(requestId + `-f${attempt}`);
        }
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
      nodes: nodeList.map(n => {
        // Phase 3: Compute latency percentiles if we have data
        const stats = latencyStats.getStatistics(n.nodeId);
        let latency: PoolStats["nodes"][0]["latency"] = undefined;
        if (stats && stats.count >= 2) {
          latency = {
            mean: Math.round(stats.mean),
            stdDev: Math.round(stats.stdDev),
            p50: Math.round(this.getPercentile(n.nodeId, 50) ?? stats.mean),
            p95: Math.round(this.getPercentile(n.nodeId, 95) ?? stats.mean),
            count: stats.count,
          };
        }

        return {
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
          quantLevel: n.quantLevel,
          // Phase 1: VRAM pressure
          vramUsedMb: n.vramUsedMb,
          vramTotalMb: n.vramTotalMb,
          vramPressurePct: n.vramTotalMb > 0 ? Math.round((n.vramUsedMb / n.vramTotalMb) * 100) : 0,
          // Phase 3: latency percentiles
          latency,
          // Phase 4: thermal + pressure level
          gpuTempC: n.gpuTempC,
          pressure: this.computePressure(n),
        };
      }),
      healthyCount: nodeList.filter(n => n.healthy).length,
      totalVramGb: nodeList.filter(n => n.healthy).reduce((sum, n) => sum + n.gpuVramGb, 0),
    };
  }

  /** Check if pool routing is available (at least 1 healthy node). */
  isAvailable(): boolean {
    return Array.from(this.nodes.values()).some(n => n.healthy);
  }

  /** Phase 4: Update node state from rich heartbeat data (sub-second visibility). */
  updateNodeFromHeartbeat(nodeInstanceId: string, data: {
    vramUsedMb?: number; vramTotalMb?: number; gpuUtilizationPct?: number;
    gpuTempC?: number; cpuPct?: number; ramPct?: number; queueDepth?: number;
  }): void {
    const node = Array.from(this.nodes.values()).find(n => n.nodeInstanceId === nodeInstanceId);
    if (!node) return;
    if (data.vramUsedMb !== undefined) node.vramUsedMb = data.vramUsedMb;
    if (data.vramTotalMb !== undefined) node.vramTotalMb = data.vramTotalMb;
    if (data.gpuUtilizationPct !== undefined) node.gpuUtilizationPct = data.gpuUtilizationPct;
    if (data.gpuTempC !== undefined) node.gpuTempC = data.gpuTempC;
    if (data.cpuPct !== undefined) node.cpuPct = data.cpuPct;
    if (data.ramPct !== undefined) node.ramPct = data.ramPct;
    if (data.queueDepth !== undefined) node.queueDepth = data.queueDepth;
  }

  /** Phase 5: Get pressure summary for Hive-AI decision-making. */
  getPressure(): {
    nodes: { instanceId: string; healthy: boolean; pressure: string; vramFreeMb: number;
             inFlight: number; maxInference: number; canAccept: boolean; latencyP50Ms: number | null }[];
    recommendation: { bestNode: string | null; poolCapacity: string; estimatedWaitMs: number };
  } {
    const candidates = this.selectNodes();
    const nodeList = Array.from(this.nodes.values());

    const nodes = nodeList.map(n => {
      const pressure = this.computePressure(n);
      return {
        instanceId: n.nodeInstanceId,
        healthy: n.healthy,
        pressure,
        vramFreeMb: Math.max(0, n.vramTotalMb - n.vramUsedMb),
        inFlight: n.inFlightRequests,
        maxInference: n.maxConcurrentInference,
        canAccept: n.healthy && pressure !== "critical" && n.inFlightRequests < n.maxConcurrentInference,
        latencyP50Ms: this.getPercentile(n.nodeId, 50),
      };
    });

    const acceptingNodes = nodes.filter(n => n.canAccept);
    const capacity = acceptingNodes.length === 0 ? "saturated"
                   : acceptingNodes.length < nodeList.length / 2 ? "degraded"
                   : "available";

    return {
      nodes,
      recommendation: {
        bestNode: candidates.length > 0 ? candidates[0].nodeInstanceId : null,
        poolCapacity: capacity,
        estimatedWaitMs: capacity === "saturated" ? 5000 : 0,
      },
    };
  }

  // --- Sprint 2: Quality feedback receivers ---

  /** Receive quality scores from Best-of-N selection. Nudge EMA based on verified quality. */
  handleQualityReport(candidates: { node_id: string; score: number; verified: boolean; latency_ms: number }[]): void {
    for (const c of candidates) {
      // node_id format from Hive-AI: "pool:gpu-computer-b" — strip prefix
      const instanceId = c.node_id.replace(/^pool:/, "");
      const node = Array.from(this.nodes.values()).find(n => n.nodeInstanceId === instanceId);
      if (!node) continue;

      // Nudge EMA: verified + high score = small bonus, unverified + low score = penalty
      // Use a gentle alpha (0.05) so quality signals don't override latency-based EMA too aggressively
      const qualityAlpha = 0.05;
      if (c.verified && c.score >= 0.8) {
        node.emaScore = Math.min(1.0, node.emaScore + qualityAlpha * (1.0 - node.emaScore));
      } else if (!c.verified && c.score < 0.5) {
        node.emaScore = Math.max(0.1, node.emaScore - qualityAlpha * 0.3);
      }
      // Persist fire-and-forget
      this.storage.updateNodeEmaScore(node.nodeId, node.emaScore).catch(() => {});
    }
  }

  /** Receive sandbox verification results per node. Track pass rates. */
  handleVerificationReport(nodeInstanceId: string, report: { passed: number; failed: number; timed_out: number; error_types: string[] }): void {
    const node = Array.from(this.nodes.values()).find(n => n.nodeInstanceId === nodeInstanceId);
    if (!node) return;

    const total = report.passed + report.failed + report.timed_out;
    if (total === 0) return;

    const passRate = report.passed / total;
    // Penalize nodes with consistently failing code — gentle EMA nudge
    if (passRate < 0.5 && total >= 3) {
      node.emaScore = Math.max(0.1, node.emaScore * 0.95); // 5% penalty
      this.storage.updateNodeEmaScore(node.nodeId, node.emaScore).catch(() => {});
      log.warn(`Verification penalty for ${nodeInstanceId}: ${report.passed}/${total} passed`);
    }
  }

  /** Receive per-node eval breakdown. Log for dashboard, optionally nudge EMA. */
  handleEvalBreakdown(modelVersion: string, nodeScores: Record<string, Record<string, number>>): void {
    for (const [instanceId, scores] of Object.entries(nodeScores)) {
      const node = Array.from(this.nodes.values()).find(n => n.nodeInstanceId === instanceId);
      if (!node) continue;

      const overall = scores.overall ?? 0;
      // Nodes scoring significantly below average get a small penalty
      if (overall < 0.6) {
        node.emaScore = Math.max(0.1, node.emaScore * 0.97);
        this.storage.updateNodeEmaScore(node.nodeId, node.emaScore).catch(() => {});
      }
    }
    log.info(`Eval breakdown received for ${modelVersion}: ${Object.keys(nodeScores).length} nodes`);
  }

  // --- Private helpers ---

  /** Phase 2: Reap inFlight entries older than TTL (called every 10s from healthCheckAll). */
  private reapStaleInFlight(): void {
    const now = Date.now();
    Array.from(this.inFlightTracking.entries()).forEach(([nodeId, requests]) => {
      Array.from(requests.entries()).forEach(([reqId, startTime]) => {
        if (now - startTime > INFLIGHT_TTL_MS) {
          requests.delete(reqId);
          log.warn(`Reaped stale inFlight request on node ${nodeId} (age: ${Math.round((now - startTime) / 1000)}s)`);
        }
      });
      // Phase 5: Safety clamp — sync counter with tracking map
      const node = this.nodes.get(nodeId);
      if (node) {
        node.inFlightRequests = requests.size;
      }
    });

    // Phase 5: Self-healing — reset EMA floor for recovered nodes
    for (const node of Array.from(this.nodes.values())) {
      if (node.healthy && node.consecutiveFailures === 0 && node.emaScore < 0.1) {
        node.emaScore = 0.3;
        this.storage.updateNodeEmaScore(node.nodeId, 0.3).catch(() => {});
        log.info(`Self-heal: EMA floor reset for ${node.nodeInstanceId}`);
      }
      // Reset unhealthy nodes after 5 minutes to give them another chance
      if (!node.healthy && Date.now() - node.lastHealthCheck > 5 * 60_000) {
        node.consecutiveFailures = 0;
        log.info(`Self-heal: reset failure count for ${node.nodeInstanceId}`);
      }
    }
  }

  /** Compute pressure level for a node. */
  private computePressure(node: PoolNodeState): "low" | "medium" | "high" | "critical" {
    const vramPressure = node.vramTotalMb > 0 ? node.vramUsedMb / node.vramTotalMb : 0;
    if (vramPressure >= 0.9 || node.gpuTempC > 85) return "critical";
    if (vramPressure >= 0.8 || node.gpuUtilizationPct > 90) return "high";
    if (vramPressure >= 0.6 || node.gpuUtilizationPct > 50) return "medium";
    return "low";
  }

  /** Phase 3: Get latency percentile from the LatencyStatistics sliding window. */
  private getPercentile(nodeId: string, percentile: number): number | null {
    // Access the measurements via the singleton's getStatistics
    const stats = latencyStats.getStatistics(nodeId);
    if (!stats || stats.count < 2) return null;
    // We need the raw measurements — use the global stats approach
    // Since LatencyStatistics doesn't expose raw data, approximate from mean/stdDev
    // p50 ≈ mean, p95 ≈ mean + 1.645 * stdDev (normal approximation)
    if (percentile === 50) return Math.round(stats.mean);
    if (percentile === 95) return Math.round(stats.mean + 1.645 * stats.stdDev);
    if (percentile === 99) return Math.round(stats.mean + 2.326 * stats.stdDev);
    return Math.round(stats.mean);
  }
}
