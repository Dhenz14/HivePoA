import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { 
  Server, 
  Wifi, 
  WifiOff, 
  Globe, 
  HardDrive, 
  Loader2,
  RefreshCw,
  ExternalLink,
  Copy,
  Laptop
} from "lucide-react";
import { useNodeConfig } from "@/contexts/NodeConfigContext";
import { formatBytes, type ConnectionMode } from "@/lib/node-config";

export default function Connect() {
  const { toast } = useToast();
  const { 
    config, 
    setMode, 
    updateConfig, 
    testConnection, 
    ipfsStats, 
    isTesting,
    refreshStats 
  } = useNodeConfig();

  const handleModeChange = (mode: ConnectionMode) => {
    setMode(mode);
  };

  const handleInputChange = (field: "ipfsApiUrl" | "ipfsGatewayUrl" | "hiveUsername", value: string) => {
    updateConfig({ [field]: value });
  };

  const handleTestConnection = async () => {
    const result = await testConnection();
    
    if (result.success) {
      toast({
        title: "Connected!",
        description: `Successfully connected to IPFS node`,
      });
    } else {
      toast({
        title: "Connection Failed",
        description: result.error || "Could not connect to IPFS node",
        variant: "destructive",
      });
    }
  };

  const handleCopyPeerId = () => {
    if (config.peerId) {
      navigator.clipboard.writeText(config.peerId);
      toast({ title: "Copied!", description: "Peer ID copied to clipboard" });
    }
  };

  return (
    <div className="p-8 space-y-8 max-w-4xl mx-auto">
      <div>
        <h1 className="text-3xl font-display font-bold flex items-center gap-3" data-testid="connect-title">
          <Server className="h-8 w-8 text-primary" />
          Node Connection
        </h1>
        <p className="text-muted-foreground mt-1">
          Connect to your IPFS node to store content and earn rewards
        </p>
      </div>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Connection Status</CardTitle>
              <CardDescription>Your IPFS node connection</CardDescription>
            </div>
            {config.isConnected ? (
              <Badge variant="default" className="bg-green-500 text-white" data-testid="status-connected">
                <Wifi className="w-3 h-3 mr-1" />
                Connected
              </Badge>
            ) : (
              <Badge variant="secondary" data-testid="status-disconnected">
                <WifiOff className="w-3 h-3 mr-1" />
                Disconnected
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {config.isConnected && config.peerId && (
            <div className="space-y-4">
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="text-xs text-muted-foreground">Peer ID</p>
                  <p className="font-mono text-sm truncate max-w-md">{config.peerId}</p>
                </div>
                <Button variant="ghost" size="icon" onClick={handleCopyPeerId}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              
              {ipfsStats && (
                <div className="grid grid-cols-3 gap-4">
                  <div className="p-3 bg-muted/50 rounded-lg text-center">
                    <p className="text-2xl font-bold">{formatBytes(ipfsStats.repoSize)}</p>
                    <p className="text-xs text-muted-foreground">Storage Used</p>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-lg text-center">
                    <p className="text-2xl font-bold">{ipfsStats.numObjects.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">Objects</p>
                  </div>
                  <div className="p-3 bg-muted/50 rounded-lg text-center">
                    <p className="text-2xl font-bold">{ipfsStats.addresses.length}</p>
                    <p className="text-xs text-muted-foreground">Addresses</p>
                  </div>
                </div>
              )}
              
              {config.isConnected && config.mode !== "demo" && (
                <Button variant="outline" size="sm" onClick={refreshStats} className="w-full">
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Refresh Stats
                </Button>
              )}
            </div>
          )}
          
          {!config.isConnected && config.mode !== "demo" && (
            <div className="text-center py-8 text-muted-foreground">
              <WifiOff className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>Not connected to an IPFS node</p>
              <p className="text-sm">Configure your node below and test the connection</p>
            </div>
          )}
          
          {config.mode === "demo" && (
            <div className="text-center py-8 text-muted-foreground">
              <Globe className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>Running in Demo Mode</p>
              <p className="text-sm">Using simulated data for demonstration purposes</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle>Connection Mode</CardTitle>
          <CardDescription>Choose how to connect to IPFS</CardDescription>
        </CardHeader>
        <CardContent>
          <RadioGroup
            value={config.mode}
            onValueChange={(v) => handleModeChange(v as ConnectionMode)}
            className="space-y-4"
          >
            <div className="flex items-start space-x-3 p-4 border rounded-lg hover:border-primary/50 transition-colors">
              <RadioGroupItem value="local" id="local" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="local" className="flex items-center gap-2 cursor-pointer">
                  <Laptop className="h-4 w-4" />
                  Local Node
                </Label>
                <p className="text-sm text-muted-foreground mt-1">
                  Connect to IPFS running on your local machine (localhost:5001)
                </p>
              </div>
            </div>
            
            <div className="flex items-start space-x-3 p-4 border rounded-lg hover:border-primary/50 transition-colors">
              <RadioGroupItem value="remote" id="remote" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="remote" className="flex items-center gap-2 cursor-pointer">
                  <HardDrive className="h-4 w-4" />
                  Remote Node
                </Label>
                <p className="text-sm text-muted-foreground mt-1">
                  Connect to IPFS on your home server, VPS, or Raspberry Pi
                </p>
              </div>
            </div>
            
            <div className="flex items-start space-x-3 p-4 border rounded-lg hover:border-primary/50 transition-colors">
              <RadioGroupItem value="demo" id="demo" className="mt-1" />
              <div className="flex-1">
                <Label htmlFor="demo" className="flex items-center gap-2 cursor-pointer">
                  <Globe className="h-4 w-4" />
                  Demo Mode
                </Label>
                <p className="text-sm text-muted-foreground mt-1">
                  Use simulated data to explore the interface (no real IPFS)
                </p>
              </div>
            </div>
          </RadioGroup>
        </CardContent>
      </Card>

      {config.mode !== "demo" && (
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle>Node Settings</CardTitle>
            <CardDescription>Configure your IPFS node connection</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4">
              <div className="grid gap-2">
                <Label htmlFor="ipfs-api">IPFS API URL</Label>
                <Input
                  id="ipfs-api"
                  data-testid="input-ipfs-api"
                  placeholder="http://127.0.0.1:5001"
                  value={config.ipfsApiUrl}
                  onChange={(e) => handleInputChange("ipfsApiUrl", e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  The IPFS HTTP API endpoint (usually port 5001)
                </p>
              </div>
              
              <div className="grid gap-2">
                <Label htmlFor="ipfs-gateway">IPFS Gateway URL</Label>
                <Input
                  id="ipfs-gateway"
                  data-testid="input-ipfs-gateway"
                  placeholder="http://127.0.0.1:8080"
                  value={config.ipfsGatewayUrl}
                  onChange={(e) => handleInputChange("ipfsGatewayUrl", e.target.value)}
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  The IPFS gateway for viewing content (usually port 8080)
                </p>
              </div>
              
              <div className="grid gap-2">
                <Label htmlFor="hive-username">Hive Username (Optional)</Label>
                <Input
                  id="hive-username"
                  data-testid="input-hive-username"
                  placeholder="@yourusername"
                  value={config.hiveUsername}
                  onChange={(e) => handleInputChange("hiveUsername", e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Your Hive account for receiving HBD rewards
                </p>
              </div>
            </div>
            
            <div className="flex gap-3">
              <Button
                data-testid="button-test-connection"
                onClick={handleTestConnection}
                disabled={isTesting}
                className="flex-1"
              >
                {isTesting ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : config.isConnected ? (
                  <RefreshCw className="h-4 w-4 mr-2" />
                ) : (
                  <Wifi className="h-4 w-4 mr-2" />
                )}
                {isTesting ? "Testing..." : config.isConnected ? "Reconnect" : "Test Connection"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="bg-muted/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <HardDrive className="h-5 w-5" />
            Setting Up Your Own Node
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-3">
          <p>To run your own IPFS node and earn HBD rewards:</p>
          <ol className="list-decimal list-inside space-y-2 ml-2">
            <li><strong>Install Kubo</strong> - Download from <a href="https://dist.ipfs.tech/#kubo" target="_blank" rel="noopener" className="text-primary hover:underline">ipfs.tech <ExternalLink className="inline h-3 w-3" /></a></li>
            <li><strong>Initialize</strong> - Run <code className="bg-background px-1 rounded">ipfs init</code></li>
            <li><strong>Enable CORS</strong> - Required for web access</li>
            <li><strong>Start daemon</strong> - Run <code className="bg-background px-1 rounded">ipfs daemon</code></li>
            <li><strong>Connect</strong> - Enter your node's API URL above</li>
          </ol>
          <p className="pt-2">
            For remote access, you can run IPFS on a Raspberry Pi, home server, or VPS.
            Make sure to configure port forwarding and firewall rules appropriately.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
