/**
 * CDN Manager Service
 * Repurposed from SPK Network's trole CDN functionality
 * 
 * Manages CDN nodes, health monitoring, and intelligent routing
 */

import { storage } from "../storage";
import { healthScoreEncoder, latencyStats } from "./health-score";
import { geoCorrection } from "./geo-correction";
import { logCDN } from "../logger";
import type { CdnNode, InsertCdnNode } from "@shared/schema";

export interface CdnRecommendation {
  node: CdnNode;
  score: number;
  reason: string;
}

export class CdnManager {
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  // Start background health monitoring
  start(): void {
    // Check for stale nodes every 30 seconds
    this.heartbeatInterval = setInterval(() => this.checkStaleNodes(), 30000);
    
    // Recalculate health scores every minute
    this.healthCheckInterval = setInterval(() => this.recalculateHealthScores(), 60000);
    
    logCDN.info("[CDN Manager] Started health monitoring");
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    logCDN.info("[CDN Manager] Stopped health monitoring");
  }

  // Register a new CDN node
  async registerNode(data: InsertCdnNode): Promise<CdnNode> {
    const node = await storage.createCdnNode(data);
    logCDN.info(`[CDN Manager] Registered new CDN node: ${node.peerId} (${node.geoRegion})`);
    return node;
  }

  // Process heartbeat from a CDN node
  async processHeartbeat(nodeId: string, metrics?: { latency?: number; requestCount?: number }): Promise<void> {
    const node = await storage.getCdnNode(nodeId);
    if (!node) {
      logCDN.warn(`[CDN Manager] Heartbeat from unknown node: ${nodeId}`);
      return;
    }

    // Update last heartbeat
    await storage.updateCdnNodeHeartbeat(nodeId);

    // Record latency metric if provided
    if (metrics?.latency) {
      latencyStats.addMeasurement(nodeId, metrics.latency);
      
      await storage.createCdnMetric({
        nodeId,
        latencyMs: metrics.latency,
        successRate: 1.0,
        requestCount: metrics.requestCount || 1,
        sourceRegion: null
      });
    }

    // If node was degraded/offline, check if it should come back online
    if (node.status !== 'active') {
      await storage.updateCdnNodeStatus(nodeId, 'active');
      logCDN.info(`[CDN Manager] Node ${nodeId} is back online`);
    }
  }

  // Get recommended CDN nodes for a specific CID
  async getRecommendedNodes(cid: string, requesterRegion?: string): Promise<CdnRecommendation[]> {
    const allNodes = await storage.getActiveCdnNodes();
    
    if (allNodes.length === 0) {
      return [];
    }

    const recommendations: CdnRecommendation[] = [];

    for (const node of allNodes) {
      let score = 50; // Base score
      let reasons: string[] = [];

      // Factor 1: Health score (z-score based)
      try {
        const healthDecoded = healthScoreEncoder.decodeHealthScore(node.healthScore);
        const healthPercent = healthScoreEncoder.zScoreToPercent(healthDecoded.geoCorrected);
        score += (healthPercent - 50) * 0.5; // Health contributes up to +/-25 points
        
        if (healthPercent > 70) {
          reasons.push(`Excellent health (${healthPercent}%)`);
        } else if (healthPercent < 30) {
          reasons.push(`Poor health (${healthPercent}%)`);
          score -= 20;
        }
      } catch (e) {
        // Use raw z-scores if encoded score is invalid
        if (node.geoZScore !== null) {
          score += node.geoZScore * 10;
        }
      }

      // Factor 2: Geographic proximity
      if (requesterRegion && node.geoRegion) {
        const distance = geoCorrection.estimateDistanceCategory(requesterRegion, node.geoRegion);
        const multiplier = geoCorrection.getRegionalMultiplier(requesterRegion, node.geoRegion);
        
        if (distance === 'same') {
          score += 25;
          reasons.push('Same region');
        } else if (distance === 'local') {
          score += 15;
          reasons.push('Nearby');
        } else if (distance === 'continental') {
          score += 5;
          reasons.push('Same continent');
        } else if (distance === 'intercontinental') {
          score -= 10;
          reasons.push('Distant');
        }
      }

      // Factor 3: Node capacity and throughput
      if (node.throughputMax && node.throughputMax > 100) {
        score += 10;
        reasons.push('High bandwidth');
      }

      // Factor 4: Node status
      if (node.status === 'degraded') {
        score -= 30;
        reasons.push('Degraded');
      }

      recommendations.push({
        node,
        score: Math.max(0, Math.min(100, score)),
        reason: reasons.join(', ') || 'Available'
      });
    }

    // Sort by score descending
    recommendations.sort((a, b) => b.score - a.score);

    return recommendations;
  }

  // Get the best gateway URL for a CID
  async getBestGatewayUrl(cid: string, requesterRegion?: string): Promise<string | null> {
    const recommendations = await this.getRecommendedNodes(cid, requesterRegion);
    
    if (recommendations.length === 0) {
      return null;
    }

    const bestNode = recommendations[0].node;
    return `${bestNode.endpoint}/ipfs/${cid}`;
  }

  // Check for stale nodes (no heartbeat in 2 minutes)
  private async checkStaleNodes(): Promise<void> {
    const nodes = await storage.getActiveCdnNodes();
    const staleThreshold = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes

    for (const node of nodes) {
      if (new Date(node.lastHeartbeat) < staleThreshold) {
        if (node.status === 'active') {
          await storage.updateCdnNodeStatus(node.id, 'degraded');
          logCDN.info(`[CDN Manager] Node ${node.peerId} marked as degraded (no heartbeat)`);
        }
      }
    }
  }

  // Recalculate health scores for all nodes
  private async recalculateHealthScores(): Promise<void> {
    const nodes = await storage.getAllCdnNodes();
    const globalStats = latencyStats.getGlobalStatistics();

    for (const node of nodes) {
      const nodeStats = latencyStats.getStatistics(node.id);
      
      if (!nodeStats || !globalStats) {
        continue;
      }

      // Calculate raw z-score (lower latency = better, so we negate)
      const rawZScore = -((nodeStats.mean - globalStats.mean) / globalStats.stdDev);
      
      // Calculate geo-corrected z-score
      let geoZScore = rawZScore;
      if (node.geoRegion) {
        // For geo correction, we use the median baseline approach
        const correction = geoCorrection.calculateStatisticalGeoCorrection(
          nodeStats.mean,
          'global', // Source is global average
          node.geoRegion,
          globalStats.mean,
          globalStats.stdDev
        );
        geoZScore = -((correction - globalStats.mean) / globalStats.stdDev);
      }

      // Encode health score
      const healthScore = healthScoreEncoder.encodeHealthScore(rawZScore, geoZScore);

      // Update node
      await storage.updateCdnNodeHealth(node.id, {
        healthScore,
        rawZScore,
        geoZScore
      });
    }

    logCDN.info(`[CDN Manager] Recalculated health scores for ${nodes.length} nodes`);
  }

  // Simulate CDN nodes for development
  async seedSimulatedNodes(): Promise<void> {
    const existingNodes = await storage.getAllCdnNodes();
    if (existingNodes.length > 0) {
      return; // Already seeded
    }

    const regions = ['us-east', 'us-west', 'eu-central', 'asia-pacific', 'sa-east'];
    
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      await storage.createCdnNode({
        peerId: `cdn-node-${region}-${Math.random().toString(36).substring(7)}`,
        hiveUsername: `cdn-operator-${region}`,
        endpoint: `https://cdn-${region}.spknetwork.example`,
        geoRegion: region,
        geoCountry: region.split('-')[0],
        geoContinent: geoCorrection.parseRegion(region).continent,
        capacity: String(1024 * 1024 * 1024 * 100), // 100GB
        throughputMin: 50 + Math.floor(Math.random() * 50),
        throughputMax: 100 + Math.floor(Math.random() * 100),
        healthScore: 'WW', // Normal
        rawZScore: 0,
        geoZScore: 0,
        status: 'active'
      });
    }

    logCDN.info(`[CDN Manager] Seeded ${regions.length} simulated CDN nodes`);
  }
}

// Singleton instance
export const cdnManager = new CdnManager();
