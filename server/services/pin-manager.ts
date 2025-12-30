/**
 * Pin Manager Service
 * Handles IPFS pinning with progress tracking
 */

export interface PinJob {
  id: string;
  cid: string;
  title: string;
  author: string;
  status: "queued" | "fetching" | "pinning" | "complete" | "error";
  progress: number; // 0-100
  bytesReceived: number;
  totalBytes: number;
  startedAt: number;
  estimatedTimeRemaining: number | null;
  error?: string;
}

class PinManager {
  private jobs: Map<string, PinJob> = new Map();
  private listeners: Map<string, ((job: PinJob) => void)[]> = new Map();

  createJob(cid: string, title: string, author: string): PinJob {
    const id = `pin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const job: PinJob = {
      id,
      cid,
      title,
      author,
      status: "queued",
      progress: 0,
      bytesReceived: 0,
      totalBytes: 0,
      startedAt: Date.now(),
      estimatedTimeRemaining: null,
    };
    this.jobs.set(id, job);
    return job;
  }

  getJob(id: string): PinJob | undefined {
    return this.jobs.get(id);
  }

  getAllJobs(): PinJob[] {
    return Array.from(this.jobs.values());
  }

  getActiveJobs(): PinJob[] {
    return Array.from(this.jobs.values()).filter(
      j => j.status === "queued" || j.status === "fetching" || j.status === "pinning"
    );
  }

  updateJob(id: string, updates: Partial<PinJob>): void {
    const job = this.jobs.get(id);
    if (!job) return;

    Object.assign(job, updates);

    if (job.bytesReceived > 0 && job.totalBytes > 0) {
      job.progress = Math.min(99, Math.round((job.bytesReceived / job.totalBytes) * 100));
      
      const elapsed = Date.now() - job.startedAt;
      const bytesPerMs = job.bytesReceived / elapsed;
      const remainingBytes = job.totalBytes - job.bytesReceived;
      job.estimatedTimeRemaining = bytesPerMs > 0 ? Math.round(remainingBytes / bytesPerMs / 1000) : null;
    }

    const jobListeners = this.listeners.get(id) || [];
    for (const listener of jobListeners) {
      listener(job);
    }
  }

  completeJob(id: string): void {
    this.updateJob(id, { 
      status: "complete", 
      progress: 100,
      estimatedTimeRemaining: 0 
    });
  }

  failJob(id: string, error: string): void {
    this.updateJob(id, { 
      status: "error", 
      error 
    });
  }

  subscribe(jobId: string, callback: (job: PinJob) => void): () => void {
    const listeners = this.listeners.get(jobId) || [];
    listeners.push(callback);
    this.listeners.set(jobId, listeners);

    return () => {
      const current = this.listeners.get(jobId) || [];
      this.listeners.set(jobId, current.filter(l => l !== callback));
    };
  }

  cleanupOldJobs(): void {
    const oneHourAgo = Date.now() - 3600000;
    const entries = Array.from(this.jobs.entries());
    for (const [id, job] of entries) {
      if ((job.status === "complete" || job.status === "error") && job.startedAt < oneHourAgo) {
        this.jobs.delete(id);
        this.listeners.delete(id);
      }
    }
  }

  async pinWithProgress(
    jobId: string,
    ipfsApiUrl: string = "http://127.0.0.1:5001"
  ): Promise<PinJob> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }
    
    const cid = job.cid;
    
    try {
      this.updateJob(job.id, { status: "fetching" });

      const statResponse = await fetch(`${ipfsApiUrl}/api/v0/object/stat?arg=${cid}`, {
        method: "POST",
      });
      
      if (statResponse.ok) {
        const stat = await statResponse.json();
        this.updateJob(job.id, { totalBytes: stat.CumulativeSize || 0 });
      }

      this.updateJob(job.id, { status: "pinning" });

      const pinResponse = await fetch(`${ipfsApiUrl}/api/v0/pin/add?arg=${cid}&progress=true`, {
        method: "POST",
      });

      if (!pinResponse.ok) {
        throw new Error(`Pin failed: ${pinResponse.statusText}`);
      }

      if (pinResponse.body) {
        const reader = pinResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.Progress !== undefined && data.Progress >= 0) {
                this.updateJob(job.id, { 
                  bytesReceived: data.Progress,
                  progress: job.totalBytes > 0 
                    ? Math.min(99, Math.round((data.Progress / job.totalBytes) * 100))
                    : Math.min(99, data.Progress > 0 ? 50 : 0)
                });
              }
            } catch {
            }
          }
        }
      }

      this.completeJob(job.id);
      return this.jobs.get(job.id)!;

    } catch (error: any) {
      this.failJob(job.id, error.message);
      throw error;
    }
  }
}

export const pinManager = new PinManager();
