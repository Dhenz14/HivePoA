import { db } from "../db";
import { 
  encodingJobs, 
  encoderNodes, 
  encodingProfiles, 
  userEncodingSettings,
  type EncodingJob,
  type InsertEncodingJob,
  type EncoderNode,
  type EncodingProfile,
  type UserEncodingSettings,
  type InsertUserEncodingSettings
} from "@shared/schema";
import { eq, desc, and, sql, isNull, or, lte } from "drizzle-orm";
import { logEncoding } from "../logger";

export interface EncodingJobRequest {
  owner: string;
  permlink: string;
  inputCid: string;
  isShort?: boolean;
  webhookUrl?: string;
  originalFilename?: string;
  inputSizeBytes?: number;
  encodingMode?: "auto" | "self" | "community";
}

export interface EncodingJobResult {
  jobId: string;
  status: string;
  manifestCid?: string;
  videoUrl?: string;
  qualitiesEncoded?: string[];
  processingTimeSec?: number;
  error?: string;
}

export interface DesktopAgentStatus {
  available: boolean;
  endpoint?: string;
  hardwareAcceleration?: string;
  jobsInProgress?: number;
}

const DEFAULT_PROFILES: Omit<EncodingProfile, "id" | "createdAt">[] = [
  {
    name: "1080p",
    width: 1920,
    height: 1080,
    videoBitrate: "4500k",
    audioBitrate: "128k",
    videoCodec: "h264",
    audioCodec: "aac",
    profile: "high",
    level: "4.1",
    preset: "medium",
    isDefault: true,
  },
  {
    name: "720p",
    width: 1280,
    height: 720,
    videoBitrate: "2500k",
    audioBitrate: "128k",
    videoCodec: "h264",
    audioCodec: "aac",
    profile: "high",
    level: "4.0",
    preset: "medium",
    isDefault: true,
  },
  {
    name: "480p",
    width: 854,
    height: 480,
    videoBitrate: "1000k",
    audioBitrate: "128k",
    videoCodec: "h264",
    audioCodec: "aac",
    profile: "main",
    level: "3.1",
    preset: "medium",
    isDefault: true,
  },
];

export class EncodingService {
  async initializeProfiles(): Promise<void> {
    const existing = await db.select().from(encodingProfiles).limit(1);
    if (existing.length === 0) {
      for (const profile of DEFAULT_PROFILES) {
        await db.insert(encodingProfiles).values(profile).onConflictDoNothing();
      }
      logEncoding.info("[EncodingService] Initialized default encoding profiles");
    }
  }

  async getProfiles(): Promise<EncodingProfile[]> {
    return db.select().from(encodingProfiles).where(eq(encodingProfiles.isDefault, true));
  }

  async submitJob(request: EncodingJobRequest): Promise<EncodingJob> {
    const mode = request.encodingMode || "auto";
    
    const [job] = await db.insert(encodingJobs).values({
      owner: request.owner,
      permlink: request.permlink,
      inputCid: request.inputCid,
      isShort: request.isShort || false,
      webhookUrl: request.webhookUrl,
      originalFilename: request.originalFilename,
      inputSizeBytes: request.inputSizeBytes,
      encodingMode: mode,
      status: "queued",
      progress: 0,
    }).returning();

    if (mode === "auto" || mode === "self") {
      const userSettings = await this.getUserSettings(request.owner);
      if (userSettings?.desktopAgentEnabled && userSettings.desktopAgentEndpoint) {
        await this.dispatchToDesktopAgent(job, userSettings.desktopAgentEndpoint);
      }
    }

    logEncoding.info(`[EncodingService] Job ${job.id} submitted for ${request.owner}/${request.permlink}`);
    return job;
  }

  async getJob(jobId: string): Promise<EncodingJob | null> {
    const [job] = await db.select().from(encodingJobs).where(eq(encodingJobs.id, jobId));
    return job || null;
  }

  async getJobsByOwner(owner: string, limit = 20): Promise<EncodingJob[]> {
    return db.select()
      .from(encodingJobs)
      .where(eq(encodingJobs.owner, owner))
      .orderBy(desc(encodingJobs.createdAt))
      .limit(limit);
  }

  async getRecentJobs(limit = 50): Promise<EncodingJob[]> {
    return db.select()
      .from(encodingJobs)
      .orderBy(desc(encodingJobs.createdAt))
      .limit(limit);
  }

  async getQueuedJobs(): Promise<EncodingJob[]> {
    return db.select()
      .from(encodingJobs)
      .where(eq(encodingJobs.status, "queued"))
      .orderBy(encodingJobs.createdAt);
  }

  async updateJobProgress(jobId: string, progress: number, status?: string): Promise<void> {
    const updates: Partial<EncodingJob> = { progress };
    if (status) updates.status = status;
    if (status === "encoding" && !updates.startedAt) {
      updates.startedAt = new Date();
    }
    await db.update(encodingJobs).set(updates).where(eq(encodingJobs.id, jobId));
  }

  async completeJob(
    jobId: string, 
    result: { 
      outputCid: string; 
      qualitiesEncoded: string[];
      processingTimeSec: number;
      outputSizeBytes?: number;
    }
  ): Promise<void> {
    await db.update(encodingJobs).set({
      status: "completed",
      progress: 100,
      outputCid: result.outputCid,
      videoUrl: `ipfs://${result.outputCid}/manifest.m3u8`,
      qualitiesEncoded: result.qualitiesEncoded.join(","),
      processingTimeSec: result.processingTimeSec,
      outputSizeBytes: result.outputSizeBytes,
      completedAt: new Date(),
    }).where(eq(encodingJobs.id, jobId));

    const job = await this.getJob(jobId);
    if (job?.webhookUrl && !job.webhookDelivered) {
      await this.deliverWebhook(job);
    }
  }

  async failJob(jobId: string, errorMessage: string): Promise<void> {
    await db.update(encodingJobs).set({
      status: "failed",
      errorMessage,
      completedAt: new Date(),
    }).where(eq(encodingJobs.id, jobId));

    const job = await this.getJob(jobId);
    if (job?.webhookUrl && !job.webhookDelivered) {
      await this.deliverWebhook(job, errorMessage);
    }
  }

  async registerEncoder(data: {
    peerId: string;
    hiveUsername: string;
    endpoint?: string;
    encoderType: "desktop" | "browser" | "community";
    hardwareAcceleration?: string;
    presetsSupported?: string;
  }): Promise<EncoderNode> {
    const existing = await db.select()
      .from(encoderNodes)
      .where(eq(encoderNodes.peerId, data.peerId));

    if (existing.length > 0) {
      await db.update(encoderNodes).set({
        status: "active",
        availability: "available",
        lastHeartbeat: new Date(),
        endpoint: data.endpoint,
        hardwareAcceleration: data.hardwareAcceleration,
      }).where(eq(encoderNodes.peerId, data.peerId));
      return existing[0];
    }

    const [node] = await db.insert(encoderNodes).values({
      peerId: data.peerId,
      hiveUsername: data.hiveUsername,
      endpoint: data.endpoint,
      encoderType: data.encoderType,
      hardwareAcceleration: data.hardwareAcceleration,
      presetsSupported: data.presetsSupported || "hls",
      status: "active",
      availability: "available",
    }).returning();

    return node;
  }

  async heartbeatEncoder(peerId: string, jobsInProgress: number): Promise<void> {
    await db.update(encoderNodes).set({
      lastHeartbeat: new Date(),
      jobsInProgress,
      availability: jobsInProgress > 0 ? "busy" : "available",
    }).where(eq(encoderNodes.peerId, peerId));
  }

  async getAvailableEncoders(type?: string): Promise<EncoderNode[]> {
    const query = db.select()
      .from(encoderNodes)
      .where(and(
        eq(encoderNodes.status, "active"),
        eq(encoderNodes.availability, "available"),
        type ? eq(encoderNodes.encoderType, type) : sql`1=1`
      ))
      .orderBy(desc(encoderNodes.rating), encoderNodes.avgProcessingTime);

    return query;
  }

  async getCommunityEncoders(): Promise<EncoderNode[]> {
    return this.getAvailableEncoders("community");
  }

  async getUserSettings(username: string): Promise<UserEncodingSettings | null> {
    const [settings] = await db.select()
      .from(userEncodingSettings)
      .where(eq(userEncodingSettings.username, username));
    return settings || null;
  }

  async updateUserSettings(username: string, settings: Partial<InsertUserEncodingSettings>): Promise<UserEncodingSettings> {
    const existing = await this.getUserSettings(username);
    
    if (existing) {
      const [updated] = await db.update(userEncodingSettings)
        .set({ ...settings, updatedAt: new Date() })
        .where(eq(userEncodingSettings.username, username))
        .returning();
      return updated;
    }

    const [created] = await db.insert(userEncodingSettings)
      .values({ username, ...settings })
      .returning();
    return created;
  }

  async checkDesktopAgent(endpoint: string): Promise<DesktopAgentStatus> {
    try {
      const response = await fetch(`${endpoint}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });
      
      if (response.ok) {
        const data = await response.json();
        return {
          available: true,
          endpoint,
          hardwareAcceleration: data.hardwareAcceleration,
          jobsInProgress: data.jobsInProgress || 0,
        };
      }
    } catch (error) {
      logEncoding.info(`[EncodingService] Desktop agent not available at ${endpoint}`);
    }
    
    return { available: false };
  }

  async dispatchToDesktopAgent(job: EncodingJob, endpoint: string): Promise<boolean> {
    try {
      const response = await fetch(`${endpoint}/encode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: job.owner,
          permlink: job.permlink,
          input_cid: job.inputCid,
          short: job.isShort,
          webhook_url: `${process.env.REPL_SLUG ? `https://${process.env.REPL_SLUG}.replit.dev` : "http://localhost:5000"}/api/encoding/webhook`,
          api_key: process.env.ENCODING_WEBHOOK_SECRET || "dev-secret",
          originalFilename: job.originalFilename,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        await db.update(encodingJobs).set({
          encoderType: "desktop",
          status: "downloading",
        }).where(eq(encodingJobs.id, job.id));
        return true;
      }
    } catch (error) {
      logEncoding.error(`[EncodingService] Failed to dispatch to desktop agent: ${error}`);
    }
    return false;
  }

  private async deliverWebhook(job: EncodingJob, error?: string): Promise<void> {
    if (!job.webhookUrl) return;

    try {
      const payload = {
        owner: job.owner,
        permlink: job.permlink,
        input_cid: job.inputCid,
        status: job.status,
        manifest_cid: job.outputCid,
        video_url: job.videoUrl,
        job_id: job.id,
        processing_time_seconds: job.processingTimeSec,
        qualities_encoded: job.qualitiesEncoded?.split(",").filter(Boolean) || [],
        error,
        timestamp: new Date().toISOString(),
      };

      await fetch(job.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      await db.update(encodingJobs).set({
        webhookDelivered: true,
      }).where(eq(encodingJobs.id, job.id));
    } catch (error) {
      logEncoding.error(`[EncodingService] Webhook delivery failed for job ${job.id}: ${error}`);
    }
  }

  async getStats(): Promise<{
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    queuedJobs: number;
    processingJobs: number;
    activeEncoders: number;
    communityEncoders: number;
    desktopEncoders: number;
  }> {
    const [jobStats] = await db.select({
      total: sql<number>`count(*)`,
      completed: sql<number>`count(*) filter (where ${encodingJobs.status} = 'completed')`,
      failed: sql<number>`count(*) filter (where ${encodingJobs.status} = 'failed')`,
      queued: sql<number>`count(*) filter (where ${encodingJobs.status} = 'queued')`,
      processing: sql<number>`count(*) filter (where ${encodingJobs.status} in ('downloading', 'encoding', 'uploading'))`,
    }).from(encodingJobs);

    const [encoderStats] = await db.select({
      active: sql<number>`count(*) filter (where ${encoderNodes.status} = 'active')`,
      community: sql<number>`count(*) filter (where ${encoderNodes.encoderType} = 'community' and ${encoderNodes.status} = 'active')`,
      desktop: sql<number>`count(*) filter (where ${encoderNodes.encoderType} = 'desktop' and ${encoderNodes.status} = 'active')`,
    }).from(encoderNodes);

    return {
      totalJobs: Number(jobStats?.total) || 0,
      completedJobs: Number(jobStats?.completed) || 0,
      failedJobs: Number(jobStats?.failed) || 0,
      queuedJobs: Number(jobStats?.queued) || 0,
      processingJobs: Number(jobStats?.processing) || 0,
      activeEncoders: Number(encoderStats?.active) || 0,
      communityEncoders: Number(encoderStats?.community) || 0,
      desktopEncoders: Number(encoderStats?.desktop) || 0,
    };
  }
}

export const encodingService = new EncodingService();
