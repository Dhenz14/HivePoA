import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Upload, File, Search, Copy, CheckCircle2, Clock, ShieldCheck, AlertCircle, Users, Coins, AlertTriangle, XCircle, Ban } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";

export default function Storage() {
  const { toast } = useToast();
  const [isUploading, setIsUploading] = useState(false);
  
  // Mock Reputation Score (0-100)
  const reputation = 82;

  const [files, setFiles] = useState([
    { id: 1, name: "project_specs_v2.pdf", cid: "QmX7...9jK", size: "2.4 MB", status: "Pinned", date: "2025-05-20", proofs: 142, fails: 0, lastProof: "2m ago", replication: 12, confidence: 98, poaEnabled: true },
    { id: 2, name: "assets_bundle.zip", cid: "QmY8...2mL", size: "156 MB", status: "Pinned", date: "2025-05-19", proofs: 89, fails: 1, lastProof: "15m ago", replication: 8, confidence: 92, poaEnabled: true },
    { id: 3, name: "intro_video.mp4", cid: "QmZ9...4nPx", size: "45 MB", status: "Syncing", date: "2025-05-19", proofs: 0, fails: 0, lastProof: "N/A", replication: 1, confidence: 0, poaEnabled: false },
    { id: 4, name: "dataset_01.json", cid: "QmA1...5oQ", size: "12 KB", status: "Pinned", date: "2025-05-18", proofs: 450, fails: 0, lastProof: "5m ago", replication: 45, confidence: 99, poaEnabled: true },
    { id: 5, name: "backup_log.txt", cid: "QmB2...6pR", size: "1.1 MB", status: "Warning", date: "2025-05-18", proofs: 12, fails: 5, lastProof: "1h ago", replication: 4, confidence: 45, poaEnabled: true },
  ]);

  const handleUpload = () => {
    setIsUploading(true);
    setTimeout(() => {
      setIsUploading(false);
      toast({
        title: "File Uploaded",
        description: "Content successfully pinned to IPFS and broadcasted to Hive.",
      });
    }, 1500);
  };

  const togglePoa = (id: number) => {
    setFiles(files.map(f => {
      if (f.id === id) {
        const newState = !f.poaEnabled;
        toast({
          title: newState ? "Rewards Enabled" : "Rewards Disabled",
          description: `PoA challenges ${newState ? "enabled" : "disabled"} for ${f.name}`,
        });
        return { ...f, poaEnabled: newState };
      }
      return f;
    }));
  };

  const toggleAll = (enabled: boolean) => {
    setFiles(files.map(f => ({ ...f, poaEnabled: enabled })));
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
          <Button onClick={handleUpload} disabled={isUploading} className="bg-primary hover:bg-primary/90 text-primary-foreground">
            {isUploading ? (
              <>
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin mr-2"/>
                Pinning...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4 mr-2" />
                Upload Content
              </>
            )}
          </Button>
        </div>
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
                    <div className="text-2xl font-bold font-display">1,240</div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Total Proofs</div>
                 </div>
                 <div className="text-center">
                    <div className="text-2xl font-bold font-display text-red-500">6</div>
                    <div className="text-xs text-muted-foreground uppercase tracking-wider mt-1">Failed Challenges</div>
                 </div>
                 <div className="text-center">
                    <div className="text-2xl font-bold font-display text-green-500">99.5%</div>
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
                        onCheckedChange={() => togglePoa(file.id)}
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
                       {file.status === "Warning" ? (
                         <Tooltip>
                           <TooltipTrigger>
                              <div className="flex items-center gap-1 text-xs text-red-500 bg-red-500/10 px-2 py-1 rounded font-medium">
                                <XCircle className="w-3 h-3" />
                                {file.fails} Fails
                              </div>
                           </TooltipTrigger>
                           <TooltipContent>High failure rate detected. Rewards paused.</TooltipContent>
                         </Tooltip>
                       ) : (
                         <div className="flex items-center gap-1 text-xs text-green-500 bg-green-500/10 px-2 py-1 rounded font-medium opacity-80">
                            <CheckCircle2 className="w-3 h-3" />
                            {file.proofs} OK
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

                  <TableCell className="text-right text-muted-foreground font-mono text-xs">{file.lastProof}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
