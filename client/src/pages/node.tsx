import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Terminal, Play, Pause, RefreshCw, Shield, Globe, Gavel, UserX, Activity, Search, Ban, Check, AlertTriangle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, connectWebSocket, type StorageNode, type ValidatorBlacklist } from "@/lib/api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { toast } from "sonner";

const VALIDATOR_USERNAME = "validator-police";

export default function NodeStatus() {
  const queryClient = useQueryClient();
  const [isRunning, setIsRunning] = useState(true);
  const [witnessRank, setWitnessRank] = useState<number | null>(42);
  const [activeTab, setActiveTab] = useState("logs");
  const [searchQuery, setSearchQuery] = useState("");
  const [banDialogOpen, setBanDialogOpen] = useState(false);
  const [selectedNode, setSelectedNode] = useState<StorageNode | null>(null);
  const [banReason, setBanReason] = useState("");
  const [logs, setLogs] = useState<string[]>([
    "[INFO] Trole Gateway initialized v0.1.0",
    "[INFO] Hive connection established (wss://api.hive.blog)",
    "[INIT] Checking Hive Witness Status...",
  ]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Fetch storage nodes (active peers)
  const { data: nodes = [] } = useQuery({
    queryKey: ["nodes"],
    queryFn: api.getNodes,
    refetchInterval: 10000,
  });

  // Fetch validator blacklist
  const { data: blacklist = [] } = useQuery({
    queryKey: ["blacklist", VALIDATOR_USERNAME],
    queryFn: () => api.getBlacklist(VALIDATOR_USERNAME),
    refetchInterval: 10000,
  });

  // Search nodes
  const { data: searchResults = [], isLoading: isSearching } = useQuery({
    queryKey: ["nodes", "search", searchQuery],
    queryFn: () => api.searchNodes(searchQuery),
    enabled: searchQuery.length > 0,
  });

  // Ban mutation
  const banMutation = useMutation({
    mutationFn: ({ nodeId, reason }: { nodeId: string; reason: string }) =>
      api.addToBlacklist(VALIDATOR_USERNAME, nodeId, reason),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blacklist"] });
      queryClient.invalidateQueries({ queryKey: ["nodes"] });
      toast.success("Node has been blacklisted");
      setBanDialogOpen(false);
      setSelectedNode(null);
      setBanReason("");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to blacklist node");
    },
  });

  // Unban mutation
  const unbanMutation = useMutation({
    mutationFn: (nodeId: string) =>
      api.removeFromBlacklist(VALIDATOR_USERNAME, nodeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blacklist"] });
      queryClient.invalidateQueries({ queryKey: ["nodes"] });
      toast.success("Node has been removed from blacklist");
    },
    onError: () => {
      toast.error("Failed to remove node from blacklist");
    },
  });

  const blacklistedNodeIds = new Set(blacklist.map(b => b.nodeId));

  const activePeers = nodes.filter(n => n.status === "active" && !blacklistedNodeIds.has(n.id)).map(n => ({
    id: n.peerId,
    nodeId: n.id,
    hiveUsername: n.hiveUsername,
    reputation: n.reputation,
    status: n.reputation > 60 ? "Healthy" : "Probation",
    lastCheck: new Date(n.lastSeen).toLocaleTimeString(),
    isBlacklisted: false,
  }));

  const bannedNodes = blacklist.map(b => {
    const node = nodes.find(n => n.id === b.nodeId);
    return {
      id: node?.peerId || b.nodeId,
      nodeId: b.nodeId,
      hiveUsername: node?.hiveUsername || "Unknown",
      reason: b.reason,
      time: new Date(b.createdAt).toLocaleTimeString(),
    };
  });

  useEffect(() => {
    // Initial Witness Check Simulation
    setTimeout(() => {
      setLogs(prev => [...prev, `[AUTH] Witness Check: @your_user is Rank #${witnessRank} (Top 150)`]);
    }, 1000);
    setTimeout(() => {
      setLogs(prev => [...prev, `[SUCCESS] Validator Mode ENABLED based on Witness Rank`]);
    }, 2000);
  }, []);

  // WebSocket for live event logs
  useEffect(() => {
    if (!isRunning) return;

    const ws = connectWebSocket((data) => {
      if (data.type === "hive_event") {
        const event = data.data;
        let logMessage = "";

        try {
          const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
          
          switch (event.type) {
            case "hbd_transfer":
              logMessage = `[SUCCESS] HBD Payment: ${payload.amount} to @${event.toUser}`;
              break;
            case "spk_reputation_slash":
              logMessage = `[WARN] Reputation Slash: @${event.toUser} (${payload.reason})`;
              break;
            case "spk_video_upload":
              logMessage = `[INFO] New Upload: ${payload.name}`;
              break;
            case "hivepoa_announce":
              logMessage = `[INFO] Node Announce: ${payload.peerId}`;
              break;
          }
        } catch (e) {
          logMessage = `[INFO] Event: ${event.type}`;
        }

        if (logMessage) {
          setLogs(prev => [...prev.slice(-50), logMessage]);
        }
      }
    });

    return () => ws.close();
  }, [isRunning]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      const scrollArea = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollArea) {
        scrollArea.scrollTop = scrollArea.scrollHeight;
      }
    }
  }, [logs, activeTab]);

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto h-[calc(100vh-64px)] flex flex-col">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold">Node Status</h1>
          <p className="text-muted-foreground mt-1">Witness-Verified Validator Node</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setLogs([])}>
            <RefreshCw className="w-4 h-4 mr-2" /> Clear Logs
          </Button>
          <Button 
            variant={isRunning ? "destructive" : "default"} 
            onClick={() => setIsRunning(!isRunning)}
          >
            {isRunning ? <Pause className="w-4 h-4 mr-2" /> : <Play className="w-4 h-4 mr-2" />}
            {isRunning ? "Stop Node" : "Start Node"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
        {/* Configuration Panel */}
        <Card className="lg:col-span-1 border-border/50 bg-card/50 backdrop-blur-sm h-fit">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="w-5 h-5 text-primary" />
              Witness Verification
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="p-4 bg-primary/10 rounded-lg border border-primary/20">
               <div className="text-sm text-muted-foreground mb-1">Current Rank</div>
               <div className="text-2xl font-bold font-display text-primary flex items-center gap-2">
                 #{witnessRank}
                 <span className="text-xs bg-green-500/20 text-green-500 px-2 py-0.5 rounded-full border border-green-500/30">Top 150</span>
               </div>
               <div className="mt-2 text-xs text-muted-foreground">
                 Status: <span className="text-green-500 font-bold">ELIGIBLE VALIDATOR</span>
               </div>
            </div>

            <div className="pt-4 border-t border-border/50 space-y-4">
               <div className="flex items-center justify-between space-x-2">
                <div className="space-y-0.5">
                  <Label htmlFor="validator-mode">Police Mode (PoA Auditor)</Label>
                  <p className="text-xs text-muted-foreground">Run cryptographic challenges to audit storage nodes</p>
                </div>
                <Switch id="validator-mode" checked={true} disabled />
              </div>
              <div className="flex items-center justify-between space-x-2">
                <div className="space-y-0.5">
                  <Label htmlFor="hive-rewards">Auto-Payout</Label>
                  <p className="text-xs text-muted-foreground">Pay storage nodes automatically</p>
                </div>
                <Switch id="hive-rewards" defaultChecked />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Main Interface Tabs */}
        <div className="lg:col-span-2 flex flex-col h-full min-h-0">
          <Tabs defaultValue="logs" className="flex-1 flex flex-col h-full" onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-2 mb-4">
              <TabsTrigger value="logs" className="flex items-center gap-2">
                <Terminal className="w-4 h-4" /> System Logs
              </TabsTrigger>
              <TabsTrigger value="management" className="flex items-center gap-2">
                <Gavel className="w-4 h-4" /> Validator Management
              </TabsTrigger>
            </TabsList>

            {/* LOGS TAB */}
            <TabsContent value="logs" className="flex-1 min-h-0 mt-0">
              <Card className="border-border/50 bg-black/80 backdrop-blur-md font-mono text-sm border-primary/20 shadow-inner flex flex-col h-full">
                <CardHeader className="py-3 px-4 border-b border-white/10 flex flex-row items-center justify-between bg-white/5">
                  <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-primary" />
                    <span className="text-primary/80 font-bold">Output Stream</span>
                  </div>
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/50" />
                  </div>
                </CardHeader>
                <div className="flex-1 relative min-h-0" ref={scrollRef}>
                  <ScrollArea className="h-full p-4">
                    <div className="space-y-1">
                      {logs.map((log, i) => (
                        <div key={i} className="break-all">
                          <span className="text-muted-foreground mr-2">
                            {new Date().toLocaleTimeString()}
                          </span>
                          <span className={cn(
                            log.includes("[ERROR]") ? "text-red-400" :
                            log.includes("[WARN]") ? "text-yellow-400" :
                            log.includes("[SUCCESS]") ? "text-green-400" :
                            log.includes("[AUTH]") ? "text-purple-400 font-bold" :
                            "text-blue-200"
                          )}>
                            {log}
                          </span>
                        </div>
                      ))}
                      {!isRunning && (
                        <div className="text-yellow-500 mt-2 opacity-50">Node execution paused.</div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </Card>
            </TabsContent>

            {/* MANAGEMENT TAB */}
            <TabsContent value="management" className="flex-1 min-h-0 mt-0 overflow-y-auto">
              <div className="grid gap-6">
                
                {/* Search and Ban Nodes */}
                <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Search className="w-4 h-4 text-primary" />
                      Search Storage Nodes
                    </CardTitle>
                    <CardDescription>Find storage nodes by username or peer ID to ban/blacklist them</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input
                        placeholder="Search by @username or Peer ID..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10"
                        data-testid="input-search-nodes"
                      />
                    </div>
                    {searchQuery.length > 0 && (
                      <div className="border rounded-lg overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow className="hover:bg-transparent">
                              <TableHead>Username</TableHead>
                              <TableHead>Peer ID</TableHead>
                              <TableHead>Reputation</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {isSearching ? (
                              <TableRow>
                                <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">
                                  Searching...
                                </TableCell>
                              </TableRow>
                            ) : searchResults.length === 0 ? (
                              <TableRow>
                                <TableCell colSpan={5} className="text-center py-4 text-muted-foreground">
                                  No nodes found
                                </TableCell>
                              </TableRow>
                            ) : (
                              searchResults.map((node) => {
                                const isBlacklisted = blacklistedNodeIds.has(node.id);
                                return (
                                  <TableRow key={node.id} className={isBlacklisted ? "bg-red-500/5" : ""}>
                                    <TableCell className="font-medium">@{node.hiveUsername}</TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">{node.peerId.slice(0, 16)}...</TableCell>
                                    <TableCell>
                                      <div className="flex items-center gap-2">
                                        <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                                          <div 
                                            className={cn("h-full rounded-full", node.reputation > 60 ? "bg-green-500" : node.reputation > 30 ? "bg-yellow-500" : "bg-red-500")} 
                                            style={{ width: `${node.reputation}%` }}
                                          />
                                        </div>
                                        <span className="text-xs">{node.reputation}</span>
                                      </div>
                                    </TableCell>
                                    <TableCell>
                                      {isBlacklisted ? (
                                        <Badge variant="destructive" className="text-[10px]">Blacklisted</Badge>
                                      ) : (
                                        <Badge variant="outline" className={cn(
                                          "text-[10px]",
                                          node.status === "active" ? "text-green-500 border-green-500/20" : "text-yellow-500 border-yellow-500/20"
                                        )}>
                                          {node.status}
                                        </Badge>
                                      )}
                                    </TableCell>
                                    <TableCell className="text-right">
                                      {isBlacklisted ? (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          onClick={() => unbanMutation.mutate(node.id)}
                                          disabled={unbanMutation.isPending}
                                          data-testid={`button-unban-search-${node.id}`}
                                        >
                                          <Check className="w-3 h-3 mr-1" />
                                          Unban
                                        </Button>
                                      ) : (
                                        <Button
                                          variant="destructive"
                                          size="sm"
                                          onClick={() => {
                                            setSelectedNode(node);
                                            setBanDialogOpen(true);
                                          }}
                                          data-testid={`button-ban-${node.id}`}
                                        >
                                          <Ban className="w-3 h-3 mr-1" />
                                          Ban
                                        </Button>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                );
                              })
                            )}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CardContent>
                </Card>
                
                {/* Active Audits */}
                <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <Activity className="w-4 h-4 text-green-500" />
                      Audited Peers
                    </CardTitle>
                    <CardDescription>Nodes currently connected and earning HBD from you</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Username</TableHead>
                          <TableHead>Reputation</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead>Last Check</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {activePeers.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                              No active peers
                            </TableCell>
                          </TableRow>
                        ) : (
                          activePeers.map((peer, i) => (
                            <TableRow key={i}>
                              <TableCell className="font-medium">@{peer.hiveUsername}</TableCell>
                              <TableCell>
                                 <div className="flex items-center gap-2">
                                   <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                                      <div 
                                        className={cn("h-full rounded-full", peer.reputation > 80 ? "bg-green-500" : "bg-yellow-500")} 
                                        style={{ width: `${peer.reputation}%` }}
                                      />
                                   </div>
                                   <span className="text-xs">{peer.reputation}</span>
                                 </div>
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline" className={cn(
                                  "text-[10px] h-5",
                                  peer.status === "Healthy" ? "text-green-500 border-green-500/20" : "text-yellow-500 border-yellow-500/20"
                                )}>
                                  {peer.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">{peer.lastCheck}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
                                  onClick={() => {
                                    const node = nodes.find(n => n.id === peer.nodeId);
                                    if (node) {
                                      setSelectedNode(node);
                                      setBanDialogOpen(true);
                                    }
                                  }}
                                  data-testid={`button-ban-peer-${peer.nodeId}`}
                                >
                                  <Ban className="w-3 h-3" />
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                {/* Ban List */}
                <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <UserX className="w-4 h-4 text-red-500" />
                      Blacklisted Nodes
                    </CardTitle>
                    <CardDescription>Nodes you have blacklisted - they will not receive PoA challenges or HBD payments from you</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Username</TableHead>
                          <TableHead>Reason</TableHead>
                          <TableHead>Blacklisted</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {bannedNodes.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                              No blacklisted nodes
                            </TableCell>
                          </TableRow>
                        ) : (
                          bannedNodes.map((node, i) => (
                            <TableRow key={i} className="bg-red-500/5 hover:bg-red-500/10 transition-colors">
                              <TableCell className="font-mono text-xs text-red-400">@{node.hiveUsername}</TableCell>
                              <TableCell className="text-xs">{node.reason}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{node.time}</TableCell>
                              <TableCell className="text-right">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => unbanMutation.mutate(node.nodeId)}
                                  disabled={unbanMutation.isPending}
                                  data-testid={`button-unban-${node.nodeId}`}
                                >
                                  <Check className="w-3 h-3 mr-1" />
                                  Unban
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>

      {/* Ban Dialog */}
      <Dialog open={banDialogOpen} onOpenChange={setBanDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-500" />
              Blacklist Storage Node
            </DialogTitle>
            <DialogDescription>
              This will prevent the node from receiving PoA challenges and HBD payments from you.
            </DialogDescription>
          </DialogHeader>
          {selectedNode && (
            <div className="space-y-4">
              <div className="p-4 bg-muted rounded-lg space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Username:</span>
                  <span className="font-mono text-sm">@{selectedNode.hiveUsername}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Reputation:</span>
                  <span className="text-sm">{selectedNode.reputation}/100</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Status:</span>
                  <Badge variant="outline" className="text-[10px]">{selectedNode.status}</Badge>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ban-reason">Reason for banning</Label>
                <Input
                  id="ban-reason"
                  placeholder="e.g., Consistently failing PoA challenges"
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  data-testid="input-ban-reason"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setBanDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              variant="destructive" 
              onClick={() => {
                if (selectedNode && banReason.trim()) {
                  banMutation.mutate({ nodeId: selectedNode.id, reason: banReason });
                }
              }}
              disabled={!banReason.trim() || banMutation.isPending}
              data-testid="button-confirm-ban"
            >
              <Ban className="w-4 h-4 mr-2" />
              {banMutation.isPending ? "Banning..." : "Confirm Ban"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

