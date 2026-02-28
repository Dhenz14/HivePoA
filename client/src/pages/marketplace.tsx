import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useDesktopAgent } from "@/hooks/use-desktop-agent";
import { Files, Gem, TrendingUp, Pin, Search, ArrowUpDown, ArrowUp, ArrowDown, Download, Monitor } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { motion } from "framer-motion";

interface MarketplaceFile {
  id: string;
  fileName: string;
  cid: string;
  size: string;
  replicaCount: number;
  rarityMultiplier: number;
  roiScore: number;
  dailyEarnings: number;
}

async function fetchMarketplaceFiles(): Promise<MarketplaceFile[]> {
  const res = await fetch("/api/files/marketplace");
  if (!res.ok) {
    return [];
  }
  const data = await res.json();
  const files = data.files || data || [];
  return files.map((f: any) => ({
    id: f.id,
    fileName: f.name || f.fileName || "Unknown",
    cid: f.cid || "",
    size: f.size || f.sizeBytes?.toString() || "0",
    replicaCount: f.replicationCount || f.replicaCount || 1,
    rarityMultiplier: f.rarityMultiplier || 1,
    roiScore: Math.round((f.roiScore || 0) * 100),
    dailyEarnings: f.dailyEarnings || 0,
  }));
}

function truncateCid(cid: string): string {
  if (cid.length <= 12) return cid;
  return `${cid.slice(0, 6)}...${cid.slice(-4)}`;
}

function formatSize(bytes: string | number): string {
  const size = typeof bytes === "string" ? parseInt(bytes) : bytes;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getRarityColor(replicaCount: number): string {
  if (replicaCount <= 1) return "bg-red-500";
  if (replicaCount <= 2) return "bg-orange-500";
  if (replicaCount <= 3) return "bg-yellow-500";
  if (replicaCount <= 5) return "bg-lime-500";
  return "bg-green-500";
}

function getRarityLevel(replicaCount: number): string {
  if (replicaCount <= 1) return "Very Rare";
  if (replicaCount <= 2) return "Rare";
  return "Common";
}

type SortField = "fileName" | "size" | "replicaCount" | "rarityMultiplier" | "roiScore" | "dailyEarnings";
type SortDirection = "asc" | "desc";

export default function Marketplace() {
  const { toast } = useToast();
  const { check: checkAgent } = useDesktopAgent();
  const [searchQuery, setSearchQuery] = useState("");
  const [rarityFilter, setRarityFilter] = useState<"all" | "rare" | "very_rare">("all");
  const [sortField, setSortField] = useState<SortField>("roiScore");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [showAgentPrompt, setShowAgentPrompt] = useState(false);

  const { data: files = [] } = useQuery({
    queryKey: ["files", "marketplace"],
    queryFn: fetchMarketplaceFiles,
    refetchInterval: 10000,
  });

  const stats = useMemo(() => {
    const totalFiles = files.length;
    const rareFiles = files.filter(f => f.replicaCount < 3).length;
    const avgRarityMultiplier = files.length > 0
      ? files.reduce((sum, f) => sum + f.rarityMultiplier, 0) / files.length
      : 0;
    return { totalFiles, rareFiles, avgRarityMultiplier };
  }, [files]);

  const topROIFiles = useMemo(() => {
    return [...files].sort((a, b) => b.roiScore - a.roiScore).slice(0, 10);
  }, [files]);

  const filteredAndSortedFiles = useMemo(() => {
    let result = [...files];

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        f => f.fileName.toLowerCase().includes(query) || f.cid.toLowerCase().includes(query)
      );
    }

    if (rarityFilter === "rare") {
      result = result.filter(f => f.replicaCount < 3 && f.replicaCount > 1);
    } else if (rarityFilter === "very_rare") {
      result = result.filter(f => f.replicaCount <= 1);
    }

    result.sort((a, b) => {
      let aVal: number, bVal: number;
      if (sortField === "fileName") {
        return sortDirection === "asc"
          ? a.fileName.localeCompare(b.fileName)
          : b.fileName.localeCompare(a.fileName);
      } else if (sortField === "size") {
        aVal = parseInt(a.size);
        bVal = parseInt(b.size);
      } else {
        aVal = a[sortField];
        bVal = b[sortField];
      }
      return sortDirection === "asc" ? aVal - bVal : bVal - aVal;
    });

    return result;
  }, [files, searchQuery, rarityFilter, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
  };

  const handlePinNow = async (file: MarketplaceFile) => {
    const running = await checkAgent();
    if (!running) {
      setShowAgentPrompt(true);
      return;
    }
    toast({
      title: "Pin Initiated",
      description: `Started pinning "${file.fileName}" (${truncateCid(file.cid)})`,
    });
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-50" />;
    return sortDirection === "asc"
      ? <ArrowUp className="w-3 h-3 ml-1" />
      : <ArrowDown className="w-3 h-3 ml-1" />;
  };

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold" data-testid="text-page-title">Content Marketplace</h1>
          <p className="text-muted-foreground mt-1">Discover high-ROI content to pin for maximum earnings</p>
        </div>
        <div className="flex gap-2">
          <span className="px-3 py-1 bg-primary/10 text-primary text-xs rounded-full font-mono flex items-center gap-2 border border-primary/20">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Live Updates
          </span>
        </div>
      </div>

      {/* Stats Overview Row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="stats-overview">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0 }}
        >
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-total-files">
            <CardContent className="p-6">
              <div className="flex justify-between items-start mb-4">
                <div className="p-2 bg-primary/5 rounded-lg text-primary">
                  <Files className="w-5 h-5" />
                </div>
              </div>
              <p className="text-sm font-medium text-muted-foreground">Total Files Available</p>
              <div className="flex items-baseline gap-1 mt-1">
                <h3 className="text-2xl font-bold font-display tracking-tight" data-testid="text-total-files">
                  {stats.totalFiles}
                </h3>
                <span className="text-sm text-muted-foreground font-medium">files</span>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
        >
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-rare-files">
            <CardContent className="p-6">
              <div className="flex justify-between items-start mb-4">
                <div className="p-2 bg-purple-500/10 rounded-lg text-purple-500">
                  <Gem className="w-5 h-5" />
                </div>
                <Badge variant="secondary" className="bg-purple-500/20 text-purple-400">High ROI</Badge>
              </div>
              <p className="text-sm font-medium text-muted-foreground">Rare Files (&lt;3 replicas)</p>
              <div className="flex items-baseline gap-1 mt-1">
                <h3 className="text-2xl font-bold font-display tracking-tight text-purple-500" data-testid="text-rare-files">
                  {stats.rareFiles}
                </h3>
                <span className="text-sm text-muted-foreground font-medium">files</span>
              </div>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-avg-rarity">
            <CardContent className="p-6">
              <div className="flex justify-between items-start mb-4">
                <div className="p-2 bg-green-500/10 rounded-lg text-green-500">
                  <TrendingUp className="w-5 h-5" />
                </div>
              </div>
              <p className="text-sm font-medium text-muted-foreground">Average Rarity Multiplier</p>
              <div className="flex items-baseline gap-1 mt-1">
                <h3 className="text-2xl font-bold font-display tracking-tight" data-testid="text-avg-rarity">
                  {stats.avgRarityMultiplier.toFixed(2)}
                </h3>
                <span className="text-sm text-muted-foreground font-medium">x</span>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* Recommended Pins Section */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-recommended-pins">
        <CardHeader>
          <CardTitle className="font-display flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-green-500" />
            Recommended Pins
          </CardTitle>
          <CardDescription>Top 10 files with highest ROI scores</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            {topROIFiles.map((file, index) => (
              <motion.div
                key={file.id}
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: index * 0.05 }}
                data-testid={`card-recommended-${file.id}`}
              >
                <Card className="border-border/30 bg-background/50 hover:border-primary/50 transition-colors h-full">
                  <CardContent className="p-4 flex flex-col h-full">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate" title={file.fileName}>
                          {file.fileName}
                        </p>
                        <Tooltip>
                          <TooltipTrigger>
                            <code className="text-[10px] text-muted-foreground font-mono">
                              {truncateCid(file.cid)}
                            </code>
                          </TooltipTrigger>
                          <TooltipContent className="font-mono text-xs">{file.cid}</TooltipContent>
                        </Tooltip>
                      </div>
                      {file.replicaCount < 3 && (
                        <Badge variant="secondary" className="bg-purple-500/20 text-purple-400 text-[10px] ml-2">
                          Rare
                        </Badge>
                      )}
                    </div>
                    
                    <div className="space-y-1 text-xs text-muted-foreground flex-1">
                      <div className="flex justify-between">
                        <span>Size:</span>
                        <span className="font-medium text-foreground">{formatSize(file.size)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Rarity:</span>
                        <Badge variant="outline" className={cn(
                          "text-[10px] px-1.5 py-0",
                          file.rarityMultiplier >= 2.0 ? "border-purple-500 text-purple-500" :
                          file.rarityMultiplier >= 1.25 ? "border-yellow-500 text-yellow-500" :
                          "border-muted-foreground text-muted-foreground"
                        )}>
                          {file.rarityMultiplier.toFixed(2)}x
                        </Badge>
                      </div>
                      <div className="flex justify-between">
                        <span>Daily:</span>
                        <span className="font-medium text-green-500">{file.dailyEarnings.toFixed(4)} HBD</span>
                      </div>
                    </div>

                    <Button 
                      size="sm" 
                      className="w-full mt-3 h-7 text-xs"
                      onClick={() => handlePinNow(file)}
                      data-testid={`button-pin-${file.id}`}
                    >
                      <Pin className="w-3 h-3 mr-1" />
                      Pin Now
                    </Button>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Rarity Heatmap */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-rarity-heatmap">
        <CardHeader>
          <CardTitle className="font-display flex items-center gap-2">
            <Gem className="w-5 h-5 text-purple-500" />
            Rarity Heatmap
          </CardTitle>
          <CardDescription>Visual overview of file rarity across the network</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 mb-4 text-xs">
            <span className="text-muted-foreground">Rarity Legend:</span>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-red-500" />
              <span>Very Rare (1)</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-orange-500" />
              <span>Rare (2)</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-yellow-500" />
              <span>Uncommon (3)</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-lime-500" />
              <span>Common (4-5)</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-3 h-3 rounded bg-green-500" />
              <span>Abundant (6+)</span>
            </div>
          </div>
          <div className="grid grid-cols-8 md:grid-cols-12 lg:grid-cols-16 gap-1" data-testid="heatmap-grid">
            {files.map((file) => (
              <Tooltip key={file.id}>
                <TooltipTrigger asChild>
                  <motion.div
                    className={cn(
                      "w-full aspect-square rounded cursor-pointer transition-transform hover:scale-110",
                      getRarityColor(file.replicaCount)
                    )}
                    initial={{ opacity: 0, scale: 0 }}
                    animate={{ opacity: 1, scale: 1 }}
                    data-testid={`heatmap-cell-${file.id}`}
                  />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <div className="space-y-1">
                    <p className="font-medium">{file.fileName}</p>
                    <p className="text-xs text-muted-foreground font-mono">{truncateCid(file.cid)}</p>
                    <div className="flex justify-between text-xs">
                      <span>Replicas:</span>
                      <span className="font-medium">{file.replicaCount}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span>Rarity:</span>
                      <span className="font-medium">{file.rarityMultiplier.toFixed(2)}x</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span>Daily Earnings:</span>
                      <span className="font-medium text-green-500">{file.dailyEarnings.toFixed(4)} HBD</span>
                    </div>
                  </div>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Full File Table */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm" data-testid="card-file-table">
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <CardTitle className="font-display">All Available Files</CardTitle>
              <CardDescription>Browse and filter all files available for pinning</CardDescription>
            </div>
            <div className="flex gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name or CID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 w-64"
                  data-testid="input-search"
                />
              </div>
              <Select value={rarityFilter} onValueChange={(v) => setRarityFilter(v as typeof rarityFilter)}>
                <SelectTrigger className="w-32" data-testid="select-rarity-filter">
                  <SelectValue placeholder="Filter" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Files</SelectItem>
                  <SelectItem value="rare">Rare</SelectItem>
                  <SelectItem value="very_rare">Very Rare</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead 
                  className="cursor-pointer hover:text-foreground"
                  onClick={() => handleSort("fileName")}
                  data-testid="header-name"
                >
                  <div className="flex items-center">
                    Name
                    <SortIcon field="fileName" />
                  </div>
                </TableHead>
                <TableHead>CID</TableHead>
                <TableHead 
                  className="cursor-pointer hover:text-foreground text-right"
                  onClick={() => handleSort("size")}
                  data-testid="header-size"
                >
                  <div className="flex items-center justify-end">
                    Size
                    <SortIcon field="size" />
                  </div>
                </TableHead>
                <TableHead 
                  className="cursor-pointer hover:text-foreground text-right"
                  onClick={() => handleSort("replicaCount")}
                  data-testid="header-replicas"
                >
                  <div className="flex items-center justify-end">
                    Replicas
                    <SortIcon field="replicaCount" />
                  </div>
                </TableHead>
                <TableHead 
                  className="cursor-pointer hover:text-foreground text-right"
                  onClick={() => handleSort("rarityMultiplier")}
                  data-testid="header-rarity"
                >
                  <div className="flex items-center justify-end">
                    Rarity
                    <SortIcon field="rarityMultiplier" />
                  </div>
                </TableHead>
                <TableHead 
                  className="cursor-pointer hover:text-foreground text-right"
                  onClick={() => handleSort("roiScore")}
                  data-testid="header-roi"
                >
                  <div className="flex items-center justify-end">
                    ROI Score
                    <SortIcon field="roiScore" />
                  </div>
                </TableHead>
                <TableHead 
                  className="cursor-pointer hover:text-foreground text-right"
                  onClick={() => handleSort("dailyEarnings")}
                  data-testid="header-earnings"
                >
                  <div className="flex items-center justify-end">
                    Daily Earnings
                    <SortIcon field="dailyEarnings" />
                  </div>
                </TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAndSortedFiles.map((file) => (
                <TableRow key={file.id} data-testid={`row-file-${file.id}`}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {file.fileName}
                      {file.replicaCount < 3 && (
                        <Badge variant="secondary" className="bg-purple-500/20 text-purple-400 text-[10px]">
                          {getRarityLevel(file.replicaCount)}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger>
                        <code className="text-xs bg-muted px-2 py-1 rounded font-mono">
                          {truncateCid(file.cid)}
                        </code>
                      </TooltipTrigger>
                      <TooltipContent className="font-mono text-xs">{file.cid}</TooltipContent>
                    </Tooltip>
                  </TableCell>
                  <TableCell className="text-right">{formatSize(file.size)}</TableCell>
                  <TableCell className="text-right">
                    <span className={cn(
                      "font-medium",
                      file.replicaCount <= 1 ? "text-red-500" :
                      file.replicaCount <= 2 ? "text-orange-500" :
                      file.replicaCount <= 3 ? "text-yellow-500" :
                      "text-muted-foreground"
                    )}>
                      {file.replicaCount}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge 
                      variant="outline" 
                      className={cn(
                        file.rarityMultiplier >= 2.0 ? "border-purple-500 text-purple-500" :
                        file.rarityMultiplier >= 1.25 ? "border-yellow-500 text-yellow-500" :
                        "border-muted-foreground text-muted-foreground"
                      )}
                    >
                      {file.rarityMultiplier.toFixed(2)}x
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className={cn(
                      "font-medium",
                      file.roiScore >= 80 ? "text-green-500" :
                      file.roiScore >= 60 ? "text-yellow-500" :
                      "text-muted-foreground"
                    )}>
                      {file.roiScore}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-bold text-green-500">
                    {file.dailyEarnings.toFixed(4)} HBD
                  </TableCell>
                  <TableCell className="text-right">
                    <Button 
                      size="sm" 
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => handlePinNow(file)}
                      data-testid={`button-table-pin-${file.id}`}
                    >
                      <Pin className="w-3 h-3 mr-1" />
                      Pin
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {filteredAndSortedFiles.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                    No files found matching your criteria
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
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
              The SPK Desktop Agent must be running to pin content to your local IPFS node and earn HBD rewards.
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
