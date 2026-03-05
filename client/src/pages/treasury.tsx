import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2, Shield, ShieldCheck, Users, Wallet, ArrowRightLeft,
  Key, UserPlus, CheckCircle2, RefreshCw, Activity,
  Lock, Unlock, Hexagon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api-mode";

interface TreasuryStatus {
  operational: boolean;
  signerCount: number;
  onlineSignerCount: number;
  threshold: number;
  treasuryAccount: string;
  balance?: string;
  authorityInSync: boolean;
}

interface TreasurySignerInfo {
  username: string;
  status: string;
  weight: number;
  joinedAt: string | null;
  lastHeartbeat: string | null;
  online: boolean;
  vouchCount?: number;
}

interface TreasuryTransaction {
  id: string;
  txType: string;
  status: string;
  threshold: number;
  signatures: Record<string, string>;
  broadcastTxId: string | null;
  metadata: any;
  createdAt: string;
}

interface VouchCandidate {
  username: string;
  status: string;
  isSigner: boolean;
  vouchCount: number;
  requiredVouches: number;
  vouches: { voucher: string; voucherRank: number; createdAt: string }[];
}

function AuthorityRing({ signers, threshold, onlineCount }: {
  signers: TreasurySignerInfo[];
  threshold: number;
  onlineCount: number;
}) {
  const total = signers.length || 1;
  const segmentAngle = 360 / total;
  const radius = 80;
  const strokeWidth = 12;
  const center = 100;

  return (
    <div className="flex flex-col items-center gap-3">
      <svg viewBox="0 0 200 200" className="w-48 h-48">
        <circle cx={center} cy={center} r={radius} fill="none"
          stroke="currentColor" strokeWidth={strokeWidth}
          className="text-white/5" />

        {signers.map((signer, i) => {
          const startAngle = (i * segmentAngle - 90) * (Math.PI / 180);
          const endAngle = ((i + 1) * segmentAngle - 90 - 2) * (Math.PI / 180);
          const x1 = center + radius * Math.cos(startAngle);
          const y1 = center + radius * Math.sin(startAngle);
          const x2 = center + radius * Math.cos(endAngle);
          const y2 = center + radius * Math.sin(endAngle);
          const largeArc = segmentAngle > 182 ? 1 : 0;

          return (
            <Tooltip key={signer.username}>
              <TooltipTrigger asChild>
                <path
                  d={`M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`}
                  fill="none"
                  strokeWidth={strokeWidth}
                  strokeLinecap="round"
                  className={cn(
                    "transition-all duration-500 cursor-pointer",
                    signer.online
                      ? "stroke-green-500 hover:stroke-green-400"
                      : "stroke-muted-foreground/30 hover:stroke-muted-foreground/50"
                  )}
                />
              </TooltipTrigger>
              <TooltipContent>
                <p className="font-mono text-xs">@{signer.username}</p>
                <p className="text-xs text-muted-foreground">
                  {signer.online ? "Online — signing enabled" : "Offline"}
                  {signer.vouchCount ? ` · ${signer.vouchCount} vouches` : ""}
                </p>
              </TooltipContent>
            </Tooltip>
          );
        })}

        <text x={center} y={center - 12} textAnchor="middle"
          className="fill-foreground text-2xl font-bold" fontSize="28">
          {threshold}
        </text>
        <text x={center} y={center + 8} textAnchor="middle"
          className="fill-muted-foreground text-xs" fontSize="11">
          of {total}
        </text>
        <text x={center} y={center + 22} textAnchor="middle"
          className="fill-muted-foreground text-[10px]" fontSize="10">
          required
        </text>
      </svg>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          {onlineCount} online
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-muted-foreground/30" />
          {total - onlineCount} offline
        </span>
      </div>
    </div>
  );
}

function SignatureProgress({ sigCount, threshold }: { sigCount: number; threshold: number }) {
  const pct = Math.min(100, (sigCount / Math.max(threshold, 1)) * 100);
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <Progress value={pct} className="h-1.5 flex-1" />
      <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">
        {sigCount}/{threshold}
      </span>
    </div>
  );
}

export default function Treasury() {
  const { user, isValidator } = useValidatorAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const apiBase = getApiBase();
  const [vouchInput, setVouchInput] = useState("");

  const { data: status, isLoading: statusLoading } = useQuery<TreasuryStatus>({
    queryKey: ["treasury", "status"],
    queryFn: () => fetch(`${apiBase}/api/treasury/status`).then((r) => r.json()),
    refetchInterval: 10000,
  });

  const { data: signers } = useQuery<TreasurySignerInfo[]>({
    queryKey: ["treasury", "signers"],
    queryFn: () => fetch(`${apiBase}/api/treasury/signers`).then((r) => r.json()),
    refetchInterval: 10000,
  });

  const { data: transactions } = useQuery<TreasuryTransaction[]>({
    queryKey: ["treasury", "transactions"],
    queryFn: () =>
      fetch(`${apiBase}/api/treasury/transactions?limit=20`, {
        headers: { Authorization: `Bearer ${user?.sessionToken}` },
      }).then((r) => r.json()),
    enabled: !!user?.sessionToken,
    refetchInterval: 15000,
  });

  const { data: vouchData } = useQuery<VouchCandidate[]>({
    queryKey: ["treasury", "vouches"],
    queryFn: () => fetch(`${apiBase}/api/wot/treasury-vouches`).then((r) => r.json()),
    refetchInterval: 15000,
  });

  const joinMutation = useMutation({
    mutationFn: () =>
      fetch(`${apiBase}/api/treasury/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${user?.sessionToken}` },
      }).then((r) => r.json()),
    onSuccess: (data) => {
      if (data.success) {
        toast({ title: "Joined Treasury", description: data.message });
        queryClient.invalidateQueries({ queryKey: ["treasury"] });
      } else {
        toast({ title: "Cannot Join", description: data.error, variant: "destructive" });
      }
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () =>
      fetch(`${apiBase}/api/treasury/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${user?.sessionToken}` },
      }).then((r) => r.json()),
    onSuccess: (data) => {
      if (data.success) {
        toast({ title: "Left Treasury", description: data.message });
        queryClient.invalidateQueries({ queryKey: ["treasury"] });
      } else {
        toast({ title: "Cannot Leave", description: data.error, variant: "destructive" });
      }
    },
  });

  const vouchMutation = useMutation({
    mutationFn: (candidateUsername: string) =>
      fetch(`${apiBase}/api/wot/treasury-vouch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${user?.sessionToken}` },
        body: JSON.stringify({ candidateUsername }),
      }).then((r) => r.json()),
    onSuccess: (data) => {
      if (data.success) {
        toast({ title: "Vouch Submitted", description: data.message });
        queryClient.invalidateQueries({ queryKey: ["treasury"] });
        setVouchInput("");
      } else {
        toast({ title: "Vouch Failed", description: data.error, variant: "destructive" });
      }
    },
  });

  const isSigner = signers?.some((s) => s.username === user?.username);

  if (statusLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const threshold = status?.threshold || 0;
  const signerCount = status?.signerCount || 0;
  const onlineCount = status?.onlineSignerCount || 0;

  return (
    <div className="p-6 md:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-primary/10 text-primary">
            <Key className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-display font-bold">Multisig Treasury</h1>
            <p className="text-sm text-muted-foreground">
              {status?.treasuryAccount} — Hive L1 native multisig
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {user && !isSigner && (
            <Button
              onClick={() => joinMutation.mutate()}
              disabled={joinMutation.isPending}
              className="gap-2"
            >
              {joinMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              Join as Signer
            </Button>
          )}
          {user && isSigner && (
            <Button
              variant="outline"
              onClick={() => leaveMutation.mutate()}
              disabled={leaveMutation.isPending}
              className="gap-2"
            >
              {leaveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Leave Treasury
            </Button>
          )}
        </div>
      </div>

      {/* Status banner */}
      <div className={cn(
        "rounded-xl border p-4 flex items-center gap-4",
        status?.operational
          ? "border-green-500/20 bg-green-500/5"
          : "border-yellow-500/20 bg-yellow-500/5"
      )}>
        <div className={cn(
          "p-2 rounded-lg",
          status?.operational ? "bg-green-500/20 text-green-500" : "bg-yellow-500/20 text-yellow-500"
        )}>
          {status?.operational ? <Unlock className="h-5 w-5" /> : <Lock className="h-5 w-5" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            {status?.operational ? "Treasury Operational" : "Treasury Inactive"}
          </p>
          <p className="text-xs text-muted-foreground">
            {status?.operational
              ? `${onlineCount} of ${signerCount} signers online — ${threshold} signatures required per transaction`
              : !status?.authorityInSync
                ? "On-chain authority out of sync with signer set — self-healing in progress"
                : signerCount < 3
                  ? `Need at least 3 active signers (currently ${signerCount})`
                  : `Waiting for signers to come online (${onlineCount}/${signerCount})`}
          </p>
        </div>
        {status?.authorityInSync ? (
          <Badge variant="outline" className="text-green-500 border-green-500/30 shrink-0">
            <CheckCircle2 className="h-3 w-3 mr-1" /> Synced
          </Badge>
        ) : (
          <Badge variant="outline" className="text-yellow-500 border-yellow-500/30 shrink-0">
            <RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Syncing
          </Badge>
        )}
      </div>

      {/* Authority Ring + Stats */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Hexagon className="h-4 w-4 text-primary" />
              Authority Ring
            </CardTitle>
            <CardDescription>Each segment = one signer key slice</CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center pt-2">
            {signers?.length ? (
              <AuthorityRing signers={signers} threshold={threshold} onlineCount={onlineCount} />
            ) : (
              <div className="text-center py-8 text-muted-foreground text-sm">No signers yet</div>
            )}
          </CardContent>
        </Card>

        <div className="lg:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-2">
                <Users className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Signers</span>
              </div>
              <div className="text-2xl font-bold">
                {onlineCount}
                <span className="text-sm font-normal text-muted-foreground">/{signerCount}</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {signerCount > 0 ? `${Math.round((onlineCount / signerCount) * 100)}% online` : "None yet"}
              </p>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-2">
                <Shield className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Threshold</span>
              </div>
              <div className="text-2xl font-bold">{threshold}</div>
              <p className="text-[10px] text-muted-foreground mt-1">60% quorum</p>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-2">
                <Wallet className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Balance</span>
              </div>
              <div className="text-2xl font-bold truncate">{status?.balance || "0.000 HBD"}</div>
              <p className="text-[10px] text-muted-foreground mt-1">Treasury reserves</p>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-2">
                <Activity className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Broadcast</span>
              </div>
              <div className="text-2xl font-bold">
                {transactions?.filter((t) => t.status === "broadcast").length || 0}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">Successful txs</p>
            </CardContent>
          </Card>

          {/* Fluid key rotation row */}
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm col-span-2 md:col-span-4">
            <CardContent className="pt-5 pb-4">
              <div className="flex items-center gap-2 text-muted-foreground mb-3">
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="text-xs font-medium">Fluid Key Rotation</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {signers?.length ? signers.map((s) => (
                  <Tooltip key={s.username}>
                    <TooltipTrigger>
                      <div className={cn(
                        "px-2 py-1 rounded-md text-xs font-mono border transition-all",
                        s.online
                          ? "border-green-500/30 bg-green-500/10 text-green-500"
                          : "border-border/50 bg-muted/30 text-muted-foreground"
                      )}>
                        @{s.username}
                        <span className="ml-1 opacity-50">w:{s.weight}</span>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Weight: {s.weight} · {s.online ? "Online" : "Offline"}</p>
                      {s.joinedAt && <p className="text-xs text-muted-foreground">Joined {new Date(s.joinedAt).toLocaleDateString()}</p>}
                    </TooltipContent>
                  </Tooltip>
                )) : (
                  <span className="text-xs text-muted-foreground">
                    No signers — authority set when 3+ witnesses join
                  </span>
                )}
              </div>
              {signerCount > 0 && (
                <p className="text-[10px] text-muted-foreground mt-2">
                  Authority auto-updates when signers join or leave — threshold = ceil({signerCount} × 0.6) = {threshold}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Signers + WoT + Transactions */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Active Signers */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Active Signers</CardTitle>
            <CardDescription>Witnesses and WoT-vouched signers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {signers?.length ? signers.map((signer) => (
                <div key={signer.username}
                  className="flex items-center justify-between p-2.5 rounded-lg bg-background/50 hover:bg-background/80 transition-colors">
                  <div className="flex items-center gap-2.5">
                    <div className={cn(
                      "h-2 w-2 rounded-full shrink-0",
                      signer.online ? "bg-green-500" : "bg-muted-foreground/30"
                    )} />
                    <span className="font-mono text-sm">@{signer.username}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {(signer.vouchCount ?? 0) > 0 && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {signer.vouchCount} vouches
                      </Badge>
                    )}
                    <Badge variant={signer.online ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
                      {signer.online ? "Online" : "Offline"}
                    </Badge>
                  </div>
                </div>
              )) : (
                <p className="text-muted-foreground text-sm text-center py-6">No active signers yet</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* WoT Vouching */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-primary" />
              Web of Trust — Treasury
            </CardTitle>
            <CardDescription>
              Top-150 witnesses vouch for non-witness signer candidates. 3 vouches required.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {user && isValidator && (
              <div className="flex gap-2">
                <Input
                  placeholder="@username to vouch for"
                  value={vouchInput}
                  onChange={(e) => setVouchInput(e.target.value.replace("@", ""))}
                  className="text-sm"
                />
                <Button size="sm" disabled={!vouchInput.trim() || vouchMutation.isPending}
                  onClick={() => vouchMutation.mutate(vouchInput.trim())}>
                  {vouchMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Vouch"}
                </Button>
              </div>
            )}

            <div className="space-y-2">
              {vouchData?.length ? vouchData.map((candidate) => (
                <div key={candidate.username} className="p-3 rounded-lg bg-background/50 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm">@{candidate.username}</span>
                      {candidate.isSigner && (
                        <Badge variant="default" className="text-[10px] px-1.5 py-0">Signer</Badge>
                      )}
                    </div>
                    <span className={cn(
                      "text-xs font-medium",
                      candidate.vouchCount >= candidate.requiredVouches ? "text-green-500" : "text-muted-foreground"
                    )}>
                      {candidate.vouchCount}/{candidate.requiredVouches}
                    </span>
                  </div>
                  <Progress value={(candidate.vouchCount / candidate.requiredVouches) * 100} className="h-1" />
                  <div className="flex flex-wrap gap-1">
                    {candidate.vouches.map((v) => (
                      <Badge key={v.voucher} variant="outline" className="text-[10px] px-1.5 py-0">
                        @{v.voucher}
                        {v.voucherRank > 0 && <span className="ml-0.5 opacity-50">#{v.voucherRank}</span>}
                      </Badge>
                    ))}
                  </div>
                </div>
              )) : (
                <p className="text-muted-foreground text-sm text-center py-4">No treasury vouches yet</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Recent Transactions */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="text-base">Recent Transactions</CardTitle>
            <CardDescription>Multisig transfers and authority updates</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {transactions?.length ? transactions.map((tx) => {
                const sigCount = typeof tx.signatures === "object" ? Object.keys(tx.signatures).length : 0;
                return (
                  <div key={tx.id} className="p-2.5 rounded-lg bg-background/50 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {tx.txType === "transfer" ? (
                          <ArrowRightLeft className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                        ) : (
                          <Key className="h-3.5 w-3.5 text-yellow-500 shrink-0" />
                        )}
                        <span className="text-sm font-medium truncate">
                          {tx.txType === "transfer"
                            ? `${tx.metadata?.amount || "?"} → @${tx.metadata?.recipient || "?"}`
                            : "Authority Update"}
                        </span>
                      </div>
                      <Badge className="text-[10px] px-1.5 py-0 shrink-0"
                        variant={tx.status === "broadcast" ? "default" : tx.status === "signing" ? "secondary" : "destructive"}>
                        {tx.status}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between">
                      <SignatureProgress sigCount={sigCount} threshold={tx.threshold} />
                      <span className="text-[10px] text-muted-foreground ml-2">
                        {new Date(tx.createdAt).toLocaleTimeString()}
                      </span>
                    </div>
                    {tx.broadcastTxId && (
                      <p className="text-[10px] font-mono text-muted-foreground truncate">
                        tx: {tx.broadcastTxId}
                      </p>
                    )}
                  </div>
                );
              }) : (
                <p className="text-muted-foreground text-sm text-center py-6">
                  {user?.sessionToken ? "No transactions yet" : "Sign in to view transactions"}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* How it works */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="text-base">How Multisig Treasury Works</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
            <div className="space-y-2">
              <div className="flex items-center gap-2 font-medium">
                <Shield className="h-4 w-4 text-primary" />
                Fluid Authority
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                When signers join or leave, the on-chain authority automatically updates.
                Each signer holds weight 1. Threshold = ceil(N × 0.6). If 5 signers exist,
                3 must sign. If a 6th joins, threshold becomes 4. Keys rotate fluidly.
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 font-medium">
                <Users className="h-4 w-4 text-primary" />
                DPoS + Web of Trust
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Top-150 Hive witnesses join directly — they ARE the trust layer.
                Non-witnesses need 3 vouches from top-150 witnesses to qualify.
                If a witness drops from top-150, their vouches auto-revoke and the
                signer set self-heals.
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2 font-medium">
                <Lock className="h-4 w-4 text-primary" />
                Churn Protection
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Leaving triggers a 7-day cooldown before rejoining. If a signer
                opts out more than 3 times in 90 days, the cooldown escalates to 30 days.
                This prevents authority thrashing while keeping the system open.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
