import { useState, useRef, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Clock, CheckCircle2, XCircle, AlertTriangle, Zap, ChevronDown, ChevronRight, RotateCcw, Activity, ExternalLink } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";

type ChallengeResult = "pass" | "fail" | "timeout" | "pending";

interface Challenge {
  id: string;
  nodeUsername: string;
  nodeId: string;
  fileName: string;
  fileCid: string;
  latencyMs: number;
  result: ChallengeResult;
  timestamp: string;
  salt: string;
  byteRangeStart: number;
  byteRangeEnd: number;
  expectedHash?: string;
  receivedHash?: string;
  responseTimeBreakdown?: {
    networkMs: number;
    computeMs: number;
    totalMs: number;
  };
}

interface ChallengeStats {
  pendingCount: number;
  completedToday: number;
  failedToday: number;
  challenges: Challenge[];
}

async function fetchChallenges(sessionToken?: string): Promise<ChallengeStats> {
  const headers: HeadersInit = {};
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }
  
  const res = await fetch("/api/validator/challenges", { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch challenges: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return {
    pendingCount: data.pendingCount || 0,
    completedToday: data.completedToday || 0,
    failedToday: data.failedToday || 0,
    challenges: (data.challenges || []).map((c: any) => ({
      id: c.id,
      nodeUsername: c.nodeUsername || c.node?.username || "unknown",
      nodeId: c.nodeId || c.node?.id || "",
      fileName: c.fileName || c.file?.name || "unknown",
      fileCid: c.fileCid || c.file?.cid || "",
      latencyMs: c.latencyMs || 0,
      result: mapResult(c.result),
      timestamp: c.timestamp || c.createdAt || new Date().toISOString(),
      salt: c.salt || "",
      byteRangeStart: c.byteRangeStart || 0,
      byteRangeEnd: c.byteRangeEnd || 0,
      expectedHash: c.expectedHash,
      receivedHash: c.receivedHash,
      responseTimeBreakdown: c.responseTimeBreakdown,
    })),
  };
}

function mapResult(result: string): ChallengeResult {
  if (result === "success" || result === "pass") return "pass";
  if (result === "fail" || result === "failed") return "fail";
  if (result === "timeout") return "timeout";
  return "pending";
}

function formatTimestamp(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return new Date(dateStr).toLocaleDateString();
}

function truncateCid(cid: string): string {
  if (cid.length <= 16) return cid;
  return `${cid.slice(0, 8)}...${cid.slice(-6)}`;
}

function getResultBadge(result: ChallengeResult) {
  switch (result) {
    case "pass":
      return <Badge className="bg-green-500/20 text-green-500 border-green-500/30" data-testid={`badge-result-pass`}>PASS</Badge>;
    case "fail":
      return <Badge className="bg-red-500/20 text-red-500 border-red-500/30" data-testid={`badge-result-fail`}>FAIL</Badge>;
    case "timeout":
      return <Badge className="bg-yellow-500/20 text-yellow-500 border-yellow-500/30" data-testid={`badge-result-timeout`}>TIMEOUT</Badge>;
    case "pending":
      return <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30" data-testid={`badge-result-pending`}>PENDING</Badge>;
  }
}

function getStatusIcon(result: ChallengeResult) {
  switch (result) {
    case "pass":
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case "fail":
      return <XCircle className="w-4 h-4 text-red-500" />;
    case "timeout":
      return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    case "pending":
      return <Clock className="w-4 h-4 text-gray-400 animate-pulse" />;
  }
}

export default function ChallengeQueue() {
  const { user } = useValidatorAuth();
  const sessionToken = user?.sessionToken;
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState("active");
  const [selectedChallenge, setSelectedChallenge] = useState<Challenge | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const feedRef = useRef<HTMLDivElement>(null);

  const { data: stats, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["validator", "challenges"],
    queryFn: () => fetchChallenges(sessionToken),
    refetchInterval: 5000,
    retry: 2,
  });

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
  }, [stats?.challenges]);

  const toggleRow = (id: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleRetry = (challenge: Challenge) => {
    toast({
      title: "Retry Initiated",
      description: `Retrying challenge for ${challenge.fileName} on ${challenge.nodeUsername}`,
    });
  };

  const filteredChallenges = stats?.challenges.filter(c => {
    if (activeTab === "active") return c.result === "pending";
    if (activeTab === "completed") return c.result === "pass";
    if (activeTab === "failed") return c.result === "fail" || c.result === "timeout";
    return true;
  }) || [];

  const latestChallenges = [...(stats?.challenges || [])].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  ).slice(0, 20);

  if (isLoading) {
    return (
      <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-challenge-queue-loading">
        <div>
          <h1 className="text-3xl font-display font-bold">Challenge Queue</h1>
          <p className="text-muted-foreground mt-1">Loading challenges...</p>
        </div>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-challenge-queue-error">
        <div>
          <h1 className="text-3xl font-display font-bold">Challenge Queue</h1>
          <p className="text-muted-foreground mt-1">View and manage PoA validation challenges</p>
        </div>
        <Card className="border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <XCircle className="w-12 h-12 text-red-500 mb-4" />
              <h3 className="text-lg font-semibold text-red-500 mb-2" data-testid="text-error-title">
                Failed to Load Challenges
              </h3>
              <p className="text-muted-foreground mb-4 max-w-md" data-testid="text-error-message">
                {error instanceof Error ? error.message : "An unexpected error occurred while fetching challenge data. Please try again."}
              </p>
              <Button
                onClick={() => refetch()}
                variant="outline"
                className="gap-2"
                data-testid="btn-retry-load"
              >
                <RotateCcw className="w-4 h-4" />
                Try Again
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-6 max-w-[1600px] mx-auto" data-testid="page-challenge-queue">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold" data-testid="text-page-title">Challenge Queue</h1>
          <p className="text-muted-foreground mt-1">View and manage PoA validation challenges</p>
        </div>
        <div className="flex gap-2">
          <span className="px-3 py-1 bg-primary/10 text-primary text-xs rounded-full font-mono flex items-center gap-2 border border-primary/20">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Live Updates
          </span>
        </div>
      </div>

      {/* Summary Stats Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="stats-row">
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-pending-count">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Pending Challenges</p>
                <p className="text-3xl font-bold font-display mt-1" data-testid="text-pending-count">
                  {stats?.pendingCount || 0}
                </p>
              </div>
              <div className="w-12 h-12 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                <Clock className="w-6 h-6 text-yellow-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-completed-today">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Completed Today</p>
                <p className="text-3xl font-bold font-display mt-1 text-green-500" data-testid="text-completed-today">
                  {stats?.completedToday || 0}
                </p>
              </div>
              <div className="w-12 h-12 rounded-lg bg-green-500/10 flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-green-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-failed-today">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Failed Today</p>
                <p className="text-3xl font-bold font-display mt-1 text-red-500" data-testid="text-failed-today">
                  {stats?.failedToday || 0}
                </p>
              </div>
              <div className="w-12 h-12 rounded-lg bg-red-500/10 flex items-center justify-center">
                <XCircle className="w-6 h-6 text-red-500" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Challenge Table (3 cols) */}
        <div className="lg:col-span-3">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-challenge-table">
            <CardHeader>
              <CardTitle className="font-display flex items-center gap-2">
                <Zap className="w-5 h-5 text-primary" />
                Challenges
              </CardTitle>
              <CardDescription>Click a row for detailed information</CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs value={activeTab} onValueChange={setActiveTab} data-testid="tabs-challenges">
                <TabsList className="mb-4">
                  <TabsTrigger value="active" data-testid="tab-active">
                    Active/Pending
                    <Badge variant="secondary" className="ml-2">{stats?.pendingCount || 0}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="completed" data-testid="tab-completed">
                    Completed
                    <Badge variant="secondary" className="ml-2">{stats?.completedToday || 0}</Badge>
                  </TabsTrigger>
                  <TabsTrigger value="failed" data-testid="tab-failed">
                    Failed
                    <Badge variant="secondary" className="ml-2">{stats?.failedToday || 0}</Badge>
                  </TabsTrigger>
                </TabsList>

                <TabsContent value={activeTab} className="mt-0">
                  <div className="rounded-md border border-border/50">
                    <Table data-testid="table-challenges">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[50px]"></TableHead>
                          <TableHead className="w-[100px]">Status</TableHead>
                          <TableHead>Node</TableHead>
                          <TableHead>File</TableHead>
                          <TableHead className="text-right">Latency</TableHead>
                          <TableHead className="text-center">Result</TableHead>
                          <TableHead className="text-right">Timestamp</TableHead>
                          <TableHead className="w-[80px]"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredChallenges.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={8} className="text-center py-12" data-testid="empty-state-challenges">
                              <div className="flex flex-col items-center justify-center">
                                <Clock className="w-10 h-10 text-muted-foreground/50 mb-3" />
                                <p className="text-muted-foreground font-medium mb-1">
                                  {activeTab === "active" && "No pending challenges"}
                                  {activeTab === "completed" && "No completed challenges today"}
                                  {activeTab === "failed" && "No failed challenges today"}
                                </p>
                                <p className="text-sm text-muted-foreground/70">
                                  {activeTab === "active" && "New validation challenges will appear here when nodes are challenged."}
                                  {activeTab === "completed" && "Successfully completed challenges will be listed here."}
                                  {activeTab === "failed" && "Failed or timed out challenges will be shown here."}
                                </p>
                              </div>
                            </TableCell>
                          </TableRow>
                        ) : (
                          filteredChallenges.map((challenge) => (
                            <Collapsible key={challenge.id} open={expandedRows.has(challenge.id)} onOpenChange={() => toggleRow(challenge.id)} asChild>
                              <>
                                <TableRow
                                  className="cursor-pointer hover:bg-muted/50 transition-colors"
                                  onClick={() => setSelectedChallenge(challenge)}
                                  data-testid={`row-challenge-${challenge.id}`}
                                >
                                  <TableCell>
                                    <CollapsibleTrigger asChild onClick={(e) => e.stopPropagation()}>
                                      <Button variant="ghost" size="sm" className="p-0 h-6 w-6" data-testid={`btn-expand-${challenge.id}`}>
                                        {expandedRows.has(challenge.id) ? (
                                          <ChevronDown className="w-4 h-4" />
                                        ) : (
                                          <ChevronRight className="w-4 h-4" />
                                        )}
                                      </Button>
                                    </CollapsibleTrigger>
                                  </TableCell>
                                  <TableCell>{getStatusIcon(challenge.result)}</TableCell>
                                  <TableCell className="font-medium" data-testid={`text-node-${challenge.id}`}>
                                    {challenge.nodeUsername}
                                  </TableCell>
                                  <TableCell className="font-mono text-xs" data-testid={`text-file-${challenge.id}`}>
                                    {challenge.fileName}
                                  </TableCell>
                                  <TableCell className="text-right font-mono" data-testid={`text-latency-${challenge.id}`}>
                                    {challenge.latencyMs}ms
                                  </TableCell>
                                  <TableCell className="text-center">{getResultBadge(challenge.result)}</TableCell>
                                  <TableCell className="text-right text-muted-foreground text-sm" data-testid={`text-timestamp-${challenge.id}`}>
                                    {formatTimestamp(challenge.timestamp)}
                                  </TableCell>
                                  <TableCell>
                                    {(challenge.result === "fail" || challenge.result === "timeout") && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-8 w-8 p-0"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              handleRetry(challenge);
                                            }}
                                            data-testid={`btn-retry-${challenge.id}`}
                                          >
                                            <RotateCcw className="w-4 h-4" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Retry Challenge</TooltipContent>
                                      </Tooltip>
                                    )}
                                  </TableCell>
                                </TableRow>
                                <CollapsibleContent asChild>
                                  <TableRow className="bg-muted/30" data-testid={`row-expanded-${challenge.id}`}>
                                    <TableCell colSpan={8}>
                                      <div className="p-4 space-y-2">
                                        <div className="grid grid-cols-2 gap-4 text-sm">
                                          <div>
                                            <span className="text-muted-foreground">Salt:</span>
                                            <span className="ml-2 font-mono">{challenge.salt}</span>
                                          </div>
                                          <div>
                                            <span className="text-muted-foreground">Byte Range:</span>
                                            <span className="ml-2 font-mono">
                                              {challenge.byteRangeStart.toLocaleString()} - {challenge.byteRangeEnd.toLocaleString()}
                                            </span>
                                          </div>
                                        </div>
                                        <div>
                                          <span className="text-muted-foreground text-sm">CID:</span>
                                          <span className="ml-2 font-mono text-xs">{challenge.fileCid}</span>
                                        </div>
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                </CollapsibleContent>
                              </>
                            </Collapsible>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>

        {/* Live Activity Feed (1 col) */}
        <div className="lg:col-span-1">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm h-[600px] flex flex-col" data-testid="card-live-feed">
            <CardHeader className="pb-2">
              <CardTitle className="font-display flex items-center gap-2 text-base">
                <Activity className="w-4 h-4 text-primary" />
                Live Activity
              </CardTitle>
              <CardDescription className="text-xs">Real-time challenge updates</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-0">
              <ScrollArea className="h-full px-4" ref={feedRef}>
                {latestChallenges.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full py-12 text-center" data-testid="empty-state-live-feed">
                    <Activity className="w-8 h-8 text-muted-foreground/50 mb-3" />
                    <p className="text-muted-foreground text-sm font-medium mb-1">No activity yet</p>
                    <p className="text-xs text-muted-foreground/70 max-w-[200px]">
                      Challenge events will appear here in real-time as they occur.
                    </p>
                  </div>
                ) : (
                  <AnimatePresence mode="popLayout">
                    {latestChallenges.map((challenge, index) => (
                      <motion.div
                        key={challenge.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        transition={{ duration: 0.2, delay: index * 0.02 }}
                        className={cn(
                          "p-3 mb-2 rounded-lg border cursor-pointer transition-colors hover:bg-muted/50",
                          challenge.result === "pass" && "border-green-500/30 bg-green-500/5",
                          challenge.result === "fail" && "border-red-500/30 bg-red-500/5",
                          challenge.result === "timeout" && "border-yellow-500/30 bg-yellow-500/5",
                          challenge.result === "pending" && "border-gray-500/30 bg-gray-500/5"
                        )}
                        onClick={() => setSelectedChallenge(challenge)}
                        data-testid={`feed-item-${challenge.id}`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium text-sm truncate max-w-[120px]">
                            {challenge.nodeUsername}
                          </span>
                          {getResultBadge(challenge.result)}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {challenge.fileName}
                        </div>
                        <div className="flex justify-between items-center mt-2 text-xs">
                          <span className="font-mono text-muted-foreground">
                            {challenge.latencyMs}ms
                          </span>
                          <span className="text-muted-foreground">
                            {formatTimestamp(challenge.timestamp)}
                          </span>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Challenge Details Modal */}
      <Dialog open={!!selectedChallenge} onOpenChange={(open) => !open && setSelectedChallenge(null)}>
        <DialogContent className="max-w-2xl" data-testid="dialog-challenge-details">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2">
              Challenge Details
              {selectedChallenge && getResultBadge(selectedChallenge.result)}
            </DialogTitle>
            <DialogDescription>
              Full information about this validation challenge
            </DialogDescription>
          </DialogHeader>

          {selectedChallenge && (
            <div className="space-y-6 mt-4">
              {/* Node Details */}
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Node Details</h4>
                <div className="p-4 rounded-lg bg-muted/50 border border-border/50 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Username</span>
                    <span className="font-medium" data-testid="modal-node-username">{selectedChallenge.nodeUsername}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Node ID</span>
                    <span className="font-mono text-sm">{selectedChallenge.nodeId}</span>
                  </div>
                  <div className="flex justify-end">
                    <Link href="/node-monitoring">
                      <Button variant="outline" size="sm" className="gap-2" data-testid="btn-view-node">
                        <ExternalLink className="w-3 h-3" />
                        View in Node Monitor
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>

              {/* File Details */}
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">File Details</h4>
                <div className="p-4 rounded-lg bg-muted/50 border border-border/50 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">File Name</span>
                    <span className="font-medium" data-testid="modal-file-name">{selectedChallenge.fileName}</span>
                  </div>
                  <div className="flex justify-between items-start">
                    <span className="text-muted-foreground">CID</span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="font-mono text-xs text-right max-w-[300px] break-all cursor-help" data-testid="modal-file-cid">
                          {selectedChallenge.fileCid}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Click to copy</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>

              {/* Challenge Data */}
              <div className="space-y-2">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Challenge Data</h4>
                <div className="p-4 rounded-lg bg-muted/50 border border-border/50 space-y-2">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Salt</span>
                    <span className="font-mono text-sm" data-testid="modal-salt">{selectedChallenge.salt}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Byte Range</span>
                    <span className="font-mono text-sm" data-testid="modal-byte-range">
                      {selectedChallenge.byteRangeStart.toLocaleString()} - {selectedChallenge.byteRangeEnd.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Timestamp</span>
                    <span className="text-sm">{new Date(selectedChallenge.timestamp).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* Hash Comparison (if failed) */}
              {selectedChallenge.result === "fail" && selectedChallenge.expectedHash && selectedChallenge.receivedHash && (
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold text-red-500 uppercase tracking-wider">Hash Mismatch</h4>
                  <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 space-y-2">
                    <div className="flex justify-between items-start">
                      <span className="text-muted-foreground">Expected Hash</span>
                      <span className="font-mono text-xs text-green-500" data-testid="modal-expected-hash">
                        {selectedChallenge.expectedHash}
                      </span>
                    </div>
                    <div className="flex justify-between items-start">
                      <span className="text-muted-foreground">Received Hash</span>
                      <span className="font-mono text-xs text-red-500" data-testid="modal-received-hash">
                        {selectedChallenge.receivedHash}
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Response Time Breakdown */}
              {selectedChallenge.responseTimeBreakdown && (
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Response Time Breakdown</h4>
                  <div className="p-4 rounded-lg bg-muted/50 border border-border/50">
                    <div className="grid grid-cols-3 gap-4 text-center">
                      <div>
                        <p className="text-xs text-muted-foreground">Network</p>
                        <p className="text-lg font-bold text-blue-500" data-testid="modal-network-ms">
                          {selectedChallenge.responseTimeBreakdown.networkMs}ms
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Compute</p>
                        <p className="text-lg font-bold text-purple-500" data-testid="modal-compute-ms">
                          {selectedChallenge.responseTimeBreakdown.computeMs}ms
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Total</p>
                        <p className="text-lg font-bold text-primary" data-testid="modal-total-ms">
                          {selectedChallenge.responseTimeBreakdown.totalMs}ms
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Actions */}
              {(selectedChallenge.result === "fail" || selectedChallenge.result === "timeout") && (
                <div className="flex justify-end">
                  <Button
                    onClick={() => {
                      handleRetry(selectedChallenge);
                      setSelectedChallenge(null);
                    }}
                    className="gap-2"
                    data-testid="modal-btn-retry"
                  >
                    <RotateCcw className="w-4 h-4" />
                    Retry Challenge
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
