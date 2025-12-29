import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Activity, HardDrive, Server, DollarSign, ArrowUpRight, ShieldCheck, Box, Search, PlayCircle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, connectWebSocket } from "@/lib/api";

const data = [
  { time: "00:00", proofs: 12 },
  { time: "04:00", proofs: 18 },
  { time: "08:00", proofs: 45 },
  { time: "12:00", proofs: 32 },
  { time: "16:00", proofs: 55 },
  { time: "20:00", proofs: 40 },
  { time: "24:00", proofs: 48 },
];

export default function Dashboard() {
  const [validations, setValidations] = useState<any[]>([]);
  
  // Fetch dashboard stats
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: api.getStats,
    refetchInterval: 5000, // Refresh every 5 seconds
  });

  // WebSocket for live validation feed
  useEffect(() => {
    const ws = connectWebSocket((data) => {
      if (data.type === "hive_event") {
        const event = data.data;
        
        // Only show PoA-related events
        if (event.type === "hbd_transfer" || event.type === "spk_reputation_slash") {
          const newVal = {
            id: Math.random().toString(36).substr(2, 9),
            validator: event.fromUser,
            cid: event.type === "hbd_transfer" ? "QmX7...9jK" : "QmY8...2mL",
            latency: Math.floor(Math.random() * 200) + 20 + "ms",
            status: event.type === "hbd_transfer" ? "Verified" : "Failed",
            time: "Just now"
          };
          setValidations(prev => [newVal, ...prev].slice(0, 5));
        }
      }
    });

    return () => ws.close();
  }, []);

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex justify-between items-end">
        <div>
          <h1 className="text-3xl font-display font-bold">Dashboard</h1>
          <p className="text-muted-foreground mt-1">Overview of your HivePoA Validator Node</p>
        </div>
        <div className="flex gap-2">
          <span className="px-3 py-1 bg-primary/10 text-primary text-xs rounded-full font-mono flex items-center gap-2 border border-primary/20">
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            NET: HIVE MAINNET
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatsCard 
          title="HBD Rewards" 
          value={stats?.rewards.totalHBD || "0.000"} 
          unit="HBD" 
          icon={DollarSign} 
          sub={`${stats?.rewards.transactions || 0} payouts`}
        />
        <StatsCard 
          title="Files Hosted" 
          value={stats?.files.total.toString() || "0"} 
          unit="Files" 
          icon={HardDrive} 
          sub={`${stats?.files.pinned || 0} pinned`}
        />
        <StatsCard 
          title="Validations (24h)" 
          value={stats?.challenges.total.toString() || "0"} 
          unit="Proofs" 
          icon={ShieldCheck} 
          trend={stats?.challenges.successRate ? `${stats.challenges.successRate}%` : "0%"}
          trendUp={true}
        />
        <StatsCard 
          title="Active Nodes" 
          value={stats?.nodes.active.toString() || "0"} 
          unit="Nodes" 
          icon={Server} 
          sub={`${stats?.validators.online || 0} validators online`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2 border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="font-display">Proof Activity</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data}>
                <defs>
                  <linearGradient id="colorProofs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <XAxis dataKey="time" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))' }}
                  itemStyle={{ color: 'hsl(var(--foreground))' }}
                />
                <Area type="monotone" dataKey="proofs" stroke="hsl(var(--primary))" fillOpacity={1} fill="url(#colorProofs)" />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Live Validation Feed */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="font-display flex items-center gap-2">
              <PlayCircle className="w-4 h-4 text-green-500 animate-pulse" />
              Live Validation Feed
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-hidden">
            <div className="space-y-3">
              <AnimatePresence>
                {validations.map((val) => (
                  <motion.div 
                    key={val.id}
                    initial={{ opacity: 0, height: 0, y: -20 }}
                    animate={{ opacity: 1, height: 'auto', y: 0 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center justify-between p-3 rounded-lg bg-background/50 border border-border/30 text-xs"
                  >
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "w-2 h-2 rounded-full",
                        val.status === "Verified" ? "bg-green-500 shadow-[0_0_8px_#22c55e]" : "bg-red-500"
                      )} />
                      <div>
                        <div className="font-bold flex items-center gap-2">
                           {val.validator}
                           <span className="text-[10px] text-muted-foreground font-normal">checked</span>
                           <span className="font-mono text-primary/80">{val.cid}</span>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                           Latency: {val.latency}
                        </div>
                      </div>
                    </div>
                    <Badge variant="outline" className={cn(
                      "text-[10px] px-1.5 py-0 h-5",
                      val.status === "Verified" ? "border-green-500/30 text-green-500" : "border-red-500/30 text-red-500"
                    )}>
                      {val.status}
                    </Badge>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatsCard({ title, value, unit, icon: Icon, trend, trendUp, sub }: any) {
  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm hover:border-primary/50 transition-colors group">
      <CardContent className="p-6">
        <div className="flex justify-between items-start mb-4">
          <div className="p-2 bg-primary/5 rounded-lg text-primary group-hover:bg-primary/10 transition-colors">
            <Icon className="w-5 h-5" />
          </div>
          {trend && (
            <div className={cn(
              "flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full",
              trendUp ? "text-green-500 bg-green-500/10" : "text-red-500 bg-red-500/10"
            )}>
              {trendUp && <ArrowUpRight className="w-3 h-3" />}
              {trend}
            </div>
          )}
        </div>
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <div className="flex items-baseline gap-1 mt-1">
            <h3 className="text-2xl font-bold font-display tracking-tight">{value}</h3>
            <span className="text-sm text-muted-foreground font-medium">{unit}</span>
          </div>
          {sub && <p className="text-xs text-muted-foreground mt-2">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
