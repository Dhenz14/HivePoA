import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Search, Vote, Lock, Users, ShieldCheck, TrendingUp } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";

export default function Governance() {
  const { toast } = useToast();
  const [votingPower] = useState(4500); // Mock HBD Savings balance

  const validators = [
    { rank: 1, name: "hive-kings", votes: "1.2M HBD", status: "Active", uptime: "99.9%", selfStaked: "50k HBD" },
    { rank: 2, name: "threespeak", votes: "980k HBD", status: "Active", uptime: "99.8%", selfStaked: "100k HBD" },
    { rank: 3, name: "trole-master", votes: "850k HBD", status: "Active", uptime: "99.5%", selfStaked: "25k HBD" },
    { rank: 4, name: "ipfs-guardian", votes: "620k HBD", status: "Active", uptime: "98.2%", selfStaked: "10k HBD" },
    { rank: 5, name: "data-hoarder", votes: "410k HBD", status: "Warning", uptime: "92.1%", selfStaked: "5k HBD" },
  ];

  const handleVote = (name: string) => {
    toast({
      title: "Vote Broadcasted",
      description: `You have successfully voted for witness @${name} using ${votingPower} HBD Power.`,
    });
  };

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Governance</h1>
          <p className="text-muted-foreground mt-1">Vote for validators using your HBD Savings balance</p>
        </div>
        
        <Card className="bg-primary/5 border-primary/20 min-w-[300px]">
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-3 bg-primary/20 rounded-full">
              <Lock className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase font-bold tracking-wider">Your Voting Power</p>
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold font-display">{votingPower.toLocaleString()}</span>
                <span className="text-xs font-medium text-primary">HBD (Savings)</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Validator List */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
              <CardTitle>Top Validators</CardTitle>
              <div className="relative w-64">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search validators..." className="pl-8" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {validators.map((val) => (
                  <div key={val.rank} className="flex items-center justify-between p-4 rounded-lg bg-card border border-border/50 hover:border-primary/30 transition-all group">
                    <div className="flex items-center gap-4">
                      <div className="font-display font-bold text-muted-foreground w-6 text-center">{val.rank}</div>
                      <Avatar>
                        <AvatarImage src={`https://images.hive.blog/u/${val.name}/avatar`} />
                        <AvatarFallback>{val.name.substring(0, 2).toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div>
                        <h4 className="font-bold flex items-center gap-2">
                          @{val.name}
                          {val.status === "Warning" && <Badge variant="destructive" className="h-5 text-[10px]">Warning</Badge>}
                        </h4>
                        <div className="flex gap-4 text-xs text-muted-foreground mt-1">
                          <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {val.votes} Votes</span>
                          <span className="flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> {val.selfStaked} Staked</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-6">
                      <div className="text-right hidden sm:block">
                        <div className="text-xs text-muted-foreground mb-1">Uptime</div>
                        <div className={`font-mono font-medium ${val.status === "Warning" ? "text-red-500" : "text-green-500"}`}>
                          {val.uptime}
                        </div>
                      </div>
                      <Button size="sm" variant="outline" className="group-hover:bg-primary group-hover:text-primary-foreground transition-colors" onClick={() => handleVote(val.name)}>
                        <Vote className="w-4 h-4 mr-2" />
                        Vote
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Sidebar Info */}
        <div className="space-y-6">
          <Card className="border-border/50 bg-gradient-to-b from-card/50 to-primary/5">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-primary" />
                How it works
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>
                In this decentralized model, <b>HBD Savings</b> represents your voting stake.
              </p>
              <ul className="space-y-3 list-disc pl-4">
                <li>
                  <span className="text-foreground font-medium">1 HBD in Savings = 1 Vote Power.</span>
                </li>
                <li>
                  Validators are elected to run the Proof of Access challenges.
                </li>
                <li>
                  Validators distribute rewards from the network treasury to reliable storage nodes.
                </li>
              </ul>
              <Button className="w-full mt-4" variant="secondary">
                Put HBD in Savings
              </Button>
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Network Health</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span>Consensus Participation</span>
                  <span className="font-bold">84%</span>
                </div>
                <Progress value={84} className="h-2" />
              </div>
              <div className="space-y-2">
                 <div className="flex justify-between text-xs">
                  <span>Treasury Utilization</span>
                  <span className="font-bold">12%</span>
                </div>
                <Progress value={12} className="h-2" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
