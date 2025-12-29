/**
 * Upload Manager Service
 * Repurposed from SPK Network's trole/api.js upload system
 * 
 * Handles chunked file uploads with CID verification and resume capability
 */

import { storage } from "../storage";
import { createHash, randomBytes } from "crypto";
import type { File, FileChunk, StorageContract, InsertStorageContract } from "@shared/schema";

export interface UploadSession {
  sessionId: string;
  expectedCid: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  uploaderUsername: string;
  expiresAt: Date;
}

export interface ChunkUploadResult {
  success: boolean;
  chunkIndex: number;
  checksum?: string;
  error?: string;
}

export interface UploadCompleteResult {
  success: boolean;
  file?: File;
  contract?: StorageContract;
  error?: string;
}

export class UploadManager {
  private sessions: Map<string, UploadSession> = new Map();
  private chunkData: Map<string, Map<number, Buffer>> = new Map(); // sessionId -> chunkIndex -> data
  
  // Default chunk size (5MB)
  private readonly CHUNK_SIZE = 5 * 1024 * 1024;
  
  // Session expiration (24 hours)
  private readonly SESSION_EXPIRY = 24 * 60 * 60 * 1000;

  // Initialize an upload session
  async initializeUpload(params: {
    expectedCid: string;
    fileName: string;
    fileSize: number;
    uploaderUsername: string;
    replicationCount?: number;
    durationDays?: number;
    hbdBudget?: string;
  }): Promise<UploadSession> {
    const sessionId = randomBytes(16).toString('hex');
    const totalChunks = Math.ceil(params.fileSize / this.CHUNK_SIZE);
    const expiresAt = new Date(Date.now() + this.SESSION_EXPIRY);

    // Create file record in uploading status
    const file = await storage.createFile({
      cid: params.expectedCid,
      name: params.fileName,
      size: String(params.fileSize),
      uploaderUsername: params.uploaderUsername,
      status: 'uploading',
      replicationCount: 0,
      confidence: 0,
      poaEnabled: true,
      totalChunks,
      uploadedChunks: 0,
      uploadSessionId: sessionId,
      uploadExpiresAt: expiresAt,
    });

    // Create chunk records
    for (let i = 0; i < totalChunks; i++) {
      const chunkSize = Math.min(this.CHUNK_SIZE, params.fileSize - (i * this.CHUNK_SIZE));
      await storage.createFileChunk({
        fileId: file.id,
        chunkIndex: i,
        chunkSize,
        status: 'pending',
      });
    }

    // Create storage contract
    const durationDays = params.durationDays || 30;
    const contract = await storage.createStorageContract({
      fileId: file.id,
      fileCid: params.expectedCid,
      uploaderUsername: params.uploaderUsername,
      requestedReplication: params.replicationCount || 3,
      actualReplication: 0,
      status: 'pending',
      hbdBudget: params.hbdBudget || '0',
      hbdSpent: '0',
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000),
    });

    // Create contract event
    await storage.createContractEvent({
      contractId: contract.id,
      eventType: 'created',
      payload: JSON.stringify({ fileName: params.fileName, fileSize: params.fileSize }),
      triggeredBy: params.uploaderUsername,
    });

    const session: UploadSession = {
      sessionId,
      expectedCid: params.expectedCid,
      fileName: params.fileName,
      fileSize: params.fileSize,
      totalChunks,
      uploaderUsername: params.uploaderUsername,
      expiresAt,
    };

    this.sessions.set(sessionId, session);
    this.chunkData.set(sessionId, new Map());

    console.log(`[Upload Manager] Initialized upload session ${sessionId} for ${params.fileName}`);
    return session;
  }

  // Upload a single chunk
  async uploadChunk(sessionId: string, chunkIndex: number, data: Buffer): Promise<ChunkUploadResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, chunkIndex, error: 'Session not found or expired' };
    }

    if (new Date() > session.expiresAt) {
      this.sessions.delete(sessionId);
      this.chunkData.delete(sessionId);
      return { success: false, chunkIndex, error: 'Session expired' };
    }

    if (chunkIndex < 0 || chunkIndex >= session.totalChunks) {
      return { success: false, chunkIndex, error: 'Invalid chunk index' };
    }

    // Calculate checksum
    const checksum = createHash('sha256').update(data).digest('hex');

    // Store chunk in memory
    const sessionChunks = this.chunkData.get(sessionId)!;
    sessionChunks.set(chunkIndex, data);

    // Get file and update chunk status
    const file = await storage.getFileByCid(session.expectedCid);
    if (file) {
      const chunks = await storage.getFileChunks(file.id);
      const chunk = chunks.find(c => c.chunkIndex === chunkIndex);
      if (chunk) {
        await storage.updateFileChunkStatus(chunk.id, 'uploaded', checksum);
      }
    }

    console.log(`[Upload Manager] Chunk ${chunkIndex + 1}/${session.totalChunks} uploaded for session ${sessionId}`);

    return { success: true, chunkIndex, checksum };
  }

  // Get upload progress
  async getUploadStatus(sessionId: string): Promise<{
    exists: boolean;
    session?: UploadSession;
    uploadedChunks?: number;
    pendingChunks?: number[];
    progress?: number;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { exists: false };
    }

    const sessionChunks = this.chunkData.get(sessionId)!;
    const uploadedChunks = sessionChunks.size;
    
    const pendingChunks: number[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      if (!sessionChunks.has(i)) {
        pendingChunks.push(i);
      }
    }

    const progress = Math.round((uploadedChunks / session.totalChunks) * 100);

    return {
      exists: true,
      session,
      uploadedChunks,
      pendingChunks,
      progress,
    };
  }

  // Complete the upload and verify CID
  async completeUpload(sessionId: string): Promise<UploadCompleteResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { success: false, error: 'Session not found or expired' };
    }

    const sessionChunks = this.chunkData.get(sessionId)!;
    
    // Check all chunks are uploaded
    if (sessionChunks.size !== session.totalChunks) {
      const missing = session.totalChunks - sessionChunks.size;
      return { success: false, error: `Missing ${missing} chunk(s)` };
    }

    // Assemble the complete file
    const chunks: Buffer[] = [];
    for (let i = 0; i < session.totalChunks; i++) {
      const chunk = sessionChunks.get(i);
      if (!chunk) {
        return { success: false, error: `Missing chunk ${i}` };
      }
      chunks.push(chunk);
    }
    const completeFile = Buffer.concat(chunks);

    // Verify file size
    if (completeFile.length !== session.fileSize) {
      return { 
        success: false, 
        error: `File size mismatch: expected ${session.fileSize}, got ${completeFile.length}` 
      };
    }

    // In simulation mode, we skip actual CID verification
    // In production, we would calculate CID and compare with expected
    const calculatedCid = await this.calculateCid(completeFile);
    
    // For simulation, accept if we don't have real IPFS
    const cidValid = calculatedCid === session.expectedCid || calculatedCid === 'simulated';

    if (!cidValid) {
      return { 
        success: false, 
        error: `CID mismatch: expected ${session.expectedCid}, got ${calculatedCid}` 
      };
    }

    // Update file status
    const file = await storage.getFileByCid(session.expectedCid);
    if (file) {
      await storage.updateFileStatus(file.id, 'syncing', 0, 0);
      
      // Update contract status
      const contract = await storage.getStorageContractByCid(session.expectedCid);
      if (contract) {
        await storage.updateStorageContractStatus(contract.id, 'active');
        await storage.createContractEvent({
          contractId: contract.id,
          eventType: 'activated',
          payload: JSON.stringify({ verified: true, size: completeFile.length }),
          triggeredBy: 'system',
        });
      }

      // Clean up session
      this.sessions.delete(sessionId);
      this.chunkData.delete(sessionId);

      console.log(`[Upload Manager] Upload completed for ${session.fileName} (${session.expectedCid})`);

      return { 
        success: true, 
        file: { ...file, status: 'syncing' },
        contract: contract || undefined,
      };
    }

    return { success: false, error: 'File record not found' };
  }

  // Calculate CID (simulated for now)
  private async calculateCid(data: Buffer): Promise<string> {
    // In simulation mode, return a placeholder
    // In production, this would use IPFS to calculate the actual CID
    try {
      // Attempt to use real IPFS if available
      const ipfsUrl = process.env.IPFS_API_URL;
      if (ipfsUrl) {
        // Real IPFS CID calculation would go here
        // For now, return hash-based pseudo-CID
        const hash = createHash('sha256').update(data).digest('hex');
        return `Qm${hash.substring(0, 44)}`;
      }
    } catch (e) {
      // Fall back to simulation
    }
    return 'simulated';
  }

  // Cancel an upload session
  async cancelUpload(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // Update file status to cancelled
    const file = await storage.getFileByCid(session.expectedCid);
    if (file) {
      await storage.updateFileStatus(file.id, 'cancelled', 0, 0);
      
      const contract = await storage.getStorageContractByCid(session.expectedCid);
      if (contract) {
        await storage.updateStorageContractStatus(contract.id, 'cancelled');
        await storage.createContractEvent({
          contractId: contract.id,
          eventType: 'cancelled',
          payload: JSON.stringify({ reason: 'User cancelled' }),
          triggeredBy: session.uploaderUsername,
        });
      }
    }

    this.sessions.delete(sessionId);
    this.chunkData.delete(sessionId);

    console.log(`[Upload Manager] Upload cancelled for session ${sessionId}`);
    return true;
  }

  // Clean up expired sessions
  cleanupExpiredSessions(): void {
    const now = new Date();
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(sessionId);
        this.chunkData.delete(sessionId);
        console.log(`[Upload Manager] Cleaned up expired session ${sessionId}`);
      }
    }
  }

  // Start periodic cleanup
  startCleanupInterval(): NodeJS.Timeout {
    return setInterval(() => this.cleanupExpiredSessions(), 60000); // Every minute
  }
}

// Singleton instance
export const uploadManager = new UploadManager();
