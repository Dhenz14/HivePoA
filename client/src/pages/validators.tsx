import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Search, Globe, Shield, Activity, Signal, BarChart3 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export default function Validators() {
  const { toast } = useToast();

  // "Job Allocation" represents the % of network storage jobs this validator is handling
  // This is directly correlated to their Rank/Performance.
  const validators = [
    { rank: 1, name: "threespeak", hiveRank: 5, status: "Online", peers: 124, payout: "1.00 HBD", version: "v0.1.0", performance: 98, trusted: true, jobAllocation: 95 },
    { rank: 2, name: "arcange", hiveRank: 45, status: "Online", peers: 256, payout: "1.00 HBD", version: "v0.1.0", performance: 96, trusted: true, jobAllocation: 88 },
    { rank: 3, name: "hive-kings", hiveRank: 12, status: "Online", peers: 89, payout: "0.95 HBD", version: "v0.1.0", performance: 92, trusted: true, jobAllocation: 75 },
    { rank: 4, name: "pizza-witness", hiveRank: 88, status: "Syncing", peers: 12, payout: "0.90 HBD", version: "v0.0.9", performance: 78, trusted: false, jobAllocation: 25 },
    { rank: 5, name: "smaller-guy", hiveRank: 142, status: "Offline", peers: 0, payout: "1.00 HBD", version: "v0.1.0", performance: 45, trusted: false, jobAllocation: 0 },
  ];

  const handleConnect = (name: string) => {
    toast({
      title: "Connection Request Sent",
      description: `Attempting to peer with validator @${name}...`,
    });
  };

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Network Validators</h1>
          <p className="text-muted-foreground mt-1">
            Validators are assigned jobs based on their global rank. 
            Higher performance = More jobs allocated by the protocol.
          </p>
        </div>
        
        <div className="flex gap-2">
           <Badge variant="outline" className="px-3 py-1 border-green-500/30 bg-green-500/10 text-green-500 flex gap-2">
             <Signal className="w-3 h-3" />
             Network Healthy
           </Badge>
           <Badge variant="outline" className="px-3 py-1 border-primary/30 bg-primary/10 text-primary flex gap-2">
             <Activity className="w-3 h-3" />
             14 Active Validators
           </Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Validator List */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
              <CardTitle>Global Validator Rankings</CardTitle>
              <div className="flex gap-2">
                <div className="relative w-64">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input placeholder="Search witness..." className="pl-8" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {validators.map((val) => (
                  <div key={val.rank} className={cn(
                      "flex items-center justify-between p-4 rounded-lg bg-card border border-border/50 transition-all group",
                      val.trusted ? "hover:border-primary/30" : "opacity-80 grayscale-[0.5] hover:grayscale-0 hover:opacity-100"
                    )}>
                    <div className="flex items-center gap-4">
                      <div className="flex flex-col items-center gap-1 w-12">
                         <div className={cn(
                            "font-mono text-xs text-muted-foreground rounded py-1 px-2",
                            val.rank <= 3 ? "bg-yellow-500/10 text-yellow-500 font-bold border border-yellow-500/20" : "bg-muted/50"
                           )}>
                           #{val.rank}
                         </div>
                      </div>
                      
                      <Avatar>
                        <AvatarImage src={`https://images.hive.blog/u/${val.name}/avatar`} />
                        <AvatarFallback>{val.name.substring(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div>
                        <h4 className="font-bold flex items-center gap-2">
                          @{val.name}
                          {val.trusted && (
                            <Badge variant="secondary" className="h-5 text-[10px] px-1 bg-blue-500/10 text-blue-500 border-blue-500/20">
                             Trusted
                            </Badge>
                          )}
                        </h4>
                        <div className="flex gap-4 text-xs text-muted-foreground mt-1 font-mono">
                          <span className="flex items-center gap-1">v{val.version}</span>
                          <span className="flex items-center gap-1">• {val.peers} Peers</span>
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-8">
                      {/* Job Allocation Metric */}
                      <div className="text-right hidden sm:block w-32">
                         <div className="text-xs text-muted-foreground mb-1 flex items-center justify-end gap-1">
                           <BarChart3 className="w-3 h-3" /> Job Allocation
                         </div>
                         <div className="flex items-center gap-2 justify-end">
                            <span className="font-mono font-bold text-sm">{val.jobAllocation}%</span>
                         </div>
                         <Progress value={val.jobAllocation} className="h-1.5 mt-1 bg-secondary" indicatorClassName="bg-primary"/>
                      </div>

                      <div className="text-right hidden sm:block w-20">
                         <div className="text-xs text-muted-foreground mb-1">Payout</div>
                         <div className="font-mono font-medium">{val.payout}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar Info */}
        <div className="space-y-6">
          <Card className="border-border/50 bg-primary/5">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Shield className="w-5 h-5 text-primary" />
                Rank-Based Allocation
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>
                The HivePoA protocol automatically assigns more audit jobs to high-ranking validators.
              </p>
              <ul className="space-y-3 list-disc pl-4">
                <li>
                  <span className="text-foreground font-medium">Rank #1-50</span>: Receive 90% of network traffic and audit jobs.
                </li>
                <li>
                  <span className="text-foreground font-medium">Bad Actors</span>: Validators who fail to pay or have low uptime drop in rank and receive fewer jobs.
                </li>
                <li>
                  <span className="text-foreground font-medium">No User Filtering</span>: Users cannot manually block validators. The protocol handles quality control globally.
                </li>
              </ul>
            </CardContent>
          </Card>

           <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Network Metrics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                 <div className="flex justify-between text-xs">
                  <span>Job Distribution Efficiency</span>
                  <span className="font-bold text-green-500">98.2%</span>
                </div>
                <Progress value={98} className="h-2" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
