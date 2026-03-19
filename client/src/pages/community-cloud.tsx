import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Activity, Cpu, Globe, Server, Zap, Users, Coins } from "lucide-react";
import { getApiBase } from "@/lib/api-mode";

export default function CommunityCloud() {
  const { data: dashboard, isLoading } = useQuery({
    queryKey: ["/api/community/dashboard"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/community/dashboard`);
      return res.json();
    },
    refetchInterval: 15000,
  });

  const tier = dashboard?.tier?.tier || 1;
  const totalGpus = dashboard?.tier?.totalGpus || 0;
  const clusters = dashboard?.clusters?.clusters || [];
  const routes = dashboard?.inference?.routes?.routes || [];
  const contribs = dashboard?.inference?.contributions || {};
  const status = dashboard?.spiritBomb?.status || "initializing";

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Activity className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Community Cloud</h1>
            <p className="text-muted-foreground">
              Spirit Bomb — Permissionless GPU Cloud
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Badge variant={status === "active" ? "default" : "secondary"} className="text-sm">
            {status === "active" ? "Active" : "Initializing"}
          </Badge>
          <Badge variant="outline" className="text-sm">Tier {tier}</Badge>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total GPUs</CardTitle>
            <Cpu className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalGpus}</div>
            <p className="text-xs text-muted-foreground">
              {tier === 1 ? "< 15 needed for Tier 2" : tier === 2 ? "< 40 needed for Tier 3" : "Full Brain active"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Clusters</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{clusters.length}</div>
            <p className="text-xs text-muted-foreground">
              {dashboard?.tier?.totalVramGb || 0} GB total VRAM
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Tokens Generated</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(contribs.totalTokens || 0).toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              {(contribs.totalRequests || 0).toLocaleString()} requests served
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Contributors</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{contribs.activeContributors || 0}</div>
            <p className="text-xs text-muted-foreground">
              {(contribs.totalHbdEarned || 0).toFixed(3)} HBD earned
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tier Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Current Tier Configuration</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground block">Base Model</span>
              <span className="font-medium">{dashboard?.tier?.baseModel || "Qwen3-14B"}</span>
            </div>
            <div>
              <span className="text-muted-foreground block">Active Experts</span>
              <span className="font-medium">{dashboard?.tier?.activeExperts || 2} MoE</span>
            </div>
            <div>
              <span className="text-muted-foreground block">Quantization</span>
              <span className="font-medium uppercase">{dashboard?.tier?.quantization || "awq"}</span>
            </div>
            <div>
              <span className="text-muted-foreground block">Context Length</span>
              <span className="font-medium">
                {((dashboard?.tier?.maxContextLength || 32768) / 1024).toFixed(0)}K
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Clusters */}
      {clusters.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>GPU Clusters</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {clusters.map((cluster: any) => (
                <div
                  key={cluster.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div className="flex items-center gap-3">
                    <Globe className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">{cluster.name || cluster.id}</p>
                      <p className="text-xs text-muted-foreground">
                        {cluster.region} — {cluster.totalGpus} GPUs, {cluster.totalVramGb} GB VRAM
                      </p>
                    </div>
                  </div>
                  <Badge variant={cluster.status === "active" ? "default" : "secondary"}>
                    {cluster.status}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Inference Routes */}
      {routes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Inference Routes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {routes.map((route: any) => (
                <div
                  key={route.id}
                  className="flex items-center justify-between p-2 rounded border text-sm"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{route.mode}</Badge>
                    <span>{route.modelName}</span>
                    {route.pipelineStages > 1 && (
                      <span className="text-xs text-muted-foreground">
                        PP={route.pipelineStages}
                      </span>
                    )}
                    {route.tensorParallelSize > 1 && (
                      <span className="text-xs text-muted-foreground">
                        TP={route.tensorParallelSize}
                      </span>
                    )}
                  </div>
                  <Badge variant={route.status === "active" ? "default" : "secondary"}>
                    priority={route.priority}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
