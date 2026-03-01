import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "./use-toast";
import { getApiBase, hasBackend } from "@/lib/api-mode";

interface EarningsData {
  node: {
    username: string;
    reputation: number;
    status: string;
    consecutiveFails: number;
    totalEarnedHbd: number;
  };
  streak: {
    current: number;
    max: number;
    bonus: number;
    bonusPercent: number;
    nextTier: number;
  };
  risk: {
    consecutiveFails: number;
    maxFails: number;
    isBanned: boolean;
    isProbation: boolean;
    banRisk: string;
  };
  earnings: {
    today: number;
    week: number;
    total: number;
  };
}

const ALERT_STORAGE_KEY = "spk_alert_state";

interface AlertState {
  lastStreak: number;
  lastEarningsTotal: number;
  lastBanWarningShown: number;
  shownMilestones: string[];
}

function getAlertState(): AlertState {
  try {
    const stored = localStorage.getItem(ALERT_STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {}
  return {
    lastStreak: 0,
    lastEarningsTotal: 0,
    lastBanWarningShown: 0,
    shownMilestones: [],
  };
}

function saveAlertState(state: AlertState) {
  try {
    localStorage.setItem(ALERT_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

export function useAlerts(username: string = "demo_user", enabled: boolean = true) {
  const alertStateRef = useRef<AlertState>(getAlertState());

  const { data: earningsData } = useQuery<EarningsData>({
    queryKey: ["earnings-dashboard", username],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/earnings/dashboard/${username}`);
      if (!res.ok) throw new Error("Failed to fetch earnings");
      return res.json();
    },
    enabled: enabled && hasBackend(),
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (!earningsData || !enabled) return;
    if (!earningsData.streak || !earningsData.earnings || !earningsData.risk) return;

    const state = alertStateRef.current;
    if (!state) return;
    
    const streak = earningsData.streak.current || 0;
    const totalEarned = earningsData.earnings.total || 0;
    const consecutiveFails = earningsData.risk.consecutiveFails || 0;
    const now = Date.now();

    const STREAK_TIERS = [10, 50, 100];
    for (const tier of STREAK_TIERS) {
      const milestoneKey = `streak_${tier}`;
      if (streak >= tier && state.lastStreak < tier && !state.shownMilestones.includes(milestoneKey)) {
        const bonusText = tier === 10 ? "+10% bonus" : tier === 50 ? "+25% bonus" : "+50% bonus";
        const tierName = tier === 10 ? "Bronze" : tier === 50 ? "Silver" : tier === 100 ? "Gold" : "Diamond";
        toast({
          title: `${tierName} Streak Achieved!`,
          description: `You hit ${tier} consecutive proofs! ${bonusText} now active!`,
          variant: "default",
        });
        state.shownMilestones.push(milestoneKey);
      }
    }

    if (consecutiveFails >= 2 && now - state.lastBanWarningShown > 60000) {
      toast({
        title: "Ban Risk Warning!",
        description: `You have ${consecutiveFails}/3 consecutive failures. Fix your IPFS connection!`,
        variant: "destructive",
      });
      state.lastBanWarningShown = now;
    }

    if (consecutiveFails >= 1 && consecutiveFails < 2 && state.lastBanWarningShown === 0) {
      toast({
        title: "Challenge Failed",
        description: "1 consecutive failure. Check your node if this continues.",
        variant: "default",
      });
      state.lastBanWarningShown = now;
    }

    if (earningsData.risk.isBanned && !state.shownMilestones.includes("banned")) {
      toast({
        title: "Node Banned",
        description: "Your node has been banned due to 3 consecutive failures. Wait 24h for cooldown.",
        variant: "destructive",
      });
      state.shownMilestones.push("banned");
    }

    const EARNINGS_MILESTONES = [0.01, 0.1, 1, 10, 100];
    for (const milestone of EARNINGS_MILESTONES) {
      const milestoneKey = `earnings_${milestone}`;
      if (totalEarned >= milestone && state.lastEarningsTotal < milestone && !state.shownMilestones.includes(milestoneKey)) {
        toast({
          title: "Earnings Milestone!",
          description: `You've earned ${milestone} HBD total! Keep storing!`,
          variant: "default",
        });
        state.shownMilestones.push(milestoneKey);
      }
    }

    state.lastStreak = streak;
    state.lastEarningsTotal = totalEarned;

    if (streak === 0) {
      state.shownMilestones = state.shownMilestones.filter(m => !m.startsWith("streak_"));
    }

    alertStateRef.current = state;
    saveAlertState(state);
  }, [earningsData, enabled]);

  return { earningsData };
}
