# Hybrid Encoding System Blueprint

## Executive Summary

This document provides a comprehensive technical specification for SPK Network 2.0's hybrid encoding system. After deep analysis of the 3speakencoder codebase, we recommend a **selective repurposing strategy**: adapt proven FFmpeg/HLS modules while rebuilding queue, orchestration, and integration layers for our PostgreSQL/Drizzle stack.

## Component Analysis: Repurpose vs Rebuild

### 1. VideoProcessor.ts - REPURPOSE (90%)

**3speakencoder Implementation:**
- FFmpeg command builder with hardware acceleration cascade (NVENC → VAAPI → QSV → libx264)
- Multi-quality encoding (1080p/720p/480p) with adaptive bitrate
- Codec detection and capability probing
- Progress parsing from FFmpeg stderr

**Decision: REPURPOSE**
- The FFmpeg command generation logic is battle-tested and complex
- Hardware acceleration fallback cascade is non-trivial to implement correctly
- Codec presets align with our H.264 High Profile @ Level 4.1 requirements

**Adaptations Needed:**
- Convert to TypeScript with strict types
- Inject configuration via our EncodingService
- Replace file I/O with streaming for IPFS upload
- Add progress event emitter for WebSocket updates

```typescript
// Repurposed structure
interface VideoProcessorConfig {
  inputPath: string;
  outputDir: string;
  qualities: QualityPreset[];
  hwAccel?: 'nvenc' | 'vaapi' | 'qsv' | 'none';
  onProgress?: (percent: number, stage: string) => void;
}

class VideoProcessor {
  private detectHardwareAcceleration(): Promise<HWAccelType>;
  private buildFFmpegCommand(quality: QualityPreset): string[];
  async encode(config: VideoProcessorConfig): Promise<EncodingResult>;
}
```

### 2. HLSProcessor.ts - REPURPOSE (85%)

**3speakencoder Implementation:**
- Master playlist generation with variant streams
- Segment naming and organization
- Bandwidth and resolution metadata

**Decision: REPURPOSE**
- HLS manifest format is standardized; their implementation is correct
- Segment handling logic works well

**Adaptations Needed:**
- Update paths for IPFS-compatible relative URLs
- Add CID-based segment references for decentralized playback

### 3. JobQueue.ts - REBUILD (100%)

**3speakencoder Implementation:**
- In-memory queue with simple FIFO processing
- No persistence across restarts
- Single-encoder design

**Decision: REBUILD COMPLETELY**
- We need PostgreSQL persistence via Drizzle ORM
- Multi-encoder coordination with lease-based locking
- Priority queue (self → browser → community)
- Retry logic with exponential backoff

**New Implementation:**
```typescript
// Database-backed queue with leasing
interface JobScheduler {
  claimJob(encoderId: string, encoderType: string): Promise<EncodingJob | null>;
  releaseJob(jobId: string, reason: string): Promise<void>;
  completeJob(jobId: string, result: EncodingResult): Promise<void>;
  failJob(jobId: string, error: string, retryable: boolean): Promise<void>;
  getQueueDepth(): Promise<QueueStats>;
}
```

### 4. JobProcessor.ts - REBUILD (100%)

**3speakencoder Implementation:**
- Orchestrates download → encode → upload pipeline
- Handles job lifecycle transitions
- Error handling and cleanup

**Decision: REBUILD COMPLETELY**
- Different architecture: distributed workers vs monolithic
- Need to support three encoder types (desktop, browser, community)
- Integration with our webhook system

### 5. DirectApiService.ts - USE AS REFERENCE (50%)

**3speakencoder Implementation:**
- REST API for job submission
- Status polling endpoints
- Health checks

**Decision: USE AS REFERENCE**
- API design patterns are useful
- But we need Hive Keychain auth, Zod validation
- Different endpoint structure for our stack

**Our API Design:**
```
POST /api/encoding/jobs          - Submit job (Zod validated)
GET  /api/encoding/jobs/:id      - Get job status
POST /api/encoding/webhook       - Encoder callbacks (signed)
POST /api/encoding/agent/claim   - Desktop agent claims job
POST /api/encoding/agent/progress - Progress updates
POST /api/encoding/agent/complete - Job completion
```

### 6. IPFSService.ts - REBUILD (100%)

**3speakencoder Implementation:**
- Direct IPFS HTTP API calls
- File-based uploads

**Decision: REBUILD COMPLETELY**
- We have existing ipfs-manager and ipfs-client abstractions
- Need streaming upload for large files
- Integration with our gateway and pinning infrastructure

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        SPK Network 2.0 Server                        │
├─────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   Encoding   │  │     Job      │  │      Webhook            │  │
│  │  Orchestrator│──│   Scheduler  │──│      Dispatcher         │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│         │                 │                      │                  │
│         ▼                 ▼                      ▼                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    PostgreSQL (Drizzle ORM)                  │   │
│  │  encoding_jobs | encoder_nodes | encoding_profiles           │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
         │                    │                         │
         ▼                    ▼                         ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐
│  Desktop Agent  │  │ Browser Worker  │  │   Community Encoder     │
│     (Tauri)     │  │   (WebCodecs)   │  │      (External)         │
├─────────────────┤  ├─────────────────┤  ├─────────────────────────┤
│ - FFmpeg        │  │ - WebCodecs API │  │ - FFmpeg                │
│ - GPU Accel     │  │ - 480p only     │  │ - HBD payments          │
│ - Local IPFS    │  │ - Short videos  │  │ - Signed jobs           │
│ - Free encoding │  │ - <2min limit   │  │ - Reputation system     │
└─────────────────┘  └─────────────────┘  └─────────────────────────┘
```

## Encoding Priority & Fallback Strategy

```
1. DESKTOP AGENT (Priority: Highest)
   ├── Check: User has desktop agent running?
   ├── Check: Agent available (not busy)?
   ├── Benefit: Free, fast, GPU-accelerated
   └── Output: Full quality (1080p/720p/480p)

2. BROWSER WEBCODECS (Priority: Medium)
   ├── Check: Video is "short" (<2 minutes)?
   ├── Check: Browser supports WebCodecs?
   ├── Benefit: No external dependency
   └── Output: Single quality (480p only)

3. COMMUNITY ENCODER (Priority: Low)
   ├── Check: User willing to pay HBD?
   ├── Select: Best available encoder (rating, price)
   ├── Benefit: Reliable, always available
   └── Output: Full quality (1080p/720p/480p)
```

## Database Schema Extensions

```typescript
// Enhanced encoding_jobs table
export const encodingJobs = pgTable("encoding_jobs", {
  // ... existing fields ...
  
  // Job assignment
  assignedAt: timestamp("assigned_at"),
  assignedEncoderId: varchar("assigned_encoder_id"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  
  // Retry logic
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  lastError: text("last_error"),
  nextRetryAt: timestamp("next_retry_at"),
  
  // Progress tracking
  currentStage: text("current_stage"), // downloading, encoding, uploading
  stageProgress: integer("stage_progress").default(0),
  
  // Security
  jobSignature: text("job_signature"), // For community encoders
  webhookSecret: text("webhook_secret"),
});

// Encoder capabilities
export const encoderCapabilities = pgTable("encoder_capabilities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  encoderNodeId: varchar("encoder_node_id").references(() => encoderNodes.id),
  codec: text("codec").notNull(), // h264, h265, vp9, av1
  maxResolution: text("max_resolution").notNull(), // 1080p, 4k
  hwAccelType: text("hw_accel_type"), // nvenc, vaapi, qsv
  estimatedSpeed: real("estimated_speed"), // x realtime
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

## Desktop Agent API Contract

The desktop agent exposes a local HTTP API for the web app to communicate with:

```typescript
// Desktop Agent API (runs on localhost:3002)

// Health check - web app polls this to detect agent
GET /health
Response: {
  status: "ready" | "busy" | "offline",
  version: "1.0.0",
  hwAccel: "nvenc" | "vaapi" | "qsv" | "none",
  jobsInProgress: number,
  ipfsConnected: boolean
}

// Claim a job from the queue
POST /claim
Headers: { "X-Hive-User": "username" }
Response: {
  jobId: string,
  inputCid: string,
  owner: string,
  permlink: string,
  isShort: boolean,
  qualities: ["1080p", "720p", "480p"]
}

// Report progress
POST /progress
Body: {
  jobId: string,
  stage: "downloading" | "encoding" | "uploading",
  progress: number, // 0-100
  details?: string
}

// Complete job
POST /complete
Body: {
  jobId: string,
  outputCid: string,
  manifestPath: string,
  qualities: string[],
  processingTimeSec: number,
  outputSizeBytes: number
}

// Fail job
POST /fail
Body: {
  jobId: string,
  error: string,
  retryable: boolean
}
```

## Server API Endpoints

```typescript
// Job Management
POST   /api/encoding/jobs              // Submit new job
GET    /api/encoding/jobs              // List jobs (with filters)
GET    /api/encoding/jobs/:id          // Get job details
DELETE /api/encoding/jobs/:id          // Cancel job

// Encoder Management  
GET    /api/encoding/encoders          // List available encoders
POST   /api/encoding/encoders/register // Register encoder
POST   /api/encoding/encoders/heartbeat // Encoder heartbeat

// Desktop Agent Bridge
POST   /api/encoding/agent/claim       // Agent claims next job
POST   /api/encoding/agent/progress    // Report progress
POST   /api/encoding/agent/complete    // Mark job complete
POST   /api/encoding/agent/fail        // Report failure

// Community Encoder
POST   /api/encoding/community/bid     // Submit bid for job
POST   /api/encoding/community/accept  // Accept bid
POST   /api/encoding/webhook           // Webhook callback (signed)

// User Settings
GET    /api/encoding/settings/:user    // Get user preferences
PATCH  /api/encoding/settings/:user    // Update preferences
POST   /api/encoding/check-agent       // Check desktop agent status
```

## Implementation Plan

### Phase 1: Core Infrastructure (Current - Complete)
- [x] Database schema for encoding jobs
- [x] Basic encoding service
- [x] API routes with Zod validation
- [x] Frontend encoding dashboard

### Phase 2: Job Scheduler & Queue (Next)
- [ ] Lease-based job assignment
- [ ] Retry logic with exponential backoff
- [ ] Priority queue (self → browser → community)
- [ ] Job expiration and cleanup

### Phase 3: Desktop Agent Worker
- [ ] Repurpose VideoProcessor from 3speakencoder
- [ ] FFmpeg integration with hw acceleration detection
- [ ] HLS segment generation
- [ ] IPFS upload integration
- [ ] Progress reporting to server

### Phase 4: Browser WebCodecs Worker
- [ ] WebCodecs API integration
- [ ] 480p single-quality encoding
- [ ] Short video detection (<2 min)
- [ ] Client-side progress UI

### Phase 5: Community Encoder Marketplace
- [ ] Encoder registration and verification
- [ ] Bidding system for jobs
- [ ] HBD escrow and payment
- [ ] Reputation scoring

### Phase 6: Security & Polish
- [ ] Webhook signature verification
- [ ] Rate limiting
- [ ] Audit logging
- [ ] Monitoring and alerting

## Security Considerations

1. **Job Submission**: Require Hive Keychain signature
2. **Webhook Verification**: HMAC-SHA256 signatures
3. **Encoder Registration**: Verify Hive account ownership
4. **Community Payments**: Escrow HBD until job verified
5. **Rate Limiting**: Prevent abuse of encoding resources

## Quality Presets

| Quality | Resolution | Video Bitrate | Audio | Profile | Level |
|---------|------------|---------------|-------|---------|-------|
| 1080p   | 1920x1080  | 4500 kbps     | 128k  | High    | 4.1   |
| 720p    | 1280x720   | 2500 kbps     | 128k  | High    | 4.0   |
| 480p    | 854x480    | 1000 kbps     | 128k  | Main    | 3.1   |

## FFmpeg Command Template (Repurposed)

```bash
ffmpeg -i input.mp4 \
  -c:v libx264 -profile:v high -level:v 4.1 \
  -preset medium -crf 23 \
  -c:a aac -b:a 128k \
  -f hls -hls_time 4 -hls_playlist_type vod \
  -hls_segment_filename "segment_%03d.ts" \
  -master_pl_name master.m3u8 \
  output.m3u8
```

With hardware acceleration:
```bash
# NVIDIA NVENC
ffmpeg -hwaccel cuda -i input.mp4 -c:v h264_nvenc ...

# Intel QSV
ffmpeg -hwaccel qsv -i input.mp4 -c:v h264_qsv ...

# AMD/Intel VAAPI
ffmpeg -hwaccel vaapi -i input.mp4 -c:v h264_vaapi ...
```

## Conclusion

The hybrid encoding system combines the best of both approaches:
- **Repurpose** proven FFmpeg/HLS logic from 3speakencoder
- **Rebuild** queue, orchestration, and integration for our stack
- **Build new** browser WebCodecs and community marketplace features

This approach minimizes risk while ensuring the system integrates seamlessly with SPK Network 2.0's existing infrastructure.
