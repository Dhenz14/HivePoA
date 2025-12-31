import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Shield, Activity, Clock, Skull, TrendingUp, TrendingDown, CheckCircle2, XCircle, Timer, Zap, Server } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip } from "recharts";
import { cn } from "@/lib/utils";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";

interface HourlyActivityItem {
  hour: number;
  active: number;
}

interface ValidatorDashboardData {
  validator: {
    id: string;
    username: string;
    rank: number;
    status: string;
    performance: number;
    version: string;
  };
  stats: {
    today: number;
    week: number;
    month: number;
    total: number;
  };
  results: {
    success: number;
    fail: number;
    timeout: number;
    successRate: string;
    cheatersCaught: number;
  };
  latency: {
    avg: number;
    p95: number;
    min: number;
    max: number;
  };
  uptime: string;
  hourlyActivity: HourlyActivityItem[];
  earnings: number;
}

async function fetchValidatorDashboard(username: string, sessionToken?: string): Promise<ValidatorDashboardData> {
  const headers: HeadersInit = {};
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }
  
  const res = await fetch(`/api/validator/dashboard/${username}`, { headers });
  if (!res.ok) {
    return {
      validator: {
        id: "",
        username: "demo_user",
        rank: 5,
        status: "active",
        performance: 98,
        version: "1.0.0",
      },
      stats: { today: 0, week: 0, month: 0, total: 0 },
      results: { success: 0, fail: 0, timeout: 0, successRate: "0.0", cheatersCaught: 0 },
      latency: { avg: 0, p95: 0, min: 0, max: 0 },
      uptime: "0.0",
      hourlyActivity: Array.from({ length: 24 }, (_, i) => ({ hour: i, active: 0 })),
      earnings: 0,
    };
  }
  return res.json();
}

function getLatencyColor(latency: number): string {
  if (latency < 500) return "text-green-500";
  if (latency < 1500) return "text-yellow-500";
  return "text-red-500";
}

function getUptimeColor(uptime: number): string {
  if (uptime >= 99) return "text-green-500";
  if (uptime >= 95) return "text-yellow-500";
  return "text-red-500";
}

function getUptimeBgColor(uptime: number): string {
  if (uptime >= 99) return "bg-green-500/10 border-green-500/30";
  if (uptime >= 95) return "bg-yellow-500/10 border-yellow-500/30";
  return "bg-red-500/10 border-red-500/30";
}

function getStatusBadgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active": return "default";
    case "probation": return "secondary";
    case "banned": return "destructive";
    default: return "outline";
  }
}

export default function ValidatorDashboard() {
  const { user } = useValidatorAuth();
  const username = user?.username || "demo_user";
  const sessionToken = user?.sessionToken;
  
  const { data, isLoading } = useQuery({
    queryKey: ["validator", "dashboard", username],
    queryFn: () => fetchValidatorDashboard(username, sessionToken),
    refetchInterval: 5000,
  });

  if (isLoading || !data) {
    return (
      <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-validator-dashboard">
        <div>
          <h1 className="text-3xl font-display font-bold">Validator Operations</h1>
          <p className="text-muted-foreground mt-1">Loading dashboard data...</p>
        </div>
      </div>
    );
  }

  const uptime = parseFloat(data.uptime);
  const pieData = [
    { name: "Success", value: data.results.success, color: "#22c55e" },
    { name: "Failed", value: data.results.fail, color: "#ef4444" },
    { name: "Timeout", value: data.results.timeout, color: "#f59e0b" },
  ].filter(d => d.value > 0);

  const hourlyActivity = data.hourlyActivity;

  const activeHours = hourlyActivity.filter(h => h.active > 0).length;
  const weeklyAvgPerDay = data.stats.week > 0 ? Math.floor(data.stats.week / 7) : 0;
  const todayTrend = weeklyAvgPerDay > 0 ? data.stats.today - weeklyAvgPerDay : 0;
  const todayTrendPercent = weeklyAvgPerDay > 0 
    ? Math.round((todayTrend / weeklyAvgPerDay) * 100) 
    : 0;

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-validator-dashboard">
      {/* Header Section */}
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-3">
            <Shield className="w-8 h-8 text-primary" />
            <h1 className="text-3xl font-display font-bold" data-testid="text-page-title">
              Validator Operations
            </h1>
          </div>
          <p className="text-muted-foreground mt-1">Network policing and challenge monitoring</p>
        </div>
        <div className="flex gap-2">
          <span className="px-3 py-1 bg-primary/10 text-primary text-xs rounded-full font-mono flex items-center gap-2 border border-primary/20" data-testid="status-live-updates">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Live Updates
          </span>
        </div>
      </div>

      {/* Validator Info Header */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-validator-header">
        <CardContent className="p-6">
          <div className="flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center">
                <Shield className="w-6 h-6 text-primary" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-bold" data-testid="text-validator-username">
                    {data.validator.username}
                  </h2>
                  <Badge variant="outline" className="font-mono" data-testid="badge-validator-rank">
                    #{data.validator.rank}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">Validator Node</p>
              </div>
            </div>
            
            <div className="flex items-center gap-4 ml-auto">
              <div className="text-center px-4 border-r border-border/50">
                <p className="text-xs text-muted-foreground">Status</p>
                <Badge 
                  variant={getStatusBadgeVariant(data.validator.status)}
                  data-testid="badge-validator-status"
                >
                  {data.validator.status}
                </Badge>
              </div>
              <div className="text-center px-4 border-r border-border/50">
                <p className="text-xs text-muted-foreground">Version</p>
                <span className="font-mono text-sm" data-testid="text-validator-version">
                  v{data.validator.version}
                </span>
              </div>
              <div className="text-center px-4">
                <p className="text-xs text-muted-foreground">Uptime</p>
                <span className={cn("font-bold", getUptimeColor(uptime))} data-testid="text-validator-uptime">
                  {uptime.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats Cards Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard
          title="Challenges Today"
          value={data.stats.today}
          icon={Activity}
          trend={todayTrendPercent}
          trendUp={todayTrend >= 0}
          testId="card-challenges-today"
        />
        <StatsCard
          title="Challenges This Week"
          value={data.stats.week}
          icon={Activity}
          testId="card-challenges-week"
        />
        <StatsCard
          title="Challenges This Month"
          value={data.stats.month}
          icon={Activity}
          testId="card-challenges-month"
        />
        <StatsCard
          title="Cheaters Caught"
          value={data.results.cheatersCaught}
          icon={Skull}
          iconColor="text-red-500"
          testId="card-cheaters-caught"
        />
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Results Overview Card */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-results-overview">
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-500" />
              Results Overview
            </CardTitle>
            <CardDescription>Challenge success/fail/timeout ratio</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center gap-6">
              {/* Pie Chart */}
              <div className="w-32 h-32" data-testid="chart-results-pie">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={30}
                      outerRadius={50}
                      paddingAngle={2}
                      dataKey="value"
                    >
                      {pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <RechartsTooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        borderColor: "hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              
              {/* Success Rate */}
              <div className="flex-1">
                <div className="text-center mb-4">
                  <span className="text-4xl font-bold text-green-500" data-testid="text-success-rate">
                    {data.results.successRate}%
                  </span>
                  <p className="text-sm text-muted-foreground">Success Rate</p>
                </div>
              </div>
            </div>

            {/* Progress Bars */}
            <div className="space-y-3">
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    Success
                  </span>
                  <span className="text-green-500 font-medium" data-testid="text-success-count">
                    {data.results.success}
                  </span>
                </div>
                <Progress 
                  value={data.results.success / Math.max(1, data.stats.total) * 100} 
                  className="h-2 [&>div]:bg-green-500" 
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <XCircle className="w-4 h-4 text-red-500" />
                    Failed
                  </span>
                  <span className="text-red-500 font-medium" data-testid="text-fail-count">
                    {data.results.fail}
                  </span>
                </div>
                <Progress 
                  value={data.results.fail / Math.max(1, data.stats.total) * 100} 
                  className="h-2 [&>div]:bg-red-500" 
                />
              </div>
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="flex items-center gap-2">
                    <Timer className="w-4 h-4 text-yellow-500" />
                    Timeout
                  </span>
                  <span className="text-yellow-500 font-medium" data-testid="text-timeout-count">
                    {data.results.timeout}
                  </span>
                </div>
                <Progress 
                  value={data.results.timeout / Math.max(1, data.stats.total) * 100} 
                  className="h-2 [&>div]:bg-yellow-500" 
                />
              </div>
            </div>

            {/* Text Breakdown */}
            <div className="p-3 bg-background/50 rounded-lg border border-border/30 text-center">
              <p className="text-sm" data-testid="text-results-breakdown">
                <span className="text-green-500 font-medium">{data.results.success} passed</span>
                {", "}
                <span className="text-red-500 font-medium">{data.results.fail} failed</span>
                {", "}
                <span className="text-yellow-500 font-medium">{data.results.timeout} timeout</span>
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Latency Metrics Card */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-latency-metrics">
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2">
              <Clock className="w-5 h-5 text-primary" />
              Latency Metrics
            </CardTitle>
            <CardDescription>Response time measurements</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Average Latency - Large Display */}
            <div className="text-center p-4 bg-background/50 rounded-lg border border-border/30">
              <p className="text-sm text-muted-foreground mb-1">Average Latency</p>
              <span className={cn("text-4xl font-bold", getLatencyColor(data.latency.avg))} data-testid="text-avg-latency">
                {data.latency.avg}ms
              </span>
              {data.latency.avg >= 1500 && (
                <p className="text-xs text-red-500 mt-2">⚠️ High latency detected</p>
              )}
            </div>

            {/* P95 Latency */}
            <div className="grid grid-cols-3 gap-4 text-center">
              <div className="p-3 bg-background/50 rounded-lg border border-border/30">
                <p className="text-xs text-muted-foreground">P95</p>
                <p className={cn("text-lg font-bold", getLatencyColor(data.latency.p95))} data-testid="text-p95-latency">
                  {data.latency.p95}ms
                </p>
              </div>
              <div className="p-3 bg-background/50 rounded-lg border border-border/30">
                <p className="text-xs text-muted-foreground">Min</p>
                <p className="text-lg font-bold text-green-500" data-testid="text-min-latency">
                  {data.latency.min}ms
                </p>
              </div>
              <div className="p-3 bg-background/50 rounded-lg border border-border/30">
                <p className="text-xs text-muted-foreground">Max</p>
                <p className={cn("text-lg font-bold", getLatencyColor(data.latency.max))} data-testid="text-max-latency">
                  {data.latency.max}ms
                </p>
              </div>
            </div>

            {/* Latency Color Legend */}
            <div className="flex justify-center gap-4 text-xs">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                {"<500ms (Good)"}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-yellow-500" />
                {"<1500ms (Fair)"}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                {">1500ms (Poor)"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Uptime Tracker Card */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-uptime-tracker">
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2">
              <Server className="w-5 h-5 text-primary" />
              Uptime Tracker
            </CardTitle>
            <CardDescription>24-hour availability monitoring</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Large Uptime Display */}
            <div className={cn("text-center p-6 rounded-lg border", getUptimeBgColor(uptime))}>
              <span className={cn("text-5xl font-bold", getUptimeColor(uptime))} data-testid="text-uptime-large">
                {uptime.toFixed(1)}%
              </span>
              <p className="text-sm text-muted-foreground mt-2">Uptime (Last 24 Hours)</p>
            </div>

            {/* 24-hour Activity Bar Chart */}
            <div data-testid="chart-hourly-activity">
              <p className="text-sm text-muted-foreground mb-2">24-Hour Activity</p>
              <div className="h-16">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hourlyActivity}>
                    <XAxis 
                      dataKey="hour" 
                      stroke="hsl(var(--muted-foreground))"
                      fontSize={10}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => v % 6 === 0 ? `${v}h` : ""}
                    />
                    <Bar 
                      dataKey="active" 
                      fill="hsl(var(--primary))"
                      radius={[2, 2, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Uptime Legend */}
            <div className="flex justify-center gap-4 text-xs">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                {">99% (Excellent)"}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-yellow-500" />
                {">95% (Good)"}
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                {"<95% (Poor)"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Earnings Card */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-earnings">
          <CardHeader>
            <CardTitle className="font-display flex items-center gap-2">
              <Zap className="w-5 h-5 text-yellow-500" />
              Validation Earnings
            </CardTitle>
            <CardDescription>Rewards from network policing</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Total Earnings Display */}
            <div className="text-center p-6 bg-gradient-to-br from-yellow-500/10 to-amber-500/10 rounded-lg border border-yellow-500/30">
              <span className="text-4xl font-bold text-yellow-500" data-testid="text-total-earnings">
                {data.earnings.toFixed(4)}
              </span>
              <span className="text-xl text-yellow-500/70 ml-2">HBD</span>
              <p className="text-sm text-muted-foreground mt-2">Total Validation Earnings</p>
            </div>

            {/* Earnings Stats */}
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-background/50 rounded-lg border border-border/30 text-center">
                <p className="text-xs text-muted-foreground">Per Challenge</p>
                <p className="text-lg font-bold text-primary" data-testid="text-earnings-per-challenge">
                  {(data.stats.total > 0 ? data.earnings / data.stats.total : 0).toFixed(6)} HBD
                </p>
              </div>
              <div className="p-4 bg-background/50 rounded-lg border border-border/30 text-center">
                <p className="text-xs text-muted-foreground">Total Challenges</p>
                <p className="text-lg font-bold text-primary" data-testid="text-total-challenges">
                  {data.stats.total}
                </p>
              </div>
            </div>

            {/* Earnings Trend */}
            <div className="flex items-center justify-center gap-2 p-3 bg-background/50 rounded-lg border border-border/30" data-testid="container-earnings-rate">
              <TrendingUp className="w-4 h-4 text-green-500" />
              <span className="text-sm text-muted-foreground">
                Earning rate: <span className="text-green-500 font-medium" data-testid="text-earnings-rate">{((data.earnings / Math.max(1, data.stats.week)) * 7).toFixed(4)} HBD/week</span>
              </span>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface StatsCardProps {
  title: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  trend?: number;
  trendUp?: boolean;
  iconColor?: string;
  testId: string;
}

function StatsCard({ title, value, icon: Icon, trend, trendUp, iconColor = "text-primary", testId }: StatsCardProps) {
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid={testId}>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold mt-1" data-testid={`${testId}-value`}>{value}</p>
            {trend !== undefined && (
              <div className={cn(
                "flex items-center gap-1 text-xs mt-1",
                trendUp ? "text-green-500" : "text-red-500"
              )}>
                {trendUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                <span data-testid={`${testId}-trend`}>{trendUp ? "+" : ""}{trend}% vs yesterday</span>
              </div>
            )}
          </div>
          <div className={cn("w-12 h-12 rounded-lg bg-background/50 flex items-center justify-center", iconColor)}>
            <Icon className="w-6 h-6" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
