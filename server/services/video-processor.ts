import { spawn, execSync, ChildProcess } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { logVideo } from "../logger";

export type HardwareAccelType = "nvenc" | "vaapi" | "qsv" | "videotoolbox" | "none";

export interface QualityPreset {
  name: string;
  width: number;
  height: number;
  videoBitrate: number;
  audioBitrate: number;
  profile: string;
  level: string;
}

export interface VideoProcessorConfig {
  inputPath: string;
  outputDir: string;
  qualities?: QualityPreset[];
  hwAccel?: HardwareAccelType;
  hlsSegmentDuration?: number;
  preset?: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow";
}

export interface EncodingProgress {
  percent: number;
  stage: string;
  quality?: string;
  fps?: number;
  speed?: string;
  time?: string;
  bitrate?: string;
}

export interface EncodingResult {
  success: boolean;
  outputPaths: {
    masterPlaylist: string;
    qualityPlaylists: { name: string; path: string }[];
    segments: string[];
  };
  qualities: string[];
  processingTimeSec: number;
  hardwareAccelUsed: HardwareAccelType;
  error?: string;
}

export const DEFAULT_QUALITY_PRESETS: QualityPreset[] = [
  {
    name: "1080p",
    width: 1920,
    height: 1080,
    videoBitrate: 4500,
    audioBitrate: 128,
    profile: "high",
    level: "4.1",
  },
  {
    name: "720p",
    width: 1280,
    height: 720,
    videoBitrate: 2500,
    audioBitrate: 128,
    profile: "high",
    level: "4.0",
  },
  {
    name: "480p",
    width: 854,
    height: 480,
    videoBitrate: 1000,
    audioBitrate: 128,
    profile: "main",
    level: "3.1",
  },
];

export class VideoProcessor extends EventEmitter {
  private ffmpegPath: string;
  private ffprobePath: string;
  private detectedHwAccel: HardwareAccelType | null = null;
  private currentProcess: ChildProcess | null = null;
  private cancelled = false;

  constructor(ffmpegPath = "ffmpeg", ffprobePath = "ffprobe") {
    super();
    this.ffmpegPath = ffmpegPath;
    this.ffprobePath = ffprobePath;
  }

  async detectHardwareAcceleration(): Promise<HardwareAccelType> {
    if (this.detectedHwAccel !== null) {
      return this.detectedHwAccel;
    }

    const accelerators: { type: HardwareAccelType; test: () => boolean }[] = [
      { type: "nvenc", test: () => this.testNvenc() },
      { type: "videotoolbox", test: () => this.testVideoToolbox() },
      { type: "qsv", test: () => this.testQsv() },
      { type: "vaapi", test: () => this.testVaapi() },
    ];

    for (const { type, test } of accelerators) {
      try {
        if (test()) {
          this.detectedHwAccel = type;
          this.emit("hwAccelDetected", type);
          logVideo.info(`[VideoProcessor] Hardware acceleration detected: ${type}`);
          return type;
        }
      } catch (e) {
        continue;
      }
    }

    this.detectedHwAccel = "none";
    logVideo.info("[VideoProcessor] No hardware acceleration available, using software encoding");
    return "none";
  }

  private testNvenc(): boolean {
    try {
      const result = execSync(`${this.ffmpegPath} -hide_banner -encoders 2>/dev/null | grep h264_nvenc`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      return result.includes("h264_nvenc");
    } catch {
      return false;
    }
  }

  private testVideoToolbox(): boolean {
    try {
      const result = execSync(`${this.ffmpegPath} -hide_banner -encoders 2>/dev/null | grep h264_videotoolbox`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      return result.includes("h264_videotoolbox");
    } catch {
      return false;
    }
  }

  private testQsv(): boolean {
    try {
      const result = execSync(`${this.ffmpegPath} -hide_banner -encoders 2>/dev/null | grep h264_qsv`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      return result.includes("h264_qsv");
    } catch {
      return false;
    }
  }

  private testVaapi(): boolean {
    try {
      if (!fs.existsSync("/dev/dri/renderD128")) {
        return false;
      }
      const result = execSync(`${this.ffmpegPath} -hide_banner -encoders 2>/dev/null | grep h264_vaapi`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      return result.includes("h264_vaapi");
    } catch {
      return false;
    }
  }

  async getVideoInfo(inputPath: string): Promise<{
    duration: number;
    width: number;
    height: number;
    fps: number;
    codec: string;
  }> {
    return new Promise((resolve, reject) => {
      const args = [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        inputPath,
      ];

      const proc = spawn(this.ffprobePath, args);
      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => (stdout += data.toString()));
      proc.stderr.on("data", (data) => (stderr += data.toString()));

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed: ${stderr}`));
          return;
        }

        try {
          const info = JSON.parse(stdout);
          const videoStream = info.streams?.find((s: any) => s.codec_type === "video");

          if (!videoStream) {
            reject(new Error("No video stream found"));
            return;
          }

          const fps = eval(videoStream.r_frame_rate) || 30;

          resolve({
            duration: parseFloat(info.format?.duration || "0"),
            width: videoStream.width || 1920,
            height: videoStream.height || 1080,
            fps: Math.round(fps),
            codec: videoStream.codec_name || "unknown",
          });
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${e}`));
        }
      });
    });
  }

  buildFFmpegCommand(
    config: VideoProcessorConfig,
    quality: QualityPreset,
    hwAccel: HardwareAccelType
  ): string[] {
    const args: string[] = [];
    const outputPath = path.join(config.outputDir, quality.name);
    const playlistPath = path.join(outputPath, "playlist.m3u8");
    const segmentPattern = path.join(outputPath, "segment_%03d.ts");
    const hlsTime = config.hlsSegmentDuration || 4;
    const preset = config.preset || "medium";

    if (hwAccel === "nvenc") {
      args.push("-hwaccel", "cuda", "-hwaccel_output_format", "cuda");
    } else if (hwAccel === "vaapi") {
      args.push("-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128", "-hwaccel_output_format", "vaapi");
    } else if (hwAccel === "qsv") {
      args.push("-hwaccel", "qsv", "-hwaccel_output_format", "qsv");
    } else if (hwAccel === "videotoolbox") {
      args.push("-hwaccel", "videotoolbox");
    }

    args.push("-i", config.inputPath);

    if (hwAccel === "nvenc") {
      args.push(
        "-c:v", "h264_nvenc",
        "-profile:v", quality.profile,
        "-level:v", quality.level,
        "-preset", "p4",
        "-rc", "vbr",
        "-b:v", `${quality.videoBitrate}k`,
        "-maxrate", `${Math.round(quality.videoBitrate * 1.5)}k`,
        "-bufsize", `${quality.videoBitrate * 2}k`
      );
    } else if (hwAccel === "vaapi") {
      args.push(
        "-vf", `format=nv12,hwupload`,
        "-c:v", "h264_vaapi",
        "-profile:v", quality.profile === "high" ? "high" : "main",
        "-level", quality.level.replace(".", ""),
        "-b:v", `${quality.videoBitrate}k`,
        "-maxrate", `${Math.round(quality.videoBitrate * 1.5)}k`,
        "-bufsize", `${quality.videoBitrate * 2}k`
      );
    } else if (hwAccel === "qsv") {
      args.push(
        "-c:v", "h264_qsv",
        "-profile:v", quality.profile,
        "-level", quality.level.replace(".", ""),
        "-preset", "medium",
        "-b:v", `${quality.videoBitrate}k`,
        "-maxrate", `${Math.round(quality.videoBitrate * 1.5)}k`,
        "-bufsize", `${quality.videoBitrate * 2}k`
      );
    } else if (hwAccel === "videotoolbox") {
      args.push(
        "-c:v", "h264_videotoolbox",
        "-profile:v", quality.profile,
        "-level:v", quality.level,
        "-b:v", `${quality.videoBitrate}k`,
        "-maxrate", `${Math.round(quality.videoBitrate * 1.5)}k`,
        "-bufsize", `${quality.videoBitrate * 2}k`
      );
    } else {
      args.push(
        "-c:v", "libx264",
        "-profile:v", quality.profile,
        "-level:v", quality.level,
        "-preset", preset,
        "-crf", "23",
        "-b:v", `${quality.videoBitrate}k`,
        "-maxrate", `${Math.round(quality.videoBitrate * 1.5)}k`,
        "-bufsize", `${quality.videoBitrate * 2}k`
      );
    }

    args.push(
      "-vf", `scale=${quality.width}:${quality.height}:force_original_aspect_ratio=decrease,pad=${quality.width}:${quality.height}:(ow-iw)/2:(oh-ih)/2`,
      "-c:a", "aac",
      "-b:a", `${quality.audioBitrate}k`,
      "-ac", "2",
      "-ar", "48000",
      "-f", "hls",
      "-hls_time", String(hlsTime),
      "-hls_playlist_type", "vod",
      "-hls_segment_filename", segmentPattern,
      "-hls_flags", "independent_segments",
      playlistPath
    );

    return args;
  }

  parseProgress(line: string, totalDuration: number): EncodingProgress | null {
    const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
    const fpsMatch = line.match(/fps=\s*([\d.]+)/);
    const speedMatch = line.match(/speed=\s*([\d.]+x)/);
    const bitrateMatch = line.match(/bitrate=\s*([\d.]+kbits\/s)/);

    if (!timeMatch) return null;

    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseInt(timeMatch[3], 10);
    const hundredths = parseInt(timeMatch[4], 10);

    const currentTime = hours * 3600 + minutes * 60 + seconds + hundredths / 100;
    const percent = totalDuration > 0 ? Math.min(100, Math.round((currentTime / totalDuration) * 100)) : 0;

    return {
      percent,
      stage: "encoding",
      time: `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
      fps: fpsMatch ? parseFloat(fpsMatch[1]) : undefined,
      speed: speedMatch ? speedMatch[1] : undefined,
      bitrate: bitrateMatch ? bitrateMatch[1] : undefined,
    };
  }

  private async encodeQuality(
    config: VideoProcessorConfig,
    quality: QualityPreset,
    hwAccel: HardwareAccelType,
    duration: number,
    qualityIndex: number,
    totalQualities: number
  ): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const outputPath = path.join(config.outputDir, quality.name);
      
      if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
      }

      const args = this.buildFFmpegCommand(config, quality, hwAccel);
      
      this.emit("progress", {
        percent: 0,
        stage: "starting",
        quality: quality.name,
      } as EncodingProgress);

      const proc = spawn(this.ffmpegPath, args);
      this.currentProcess = proc;

      proc.stderr.on("data", (data: Buffer) => {
        if (this.cancelled) return;

        const line = data.toString();
        const progress = this.parseProgress(line, duration);

        if (progress) {
          const basePercent = (qualityIndex / totalQualities) * 100;
          const qualityPercent = (progress.percent / 100) * (100 / totalQualities);
          
          this.emit("progress", {
            ...progress,
            percent: Math.round(basePercent + qualityPercent),
            quality: quality.name,
          });
        }
      });

      proc.on("close", (code) => {
        this.currentProcess = null;
        
        if (this.cancelled) {
          resolve({ success: false, error: "Encoding cancelled" });
          return;
        }

        if (code !== 0) {
          resolve({ success: false, error: `FFmpeg exited with code ${code}` });
        } else {
          resolve({ success: true });
        }
      });

      proc.on("error", (err) => {
        this.currentProcess = null;
        resolve({ success: false, error: err.message });
      });
    });
  }

  async encode(config: VideoProcessorConfig): Promise<EncodingResult> {
    const startTime = Date.now();
    this.cancelled = false;

    const qualities = config.qualities || DEFAULT_QUALITY_PRESETS;
    let hwAccel = config.hwAccel || (await this.detectHardwareAcceleration());

    if (!fs.existsSync(config.outputDir)) {
      fs.mkdirSync(config.outputDir, { recursive: true });
    }

    this.emit("progress", { percent: 0, stage: "analyzing" } as EncodingProgress);

    let videoInfo;
    try {
      videoInfo = await this.getVideoInfo(config.inputPath);
    } catch (e) {
      return {
        success: false,
        outputPaths: { masterPlaylist: "", qualityPlaylists: [], segments: [] },
        qualities: [],
        processingTimeSec: (Date.now() - startTime) / 1000,
        hardwareAccelUsed: "none",
        error: `Failed to analyze video: ${e}`,
      };
    }

    const applicableQualities = qualities.filter(
      (q) => q.height <= videoInfo.height || q.name === "480p"
    );

    const qualityPlaylists: { name: string; path: string }[] = [];
    const allSegments: string[] = [];

    for (let i = 0; i < applicableQualities.length; i++) {
      const quality = applicableQualities[i];

      if (this.cancelled) {
        return {
          success: false,
          outputPaths: { masterPlaylist: "", qualityPlaylists: [], segments: [] },
          qualities: [],
          processingTimeSec: (Date.now() - startTime) / 1000,
          hardwareAccelUsed: hwAccel,
          error: "Encoding cancelled",
        };
      }

      this.emit("progress", {
        percent: Math.round((i / applicableQualities.length) * 100),
        stage: "encoding",
        quality: quality.name,
      } as EncodingProgress);

      const result = await this.encodeQuality(
        config,
        quality,
        hwAccel,
        videoInfo.duration,
        i,
        applicableQualities.length
      );

      if (!result.success) {
        if (hwAccel !== "none" && i === 0) {
          logVideo.info(`[VideoProcessor] Hardware encoding failed, falling back to software`);
          hwAccel = "none";
          const retryResult = await this.encodeQuality(
            config,
            quality,
            "none",
            videoInfo.duration,
            i,
            applicableQualities.length
          );

          if (!retryResult.success) {
            return {
              success: false,
              outputPaths: { masterPlaylist: "", qualityPlaylists: [], segments: [] },
              qualities: [],
              processingTimeSec: (Date.now() - startTime) / 1000,
              hardwareAccelUsed: "none",
              error: retryResult.error,
            };
          }
        } else {
          return {
            success: false,
            outputPaths: { masterPlaylist: "", qualityPlaylists: [], segments: [] },
            qualities: [],
            processingTimeSec: (Date.now() - startTime) / 1000,
            hardwareAccelUsed: hwAccel,
            error: result.error,
          };
        }
      }

      const qualityDir = path.join(config.outputDir, quality.name);
      qualityPlaylists.push({
        name: quality.name,
        path: path.join(qualityDir, "playlist.m3u8"),
      });

      const segments = fs.readdirSync(qualityDir).filter((f) => f.endsWith(".ts"));
      allSegments.push(...segments.map((s) => path.join(qualityDir, s)));
    }

    this.emit("progress", { percent: 100, stage: "completed" } as EncodingProgress);

    return {
      success: true,
      outputPaths: {
        masterPlaylist: path.join(config.outputDir, "master.m3u8"),
        qualityPlaylists,
        segments: allSegments,
      },
      qualities: applicableQualities.map((q) => q.name),
      processingTimeSec: (Date.now() - startTime) / 1000,
      hardwareAccelUsed: hwAccel,
    };
  }

  cancel(): void {
    this.cancelled = true;
    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
    }
  }
}

export const videoProcessor = new VideoProcessor();
