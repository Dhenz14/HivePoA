import React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Activity, Cpu, Thermometer, Zap, Coins, Server,
  Pause, Play, Square, Gamepad2, RefreshCw, AlertCircle,
  Settings, Clock, HardDrive,
} from "lucide-react";
import {
  getGpuStatus, getGpuMetrics, getGpuEarnings, updateGpuConfig,
  startGpuContribution, stopGpuContribution,
  pauseGpuContribution, resumeGpuContribution, enterGamingMode,
  type GpuContributionStatus, type GpuMetrics, type GpuEarnings,
} from "@/lib/gpu-agent";
import { getApiBase } from "@/lib/api-mode";

function formatUptime(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

function tempColor(c: number): string {
  if (c < 60) return "text-green-500";
  if (c < 75) return "text-yellow-500";
  return "text-red-500";
}

const stateLabels: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  running: { label: "Contributing", color: "bg-green-500", icon: <Activity className="h-3 w-3" /> },
  paused: { label: "Paused", color: "bg-orange-500", icon: <Pause className="h-3 w-3" /> },
  gaming_mode: { label: "Gaming Mode", color: "bg-orange-500", icon: <Gamepad2 className="h-3 w-3" /> },
  starting: { label: "Starting...", color: "bg-yellow-500", icon: <RefreshCw className="h-3 w-3 animate-spin" /> },
  draining: { label: "Draining...", color: "bg-yellow-500", icon: <RefreshCw className="h-3 w-3 animate-spin" /> },
  error: { label: "Error", color: "bg-red-500", icon: <AlertCircle className="h-3 w-3" /> },
  stopped: { label: "Stopped", color: "bg-gray-500", icon: <Square className="h-3 w-3" /> },
  checking_deps: { label: "Checking...", color: "bg-yellow-500", icon: <RefreshCw className="h-3 w-3 animate-spin" /> },
};

const VRAM_PRESETS = [
  { label: "Conservative", value: 0.50, desc: "50% — Plenty of room for other apps" },
  { label: "Balanced", value: 0.70, desc: "70% — Good for most users" },
  { label: "Maximum", value: 0.90, desc: "90% — Best performance, minimal headroom" },
];

function GpuSettingsPanel({ config, onUpdate }: {
  config: GpuContributionStatus["config"];
  onUpdate: () => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [vram, setVram] = React.useState(config.vramUtilization);
  const [scheduleEnabled, setScheduleEnabled] = React.useState(config.scheduleEnabled);
  const [scheduleStart, setScheduleStart] = React.useState(config.scheduleStart);
  const [scheduleEnd, setScheduleEnd] = React.useState(config.scheduleEnd);
  const [gamingMode, setGamingMode] = React.useState(config.autoGamingMode);

  // Sync state when config changes from outside
  React.useEffect(() => {
    setVram(config.vramUtilization);
    setScheduleEnabled(config.scheduleEnabled);
    setScheduleStart(config.scheduleStart);
    setScheduleEnd(config.scheduleEnd);
    setGamingMode(config.autoGamingMode);
  }, [config]);

  const saveVram = async (value: number) => {
    setVram(value);
    await updateGpuConfig({ vramUtilization: value });
    onUpdate();
  };

  const saveSchedule = async (enabled: boolean, start: string, end: string) => {
    setScheduleEnabled(enabled);
    setScheduleStart(start);
    setScheduleEnd(end);
    await updateGpuConfig({ scheduleEnabled: enabled, scheduleStart: start, scheduleEnd: end });
    onUpdate();
  };

  const saveGamingMode = async (enabled: boolean) => {
    setGamingMode(enabled);
    await updateGpuConfig({ autoGamingMode: enabled });
    onUpdate();
  };

  const activePreset = VRAM_PRESETS.find(p => Math.abs(p.value - vram) < 0.02);

  if (!expanded) {
    return (
      <Card className="cursor-pointer hover:bg-accent/50 transition-colors" onClick={() => setExpanded(true)}>
        <CardContent className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Settings className="h-5 w-5 text-muted-foreground" />
            <div>
              <p className="font-medium text-sm">GPU Settings</p>
              <p className="text-xs text-muted-foreground">
                VRAM: {(vram * 100).toFixed(0)}%
                {scheduleEnabled ? ` | Schedule: ${scheduleStart}—${scheduleEnd}` : ""}
                {gamingMode ? " | Gaming auto-pause" : ""}
              </p>
            </div>
          </div>
          <span className="text-xs text-muted-foreground">Click to expand</span>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            GPU Settings
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(false)}>
            Collapse
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* VRAM Allocation Slider */}
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            <Label className="font-medium">VRAM Allocation</Label>
          </div>

          {/* Preset buttons */}
          <div className="flex gap-2">
            {VRAM_PRESETS.map(preset => (
              <Button
                key={preset.label}
                variant={activePreset?.label === preset.label ? "default" : "outline"}
                size="sm"
                className="flex-1"
                onClick={() => saveVram(preset.value)}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          {/* Slider */}
          <div className="space-y-2">
            <Slider
              value={[vram * 100]}
              min={50}
              max={95}
              step={5}
              onValueCommit={(values) => saveVram(values[0] / 100)}
              onValueChange={(values) => setVram(values[0] / 100)}
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>50% Safe</span>
              <span className="font-mono text-sm text-foreground">{(vram * 100).toFixed(0)}%</span>
              <span>95% Max</span>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            {activePreset ? activePreset.desc : `${(vram * 100).toFixed(0)}% — Custom allocation`}
            . Changes take effect on next container restart.
          </p>
        </div>

        {/* Schedule */}
        <div className="space-y-4 pt-2 border-t">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <Label className="font-medium">Contribution Schedule</Label>
            </div>
            <Switch
              checked={scheduleEnabled}
              onCheckedChange={(checked) => saveSchedule(checked, scheduleStart, scheduleEnd)}
            />
          </div>

          {scheduleEnabled && (
            <div className="flex items-center gap-3 pl-6">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Start</Label>
                <Input
                  type="time"
                  value={scheduleStart}
                  onChange={(e) => {
                    const val = e.target.value;
                    setScheduleStart(val);
                    saveSchedule(scheduleEnabled, val, scheduleEnd);
                  }}
                  className="w-28"
                />
              </div>
              <span className="text-muted-foreground mt-5">to</span>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">End</Label>
                <Input
                  type="time"
                  value={scheduleEnd}
                  onChange={(e) => {
                    const val = e.target.value;
                    setScheduleEnd(val);
                    saveSchedule(scheduleEnabled, scheduleStart, val);
                  }}
                  className="w-28"
                />
              </div>
            </div>
          )}

          {scheduleEnabled && (
            <p className="text-xs text-muted-foreground pl-6">
              GPU will automatically start at {scheduleStart} and stop at {scheduleEnd}.
              {scheduleStart > scheduleEnd ? " (overnight)" : ""}
            </p>
          )}
        </div>

        {/* Gaming Mode */}
        <div className="flex items-center justify-between pt-2 border-t">
          <div className="flex items-center gap-2">
            <Gamepad2 className="h-4 w-4 text-muted-foreground" />
            <div>
              <Label className="font-medium">Auto Gaming Mode</Label>
              <p className="text-xs text-muted-foreground">
                Detect VRAM contention and auto-pause. Resumes when idle for 2.5 min.
              </p>
            </div>
          </div>
          <Switch
            checked={gamingMode}
            onCheckedChange={saveGamingMode}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export default function GpuDashboard() {
  const queryClient = useQueryClient();

  const { data: status } = useQuery<GpuContributionStatus | null>({
    queryKey: ["gpu-status"],
    queryFn: getGpuStatus,
    refetchInterval: 5000,
  });

  const { data: metrics } = useQuery<GpuMetrics | null>({
    queryKey: ["gpu-metrics"],
    queryFn: getGpuMetrics,
    refetchInterval: 5000,
    enabled: status?.state === "running",
  });

  const { data: earnings } = useQuery<GpuEarnings | null>({
    queryKey: ["gpu-earnings"],
    queryFn: getGpuEarnings,
    refetchInterval: 15000,
  });

  // Pool stats — live network view
  const { data: poolStats } = useQuery({
    queryKey: ["pool-stats"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/gpu/pool`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 10000,
  });

  const poolNodes = poolStats?.pool?.nodes || [];
  const poolHealthy = poolStats?.pool?.healthyCount || 0;
  const poolRequests = poolStats?.routing24h?.totalRequests || 0;
  const poolAvgLatency = poolStats?.routing24h?.avgLatencyMs || 0;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["gpu-status"] });
    queryClient.invalidateQueries({ queryKey: ["gpu-metrics"] });
    queryClient.invalidateQueries({ queryKey: ["gpu-earnings"] });
  };

  const startMutation = useMutation({
    mutationFn: () => startGpuContribution({ mode: "pool" }),
    onSuccess: invalidate,
  });

  const stopMutation = useMutation({
    mutationFn: stopGpuContribution,
    onSuccess: invalidate,
  });

  const pauseMutation = useMutation({
    mutationFn: pauseGpuContribution,
    onSuccess: invalidate,
  });

  const resumeMutation = useMutation({
    mutationFn: resumeGpuContribution,
    onSuccess: invalidate,
  });

  const gamingMutation = useMutation({
    mutationFn: enterGamingMode,
    onSuccess: invalidate,
  });

  const state = status?.state || "stopped";
  const stateInfo = stateLabels[state] || stateLabels.stopped;
  const isRunning = state === "running";
  const canStart = state === "stopped" || state === "error";
  const canPause = state === "running";
  const canResume = state === "paused" || state === "gaming_mode";

  // No agent detected
  if (status === null) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold mb-4">GPU Dashboard</h1>
        <Card>
          <CardContent className="p-8 text-center space-y-4">
            <Cpu className="h-12 w-12 mx-auto text-muted-foreground" />
            <h2 className="text-lg font-semibold">Desktop Agent Not Detected</h2>
            <p className="text-muted-foreground">
              The Desktop Agent needs to be running to contribute your GPU.
            </p>
            <Button onClick={() => window.location.href = "/download"}>
              Download Desktop Agent
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Status Bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">GPU Dashboard</h1>
          <Badge variant="outline" className="gap-1">
            <span className={`h-2 w-2 rounded-full ${stateInfo.color}`} />
            {stateInfo.label}
          </Badge>
          {isRunning && status?.uptimeMs ? (
            <span className="text-sm text-muted-foreground">
              Uptime: {formatUptime(status.uptimeMs)}
            </span>
          ) : null}
        </div>
        <div className="flex gap-2">
          {canStart && (
            <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
              <Play className="h-4 w-4 mr-1" /> Start
            </Button>
          )}
          {canPause && (
            <>
              <Button variant="outline" onClick={() => pauseMutation.mutate()} disabled={pauseMutation.isPending}>
                <Pause className="h-4 w-4 mr-1" /> Pause
              </Button>
              <Button variant="outline" onClick={() => gamingMutation.mutate()} disabled={gamingMutation.isPending}>
                <Gamepad2 className="h-4 w-4 mr-1" /> Gaming Mode
              </Button>
            </>
          )}
          {canResume && (
            <Button onClick={() => resumeMutation.mutate()} disabled={resumeMutation.isPending}>
              <Play className="h-4 w-4 mr-1" /> Resume
            </Button>
          )}
          {(isRunning || state === "paused") && (
            <Button variant="destructive" size="sm" onClick={() => stopMutation.mutate()} disabled={stopMutation.isPending}>
              <Square className="h-4 w-4 mr-1" /> Stop
            </Button>
          )}
        </div>
      </div>

      {/* Error Banner */}
      {state === "error" && status?.error && (
        <Card className="border-red-500/50 bg-red-500/5">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
            <div>
              <p className="font-medium text-red-500">Error</p>
              <p className="text-sm text-muted-foreground">{status.error}</p>
            </div>
            <Button size="sm" className="ml-auto" onClick={() => startMutation.mutate()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* GPU Info Banner */}
      {status?.gpuInfo && (
        <p className="text-sm text-muted-foreground">
          {status.gpuInfo.name} ({status.gpuInfo.vramTotalGb} GB) | Driver {status.gpuInfo.driverVersion}
          {status.config.mode ? ` | ${status.config.mode.charAt(0).toUpperCase() + status.config.mode.slice(1)} Mode` : ""}
        </p>
      )}

      {/* Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* GPU Health */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Thermometer className="h-4 w-4" /> GPU Health
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span>Temperature</span>
              <span className={metrics ? tempColor(metrics.temperatureC) : "text-muted-foreground"}>
                {metrics ? `${metrics.temperatureC}°C` : "—"}
              </span>
            </div>
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span>VRAM</span>
                <span className="text-muted-foreground">
                  {metrics ? `${(metrics.vramUsedMb / 1024).toFixed(1)} / ${(metrics.vramTotalMb / 1024).toFixed(1)} GB` : "—"}
                </span>
              </div>
              {metrics && (
                <Progress value={(metrics.vramUsedMb / metrics.vramTotalMb) * 100} className="h-2" />
              )}
            </div>
            <div className="flex justify-between text-sm">
              <span>Utilization</span>
              <span>{metrics ? `${metrics.utilizationPct}%` : "—"}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>Power</span>
              <span className="text-muted-foreground">
                {metrics ? `${metrics.powerDrawW.toFixed(0)}W / ${metrics.powerLimitW.toFixed(0)}W` : "—"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Inference Stats */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="h-4 w-4" /> Inference
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span>Tokens Today</span>
              <span className="font-mono">{formatTokens(earnings?.totalTokens || 0)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>Requests</span>
              <span className="font-mono">{earnings?.totalRequests || 0}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>Model</span>
              <span className="text-muted-foreground text-xs">{status?.config.model || "—"}</span>
            </div>
          </CardContent>
        </Card>

        {/* Earnings */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Coins className="h-4 w-4" /> Earnings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-2xl font-bold">
              ${(earnings?.estimatedHbdEarned || 0).toFixed(4)}
              <span className="text-sm font-normal text-muted-foreground ml-1">HBD</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>Tokens Processed</span>
              <span className="font-mono">{formatTokens(earnings?.totalTokens || 0)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>Uptime</span>
              <span>{earnings?.uptimeMs ? formatUptime(earnings.uptimeMs) : "—"}</span>
            </div>
          </CardContent>
        </Card>

        {/* Network */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Server className="h-4 w-4" /> Network
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span>Mode</span>
              <Badge variant="outline" className="text-xs">
                {status?.config.mode || "solo"}
              </Badge>
            </div>
            <div className="flex justify-between text-sm">
              <span>Gaming Mode</span>
              <span>{status?.config.autoGamingMode ? "Auto" : "Off"}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span>VRAM Allocation</span>
              <span>{status?.config.vramUtilization ? `${(status.config.vramUtilization * 100).toFixed(0)}%` : "—"}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pool Network */}
      {poolNodes.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Activity className="h-5 w-5" />
                Pool Network
              </CardTitle>
              <Badge variant={poolHealthy > 0 ? "default" : "secondary"}>
                {poolHealthy}/{poolNodes.length} Healthy
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {poolNodes.map((node: any) => (
              <div key={node.id} className="flex items-center justify-between p-3 rounded-lg border">
                <div className="flex items-center gap-3">
                  <span className={`h-2.5 w-2.5 rounded-full ${node.healthy ? "bg-green-500" : "bg-red-500"}`} />
                  <div>
                    <p className="text-sm font-medium">{node.instanceId?.replace("gpu-", "").replace(/-/g, " ")}</p>
                    <p className="text-xs text-muted-foreground">{node.gpu} — {node.vramGb}GB</p>
                  </div>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  <p>Score: {(node.emaScore * 100).toFixed(0)}%</p>
                  <p>{node.utilization}% load</p>
                </div>
              </div>
            ))}
            <div className="flex justify-between text-sm text-muted-foreground pt-2 border-t">
              <span>{poolRequests.toLocaleString()} requests routed</span>
              <span>{poolAvgLatency > 0 ? `avg ${(poolAvgLatency / 1000).toFixed(1)}s` : ""}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* GPU Settings */}
      {status && <GpuSettingsPanel config={status.config} onUpdate={invalidate} />}

      {/* How it works (when stopped) */}
      {canStart && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-6 text-center space-y-4">
            <Zap className="h-10 w-10 mx-auto text-primary" />
            <h2 className="text-lg font-semibold">Ready to Contribute</h2>
            <p className="text-muted-foreground max-w-md mx-auto">
              Your GPU will serve AI requests from the community and earn HBD rewards.
              Auto-pauses when you game.
            </p>
            <Button size="lg" className="gap-2" onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
              <Play className="h-5 w-5" /> Start Contributing
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
