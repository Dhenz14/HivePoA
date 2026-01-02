const ctx: Worker = self as unknown as Worker;

interface StartMessage {
  type: 'start';
  frames: ImageBitmap[];
  frameRate: number;
  duration: number;
}

interface CancelMessage {
  type: 'cancel';
}

type WorkerMessage = StartMessage | CancelMessage;

interface ProgressMessage {
  type: 'progress';
  stage: 'encoding' | 'finalizing';
  progress: number;
  timeRemaining?: number;
}

interface CompleteMessage {
  type: 'complete';
  outputBuffer: ArrayBuffer;
  duration: number;
}

interface ErrorMessage {
  type: 'error';
  error: string;
}

type OutgoingMessage = ProgressMessage | CompleteMessage | ErrorMessage;

const TARGET_WIDTH = 854;
const TARGET_HEIGHT = 480;
const TARGET_BITRATE = 1_500_000;

let cancelled = false;
let videoEncoder: VideoEncoder | null = null;

function sendMessage(msg: OutgoingMessage): void {
  ctx.postMessage(msg);
}

function sendProgress(stage: 'encoding' | 'finalizing', progress: number, timeRemaining?: number): void {
  sendMessage({ type: 'progress', stage, progress, timeRemaining });
}

function sendError(error: string): void {
  sendMessage({ type: 'error', error });
}

function sendComplete(outputBuffer: ArrayBuffer, duration: number): void {
  ctx.postMessage({ type: 'complete', outputBuffer, duration }, [outputBuffer]);
}

async function encodeFrames(frames: ImageBitmap[], frameRate: number, duration: number): Promise<void> {
  cancelled = false;
  
  const encodedChunks: { data: Uint8Array; timestamp: number; type: string }[] = [];
  let encodedFrameCount = 0;
  const startTime = Date.now();
  const totalFrames = frames.length;
  
  sendProgress('encoding', 0);
  
  try {
    videoEncoder = new VideoEncoder({
      output: (chunk: EncodedVideoChunk) => {
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
        
        sendProgress('encoding', Math.round(progress * 0.9), remaining);
      },
      error: (err: DOMException) => {
        sendError(`Video encoding error: ${err.message}`);
      },
    });

    const encoderConfig: VideoEncoderConfig = {
      codec: 'avc1.42001f',
      width: TARGET_WIDTH,
      height: TARGET_HEIGHT,
      bitrate: TARGET_BITRATE,
      framerate: frameRate,
      latencyMode: 'quality',
    };
    
    const support = await VideoEncoder.isConfigSupported(encoderConfig);
    if (!support.supported) {
      const fallbackConfig: VideoEncoderConfig = {
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
      const timestamp = (i / frameRate) * 1_000_000;
      const frameDuration = (1 / frameRate) * 1_000_000;
      
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

ctx.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const { type } = event.data;
  
  switch (type) {
    case 'start': {
      const msg = event.data as StartMessage;
      await encodeFrames(msg.frames, msg.frameRate, msg.duration);
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

export {};
