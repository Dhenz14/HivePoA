import React from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, Cpu, Globe, Server, Zap, Users, Coins, ArrowRight, ExternalLink, Copy } from "lucide-react";
import { getApiBase } from "@/lib/api-mode";
import { useToast } from "@/hooks/use-toast";

export default function CommunityCloud() {
  const { toast } = useToast();

  const { data: dashboard, isLoading } = useQuery({
    queryKey: ["/api/community/dashboard"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/community/dashboard`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 15000,
  });

  // Live pool stats — updated every 10s (matches health check cycle)
  const { data: poolStats } = useQuery({
    queryKey: ["/api/gpu/pool"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/gpu/pool`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 10000,
  });

  const poolNodes = poolStats?.pool?.nodes || [];
  const healthyCount = poolStats?.pool?.healthyCount || 0;
  const totalVramGb = poolStats?.pool?.totalVramGb || 0;
  const totalRequests = poolStats?.routing24h?.totalRequests || 0;
  const avgLatency = poolStats?.routing24h?.avgLatencyMs || 0;
  const failoverRate = poolStats?.routing24h?.failoverRate || 0;
  // CPU+RAM pool stats
  const cpuPool = poolStats?.pool?.cpu || { healthyCount: 0, totalCores: 0 };
  const ramPool = poolStats?.pool?.ram || { healthyCount: 0, totalRamGb: 0 };

  const tier = healthyCount >= 40 ? 3 : healthyCount >= 2 ? 2 : 1;
  const totalGpus = healthyCount || dashboard?.tier?.totalGpus || 0;
  const clusters = dashboard?.clusters?.clusters || [];
  const contribs = dashboard?.inference?.contributions || {};

  const tierNames: Record<number, string> = {
    1: "Solo (your AI, your GPU)",
    2: "Pool (community throughput)",
    3: "Cluster (combined brain power)",
  };

  const [agentDetected, setAgentDetected] = React.useState<boolean | null>(null);

  // Check if Desktop Agent is running
  React.useEffect(() => {
    fetch("http://127.0.0.1:5111/api/status", { signal: AbortSignal.timeout(2000) })
      .then(r => { if (r.ok) setAgentDetected(true); else setAgentDetected(false); })
      .catch(() => setAgentDetected(false));
  }, []);

  const contributeGpu = () => {
    if (agentDetected) {
      // Agent running — open GPU setup wizard
      window.open("http://127.0.0.1:5111/gpu-setup", "_blank");
    } else {
      // No agent — go to download page
      window.location.href = "/download?next=gpu-setup";
    }
  };

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Community GPU Cloud</h1>
        <p className="text-muted-foreground mt-1">
          People share their graphics cards to create a free, community-powered AI.
          The more GPUs that join, the smarter the AI gets.
        </p>
      </div>

      {/* Pool Status Banner */}
      {healthyCount > 0 && (
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-6 pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500"></span>
                </span>
                <span className="text-lg font-semibold">Pool is Live</span>
              </div>
              <span className="text-sm text-muted-foreground">
                {healthyCount} {healthyCount === 1 ? "GPU" : "GPUs"} online — {totalVramGb} GB VRAM
                {cpuPool.healthyCount > 0 ? ` | ${cpuPool.totalCores} CPU cores` : ""}
                {ramPool.healthyCount > 0 ? ` | ${ramPool.totalRamGb} GB RAM` : ""}
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{totalGpus}</div>
            <p className="text-sm text-muted-foreground mt-1">GPUs online</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{totalVramGb}</div>
            <p className="text-sm text-muted-foreground mt-1">GB VRAM total</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{totalRequests.toLocaleString()}</div>
            <p className="text-sm text-muted-foreground mt-1">Requests served</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{avgLatency > 0 ? `${(avgLatency / 1000).toFixed(1)}s` : "—"}</div>
            <p className="text-sm text-muted-foreground mt-1">Avg response time</p>
          </CardContent>
        </Card>
      </div>

      {/* Live GPU Nodes */}
      {poolNodes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              GPU Nodes
            </CardTitle>
            <CardDescription>
              {healthyCount} of {poolNodes.length} nodes online and serving AI requests.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {poolNodes.map((node: any) => (
                <div
                  key={node.id}
                  className={`p-4 rounded-lg border ${node.healthy ? "border-green-500/20 bg-green-500/5" : "border-red-500/20 bg-red-500/5"}`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`h-2 w-2 rounded-full ${node.healthy ? "bg-green-500" : "bg-red-500"}`} />
                    <span className="font-medium text-sm">{node.instanceId?.replace("gpu-", "").replace(/-/g, " ") || "GPU Node"}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{node.gpu}</p>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-sm font-medium">{node.vramGb} GB</span>
                    <Badge variant={node.healthy ? "default" : "destructive"} className="text-xs">
                      {node.healthy ? "Online" : "Offline"}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Current tier explained simply */}
      <Card>
        <CardHeader>
          <CardTitle>Current Community Level: Tier {tier}</CardTitle>
          <CardDescription>{tierNames[tier] || tierNames[1]}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {/* Tier progress bar */}
            <div>
              <div className="flex justify-between text-sm mb-1">
                <span>Tier 1 (0 GPUs)</span>
                <span>Tier 2 (15 GPUs)</span>
                <span>Tier 3 (40 GPUs)</span>
              </div>
              <div className="h-3 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${Math.min(100, (totalGpus / 40) * 100)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {tier < 3
                  ? `${tier === 1 ? 15 - totalGpus : 40 - totalGpus} more GPUs needed for the next level`
                  : "Maximum level reached!"}
              </p>
            </div>

            {/* What each tier means — no jargon */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
              <div className={`p-3 rounded-lg border ${tier >= 1 ? "bg-primary/5 border-primary/20" : ""}`}>
                <p className="font-medium">Tier 1: Base</p>
                <p className="text-muted-foreground">Local AI on your computer. Free and private.</p>
              </div>
              <div className={`p-3 rounded-lg border ${tier >= 2 ? "bg-primary/5 border-primary/20" : ""}`}>
                <p className="font-medium">Tier 2: Enhanced</p>
                <p className="text-muted-foreground">Community GPUs team up for better answers.</p>
              </div>
              <div className={`p-3 rounded-lg border ${tier >= 3 ? "bg-primary/5 border-primary/20" : ""}`}>
                <p className="font-medium">Tier 3: Full Power</p>
                <p className="text-muted-foreground">Large AI model powered by 40+ community GPUs.</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* How to contribute — THE CTA */}
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle>Share Your GPU</CardTitle>
          <CardDescription>
            Got a gaming PC? Your graphics card can earn you money while you're not using it.
            One click sets everything up automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/10 p-2 shrink-0">
                <span className="text-primary font-bold text-sm">1</span>
              </div>
              <div>
                <p className="font-medium">Click the button</p>
                <p className="text-muted-foreground">We detect your GPU, install everything needed, and configure it automatically.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/10 p-2 shrink-0">
                <span className="text-primary font-bold text-sm">2</span>
              </div>
              <div>
                <p className="font-medium">Choose your mode</p>
                <p className="text-muted-foreground">Pool (earn by serving requests) or Cluster (team up for a bigger AI brain).</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/10 p-2 shrink-0">
                <span className="text-primary font-bold text-sm">3</span>
              </div>
              <div>
                <p className="font-medium">Earn HBD ($1 each)</p>
                <p className="text-muted-foreground">Get paid based on how much AI work your GPU handles. Auto-pauses when you game.</p>
              </div>
            </div>
          </div>

          {/* One-click contribute button */}
          <Button size="lg" className="w-full gap-2 text-lg py-6" onClick={contributeGpu}>
            <Zap className="h-5 w-5" />
            Contribute My GPU
          </Button>

          {agentDetected === false && (
            <p className="text-xs text-muted-foreground text-center">
              You'll need to download the Desktop Agent first (2 min install).
            </p>
          )}

          <div className="flex flex-wrap gap-2 justify-center">
            <a href="https://signup.hive.io" target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm" className="gap-1">
                Create Hive Account <ExternalLink className="h-3 w-3" />
              </Button>
            </a>
            <p className="text-xs text-muted-foreground self-center">
              Any GPU with 6+ GB: NVIDIA, AMD, Apple Silicon, Intel Arc
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Active clusters */}
      {clusters.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Active GPU Groups</CardTitle>
            <CardDescription>
              GPUs near each other are grouped together for faster teamwork.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {clusters.map((cluster: any) => (
                <div
                  key={cluster.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div className="flex items-center gap-3">
                    <Server className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">{cluster.name || "GPU Group"}</p>
                      <p className="text-xs text-muted-foreground">
                        {cluster.region} — {cluster.totalGpus} GPUs, {cluster.totalVramGb} GB memory
                      </p>
                    </div>
                  </div>
                  <Badge variant={cluster.status === "active" ? "default" : "secondary"}>
                    {cluster.status === "active" ? "Active" : cluster.status}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Earnings estimate */}
      <Card>
        <CardHeader>
          <CardTitle>Estimated Earnings</CardTitle>
          <CardDescription>
            How much you could earn by sharing your GPU (approximate, depends on demand).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
            <div className="p-4 rounded-lg bg-muted">
              <p className="text-sm text-muted-foreground">8 GB GPU (GTX 1070)</p>
              <p className="text-2xl font-bold mt-1">~$0.50</p>
              <p className="text-xs text-muted-foreground">per day (8 hrs)</p>
            </div>
            <div className="p-4 rounded-lg bg-muted">
              <p className="text-sm text-muted-foreground">16 GB GPU (RTX 4070)</p>
              <p className="text-2xl font-bold mt-1">~$1.20</p>
              <p className="text-xs text-muted-foreground">per day (8 hrs)</p>
            </div>
            <div className="p-4 rounded-lg bg-muted">
              <p className="text-sm text-muted-foreground">24 GB GPU (RTX 4090)</p>
              <p className="text-2xl font-bold mt-1">~$2.00</p>
              <p className="text-xs text-muted-foreground">per day (8 hrs)</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground text-center mt-3">
            Earnings increase at higher community tiers (Tier 2: 1.5x, Tier 3: 2x multiplier).
            HBD = Hive-Backed Dollars, each worth approximately $1 USD.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
