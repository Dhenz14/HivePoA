import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Activity, HardDrive, Server, DollarSign, ArrowUpRight, ShieldCheck, Box } from "lucide-react";
import { motion } from "framer-motion";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";

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
          title="HBD Balance" 
          value="452.30" 
          unit="HBD" 
          icon={DollarSign} 
          trend="+12.5%"
          trendUp={true}
        />
        <StatsCard 
          title="Storage Used" 
          value="85.2" 
          unit="GB" 
          icon={HardDrive} 
          sub="Cap: 1000 GB"
        />
        <StatsCard 
          title="Validations (24h)" 
          value="1,240" 
          unit="Proofs" 
          icon={ShieldCheck} 
          trend="+5.2%"
          trendUp={true}
        />
        <StatsCard 
          title="Active Peers" 
          value="14" 
          unit="Nodes" 
          icon={Server} 
          sub="Swarm Health: Good"
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

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm flex flex-col">
          <CardHeader>
            <CardTitle className="font-display">Recent Logs</CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-hidden">
            <div className="space-y-4 font-mono text-xs">
              {[
                { time: "10:42:05", type: "INFO", msg: "Received challenge for CID: QmX7...9jK" },
                { time: "10:42:02", type: "SUCCESS", msg: "Proof submitted. Hash: 0x8f...2a" },
                { time: "10:41:45", type: "INFO", msg: "Syncing Trole gateway..." },
                { time: "10:41:12", type: "INFO", msg: "Peer connected: 12D3...8kL" },
                { time: "10:40:55", type: "WARN", msg: "High latency on peer 12D3...8kL" },
                { time: "10:40:01", type: "SUCCESS", msg: "HBD Reward received: 0.050 HBD" },
              ].map((log, i) => (
                <div key={i} className="flex gap-2 items-start opacity-80 hover:opacity-100 transition-opacity">
                  <span className="text-muted-foreground">{log.time}</span>
                  <span className={cn(
                    "font-bold",
                    log.type === "INFO" && "text-blue-400",
                    log.type === "SUCCESS" && "text-green-400",
                    log.type === "WARN" && "text-yellow-400",
                  )}>{log.type}</span>
                  <span className="text-foreground/80 truncate">{log.msg}</span>
                </div>
              ))}
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
