import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { 
  Video, 
  Upload, 
  Settings, 
  RefreshCw, 
  Monitor, 
  Globe, 
  Cpu,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  Loader2,
  Server,
  Activity,
  Users,
  Timer,
  Zap,
  WifiOff,
  Wifi
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { BrowserEncoder } from "@/lib/browser-encoder";
import { detectDesktopAgent, type DesktopAgentStatus } from "@/lib/desktop-agent";

interface EncodingJob {
  id: string;
  owner: string;
  permlink: string;
  inputCid: string;
  outputCid?: string;
  status: string;
  progress: number;
  stage?: string;
  encodingMode: string;
  encoderType?: string;
  isShort: boolean;
  qualitiesEncoded?: string;
  videoUrl?: string;
  hbdCost?: string;
  errorMessage?: string;
  originalFilename?: string;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  processingTimeSec?: number;
  createdAt: string;
  completedAt?: string;
  estimatedWaitSec?: number;
}

interface QueueStats {
  queued: number;
  assigned: number;
  processing: number;
  completed: number;
  failed: number;
  totalPending: number;
}

interface EncoderNode {
  id: string;
  peerId: string;
  hiveUsername: string;
  endpoint?: string;
  encoderType: string;
  availability: string;
  jobsCompleted: number;
  jobsInProgress: number;
  hardwareAcceleration?: string;
  rating?: number;
}

interface EncoderStatus {
  desktop: {
    available: boolean;
    status: DesktopAgentStatus | null;
    checking: boolean;
  };
  browser: {
    supported: boolean;
    missing: string[];
  };
  community: {
    count: number;
    available: number;
  };
}

export default function EncodingPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [newJobForm, setNewJobForm] = useState({
    owner: "",
    permlink: "",
    inputCid: "",
    isShort: false,
    useBrowserEncoder: false,
  });
  const [testEndpoint, setTestEndpoint] = useState("http://localhost:3002");
  
  const [encoderStatus, setEncoderStatus] = useState<EncoderStatus>({
    desktop: { available: false, status: null, checking: false },
    browser: { supported: false, missing: [] },
    community: { count: 0, available: 0 },
  });

  const { data: queueStats } = useQuery<QueueStats>({
    queryKey: ["/api/encoding/queue/stats"],
    refetchInterval: 3000,
  });

  const { data: jobs = [] } = useQuery<EncodingJob[]>({
    queryKey: ["/api/encoding/jobs", username],
    queryFn: async () => {
      const url = username 
        ? `/api/encoding/jobs?owner=${encodeURIComponent(username)}`
        : "/api/encoding/jobs";
      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to fetch jobs");
      return res.json();
    },
    refetchInterval: 2000,
  });

  const { data: encoders = [] } = useQuery<EncoderNode[]>({
    queryKey: ["/api/encoding/encoders"],
    refetchInterval: 10000,
  });

  useEffect(() => {
    const browserSupport = BrowserEncoder.getSupportInfo();
    setEncoderStatus(prev => ({
      ...prev,
      browser: {
        supported: browserSupport.supported,
        missing: browserSupport.missing,
      },
    }));
  }, []);

  useEffect(() => {
    const available = encoders.filter(e => e.availability === "available").length;
    setEncoderStatus(prev => ({
      ...prev,
      community: {
        count: encoders.length,
        available,
      },
    }));
  }, [encoders]);

  const checkDesktopAgent = async () => {
    setEncoderStatus(prev => ({
      ...prev,
      desktop: { ...prev.desktop, checking: true },
    }));
    
    try {
      const status = await detectDesktopAgent();
      setEncoderStatus(prev => ({
        ...prev,
        desktop: {
          available: status !== null,
          status,
          checking: false,
        },
      }));
      
      if (status) {
        toast({ 
          title: "Desktop Agent Connected", 
          description: `Version: ${status.version || "Unknown"}` 
        });
      }
    } catch {
      setEncoderStatus(prev => ({
        ...prev,
        desktop: { available: false, status: null, checking: false },
      }));
    }
  };

  useEffect(() => {
    checkDesktopAgent();
    const interval = setInterval(checkDesktopAgent, 30000);
    return () => clearInterval(interval);
  }, []);

  const submitJobMutation = useMutation({
    mutationFn: async (job: typeof newJobForm) => {
      const res = await fetch("/api/encoding/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner: job.owner,
          permlink: job.permlink,
          inputCid: job.inputCid,
          isShort: job.isShort,
          encodingMode: job.useBrowserEncoder ? "browser" : "auto",
        }),
      });
      if (!res.ok) throw new Error("Failed to submit job");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Job Submitted", description: "Encoding job added to queue" });
      queryClient.invalidateQueries({ queryKey: ["/api/encoding/jobs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/encoding/queue/stats"] });
      setNewJobForm({ owner: "", permlink: "", inputCid: "", isShort: false, useBrowserEncoder: false });
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const checkDesktopAgentMutation = useMutation({
    mutationFn: async (endpoint: string) => {
      const res = await fetch("/api/encoding/check-desktop-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.available) {
        toast({ 
          title: "Desktop Agent Found", 
          description: `Hardware: ${data.hardwareAcceleration || "Software"}` 
        });
      } else {
        toast({ 
          title: "Desktop Agent Not Found", 
          description: "Make sure the agent is running locally",
          variant: "destructive"
        });
      }
    },
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <Badge className="bg-green-500 hover:bg-green-600" data-testid="badge-status-completed">completed</Badge>;
      case "failed":
        return <Badge variant="destructive" data-testid="badge-status-failed">failed</Badge>;
      case "queued":
        return <Badge className="bg-yellow-500 hover:bg-yellow-600" data-testid="badge-status-queued">queued</Badge>;
      case "assigned":
        return <Badge className="bg-orange-500 hover:bg-orange-600" data-testid="badge-status-assigned">assigned</Badge>;
      case "downloading":
      case "encoding":
      case "uploading":
        return <Badge className="bg-blue-500 hover:bg-blue-600" data-testid="badge-status-encoding">{status}</Badge>;
      default:
        return <Badge variant="secondary" data-testid="badge-status-unknown">{status}</Badge>;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case "failed":
        return <XCircle className="h-4 w-4 text-red-500" />;
      case "queued":
        return <Clock className="h-4 w-4 text-yellow-500" />;
      case "downloading":
      case "encoding":
      case "uploading":
        return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
      default:
        return <AlertCircle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getEncoderTypeIcon = (type?: string) => {
    switch (type) {
      case "desktop":
        return <Monitor className="h-4 w-4" />;
      case "browser":
        return <Globe className="h-4 w-4" />;
      case "community":
        return <Server className="h-4 w-4" />;
      default:
        return <Cpu className="h-4 w-4" />;
    }
  };

  const getStageLabel = (status: string, stage?: string) => {
    if (stage) return stage;
    switch (status) {
      case "downloading": return "Downloading source...";
      case "encoding": return "Encoding video...";
      case "uploading": return "Uploading to IPFS...";
      default: return status;
    }
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatDuration = (sec?: number) => {
    if (!sec) return "—";
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  };

  const formatWaitTime = (seconds?: number) => {
    if (!seconds || seconds <= 0) return "Ready to start";
    if (seconds < 60) return `~${seconds}s wait`;
    if (seconds < 3600) return `~${Math.ceil(seconds / 60)}min wait`;
    return `~${Math.ceil(seconds / 3600)}h wait`;
  };

  const activeJobs = jobs.filter(j => ["downloading", "encoding", "uploading", "assigned"].includes(j.status));
  const queuedJobs = jobs.filter(j => j.status === "queued");
  const completedJobs = jobs.filter(j => j.status === "completed");
  const failedJobs = jobs.filter(j => j.status === "failed");

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Video className="h-8 w-8 text-red-500" />
            Hybrid Encoding
          </h1>
          <p className="text-muted-foreground">
            Self-encode with desktop agent, browser, or use community encoders
          </p>
        </div>
        <Button 
          variant="outline" 
          onClick={() => {
            queryClient.invalidateQueries();
            checkDesktopAgent();
          }}
          data-testid="button-refresh-encoding"
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card data-testid="panel-encoder-status">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Encoder Status
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Monitor className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Desktop Agent</span>
              </div>
              {encoderStatus.desktop.checking ? (
                <Badge variant="outline" className="flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Checking
                </Badge>
              ) : encoderStatus.desktop.available ? (
                <Badge className="bg-green-500 flex items-center gap-1" data-testid="status-desktop-connected">
                  <Wifi className="h-3 w-3" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="secondary" className="flex items-center gap-1" data-testid="status-desktop-disconnected">
                  <WifiOff className="h-3 w-3" />
                  Disconnected
                </Badge>
              )}
            </div>
            
            <Separator />
            
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Browser WebCodecs</span>
              </div>
              {encoderStatus.browser.supported ? (
                <Badge className="bg-green-500" data-testid="status-browser-supported">
                  Supported
                </Badge>
              ) : (
                <Badge variant="secondary" data-testid="status-browser-unsupported">
                  Unsupported
                </Badge>
              )}
            </div>
            
            <Separator />
            
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Community Encoders</span>
              </div>
              <Badge 
                variant={encoderStatus.community.available > 0 ? "default" : "secondary"}
                data-testid="status-community-count"
              >
                {encoderStatus.community.available}/{encoderStatus.community.count} available
              </Badge>
            </div>
          </CardContent>
        </Card>

        <Card data-testid="panel-queue-stats">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Timer className="h-5 w-5" />
              Queue Statistics
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3">
              <div className="text-center p-2 rounded-lg bg-yellow-500/10">
                <div className="text-2xl font-bold text-yellow-500" data-testid="stat-queued">
                  {queueStats?.queued || 0}
                </div>
                <div className="text-xs text-muted-foreground">Queued</div>
              </div>
              <div className="text-center p-2 rounded-lg bg-blue-500/10">
                <div className="text-2xl font-bold text-blue-500" data-testid="stat-processing">
                  {queueStats?.processing || 0}
                </div>
                <div className="text-xs text-muted-foreground">Processing</div>
              </div>
              <div className="text-center p-2 rounded-lg bg-green-500/10">
                <div className="text-2xl font-bold text-green-500" data-testid="stat-completed">
                  {queueStats?.completed || 0}
                </div>
                <div className="text-xs text-muted-foreground">Completed</div>
              </div>
              <div className="text-center p-2 rounded-lg bg-red-500/10">
                <div className="text-2xl font-bold text-red-500" data-testid="stat-failed">
                  {queueStats?.failed || 0}
                </div>
                <div className="text-xs text-muted-foreground">Failed</div>
              </div>
            </div>
            {queueStats?.totalPending && queueStats.totalPending > 0 && (
              <div className="mt-3 text-center text-sm text-muted-foreground">
                <span data-testid="text-estimated-wait">
                  Est. wait: {formatWaitTime(queueStats.totalPending * 60)}
                </span>
              </div>
            )}
          </CardContent>
        </Card>

        <Card data-testid="panel-active-jobs">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Active Jobs
            </CardTitle>
          </CardHeader>
          <CardContent>
            {activeJobs.length === 0 ? (
              <div className="text-center py-4 text-muted-foreground text-sm">
                No active encoding jobs
              </div>
            ) : (
              <div className="space-y-3">
                {activeJobs.slice(0, 3).map((job) => (
                  <div key={job.id} className="space-y-1" data-testid={`active-job-${job.id}`}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium truncate max-w-[120px]">{job.permlink}</span>
                      {getStatusBadge(job.status)}
                    </div>
                    <Progress value={job.progress} className="h-2" data-testid={`progress-bar-${job.id}`} />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span data-testid={`stage-label-${job.id}`}>{getStageLabel(job.status, job.stage)}</span>
                      <span data-testid={`progress-percent-${job.id}`}>{job.progress}%</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="jobs" className="space-y-4">
        <TabsList>
          <TabsTrigger value="jobs" data-testid="tab-jobs">
            Jobs History
            {jobs.length > 0 && (
              <Badge variant="secondary" className="ml-2">{jobs.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="submit" data-testid="tab-submit">Submit Job</TabsTrigger>
          <TabsTrigger value="encoders" data-testid="tab-encoders">
            Encoders
            {encoders.length > 0 && (
              <Badge variant="secondary" className="ml-2">{encoders.length}</Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="settings" data-testid="tab-settings">Settings</TabsTrigger>
        </TabsList>

        <TabsContent value="jobs" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Encoding Jobs</CardTitle>
                  <CardDescription>Job history and real-time status</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    placeholder="Filter by username..."
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-48"
                    data-testid="input-filter-username"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {jobs.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Video className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No encoding jobs yet</p>
                  <p className="text-sm mt-1">Submit a video to get started</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {jobs.map((job) => (
                    <div
                      key={job.id}
                      className="border rounded-lg p-4 space-y-3"
                      data-testid={`card-job-${job.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {getStatusIcon(job.status)}
                          <span className="font-medium">{job.owner}/{job.permlink}</span>
                          {job.isShort && <Badge variant="secondary">Short</Badge>}
                        </div>
                        <div className="flex items-center gap-2">
                          {job.encoderType && (
                            <Badge variant="outline" className="flex items-center gap-1">
                              {getEncoderTypeIcon(job.encoderType)}
                              {job.encoderType}
                            </Badge>
                          )}
                          {getStatusBadge(job.status)}
                        </div>
                      </div>

                      {["downloading", "encoding", "uploading", "assigned"].includes(job.status) && (
                        <div className="space-y-1">
                          <div className="flex justify-between text-sm text-muted-foreground">
                            <span data-testid={`job-stage-${job.id}`}>
                              {getStageLabel(job.status, job.stage)}
                            </span>
                            <span data-testid={`job-progress-${job.id}`}>{job.progress}%</span>
                          </div>
                          <Progress value={job.progress} data-testid={`job-progress-bar-${job.id}`} />
                        </div>
                      )}

                      {job.status === "queued" && (
                        <div className="flex items-center gap-2 text-sm text-yellow-600 bg-yellow-500/10 p-2 rounded">
                          <Clock className="h-4 w-4" />
                          <span data-testid={`job-wait-${job.id}`}>
                            {formatWaitTime(job.estimatedWaitSec)}
                          </span>
                        </div>
                      )}

                      <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                        <span>Input: {job.inputCid.substring(0, 12)}...</span>
                        {job.outputCid && (
                          <span>Output: {job.outputCid.substring(0, 12)}...</span>
                        )}
                        {job.qualitiesEncoded && (
                          <span>Qualities: {job.qualitiesEncoded}</span>
                        )}
                        {job.inputSizeBytes && (
                          <span>Size: {formatBytes(job.inputSizeBytes)}</span>
                        )}
                        {job.processingTimeSec && (
                          <span>Time: {formatDuration(job.processingTimeSec)}</span>
                        )}
                        {job.hbdCost && parseFloat(job.hbdCost) > 0 && (
                          <span className="text-orange-500">Cost: {job.hbdCost} HBD</span>
                        )}
                      </div>

                      {job.errorMessage && (
                        <div className="text-sm text-red-500 bg-red-500/10 p-2 rounded flex items-start gap-2">
                          <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
                          <span data-testid={`job-error-${job.id}`}>{job.errorMessage}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="submit" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Submit Encoding Job</CardTitle>
              <CardDescription>
                Submit a video for encoding. Uses desktop agent if available, otherwise falls back to browser or community encoders.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="owner">Hive Username</Label>
                  <Input
                    id="owner"
                    placeholder="your-hive-username"
                    value={newJobForm.owner}
                    onChange={(e) => setNewJobForm({ ...newJobForm, owner: e.target.value })}
                    data-testid="input-owner"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="permlink">Permlink</Label>
                  <Input
                    id="permlink"
                    placeholder="my-video-post"
                    value={newJobForm.permlink}
                    onChange={(e) => setNewJobForm({ ...newJobForm, permlink: e.target.value })}
                    data-testid="input-permlink"
                  />
                </div>
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="inputCid">Input CID</Label>
                <Input
                  id="inputCid"
                  placeholder="Qm... or bafy..."
                  value={newJobForm.inputCid}
                  onChange={(e) => setNewJobForm({ ...newJobForm, inputCid: e.target.value })}
                  data-testid="input-cid"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center space-x-2">
                  <Switch
                    id="isShort"
                    checked={newJobForm.isShort}
                    onCheckedChange={(checked) => setNewJobForm({ ...newJobForm, isShort: checked })}
                    data-testid="switch-is-short"
                  />
                  <Label htmlFor="isShort">Short video (480p only, faster encoding)</Label>
                </div>

                {encoderStatus.browser.supported && (
                  <div className="flex items-center space-x-2">
                    <Switch
                      id="useBrowserEncoder"
                      checked={newJobForm.useBrowserEncoder}
                      onCheckedChange={(checked) => setNewJobForm({ ...newJobForm, useBrowserEncoder: checked, isShort: checked ? true : newJobForm.isShort })}
                      data-testid="switch-browser-encoder"
                    />
                    <div>
                      <Label htmlFor="useBrowserEncoder">Use browser encoding (WebCodecs)</Label>
                      <p className="text-xs text-muted-foreground">
                        Encode in your browser - works for videos under 2 minutes
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {newJobForm.useBrowserEncoder && !encoderStatus.browser.supported && (
                <div className="text-sm text-yellow-600 bg-yellow-500/10 p-3 rounded">
                  <AlertCircle className="h-4 w-4 inline mr-2" />
                  Browser encoding not supported. Missing: {encoderStatus.browser.missing.join(", ")}
                </div>
              )}

              <Button 
                onClick={() => submitJobMutation.mutate(newJobForm)}
                disabled={!newJobForm.owner || !newJobForm.permlink || !newJobForm.inputCid || submitJobMutation.isPending}
                className="w-full"
                data-testid="button-submit-job"
              >
                {submitJobMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                Submit Encoding Job
              </Button>

              <div className="rounded-lg border p-4 space-y-2">
                <h4 className="font-medium text-sm">Encoding Priority</h4>
                <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                  <li className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 inline" />
                    <span><strong>Desktop Agent</strong> - Fastest, GPU acceleration, free</span>
                    {encoderStatus.desktop.available && <Badge className="bg-green-500 ml-auto">Available</Badge>}
                  </li>
                  <li className="flex items-center gap-2">
                    <Globe className="h-4 w-4 inline" />
                    <span><strong>Browser (WebCodecs)</strong> - Short videos only, free</span>
                    {encoderStatus.browser.supported && <Badge className="bg-green-500 ml-auto">Supported</Badge>}
                  </li>
                  <li className="flex items-center gap-2">
                    <Server className="h-4 w-4 inline" />
                    <span><strong>Community Encoders</strong> - Reliable, costs HBD</span>
                    {encoderStatus.community.available > 0 && (
                      <Badge variant="secondary" className="ml-auto">{encoderStatus.community.available} online</Badge>
                    )}
                  </li>
                </ol>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="encoders" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Available Encoders</CardTitle>
              <CardDescription>
                Desktop agents, browser encoders, and community nodes
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2 mb-4">
                <Input
                  placeholder="http://localhost:3002"
                  value={testEndpoint}
                  onChange={(e) => setTestEndpoint(e.target.value)}
                  className="max-w-sm"
                  data-testid="input-test-endpoint"
                />
                <Button
                  variant="outline"
                  onClick={() => checkDesktopAgentMutation.mutate(testEndpoint)}
                  disabled={checkDesktopAgentMutation.isPending}
                  data-testid="button-test-agent"
                >
                  {checkDesktopAgentMutation.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Monitor className="h-4 w-4 mr-2" />
                  )}
                  Test Desktop Agent
                </Button>
              </div>

              {encoders.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Server className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No community encoders registered yet</p>
                  <p className="text-sm mt-1">Run the desktop agent to become an encoder</p>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {encoders.map((encoder) => (
                    <div
                      key={encoder.id}
                      className="border rounded-lg p-4 space-y-2"
                      data-testid={`card-encoder-${encoder.id}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {getEncoderTypeIcon(encoder.encoderType)}
                          <span className="font-medium">{encoder.hiveUsername}</span>
                        </div>
                        <Badge 
                          className={encoder.availability === "available" ? "bg-green-500" : ""}
                          variant={encoder.availability === "available" ? "default" : "secondary"}
                        >
                          {encoder.availability}
                        </Badge>
                      </div>
                      <div className="text-sm text-muted-foreground space-y-1">
                        <div>Type: {encoder.encoderType}</div>
                        {encoder.hardwareAcceleration && (
                          <div>Hardware: {encoder.hardwareAcceleration}</div>
                        )}
                        <div>Jobs: {encoder.jobsCompleted} completed, {encoder.jobsInProgress} active</div>
                        {encoder.rating && <div>Rating: {encoder.rating.toFixed(1)}/5.0</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5" />
                Encoding Preferences
              </CardTitle>
              <CardDescription>
                Configure your default encoding settings
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div className="border-t pt-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Desktop Agent Auto-Detection</Label>
                      <p className="text-sm text-muted-foreground">
                        Automatically use local encoding when agent is running
                      </p>
                    </div>
                    <Switch defaultChecked data-testid="switch-auto-detect" />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Browser Encoding Fallback</Label>
                      <p className="text-sm text-muted-foreground">
                        Use browser-based encoding for short videos if agent unavailable
                      </p>
                    </div>
                    <Switch defaultChecked data-testid="switch-browser-fallback" />
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Community Encoder Fallback</Label>
                      <p className="text-sm text-muted-foreground">
                        Use community encoders if local options unavailable (costs HBD)
                      </p>
                    </div>
                    <Switch defaultChecked data-testid="switch-community-fallback" />
                  </div>
                </div>

                <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-4">
                  <h4 className="font-medium flex items-center gap-2">
                    <Monitor className="h-4 w-4 text-blue-500" />
                    Desktop Agent Benefits
                  </h4>
                  <ul className="text-sm text-muted-foreground mt-2 space-y-1">
                    <li>• Free encoding (no HBD cost)</li>
                    <li>• GPU acceleration (NVENC, VAAPI, QSV)</li>
                    <li>• Multi-quality HLS output (1080p/720p/480p)</li>
                    <li>• Direct IPFS upload to your node</li>
                    <li>• Earn HBD by encoding for others</li>
                  </ul>
                </div>

                {encoderStatus.browser.supported && (
                  <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
                    <h4 className="font-medium flex items-center gap-2">
                      <Globe className="h-4 w-4 text-green-500" />
                      Browser Encoding Available
                    </h4>
                    <p className="text-sm text-muted-foreground mt-2">
                      Your browser supports WebCodecs. You can encode short videos (under 2 minutes) 
                      directly in your browser at 480p quality for free.
                    </p>
                  </div>
                )}

                {!encoderStatus.browser.supported && encoderStatus.browser.missing.length > 0 && (
                  <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4">
                    <h4 className="font-medium flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-yellow-500" />
                      Browser Encoding Unavailable
                    </h4>
                    <p className="text-sm text-muted-foreground mt-2">
                      Missing features: {encoderStatus.browser.missing.join(", ")}. 
                      Use Chrome 94+ or Edge 94+ for browser encoding support.
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
