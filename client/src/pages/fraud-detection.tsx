import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AlertTriangle, ShieldAlert, Hash, Users, Flag, Eye, Ban, ChevronDown, ChevronUp } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";

interface SuspiciousPattern {
  type: string;
  nodeId: string;
  nodeUsername: string;
  description: string;
  avgLatency: number;
  stdDev?: number;
  severity: "high" | "medium" | "low";
}

interface HashMismatch {
  id: string;
  nodeId: string;
  nodeUsername: string;
  timestamp: string;
  challengeData: string;
  response: string;
}

interface CollusionAlert {
  nodes: { id: string; username: string }[];
  similarity: number;
  description: string;
}

interface FraudData {
  suspiciousPatterns: SuspiciousPattern[];
  hashMismatches: HashMismatch[];
  collusionAlerts: CollusionAlert[];
  summary: {
    totalSuspicious: number;
    totalMismatches: number;
    totalCollusionAlerts: number;
  };
}

async function fetchFraudData(sessionToken?: string): Promise<FraudData> {
  const headers: HeadersInit = {};
  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }
  
  const res = await fetch("/api/validator/fraud", { headers });
  if (!res.ok) {
    return {
      suspiciousPatterns: [],
      hashMismatches: [],
      collusionAlerts: [],
      summary: { totalSuspicious: 0, totalMismatches: 0, totalCollusionAlerts: 0 },
    };
  }
  return res.json();
}

function formatTimestamp(dateStr: string): string {
  if (!dateStr) return "Unknown";
  const date = new Date(dateStr);
  return date.toLocaleString();
}

function truncateString(str: string, maxLen: number = 30): string {
  if (!str) return "N/A";
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen)}...`;
}

function getSeverityColor(severity: "high" | "medium" | "low"): string {
  switch (severity) {
    case "high": return "bg-red-500 text-white";
    case "medium": return "bg-orange-500 text-white";
    case "low": return "bg-yellow-500 text-black";
    default: return "bg-gray-500";
  }
}

function getSeverityBorderColor(severity: "high" | "medium" | "low"): string {
  switch (severity) {
    case "high": return "border-red-500/30 bg-red-500/5";
    case "medium": return "border-orange-500/30 bg-orange-500/5";
    case "low": return "border-yellow-500/30 bg-yellow-500/5";
    default: return "";
  }
}

function getPatternTypeLabel(type: string): string {
  switch (type) {
    case "high_variance": return "High Variance";
    case "too_fast": return "Too Fast";
    default: return type;
  }
}

export default function FraudDetection() {
  const { user } = useValidatorAuth();
  const sessionToken = user?.sessionToken;
  const { toast } = useToast();
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const [banningNode, setBanningNode] = useState<{ id: string; username: string } | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["validator", "fraud"],
    queryFn: () => fetchFraudData(sessionToken),
    refetchInterval: 30000,
  });

  const toggleRow = (id: string) => {
    setExpandedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  };

  const handleFlagForReview = (nodeUsername: string) => {
    toast({
      title: "Flagged for Review",
      description: `Node ${nodeUsername} has been flagged for manual review.`,
    });
  };

  const handleAddToWatchlist = (nodeUsername: string) => {
    toast({
      title: "Added to Watchlist",
      description: `Node ${nodeUsername} has been added to your watchlist.`,
    });
  };

  const handleBanNode = (nodeId: string, nodeUsername: string) => {
    toast({
      title: "Node Banned",
      description: `Node ${nodeUsername} has been banned from the network.`,
      variant: "destructive",
    });
    setBanningNode(null);
  };

  if (isLoading) {
    return (
      <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-fraud-detection">
        <div className="flex items-center gap-3">
          <ShieldAlert className="w-8 h-8 text-red-500" />
          <h1 className="text-3xl font-display font-bold">Fraud Detection</h1>
        </div>
        <div className="flex items-center justify-center py-12" data-testid="loading-state">
          <div className="flex flex-col items-center gap-4">
            <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" data-testid="loading-spinner" />
            <p className="text-muted-foreground" data-testid="loading-text">Loading fraud detection data...</p>
          </div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-fraud-detection">
        <div className="flex items-center gap-3">
          <ShieldAlert className="w-8 h-8 text-red-500" />
          <h1 className="text-3xl font-display font-bold">Fraud Detection</h1>
        </div>
        <Card className="border-red-500/50 bg-red-500/5" data-testid="error-state">
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <AlertTriangle className="w-6 h-6 text-red-500" />
              <div>
                <p className="font-medium text-red-500" data-testid="error-title">Error Loading Data</p>
                <p className="text-sm text-muted-foreground" data-testid="error-message">
                  {error instanceof Error ? error.message : "Failed to load fraud detection data. Please try again."}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  const highSeverityCount = data.suspiciousPatterns.filter(p => p.severity === "high").length;

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-fraud-detection">
      <div className="flex justify-between items-start">
        <div>
          <div className="flex items-center gap-3">
            <ShieldAlert className="w-8 h-8 text-red-500" />
            <h1 className="text-3xl font-display font-bold" data-testid="text-page-title">
              Fraud Detection
            </h1>
          </div>
          <p className="text-muted-foreground mt-1">Detect and investigate suspicious node behavior</p>
        </div>
        <span className="px-3 py-1 bg-primary/10 text-primary text-xs rounded-full font-mono flex items-center gap-2 border border-primary/20">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          Auto-refresh: 30s
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="summary-alert-bar">
        <Card className={cn(
          "border-2",
          data.summary.totalSuspicious > 0 ? "border-orange-500/50 bg-orange-500/5" : "border-border/50"
        )} data-testid="card-summary-suspicious">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className={cn(
                "w-10 h-10 rounded-lg flex items-center justify-center",
                data.summary.totalSuspicious > 0 ? "bg-orange-500/20" : "bg-muted"
              )}>
                <AlertTriangle className={cn(
                  "w-5 h-5",
                  data.summary.totalSuspicious > 0 ? "text-orange-500" : "text-muted-foreground"
                )} />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Suspicious Patterns</p>
                <p className="text-2xl font-bold" data-testid="text-suspicious-count">
                  {data.summary.totalSuspicious}
                </p>
                {highSeverityCount > 0 && (
                  <Badge className="bg-red-500 text-white mt-1" data-testid="badge-high-severity-count">
                    {highSeverityCount} high severity
                  </Badge>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={cn(
          "border-2",
          data.summary.totalMismatches > 0 ? "border-red-500/50 bg-red-500/5" : "border-border/50"
        )} data-testid="card-summary-mismatches">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className={cn(
                "w-10 h-10 rounded-lg flex items-center justify-center",
                data.summary.totalMismatches > 0 ? "bg-red-500/20" : "bg-muted"
              )}>
                <Hash className={cn(
                  "w-5 h-5",
                  data.summary.totalMismatches > 0 ? "text-red-500" : "text-muted-foreground"
                )} />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Hash Mismatches</p>
                <p className="text-2xl font-bold" data-testid="text-mismatches-count">
                  {data.summary.totalMismatches}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className={cn(
          "border-2",
          data.summary.totalCollusionAlerts > 0 ? "border-purple-500/50 bg-purple-500/5" : "border-border/50"
        )} data-testid="card-summary-collusion">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className={cn(
                "w-10 h-10 rounded-lg flex items-center justify-center",
                data.summary.totalCollusionAlerts > 0 ? "bg-purple-500/20" : "bg-muted"
              )}>
                <Users className={cn(
                  "w-5 h-5",
                  data.summary.totalCollusionAlerts > 0 ? "text-purple-500" : "text-muted-foreground"
                )} />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Collusion Alerts</p>
                <p className="text-2xl font-bold" data-testid="text-collusion-count">
                  {data.summary.totalCollusionAlerts}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-suspicious-patterns">
        <CardHeader>
          <CardTitle className="font-display flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-orange-500" />
            Suspicious Patterns
          </CardTitle>
          <CardDescription>Detected anomalies in node behavior that may indicate fraud</CardDescription>
        </CardHeader>
        <CardContent>
          {data.suspiciousPatterns.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="empty-suspicious">
              <AlertTriangle className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No suspicious patterns detected</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.suspiciousPatterns.map((pattern, index) => (
                <div
                  key={`${pattern.nodeId}-${pattern.type}-${index}`}
                  className={cn(
                    "p-4 rounded-lg border",
                    getSeverityBorderColor(pattern.severity)
                  )}
                  data-testid={`suspicious-pattern-${index}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge className={getSeverityColor(pattern.severity)} data-testid={`badge-severity-${index}`}>
                          {pattern.severity}
                        </Badge>
                        <Badge variant="outline" data-testid={`badge-type-${index}`}>
                          {getPatternTypeLabel(pattern.type)}
                        </Badge>
                        <span className="font-medium" data-testid={`text-node-username-${index}`}>
                          @{pattern.nodeUsername}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mb-2" data-testid={`text-description-${index}`}>
                        {pattern.description}
                      </p>
                      <div className="flex gap-4 text-sm">
                        <span>
                          Avg Latency: <strong data-testid={`text-avg-latency-${index}`}>{pattern.avgLatency}ms</strong>
                        </span>
                        {pattern.stdDev && (
                          <span>
                            Std Dev: <strong data-testid={`text-std-dev-${index}`}>{pattern.stdDev}ms</strong>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleFlagForReview(pattern.nodeUsername)}
                        data-testid={`button-flag-${index}`}
                      >
                        <Flag className="w-4 h-4 mr-1" />
                        Flag for Review
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleAddToWatchlist(pattern.nodeUsername)}
                        data-testid={`button-watchlist-${index}`}
                      >
                        <Eye className="w-4 h-4 mr-1" />
                        Add to Watchlist
                      </Button>
                      <AlertDialog open={banningNode?.id === pattern.nodeId} onOpenChange={(open) => !open && setBanningNode(null)}>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => setBanningNode({ id: pattern.nodeId, username: pattern.nodeUsername })}
                            data-testid={`button-ban-${index}`}
                          >
                            <Ban className="w-4 h-4 mr-1" />
                            Ban Node
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent data-testid="dialog-ban-confirm">
                          <AlertDialogHeader>
                            <AlertDialogTitle>Ban Node</AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to ban node <strong>@{banningNode?.username}</strong>? 
                              This action will remove the node from the network and prevent it from participating in challenges.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel data-testid="button-ban-cancel">Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => banningNode && handleBanNode(banningNode.id, banningNode.username)}
                              className="bg-red-500 hover:bg-red-600"
                              data-testid="button-ban-confirm"
                            >
                              Ban Node
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-hash-mismatches">
        <CardHeader>
          <CardTitle className="font-display flex items-center gap-2">
            <Hash className="w-5 h-5 text-red-500" />
            Hash Mismatch Log
          </CardTitle>
          <CardDescription>Failed proofs with mismatched hashes</CardDescription>
        </CardHeader>
        <CardContent>
          {data.hashMismatches.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="empty-mismatches">
              <Hash className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No hash mismatches detected</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Node</TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Challenge Data</TableHead>
                  <TableHead>Response</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.hashMismatches.map((mismatch) => (
                  <Collapsible key={mismatch.id} asChild open={expandedRows.has(mismatch.id)}>
                    <>
                      <TableRow
                        className="cursor-pointer hover:bg-red-500/5"
                        data-testid={`row-mismatch-${mismatch.id}`}
                      >
                        <TableCell>
                          <CollapsibleTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleRow(mismatch.id)}
                              data-testid={`button-expand-${mismatch.id}`}
                            >
                              {expandedRows.has(mismatch.id) ? (
                                <ChevronUp className="w-4 h-4" />
                              ) : (
                                <ChevronDown className="w-4 h-4" />
                              )}
                            </Button>
                          </CollapsibleTrigger>
                        </TableCell>
                        <TableCell className="font-medium" data-testid={`text-mismatch-node-${mismatch.id}`}>
                          @{mismatch.nodeUsername}
                        </TableCell>
                        <TableCell data-testid={`text-mismatch-timestamp-${mismatch.id}`}>
                          {formatTimestamp(mismatch.timestamp)}
                        </TableCell>
                        <TableCell className="font-mono text-sm" data-testid={`text-mismatch-challenge-${mismatch.id}`}>
                          {truncateString(mismatch.challengeData)}
                        </TableCell>
                        <TableCell className="font-mono text-sm" data-testid={`text-mismatch-response-${mismatch.id}`}>
                          {truncateString(mismatch.response)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleFlagForReview(mismatch.nodeUsername)}
                              data-testid={`button-flag-mismatch-${mismatch.id}`}
                            >
                              <Flag className="w-4 h-4" />
                            </Button>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  data-testid={`button-ban-mismatch-${mismatch.id}`}
                                >
                                  <Ban className="w-4 h-4" />
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent data-testid={`dialog-ban-mismatch-${mismatch.id}`}>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Ban Node</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    Are you sure you want to ban node <strong>@{mismatch.nodeUsername}</strong>?
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel data-testid={`button-ban-mismatch-cancel-${mismatch.id}`}>Cancel</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => handleBanNode(mismatch.nodeId, mismatch.nodeUsername)}
                                    className="bg-red-500 hover:bg-red-600"
                                    data-testid={`button-ban-mismatch-confirm-${mismatch.id}`}
                                  >
                                    Ban Node
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        </TableCell>
                      </TableRow>
                      <CollapsibleContent asChild>
                        <TableRow className="bg-muted/30" data-testid={`row-mismatch-expanded-${mismatch.id}`}>
                          <TableCell colSpan={6}>
                            <div className="p-4 space-y-3">
                              <div>
                                <p className="text-sm font-medium mb-1">Full Challenge Data:</p>
                                <pre className="text-xs font-mono bg-background p-3 rounded border overflow-x-auto" data-testid={`text-full-challenge-${mismatch.id}`}>
                                  {mismatch.challengeData || "N/A"}
                                </pre>
                              </div>
                              <div>
                                <p className="text-sm font-medium mb-1">Full Response:</p>
                                <pre className="text-xs font-mono bg-background p-3 rounded border overflow-x-auto" data-testid={`text-full-response-${mismatch.id}`}>
                                  {mismatch.response || "No response"}
                                </pre>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      </CollapsibleContent>
                    </>
                  </Collapsible>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-collusion-detection">
        <CardHeader>
          <CardTitle className="font-display flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-500" />
            Collusion Detection
          </CardTitle>
          <CardDescription>Pairs of nodes with suspiciously similar failure patterns</CardDescription>
        </CardHeader>
        <CardContent>
          {data.collusionAlerts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground" data-testid="empty-collusion">
              <Users className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No collusion patterns detected</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.collusionAlerts.map((alert, index) => (
                <div
                  key={index}
                  className="p-4 rounded-lg border border-purple-500/30 bg-purple-500/5"
                  data-testid={`collusion-alert-${index}`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <Badge variant="outline" className="border-purple-500 text-purple-500">
                          {alert.similarity.toFixed(1)}% similarity
                        </Badge>
                        <div className="flex items-center gap-2" data-testid={`text-collusion-nodes-${index}`}>
                          <span className="font-medium">@{alert.nodes[0]?.username}</span>
                          <span className="text-muted-foreground">&</span>
                          <span className="font-medium">@{alert.nodes[1]?.username}</span>
                        </div>
                      </div>
                      <p className="text-sm text-muted-foreground" data-testid={`text-collusion-description-${index}`}>
                        These nodes fail at the same time - possible coordination
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          handleAddToWatchlist(alert.nodes[0]?.username || "");
                          handleAddToWatchlist(alert.nodes[1]?.username || "");
                        }}
                        data-testid={`button-watchlist-collusion-${index}`}
                      >
                        <Eye className="w-4 h-4 mr-1" />
                        Watch Both
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleFlagForReview(`${alert.nodes[0]?.username} & ${alert.nodes[1]?.username}`)}
                        data-testid={`button-flag-collusion-${index}`}
                      >
                        <Flag className="w-4 h-4 mr-1" />
                        Flag for Review
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
