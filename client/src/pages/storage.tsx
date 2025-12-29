import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Upload, File, Search, Copy, CheckCircle2, Clock, ShieldCheck, AlertCircle, Users } from "lucide-react";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export default function Storage() {
  const { toast } = useToast();
  const [isUploading, setIsUploading] = useState(false);

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

  const files = [
    { name: "project_specs_v2.pdf", cid: "QmX7...9jK", size: "2.4 MB", status: "Pinned", date: "2025-05-20", proofs: 142, lastProof: "2m ago", replication: 12, confidence: 98 },
    { name: "assets_bundle.zip", cid: "QmY8...2mL", size: "156 MB", status: "Pinned", date: "2025-05-19", proofs: 89, lastProof: "15m ago", replication: 8, confidence: 92 },
    { name: "intro_video.mp4", cid: "QmZ9...4nPx", size: "45 MB", status: "Syncing", date: "2025-05-19", proofs: 0, lastProof: "N/A", replication: 1, confidence: 0 },
    { name: "dataset_01.json", cid: "QmA1...5oQ", size: "12 KB", status: "Pinned", date: "2025-05-18", proofs: 450, lastProof: "5m ago", replication: 45, confidence: 99 },
    { name: "backup_log.txt", cid: "QmB2...6pR", size: "1.1 MB", status: "Pinned", date: "2025-05-18", proofs: 12, lastProof: "1h ago", replication: 4, confidence: 75 },
  ];

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold">Storage Management</h1>
          <p className="text-muted-foreground mt-1">Manage your IPFS pins and content proofs</p>
        </div>
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

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
          <CardTitle className="font-display text-lg">Pinned Content & Proofs</CardTitle>
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
                <TableHead>Network Health</TableHead>
                <TableHead>Proof Stats</TableHead>
                <TableHead className="text-right">Last Verified</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {files.map((file, i) => (
                <TableRow key={i} className="hover:bg-primary/5 border-border/50 group transition-colors">
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
                  <TableCell>
                    <div className="flex items-center gap-4">
                      <Tooltip>
                        <TooltipTrigger>
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-secondary/50 px-2 py-1 rounded">
                             <Users className="w-3 h-3" />
                             {file.replication} Nodes
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>Replication Count</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger>
                           <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-secondary/50 px-2 py-1 rounded">
                             <ShieldCheck className="w-3 h-3" />
                             {file.confidence}% Trust
                          </div>
                        </TooltipTrigger>
                        <TooltipContent>Validator Confidence Score</TooltipContent>
                      </Tooltip>
                    </div>
                  </TableCell>
                  <TableCell>
                    {file.status === "Pinned" ? (
                      <div className="flex items-center gap-2 text-xs">
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                        <span className="font-mono text-green-500">{file.proofs} Proofs</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                         <AlertCircle className="w-4 h-4" />
                         <span>Pending Sync</span>
                      </div>
                    )}
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
