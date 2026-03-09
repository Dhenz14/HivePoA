import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Flag, Ban, ShieldCheck, ShieldX, AlertTriangle, Search, Plus, Trash2, Eye, CheckCircle, XCircle } from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";
import { api } from "@/lib/api";

interface ContentFlagSummary {
  cid: string;
  totalFlags: number;
  reasons: string[];
  maxSeverity: string;
  status: string;
}

interface ContentFlag {
  id: string;
  cid: string;
  fileId: string | null;
  reporterUsername: string;
  reason: string;
  description: string | null;
  severity: string;
  status: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  flagCount: number;
  createdAt: string;
}

interface UploaderBan {
  id: string;
  bannedUsername: string;
  bannedBy: string;
  reason: string;
  scope: string;
  active: boolean;
  expiresAt: string | null;
  relatedFlagId: string | null;
  createdAt: string;
}

const FLAG_REASONS = [
  { value: "illegal", label: "Illegal Content", color: "text-red-500" },
  { value: "copyright", label: "Copyright Violation", color: "text-orange-500" },
  { value: "malware", label: "Malware / Virus", color: "text-red-600" },
  { value: "spam", label: "Spam", color: "text-yellow-500" },
  { value: "harassment", label: "Harassment", color: "text-purple-500" },
  { value: "other", label: "Other", color: "text-gray-500" },
];

const SEVERITY_COLORS: Record<string, string> = {
  low: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  moderate: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
  severe: "bg-orange-500/10 text-orange-500 border-orange-500/20",
  critical: "bg-red-500/10 text-red-500 border-red-500/20",
};

const STATUS_BADGES: Record<string, { color: string; icon: React.ReactNode }> = {
  pending: { color: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20", icon: <Eye className="w-3 h-3" /> },
  reviewed: { color: "bg-blue-500/10 text-blue-500 border-blue-500/20", icon: <Eye className="w-3 h-3" /> },
  confirmed: { color: "bg-red-500/10 text-red-500 border-red-500/20", icon: <CheckCircle className="w-3 h-3" /> },
  dismissed: { color: "bg-green-500/10 text-green-500 border-green-500/20", icon: <XCircle className="w-3 h-3" /> },
};

export default function ContentModeration() {
  const { toast } = useToast();
  const { user } = useValidatorAuth();
  const sessionToken = user?.sessionToken;
  const queryClient = useQueryClient();
  const [flagStatusFilter, setFlagStatusFilter] = useState<string>("all");
  const [banSearch, setBanSearch] = useState("");
  const [flagDialogOpen, setFlagDialogOpen] = useState(false);
  const [banDialogOpen, setBanDialogOpen] = useState(false);
  const [selectedCidForDetails, setSelectedCidForDetails] = useState<string | null>(null);

  // Form state for flag dialog
  const [flagCid, setFlagCid] = useState("");
  const [flagReason, setFlagReason] = useState("");
  const [flagDescription, setFlagDescription] = useState("");
  const [flagSeverity, setFlagSeverity] = useState("moderate");

  // Form state for ban dialog
  const [banUsername, setBanUsername] = useState("");
  const [banReason, setBanReason] = useState("");
  const [banScope, setBanScope] = useState("local");

  // Queries
  const { data: flagSummary = [], isLoading: loadingFlags } = useQuery<ContentFlagSummary[]>({
    queryKey: ["/api/flags/summary"],
    refetchInterval: 30000,
  });

  const { data: allFlags = [] } = useQuery<ContentFlag[]>({
    queryKey: ["/api/flags"],
    refetchInterval: 30000,
  });

  const { data: cidFlags = [] } = useQuery<ContentFlag[]>({
    queryKey: ["/api/flags/cid", selectedCidForDetails],
    queryFn: async () => selectedCidForDetails ? api.getFlagsByCid(selectedCidForDetails) : [],
    enabled: !!selectedCidForDetails,
  });

  const { data: bans = [], isLoading: loadingBans } = useQuery<UploaderBan[]>({
    queryKey: ["/api/bans"],
    refetchInterval: 30000,
  });

  // Mutations
  const flagMutation = useMutation({
    mutationFn: async () => {
      if (!sessionToken) throw new Error("Not authenticated");
      return api.flagContent({ cid: flagCid, reason: flagReason, description: flagDescription || undefined, severity: flagSeverity }, sessionToken);
    },
    onSuccess: () => {
      toast({ title: "Content Flagged", description: "Report submitted. Validators will review it." });
      queryClient.invalidateQueries({ queryKey: ["/api/flags"] });
      queryClient.invalidateQueries({ queryKey: ["/api/flags/summary"] });
      setFlagDialogOpen(false);
      setFlagCid(""); setFlagReason(""); setFlagDescription(""); setFlagSeverity("moderate");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to flag content", description: err.message, variant: "destructive" });
    },
  });

  const reviewMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "confirmed" | "dismissed" }) => {
      if (!sessionToken) throw new Error("Not authenticated");
      return api.reviewFlag(id, status, sessionToken);
    },
    onSuccess: (_, { status }) => {
      toast({ title: status === "confirmed" ? "Flag Confirmed" : "Flag Dismissed" });
      queryClient.invalidateQueries({ queryKey: ["/api/flags"] });
      queryClient.invalidateQueries({ queryKey: ["/api/flags/summary"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to review flag", description: err.message, variant: "destructive" });
    },
  });

  const banMutation = useMutation({
    mutationFn: async () => {
      if (!sessionToken) throw new Error("Not authenticated");
      return api.banUploader({ bannedUsername: banUsername, reason: banReason, scope: banScope }, sessionToken);
    },
    onSuccess: () => {
      toast({ title: "Uploader Banned", description: `${banUsername} has been banned from your node.` });
      queryClient.invalidateQueries({ queryKey: ["/api/bans"] });
      setBanDialogOpen(false);
      setBanUsername(""); setBanReason(""); setBanScope("local");
    },
    onError: (err: Error) => {
      toast({ title: "Failed to ban uploader", description: err.message, variant: "destructive" });
    },
  });

  const unbanMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!sessionToken) throw new Error("Not authenticated");
      return api.removeBan(id, sessionToken);
    },
    onSuccess: () => {
      toast({ title: "Ban Removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/bans"] });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to remove ban", description: err.message, variant: "destructive" });
    },
  });

  const filteredFlags = flagStatusFilter === "all"
    ? flagSummary
    : flagSummary.filter(f => f.status === flagStatusFilter);

  const filteredBans = banSearch
    ? bans.filter(b => b.bannedUsername.toLowerCase().includes(banSearch.toLowerCase()))
    : bans;

  // Stats
  const pendingFlags = flagSummary.filter(f => f.status === "pending").length;
  const confirmedFlags = flagSummary.filter(f => f.status === "confirmed").length;
  const criticalFlags = flagSummary.filter(f => f.maxSeverity === "critical").length;
  const totalBans = bans.length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Content Moderation</h1>
          <p className="text-muted-foreground">
            Flag harmful content and manage uploader bans to protect your storage node
          </p>
        </div>
        <div className="flex gap-2">
          <Dialog open={flagDialogOpen} onOpenChange={setFlagDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm">
                <Flag className="w-4 h-4 mr-2" />
                Flag Content
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Report Content</DialogTitle>
                <DialogDescription>
                  Flag content that violates community guidelines. Reports are reviewed by validators.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Content CID</label>
                  <Input
                    placeholder="Qm... or bafy..."
                    value={flagCid}
                    onChange={e => setFlagCid(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Reason</label>
                  <Select value={flagReason} onValueChange={setFlagReason}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a reason" />
                    </SelectTrigger>
                    <SelectContent>
                      {FLAG_REASONS.map(r => (
                        <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Severity</label>
                  <Select value={flagSeverity} onValueChange={setFlagSeverity}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low</SelectItem>
                      <SelectItem value="moderate">Moderate</SelectItem>
                      <SelectItem value="severe">Severe</SelectItem>
                      <SelectItem value="critical">Critical — Immediate Action</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Description (optional)</label>
                  <Textarea
                    placeholder="Provide additional details about the content..."
                    value={flagDescription}
                    onChange={e => setFlagDescription(e.target.value)}
                    rows={3}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setFlagDialogOpen(false)}>Cancel</Button>
                <Button
                  variant="destructive"
                  onClick={() => flagMutation.mutate()}
                  disabled={!flagCid || !flagReason || flagMutation.isPending}
                >
                  {flagMutation.isPending ? "Submitting..." : "Submit Report"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Dialog open={banDialogOpen} onOpenChange={setBanDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="destructive" size="sm">
                <Ban className="w-4 h-4 mr-2" />
                Ban Uploader
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Ban Uploader</DialogTitle>
                <DialogDescription>
                  Block a Hive user from uploading content to your storage node.
                  Their existing content will remain but no new uploads will be accepted.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Hive Username</label>
                  <Input
                    placeholder="username"
                    value={banUsername}
                    onChange={e => setBanUsername(e.target.value.toLowerCase())}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Reason</label>
                  <Textarea
                    placeholder="Why are you banning this uploader?"
                    value={banReason}
                    onChange={e => setBanReason(e.target.value)}
                    rows={2}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Scope</label>
                  <Select value={banScope} onValueChange={setBanScope}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">Local — Your node only</SelectItem>
                      <SelectItem value="network">Network — Recommend to all validators</SelectItem>
                    </SelectContent>
                  </Select>
                  {banScope === "network" && (
                    <p className="text-xs text-muted-foreground">
                      Network-scope bans are broadcast to other validators but each node decides whether to enforce them.
                    </p>
                  )}
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setBanDialogOpen(false)}>Cancel</Button>
                <Button
                  variant="destructive"
                  onClick={() => banMutation.mutate()}
                  disabled={!banUsername || !banReason || banMutation.isPending}
                >
                  {banMutation.isPending ? "Banning..." : "Confirm Ban"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="border-yellow-500/20">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-yellow-500/10">
                <Flag className="w-5 h-5 text-yellow-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{pendingFlags}</p>
                <p className="text-xs text-muted-foreground">Pending Reviews</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-red-500/20">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-500/10">
                <AlertTriangle className="w-5 h-5 text-red-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{criticalFlags}</p>
                <p className="text-xs text-muted-foreground">Critical Flags</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-green-500/20">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10">
                <ShieldCheck className="w-5 h-5 text-green-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{confirmedFlags}</p>
                <p className="text-xs text-muted-foreground">Confirmed Threats</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="border-purple-500/20">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <Ban className="w-5 h-5 text-purple-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{totalBans}</p>
                <p className="text-xs text-muted-foreground">Active Bans</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="flags">
        <TabsList>
          <TabsTrigger value="flags">
            <Flag className="w-4 h-4 mr-2" />
            Flagged Content
            {pendingFlags > 0 && (
              <Badge variant="destructive" className="ml-2 text-xs px-1.5 py-0">
                {pendingFlags}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="bans">
            <Ban className="w-4 h-4 mr-2" />
            Uploader Bans
            {totalBans > 0 && (
              <Badge variant="secondary" className="ml-2 text-xs px-1.5 py-0">
                {totalBans}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Flagged Content Tab */}
        <TabsContent value="flags" className="space-y-4">
          <div className="flex items-center gap-4">
            <Select value={flagStatusFilter} onValueChange={setFlagStatusFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Flags</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="dismissed">Dismissed</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {filteredFlags.length} flagged item{filteredFlags.length !== 1 ? "s" : ""}
            </p>
          </div>

          {loadingFlags ? (
            <Card><CardContent className="py-8 text-center text-muted-foreground">Loading flags...</CardContent></Card>
          ) : filteredFlags.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <ShieldCheck className="w-12 h-12 mx-auto text-green-500/50 mb-3" />
                <p className="text-muted-foreground">No flagged content. The network is clean!</p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>CID</TableHead>
                    <TableHead>Reasons</TableHead>
                    <TableHead>Flags</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredFlags.map(item => (
                    <TableRow key={item.cid}>
                      <TableCell className="font-mono text-xs max-w-[200px] truncate">
                        {item.cid}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {item.reasons.map(r => {
                            const reason = FLAG_REASONS.find(fr => fr.value === r);
                            return (
                              <Badge key={r} variant="outline" className="text-xs">
                                {reason?.label || r}
                              </Badge>
                            );
                          })}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">{item.totalFlags}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={SEVERITY_COLORS[item.maxSeverity] || ""}>
                          {item.maxSeverity}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={STATUS_BADGES[item.status]?.color || ""}>
                          <span className="flex items-center gap-1">
                            {STATUS_BADGES[item.status]?.icon}
                            {item.status}
                          </span>
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setSelectedCidForDetails(selectedCidForDetails === item.cid ? null : item.cid)}
                          >
                            <Eye className="w-4 h-4" />
                          </Button>
                          {item.status === "pending" && user && (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-red-500 hover:text-red-600"
                                onClick={() => {
                                  const flag = allFlags.find(f => f.cid === item.cid && f.status === "pending");
                                  if (flag) reviewMutation.mutate({ id: flag.id, status: "confirmed" });
                                }}
                                disabled={reviewMutation.isPending}
                              >
                                <ShieldX className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-green-500 hover:text-green-600"
                                onClick={() => {
                                  const flag = allFlags.find(f => f.cid === item.cid && f.status === "pending");
                                  if (flag) reviewMutation.mutate({ id: flag.id, status: "dismissed" });
                                }}
                                disabled={reviewMutation.isPending}
                              >
                                <CheckCircle className="w-4 h-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}

          {/* Detail panel for selected CID */}
          {selectedCidForDetails && cidFlags.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Eye className="w-4 h-4" />
                  Flag Details: <span className="font-mono text-xs">{selectedCidForDetails}</span>
                </CardTitle>
                <CardDescription>
                  {cidFlags.length} report{cidFlags.length !== 1 ? "s" : ""} filed for this content
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reporter</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Severity</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {cidFlags.map(flag => (
                      <TableRow key={flag.id}>
                        <TableCell className="font-medium">@{flag.reporterUsername}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {FLAG_REASONS.find(r => r.value === flag.reason)?.label || flag.reason}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[300px] truncate text-sm text-muted-foreground">
                          {flag.description || "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={SEVERITY_COLORS[flag.severity] || ""}>
                            {flag.severity}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={STATUS_BADGES[flag.status]?.color || ""}>
                            {flag.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {new Date(flag.createdAt).toLocaleDateString()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {/* Quick ban from flag */}
                {cidFlags.some(f => f.status === "confirmed") && (
                  <div className="mt-4 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                    <p className="text-sm text-red-400 mb-2">
                      This content has confirmed flags. Consider banning the uploader.
                    </p>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        const uploader = cidFlags[0]?.reporterUsername;
                        if (uploader) {
                          setBanUsername(uploader);
                          setBanReason(`Confirmed flagged content: ${selectedCidForDetails}`);
                          setBanDialogOpen(true);
                        }
                      }}
                    >
                      <Ban className="w-4 h-4 mr-2" />
                      Ban Uploader
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Uploader Bans Tab */}
        <TabsContent value="bans" className="space-y-4">
          <div className="flex items-center gap-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search banned users..."
                value={banSearch}
                onChange={e => setBanSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {filteredBans.length} active ban{filteredBans.length !== 1 ? "s" : ""}
            </p>
          </div>

          {loadingBans ? (
            <Card><CardContent className="py-8 text-center text-muted-foreground">Loading bans...</CardContent></Card>
          ) : filteredBans.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <ShieldCheck className="w-12 h-12 mx-auto text-green-500/50 mb-3" />
                <p className="text-muted-foreground">
                  {banSearch ? "No bans matching your search." : "No active bans. All uploaders are allowed."}
                </p>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Username</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Banned By</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredBans.map(ban => (
                    <TableRow key={ban.id}>
                      <TableCell className="font-medium">@{ban.bannedUsername}</TableCell>
                      <TableCell className="max-w-[250px] truncate text-sm text-muted-foreground">
                        {ban.reason}
                      </TableCell>
                      <TableCell className="text-sm">@{ban.bannedBy}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={ban.scope === "network" ? "text-red-500 border-red-500/30" : ""}>
                          {ban.scope}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {ban.expiresAt ? new Date(ban.expiresAt).toLocaleDateString() : "Never"}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(ban.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm" className="text-green-500 hover:text-green-600">
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Remove Ban?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will unban @{ban.bannedUsername} and allow them to upload content to your node again.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction onClick={() => unbanMutation.mutate(ban.id)}>
                                Remove Ban
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* How it works */}
      <Card className="border-primary/10">
        <CardHeader>
          <CardTitle className="text-sm">How Content Moderation Works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <p><strong>Community Flagging:</strong> Any authenticated user can flag content by CID. When multiple users flag the same content, the flag count increases, signaling higher urgency.</p>
          <p><strong>Validator Review:</strong> Validators review flags and either confirm (adds to blocklist) or dismiss them. Critical confirmed flags are automatically added to the network blocklist.</p>
          <p><strong>Uploader Bans:</strong> Node operators can ban uploaders by Hive username. Local bans apply to your node only. Network-scope bans are shared with other validators as recommendations.</p>
          <p><strong>Enforcement:</strong> Banned uploaders and blocked CIDs are checked during file uploads and PoA challenges. Storage nodes will not pin content from banned users.</p>
        </CardContent>
      </Card>
    </div>
  );
}
