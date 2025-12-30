import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, File, Search, Copy, CheckCircle2, Clock, ShieldCheck, AlertCircle, Users, Coins, AlertTriangle, XCircle, Ban, Wifi, Network, Film, Cpu, Hash, Globe, X, Trash2, Pin, Settings } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, UserSettings } from "@/lib/api";

export default function Storage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  // New State for "Oratr" simulation (Transcoding -> Hashing -> Seeding)
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'transcoding' | 'hashing' | 'broadcasting' | 'seeding' | 'complete'>('idle');
  const [taskProgress, setTaskProgress] = useState(0);
  const [seedPeers, setSeedPeers] = useState(0);

  // Fetch files from API
  const { data: files = [] } = useQuery({
    queryKey: ["files"],
    queryFn: api.getFiles,
    refetchInterval: 10000,
  });

  // Fetch nodes to get our own reputation
  const { data: nodes = [] } = useQuery({
    queryKey: ["nodes"],
    queryFn: api.getNodes,
    refetchInterval: 10000,
  });

  // Fetch user settings (simulated username "demo_user")
  const { data: settings } = useQuery({
    queryKey: ["settings", "demo_user"],
    queryFn: () => api.getSettings("demo_user"),
    refetchInterval: 30000,
  });

  // Update settings mutation
  const updateSettingsMutation = useMutation({
    mutationFn: (data: Partial<UserSettings>) => api.updateSettings("demo_user", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings", "demo_user"] });
      toast({
        title: "Settings Updated",
        description: "Your auto-pin preferences have been saved.",
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

  // Get first node's reputation (simulate "your" node)
  const reputation = nodes[0]?.reputation || 50;

  // Stats calculation
  const totalProofs = nodes.reduce((sum, n) => sum + n.totalProofs, 0);
  const totalFails = nodes.reduce((sum, n) => sum + n.failedProofs, 0);
  const successRate = totalProofs + totalFails > 0 
    ? ((totalProofs / (totalProofs + totalFails)) * 100).toFixed(1)
    : "0.0";

  // Create file mutation
  const createFileMutation = useMutation({
    mutationFn: api.createFile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["files"] });
    },
  });

  // Delete file mutation
  const deleteFileMutation = useMutation({
    mutationFn: (id: string) => api.deleteFile(id),
    onSuccess: () => {
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
    if (confirm(`Are you sure you want to unpin "${file.name}"? This will remove it from your IPFS node.`)) {
      deleteFileMutation.mutate(file.id);
    }
  };

  const handleUpload = () => {
    // Phase 1: Transcoding (Client Side)
    setUploadStatus('transcoding');
    setTaskProgress(0);
    
    let p = 0;
    const interval = setInterval(() => {
      p += 5;
      setTaskProgress(p);
      if (p >= 100) {
        clearInterval(interval);
        
        // Phase 2: Hashing (IPFS)
        setUploadStatus('hashing');
        setTaskProgress(0);
        let h = 0;
        const hashInterval = setInterval(() => {
           h += 10;
           setTaskProgress(h);
           if (h >= 100) {
             clearInterval(hashInterval);
             
             // Phase 3: Hive Broadcast
             setUploadStatus('broadcasting');
             setTimeout(() => {
                startSeeding();
             }, 1500);
           }
        }, 150);
      }
    }, 100);
  };

  const startSeeding = () => {
    // Phase 4: Swarm Discovery
    setUploadStatus('seeding');
    toast({
      title: "Hive Transaction Broadcasted",
      description: "custom_json: [\"spk_video_upload\", { ... }]",
    });

    // Simulate peers connecting
    let peers = 0;
    const seedInterval = setInterval(() => {
      peers++;
      setSeedPeers(peers);
      if (peers >= 3) {
        clearInterval(seedInterval);
        setUploadStatus('complete');
        toast({
          title: "Swarm Replication Active",
          description: "3 Storage Nodes are now hosting your content.",
        });
        // Add new file via API
        createFileMutation.mutate({
          name: "my_vlog_final.mp4",
          cid: `QmNew${Date.now()}`,
          size: "450 MB",
          uploaderUsername: "user",
          status: "syncing",
          replicationCount: 3,
          confidence: 0,
          poaEnabled: true,
        });
        setTimeout(() => setUploadStatus('idle'), 3000);
      }
    }, 1500);
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
      
      {/* Header & Upload */}
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold">Storage Management</h1>
          <p className="text-muted-foreground mt-1">Manage your IPFS pins and content proofs</p>
        </div>
        <div className="flex items-center gap-4">
          <Button 
            onClick={handleUpload} 
            disabled={uploadStatus !== 'idle'} 
            className={cn(
              "transition-all duration-500 min-w-[200px]",
              uploadStatus === 'seeding' ? "bg-green-500 hover:bg-green-600" : "bg-primary hover:bg-primary/90"
            )}
          >
            {uploadStatus === 'idle' && (
              <>
                <Upload className="w-4 h-4 mr-2" />
                Upload New Content
              </>
            )}
            
            {uploadStatus === 'transcoding' && (
              <>
                 <Film className="w-4 h-4 mr-2 animate-pulse" />
                 Transcoding... {taskProgress}%
              </>
            )}

            {uploadStatus === 'hashing' && (
              <>
                 <Cpu className="w-4 h-4 mr-2 animate-pulse" />
                 IPFS Hashing... {taskProgress}%
              </>
            )}

            {uploadStatus === 'broadcasting' && (
              <>
                 <Globe className="w-4 h-4 mr-2 animate-pulse" />
                 Hive Broadcast...
              </>
            )}

            {uploadStatus === 'seeding' && (
              <>
                 <Wifi className="w-4 h-4 mr-2 animate-pulse" />
                 Seeding... ({seedPeers} Peers)
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

      {/* Auto-Pin Settings */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="pb-4">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Pin className="w-4 h-4 text-primary" />
            Auto-Pin New Videos
          </CardTitle>
          <CardDescription>Automatically pin new videos from the network to earn HBD rewards</CardDescription>
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
          <CardTitle className="font-display text-lg">Pinned Content</CardTitle>
          <div className="relative w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search CID or name..." className="pl-8 bg-background/50" />
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
                <TableHead>Performance</TableHead>
                <TableHead className="text-right">Last Verified</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file) => (
                <TableRow key={file.id} className="hover:bg-primary/5 border-border/50 group transition-colors">
                  <TableCell className="font-medium flex items-center gap-2">
                    <File className="w-4 h-4 text-primary" />
                    {file.name}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <div className="flex items-center gap-2">
                      {file.cid}
                      <button className="opacity-0 group-hover:opacity-100 transition-opacity hover:text-primary">
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
        </CardContent>
      </Card>
    </div>
  );
}
