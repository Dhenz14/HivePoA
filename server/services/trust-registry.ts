import { db } from "../db";
import {
  trustedRolePolicies,
  trustedRoles,
  trustedRoleVouches,
  trustedRoleAuditLog,
  type TrustedRolePolicy,
  type TrustedRole,
  type TrustedRoleVouch,
  type TrustedRoleAuditEntry,
} from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { logWoT } from "../logger";

const VALID_ROLES = ["validator", "treasury_signer", "compute_verifier", "oracle_runner", "dbc_trainer"] as const;
export type TrustRole = typeof VALID_ROLES[number];

// Default policies seeded at startup
const DEFAULT_POLICIES: Omit<TrustedRolePolicy, "createdAt">[] = [
  { role: "validator", vouchesRequired: 1, cooldownHours: 168, maxChurnEvents: 5, requiresOptIn: true, autoEligibleWitnessRank: 150, description: "PoA challenge validators" },
  { role: "treasury_signer", vouchesRequired: 3, cooldownHours: 168, maxChurnEvents: 5, requiresOptIn: true, autoEligibleWitnessRank: 150, description: "Multisig treasury signers (60%/80% quorum)" },
  { role: "compute_verifier", vouchesRequired: 2, cooldownHours: 168, maxChurnEvents: 5, requiresOptIn: true, autoEligibleWitnessRank: 150, description: "GPU compute job verifiers" },
  { role: "oracle_runner", vouchesRequired: 2, cooldownHours: 168, maxChurnEvents: 5, requiresOptIn: true, autoEligibleWitnessRank: 150, description: "DBC oracle nodes" },
  { role: "dbc_trainer", vouchesRequired: 2, cooldownHours: 168, maxChurnEvents: 5, requiresOptIn: true, autoEligibleWitnessRank: 150, description: "DBC privileged trainers" },
];

export interface EligibilityCheck {
  eligible: boolean;
  eligibilityType: "witness" | "vouched" | "none";
  witnessRank: number | null;
  vouchers: string[];
  optedIn: boolean;
  status: string;
  role: string;
}

export class TrustRegistryService {
  private hiveClient: any; // injected — uses isTopWitness(), getWitnessRank()

  constructor(hiveClient: any) {
    this.hiveClient = hiveClient;
  }

  async initialize(): Promise<void> {
    // Seed default policies if not present
    for (const policy of DEFAULT_POLICIES) {
      await db.insert(trustedRolePolicies).values(policy).onConflictDoNothing();
    }
    logWoT.info("[TrustRegistry] Initialized with default role policies");
  }

  // ================================================================
  // Eligibility Check (the key endpoint for Hive-AI)
  // ================================================================

  async checkEligibility(username: string, role: string): Promise<EligibilityCheck> {
    const policy = await this.getPolicy(role);
    if (!policy) {
      return { eligible: false, eligibilityType: "none", witnessRank: null, vouchers: [], optedIn: false, status: "unknown_role", role };
    }

    // Check if already opted in
    const existing = await this.getRole(username, role);
    if (existing && existing.status === "active") {
      return {
        eligible: true,
        eligibilityType: existing.eligibilityType as "witness" | "vouched",
        witnessRank: existing.witnessRank,
        vouchers: existing.eligibilityType === "vouched" ? await this.getVouchersFor(username, role) : [],
        optedIn: true,
        status: existing.status,
        role,
      };
    }

    // Check witness eligibility (safe: if Hive client is mock or unreachable, treat as not-a-witness)
    let isWitness = false;
    let witnessRank: number | null = null;
    try {
      isWitness = await this.hiveClient.isTopWitness(username, policy.autoEligibleWitnessRank);
      if (isWitness) {
        witnessRank = await this.hiveClient.getWitnessRank(username);
      }
    } catch {
      // Mock client or Hive API unreachable — not a witness
      isWitness = false;
    }

    if (isWitness) {
      return {
        eligible: true,
        eligibilityType: "witness",
        witnessRank,
        vouchers: [],
        optedIn: !!existing,
        status: existing?.status || "eligible_not_opted_in",
        role,
      };
    }

    // Check vouch eligibility
    const activeVouches = await this.getActiveVouchesForCandidate(username, role);
    // Filter: only count vouches from current top-150 witnesses
    const validVouches: string[] = [];
    for (const v of activeVouches) {
      try {
        const still = await this.hiveClient.isTopWitness(v.voucherUsername, policy.autoEligibleWitnessRank);
        if (still) validVouches.push(v.voucherUsername);
      } catch (err) {
        // Voucher check failed — skip this vouch (fail-closed), but log for observability
        logWoT.warn({ err, voucher: v.voucherUsername }, "Witness check failed during eligibility — vouch skipped");
      }
    }

    if (validVouches.length >= policy.vouchesRequired) {
      return {
        eligible: true,
        eligibilityType: "vouched",
        witnessRank: null,
        vouchers: validVouches,
        optedIn: !!existing,
        status: existing?.status || "eligible_not_opted_in",
        role,
      };
    }

    return {
      eligible: false,
      eligibilityType: "none",
      witnessRank: null,
      vouchers: validVouches,
      optedIn: false,
      status: `needs_${policy.vouchesRequired - validVouches.length}_more_vouches`,
      role,
    };
  }

  // ================================================================
  // Opt-In / Opt-Out
  // ================================================================

  async optIn(username: string, role: string): Promise<TrustedRole> {
    const check = await this.checkEligibility(username, role);
    if (!check.eligible) {
      throw new Error(`Not eligible for role ${role}: ${check.status}`);
    }

    const existing = await this.getRole(username, role);
    if (existing && existing.status === "active") {
      return existing; // already opted in
    }

    if (existing && existing.status === "cooldown" && existing.cooldownUntil && new Date(existing.cooldownUntil) > new Date()) {
      throw new Error(`In cooldown until ${existing.cooldownUntil}`);
    }

    const now = new Date();
    if (existing) {
      // Reactivate
      await db.update(trustedRoles).set({
        status: "active",
        eligibilityType: check.eligibilityType,
        witnessRank: check.witnessRank,
        optedInAt: now,
        removedAt: null,
        removeReason: null,
        cooldownUntil: null,
      }).where(eq(trustedRoles.id, existing.id));
    } else {
      await db.insert(trustedRoles).values({
        username,
        role,
        status: "active",
        eligibilityType: check.eligibilityType,
        witnessRank: check.witnessRank,
        optedInAt: now,
      });
    }

    await this.auditLog(username, role, "opted_in", username);
    logWoT.info({ username, role, type: check.eligibilityType }, "Opted into trusted role");

    return (await this.getRole(username, role))!;
  }

  async optOut(username: string, role: string): Promise<void> {
    const existing = await this.getRole(username, role);
    if (!existing || existing.status !== "active") {
      throw new Error("Not currently active in this role");
    }

    const policy = await this.getPolicy(role);
    const cooldownUntil = new Date(Date.now() + (policy?.cooldownHours || 168) * 3600 * 1000);

    await db.update(trustedRoles).set({
      status: "cooldown",
      removedAt: new Date(),
      removeReason: "opted_out",
      cooldownUntil,
    }).where(eq(trustedRoles.id, existing.id));

    await this.auditLog(username, role, "opted_out", username);
    logWoT.info({ username, role, cooldownUntil }, "Opted out of trusted role");
  }

  // ================================================================
  // Vouching
  // ================================================================

  async addVouch(voucherUsername: string, candidateUsername: string, role: string): Promise<TrustedRoleVouch> {
    const policy = await this.getPolicy(role);
    if (!policy) throw new Error(`Unknown role: ${role}`);

    // Verify voucher is a top-N witness
    const isWitness = await this.hiveClient.isTopWitness(voucherUsername, policy.autoEligibleWitnessRank);
    if (!isWitness) throw new Error("Only top-150 witnesses can vouch");

    const rank = await this.hiveClient.getWitnessRank(voucherUsername);

    // Check for existing active vouch
    const existing = await this.getActiveVouch(voucherUsername, candidateUsername, role);
    if (existing) throw new Error("Already vouching for this candidate in this role");

    const [vouch] = await db.insert(trustedRoleVouches).values({
      voucherUsername,
      candidateUsername,
      role,
      voucherRank: rank || 0,
      active: true,
    }).returning();

    await this.auditLog(candidateUsername, role, "vouch_added", voucherUsername, `Vouched by ${voucherUsername} (rank ${rank})`);
    logWoT.info({ voucher: voucherUsername, candidate: candidateUsername, role, rank }, "Vouch added");

    return vouch;
  }

  async revokeVouch(voucherUsername: string, candidateUsername: string, role: string, reason = "manual"): Promise<void> {
    const existing = await this.getActiveVouch(voucherUsername, candidateUsername, role);
    if (!existing) throw new Error("No active vouch found");

    await db.update(trustedRoleVouches).set({
      active: false,
      revokedAt: new Date(),
      revokeReason: reason,
    }).where(eq(trustedRoleVouches.id, existing.id));

    await this.auditLog(candidateUsername, role, "vouch_revoked", voucherUsername, reason);
    logWoT.info({ voucher: voucherUsername, candidate: candidateUsername, role, reason }, "Vouch revoked");

    // Check if candidate still has enough vouches — suspend if not
    const check = await this.checkEligibility(candidateUsername, role);
    if (!check.eligible) {
      const memberRole = await this.getRole(candidateUsername, role);
      if (memberRole && memberRole.status === "active") {
        await db.update(trustedRoles).set({
          status: "suspended",
          removeReason: "insufficient_vouches",
        }).where(eq(trustedRoles.id, memberRole.id));
        await this.auditLog(candidateUsername, role, "suspended", "system", "Lost required vouches");
        logWoT.warn({ username: candidateUsername, role }, "Suspended — lost required vouches");
      }
    }
  }

  // ================================================================
  // Witness Refresh (called periodically)
  // ================================================================

  async refreshWitnessEligibility(): Promise<{ revoked: number; suspended: number; errors: number }> {
    let revoked = 0;
    let suspended = 0;
    let errors = 0;

    // Check all active vouches — revoke if voucher is no longer top-150
    // Fail-closed per record: if Hive client throws for one account, skip it and continue
    const allVouches = await db.select().from(trustedRoleVouches).where(eq(trustedRoleVouches.active, true));

    for (const vouch of allVouches) {
      try {
        const policy = await this.getPolicy(vouch.role);
        const stillWitness = await this.hiveClient.isTopWitness(vouch.voucherUsername, policy?.autoEligibleWitnessRank || 150);
        if (!stillWitness) {
          await this.revokeVouch(vouch.voucherUsername, vouch.candidateUsername, vouch.role, "voucher_deranked");
          revoked++;
        }
      } catch (err) {
        // Skip this vouch — don't revoke on RPC failure (fail-closed = keep existing state)
        errors++;
        logWoT.warn({ voucher: vouch.voucherUsername, role: vouch.role, err }, "Witness check failed during refresh — skipping");
      }
    }

    // Check all active witness-type roles — suspend if no longer top-150
    const witnessRoles = await db.select().from(trustedRoles)
      .where(and(eq(trustedRoles.status, "active"), eq(trustedRoles.eligibilityType, "witness")));

    for (const role of witnessRoles) {
      try {
        const policy = await this.getPolicy(role.role);
        const stillWitness = await this.hiveClient.isTopWitness(role.username, policy?.autoEligibleWitnessRank || 150);
        if (!stillWitness) {
          await db.update(trustedRoles).set({
            status: "suspended",
            removeReason: "witness_deranked",
          }).where(eq(trustedRoles.id, role.id));
          await this.auditLog(role.username, role.role, "witness_deranked", "system");
          suspended++;
        }
      } catch (err) {
        errors++;
        logWoT.warn({ username: role.username, role: role.role, err }, "Witness check failed during refresh — skipping");
      }
    }

    if (revoked > 0 || suspended > 0 || errors > 0) {
      logWoT.info({ revoked, suspended, errors }, "Witness refresh completed");
    }
    return { revoked, suspended, errors };
  }

  // ================================================================
  // Queries
  // ================================================================

  async getPolicy(role: string): Promise<TrustedRolePolicy | undefined> {
    const [p] = await db.select().from(trustedRolePolicies).where(eq(trustedRolePolicies.role, role));
    return p || undefined;
  }

  async getAllPolicies(): Promise<TrustedRolePolicy[]> {
    return db.select().from(trustedRolePolicies);
  }

  async getRole(username: string, role: string): Promise<TrustedRole | undefined> {
    const [r] = await db.select().from(trustedRoles)
      .where(and(eq(trustedRoles.username, username), eq(trustedRoles.role, role)));
    return r || undefined;
  }

  async getRoleMembers(role: string): Promise<TrustedRole[]> {
    return db.select().from(trustedRoles)
      .where(and(eq(trustedRoles.role, role), eq(trustedRoles.status, "active")))
      .orderBy(desc(trustedRoles.optedInAt));
  }

  async getActiveVouch(voucher: string, candidate: string, role: string): Promise<TrustedRoleVouch | undefined> {
    const [v] = await db.select().from(trustedRoleVouches)
      .where(and(
        eq(trustedRoleVouches.voucherUsername, voucher),
        eq(trustedRoleVouches.candidateUsername, candidate),
        eq(trustedRoleVouches.role, role),
        eq(trustedRoleVouches.active, true),
      ));
    return v || undefined;
  }

  async getActiveVouchesForCandidate(username: string, role: string): Promise<TrustedRoleVouch[]> {
    return db.select().from(trustedRoleVouches)
      .where(and(
        eq(trustedRoleVouches.candidateUsername, username),
        eq(trustedRoleVouches.role, role),
        eq(trustedRoleVouches.active, true),
      ));
  }

  async getVouchersFor(username: string, role: string): Promise<string[]> {
    const vouches = await this.getActiveVouchesForCandidate(username, role);
    return vouches.map(v => v.voucherUsername);
  }

  async getVouchesByVoucher(username: string): Promise<TrustedRoleVouch[]> {
    return db.select().from(trustedRoleVouches)
      .where(and(eq(trustedRoleVouches.voucherUsername, username), eq(trustedRoleVouches.active, true)));
  }

  async getVouchesForCandidate(username: string): Promise<TrustedRoleVouch[]> {
    return db.select().from(trustedRoleVouches)
      .where(and(eq(trustedRoleVouches.candidateUsername, username), eq(trustedRoleVouches.active, true)));
  }

  async getVouchesByRole(role: string): Promise<TrustedRoleVouch[]> {
    return db.select().from(trustedRoleVouches)
      .where(and(eq(trustedRoleVouches.role, role), eq(trustedRoleVouches.active, true)));
  }

  async getAuditLog(limit = 50): Promise<TrustedRoleAuditEntry[]> {
    return db.select().from(trustedRoleAuditLog).orderBy(desc(trustedRoleAuditLog.createdAt)).limit(limit);
  }

  private async auditLog(username: string, role: string, action: string, actor?: string, details?: string): Promise<void> {
    await db.insert(trustedRoleAuditLog).values({
      username,
      role,
      action,
      actorUsername: actor || null,
      details: details || null,
    });
  }
}
