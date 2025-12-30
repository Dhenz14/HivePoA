import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TrendingUp, TrendingDown, Coins, Flame, AlertTriangle, CheckCircle2, XCircle, Clock, Zap, Trophy, Shield } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";

interface EarningsData {
  todayEarnings: number;
  weeklyEarnings: number;
  projectedMonthly: number;
  currentStreak: number;
  streakTarget: number;
  bonusMultiplier: number;
  consecutiveFails: number;
  earningsHistory: { date: string; hbd: number }[];
}

interface LiveChallenge {
  id: string;
  nodeUsername: string;
  fileName: string;
  latencyMs: number;
  result: "pass" | "fail";
  timestamp: string;
}

interface ChallengeStats {
  successRateLastHour: number;
  successRate24h: number;
  avgLatency: number;
  challenges: LiveChallenge[];
}

interface FileEarning {
  id: string;
  fileName: string;
  cid: string;
  earnedHbd: number;
  rarityMultiplier: number;
  roiScore: number;
  replicaCount: number;
}

async function fetchEarnings(username: string): Promise<EarningsData> {
  const res = await fetch(`/api/earnings/${username}`);
  if (!res.ok) {
    return {
      todayEarnings: 0.847,
      weeklyEarnings: 5.234,
      projectedMonthly: 22.45,
      currentStreak: 47,
      streakTarget: 50,
      bonusMultiplier: 1.25,
      consecutiveFails: 0,
      earningsHistory: [
        { date: "Mon", hbd: 0.65 },
        { date: "Tue", hbd: 0.82 },
        { date: "Wed", hbd: 0.71 },
        { date: "Thu", hbd: 0.93 },
        { date: "Fri", hbd: 0.88 },
        { date: "Sat", hbd: 0.78 },
        { date: "Sun", hbd: 0.85 },
      ],
    };
  }
  return res.json();
}

async function fetchLiveChallenges(): Promise<ChallengeStats> {
  const res = await fetch("/api/challenges/live");
  if (!res.ok) {
    return {
      successRateLastHour: 98.5,
      successRate24h: 97.2,
      avgLatency: 245,
      challenges: [
        { id: "1", nodeUsername: "storage_node_1", fileName: "video_001.mp4", latencyMs: 180, result: "pass", timestamp: "2 min ago" },
        { id: "2", nodeUsername: "ipfs_keeper", fileName: "podcast_ep45.mp3", latencyMs: 320, result: "pass", timestamp: "5 min ago" },
        { id: "3", nodeUsername: "hive_storage", fileName: "doc_backup.pdf", latencyMs: 1650, result: "fail", timestamp: "8 min ago" },
        { id: "4", nodeUsername: "decen_host", fileName: "image_gallery.zip", latencyMs: 145, result: "pass", timestamp: "12 min ago" },
        { id: "5", nodeUsername: "storage_node_1", fileName: "stream_vod.mp4", latencyMs: 210, result: "pass", timestamp: "15 min ago" },
      ],
    };
  }
  return res.json();
}

async function fetchFileEarnings(): Promise<FileEarning[]> {
  const res = await fetch("/api/files/marketplace");
  if (!res.ok) {
    return [
      { id: "1", fileName: "popular_video.mp4", cid: "QmX7d8f9a2b3c4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0", earnedHbd: 1.245, rarityMultiplier: 1.5, roiScore: 89, replicaCount: 2 },
      { id: "2", fileName: "trending_podcast.mp3", cid: "QmY8e9g0h1i2j3k4l5m6n7o8p9q0r1s2t3u4v5w6x7y8z9", earnedHbd: 0.892, rarityMultiplier: 1.0, roiScore: 72, replicaCount: 5 },
      { id: "3", fileName: "rare_document.pdf", cid: "QmZ9f0g1h2i3j4k5l6m7n8o9p0q1r2s3t4u5v6w7x8y9z0", earnedHbd: 0.654, rarityMultiplier: 2.0, roiScore: 95, replicaCount: 1 },
      { id: "4", fileName: "community_backup.zip", cid: "QmA0g1h2i3j4k5l6m7n8o9p0q1r2s3t4u5v6w7x8y9z0a1", earnedHbd: 0.423, rarityMultiplier: 1.25, roiScore: 65, replicaCount: 3 },
      { id: "5", fileName: "legacy_archive.tar", cid: "QmB1h2i3j4k5l6m7n8o9p0q1r2s3t4u5v6w7x8y9z0a1b2", earnedHbd: 0.312, rarityMultiplier: 1.0, roiScore: 58, replicaCount: 7 },
    ];
  }
  return res.json();
}

function getStreakTier(streak: number): { tier: string; next: number; bonus: string } {
  if (streak >= 100) return { tier: "Diamond", next: 100, bonus: "1.5x" };
  if (streak >= 50) return { tier: "Gold", next: 100, bonus: "1.25x" };
  if (streak >= 25) return { tier: "Silver", next: 50, bonus: "1.1x" };
  return { tier: "Bronze", next: 25, bonus: "1x" };
}

function truncateCid(cid: string): string {
  if (cid.length <= 12) return cid;
  return `${cid.slice(0, 6)}...${cid.slice(-4)}`;
}

export default function Earnings() {
  const { data: earnings } = useQuery({
    queryKey: ["earnings", "demo_user"],
    queryFn: () => fetchEarnings("demo_user"),
    refetchInterval: 5000,
  });

  const { data: challengeStats } = useQuery({
    queryKey: ["challenges", "live"],
    queryFn: fetchLiveChallenges,
    refetchInterval: 5000,
  });

  const { data: fileEarnings = [] } = useQuery({
    queryKey: ["files", "marketplace"],
    queryFn: fetchFileEarnings,
    refetchInterval: 5000,
  });

  const streakInfo = getStreakTier(earnings?.currentStreak || 0);
  const streakProgress = earnings ? ((earnings.currentStreak % (streakInfo.next === 100 && earnings.currentStreak >= 50 ? 50 : streakInfo.next)) / (streakInfo.next === 100 && earnings.currentStreak >= 50 ? 50 : streakInfo.next)) * 100 : 0;

  const sortedFileEarnings = [...fileEarnings].sort((a, b) => b.earnedHbd - a.earnedHbd);

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold">Earnings Dashboard</h1>
          <p className="text-muted-foreground mt-1">Track your HBD earnings from storage challenges</p>
        </div>
        <div className="flex gap-2">
          <span className="px-3 py-1 bg-primary/10 text-primary text-xs rounded-full font-mono flex items-center gap-2 border border-primary/20">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Live Updates
          </span>
        </div>
      </div>

      {/* Top Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Today's Earnings"
          value={earnings?.todayEarnings.toFixed(3) || "0.000"}
          unit="HBD"
          icon={Coins}
          trend={earnings && earnings.todayEarnings > 0.5 ? "+12%" : "-5%"}
          trendUp={earnings && earnings.todayEarnings > 0.5}
          testId="card-today-earnings"
        />
        <StatsCard
          title="Weekly Earnings"
          value={earnings?.weeklyEarnings.toFixed(3) || "0.000"}
          unit="HBD"
          icon={TrendingUp}
          sub="Last 7 days"
          testId="card-weekly-earnings"
        />
        <StatsCard
          title="Projected Monthly"
          value={earnings?.projectedMonthly.toFixed(2) || "0.00"}
          unit="HBD"
          icon={Zap}
          sub="Based on current rate"
          testId="card-projected-monthly"
        />
        <StatsCard
          title="Current Streak"
          value={earnings?.currentStreak.toString() || "0"}
          unit="days"
          icon={Flame}
          badge={streakInfo.bonus}
          badgeVariant="default"
          testId="card-current-streak"
        />
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Streak & Risk Tracker */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-streak-tracker">
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2">
              <Trophy className="w-5 h-5 text-yellow-500" />
              Streak & Risk Tracker
            </CardTitle>
            <CardDescription>Maintain your streak for bonus multipliers</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Large Streak Counter */}
            <div className="flex items-center justify-between">
              <div>
                <div className="text-5xl font-bold font-display tracking-tight">
                  {earnings?.currentStreak || 0}
                  <span className="text-2xl text-muted-foreground">/{streakInfo.next}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {streakInfo.next - (earnings?.currentStreak || 0)} days to {streakInfo.tier === "Diamond" ? "maintain Diamond" : `next tier (${streakInfo.tier === "Bronze" ? "Silver" : streakInfo.tier === "Silver" ? "Gold" : "Diamond"})`}
                </p>
              </div>
              <Badge 
                className={cn(
                  "text-lg px-4 py-2",
                  earnings?.bonusMultiplier === 1.5 ? "bg-purple-500" :
                  earnings?.bonusMultiplier === 1.25 ? "bg-yellow-500" :
                  earnings?.bonusMultiplier === 1.1 ? "bg-gray-400" :
                  "bg-amber-700"
                )}
                data-testid="badge-bonus-multiplier"
              >
                {earnings?.bonusMultiplier || 1}x Bonus
              </Badge>
            </div>

            {/* Progress Bar */}
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Progress to next tier</span>
                <span className="font-medium">{streakProgress.toFixed(0)}%</span>
              </div>
              <Progress value={streakProgress} className="h-3" data-testid="progress-streak" />
            </div>

            {/* Ban Risk Indicator */}
            <div className={cn(
              "p-4 rounded-lg border",
              earnings && earnings.consecutiveFails >= 2 
                ? "bg-red-500/10 border-red-500/50" 
                : earnings && earnings.consecutiveFails >= 1
                  ? "bg-yellow-500/10 border-yellow-500/50"
                  : "bg-green-500/10 border-green-500/50"
            )}>
              <div className="flex items-center gap-3">
                <Shield className={cn(
                  "w-5 h-5",
                  earnings && earnings.consecutiveFails >= 2 ? "text-red-500" :
                  earnings && earnings.consecutiveFails >= 1 ? "text-yellow-500" :
                  "text-green-500"
                )} />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Ban Risk Status</span>
                    <Badge 
                      variant="outline" 
                      className={cn(
                        earnings && earnings.consecutiveFails >= 2 ? "border-red-500 text-red-500" :
                        earnings && earnings.consecutiveFails >= 1 ? "border-yellow-500 text-yellow-500" :
                        "border-green-500 text-green-500"
                      )}
                      data-testid="badge-consecutive-fails"
                    >
                      {earnings?.consecutiveFails || 0}/3 Failures
                    </Badge>
                  </div>
                  {earnings && earnings.consecutiveFails >= 2 && (
                    <p className="text-sm text-red-500 mt-2 flex items-center gap-2" data-testid="text-ban-warning">
                      <AlertTriangle className="w-4 h-4" />
                      Warning: {earnings.consecutiveFails}/3 failures - fix IPFS connection!
                    </p>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Challenge Activity Feed */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-challenge-feed">
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2">
              <Clock className="w-5 h-5 text-primary" />
              Challenge Activity Feed
            </CardTitle>
            <CardDescription>Live updates from recent challenges</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Success Rate Stats */}
            <div className="grid grid-cols-3 gap-4 p-3 bg-background/50 rounded-lg border border-border/30">
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Last Hour</p>
                <p className="text-lg font-bold text-green-500" data-testid="text-success-rate-hour">
                  {challengeStats?.successRateLastHour.toFixed(1) || 0}%
                </p>
              </div>
              <div className="text-center border-x border-border/30">
                <p className="text-xs text-muted-foreground">24h Rate</p>
                <p className="text-lg font-bold text-green-500" data-testid="text-success-rate-24h">
                  {challengeStats?.successRate24h.toFixed(1) || 0}%
                </p>
              </div>
              <div className="text-center">
                <p className="text-xs text-muted-foreground">Avg Latency</p>
                <p className={cn(
                  "text-lg font-bold",
                  challengeStats && challengeStats.avgLatency > 1500 ? "text-red-500" : "text-primary"
                )} data-testid="text-avg-latency">
                  {challengeStats?.avgLatency || 0}ms
                </p>
                {challengeStats && challengeStats.avgLatency > 1500 && (
                  <Tooltip>
                    <TooltipTrigger>
                      <AlertTriangle className="w-3 h-3 text-red-500 inline ml-1" />
                    </TooltipTrigger>
                    <TooltipContent>Latency too high! May cause failures.</TooltipContent>
                  </Tooltip>
                )}
              </div>
            </div>

            {/* Live Feed */}
            <div className="space-y-2 max-h-[280px] overflow-y-auto">
              <AnimatePresence>
                {challengeStats?.challenges.map((challenge) => (
                  <motion.div
                    key={challenge.id}
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center justify-between p-3 rounded-lg bg-background/50 border border-border/30 text-xs"
                    data-testid={`challenge-item-${challenge.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "w-2 h-2 rounded-full",
                        challenge.result === "pass" ? "bg-green-500 shadow-[0_0_8px_#22c55e]" : "bg-red-500 shadow-[0_0_8px_#ef4444]"
                      )} />
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          <span className="text-primary">@{challenge.nodeUsername}</span>
                          <span className="text-muted-foreground">•</span>
                          <span className="font-mono text-muted-foreground truncate max-w-[120px]">{challenge.fileName}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
                          <span>Latency: {challenge.latencyMs}ms</span>
                          <span>•</span>
                          <span>{challenge.timestamp}</span>
                        </div>
                      </div>
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px] px-2 py-0.5",
                        challenge.result === "pass" 
                          ? "border-green-500/30 text-green-500" 
                          : "border-red-500/30 text-red-500"
                      )}
                    >
                      {challenge.result === "pass" ? (
                        <><CheckCircle2 className="w-3 h-3 mr-1" />Pass</>
                      ) : (
                        <><XCircle className="w-3 h-3 mr-1" />Fail</>
                      )}
                    </Badge>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Earnings Chart */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-earnings-chart">
        <CardHeader>
          <CardTitle className="font-display">Earnings Over Time</CardTitle>
          <CardDescription>Your HBD earnings for the past week</CardDescription>
        </CardHeader>
        <CardContent className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={earnings?.earningsHistory || []}>
              <defs>
                <linearGradient id="colorHbd" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <XAxis 
                dataKey="date" 
                stroke="hsl(var(--muted-foreground))" 
                fontSize={12} 
                tickLine={false} 
                axisLine={false} 
              />
              <YAxis 
                stroke="hsl(var(--muted-foreground))" 
                fontSize={12} 
                tickLine={false} 
                axisLine={false}
                tickFormatter={(value) => `${value} HBD`}
              />
              <RechartsTooltip
                contentStyle={{ 
                  backgroundColor: 'hsl(var(--card))', 
                  borderColor: 'hsl(var(--border))',
                  borderRadius: '8px'
                }}
                itemStyle={{ color: 'hsl(var(--foreground))' }}
                formatter={(value: number) => [`${value.toFixed(3)} HBD`, 'Earnings']}
              />
              <Line 
                type="monotone" 
                dataKey="hbd" 
                stroke="hsl(var(--primary))" 
                strokeWidth={2}
                dot={{ fill: 'hsl(var(--primary))', strokeWidth: 2 }}
                activeDot={{ r: 6, fill: 'hsl(var(--primary))' }}
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Per-File Earnings Table */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-file-earnings">
        <CardHeader>
          <CardTitle className="font-display">Per-File Earnings</CardTitle>
          <CardDescription>Earnings breakdown by file, sorted by highest earnings</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File Name</TableHead>
                <TableHead>CID</TableHead>
                <TableHead className="text-right">Earned HBD</TableHead>
                <TableHead className="text-right">Rarity</TableHead>
                <TableHead className="text-right">ROI Score</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedFileEarnings.map((file) => (
                <TableRow key={file.id} data-testid={`row-file-${file.id}`}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {file.fileName}
                      {file.replicaCount < 3 && (
                        <Tooltip>
                          <TooltipTrigger>
                            <Badge variant="secondary" className="bg-purple-500/20 text-purple-400 text-[10px]">
                              Rare
                            </Badge>
                          </TooltipTrigger>
                          <TooltipContent>Only {file.replicaCount} replica(s) on the network</TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger>
                        <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                          {truncateCid(file.cid)}
                        </code>
                      </TooltipTrigger>
                      <TooltipContent className="font-mono text-xs">{file.cid}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="text-right font-bold text-green-500">
                    {file.earnedHbd.toFixed(3)} HBD
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge 
                      variant="outline" 
                      className={cn(
                        file.rarityMultiplier >= 2.0 ? "border-purple-500 text-purple-500" :
                        file.rarityMultiplier >= 1.25 ? "border-yellow-500 text-yellow-500" :
                        "border-muted-foreground text-muted-foreground"
                      )}
                    >
                      {file.rarityMultiplier}x
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Progress value={file.roiScore} className="w-16 h-2" />
                      <span className={cn(
                        "text-sm font-medium",
                        file.roiScore >= 80 ? "text-green-500" :
                        file.roiScore >= 60 ? "text-yellow-500" :
                        "text-muted-foreground"
                      )}>
                        {file.roiScore}
                      </span>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

interface StatsCardProps {
  title: string;
  value: string;
  unit: string;
  icon: React.ElementType;
  trend?: string;
  trendUp?: boolean;
  sub?: string;
  badge?: string;
  badgeVariant?: "default" | "secondary" | "outline";
  testId?: string;
}

function StatsCard({ title, value, unit, icon: Icon, trend, trendUp, sub, badge, badgeVariant, testId }: StatsCardProps) {
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm hover:border-primary/50 transition-colors group" data-testid={testId}>
      <CardContent className="p-6">
        <div className="flex justify-between items-start mb-4">
          <div className="p-2 bg-primary/5 rounded-lg text-primary group-hover:bg-primary/10 transition-colors">
            <Icon className="w-5 h-5" />
          </div>
          {trend && (
            <div className={cn(
              "flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full",
              trendUp ? "text-green-500 bg-green-500/10" : "text-red-500 bg-red-500/10"
            )}>
              {trendUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {trend}
            </div>
          )}
          {badge && (
            <Badge variant={badgeVariant || "default"} className="bg-primary text-primary-foreground">
              {badge}
            </Badge>
          )}
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <div className="flex items-baseline gap-1 mt-1">
            <h3 className="text-2xl font-bold font-display tracking-tight">{value}</h3>
            <span className="text-sm text-muted-foreground font-medium">{unit}</span>
          </div>
          {sub && <p className="text-xs text-muted-foreground mt-2">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
