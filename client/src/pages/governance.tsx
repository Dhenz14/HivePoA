import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Search, Users, ShieldCheck, TrendingUp, AlertTriangle, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { getApiBase } from "@/lib/api-mode";

interface Validator {
  id: string;
  username: string;
  status: string;
  totalChallenges: number;
  successfulChallenges: number;
  failedChallenges: number;
  reputation: number;
  lastActive: string | null;
}

export default function Governance() {
  const [search, setSearch] = useState("");
  const apiBase = getApiBase();

  const { data: validators, isLoading, error } = useQuery<Validator[]>({
    queryKey: ["governance-validators"],
    queryFn: async () => {
      const res = await fetch(`${apiBase}/api/validators`);
      if (!res.ok) throw new Error("Failed to fetch validators");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const { data: treasuryStatus } = useQuery<{ signerCount: number; threshold: number; balance?: string; operational: boolean }>({
    queryKey: ["governance-treasury"],
    queryFn: () => fetch(`${apiBase}/api/treasury/status`).then((r) => r.json()),
    refetchInterval: 30000,
  });

  const filteredValidators = useMemo(() => {
    if (!validators) return [];
    const sorted = [...validators].sort((a, b) => b.reputation - a.reputation);
    if (!search.trim()) return sorted;
    return sorted.filter((v) => v.username.toLowerCase().includes(search.toLowerCase()));
  }, [validators, search]);

  const totalChallenges = validators?.reduce((s, v) => s + v.totalChallenges, 0) || 0;
  const avgSuccess = validators && validators.length > 0
    ? Math.round(validators.reduce((s, v) => s + (v.totalChallenges > 0 ? (v.successfulChallenges / v.totalChallenges) * 100 : 0), 0) / validators.length)
    : 0;

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
        <div>
          <h1 className="text-3xl font-display font-bold">Governance</h1>
          <p className="text-muted-foreground mt-1">Validator rankings and network health</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Validator List */}
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
              <CardTitle>Validators ({filteredValidators.length})</CardTitle>
              <div className="relative w-64">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input placeholder="Search validators..." className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : error ? (
                <div className="flex flex-col items-center py-12 text-center">
                  <AlertTriangle className="h-8 w-8 text-destructive mb-2" />
                  <p className="text-sm text-muted-foreground">Failed to load validators. Is the backend running?</p>
                </div>
              ) : filteredValidators.length === 0 ? (
                <p className="text-center py-8 text-muted-foreground">No validators found</p>
              ) : (
                <div className="space-y-4">
                  {filteredValidators.map((val, i) => {
                    const successRate = val.totalChallenges > 0
                      ? ((val.successfulChallenges / val.totalChallenges) * 100).toFixed(1)
                      : "0.0";
                    return (
                      <div key={val.id} className="flex items-center justify-between p-4 rounded-lg bg-card border border-border/50 hover:border-primary/30 transition-all group">
                        <div className="flex items-center gap-4">
                          <div className="font-display font-bold text-muted-foreground w-6 text-center">{i + 1}</div>
                          <Avatar>
                            <AvatarImage src={`https://images.hive.blog/u/${val.username}/avatar`} />
                            <AvatarFallback>{val.username.substring(0, 2).toUpperCase()}</AvatarFallback>
                          </Avatar>
                          <div>
                            <h4 className="font-bold flex items-center gap-2">
                              @{val.username}
                              {val.status !== "active" && <Badge variant="destructive" className="h-5 text-[10px]">{val.status}</Badge>}
                            </h4>
                            <div className="flex gap-4 text-xs text-muted-foreground mt-1">
                              <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {val.totalChallenges} challenges</span>
                              <span className="flex items-center gap-1"><ShieldCheck className="w-3 h-3" /> Rep: {val.reputation}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-6">
                          <div className="text-right hidden sm:block">
                            <div className="text-xs text-muted-foreground mb-1">Success Rate</div>
                            <div className={`font-mono font-medium ${parseFloat(successRate) >= 95 ? "text-green-500" : parseFloat(successRate) >= 80 ? "text-yellow-500" : "text-red-500"}`}>
                              {successRate}%
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar Info */}
        <div className="space-y-6">
          <Card className="border-border/50 bg-gradient-to-b from-card/50 to-primary/5">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-primary" />
                Network Stats
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Validators</span>
                <span className="font-bold">{validators?.length || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total Challenges</span>
                <span className="font-bold">{totalChallenges.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Avg Success Rate</span>
                <span className="font-bold">{avgSuccess}%</span>
              </div>
              {treasuryStatus && (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Treasury Signers</span>
                    <span className="font-bold">{treasuryStatus.signerCount}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Treasury Balance</span>
                    <span className="font-bold">{treasuryStatus.balance || "N/A"}</span>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="border-border/50">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Network Health</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span>Avg Success Rate</span>
                  <span className="font-bold">{avgSuccess}%</span>
                </div>
                <Progress value={avgSuccess} className="h-2" />
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span>Treasury Operational</span>
                  <span className="font-bold">{treasuryStatus?.operational ? "Yes" : "No"}</span>
                </div>
                <Progress value={treasuryStatus?.operational ? 100 : 0} className="h-2" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
