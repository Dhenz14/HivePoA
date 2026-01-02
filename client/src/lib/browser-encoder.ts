export interface EncodingProgress {
  stage: 'analyzing' | 'encoding' | 'finalizing';
  progress: number;
  timeRemaining?: number;
}

export interface EncodingResult {
  success: boolean;
  outputBlob?: Blob;
  outputArrayBuffer?: ArrayBuffer;
  duration?: number;
  error?: string;
}

export interface VideoEligibility {
  eligible: boolean;
  reason?: string;
  duration?: number;
}

type ProgressCallback = (progress: EncodingProgress) => void;

const MAX_DURATION_SECONDS = 120;
const TARGET_WIDTH = 854;
const TARGET_HEIGHT = 480;
const TARGET_FRAMERATE = 30;

const SUPPORTED_TYPES = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
];

export class BrowserEncoder {
  private worker: Worker | null = null;
  private abortController: AbortController | null = null;

  static isSupported(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }

    const hasVideoEncoder = 'VideoEncoder' in window;
    const hasVideoDecoder = 'VideoDecoder' in window;
    const hasVideoFrame = 'VideoFrame' in window;
    const hasOffscreenCanvas = 'OffscreenCanvas' in window;
    const hasImageBitmap = 'createImageBitmap' in window;

    return hasVideoEncoder && hasVideoDecoder && hasVideoFrame && hasOffscreenCanvas && hasImageBitmap;
  }

  static getSupportInfo(): {
    supported: boolean;
    missing: string[];
    browserInfo: string;
  } {
    const missing: string[] = [];

    if (typeof window === 'undefined') {
      return { supported: false, missing: ['browser environment'], browserInfo: 'Not in browser' };
    }

    if (!('VideoEncoder' in window)) missing.push('VideoEncoder');
    if (!('VideoDecoder' in window)) missing.push('VideoDecoder');
    if (!('VideoFrame' in window)) missing.push('VideoFrame');
    if (!('OffscreenCanvas' in window)) missing.push('OffscreenCanvas');
    if (!('createImageBitmap' in window)) missing.push('createImageBitmap');

    const browserInfo = navigator.userAgent;
    
    return {
      supported: missing.length === 0,
      missing,
      browserInfo,
    };
  }

  static async checkVideoEligibility(file: File): Promise<VideoEligibility> {
    if (!file) {
      return { eligible: false, reason: 'No file provided' };
    }

    if (!SUPPORTED_TYPES.includes(file.type) && !file.type.startsWith('video/')) {
      return { 
        eligible: false, 
        reason: `Unsupported file type: ${file.type || 'unknown'}. Supported formats: MP4, WebM, MOV, AVI, MKV` 
      };
    }

    const maxSizeBytes = 500 * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      return {
        eligible: false,
        reason: `File too large: ${(file.size / (1024 * 1024)).toFixed(1)}MB. Maximum size: 500MB`,
      };
    }

    try {
      const duration = await BrowserEncoder.getVideoDuration(file);
      
      if (duration > MAX_DURATION_SECONDS) {
        return {
          eligible: false,
          reason: `Video too long: ${Math.round(duration)}s. Browser encoding is limited to ${MAX_DURATION_SECONDS / 60} minutes. Use desktop agent for longer videos.`,
          duration,
        };
      }

      if (duration < 1) {
        return {
          eligible: false,
          reason: 'Video too short (less than 1 second)',
          duration,
        };
      }

      return { eligible: true, duration };
    } catch (err) {
      return {
        eligible: false,
        reason: err instanceof Error ? err.message : 'Failed to analyze video',
      };
    }
  }

  private static getVideoDuration(file: File): Promise<number> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;

      const objectUrl = URL.createObjectURL(file);

      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
        video.remove();
      };

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout loading video metadata'));
      }, 30000);

      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        const duration = video.duration;
        cleanup();

        if (isNaN(duration) || !isFinite(duration)) {
          reject(new Error('Could not determine video duration'));
        } else {
          resolve(duration);
        }
      };

      video.onerror = () => {
        clearTimeout(timeout);
        cleanup();
        reject(new Error('Failed to load video metadata. The file may be corrupted or in an unsupported format.'));
      };

      video.src = objectUrl;
      video.load();
    });
  }

  static getUnsupportedBrowserMessage(): string {
    const info = BrowserEncoder.getSupportInfo();
    
    if (info.supported) {
      return '';
    }

    const isChrome = /Chrome/.test(navigator.userAgent) && !/Edge/.test(navigator.userAgent);
    const isFirefox = /Firefox/.test(navigator.userAgent);
    const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);
    const isEdge = /Edg/.test(navigator.userAgent);

    let browserAdvice = '';
    
    if (isFirefox) {
      browserAdvice = 'Firefox has limited WebCodecs support. Please use Chrome 94+ or Edge 94+ for browser encoding.';
    } else if (isSafari) {
      browserAdvice = 'Safari has limited WebCodecs support. Please use Chrome 94+ or Edge 94+ for browser encoding.';
    } else if (isChrome || isEdge) {
      browserAdvice = 'Your browser version may be outdated. Please update to the latest version.';
    } else {
      browserAdvice = 'Please use Chrome 94+, Edge 94+, or a Chromium-based browser for browser encoding.';
    }

    return `Browser encoding not supported. Missing features: ${info.missing.join(', ')}. ${browserAdvice}`;
  }

  async encode(file: File, onProgress?: ProgressCallback): Promise<EncodingResult> {
    if (!BrowserEncoder.isSupported()) {
      return {
        success: false,
        error: BrowserEncoder.getUnsupportedBrowserMessage(),
      };
    }

    const eligibility = await BrowserEncoder.checkVideoEligibility(file);
    if (!eligibility.eligible) {
      return {
        success: false,
        error: eligibility.reason,
        duration: eligibility.duration,
      };
    }

    this.abortController = new AbortController();

    try {
      onProgress?.({ stage: 'analyzing', progress: 0 });
      
      const { frames, duration } = await this.extractFrames(file, onProgress);
      
      if (this.abortController.signal.aborted) {
        frames.forEach(f => f.close());
        return { success: false, error: 'Encoding cancelled' };
      }

      const workerCode = this.getWorkerCode();
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      
      this.worker = new Worker(workerUrl);
      URL.revokeObjectURL(workerUrl);

      return new Promise<EncodingResult>((resolve) => {
        if (!this.worker) {
          frames.forEach(f => f.close());
          resolve({ success: false, error: 'Failed to create worker' });
          return;
        }

        this.worker.onmessage = (event: MessageEvent) => {
          const { type } = event.data;

          switch (type) {
            case 'progress':
              onProgress?.({
                stage: event.data.stage,
                progress: event.data.progress,
                timeRemaining: event.data.timeRemaining,
              });
              break;

            case 'complete': {
              const outputBuffer = event.data.outputBuffer as ArrayBuffer;
              const outputBlob = new Blob([outputBuffer], { type: 'video/h264' });
              
              this.cleanup();
              resolve({
                success: true,
                outputBlob,
                outputArrayBuffer: outputBuffer,
                duration: event.data.duration,
              });
              break;
            }

            case 'error':
              this.cleanup();
              resolve({
                success: false,
                error: event.data.error,
              });
              break;
          }
        };

        this.worker.onerror = (err) => {
          this.cleanup();
          resolve({
            success: false,
            error: `Worker error: ${err.message || 'Unknown error'}`,
          });
        };

        this.worker.postMessage(
          {
            type: 'start',
            frames,
            frameRate: TARGET_FRAMERATE,
            duration,
          },
          frames
        );
      });
    } catch (err) {
      this.cleanup();
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Encoding failed',
      };
    }
  }

  private async extractFrames(
    file: File,
    onProgress?: ProgressCallback
  ): Promise<{ frames: ImageBitmap[]; duration: number }> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';

      const objectUrl = URL.createObjectURL(file);
      video.src = objectUrl;

      const cleanup = () => {
        URL.revokeObjectURL(objectUrl);
        video.remove();
      };

      video.onloadedmetadata = async () => {
        const duration = video.duration;
        const totalFrames = Math.ceil(duration * TARGET_FRAMERATE);
        const frames: ImageBitmap[] = [];

        const canvas = document.createElement('canvas');
        canvas.width = TARGET_WIDTH;
        canvas.height = TARGET_HEIGHT;
        const ctx = canvas.getContext('2d');

        if (!ctx) {
          cleanup();
          reject(new Error('Could not create canvas context'));
          return;
        }

        try {
          for (let i = 0; i < totalFrames; i++) {
            if (this.abortController?.signal.aborted) {
              frames.forEach(f => f.close());
              cleanup();
              reject(new Error('Cancelled'));
              return;
            }

            const targetTime = i / TARGET_FRAMERATE;
            video.currentTime = targetTime;

            await new Promise<void>((res, rej) => {
              const onSeeked = () => {
                video.removeEventListener('seeked', onSeeked);
                res();
              };
              const onError = () => {
                video.removeEventListener('error', onError);
                rej(new Error('Video seek failed'));
              };
              video.addEventListener('seeked', onSeeked);
              video.addEventListener('error', onError);
              
              if (Math.abs(video.currentTime - targetTime) < 0.01) {
                video.removeEventListener('seeked', onSeeked);
                video.removeEventListener('error', onError);
                res();
              }
            });

            ctx.drawImage(video, 0, 0, TARGET_WIDTH, TARGET_HEIGHT);
            
            const bitmap = await createImageBitmap(canvas);
            frames.push(bitmap);

            if (i % 5 === 0) {
              const progress = Math.round((i / totalFrames) * 50);
              onProgress?.({ stage: 'analyzing', progress });
            }
          }

          cleanup();
          resolve({ frames, duration });
        } catch (err) {
          frames.forEach(f => f.close());
          cleanup();
          reject(err);
        }
      };

      video.onerror = () => {
        cleanup();
        reject(new Error('Failed to load video file'));
      };

      video.load();
    });
  }

  cancel(): void {
    this.abortController?.abort();
    
    if (this.worker) {
      this.worker.postMessage({ type: 'cancel' });
      setTimeout(() => this.cleanup(), 100);
    }
  }

  private cleanup(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.abortController = null;
  }

  private getWorkerCode(): string {
    return `
const TARGET_WIDTH = 854;
const TARGET_HEIGHT = 480;
const TARGET_BITRATE = 1500000;

let cancelled = false;
let videoEncoder = null;

function sendMessage(msg) {
  self.postMessage(msg);
}

function sendProgress(stage, progress, timeRemaining) {
  sendMessage({ type: 'progress', stage, progress, timeRemaining });
}

function sendError(error) {
  sendMessage({ type: 'error', error });
}

function sendComplete(outputBuffer, duration) {
  self.postMessage({ type: 'complete', outputBuffer, duration }, [outputBuffer]);
}

async function encodeFrames(frames, frameRate, duration) {
  cancelled = false;
  
  const encodedChunks = [];
  let encodedFrameCount = 0;
  const startTime = Date.now();
  const totalFrames = frames.length;
  
  sendProgress('encoding', 50);
  
  try {
    videoEncoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        encodedChunks.push({
          data,
          timestamp: chunk.timestamp,
          type: chunk.type,
        });
        encodedFrameCount++;
        
        const progress = Math.round((encodedFrameCount / totalFrames) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = encodedFrameCount / elapsed;
        const remaining = rate > 0 ? Math.round((totalFrames - encodedFrameCount) / rate) : undefined;
        
        sendProgress('encoding', 50 + Math.round(progress * 0.4), remaining);
      },
      error: (err) => {
        sendError('Video encoding error: ' + err.message);
      },
    });

    const encoderConfig = {
      codec: 'avc1.42001f',
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      bitrate: TARGET_BITRATE,
      framerate: frameRate,
      latencyMode: 'quality',
    };
    
    const support = await VideoEncoder.isConfigSupported(encoderConfig);
    if (!support.supported) {
      const fallbackConfig = {
        codec: 'avc1.42001f',
        width: TARGET_WIDTH,
        height: TARGET_HEIGHT,
        bitrate: TARGET_BITRATE,
        framerate: frameRate,
      };
      
      const fallbackSupport = await VideoEncoder.isConfigSupported(fallbackConfig);
      if (!fallbackSupport.supported) {
        throw new Error('H.264 encoding not supported by this browser');
      }
      videoEncoder.configure(fallbackConfig);
    } else {
      videoEncoder.configure(encoderConfig);
    }
    
    const canvas = new OffscreenCanvas(TARGET_WIDTH, TARGET_HEIGHT);
    const canvasCtx = canvas.getContext('2d');
    
    if (!canvasCtx) {
      throw new Error('Could not create OffscreenCanvas context');
    }
    
    for (let i = 0; i < frames.length && !cancelled; i++) {
      const timestamp = (i / frameRate) * 1000000;
      const frameDuration = (1 / frameRate) * 1000000;
      
      canvasCtx.drawImage(frames[i], 0, 0, TARGET_WIDTH, TARGET_HEIGHT);
      
      const videoFrame = new VideoFrame(canvas, {
        timestamp,
        duration: frameDuration,
      });
      
      const keyFrame = i === 0 || i % 60 === 0;
      videoEncoder.encode(videoFrame, { keyFrame });
      videoFrame.close();
      
      frames[i].close();
    }
    
    await videoEncoder.flush();
    
    if (cancelled) {
      sendError('Encoding cancelled');
      return;
    }
    
    sendProgress('finalizing', 95);
    
    let totalSize = 0;
    for (const chunk of encodedChunks) {
      totalSize += chunk.data.byteLength;
    }
    
    const output = new Uint8Array(totalSize);
    let offset = 0;
    
    for (const chunk of encodedChunks) {
      output.set(chunk.data, offset);
      offset += chunk.data.byteLength;
    }
    
    sendProgress('finalizing', 100);
    sendComplete(output.buffer, duration);
    
  } catch (err) {
    for (const frame of frames) {
      try { frame.close(); } catch {}
    }
    sendError(err instanceof Error ? err.message : 'Encoding failed');
  } finally {
    if (videoEncoder) {
      try { videoEncoder.close(); } catch {}
      videoEncoder = null;
    }
  }
}

self.onmessage = async (event) => {
  const { type } = event.data;
  
  switch (type) {
    case 'start': {
      const { frames, frameRate, duration } = event.data;
      await encodeFrames(frames, frameRate, duration);
      break;
    }
      
    case 'cancel':
      cancelled = true;
      if (videoEncoder) {
        try { videoEncoder.close(); } catch {}
        videoEncoder = null;
      }
      break;
  }
};
`;
  }
}

export default BrowserEncoder;
