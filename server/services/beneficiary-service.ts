/**
 * Beneficiary Rewards Service
 * Phase 4: Split HBD payouts to node operators
 * 
 * Manages reward allocations and tracks payout history
 */

import { storage } from "../storage";
import type { BeneficiaryAllocation, PayoutHistory, StorageNode } from "@shared/schema";

export interface PayoutSplit {
  recipientUsername: string;
  recipientNodeId?: string;
  percentage: number;
  hbdAmount: string;
  payoutType: 'storage' | 'encoding' | 'beneficiary' | 'validation';
}

export interface PayoutResult {
  success: boolean;
  splits: PayoutSplit[];
  totalHbd: string;
  txHash?: string;
  error?: string;
}

export class BeneficiaryService {
  // Maximum beneficiaries per user
  private readonly MAX_BENEFICIARIES = 10;
  
  // Maximum total allocation (leave some for the user)
  private readonly MAX_TOTAL_ALLOCATION = 90; // 90%

  // Add a beneficiary allocation
  async addBeneficiary(params: {
    fromUsername: string;
    toNodeId: string;
    percentage: number;
  }): Promise<BeneficiaryAllocation> {
    // Validate percentage
    if (params.percentage <= 0 || params.percentage > 100) {
      throw new Error('Percentage must be between 0 and 100');
    }

    // Get current allocations
    const current = await storage.getBeneficiaryAllocations(params.fromUsername);
    
    // Check max beneficiaries
    if (current.length >= this.MAX_BENEFICIARIES) {
      throw new Error(`Maximum ${this.MAX_BENEFICIARIES} beneficiaries allowed`);
    }

    // Check total allocation
    const totalCurrent = current.reduce((sum, a) => sum + a.percentage, 0);
    if (totalCurrent + params.percentage > this.MAX_TOTAL_ALLOCATION) {
      throw new Error(`Total allocation would exceed ${this.MAX_TOTAL_ALLOCATION}%`);
    }

    // Check if node already has allocation
    const existing = current.find(a => a.toNodeId === params.toNodeId);
    if (existing) {
      throw new Error('Beneficiary already exists. Use update to change percentage.');
    }

    // Verify node exists
    const node = await storage.getStorageNode(params.toNodeId);
    if (!node) {
      throw new Error('Storage node not found');
    }

    // Create allocation
    const allocation = await storage.createBeneficiaryAllocation({
      fromUsername: params.fromUsername,
      toNodeId: params.toNodeId,
      percentage: params.percentage,
      hbdAllocated: '0',
      active: true,
    });

    console.log(`[Beneficiary Service] Added allocation: ${params.fromUsername} -> ${node.hiveUsername} (${params.percentage}%)`);
    return allocation;
  }

  // Update beneficiary percentage
  async updateBeneficiary(params: {
    allocationId: string;
    percentage: number;
    fromUsername: string;
  }): Promise<void> {
    if (params.percentage <= 0 || params.percentage > 100) {
      throw new Error('Percentage must be between 0 and 100');
    }

    // Get all allocations
    const current = await storage.getBeneficiaryAllocations(params.fromUsername);
    
    // Find the one to update
    const toUpdate = current.find(a => a.id === params.allocationId);
    if (!toUpdate) {
      throw new Error('Allocation not found');
    }

    // Calculate new total
    const otherTotal = current
      .filter(a => a.id !== params.allocationId)
      .reduce((sum, a) => sum + a.percentage, 0);
    
    if (otherTotal + params.percentage > this.MAX_TOTAL_ALLOCATION) {
      throw new Error(`Total allocation would exceed ${this.MAX_TOTAL_ALLOCATION}%`);
    }

    await storage.updateBeneficiaryAllocation(params.allocationId, params.percentage);
    console.log(`[Beneficiary Service] Updated allocation ${params.allocationId} to ${params.percentage}%`);
  }

  // Remove beneficiary
  async removeBeneficiary(allocationId: string): Promise<void> {
    await storage.deactivateBeneficiaryAllocation(allocationId);
    console.log(`[Beneficiary Service] Removed allocation ${allocationId}`);
  }

  // Get all beneficiaries for a user
  async getBeneficiaries(username: string): Promise<{
    allocations: (BeneficiaryAllocation & { node?: StorageNode })[];
    totalPercentage: number;
    remainingPercentage: number;
  }> {
    const allocations = await storage.getBeneficiaryAllocations(username);
    
    // Enrich with node data
    const enriched = await Promise.all(
      allocations.map(async (a) => ({
        ...a,
        node: await storage.getStorageNode(a.toNodeId),
      }))
    );

    const totalPercentage = allocations.reduce((sum, a) => sum + a.percentage, 0);

    return {
      allocations: enriched,
      totalPercentage,
      remainingPercentage: 100 - totalPercentage,
    };
  }

  // Calculate payout splits for a given amount
  async calculateSplits(params: {
    fromUsername: string;
    totalHbd: string;
    payoutType: 'storage' | 'encoding' | 'beneficiary' | 'validation';
  }): Promise<PayoutSplit[]> {
    const splits: PayoutSplit[] = [];
    const totalAmount = parseFloat(params.totalHbd);
    
    if (totalAmount <= 0) {
      return splits;
    }

    // Get beneficiary allocations
    const { allocations, totalPercentage } = await this.getBeneficiaries(params.fromUsername);

    // Calculate beneficiary splits
    for (const allocation of allocations) {
      if (!allocation.node) continue;
      
      const amount = (totalAmount * allocation.percentage) / 100;
      splits.push({
        recipientUsername: allocation.node.hiveUsername,
        recipientNodeId: allocation.toNodeId,
        percentage: allocation.percentage,
        hbdAmount: amount.toFixed(3),
        payoutType: 'beneficiary',
      });
    }

    // Remaining goes to the original user
    const remainingPercentage = 100 - totalPercentage;
    if (remainingPercentage > 0) {
      const amount = (totalAmount * remainingPercentage) / 100;
      splits.push({
        recipientUsername: params.fromUsername,
        percentage: remainingPercentage,
        hbdAmount: amount.toFixed(3),
        payoutType: params.payoutType,
      });
    }

    return splits;
  }

  // Execute payout with beneficiary splits
  async executePayout(params: {
    fromUsername: string;
    totalHbd: string;
    payoutType: 'storage' | 'encoding' | 'beneficiary' | 'validation';
    contractId?: string;
  }): Promise<PayoutResult> {
    try {
      const splits = await this.calculateSplits({
        fromUsername: params.fromUsername,
        totalHbd: params.totalHbd,
        payoutType: params.payoutType,
      });

      // Record each payout
      for (const split of splits) {
        await storage.createPayoutHistory({
          contractId: params.contractId,
          recipientUsername: split.recipientUsername,
          recipientNodeId: split.recipientNodeId,
          hbdAmount: split.hbdAmount,
          payoutType: split.payoutType,
        });
      }

      // In production, this would broadcast to Hive blockchain
      const txHash = `sim_tx_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      console.log(`[Beneficiary Service] Executed payout: ${params.totalHbd} HBD split into ${splits.length} parts`);

      return {
        success: true,
        splits,
        totalHbd: params.totalHbd,
        txHash,
      };
    } catch (error) {
      console.error("[Beneficiary Service] Payout error:", error);
      return {
        success: false,
        splits: [],
        totalHbd: params.totalHbd,
        error: String(error),
      };
    }
  }

  // Get payout history for a user
  async getPayoutHistory(username: string, limit = 50): Promise<PayoutHistory[]> {
    return storage.getPayoutHistory(username, limit);
  }

  // Calculate total earnings for a user
  async getTotalEarnings(username: string): Promise<{
    storage: string;
    encoding: string;
    beneficiary: string;
    validation: string;
    total: string;
  }> {
    const history = await storage.getPayoutHistory(username, 1000);
    
    const earnings = {
      storage: 0,
      encoding: 0,
      beneficiary: 0,
      validation: 0,
    };

    for (const payout of history) {
      const amount = parseFloat(payout.hbdAmount);
      const type = payout.payoutType as keyof typeof earnings;
      if (type in earnings) {
        earnings[type] += amount;
      }
    }

    return {
      storage: earnings.storage.toFixed(3),
      encoding: earnings.encoding.toFixed(3),
      beneficiary: earnings.beneficiary.toFixed(3),
      validation: earnings.validation.toFixed(3),
      total: (earnings.storage + earnings.encoding + earnings.beneficiary + earnings.validation).toFixed(3),
    };
  }
}

// Singleton instance
export const beneficiaryService = new BeneficiaryService();
