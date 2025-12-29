/**
 * IPFS Gateway Proxy Service
 * Phase 1: Public gateway with CDN routing and blocklist checking
 * 
 * Provides a unified gateway that routes requests to the best CDN node
 */

import type { Request, Response } from "express";
import { cdnManager } from "./cdn-manager";
import { blocklistService } from "./blocklist-service";
import { storage } from "../storage";

export interface GatewayRequest {
  cid: string;
  path?: string;
  requesterRegion?: string;
  platformId?: string;
  validatorId?: string;
  username?: string;
}

export interface GatewayResponse {
  success: boolean;
  redirectUrl?: string;
  data?: Buffer;
  contentType?: string;
  error?: string;
  blocked?: boolean;
  blockReasons?: string[];
}

export class IpfsGatewayService {
  // Default public IPFS gateways as fallback
  private readonly FALLBACK_GATEWAYS = [
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://dweb.link/ipfs/',
  ];

  // Process a gateway request
  async processRequest(request: GatewayRequest): Promise<GatewayResponse> {
    // Check blocklist first
    const blockCheck = await blocklistService.checkBlocked({
      targetType: 'cid',
      targetValue: request.cid,
      userScopes: {
        username: request.username,
        platformId: request.platformId,
        validatorId: request.validatorId,
      },
    });

    if (blockCheck.blocked) {
      return {
        success: false,
        blocked: true,
        blockReasons: blockCheck.reasons.map(r => `${r.scope}: ${r.reason}`),
        error: 'Content blocked by policy',
      };
    }

    // Get best CDN node
    const recommendations = await cdnManager.getRecommendedNodes(
      request.cid,
      request.requesterRegion
    );

    if (recommendations.length > 0) {
      const bestNode = recommendations[0].node;
      const fullPath = request.path ? `${request.cid}/${request.path}` : request.cid;
      const redirectUrl = `${bestNode.endpoint}/ipfs/${fullPath}`;

      return {
        success: true,
        redirectUrl,
      };
    }

    // Fallback to public gateway
    const fallbackIndex = Math.floor(Math.random() * this.FALLBACK_GATEWAYS.length);
    const fallbackGateway = this.FALLBACK_GATEWAYS[fallbackIndex];
    const fullPath = request.path ? `${request.cid}/${request.path}` : request.cid;

    return {
      success: true,
      redirectUrl: `${fallbackGateway}${fullPath}`,
    };
  }

  // Express middleware for gateway requests
  createMiddleware() {
    return async (req: Request, res: Response) => {
      const cid = req.params.cid;
      const path = req.params[0]; // Capture remaining path

      if (!cid) {
        return res.status(400).json({ error: 'CID required' });
      }

      // Extract requester info
      const requesterRegion = req.headers['cf-ipcountry'] as string || 
                              req.headers['x-vercel-ip-country'] as string ||
                              'unknown';
      
      const platformId = req.headers['x-platform-id'] as string;
      const username = req.headers['x-hive-username'] as string;

      try {
        const result = await this.processRequest({
          cid,
          path,
          requesterRegion,
          platformId,
          username,
        });

        if (result.blocked) {
          return res.status(451).json({ 
            error: result.error,
            reasons: result.blockReasons,
          });
        }

        if (result.redirectUrl) {
          // Record metric for CDN
          // In production, this would be done async
          return res.redirect(302, result.redirectUrl);
        }

        if (result.data) {
          res.setHeader('Content-Type', result.contentType || 'application/octet-stream');
          return res.send(result.data);
        }

        return res.status(500).json({ error: 'No response available' });
      } catch (error) {
        console.error('[IPFS Gateway] Error:', error);
        return res.status(500).json({ error: 'Gateway error' });
      }
    };
  }

  // Get gateway statistics
  async getStats(): Promise<{
    totalNodes: number;
    activeNodes: number;
    regions: string[];
    avgLatency: number;
  }> {
    const allNodes = await storage.getAllCdnNodes();
    const activeNodes = await storage.getActiveCdnNodes();
    
    const regionSet = new Set(allNodes.map(n => n.geoRegion).filter(Boolean));
    const regions = Array.from(regionSet);
    
    // Calculate average latency from recent metrics
    let totalLatency = 0;
    let latencyCount = 0;
    
    for (const node of activeNodes.slice(0, 10)) {
      const metrics = await storage.getCdnNodeMetrics(node.id, 10);
      for (const m of metrics) {
        totalLatency += m.latencyMs;
        latencyCount++;
      }
    }

    return {
      totalNodes: allNodes.length,
      activeNodes: activeNodes.length,
      regions,
      avgLatency: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
    };
  }

  // Validate a CID format
  isValidCid(cid: string): boolean {
    // Basic CID validation
    // CIDv0: 46 characters starting with Qm
    // CIDv1: Variable length starting with b (base32) or z (base58btc)
    if (cid.startsWith('Qm') && cid.length === 46) {
      return /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid);
    }
    if (cid.startsWith('b') || cid.startsWith('z')) {
      return /^[a-z2-7]{59}$/.test(cid) || /^z[1-9A-HJ-NP-Za-km-z]+$/.test(cid);
    }
    return false;
  }

  // Get content type from file extension
  getContentType(path: string | undefined): string {
    if (!path) return 'application/octet-stream';
    
    const ext = path.split('.').pop()?.toLowerCase();
    const types: Record<string, string> = {
      'html': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'json': 'application/json',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'svg': 'image/svg+xml',
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'mp3': 'audio/mpeg',
      'm3u8': 'application/vnd.apple.mpegurl',
      'ts': 'video/mp2t',
      'pdf': 'application/pdf',
    };

    return types[ext || ''] || 'application/octet-stream';
  }
}

// Singleton instance
export const ipfsGateway = new IpfsGatewayService();
