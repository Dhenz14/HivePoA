import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TrendingUp, TrendingDown, Activity, Gauge, Clock, AlertTriangle, CheckCircle2, Lightbulb, Server, Network, Zap } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, Area, AreaChart } from "recharts";
import { cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api-mode";

interface PerformanceData {
  proofsPerHour: number;
  proofsTrend: number;
  bandwidthPerHour: number;
  avgLatency: number;
  minLatency: number;
  maxLatency: number;
  healthyNodes: number;
  atRiskNodes: number;
  totalNodes: number;
  yourRank: number;
  successRateTrend: { hour: number; successRate: number; challengeCount: number }[];
  totalChallenges24h: number;
  successRate24h: number;
  failedChallenges24h: number;
}

async function fetchPerformanceData(): Promise<PerformanceData> {
  const res = await fetch(`${getApiBase()}/api/analytics/performance`);
  if (!res.ok) {
    return {
      proofsPerHour: 0,
      proofsTrend: 0,
      bandwidthPerHour: 0,
      avgLatency: 0,
      minLatency: 0,
      maxLatency: 0,
      healthyNodes: 0,
      atRiskNodes: 0,
      totalNodes: 0,
      yourRank: 1,
      successRateTrend: [],
      totalChallenges24h: 0,
      successRate24h: 0,
      failedChallenges24h: 0,
    };
  }
  const data = await res.json();
  
  const totalChallenges = data.trends?.reduce((sum: number, t: any) => sum + (t.challenges || 0), 0) || 0;
  const avgSuccessRate = data.trends?.length > 0
    ? data.trends.reduce((sum: number, t: any) => sum + (t.successRate || 0), 0) / data.trends.length
    : 0;
  
  return {
    proofsPerHour: data.proofsPerHour || 0,
    proofsTrend: data.proofsTrend || 0,
    bandwidthPerHour: data.bandwidthPerHour || 0,
    avgLatency: data.latency?.avg || 0,
    minLatency: data.latency?.min || 0,
    maxLatency: data.latency?.max || 0,
    healthyNodes: data.nodes?.healthy || 0,
    atRiskNodes: data.nodes?.atRisk || 0,
    totalNodes: data.nodes?.total || 0,
    yourRank: data.yourRank || 0,
    successRateTrend: (data.trends || []).map((t: any) => ({
      hour: t.hour,
      successRate: t.successRate || 0,
      challengeCount: t.challenges || 0,
    })),
    totalChallenges24h: totalChallenges,
    successRate24h: avgSuccessRate,
    failedChallenges24h: Math.round(totalChallenges * (100 - avgSuccessRate) / 100),
  };
}

function formatBandwidth(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function Analytics() {
  const { data: performance, isLoading } = useQuery({
    queryKey: ["analytics", "performance"],
    queryFn: fetchPerformanceData,
    refetchInterval: 10000,
  });

  if (isLoading || !performance) {
    return (
      <div className="p-8 space-y-8 max-w-7xl mx-auto">
        <div className="flex justify-between items-end">
          <div>
            <h1 className="text-3xl font-display font-bold">Performance Analytics</h1>
            <p className="text-muted-foreground mt-1">Loading analytics data...</p>
          </div>
        </div>
      </div>
    );
  }

  const isLatencyHigh = performance.avgLatency > 1500;
  const hasManyFails = performance.failedChallenges24h > 50 || performance.successRate24h < 95;
  const isPerformingWell = performance.successRate24h >= 98 && performance.avgLatency < 500;

  const suggestions: { type: "warning" | "error" | "success"; message: string }[] = [];
  if (isLatencyHigh) {
    suggestions.push({ type: "warning", message: "Consider moving IPFS node closer to validators" });
  }
  if (hasManyFails) {
    suggestions.push({ type: "error", message: "Check IPFS daemon health and connectivity" });
  }
  if (isPerformingWell) {
    suggestions.push({ type: "success", message: "Your node is performing well!" });
  }
  if (suggestions.length === 0) {
    suggestions.push({ type: "success", message: "Node performance is within acceptable range" });
  }

  const latencyMaxAcceptable = 2000;
  const latencyPosition = Math.min((performance.avgLatency / latencyMaxAcceptable) * 100, 100);

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-analytics">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold" data-testid="text-page-title">Performance Analytics</h1>
          <p className="text-muted-foreground mt-1">Monitor your storage node health and performance</p>
        </div>
        <div className="flex gap-2">
          <span className="px-3 py-1 bg-primary/10 text-primary text-xs rounded-full font-mono flex items-center gap-2 border border-primary/20">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Auto-refresh: 10s
          </span>
        </div>
      </div>

      {/* Key Metrics Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="metrics-row">
        <MetricCard
          title="Proofs/Hour"
          value={performance.proofsPerHour.toString()}
          icon={Activity}
          trend={performance.proofsTrend}
          testId="card-proofs-hour"
        />
        <MetricCard
          title="Bandwidth/Hour"
          value={formatBandwidth(performance.bandwidthPerHour)}
          icon={Zap}
          testId="card-bandwidth-hour"
        />
        <MetricCard
          title="Average Latency"
          value={`${performance.avgLatency}ms`}
          icon={Clock}
          warning={isLatencyHigh}
          warningText="High latency detected"
          testId="card-avg-latency"
        />
        <MetricCard
          title="Node Health"
          value={`${performance.healthyNodes}/${performance.totalNodes}`}
          icon={Server}
          sub={`${performance.atRiskNodes} at-risk`}
          atRisk={performance.atRiskNodes > 0}
          testId="card-node-health"
        />
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Success Rate Trend Chart */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm lg:col-span-2" data-testid="card-success-rate-chart">
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2">
              <Gauge className="w-5 h-5 text-primary" />
              Success Rate Trend (24 Hours)
            </CardTitle>
            <CardDescription>
              Success rate and challenge count over the last 24 hours
            </CardDescription>
          </CardHeader>
          <CardContent className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={performance.successRateTrend}>
                <defs>
                  <linearGradient id="colorSuccessRate" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorChallengeCount" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#22c55e" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="hour"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => `${value}h`}
                />
                <YAxis
                  yAxisId="left"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  domain={[85, 100]}
                  tickFormatter={(value) => `${value}%`}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value) => value}
                />
                <RechartsTooltip
                  contentStyle={{
                    backgroundColor: "hsl(var(--card))",
                    borderColor: "hsl(var(--border))",
                    borderRadius: "8px",
                  }}
                  itemStyle={{ color: "hsl(var(--foreground))" }}
                  formatter={(value: number, name: string) => [
                    name === "successRate" ? `${value.toFixed(1)}%` : value,
                    name === "successRate" ? "Success Rate" : "Challenges",
                  ]}
                  labelFormatter={(label) => `Hour ${label}`}
                />
                <Area
                  yAxisId="right"
                  type="monotone"
                  dataKey="challengeCount"
                  stroke="#22c55e"
                  strokeWidth={1}
                  fill="url(#colorChallengeCount)"
                  dot={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="successRate"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, fill: "hsl(var(--primary))" }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Latency Distribution Card */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-latency-distribution">
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2">
              <Clock className="w-5 h-5 text-primary" />
              Latency Distribution
            </CardTitle>
            <CardDescription>Min, average, and max response times</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Stats Grid */}
            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="p-3 bg-background/50 rounded-lg border border-border/30">
                <p className="text-xs text-muted-foreground">Min</p>
                <p className="text-xl font-bold text-green-500" data-testid="text-latency-min">
                  {performance.minLatency}ms
                </p>
              </div>
              <div className="p-3 bg-background/50 rounded-lg border border-border/30">
                <p className="text-xs text-muted-foreground">Avg</p>
                <p className={cn("text-xl font-bold", isLatencyHigh ? "text-red-500" : "text-primary")} data-testid="text-latency-avg">
                  {performance.avgLatency}ms
                </p>
              </div>
              <div className="p-3 bg-background/50 rounded-lg border border-border/30">
                <p className="text-xs text-muted-foreground">Max</p>
                <p className={cn("text-xl font-bold", performance.maxLatency > 1500 ? "text-yellow-500" : "text-muted-foreground")} data-testid="text-latency-max">
                  {performance.maxLatency}ms
                </p>
              </div>
            </div>

            {/* Visual Range Bar */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>0ms</span>
                <span>Acceptable Range</span>
                <span>2000ms</span>
              </div>
              <div className="relative h-4 bg-gradient-to-r from-green-500 via-yellow-500 to-red-500 rounded-full overflow-hidden">
                <div
                  className="absolute top-0 h-full w-1 bg-white shadow-lg"
                  style={{ left: `${latencyPosition}%` }}
                  data-testid="indicator-latency-position"
                />
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-green-500">Good</span>
                <span className="text-yellow-500">Warning</span>
                <span className="text-red-500">Critical</span>
              </div>
            </div>

            {/* Warning Message */}
            {isLatencyHigh && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 flex items-center gap-2" data-testid="alert-high-latency">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                <span className="text-sm text-red-500">
                  Average latency exceeds 1500ms threshold. Performance may be degraded.
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Optimization Suggestions Card */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-optimization-suggestions">
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2">
              <Lightbulb className="w-5 h-5 text-yellow-500" />
              Optimization Suggestions
            </CardTitle>
            <CardDescription>Recommendations based on your node performance</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {suggestions.map((suggestion, index) => (
              <div
                key={index}
                className={cn(
                  "p-4 rounded-lg border flex items-start gap-3",
                  suggestion.type === "success" && "bg-green-500/10 border-green-500/30",
                  suggestion.type === "warning" && "bg-yellow-500/10 border-yellow-500/30",
                  suggestion.type === "error" && "bg-red-500/10 border-red-500/30"
                )}
                data-testid={`suggestion-${index}`}
              >
                {suggestion.type === "success" && <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />}
                {suggestion.type === "warning" && <AlertTriangle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />}
                {suggestion.type === "error" && <AlertTriangle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />}
                <span className={cn(
                  "text-sm",
                  suggestion.type === "success" && "text-green-500",
                  suggestion.type === "warning" && "text-yellow-500",
                  suggestion.type === "error" && "text-red-500"
                )}>
                  {suggestion.message}
                </span>
              </div>
            ))}

            {/* Quick Stats */}
            <div className="pt-4 border-t border-border/30 grid grid-cols-2 gap-4 mt-4">
              <div className="text-center p-3 bg-background/50 rounded-lg">
                <p className="text-2xl font-bold text-primary" data-testid="text-success-rate">
                  {performance.successRate24h.toFixed(1)}%
                </p>
                <p className="text-xs text-muted-foreground">24h Success Rate</p>
              </div>
              <div className="text-center p-3 bg-background/50 rounded-lg">
                <p className="text-2xl font-bold text-muted-foreground" data-testid="text-total-challenges">
                  {performance.totalChallenges24h.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">Total Challenges</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Network Overview Card */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-network-overview">
        <CardHeader>
          <CardTitle className="font-display flex items-center gap-2">
            <Network className="w-5 h-5 text-primary" />
            Network Overview
          </CardTitle>
          <CardDescription>Your position in the storage operator network</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div className="text-center p-4 bg-background/50 rounded-lg border border-border/30">
              <Server className="w-6 h-6 mx-auto text-primary mb-2" />
              <p className="text-3xl font-bold" data-testid="text-total-nodes">{performance.totalNodes}</p>
              <p className="text-xs text-muted-foreground mt-1">Total Nodes</p>
            </div>
            <div className="text-center p-4 bg-background/50 rounded-lg border border-border/30">
              <CheckCircle2 className="w-6 h-6 mx-auto text-green-500 mb-2" />
              <p className="text-3xl font-bold text-green-500" data-testid="text-healthy-nodes">{performance.healthyNodes}</p>
              <p className="text-xs text-muted-foreground mt-1">Healthy Nodes</p>
            </div>
            <div className="text-center p-4 bg-background/50 rounded-lg border border-border/30">
              <AlertTriangle className="w-6 h-6 mx-auto text-yellow-500 mb-2" />
              <p className="text-3xl font-bold text-yellow-500" data-testid="text-at-risk-nodes">{performance.atRiskNodes}</p>
              <p className="text-xs text-muted-foreground mt-1">At-Risk Nodes</p>
            </div>
            <div className="text-center p-4 bg-background/50 rounded-lg border border-border/30">
              <div className="relative">
                <div className="w-6 h-6 mx-auto bg-primary/20 rounded-full flex items-center justify-center mb-2">
                  <span className="text-xs font-bold text-primary">#</span>
                </div>
              </div>
              <p className="text-3xl font-bold" data-testid="text-your-rank">{performance.yourRank}</p>
              <p className="text-xs text-muted-foreground mt-1">Your Rank</p>
              <Badge variant="outline" className="mt-2 text-[10px]">
                Top {((performance.yourRank / performance.totalNodes) * 100).toFixed(0)}%
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface MetricCardProps {
  title: string;
  value: string;
  icon: React.ElementType;
  trend?: number;
  sub?: string;
  warning?: boolean;
  warningText?: string;
  atRisk?: boolean;
  testId?: string;
}

function MetricCard({ title, value, icon: Icon, trend, sub, warning, warningText, atRisk, testId }: MetricCardProps) {
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm hover:border-primary/50 transition-colors group" data-testid={testId}>
      <CardContent className="p-6">
        <div className="flex justify-between items-start mb-4">
          <div className="p-2 bg-primary/5 rounded-lg text-primary group-hover:bg-primary/10 transition-colors">
            <Icon className="w-5 h-5" />
          </div>
          {trend !== undefined && (
            <div className={cn(
              "flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full",
              trend >= 0 ? "text-green-500 bg-green-500/10" : "text-red-500 bg-red-500/10"
            )} data-testid={`${testId}-trend`}>
              {trend >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {trend >= 0 ? "+" : ""}{trend.toFixed(1)}%
            </div>
          )}
          {warning && (
            <Tooltip>
              <TooltipTrigger>
                <Badge variant="destructive" className="text-[10px] px-2 py-0.5" data-testid={`${testId}-warning`}>
                  <AlertTriangle className="w-3 h-3 mr-1" />
                  High
                </Badge>
              </TooltipTrigger>
              <TooltipContent>{warningText}</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <div className="flex items-baseline gap-1 mt-1">
            <h3 className="text-2xl font-bold font-display tracking-tight">{value}</h3>
          </div>
          {sub && (
            <p className={cn(
              "text-xs mt-2",
              atRisk ? "text-yellow-500" : "text-muted-foreground"
            )}>
              {atRisk && <AlertTriangle className="w-3 h-3 inline mr-1" />}
              {sub}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
