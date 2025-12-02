import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Terminal, Play, Pause, RefreshCw, Shield } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useState, useEffect, useRef } from "react";

export default function NodeStatus() {
  const [isRunning, setIsRunning] = useState(true);
  const [logs, setLogs] = useState<string[]>([
    "[INFO] Trole Gateway initialized v0.1.0",
    "[INFO] Hive connection established (wss://api.hive.blog)",
    "[INFO] Loading local data stores...",
    "[INFO] IPFS Daemon connected on port 5001",
    "[INFO] PoA Validator module loaded",
    "[INFO] Listening for proofs on channel: hive-poa-v1",
  ]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isRunning) return;
    
    const interval = setInterval(() => {
      const newLog = generateMockLog();
      setLogs(prev => [...prev.slice(-50), newLog]);
    }, 2000);

    return () => clearInterval(interval);
  }, [isRunning]);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      const scrollArea = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollArea) {
        scrollArea.scrollTop = scrollArea.scrollHeight;
      }
    }
  }, [logs]);

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto h-[calc(100vh-64px)] flex flex-col">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold">Node Status</h1>
          <p className="text-muted-foreground mt-1">Technical monitoring and configuration</p>
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
              <SettingsIcon />
              Configuration
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between space-x-2">
              <div className="space-y-0.5">
                <Label htmlFor="validator-mode">Validator Mode</Label>
                <p className="text-xs text-muted-foreground">Run proofs for the network</p>
              </div>
              <Switch id="validator-mode" defaultChecked />
            </div>
            <div className="flex items-center justify-between space-x-2">
              <div className="space-y-0.5">
                <Label htmlFor="hive-rewards">Auto-Claim HBD</Label>
                <p className="text-xs text-muted-foreground">Claim rewards automatically</p>
              </div>
              <Switch id="hive-rewards" defaultChecked />
            </div>
            <div className="flex items-center justify-between space-x-2">
              <div className="space-y-0.5">
                <Label htmlFor="ipfs-pinning">Aggressive Pinning</Label>
                <p className="text-xs text-muted-foreground">Cache content proactively</p>
              </div>
              <Switch id="ipfs-pinning" />
            </div>
            
            <div className="pt-4 border-t border-border/50">
              <p className="text-sm font-medium mb-2">Node Info</p>
              <div className="space-y-2 text-xs font-mono text-muted-foreground">
                <div className="flex justify-between">
                  <span>Peer ID:</span>
                  <span className="text-primary">12D3...8kL</span>
                </div>
                <div className="flex justify-between">
                  <span>Uptime:</span>
                  <span>4d 12h 30m</span>
                </div>
                <div className="flex justify-between">
                  <span>Version:</span>
                  <span>v0.1.0-alpha</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Terminal/Logs */}
        <Card className="lg:col-span-2 border-border/50 bg-black/80 backdrop-blur-md font-mono text-sm border-primary/20 shadow-inner flex flex-col min-h-0">
          <CardHeader className="py-3 px-4 border-b border-white/10 flex flex-row items-center justify-between bg-white/5">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              <span className="text-primary/80 font-bold">System Output</span>
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
      </div>
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-4 h-4"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

function generateMockLog() {
  const types = ["[INFO]", "[INFO]", "[INFO]", "[SUCCESS]", "[WARN]"];
  const msgs = [
    "Validating chunk QmX7...9jK",
    "Peer 12D3...8kL requested block data",
    "HBD Payment detected on chain",
    "Proof of Access verified for user @hive.user",
    "Garbage collection started",
    "DHT routing table updated",
    "Connection latency: 45ms",
    "New block parsed: #84,120,102"
  ];
  const type = types[Math.floor(Math.random() * types.length)];
  const msg = msgs[Math.floor(Math.random() * msgs.length)];
  return `${type} ${msg}`;
}

import { cn } from "@/lib/utils";
