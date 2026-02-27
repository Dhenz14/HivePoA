import { db } from "../db";
import { encodingJobs, userEncodingSettings, type EncodingJob, type InsertEncodingJob } from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { jobScheduler } from "./job-scheduler";
import { logEncoding } from "../logger";
import crypto from "crypto";

interface JobSubmission {
  owner: string;
  permlink: string;
  inputCid: string;
  originalFilename?: string;
  inputSizeBytes?: number;
  isShort?: boolean;
  encodingMode?: "auto" | "self" | "community";
  webhookUrl?: string;
  priority?: number;
}

interface EncoderStatus {
  type: "desktop" | "browser" | "community";
  available: boolean;
  endpoint?: string;
  lastSeen?: Date;
}

interface JobResult {
  jobId: string;
  status: string;
  estimatedWait?: number;
  encoderAssigned?: string;
}

export class EncodingOrchestrator {
  private webhookSecrets = new Map<string, string>();

  async submitJob(submission: JobSubmission): Promise<JobResult> {
    const userSettings = await this.getUserSettings(submission.owner);
    
    const webhookSecret = crypto.randomBytes(32).toString("hex");
    const effectiveMode = submission.encodingMode || userSettings?.preferredMode || "auto";
    
    const isShort = submission.isShort ?? 
      (submission.inputSizeBytes ? submission.inputSizeBytes < 50 * 1024 * 1024 : false);

    const [job] = await db.insert(encodingJobs).values({
      owner: submission.owner,
      permlink: submission.permlink,
      inputCid: submission.inputCid,
      originalFilename: submission.originalFilename,
      inputSizeBytes: submission.inputSizeBytes,
      isShort,
      encodingMode: effectiveMode,
      webhookUrl: submission.webhookUrl || userSettings?.webhookUrl,
      webhookSecret,
      priority: submission.priority ?? 0,
      status: "queued",
    }).returning();

    this.webhookSecrets.set(job.id, webhookSecret);

    await this.logJobEvent(job.id, "created", null, "queued", null, {
      inputCid: submission.inputCid,
      encodingMode: effectiveMode,
      isShort,
    });

    const stats = await jobScheduler.getQueueStats();
    
    return {
      jobId: job.id,
      status: "queued",
      estimatedWait: this.estimateWaitTime(stats.totalPending),
    };
  }

  async checkDesktopAgent(username: string): Promise<EncoderStatus> {
    const settings = await this.getUserSettings(username);
    if (!settings?.desktopAgentEnabled || !settings?.desktopAgentEndpoint) {
      return { type: "desktop", available: false };
    }

    try {
      const response = await fetch(`${settings.desktopAgentEndpoint}/health`, {
        method: "GET",
        headers: { "X-Hive-User": username },
        signal: AbortSignal.timeout(2000),
      });

      if (!response.ok) {
        return { type: "desktop", available: false };
      }

      const health = await response.json();
      return {
        type: "desktop",
        available: health.status === "ready",
        endpoint: settings.desktopAgentEndpoint,
        lastSeen: new Date(),
      };
    } catch {
      return { type: "desktop", available: false };
    }
  }

  async agentClaimJob(encoderId: string, encoderType: "desktop" | "browser" | "community", hiveUser?: string): Promise<{
    job: EncodingJob | null;
    signature?: string;
  }> {
    const { job, leaseId } = await jobScheduler.claimJob(encoderId, encoderType);
    
    if (!job) {
      return { job: null };
    }

    const signature = this.generateJobSignature(job.id, leaseId || "");
    
    return { job, signature };
  }

  async agentReportProgress(
    jobId: string, 
    stage: string, 
    progress: number,
    signature: string
  ): Promise<boolean> {
    const statusMap: Record<string, string> = {
      downloading: "downloading",
      encoding: "encoding",
      encoding_1080p: "encoding",
      encoding_720p: "encoding",
      encoding_480p: "encoding",
      uploading: "uploading",
    };

    const status = statusMap[stage];
    await jobScheduler.updateProgress(jobId, stage, progress, status);
    
    await this.notifyWebhook(jobId, "progress", { stage, progress });
    
    return true;
  }

  async agentCompleteJob(
    jobId: string,
    result: {
      outputCid: string;
      qualitiesEncoded: string[];
      processingTimeSec: number;
      outputSizeBytes?: number;
    },
    signature: string
  ): Promise<void> {
    await jobScheduler.completeJob(jobId, result);
    
    await this.notifyWebhook(jobId, "completed", {
      outputCid: result.outputCid,
      qualities: result.qualitiesEncoded,
      videoUrl: `ipfs://${result.outputCid}/master.m3u8`,
    });
  }

  async agentFailJob(
    jobId: string,
    error: string,
    retryable: boolean,
    signature: string
  ): Promise<void> {
    await jobScheduler.failJob(jobId, error, retryable);
    
    if (!retryable) {
      await this.notifyWebhook(jobId, "failed", { error });
    }
  }

  async getJob(jobId: string): Promise<EncodingJob | null> {
    const [job] = await db.select().from(encodingJobs).where(eq(encodingJobs.id, jobId));
    return job || null;
  }

  async getJobsByOwner(owner: string, limit: number = 50): Promise<EncodingJob[]> {
    return db.select()
      .from(encodingJobs)
      .where(eq(encodingJobs.owner, owner))
      .orderBy(desc(encodingJobs.createdAt))
      .limit(limit);
  }

  async cancelJob(jobId: string, username: string): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job || job.owner !== username) {
      return false;
    }

    if (["completed", "failed", "cancelled"].includes(job.status)) {
      return false;
    }

    await jobScheduler.cancelJob(jobId, `Cancelled by owner: ${username}`);
    await this.notifyWebhook(jobId, "cancelled", { reason: "User cancelled" });
    
    return true;
  }

  async renewJobLease(jobId: string): Promise<boolean> {
    return jobScheduler.renewLease(jobId);
  }

  private async getUserSettings(username: string) {
    const [settings] = await db.select()
      .from(userEncodingSettings)
      .where(eq(userEncodingSettings.username, username));
    return settings;
  }

  private estimateWaitTime(queueDepth: number): number {
    const avgJobTimeSec = 120;
    return queueDepth * avgJobTimeSec;
  }

  private generateJobSignature(jobId: string, leaseId: string): string {
    const secret = this.webhookSecrets.get(jobId) || "default-secret";
    return crypto
      .createHmac("sha256", secret)
      .update(`${jobId}:${leaseId}`)
      .digest("hex");
  }

  private async notifyWebhook(jobId: string, event: string, data: Record<string, any>): Promise<void> {
    const job = await this.getJob(jobId);
    if (!job?.webhookUrl) return;

    const payload = {
      event,
      jobId,
      timestamp: new Date().toISOString(),
      data,
    };

    const secret = this.webhookSecrets.get(jobId) || job.webhookSecret || "";
    const signature = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(payload))
      .digest("hex");

    try {
      await fetch(job.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-SPK-Signature": signature,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (event === "completed" || event === "failed" || event === "cancelled") {
        await db.update(encodingJobs)
          .set({ webhookDelivered: true })
          .where(eq(encodingJobs.id, jobId));
      }
    } catch (error) {
      logEncoding.warn({ err: error }, `Webhook delivery failed for job ${jobId}`);
    }
  }

  private async logJobEvent(
    jobId: string,
    eventType: string,
    previousStatus: string | null,
    newStatus: string,
    encoderId: string | null,
    details: Record<string, any>
  ): Promise<void> {
    const { encodingJobEvents } = await import("@shared/schema");
    await db.insert(encodingJobEvents).values({
      jobId,
      eventType,
      previousStatus,
      newStatus,
      encoderId: encoderId || undefined,
      details: JSON.stringify(details),
    });
  }
}

export const encodingOrchestrator = new EncodingOrchestrator();
