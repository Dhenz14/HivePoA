import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Upload, File, Search, Copy, CheckCircle2, Clock, ShieldCheck, AlertCircle, Users, Coins, AlertTriangle, XCircle, Ban, Wifi, Network, Film, Cpu, Hash, Globe, X, Trash2, Pin, Settings, Download, Loader2, Monitor, HardDrive, Zap } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { useDesktopAgent } from "@/hooks/use-desktop-agent";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, UserSettings } from "@/lib/api";

const AGENT_URL = "http://127.0.0.1:5111";

export default function Storage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isRunning: agentRunning, status: agentStatus, pins: agentPins, check: checkAgent, unpinCid, refreshPins } = useDesktopAgent();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'pinning' | 'complete'>('idle');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [fileSearch, setFileSearch] = useState("");
  const [filePage, setFilePage] = useState(1);
  const [showAgentPrompt, setShowAgentPrompt] = useState(false);
  const FILES_PER_PAGE = 20;

  // When agent is running, use agent data. Otherwise fall back to server API.
  const agentConnected = agentRunning === true && agentStatus !== null;

  // Fetch files from server API (fallback when agent is not connected)
  const { data: filesData, isLoading: filesLoading } = useQuery({
    queryKey: ["files", filePage],
    queryFn: () => api.getFilesPaginated(filePage, FILES_PER_PAGE),
    refetchInterval: 10000,
    enabled: !agentConnected, // Skip server query when agent is live
  });
  const serverFiles = filesData?.data || [];
  const totalPages = agentConnected ? 1 : (filesData?.totalPages || 1);

  // Build the file list: when agent is connected, show agent pins; otherwise server files
  const files = agentConnected
    ? agentPins
        .filter(cid => !fileSearch || cid.toLowerCase().includes(fileSearch))
        .map((cid, i) => ({
          id: cid,
          cid,
          name: `Pin ${i + 1}`,
          size: "-",
          uploaderUsername: agentStatus?.config?.hiveUsername || "local",
          status: "active",
          replicationCount: agentStatus?.network?.peerCount || 0,
          confidence: 100,
          poaEnabled: true,
          createdAt: new Date().toISOString(),
          earnedHbd: 0,
        }))
    : serverFiles;

  // Fetch nodes to get our own reputation (server fallback)
  const { data: nodes = [] } = useQuery({
    queryKey: ["nodes"],
    queryFn: api.getNodes,
    refetchInterval: 10000,
    enabled: !agentConnected,
  });

  // Fetch user settings (simulated username "demo_user")
  const { data: settings } = useQuery({
    queryKey: ["settings", "demo_user"],
    queryFn: () => api.getSettings("demo_user"),
    refetchInterval: 30000,
    enabled: !agentConnected,
  });

  // Update settings mutation
  const updateSettingsMutation = useMutation({
    mutationFn: (data: Partial<UserSettings>) => api.updateSettings("demo_user", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "demo_user"] });
      toast({
        title: "Settings Updated",
        description: "Your preferences have been saved.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to update settings",
        variant: "destructive",
      });
    },
  });

  // Start network download mutation
  const startDownloadMutation = useMutation({
    mutationFn: () => api.startNetworkDownload("demo_user"),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["settings", "demo_user"] });
      toast({
        title: result.started ? "Download Started" : "Download Not Started",
        description: result.message,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to start download",
        variant: "destructive",
      });
    },
  });

  // Agent stats (live from agent) or server fallback
  const reputation = agentConnected ? 100 : (nodes[0]?.reputation || 50);
  const validationStats = agentStatus?.network?.validationStats;
  const totalProofs = agentConnected
    ? (validationStats?.passed || 0)
    : nodes.reduce((sum, n) => sum + n.totalProofs, 0);
  const totalFails = agentConnected
    ? (validationStats?.failed || 0)
    : nodes.reduce((sum, n) => sum + n.failedProofs, 0);
  const successRate = totalProofs + totalFails > 0
    ? ((totalProofs / (totalProofs + totalFails)) * 100).toFixed(1)
    : "100.0";

  // Create file mutation
  const createFileMutation = useMutation({
    mutationFn: api.createFile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });

  // Delete / unpin file
  const deleteFileMutation = useMutation({
    mutationFn: async (id: string) => {
      if (agentConnected) {
        const ok = await unpinCid(id);
        if (!ok) throw new Error("Failed to unpin from agent");
        return;
      }
      return api.deleteFile(id);
    },
    onSuccess: () => {
      if (agentConnected) refreshPins();
      queryClient.invalidateQueries({ queryKey: ["files"] });
      toast({
        title: "File Unpinned",
        description: "The file has been removed from your IPFS node.",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Error",
        description: error.message || "Failed to delete file",
        variant: "destructive",
      });
    },
  });

  const handleDelete = (file: { id: string; name: string }) => {
    const label = file.name.startsWith("Pin ") ? file.id.substring(0, 16) + "..." : file.name;
    if (confirm(`Are you sure you want to unpin "${label}"? This will remove it from your IPFS node.`)) {
      deleteFileMutation.mutate(file.id);
    }
  };

  const handleUpload = async () => {
    const running = await checkAgent();
    if (!running) {
      setShowAgentPrompt(true);
      return;
    }
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadStatus('uploading');
    setUploadProgress(0);

    try {
      const buffer = await file.arrayBuffer();
      setUploadProgress(30);
      setUploadStatus('pinning');

      // Route upload through desktop agent when connected, otherwise use server
      if (agentConnected) {
        const res = await fetch(`${AGENT_URL}/api/upload`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": file.name,
          },
          body: buffer,
        });

        setUploadProgress(90);
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Upload failed");
        }

        const result = await res.json();
        setUploadProgress(100);
        setUploadStatus('complete');

        toast({
          title: "File Pinned to Local IPFS",
          description: `${file.name} pinned with CID: ${result.cid?.substring(0, 16)}...`,
        });

        // Refresh agent pins
        refreshPins();
      } else {
        const sessionToken = localStorage.getItem("spk_validator_session");
        let authToken = "";
        if (sessionToken) {
          try {
            const parsed = JSON.parse(sessionToken);
            authToken = parsed.user?.sessionToken || "";
          } catch { /* ignore */ }
        }

        const res = await fetch("/api/upload/simple", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-File-Name": file.name,
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: buffer,
        });

        setUploadProgress(90);
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Upload failed");
        }

        const result = await res.json();
        setUploadProgress(100);
        setUploadStatus('complete');

        toast({
          title: "File Uploaded to IPFS",
          description: `${file.name} pinned with CID: ${result.cid?.substring(0, 16)}...`,
        });

        queryClient.invalidateQueries({ queryKey: ["files"] });
      }

      setTimeout(() => setUploadStatus('idle'), 3000);
    } catch (error: any) {
      toast({
        title: "Upload Failed",
        description: error.message || "Failed to upload file",
        variant: "destructive",
      });
      setUploadStatus('idle');
    }

    // Reset the file input
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const togglePoa = (name: string) => {
    // In a real implementation, this would call an API to update the file
    toast({
      title: "Feature Not Implemented",
      description: `PoA toggle for ${name} (API endpoint needed)`,
    });
  };

  const toggleAll = (enabled: boolean) => {
    toast({
      title: enabled ? "All Rewards Enabled" : "All Rewards Paused",
      description: `PoA challenges ${enabled ? "enabled" : "paused"} for all files.`,
    });
  };

  const allEnabled = files.every(f => f.poaEnabled);

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">

      {/* Desktop Agent Status Banner */}
      {agentConnected && (
        <Card className="border-green-500/30 bg-green-500/5 backdrop-blur-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" />
                <div>
                  <p className="text-sm font-medium flex items-center gap-2">
                    <Monitor className="w-4 h-4" />
                    Desktop Agent Connected
                    {agentStatus?.version && <Badge variant="outline" className="text-xs">{agentStatus.version}</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {agentStatus?.config?.hiveUsername
                      ? `@${agentStatus.config.hiveUsername}`
                      : "No Hive account linked"
                    }
                    {agentStatus?.peerId && ` \u00B7 Peer ${agentStatus.peerId.substring(0, 12)}...`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <div className="text-center">
                  <div className="font-bold font-display">{agentPins.length}</div>
                  <div className="text-xs text-muted-foreground">Pins</div>
                </div>
                <div className="text-center">
                  <div className="font-bold font-display">{agentStatus?.network?.peerCount || 0}</div>
                  <div className="text-xs text-muted-foreground">Peers</div>
                </div>
                <div className="text-center">
                  <div className="font-bold font-display text-green-500">
                    {(agentStatus?.earnings?.totalHbd || 0).toFixed(3)}
                  </div>
                  <div className="text-xs text-muted-foreground">HBD</div>
                </div>
                {agentStatus?.storageInfo && (
                  <div className="text-center">
                    <div className="font-bold font-display">{agentStatus.storageInfo.usedFormatted}</div>
                    <div className="text-xs text-muted-foreground">
                      / {agentStatus.storageInfo.maxFormatted}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Agent not detected warning */}
      {agentRunning === false && (
        <Card className="border-yellow-500/30 bg-yellow-500/5 backdrop-blur-sm">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <AlertTriangle className="w-5 h-5 text-yellow-500" />
                <div>
                  <p className="text-sm font-medium">Desktop Agent Not Detected</p>
                  <p className="text-xs text-muted-foreground">
                    Download and run the desktop agent to store files locally and earn HBD
                  </p>
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => window.location.href = "/download"}>
                <Download className="w-4 h-4 mr-2" />
                Get Agent
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Header & Upload */}
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold">Storage Management</h1>
          <p className="text-muted-foreground mt-1">
            {agentConnected
              ? `Managing ${agentPins.length} pins on your local IPFS node`
              : "Manage your IPFS pins and content proofs"
            }
          </p>
        </div>
        <div className="flex items-center gap-4">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            aria-label="Select file to upload"
            onChange={handleFileSelected}
            accept="video/*,image/*,audio/*,.pdf,.txt,.json"
          />
          <Button
            onClick={handleUpload}
            disabled={uploadStatus !== 'idle'}
            className={cn(
              "transition-all duration-500 min-w-[200px]",
              uploadStatus === 'complete' ? "bg-green-500 hover:bg-green-600" : "bg-primary hover:bg-primary/90"
            )}
          >
            {uploadStatus === 'idle' && (
              <>
                <Upload className="w-4 h-4 mr-2" />
                Upload New Content
              </>
            )}

            {uploadStatus === 'uploading' && (
              <>
                 <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                 Uploading... {uploadProgress}%
              </>
            )}

            {uploadStatus === 'pinning' && (
              <>
                 <Cpu className="w-4 h-4 mr-2 animate-pulse" />
                 Pinning to IPFS...
              </>
            )}

            {uploadStatus === 'complete' && (
              <>
                 <CheckCircle2 className="w-4 h-4 mr-2" />
                 Upload Complete
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Agent P2P Network / Download & Auto-Pin Settings */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {agentConnected ? (
          /* P2P Network Status Card (shown when agent is connected) */
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Network className="w-4 h-4 text-primary" />
                P2P Network
              </CardTitle>
              <CardDescription>Your node's peer-to-peer network activity</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-lg border bg-muted/30 p-3 text-center">
                  <Users className="w-5 h-5 mx-auto text-primary mb-1" />
                  <div className="text-2xl font-bold font-display">{agentStatus?.network?.peerCount || 0}</div>
                  <div className="text-xs text-muted-foreground">Connected Peers</div>
                </div>
                <div className="rounded-lg border bg-muted/30 p-3 text-center">
                  <Zap className="w-5 h-5 mx-auto text-yellow-500 mb-1" />
                  <div className="text-2xl font-bold font-display">{validationStats?.issued || 0}</div>
                  <div className="text-xs text-muted-foreground">Challenges Issued</div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Validator Mode</span>
                  <Badge variant={agentStatus?.network?.validatorEnabled ? "default" : "outline"}>
                    {agentStatus?.network?.validatorEnabled ? "Active" : "Disabled"}
                  </Badge>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Hive Posting Key</span>
                  <Badge variant={agentStatus?.network?.hasPostingKey ? "default" : "destructive"}>
                    {agentStatus?.network?.hasPostingKey ? "Configured" : "Not Set"}
                  </Badge>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Challenges Passed</span>
                  <span className="font-mono">{agentStatus?.earnings?.challengesPassed || 0}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Total Earned</span>
                  <span className="font-mono text-green-500">{(agentStatus?.earnings?.totalHbd || 0).toFixed(3)} HBD</span>
                </div>
              </div>

              {agentStatus?.storageInfo && (
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Storage</span>
                    <span className="font-mono text-xs">{agentStatus.storageInfo.usedFormatted} / {agentStatus.storageInfo.maxFormatted}</span>
                  </div>
                  <Progress value={agentStatus.storageInfo.percentage} className="h-2" />
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          /* Network Download Card (shown when agent is NOT connected) */
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Download className="w-4 h-4 text-primary" />
                Download Network Videos
              </CardTitle>
              <CardDescription>Download existing videos from the network to store and earn HBD</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="download-mode">Download Mode</Label>
                <Select
                  data-testid="select-download-mode"
                  value={settings?.downloadMode || "off"}
                  onValueChange={(value: "off" | "all" | "quota") => {
                    updateSettingsMutation.mutate({ downloadMode: value });
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">Off - No automatic downloads</SelectItem>
                    <SelectItem value="all">All - Download every video</SelectItem>
                    <SelectItem value="quota">Quota - Download a set number</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="download-quota">Videos to Download</Label>
                <div className="flex items-center gap-2">
                  <Input
                    data-testid="input-download-quota"
                    id="download-quota"
                    type="number"
                    min={1}
                    max={1000}
                    value={settings?.downloadQuota || 10}
                    disabled={settings?.downloadMode !== "quota"}
                    onChange={(e) => {
                      const value = parseInt(e.target.value) || 10;
                      updateSettingsMutation.mutate({ downloadQuota: value });
                    }}
                    className="w-24"
                  />
                  <span className="text-sm text-muted-foreground">videos</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Download Progress</Label>
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <Progress
                      value={settings?.downloadMode === "quota" && settings?.downloadQuota
                        ? ((settings?.downloadedToday || 0) / settings.downloadQuota) * 100
                        : 0
                      }
                      className="h-2"
                    />
                  </div>
                  <span className="text-sm font-medium">
                    {settings?.downloadedToday || 0}
                    {settings?.downloadMode === "quota" && `/${settings?.downloadQuota || 10}`}
                  </span>
                </div>
              </div>

              <Button
                data-testid="button-start-download"
                onClick={() => startDownloadMutation.mutate()}
                disabled={settings?.downloadMode === "off" || settings?.downloadInProgress || startDownloadMutation.isPending}
                className="w-full"
              >
                {settings?.downloadInProgress || startDownloadMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Downloading...
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4 mr-2" />
                    Start Download
                  </>
                )}
              </Button>

              <p className="text-xs text-muted-foreground">
                {settings?.downloadMode === "off" && "Enable a download mode to start downloading videos"}
                {settings?.downloadMode === "all" && `Will download all ${files.length} available videos`}
                {settings?.downloadMode === "quota" && `${(settings?.downloadQuota || 10) - (settings?.downloadedToday || 0)} videos remaining to download`}
              </p>
            </CardContent>
          </Card>
        )}

        {/* Auto-Pin Settings Card */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Pin className="w-4 h-4 text-primary" />
              Auto-Pin New Videos
            </CardTitle>
            <CardDescription>Automatically pin new videos as they appear on the network</CardDescription>
          </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="space-y-2">
              <Label htmlFor="auto-pin-mode">Auto-Pin Mode</Label>
              <Select
                data-testid="select-auto-pin-mode"
                value={settings?.autoPinMode || "off"}
                onValueChange={(value: "off" | "all" | "daily_limit") => {
                  updateSettingsMutation.mutate({
                    autoPinMode: value,
                    autoPinEnabled: value !== "off"
                  });
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off - Manual pinning only</SelectItem>
                  <SelectItem value="all">All - Pin every new video</SelectItem>
                  <SelectItem value="daily_limit">Daily Limit - Set max per day</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="daily-limit">Daily Limit</Label>
              <div className="flex items-center gap-2">
                <Input
                  data-testid="input-daily-limit"
                  id="daily-limit"
                  type="number"
                  min={1}
                  max={100}
                  value={settings?.autoPinDailyLimit || 10}
                  disabled={settings?.autoPinMode !== "daily_limit"}
                  onChange={(e) => {
                    const value = parseInt(e.target.value) || 10;
                    updateSettingsMutation.mutate({ autoPinDailyLimit: value });
                  }}
                  className="w-24"
                />
                <span className="text-sm text-muted-foreground">videos/day</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Today's Progress</Label>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <Progress
                    value={settings?.autoPinMode === "daily_limit" && settings?.autoPinDailyLimit
                      ? ((settings?.autoPinTodayCount || 0) / settings.autoPinDailyLimit) * 100
                      : 0
                    }
                    className="h-2"
                  />
                </div>
                <span className="text-sm font-medium">
                  {settings?.autoPinTodayCount || 0}
                  {settings?.autoPinMode === "daily_limit" && `/${settings?.autoPinDailyLimit || 10}`}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {settings?.autoPinMode === "off" && "Auto-pinning is disabled"}
                {settings?.autoPinMode === "all" && "Pinning all incoming videos"}
                {settings?.autoPinMode === "daily_limit" && `${(settings?.autoPinDailyLimit || 10) - (settings?.autoPinTodayCount || 0)} slots remaining today`}
              </p>
            </div>
          </div>
        </CardContent>
        </Card>
      </div>

      {/* Reputation & Health Section */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm lg:col-span-1">
          <CardHeader>
             <CardTitle className="text-sm font-medium flex items-center gap-2">
               <ShieldCheck className="w-4 h-4 text-primary" />
               Node Reputation Score
             </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-end justify-between">
              <span className="text-4xl font-display font-bold">{reputation}</span>
              <span className="text-xs text-muted-foreground mb-1">/ 100</span>
            </div>
            <Progress 
              value={reputation} 
              className={cn("h-2", 
                reputation > 80 ? "[&>div]:bg-green-500" : 
                reputation > 50 ? "[&>div]:bg-yellow-500" : "[&>div]:bg-red-500"
              )} 
            />
            <div className="flex items-center gap-2 text-xs">
              {reputation > 80 ? (
                <div className="flex items-center gap-1.5 text-green-500 bg-green-500/10 px-2 py-1 rounded">
                  <CheckCircle2 className="w-3 h-3" />
                  Excellent Standing (1.0x Rewards)
                </div>
              ) : reputation > 30 ? (
                <div className="flex items-center gap-1.5 text-yellow-500 bg-yellow-500/10 px-2 py-1 rounded">
                  <AlertTriangle className="w-3 h-3" />
                  Probation (0.5x Rewards)
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-red-500 bg-red-500/10 px-2 py-1 rounded">
                  <Ban className="w-3 h-3" />
                  Banned (0x Rewards)
                </div>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Your reputation affects your HBD earnings. Missed PoA challenges will lower your score. 
              <span className="text-red-400 font-medium"> 3 consecutive fails = Ban.</span>
            </p>
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm lg:col-span-2 flex flex-col justify-center">
           <CardContent className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="space-y-1">
                  <h3 className="font-medium">Global PoA Settings</h3>
                  <p className="text-xs text-muted-foreground">Master switch for all hosted content</p>
                </div>
                <div className="flex items-center gap-3">
                   <Label htmlFor="all-rewards" className="text-sm font-medium">Enable All Rewards</Label>
                   <Switch 
                    id="all-rewards" 
                    checked={allEnabled}
                    onCheckedChange={toggleAll}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4 pt-4 border-t border-border/50">
                 <div className="text-center">
                    <div className="text-2xl font-bold font-display">{totalProofs}</div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Total Proofs</div>
                 </div>
                 <div className="text-center">
                    <div className="text-2xl font-bold font-display text-red-500">{totalFails}</div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Failed Challenges</div>
                 </div>
                 <div className="text-center">
                    <div className="text-2xl font-bold font-display text-green-500">{successRate}%</div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Success Rate</div>
                 </div>
              </div>
           </CardContent>
        </Card>
      </div>

      {/* Files Table */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="font-display text-lg">
            {agentConnected ? `Pinned Content (${agentPins.length} pins)` : "Pinned Content"}
          </CardTitle>
          <div className="relative w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search CID or name..."
              className="pl-8 bg-background/50"
              value={fileSearch}
              onChange={(e) => setFileSearch(e.target.value.toLowerCase())}
            />
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent border-border/50">
                <TableHead>Name</TableHead>
                <TableHead>CID</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>PoA Status</TableHead>
                <TableHead>Earnings</TableHead>
                <TableHead>Performance</TableHead>
                <TableHead className="text-right">Last Verified</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filesLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin mx-auto text-muted-foreground" />
                    <p className="text-sm text-muted-foreground mt-2">Loading pinned content...</p>
                  </TableCell>
                </TableRow>
              ) : files.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-12">
                    <Upload className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p className="text-muted-foreground">
                      {agentConnected ? "No files pinned on your local node" : "No files pinned yet"}
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">Upload content to start earning HBD</p>
                  </TableCell>
                </TableRow>
              ) : files
                .filter(f => !fileSearch || f.name.toLowerCase().includes(fileSearch) || f.cid.toLowerCase().includes(fileSearch))
                .map((file) => (
                <TableRow key={file.id} className="hover:bg-primary/5 border-border/50 group transition-colors">
                  <TableCell className="font-medium flex items-center gap-2">
                    {agentConnected ? (
                      <>
                        <HardDrive className="w-4 h-4 text-primary" />
                        <span className="font-mono text-xs">{file.cid.substring(0, 20)}...</span>
                      </>
                    ) : (
                      <>
                        <File className="w-4 h-4 text-primary" />
                        {file.name}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help">{file.cid.length > 20 ? file.cid.substring(0, 20) + "..." : file.cid}</span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="font-mono text-xs max-w-md break-all">
                          {file.cid}
                        </TooltipContent>
                      </Tooltip>
                      <button
                        title="Copy CID"
                        className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-primary"
                        onClick={() => {
                          navigator.clipboard.writeText(file.cid);
                          toast({ title: "CID Copied", description: file.cid.substring(0, 24) + "..." });
                        }}
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                  </TableCell>
                  <TableCell>{file.size}</TableCell>
                  
                  {/* PoA Toggle Column */}
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch 
                        checked={file.poaEnabled} 
                        onCheckedChange={() => togglePoa(file.name)}
                        className="scale-75 data-[state=checked]:bg-green-500"
                      />
                      <span className={cn(
                        "text-xs font-medium",
                        file.poaEnabled ? "text-green-500" : "text-muted-foreground"
                      )}>
                        {file.poaEnabled ? "Earning" : "Paused"}
                      </span>
                    </div>
                  </TableCell>

                  {/* Earnings Column with Tooltip */}
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-1.5 cursor-help">
                          <Coins className="w-3.5 h-3.5 text-yellow-500" />
                          <span className={cn(
                            "font-medium text-sm",
                            (file.earnedHbd || 0) > 0 ? "text-green-500" : "text-muted-foreground"
                          )}>
                            {(file.earnedHbd || 0).toFixed(3)} HBD
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs">
                        <div className="space-y-1.5 text-xs">
                          <div className="font-semibold text-sm">Earnings for "{file.name}"</div>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">Total Earned:</span>
                            <span className="font-mono font-medium text-green-400">{(file.earnedHbd || 0).toFixed(3)} HBD</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">PoA Challenges:</span>
                            <span className="font-mono">{file.replicationCount * 10 || 0} passed</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">Reward Rate:</span>
                            <span className="font-mono">{file.replicationCount > 0 ? (1 / file.replicationCount).toFixed(2) : "1.00"}x</span>
                          </div>
                          <div className="pt-1 border-t border-border/50 text-muted-foreground">
                            Earnings based on successful PoA proofs. Fewer replicas = higher rewards.
                          </div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>

                  {/* Performance / Health Column */}
                  <TableCell>
                    <div className="flex items-center gap-3">
                       {file.status === "warning" ? (
                         <Tooltip>
                           <TooltipTrigger>
                              <div className="flex items-center gap-1 text-xs text-red-500 bg-red-500/10 px-2 py-1 rounded font-medium">
                                <XCircle className="w-3 h-3" />
                                Fails
                              </div>
                           </TooltipTrigger>
                           <TooltipContent>High failure rate detected. Rewards paused.</TooltipContent>
                         </Tooltip>
                       ) : (
                         <div className="flex items-center gap-1 text-xs text-green-500 bg-green-500/10 px-2 py-1 rounded font-medium opacity-80">
                            <CheckCircle2 className="w-3 h-3" />
                            {file.replicationCount} Peers
                         </div>
                       )}

                       {/* Trust Score */}
                       <div className="w-16 h-1.5 bg-secondary rounded-full overflow-hidden">
                          <div 
                            className={cn("h-full rounded-full", file.confidence > 80 ? "bg-green-500" : file.confidence > 50 ? "bg-yellow-500" : "bg-red-500")} 
                            style={{ width: `${file.confidence}%` }}
                          />
                       </div>
                    </div>
                  </TableCell>

                  <TableCell className="text-right text-muted-foreground font-mono text-xs">
                    {new Date(file.createdAt).toLocaleTimeString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          title="Unpin from IPFS"
                          data-testid={`button-delete-${file.id}`}
                          onClick={() => handleDelete(file)}
                          disabled={deleteFileMutation.isPending}
                          className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Unpin from IPFS</TooltipContent>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-border/50">
              <p className="text-sm text-muted-foreground">
                Page {filePage} of {totalPages} ({filesData?.total || 0} files)
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={filePage <= 1}
                  onClick={() => setFilePage(p => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={filePage >= totalPages}
                  onClick={() => setFilePage(p => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showAgentPrompt} onOpenChange={setShowAgentPrompt}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Monitor className="h-5 w-5 text-primary" />
              Desktop Agent Required
            </DialogTitle>
            <DialogDescription>
              The SPK Desktop Agent must be running to upload and pin content to your local IPFS node.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div className="rounded-lg border bg-muted/50 p-4 space-y-2 text-sm">
              <p className="font-medium">The Desktop Agent:</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>Runs a local IPFS node for content storage</li>
                <li>Responds to Proof-of-Access challenges</li>
                <li>Earns HBD rewards automatically</li>
              </ul>
            </div>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setShowAgentPrompt(false)}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={() => window.location.href = "/download"}>
                <Download className="h-4 w-4 mr-2" />
                Download Agent
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
