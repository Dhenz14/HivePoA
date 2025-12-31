import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { Server, CheckCircle2, AlertTriangle, XCircle, Clock, Activity, Shield, ChevronDown, ChevronUp, Eye } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";

interface NodeDetails {
  id: string;
  peerId: string;
  username: string;
  reputation: number;
  status: string;
  consecutiveFails: number;
  totalProofs: number;
  failedProofs: number;
  lastSeen: string;
  riskLevel: string;
  recentStats: {
    challenges: number;
    success: number;
    fail: number;
    successRate: string;
  };
  avgLatency: number;
}

interface NodesData {
  all: NodeDetails[];
  atRisk: NodeDetails[];
  banned: NodeDetails[];
  probation: NodeDetails[];
  healthy: NodeDetails[];
  summary: {
    total: number;
    healthy: number;
    atRisk: number;
    banned: number;
    probation: number;
  };
}

async function fetchNodes(sessionToken?: string): Promise<NodesData> {
  const headers: HeadersInit = {};
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }
  
  const res = await fetch("/api/validator/nodes", { headers });
  if (!res.ok) {
    return {
      all: [],
      atRisk: [],
      banned: [],
      probation: [],
      healthy: [],
      summary: { total: 0, healthy: 0, atRisk: 0, banned: 0, probation: 0 },
    };
  }
  return res.json();
}

function formatLastSeen(dateStr: string): string {
  if (!dateStr) return "Never";
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getStatusIcon(node: NodeDetails) {
  if (node.status === "banned") return <XCircle className="w-4 h-4 text-red-500" />;
  if (node.status === "probation") return <AlertTriangle className="w-4 h-4 text-orange-500" />;
  if (node.consecutiveFails >= 2) return <AlertTriangle className="w-4 h-4 text-red-500" />;
  if (node.consecutiveFails >= 1) return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
  if (node.reputation < 30) return <AlertTriangle className="w-4 h-4 text-orange-500" />;
  return <CheckCircle2 className="w-4 h-4 text-green-500" />;
}

function getRowColor(node: NodeDetails): string {
  if (node.status === "banned") return "bg-red-500/5 hover:bg-red-500/10";
  if (node.status === "probation") return "bg-orange-500/5 hover:bg-orange-500/10";
  if (node.consecutiveFails >= 2) return "bg-red-500/5 hover:bg-red-500/10";
  if (node.consecutiveFails >= 1 || node.reputation < 30) return "bg-yellow-500/5 hover:bg-yellow-500/10";
  return "hover:bg-accent/50";
}

function getReputationColor(reputation: number): string {
  if (reputation >= 80) return "bg-green-500";
  if (reputation >= 50) return "bg-lime-500";
  if (reputation >= 30) return "bg-yellow-500";
  if (reputation >= 10) return "bg-orange-500";
  return "bg-red-500";
}

function getHealthMapColor(node: NodeDetails): string {
  if (node.status === "banned") return "bg-red-500";
  if (node.status === "probation" || node.riskLevel === "at-risk") return "bg-orange-500";
  if (node.consecutiveFails >= 1 || node.reputation < 30) return "bg-yellow-500";
  return "bg-green-500";
}

function getLatencyColor(latency: number): string {
  if (latency < 500) return "text-green-500";
  if (latency < 1500) return "text-yellow-500";
  return "text-red-500";
}

export default function NodeMonitoring() {
  const { user } = useValidatorAuth();
  const sessionToken = user?.sessionToken;
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<NodeDetails | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["validator", "nodes"],
    queryFn: () => fetchNodes(sessionToken),
    refetchInterval: 10000,
  });

  const toggleRow = (nodeId: string) => {
    setExpandedRow(expandedRow === nodeId ? null : nodeId);
  };

  const openDetails = (node: NodeDetails) => {
    setSelectedNode(node);
    setDetailsOpen(true);
  };

  const recentBans = data?.banned.slice(0, 5).map(node => ({
    username: node.username,
    reason: `${node.consecutiveFails || 3} consecutive failures`,
    time: formatLastSeen(node.lastSeen),
  })) || [];

  if (isLoading || !data) {
    return (
      <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-node-monitoring">
        <div>
          <h1 className="text-3xl font-display font-bold">Node Monitoring</h1>
          <p className="text-muted-foreground mt-1">Loading node data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-node-monitoring">
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-3">
            <Server className="w-8 h-8 text-primary" />
            <h1 className="text-3xl font-display font-bold" data-testid="text-page-title">
              Node Monitoring
            </h1>
          </div>
          <p className="text-muted-foreground mt-1">Monitor all storage nodes on the network</p>
        </div>
        <span className="px-3 py-1 bg-primary/10 text-primary text-xs rounded-full font-mono flex items-center gap-2 border border-primary/20">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          Live Updates
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="summary-bar">
        <SummaryCard
          title="Total Nodes"
          value={data.summary.total}
          icon={Server}
          iconColor="text-primary"
          testId="card-total-nodes"
        />
        <SummaryCard
          title="Healthy"
          value={data.summary.healthy}
          icon={CheckCircle2}
          iconColor="text-green-500"
          testId="card-healthy-nodes"
        />
        <SummaryCard
          title="At Risk"
          value={data.summary.atRisk}
          icon={AlertTriangle}
          iconColor="text-yellow-500"
          testId="card-at-risk-nodes"
        />
        <SummaryCard
          title="Banned"
          value={data.summary.banned}
          icon={XCircle}
          iconColor="text-red-500"
          testId="card-banned-nodes"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-node-tabs">
            <CardHeader>
              <CardTitle className="font-display flex items-center gap-2">
                <Activity className="w-5 h-5 text-primary" />
                Storage Nodes
              </CardTitle>
              <CardDescription>View and manage network storage nodes</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="all" data-testid="tabs-nodes">
                <TabsList className="grid w-full grid-cols-4">
                  <TabsTrigger value="all" data-testid="tab-all-nodes">
                    All Nodes ({data.all.length})
                  </TabsTrigger>
                  <TabsTrigger value="at-risk" data-testid="tab-at-risk">
                    At Risk ({data.atRisk.length})
                  </TabsTrigger>
                  <TabsTrigger value="banned" data-testid="tab-banned">
                    Banned ({data.banned.length})
                  </TabsTrigger>
                  <TabsTrigger value="probation" data-testid="tab-probation">
                    Probation ({data.probation.length})
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="all" data-testid="content-all-nodes">
                  <NodeTable
                    nodes={data.all}
                    expandedRow={expandedRow}
                    toggleRow={toggleRow}
                    openDetails={openDetails}
                  />
                </TabsContent>
                <TabsContent value="at-risk" data-testid="content-at-risk">
                  <NodeTable
                    nodes={data.atRisk}
                    expandedRow={expandedRow}
                    toggleRow={toggleRow}
                    openDetails={openDetails}
                  />
                </TabsContent>
                <TabsContent value="banned" data-testid="content-banned">
                  <NodeTable
                    nodes={data.banned}
                    expandedRow={expandedRow}
                    toggleRow={toggleRow}
                    openDetails={openDetails}
                  />
                </TabsContent>
                <TabsContent value="probation" data-testid="content-probation">
                  <NodeTable
                    nodes={data.probation}
                    expandedRow={expandedRow}
                    toggleRow={toggleRow}
                    openDetails={openDetails}
                  />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-health-map">
            <CardHeader>
              <CardTitle className="font-display flex items-center gap-2">
                <Shield className="w-5 h-5 text-primary" />
                Node Health Map
              </CardTitle>
              <CardDescription>Visual overview of all nodes</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-8 gap-1" data-testid="health-map-grid">
                {data.all.map((node) => (
                  <Tooltip key={node.id}>
                    <TooltipTrigger asChild>
                      <motion.div
                        className={cn(
                          "w-6 h-6 rounded cursor-pointer transition-transform hover:scale-110",
                          getHealthMapColor(node)
                        )}
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        data-testid={`health-square-${node.id}`}
                      />
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="text-sm">
                        <p className="font-medium">{node.username}</p>
                        <p className="text-muted-foreground">Reputation: {node.reputation}</p>
                        <p className="text-muted-foreground">Status: {node.status}</p>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
              <div className="flex justify-center gap-4 mt-4 text-xs">
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-green-500" />
                  Healthy
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-yellow-500" />
                  Warning
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-orange-500" />
                  At-Risk
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded bg-red-500" />
                  Banned
                </span>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-recent-bans">
            <CardHeader>
              <CardTitle className="font-display flex items-center gap-2">
                <XCircle className="w-5 h-5 text-red-500" />
                Recent Bans
              </CardTitle>
              <CardDescription>Recently banned storage nodes</CardDescription>
            </CardHeader>
            <CardContent>
              {recentBans.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No recent bans</p>
              ) : (
                <div className="space-y-3">
                  {recentBans.map((ban, index) => (
                    <div
                      key={index}
                      className="p-3 bg-red-500/5 border border-red-500/20 rounded-lg"
                      data-testid={`ban-entry-${index}`}
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <XCircle className="w-4 h-4 text-red-500" />
                        <span className="text-muted-foreground">Banned {ban.time}:</span>
                      </div>
                      <p className="text-sm mt-1">
                        <span className="font-medium">{ban.username}</span>
                        <span className="text-muted-foreground"> - {ban.reason}</span>
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-2xl" data-testid="dialog-node-details">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Server className="w-5 h-5" />
              Node Details: {selectedNode?.username}
            </DialogTitle>
            <DialogDescription>
              Detailed information about this storage node
            </DialogDescription>
          </DialogHeader>
          {selectedNode && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge
                    variant={selectedNode.status === "active" ? "default" : "destructive"}
                    data-testid="detail-status"
                  >
                    {selectedNode.status}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-muted-foreground">Risk Level</p>
                  <Badge
                    variant={selectedNode.riskLevel === "healthy" ? "outline" : "secondary"}
                    data-testid="detail-risk-level"
                  >
                    {selectedNode.riskLevel}
                  </Badge>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Reputation</p>
                <div className="flex items-center gap-3">
                  <Progress
                    value={selectedNode.reputation}
                    className="h-3 flex-1"
                    data-testid="detail-reputation-bar"
                  />
                  <span className="text-lg font-bold" data-testid="detail-reputation">
                    {selectedNode.reputation}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div className="p-3 bg-background/50 rounded-lg border text-center">
                  <p className="text-xs text-muted-foreground">Total Proofs</p>
                  <p className="text-xl font-bold" data-testid="detail-total-proofs">
                    {selectedNode.totalProofs}
                  </p>
                </div>
                <div className="p-3 bg-background/50 rounded-lg border text-center">
                  <p className="text-xs text-muted-foreground">Failed Proofs</p>
                  <p className="text-xl font-bold text-red-500" data-testid="detail-failed-proofs">
                    {selectedNode.failedProofs}
                  </p>
                </div>
                <div className="p-3 bg-background/50 rounded-lg border text-center">
                  <p className="text-xs text-muted-foreground">Consecutive Fails</p>
                  <p className={cn(
                    "text-xl font-bold",
                    selectedNode.consecutiveFails >= 2 ? "text-red-500" :
                    selectedNode.consecutiveFails >= 1 ? "text-yellow-500" :
                    "text-green-500"
                  )} data-testid="detail-consecutive-fails">
                    {selectedNode.consecutiveFails}/3
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="p-3 bg-background/50 rounded-lg border">
                  <p className="text-xs text-muted-foreground">Success Rate (24h)</p>
                  <p className="text-lg font-bold text-green-500" data-testid="detail-success-rate">
                    {selectedNode.recentStats.successRate}%
                  </p>
                </div>
                <div className="p-3 bg-background/50 rounded-lg border">
                  <p className="text-xs text-muted-foreground">Avg Latency</p>
                  <p className={cn("text-lg font-bold", getLatencyColor(selectedNode.avgLatency))} data-testid="detail-avg-latency">
                    {selectedNode.avgLatency}ms
                  </p>
                </div>
              </div>

              <div className="p-3 bg-background/50 rounded-lg border">
                <p className="text-xs text-muted-foreground">Last Seen</p>
                <p className="text-sm" data-testid="detail-last-seen">
                  {formatLastSeen(selectedNode.lastSeen)}
                </p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface SummaryCardProps {
  title: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  testId: string;
}

function SummaryCard({ title, value, icon: Icon, iconColor, testId }: SummaryCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
    >
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid={testId}>
        <CardContent className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">{title}</p>
              <p className="text-3xl font-bold mt-1" data-testid={`${testId}-value`}>{value}</p>
            </div>
            <div className={cn("w-12 h-12 rounded-lg bg-background/50 flex items-center justify-center", iconColor)}>
              <Icon className="w-6 h-6" />
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

interface NodeTableProps {
  nodes: NodeDetails[];
  expandedRow: string | null;
  toggleRow: (nodeId: string) => void;
  openDetails: (node: NodeDetails) => void;
}

function NodeTable({ nodes, expandedRow, toggleRow, openDetails }: NodeTableProps) {
  if (nodes.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No nodes found in this category
      </div>
    );
  }

  return (
    <div className="mt-4 rounded-md border">
      <Table data-testid="table-nodes">
        <TableHeader>
          <TableRow>
            <TableHead className="w-12"></TableHead>
            <TableHead>Username</TableHead>
            <TableHead>Reputation</TableHead>
            <TableHead>Cons. Fails</TableHead>
            <TableHead>Success (24h)</TableHead>
            <TableHead>Avg Latency</TableHead>
            <TableHead>Last Seen</TableHead>
            <TableHead className="w-20"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.map((node) => (
            <>
              <TableRow
                key={node.id}
                className={cn("cursor-pointer transition-colors", getRowColor(node))}
                onClick={() => toggleRow(node.id)}
                data-testid={`row-node-${node.id}`}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    {getStatusIcon(node)}
                    {expandedRow === node.id ? (
                      <ChevronUp className="w-4 h-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-muted-foreground" />
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-medium" data-testid={`cell-username-${node.id}`}>
                  {node.username}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className="w-16 h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn("h-full transition-all", getReputationColor(node.reputation))}
                        style={{ width: `${node.reputation}%` }}
                      />
                    </div>
                    <span className="text-sm" data-testid={`cell-reputation-${node.id}`}>
                      {node.reputation}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge
                    variant={node.consecutiveFails >= 2 ? "destructive" : node.consecutiveFails >= 1 ? "secondary" : "outline"}
                    data-testid={`cell-fails-${node.id}`}
                  >
                    {node.consecutiveFails}/3
                  </Badge>
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      parseFloat(node.recentStats.successRate) >= 90 ? "text-green-500" :
                      parseFloat(node.recentStats.successRate) >= 70 ? "text-yellow-500" :
                      "text-red-500"
                    )}
                    data-testid={`cell-success-${node.id}`}
                  >
                    {node.recentStats.successRate}%
                  </span>
                </TableCell>
                <TableCell>
                  <span className={getLatencyColor(node.avgLatency)} data-testid={`cell-latency-${node.id}`}>
                    {node.avgLatency}ms
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground" data-testid={`cell-last-seen-${node.id}`}>
                  {formatLastSeen(node.lastSeen)}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      openDetails(node);
                    }}
                    data-testid={`button-view-details-${node.id}`}
                  >
                    <Eye className="w-4 h-4" />
                  </Button>
                </TableCell>
              </TableRow>
              {expandedRow === node.id && (
                <TableRow className="bg-muted/30" data-testid={`row-expanded-${node.id}`}>
                  <TableCell colSpan={8}>
                    <div className="p-4 grid grid-cols-4 gap-4">
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground">Total Proofs</p>
                        <p className="text-lg font-bold">{node.totalProofs}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground">Failed Proofs</p>
                        <p className="text-lg font-bold text-red-500">{node.failedProofs}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground">24h Challenges</p>
                        <p className="text-lg font-bold">{node.recentStats.challenges}</p>
                      </div>
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground">Status</p>
                        <Badge variant={node.status === "active" ? "default" : "destructive"}>
                          {node.status}
                        </Badge>
                      </div>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
