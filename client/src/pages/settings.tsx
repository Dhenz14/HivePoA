import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ShieldAlert, Save, AlertTriangle, Loader2, Settings2, Network, HardDrive } from "lucide-react";
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { Slider } from "@/components/ui/slider";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getApiBase } from "@/lib/api-mode";

interface AgentConfig {
  hiveUsername?: string;
  autoStart?: boolean;
  bandwidthLimitUp?: number;
  bandwidthLimitDown?: number;
  storageMaxGB?: number;
  serverUrl?: string;
  p2pMode?: boolean;
  validatorEnabled?: boolean;
  challengeIntervalMs?: number;
}

export default function ValidatorSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const apiBase = getApiBase();

  const { data: config, isLoading, error } = useQuery<AgentConfig>({
    queryKey: ["agent-config"],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/api/config`);
      if (!res.ok) throw new Error("Failed to load config");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const [hiveUsername, setHiveUsername] = useState("");
  const [bandwidthUp, setBandwidthUp] = useState([100]);
  const [bandwidthDown, setBandwidthDown] = useState([100]);
  const [storageMax, setStorageMax] = useState([50]);
  const [p2pMode, setP2pMode] = useState(false);
  const [validatorEnabled, setValidatorEnabled] = useState(false);
  const [autoStart, setAutoStart] = useState(false);

  // Sync form state when config loads
  useEffect(() => {
    if (config) {
      setHiveUsername(config.hiveUsername || "");
      setBandwidthUp([config.bandwidthLimitUp || 100]);
      setBandwidthDown([config.bandwidthLimitDown || 100]);
      setStorageMax([config.storageMaxGB || 50]);
      setP2pMode(config.p2pMode ?? false);
      setValidatorEnabled(config.validatorEnabled ?? false);
      setAutoStart(config.autoStart ?? false);
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async (updates: Partial<AgentConfig>) => {
      const res = await fetch(`${apiBase}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save config");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Settings Saved", description: "Configuration updated successfully." });
      queryClient.invalidateQueries({ queryKey: ["agent-config"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = () => {
    saveMutation.mutate({
      hiveUsername: hiveUsername.trim() || undefined,
      bandwidthLimitUp: bandwidthUp[0],
      bandwidthLimitDown: bandwidthDown[0],
      storageMaxGB: storageMax[0],
      p2pMode,
      validatorEnabled,
      autoStart,
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 space-y-8 max-w-4xl mx-auto">
        <div>
          <h1 className="text-3xl font-display font-bold">Validator Configuration</h1>
          <p className="text-muted-foreground mt-1">Configure your node settings</p>
        </div>
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="p-6 flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <div>
              <p className="font-medium">Cannot load settings</p>
              <p className="text-sm text-muted-foreground">Desktop agent must be running to configure settings.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-display font-bold">Validator Configuration</h1>
        <p className="text-muted-foreground mt-1">Configure your node's network and validation settings</p>
      </div>

      <div className="grid gap-6">
        {/* Identity */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="p-2 bg-primary/10 rounded-lg text-primary">
                <Settings2 className="w-5 h-5" />
              </div>
              <div>
                <CardTitle>Identity</CardTitle>
                <CardDescription>Your Hive account and startup behavior</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="hiveUsername">Hive Username</Label>
              <Input id="hiveUsername" placeholder="e.g. myaccount" className="font-mono" value={hiveUsername} onChange={(e) => setHiveUsername(e.target.value)} />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base">Auto-Start on Launch</Label>
                <p className="text-xs text-muted-foreground">Automatically start IPFS and validation when the app opens</p>
              </div>
              <Switch checked={autoStart} onCheckedChange={setAutoStart} />
            </div>
          </CardContent>
        </Card>

        {/* Network */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="p-2 bg-blue-500/10 rounded-lg text-blue-500">
                <Network className="w-5 h-5" />
              </div>
              <div>
                <CardTitle>Network</CardTitle>
                <CardDescription>Bandwidth limits and P2P mode</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <Label>Upload Bandwidth (KB/s)</Label>
                <span className="font-mono font-bold text-primary">{bandwidthUp[0]}</span>
              </div>
              <Slider value={bandwidthUp} onValueChange={setBandwidthUp} max={10000} step={10} className="py-2" />
            </div>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <Label>Download Bandwidth (KB/s)</Label>
                <span className="font-mono font-bold text-primary">{bandwidthDown[0]}</span>
              </div>
              <Slider value={bandwidthDown} onValueChange={setBandwidthDown} max={10000} step={10} className="py-2" />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base">P2P Mode</Label>
                <p className="text-xs text-muted-foreground">Connect directly to peers via IPFS PubSub instead of central server</p>
              </div>
              <Switch checked={p2pMode} onCheckedChange={setP2pMode} />
            </div>
          </CardContent>
        </Card>

        {/* Storage */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="p-2 bg-purple-500/10 rounded-lg text-purple-500">
                <HardDrive className="w-5 h-5" />
              </div>
              <div>
                <CardTitle>Storage</CardTitle>
                <CardDescription>IPFS storage quota</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center">
              <Label>Max Storage (GB)</Label>
              <span className="font-mono font-bold text-primary">{storageMax[0]}</span>
            </div>
            <Slider value={storageMax} onValueChange={setStorageMax} max={1000} step={1} className="py-2" />
            <p className="text-xs text-muted-foreground">
              Limits the IPFS datastore size. Content is evicted LRU when the limit is reached.
            </p>
          </CardContent>
        </Card>

        {/* Validation */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-2">
              <div className="p-2 bg-green-500/10 rounded-lg text-green-500">
                <ShieldAlert className="w-5 h-5" />
              </div>
              <div>
                <CardTitle>Validation</CardTitle>
                <CardDescription>PoA challenge settings</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div>
                <Label className="text-base">Enable Validator</Label>
                <p className="text-xs text-muted-foreground">Run PoA challenges against storage nodes and earn rewards</p>
              </div>
              <Switch checked={validatorEnabled} onCheckedChange={setValidatorEnabled} />
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-4">
          <Button variant="outline" onClick={() => queryClient.invalidateQueries({ queryKey: ["agent-config"] })}>
            Discard Changes
          </Button>
          <Button onClick={handleSave} disabled={saveMutation.isPending} className="bg-primary hover:bg-primary/90">
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save Configuration
          </Button>
        </div>
      </div>
    </div>
  );
}
