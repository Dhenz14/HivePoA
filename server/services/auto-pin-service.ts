/**
 * Auto-Pin Service
 * Phase 4: Automatic pinning of viewed content
 * 
 * Watches for completed view events and pins content that meets user criteria
 */

import { storage } from "../storage";
import type { ViewEvent, UserNodeSettings, File } from "@shared/schema";

export interface AutoPinResult {
  pinned: boolean;
  reason: string;
  fileId?: string;
  fileCid?: string;
}

export class AutoPinService {
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  // Start the auto-pin worker
  start(): void {
    this.processingInterval = setInterval(() => this.processViewEvents(), 10000); // Every 10 seconds
    console.log("[Auto-Pin Service] Started auto-pin processor");
  }

  stop(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    console.log("[Auto-Pin Service] Stopped auto-pin processor");
  }

  // Process pending view events for auto-pinning
  private async processViewEvents(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      const viewEvents = await storage.getViewEventsForAutoPinning();
      
      for (const event of viewEvents) {
        await this.processViewEvent(event);
      }
    } catch (error) {
      console.error("[Auto-Pin Service] Processing error:", error);
    } finally {
      this.isProcessing = false;
    }
  }

  // Process a single view event
  private async processViewEvent(event: ViewEvent): Promise<AutoPinResult> {
    try {
      // Get user settings
      const settings = await storage.getUserNodeSettings(event.viewerUsername);
      
      if (!settings || !settings.autoPinEnabled) {
        await storage.markViewEventAutoPinTriggered(event.id);
        return { pinned: false, reason: 'Auto-pin disabled for user' };
      }

      // Get the file
      const file = await storage.getFile(event.fileId);
      if (!file) {
        await storage.markViewEventAutoPinTriggered(event.id);
        return { pinned: false, reason: 'File not found' };
      }

      // Check confidence threshold
      if (settings.autoPinThreshold && file.confidence < settings.autoPinThreshold) {
        await storage.markViewEventAutoPinTriggered(event.id);
        return { 
          pinned: false, 
          reason: `File confidence ${file.confidence}% below threshold ${settings.autoPinThreshold}%`,
          fileId: file.id,
        };
      }

      // Check file size
      const maxSize = BigInt(settings.maxAutoPinSize || '104857600');
      const fileSize = BigInt(file.size);
      if (fileSize > maxSize) {
        await storage.markViewEventAutoPinTriggered(event.id);
        return { 
          pinned: false, 
          reason: `File size ${file.size} exceeds max ${settings.maxAutoPinSize}`,
          fileId: file.id,
        };
      }

      // Pin the file (in simulation, we just log it)
      await this.pinFile(file, event.viewerUsername);
      await storage.markViewEventAutoPinTriggered(event.id);

      console.log(`[Auto-Pin Service] Pinned ${file.cid} for user ${event.viewerUsername}`);

      return {
        pinned: true,
        reason: 'Auto-pinned after completed view',
        fileId: file.id,
        fileCid: file.cid,
      };
    } catch (error) {
      console.error(`[Auto-Pin Service] Error processing event ${event.id}:`, error);
      return { pinned: false, reason: String(error) };
    }
  }

  // Pin a file (simulated - in production would call IPFS)
  private async pinFile(file: File, username: string): Promise<void> {
    // In production, this would:
    // 1. Connect to user's local IPFS node
    // 2. Call ipfs.pin.add(file.cid)
    // 3. Track the pin in the database
    
    // For simulation, we just log and could track in a pins table
    console.log(`[Auto-Pin Service] Simulated pin: ${file.cid} for ${username}`);
  }

  // Record a view event
  async recordView(params: {
    fileId: string;
    viewerUsername: string;
    viewDurationMs: number;
    completed: boolean;
  }): Promise<ViewEvent> {
    return storage.createViewEvent({
      fileId: params.fileId,
      viewerUsername: params.viewerUsername,
      viewDurationMs: params.viewDurationMs,
      completed: params.completed,
      autoPinTriggered: false,
    });
  }

  // Get or create user settings
  async getUserSettings(username: string): Promise<UserNodeSettings> {
    let settings = await storage.getUserNodeSettings(username);
    
    if (!settings) {
      settings = await storage.createOrUpdateUserNodeSettings({
        username,
        autoPinEnabled: false,
        autoPinThreshold: 60,
        maxAutoPinSize: '104857600', // 100MB
        encryptByDefault: false,
      });
    }

    return settings;
  }

  // Update user settings
  async updateUserSettings(username: string, updates: Partial<{
    autoPinEnabled: boolean;
    autoPinThreshold: number;
    maxAutoPinSize: string;
    encryptByDefault: boolean;
  }>): Promise<UserNodeSettings> {
    const current = await this.getUserSettings(username);
    
    return storage.createOrUpdateUserNodeSettings({
      username,
      autoPinEnabled: updates.autoPinEnabled ?? current.autoPinEnabled,
      autoPinThreshold: updates.autoPinThreshold ?? current.autoPinThreshold ?? 60,
      maxAutoPinSize: updates.maxAutoPinSize ?? current.maxAutoPinSize ?? '104857600',
      encryptByDefault: updates.encryptByDefault ?? current.encryptByDefault,
    });
  }

  // Get auto-pin statistics for a user
  async getAutoPinStats(username: string): Promise<{
    totalViews: number;
    completedViews: number;
    pinnedContent: number;
  }> {
    // This would query the database for stats
    // For now, return mock data
    return {
      totalViews: Math.floor(Math.random() * 100),
      completedViews: Math.floor(Math.random() * 50),
      pinnedContent: Math.floor(Math.random() * 20),
    };
  }
}

// Singleton instance
export const autoPinService = new AutoPinService();
