/**
 * Blocklist Service
 * Repurposed from SPK Network's blocklist/mutelist system
 * 
 * Implements multi-tier content moderation:
 * - Local: Per-user blocklists
 * - Validator: Network-level blocklists
 * - Platform: Per-platform content policies
 */

import { storage } from "../storage";
import { logBlocklist } from "../logger";
import type { BlocklistEntry, InsertBlocklistEntry, Tag, FileTag, InsertFileTag } from "@shared/schema";

export type BlocklistScope = 'local' | 'validator' | 'platform';
export type TargetType = 'account' | 'cid' | 'ipfs_hash' | 'ssdeep_hash' | 'tag';
export type Severity = 'low' | 'moderate' | 'severe' | 'critical';

export interface BlockCheckResult {
  blocked: boolean;
  reasons: { scope: BlocklistScope; reason: string; severity: Severity }[];
}

export class BlocklistService {
  // Check if a target is blocked
  async checkBlocked(params: {
    targetType: TargetType;
    targetValue: string;
    userScopes?: { username?: string; validatorId?: string; platformId?: string };
  }): Promise<BlockCheckResult> {
    const reasons: BlockCheckResult['reasons'] = [];
    
    const scopesToCheck: { scope: string; scopeOwnerId?: string }[] = [];
    
    // Always check platform and validator level
    if (params.userScopes?.platformId) {
      scopesToCheck.push({ scope: 'platform', scopeOwnerId: params.userScopes.platformId });
    }
    if (params.userScopes?.validatorId) {
      scopesToCheck.push({ scope: 'validator', scopeOwnerId: params.userScopes.validatorId });
    }
    if (params.userScopes?.username) {
      scopesToCheck.push({ scope: 'local', scopeOwnerId: params.userScopes.username });
    }

    // Check all applicable scopes
    const entries = await storage.getEffectiveBlocklist(scopesToCheck);
    
    for (const entry of entries) {
      if (entry.targetType === params.targetType && entry.targetValue === params.targetValue) {
        reasons.push({
          scope: entry.scope as BlocklistScope,
          reason: entry.reason || 'Blocked',
          severity: entry.severity as Severity,
        });
      }
    }

    return {
      blocked: reasons.length > 0,
      reasons,
    };
  }

  // Add entry to blocklist
  async addToBlocklist(params: {
    scope: BlocklistScope;
    scopeOwnerId: string;
    targetType: TargetType;
    targetValue: string;
    reason?: string;
    severity?: Severity;
    expiresAt?: Date;
  }): Promise<BlocklistEntry> {
    const entry = await storage.createBlocklistEntry({
      scope: params.scope,
      scopeOwnerId: params.scopeOwnerId,
      targetType: params.targetType,
      targetValue: params.targetValue,
      reason: params.reason,
      severity: params.severity || 'moderate',
      active: true,
      expiresAt: params.expiresAt,
    });

    logBlocklist.info(`[Blocklist Service] Added ${params.targetType}:${params.targetValue} to ${params.scope} blocklist`);
    return entry;
  }

  // Remove from blocklist
  async removeFromBlocklist(entryId: string): Promise<void> {
    await storage.deactivateBlocklistEntry(entryId);
    logBlocklist.info(`[Blocklist Service] Deactivated blocklist entry ${entryId}`);
  }

  // Get blocklist for a scope
  async getBlocklist(scope: BlocklistScope, scopeOwnerId?: string): Promise<BlocklistEntry[]> {
    return storage.getBlocklistEntries(scope, scopeOwnerId);
  }

  // Calculate ssdeep hash (simulated)
  async calculateSsdeepHash(data: Buffer): Promise<string> {
    // In production, this would use the ssdeep library
    // For simulation, we create a pseudo-hash
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(data).digest('hex');
    
    // Format similar to ssdeep: blocksize:hash1:hash2
    const blockSize = Math.floor(data.length / 64);
    return `${blockSize}:${hash.substring(0, 32)}:${hash.substring(32, 64)}`;
  }

  // Check ssdeep similarity (simulated)
  compareSsdeepHashes(hash1: string, hash2: string): number {
    // In production, this would use fuzzy hash comparison
    // For simulation, compare the hash portions
    if (hash1 === hash2) return 100;
    
    const parts1 = hash1.split(':');
    const parts2 = hash2.split(':');
    
    if (parts1.length !== 3 || parts2.length !== 3) return 0;
    
    // Simple character comparison
    let matches = 0;
    const len = Math.min(parts1[1].length, parts2[1].length);
    for (let i = 0; i < len; i++) {
      if (parts1[1][i] === parts2[1][i]) matches++;
    }
    
    return Math.round((matches / len) * 100);
  }

  // Seed default tags
  async seedDefaultTags(): Promise<void> {
    const existingTags = await storage.getAllTags();
    if (existingTags.length > 0) return;

    const defaultTags = [
      { label: 'nsfw', category: 'content', description: 'Not safe for work content' },
      { label: 'violence', category: 'content', description: 'Violent or graphic content' },
      { label: 'spam', category: 'moderation', description: 'Spam or unwanted content' },
      { label: 'copyright', category: 'moderation', description: 'Potential copyright violation' },
      { label: 'misinformation', category: 'moderation', description: 'False or misleading information' },
      { label: 'educational', category: 'content', description: 'Educational content' },
      { label: 'gaming', category: 'content', description: 'Gaming related content' },
      { label: 'music', category: 'content', description: 'Music content' },
      { label: 'vlog', category: 'content', description: 'Video blog content' },
      { label: 'tutorial', category: 'content', description: 'Tutorial or how-to content' },
    ];

    for (const tag of defaultTags) {
      await storage.createTag(tag);
    }

    logBlocklist.info("[Blocklist Service] Seeded default content tags");
  }

  // Add tag to file
  async addTagToFile(params: {
    fileId: string;
    tagLabel: string;
    addedBy: string;
  }): Promise<FileTag> {
    // Get or create tag
    let tag = await storage.getTagByLabel(params.tagLabel);
    if (!tag) {
      tag = await storage.createTag({
        label: params.tagLabel,
        category: 'content',
      });
    }

    // Check if tag already exists on file
    const existingTags = await storage.getFileTags(params.fileId);
    const existing = existingTags.find(ft => ft.tagId === tag!.id);
    if (existing) {
      return existing;
    }

    // Create file tag
    const fileTag = await storage.createFileTag({
      fileId: params.fileId,
      tagId: tag.id,
      addedBy: params.addedBy,
      votesUp: 1,
      votesDown: 0,
      confidence: 0.5,
    });

    logBlocklist.info(`[Blocklist Service] Added tag '${params.tagLabel}' to file ${params.fileId}`);
    return fileTag;
  }

  // Vote on a file tag
  async voteOnTag(params: {
    fileTagId: string;
    voterUsername: string;
    voteType: 'up' | 'down';
    voterReputation?: number;
  }): Promise<void> {
    // Check if user already voted
    const existingVote = await storage.getUserVoteOnFileTag(params.fileTagId, params.voterUsername);
    if (existingVote) {
      throw new Error('User has already voted on this tag');
    }

    // Create vote
    await storage.createTagVote({
      fileTagId: params.fileTagId,
      voterUsername: params.voterUsername,
      voteType: params.voteType,
      voterReputation: params.voterReputation || 50,
    });

    // Update file tag counts
    const fileTags = await storage.getFileTags('');
    // Get all votes and recalculate
    // For now, just increment
    // In production, this would recalculate weighted confidence

    logBlocklist.info(`[Blocklist Service] Vote recorded: ${params.voteType} on tag ${params.fileTagId}`);
  }

  // Seed sample platform blocklists
  async seedPlatformBlocklists(): Promise<void> {
    const existing = await storage.getAllPlatformBlocklists();
    if (existing.length > 0) return;

    const platforms = [
      { platformId: '3speak', platformName: '3Speak', policyUrl: 'https://3speak.tv/policy', enforceLevel: 'block' },
      { platformId: 'peakd', platformName: 'PeakD', policyUrl: 'https://peakd.com/tos', enforceLevel: 'warn' },
      { platformId: 'ecency', platformName: 'Ecency', policyUrl: 'https://ecency.com/terms', enforceLevel: 'hide' },
    ];

    for (const platform of platforms) {
      await storage.createPlatformBlocklist(platform);
    }

    logBlocklist.info("[Blocklist Service] Seeded sample platform blocklists");
  }
}

// Singleton instance
export const blocklistService = new BlocklistService();
