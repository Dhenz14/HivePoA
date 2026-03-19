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

  const tier = dashboard?.tier?.tier || 1;
  const totalGpus = dashboard?.tier?.totalGpus || 0;
  const clusters = dashboard?.clusters?.clusters || [];
  const contribs = dashboard?.inference?.contributions || {};

  const tierNames: Record<number, string> = {
    1: "Base (local AI only)",
    2: "Enhanced (cluster available)",
    3: "Full Power (community brain)",
  };

  const copyCommand = () => {
    navigator.clipboard.writeText("python scripts/start_spiritbomb.py");
    toast({ title: "Copied!", description: "Paste this in your terminal to start sharing." });
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

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{totalGpus}</div>
            <p className="text-sm text-muted-foreground mt-1">GPUs sharing</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{contribs.activeContributors || 0}</div>
            <p className="text-sm text-muted-foreground mt-1">Contributors</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">{((contribs.totalTokens || 0) / 1000).toFixed(0)}K</div>
            <p className="text-sm text-muted-foreground mt-1">AI words generated</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-3xl font-bold">${(contribs.totalHbdEarned || 0).toFixed(2)}</div>
            <p className="text-sm text-muted-foreground mt-1">Rewards paid out</p>
          </CardContent>
        </Card>
      </div>

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
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/10 p-2 shrink-0">
                <span className="text-primary font-bold text-sm">1</span>
              </div>
              <div>
                <p className="font-medium">Get a Hive account</p>
                <p className="text-muted-foreground">Free blockchain account where rewards are sent (like a crypto wallet).</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/10 p-2 shrink-0">
                <span className="text-primary font-bold text-sm">2</span>
              </div>
              <div>
                <p className="font-medium">Run one command</p>
                <p className="text-muted-foreground">The script auto-detects your GPU and starts sharing.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-primary/10 p-2 shrink-0">
                <span className="text-primary font-bold text-sm">3</span>
              </div>
              <div>
                <p className="font-medium">Earn HBD ($1 each)</p>
                <p className="text-muted-foreground">Get paid based on how much AI work your GPU handles.</p>
              </div>
            </div>
          </div>

          {/* The command */}
          <div className="flex items-center gap-2 p-3 rounded-lg bg-background border">
            <code className="flex-1 font-mono text-sm">python scripts/start_spiritbomb.py</code>
            <Button variant="ghost" size="sm" onClick={copyCommand}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <a href="https://signup.hive.io" target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm" className="gap-1">
                Create Hive Account <ExternalLink className="h-3 w-3" />
              </Button>
            </a>
            <p className="text-xs text-muted-foreground self-center">
              Requirements: NVIDIA GPU (8+ GB), Python 3.10+
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
