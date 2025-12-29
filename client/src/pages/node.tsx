import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Terminal, Play, Pause, RefreshCw, Shield, Globe, Gavel, UserX, Activity } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { api, connectWebSocket } from "@/lib/api";

export default function NodeStatus() {
  const [isRunning, setIsRunning] = useState(true);
  const [witnessRank, setWitnessRank] = useState<number | null>(42);
  const [activeTab, setActiveTab] = useState("logs");
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

  const activePeers = nodes.filter(n => n.status === "active").map(n => ({
    id: n.peerId,
    reputation: n.reputation,
    status: n.reputation > 60 ? "Healthy" : "Probation",
    lastCheck: new Date(n.lastSeen).toLocaleTimeString(),
  }));

  const bannedNodes = nodes.filter(n => n.status === "banned").map(n => ({
    id: n.peerId,
    reason: "Failed PoA challenges",
    time: new Date(n.lastSeen).toLocaleTimeString(),
    ip: "N/A",
  }));

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

        switch (event.type) {
          case "hbd_transfer":
            logMessage = `[SUCCESS] HBD Payment: ${JSON.parse(event.payload).amount} to @${event.toUser}`;
            break;
          case "spk_reputation_slash":
            logMessage = `[WARN] Reputation Slash: @${event.toUser} (${JSON.parse(event.payload).reason})`;
            break;
          case "spk_video_upload":
            logMessage = `[INFO] New Upload: ${JSON.parse(event.payload).name}`;
            break;
          case "hivepoa_announce":
            logMessage = `[INFO] Node Announce: ${JSON.parse(event.payload).peerId}`;
            break;
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
                          <TableHead>Peer ID</TableHead>
                          <TableHead>Reputation</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Last Check</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {activePeers.map((peer, i) => (
                          <TableRow key={i}>
                            <TableCell className="font-mono text-xs">{peer.id}</TableCell>
                            <TableCell>
                               <div className="w-24 h-1.5 bg-secondary rounded-full overflow-hidden">
                                  <div 
                                    className={cn("h-full rounded-full", peer.reputation > 80 ? "bg-green-500" : "bg-yellow-500")} 
                                    style={{ width: `${peer.reputation}%` }}
                                  />
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
                            <TableCell className="text-right text-xs text-muted-foreground">{peer.lastCheck}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                {/* Ban List */}
                <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <UserX className="w-4 h-4 text-red-500" />
                      Banned Nodes (Slash List)
                    </CardTitle>
                    <CardDescription>Nodes rejected due to failed PoA challenges</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <TableHead>Peer ID</TableHead>
                          <TableHead>Reason</TableHead>
                          <TableHead>IP Address</TableHead>
                          <TableHead className="text-right">Time</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {bannedNodes.map((node, i) => (
                          <TableRow key={i} className="bg-red-500/5 hover:bg-red-500/10 transition-colors">
                            <TableCell className="font-mono text-xs text-red-400">{node.id}</TableCell>
                            <TableCell className="text-xs">{node.reason}</TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">{node.ip}</TableCell>
                            <TableCell className="text-right text-xs text-muted-foreground">{node.time}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

function generateMockLog() {
  const types = ["[INFO]", "[INFO]", "[INFO]", "[SUCCESS]", "[WARN]"];
  const msgs = [
    "Validating chunk QmX7...9jK",
    "Peer 12D3...8kL requested block data",
    "HBD Payment broadcasted: 0.500 HBD to @storage-node",
    "Witness Rank Verified (Block #85,001,202)",
    "Garbage collection started",
    "DHT routing table updated",
    "Connection latency: 45ms",
    "New block parsed: #84,120,102"
  ];
  const type = types[Math.floor(Math.random() * types.length)];
  const msg = msgs[Math.floor(Math.random() * msgs.length)];
  return `${type} ${msg}`;
}
