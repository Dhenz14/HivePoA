import { db } from "../db";
import { encodingJobs, encodingJobEvents, encoderNodes, type EncodingJob } from "@shared/schema";
import { eq, and, sql, lte, isNull, or, desc, asc } from "drizzle-orm";
import crypto from "crypto";
import { logScheduler } from "../logger";

const LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const RETRY_BACKOFF_BASE_MS = 30 * 1000; // 30 seconds

export interface QueueStats {
  queued: number;
  assigned: number;
  processing: number;
  completed: number;
  failed: number;
  totalPending: number;
}

export interface ClaimResult {
  job: EncodingJob | null;
  leaseId: string | null;
}

export class JobScheduler {
  private cleanupInterval: NodeJS.Timeout | null = null;

  start(): void {
    this.cleanupInterval = setInterval(() => this.cleanupExpiredLeases(), 60000);
    logScheduler.info("[JobScheduler] Started with lease cleanup every 60s");
  }

  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  async claimJob(encoderId: string, encoderType: "desktop" | "browser" | "community"): Promise<ClaimResult> {
    const now = new Date();
    const leaseExpires = new Date(now.getTime() + LEASE_DURATION_MS);
    const leaseId = crypto.randomUUID();

    const priorityOrder = encoderType === "desktop" ? 
      ["self", "auto"] : 
      encoderType === "browser" ? 
        ["auto"] : 
        ["community", "auto"];

    for (const mode of priorityOrder) {
      const candidates = await db.select({ id: encodingJobs.id })
        .from(encodingJobs)
        .where(and(
          eq(encodingJobs.status, "queued"),
          or(
            eq(encodingJobs.encodingMode, mode),
            eq(encodingJobs.encodingMode, "auto")
          ),
          or(
            isNull(encodingJobs.nextRetryAt),
            lte(encodingJobs.nextRetryAt, now)
          ),
          encoderType === "browser" ? eq(encodingJobs.isShort, true) : sql`1=1`
        ))
        .orderBy(desc(encodingJobs.priority), asc(encodingJobs.createdAt))
        .limit(1);

      if (candidates.length === 0) continue;

      const [job] = await db.update(encodingJobs)
        .set({
          status: "assigned",
          assignedEncoderId: encoderId,
          assignedAt: now,
          leaseExpiresAt: leaseExpires,
          encoderType,
        })
        .where(and(
          eq(encodingJobs.id, candidates[0].id),
          eq(encodingJobs.status, "queued")
        ))
        .returning();

      if (job) {
        await this.logEvent(job.id, "assigned", "queued", "assigned", encoderId, {
          leaseId,
          encoderType,
          leaseExpiresAt: leaseExpires.toISOString(),
        });
        return { job, leaseId };
      }
    }

    return { job: null, leaseId: null };
  }

  async releaseJob(jobId: string, reason: string): Promise<void> {
    const [job] = await db.select().from(encodingJobs).where(eq(encodingJobs.id, jobId));
    if (!job) return;

    const attempts = (job.attempts || 0) + 1;
    const canRetry = attempts < (job.maxAttempts || 3);

    if (canRetry) {
      const backoffMs = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempts - 1);
      const nextRetry = new Date(Date.now() + backoffMs);

      await db.update(encodingJobs)
        .set({
          status: "queued",
          assignedEncoderId: null,
          assignedAt: null,
          leaseExpiresAt: null,
          attempts,
          lastError: reason,
          nextRetryAt: nextRetry,
          currentStage: null,
          stageProgress: 0,
        })
        .where(eq(encodingJobs.id, jobId));

      await this.logEvent(jobId, "retried", job.status || "assigned", "queued", job.assignedEncoderId, {
        reason,
        attempt: attempts,
        nextRetryAt: nextRetry.toISOString(),
      });
    } else {
      await db.update(encodingJobs)
        .set({
          status: "failed",
          errorMessage: reason,
          attempts,
          completedAt: new Date(),
        })
        .where(eq(encodingJobs.id, jobId));

      await this.logEvent(jobId, "failed", job.status || "assigned", "failed", job.assignedEncoderId, {
        reason,
        attempts,
        maxAttemptsReached: true,
      });
    }
  }

  async updateProgress(jobId: string, stage: string, progress: number, status?: string): Promise<void> {
    const updates: Partial<EncodingJob> = {
      currentStage: stage,
      stageProgress: progress,
    };

    if (status) {
      updates.status = status;
      if (status === "downloading" || status === "encoding") {
        updates.startedAt = new Date();
      }
    }

    const totalProgress = this.calculateTotalProgress(stage, progress);
    updates.progress = totalProgress;

    await db.update(encodingJobs)
      .set(updates)
      .where(eq(encodingJobs.id, jobId));
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
    const [job] = await db.select().from(encodingJobs).where(eq(encodingJobs.id, jobId));
    if (!job) return;

    await db.update(encodingJobs)
      .set({
        status: "completed",
        progress: 100,
        outputCid: result.outputCid,
        videoUrl: `ipfs://${result.outputCid}/master.m3u8`,
        qualitiesEncoded: result.qualitiesEncoded.join(","),
        processingTimeSec: result.processingTimeSec,
        outputSizeBytes: result.outputSizeBytes,
        completedAt: new Date(),
        currentStage: null,
        stageProgress: null,
      })
      .where(eq(encodingJobs.id, jobId));

    if (job.assignedEncoderId) {
      // Update job counts and reputation on successful completion
      const encoder = await db.select().from(encoderNodes).where(eq(encoderNodes.id, job.assignedEncoderId));
      if (encoder.length > 0) {
        const currentEncoder = encoder[0];
        const totalJobs = (currentEncoder.jobsCompleted || 0) + 1;
        const newSuccessRate = ((currentEncoder.successRate || 100) * (totalJobs - 1) + 100) / totalJobs;
        const reputationBoost = Math.min(10, Math.floor(totalJobs / 10)); // Gain reputation for consistent work
        
        await db.update(encoderNodes)
          .set({
            jobsCompleted: sql`${encoderNodes.jobsCompleted} + 1`,
            jobsInProgress: sql`GREATEST(${encoderNodes.jobsInProgress} - 1, 0)`,
            successRate: newSuccessRate,
            reputationScore: sql`LEAST(${encoderNodes.reputationScore} + ${reputationBoost}, 1000)`,
          })
          .where(eq(encoderNodes.id, job.assignedEncoderId));
      }
    }

    await this.logEvent(jobId, "completed", job.status || "uploading", "completed", job.assignedEncoderId, {
      outputCid: result.outputCid,
      qualities: result.qualitiesEncoded,
      processingTimeSec: result.processingTimeSec,
    });
  }

  async failJob(jobId: string, error: string, retryable: boolean = true): Promise<void> {
    if (retryable) {
      await this.releaseJob(jobId, error);
    } else {
      const [job] = await db.select().from(encodingJobs).where(eq(encodingJobs.id, jobId));
      
      await db.update(encodingJobs)
        .set({
          status: "failed",
          errorMessage: error,
          completedAt: new Date(),
        })
        .where(eq(encodingJobs.id, jobId));

      // Apply reputation penalty for failed jobs
      if (job?.assignedEncoderId) {
        const encoder = await db.select().from(encoderNodes).where(eq(encoderNodes.id, job.assignedEncoderId));
        if (encoder.length > 0) {
          const currentEncoder = encoder[0];
          const totalJobs = (currentEncoder.jobsCompleted || 0) + 1;
          const newSuccessRate = ((currentEncoder.successRate || 100) * totalJobs - 100) / totalJobs;
          
          await db.update(encoderNodes)
            .set({
              jobsInProgress: sql`GREATEST(${encoderNodes.jobsInProgress} - 1, 0)`,
              successRate: Math.max(0, newSuccessRate),
              reputationScore: sql`GREATEST(${encoderNodes.reputationScore} - 25, 0)`, // Penalty for failure
            })
            .where(eq(encoderNodes.id, job.assignedEncoderId));
        }
      }

      await this.logEvent(jobId, "failed", job?.status || "unknown", "failed", job?.assignedEncoderId, {
        error,
        retryable: false,
      });
    }
  }

  async cancelJob(jobId: string, reason: string): Promise<void> {
    const [job] = await db.select().from(encodingJobs).where(eq(encodingJobs.id, jobId));
    if (!job) return;

    await db.update(encodingJobs)
      .set({
        status: "cancelled",
        errorMessage: reason,
        completedAt: new Date(),
      })
      .where(eq(encodingJobs.id, jobId));

    await this.logEvent(jobId, "cancelled", job.status || "unknown", "cancelled", null, { reason });
  }

  async renewLease(jobId: string): Promise<boolean> {
    const newExpiry = new Date(Date.now() + LEASE_DURATION_MS);
    
    const result = await db.update(encodingJobs)
      .set({ leaseExpiresAt: newExpiry })
      .where(and(
        eq(encodingJobs.id, jobId),
        sql`${encodingJobs.status} NOT IN ('completed', 'failed', 'cancelled')`
      ))
      .returning();

    return result.length > 0;
  }

  async getQueueStats(): Promise<QueueStats> {
    const [stats] = await db.select({
      queued: sql<number>`count(*) filter (where ${encodingJobs.status} = 'queued')`,
      assigned: sql<number>`count(*) filter (where ${encodingJobs.status} = 'assigned')`,
      processing: sql<number>`count(*) filter (where ${encodingJobs.status} in ('downloading', 'encoding', 'uploading'))`,
      completed: sql<number>`count(*) filter (where ${encodingJobs.status} = 'completed')`,
      failed: sql<number>`count(*) filter (where ${encodingJobs.status} = 'failed')`,
    }).from(encodingJobs);

    return {
      queued: Number(stats?.queued) || 0,
      assigned: Number(stats?.assigned) || 0,
      processing: Number(stats?.processing) || 0,
      completed: Number(stats?.completed) || 0,
      failed: Number(stats?.failed) || 0,
      totalPending: (Number(stats?.queued) || 0) + (Number(stats?.assigned) || 0) + (Number(stats?.processing) || 0),
    };
  }

  async getNextJobs(limit: number = 10): Promise<EncodingJob[]> {
    return db.select()
      .from(encodingJobs)
      .where(eq(encodingJobs.status, "queued"))
      .orderBy(desc(encodingJobs.priority), asc(encodingJobs.createdAt))
      .limit(limit);
  }

  private async cleanupExpiredLeases(): Promise<void> {
    const now = new Date();
    
    const expiredJobs = await db.select()
      .from(encodingJobs)
      .where(and(
        eq(encodingJobs.status, "assigned"),
        lte(encodingJobs.leaseExpiresAt, now)
      ));

    for (const job of expiredJobs) {
      logScheduler.info(`[JobScheduler] Releasing expired lease for job ${job.id}`);
      await this.releaseJob(job.id, "Lease expired");
    }

    if (expiredJobs.length > 0) {
      logScheduler.info(`[JobScheduler] Cleaned up ${expiredJobs.length} expired leases`);
    }
  }

  private calculateTotalProgress(stage: string, stageProgress: number): number {
    const stageWeights: Record<string, { start: number; weight: number }> = {
      downloading: { start: 0, weight: 10 },
      encoding_1080p: { start: 10, weight: 30 },
      encoding_720p: { start: 40, weight: 25 },
      encoding_480p: { start: 65, weight: 20 },
      encoding: { start: 10, weight: 75 },
      uploading: { start: 85, weight: 15 },
    };

    const config = stageWeights[stage] || { start: 0, weight: 100 };
    return Math.min(100, Math.floor(config.start + (stageProgress * config.weight / 100)));
  }

  private async logEvent(
    jobId: string,
    eventType: string,
    previousStatus: string | null,
    newStatus: string,
    encoderId: string | null | undefined,
    details: Record<string, any>
  ): Promise<void> {
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

export const jobScheduler = new JobScheduler();
