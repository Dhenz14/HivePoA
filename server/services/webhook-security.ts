import crypto from "crypto";
import { Request, Response, NextFunction } from "express";

const WEBHOOK_SIGNATURE_HEADER = "X-SPK-Signature";
const TIMESTAMP_HEADER = "X-SPK-Timestamp";
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

interface WebhookPayload {
  event: string;
  jobId: string;
  timestamp: string;
  data: Record<string, any>;
}

export function generateWebhookSignature(payload: any, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(JSON.stringify(payload))
    .digest("hex");
}

export function verifyWebhookSignature(
  payload: any,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = generateWebhookSignature(payload, secret);
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expectedSignature, "hex")
    );
  } catch {
    return false;
  }
}

export function verifyTimestamp(timestamp: string | number): boolean {
  const payloadTime = typeof timestamp === "string" 
    ? new Date(timestamp).getTime() 
    : timestamp;
  const now = Date.now();
  const diff = Math.abs(now - payloadTime);
  return diff <= REPLAY_WINDOW_MS;
}

export interface SeenRequestsStore {
  seen: Map<string, number>;
  lastCleanup: number;
}

export function createReplayProtection(): SeenRequestsStore {
  return {
    seen: new Map(),
    lastCleanup: Date.now(),
  };
}

export function isReplayAttack(
  store: SeenRequestsStore,
  requestId: string
): boolean {
  const now = Date.now();
  
  if (now - store.lastCleanup > REPLAY_WINDOW_MS) {
    const cutoff = now - REPLAY_WINDOW_MS;
    const entries = Array.from(store.seen.entries());
    for (const [id, timestamp] of entries) {
      if (timestamp < cutoff) {
        store.seen.delete(id);
      }
    }
    store.lastCleanup = now;
  }
  
  if (store.seen.has(requestId)) {
    return true;
  }
  
  store.seen.set(requestId, now);
  return false;
}

export function generateJobSignature(jobId: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(jobId)
    .digest("hex")
    .slice(0, 32);
}

export function verifyJobSignature(
  jobId: string,
  signature: string,
  secret: string
): boolean {
  const expected = generateJobSignature(jobId, secret);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

export function createWebhookMiddleware(getSecretForJob: (jobId: string) => Promise<string | null>) {
  const replayStore = createReplayProtection();
  
  return async function webhookMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ) {
    const signature = req.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] as string;
    
    if (!signature) {
      return res.status(401).json({ error: "Missing webhook signature" });
    }
    
    const body = req.body as WebhookPayload;
    
    if (!body.jobId || !body.timestamp) {
      return res.status(400).json({ error: "Invalid webhook payload" });
    }
    
    if (!verifyTimestamp(body.timestamp)) {
      return res.status(401).json({ error: "Webhook timestamp expired" });
    }
    
    const requestId = `${body.jobId}:${body.timestamp}:${body.event}`;
    if (isReplayAttack(replayStore, requestId)) {
      return res.status(409).json({ error: "Duplicate webhook request" });
    }
    
    const secret = await getSecretForJob(body.jobId);
    if (!secret) {
      return res.status(404).json({ error: "Unknown job" });
    }
    
    if (!verifyWebhookSignature(body, signature, secret)) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }
    
    next();
  };
}

export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(windowMs: number = 60000, maxRequests: number = 60) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  isAllowed(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    const requests = this.requests.get(key) || [];
    const recentRequests = requests.filter(t => t > windowStart);
    
    if (recentRequests.length >= this.maxRequests) {
      return false;
    }
    
    recentRequests.push(now);
    this.requests.set(key, recentRequests);
    
    return true;
  }

  getRemainingRequests(key: string): number {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const requests = this.requests.get(key) || [];
    const recentRequests = requests.filter(t => t > windowStart);
    return Math.max(0, this.maxRequests - recentRequests.length);
  }
}

export const encodingRateLimiter = new RateLimiter(60000, 30);
export const webhookRateLimiter = new RateLimiter(60000, 100);
