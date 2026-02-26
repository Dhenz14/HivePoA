/**
 * Transcoding Service
 * Repurposed from SPK Network's oratr video encoding
 *
 * Handles video transcoding to HLS, MP4, and WebM formats.
 * Uses real FFmpeg via VideoProcessor when available, falls back to simulation.
 */

import { storage } from "../storage";
import { videoProcessor, VideoProcessor } from "./video-processor";
import { getIPFSClient } from "./ipfs-client";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type { TranscodeJob, EncoderNode, InsertTranscodeJob } from "@shared/schema";

export interface TranscodePreset {
  id: string;
  name: string;
  format: 'hls' | 'mp4' | 'webm';
  resolution: '720p' | '1080p' | '480p' | '4k';
  bitrate: string;
  description: string;
}

export const TRANSCODE_PRESETS: TranscodePreset[] = [
  { id: 'hls', name: 'HLS Adaptive', format: 'hls', resolution: '1080p', bitrate: 'adaptive', description: 'Streaming-ready HLS with multiple quality levels' },
  { id: 'mp4-1080p', name: 'MP4 1080p', format: 'mp4', resolution: '1080p', bitrate: '5000k', description: 'High quality MP4' },
  { id: 'mp4-720p', name: 'MP4 720p', format: 'mp4', resolution: '720p', bitrate: '3000k', description: 'Standard quality MP4' },
  { id: 'mp4-480p', name: 'MP4 480p', format: 'mp4', resolution: '480p', bitrate: '1500k', description: 'Low bandwidth MP4' },
  { id: 'webm-1080p', name: 'WebM 1080p', format: 'webm', resolution: '1080p', bitrate: '4000k', description: 'VP9 codec, high quality' },
  { id: 'webm-720p', name: 'WebM 720p', format: 'webm', resolution: '720p', bitrate: '2500k', description: 'VP9 codec, standard quality' },
];

export class TranscodingService {
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private ffmpegAvailable = false;

  // Start the transcoding worker
  start(): void {
    this.ffmpegAvailable = this.checkFfmpeg();
    if (this.ffmpegAvailable) {
      console.log("[Transcoding Service] FFmpeg detected — real encoding enabled");
    } else {
      console.warn("[Transcoding Service] FFmpeg not found — using simulated encoding");
    }
    this.processingInterval = setInterval(() => this.processQueue(), 5000);
    console.log("[Transcoding Service] Started job processor");
  }

  private checkFfmpeg(): boolean {
    try {
      const cmd = process.platform === "win32" ? "where ffmpeg" : "which ffmpeg";
      execSync(cmd, { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    console.log("[Transcoding Service] Stopped job processor");
  }

  // Submit a new transcode job
  async submitJob(params: {
    fileId: string;
    inputCid: string;
    preset: string;
    requestedBy: string;
  }): Promise<TranscodeJob> {
    const presetConfig = TRANSCODE_PRESETS.find(p => p.id === params.preset);
    if (!presetConfig) {
      throw new Error(`Unknown preset: ${params.preset}`);
    }

    const job = await storage.createTranscodeJob({
      fileId: params.fileId,
      inputCid: params.inputCid,
      preset: params.preset,
      status: 'queued',
      progress: 0,
    });

    console.log(`[Transcoding Service] Job ${job.id} queued for ${params.preset}`);
    return job;
  }

  // Process the job queue
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const queuedJobs = await storage.getQueuedTranscodeJobs();
      
      for (const job of queuedJobs.slice(0, 3)) { // Process up to 3 jobs at a time
        await this.processJob(job);
      }
    } catch (error) {
      console.error("[Transcoding Service] Queue processing error:", error);
    } finally {
      this.isProcessing = false;
    }
  }

  // Process a single job
  private async processJob(job: TranscodeJob): Promise<void> {
    try {
      // Try to assign to an encoder node
      const encoders = await storage.getAvailableEncoderNodes();
      
      if (encoders.length > 0) {
        // Assign to best available encoder
        const encoder = encoders[0];
        await storage.assignTranscodeJob(job.id, encoder.id);
        await storage.updateEncoderNodeAvailability(encoder.id, 'busy');
        
        console.log(`[Transcoding Service] Job ${job.id} assigned to encoder ${encoder.hiveUsername}`);
        
        // Simulate encoding process
        await this.simulateEncoding(job, encoder);
      } else {
        // No encoders available, process locally (simulation)
        await storage.updateTranscodeJobStatus(job.id, 'processing', 0);
        await this.simulateEncoding(job, null);
      }
    } catch (error) {
      console.error(`[Transcoding Service] Job ${job.id} failed:`, error);
      await storage.updateTranscodeJobStatus(job.id, 'failed', 0, undefined, String(error));
    }
  }

  // Process encoding: use real FFmpeg if available, otherwise simulate
  private async simulateEncoding(job: TranscodeJob, encoder: EncoderNode | null): Promise<void> {
    if (this.ffmpegAvailable) {
      await this.realEncoding(job, encoder);
    } else {
      await this.fallbackSimulatedEncoding(job, encoder);
    }
  }

  // Real FFmpeg encoding via VideoProcessor
  private async realEncoding(job: TranscodeJob, encoder: EncoderNode | null): Promise<void> {
    const outputDir = path.join(process.cwd(), "transcoded", job.id);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Download input file from IPFS to a temp location
    const ipfsClient = getIPFSClient();
    const inputPath = path.join(outputDir, "input");
    try {
      const data = await ipfsClient.cat(job.inputCid);
      fs.writeFileSync(inputPath, data);
    } catch (error) {
      console.error(`[Transcoding Service] Failed to fetch input from IPFS: ${error}`);
      await storage.updateTranscodeJobStatus(job.id, 'failed', 0, undefined, `IPFS fetch failed: ${error}`);
      if (encoder) await storage.updateEncoderNodeAvailability(encoder.id, 'available');
      return;
    }

    // Wire up progress events
    const progressHandler = async (progress: { percent: number; stage: string }) => {
      await storage.updateTranscodeJobStatus(job.id, 'processing', progress.percent).catch(() => {});
    };
    videoProcessor.on("progress", progressHandler);

    try {
      const result = await videoProcessor.encode({
        inputPath,
        outputDir: path.join(outputDir, "output"),
      });

      videoProcessor.off("progress", progressHandler);

      if (result.success) {
        // Upload output to IPFS
        let outputCid = `local_${job.id}`;
        try {
          const masterPlaylist = fs.readFileSync(result.outputPaths.masterPlaylist);
          outputCid = await ipfsClient.addWithPin(masterPlaylist);
        } catch {
          console.warn(`[Transcoding Service] Failed to upload to IPFS, keeping local reference`);
        }

        await storage.updateTranscodeJobStatus(job.id, 'completed', 100, outputCid);
        console.log(`[Transcoding Service] Job ${job.id} completed with FFmpeg (${result.processingTimeSec.toFixed(1)}s, ${result.hardwareAccelUsed})`);
      } else {
        await storage.updateTranscodeJobStatus(job.id, 'failed', 0, undefined, result.error);
        console.error(`[Transcoding Service] Job ${job.id} FFmpeg failed: ${result.error}`);
      }
    } catch (error) {
      videoProcessor.off("progress", progressHandler);
      await storage.updateTranscodeJobStatus(job.id, 'failed', 0, undefined, String(error));
    }

    // Clean up temp files
    try { fs.rmSync(inputPath, { force: true }); } catch {}

    if (encoder) {
      await storage.updateEncoderNodeAvailability(encoder.id, 'available');
    }
  }

  // Fallback simulation when FFmpeg is not available
  private async fallbackSimulatedEncoding(job: TranscodeJob, encoder: EncoderNode | null): Promise<void> {
    const progressSteps = [10, 25, 50, 75, 90, 100];

    for (const progress of progressSteps) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await storage.updateTranscodeJobStatus(job.id, 'processing', progress);
    }

    const outputCid = `Qm${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}transcoded`;
    await storage.updateTranscodeJobStatus(job.id, 'completed', 100, outputCid);

    if (encoder) {
      await storage.updateEncoderNodeAvailability(encoder.id, 'available');
    }

    console.log(`[Transcoding Service] Job ${job.id} completed (simulated) with output ${outputCid}`);
  }

  // Get job status with details
  async getJobStatus(jobId: string): Promise<{
    job: TranscodeJob | null;
    preset: TranscodePreset | null;
    encoder: EncoderNode | null;
  }> {
    const job = await storage.getTranscodeJob(jobId);
    if (!job) {
      return { job: null, preset: null, encoder: null };
    }

    const preset = TRANSCODE_PRESETS.find(p => p.id === job.preset) || null;
    const encoder = job.encoderNodeId ? (await storage.getEncoderNode(job.encoderNodeId) ?? null) : null;

    return { job, preset, encoder };
  }

  // Get all presets
  getPresets(): TranscodePreset[] {
    return TRANSCODE_PRESETS;
  }

  // Calculate estimated cost for encoding
  estimateCost(fileSize: number, preset: string): { hbd: string; estimatedMinutes: number } {
    const presetConfig = TRANSCODE_PRESETS.find(p => p.id === preset);
    if (!presetConfig) {
      return { hbd: '0', estimatedMinutes: 0 };
    }

    // Estimate video duration from file size (rough: 1GB ~ 1 hour of 1080p)
    const estimatedMinutes = Math.ceil((fileSize / (1024 * 1024 * 1024)) * 60);
    
    // Base cost: 0.01 HBD per minute, adjusted by preset complexity
    let costMultiplier = 1.0;
    if (presetConfig.format === 'webm') costMultiplier = 1.5; // WebM is more CPU intensive
    if (presetConfig.resolution === '4k') costMultiplier *= 2;
    if (presetConfig.id === 'hls') costMultiplier *= 1.3; // Multiple outputs

    const hbd = (estimatedMinutes * 0.01 * costMultiplier).toFixed(3);

    return { hbd, estimatedMinutes };
  }

  // Seed sample encoder nodes
  async seedEncoderNodes(): Promise<void> {
    const existingNodes = await storage.getAllEncoderNodes();
    if (existingNodes.length > 0) return;

    const nodes = [
      { peerId: 'encoder-node-1', hiveUsername: 'encoder.alpha', presetsSupported: 'hls,mp4-1080p,mp4-720p', basePriceHbd: '0.01', rating: 4.8 },
      { peerId: 'encoder-node-2', hiveUsername: 'encoder.beta', presetsSupported: 'hls,mp4-1080p,mp4-720p,webm-1080p,webm-720p', basePriceHbd: '0.015', rating: 4.5 },
      { peerId: 'encoder-node-3', hiveUsername: 'encoder.gamma', presetsSupported: 'mp4-720p,mp4-480p', basePriceHbd: '0.008', rating: 4.2 },
    ];

    for (const node of nodes) {
      await storage.createEncoderNode({
        ...node,
        availability: 'available',
        status: 'active',
        jobsCompleted: Math.floor(Math.random() * 100),
        avgProcessingTime: 30 + Math.floor(Math.random() * 60),
      });
    }

    console.log("[Transcoding Service] Seeded sample encoder nodes");
  }
}

// Singleton instance
export const transcodingService = new TranscodingService();
