import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Activity, HardDrive, Server, DollarSign, ArrowUpRight, ShieldCheck, Key } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, connectWebSocket } from "@/lib/api";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";
import { Link } from "wouter";

const data = [
  { time: "00:00", proofs: 12 },
  { time: "04:00", proofs: 18 },
  { time: "08:00", proofs: 45 },
  { time: "12:00", proofs: 32 },
  { time: "16:00", proofs: 55 },
  { time: "20:00", proofs: 40 },
  { time: "24:00", proofs: 48 },
];

const statCardAccents = [
  "from-yellow-500 to-orange-500",
  "from-blue-500 to-cyan-500",
  "from-green-500 to-emerald-500",
  "from-purple-500 to-pink-500",
];

export default function Dashboard() {
  const [validations, setValidations] = useState<any[]>([]);
  const { isAuthenticated } = useValidatorAuth();

  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: api.getStats,
    refetchInterval: 5000,
  });

  useEffect(() => {
    const ws = connectWebSocket((data) => {
      if (data.type === "hive_event") {
        const event = data.data;
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
      {/* Hero Header */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
        className="flex justify-between items-end"
      >
        <div>
          <h1 className="text-4xl font-display font-bold text-gradient-hero">
            HivePoA
          </h1>
          <p className="text-muted-foreground mt-2 text-base">
            Decentralized Proof of Access — Securing the Future of Storage
          </p>
        </div>
        <div className="flex gap-3 items-center">
          <span className="px-4 py-1.5 bg-primary/10 text-primary text-xs rounded-full font-mono flex items-center gap-2 border border-primary/20 glow-red">
            <span className="relative w-1.5 h-1.5 rounded-full bg-primary">
              <span className="absolute inset-0 rounded-full bg-primary animate-ping opacity-75" />
            </span>
            HIVE MAINNET
          </span>
        </div>
      </motion.div>

      {/* Login CTA */}
      {!isAuthenticated && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <Card className="border-primary/20 bg-primary/5 hover:glow-red transition-all duration-500">
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-6 flex-wrap">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-xl bg-primary/15 text-primary">
                    <Key className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-base">Login with Hive Keychain</h3>
                    <p className="text-sm text-muted-foreground mt-0.5">
                      Sign in to validate storage proofs and earn HBD rewards
                    </p>
                  </div>
                </div>
                <Link href="/validator-login">
                  <Button size="lg" className="font-semibold">
                    <Key className="mr-2 h-4 w-4" />
                    Login with Keychain
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: "HBD Rewards", value: stats?.rewards?.totalHBD || "0.000", unit: "HBD", icon: DollarSign, sub: `${stats?.rewards?.transactions || 0} payouts` },
          { title: "Files Hosted", value: stats?.files?.total?.toString() || "0", unit: "Files", icon: HardDrive, sub: `${stats?.files?.pinned || 0} pinned` },
          { title: "Validations (24h)", value: stats?.challenges?.total?.toString() || "0", unit: "Proofs", icon: ShieldCheck, trend: stats?.challenges?.successRate ? `${stats.challenges.successRate}%` : "0%", trendUp: true },
          { title: "Active Nodes", value: stats?.nodes?.active?.toString() || "0", unit: "Nodes", icon: Server, sub: `${stats?.validators?.online || 0} validators online` },
        ].map((stat, i) => (
          <motion.div
            key={stat.title}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.08, duration: 0.5 }}
          >
            <StatsCard {...stat} accent={statCardAccents[i]} />
          </motion.div>
        ))}
      </div>

      {/* Chart + Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.5 }}
          className="lg:col-span-2"
        >
          <Card className="glass">
            <CardHeader>
              <CardTitle className="font-display flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" />
                Proof Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data}>
                  <defs>
                    <linearGradient id="colorProofs" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(350, 83%, 55%)" stopOpacity={0.4}/>
                      <stop offset="50%" stopColor="hsl(350, 83%, 55%)" stopOpacity={0.1}/>
                      <stop offset="95%" stopColor="hsl(350, 83%, 55%)" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" stroke="hsl(240, 5%, 40%)" fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis stroke="hsl(240, 5%, 40%)" fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(220, 15%, 11%)',
                      borderColor: 'hsl(220, 15%, 22%)',
                      borderRadius: '12px',
                      boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                    }}
                    itemStyle={{ color: 'hsl(0, 0%, 98%)' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="proofs"
                    stroke="hsl(350, 83%, 55%)"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorProofs)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </motion.div>

        {/* Live Validation Feed */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.6, duration: 0.5 }}
        >
          <Card className="glass flex flex-col h-full">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="font-display flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                </span>
                Live Feed
              </CardTitle>
              <Badge variant="outline" className="text-[10px] border-red-500/30 text-red-400 font-mono">
                LIVE
              </Badge>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden">
              <div className="space-y-2.5">
                <AnimatePresence>
                  {validations.map((val) => (
                    <motion.div
                      key={val.id}
                      initial={{ opacity: 0, height: 0, y: -10 }}
                      animate={{ opacity: 1, height: 'auto', y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="flex items-center justify-between p-2.5 rounded-lg bg-white/2 border border-white/4 text-xs"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className={cn(
                          "w-2 h-2 rounded-full shrink-0",
                          val.status === "Verified"
                            ? "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                            : "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)]"
                        )} />
                        <div>
                          <div className="font-semibold flex items-center gap-1.5">
                            {val.validator}
                            <span className="font-mono text-primary/70 text-[10px]">{val.cid}</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {val.latency}
                          </div>
                        </div>
                      </div>
                      <Badge variant="outline" className={cn(
                        "text-[9px] px-1.5 py-0 h-4",
                        val.status === "Verified" ? "border-green-500/30 text-green-500" : "border-red-500/30 text-red-500"
                      )}>
                        {val.status}
                      </Badge>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {validations.length === 0 && (
                  <div className="text-center text-muted-foreground/50 text-xs py-8">
                    Waiting for validations...
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}

function StatsCard({ title, value, unit, icon: Icon, trend, trendUp, sub, accent }: any) {
  return (
    <Card className="group relative overflow-hidden hover:-translate-y-0.5 transition-all duration-300">
      <div className={cn("absolute left-0 top-0 bottom-0 w-1 bg-linear-to-b", accent)} />
      <CardContent className="p-5 pl-6">
        <div className="flex justify-between items-start mb-3">
          <div className="p-2 rounded-lg bg-white/5 transition-colors group-hover:bg-white/8">
            <Icon className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors" />
          </div>
          {trend && (
            <div className={cn(
              "flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full",
              trendUp ? "text-green-400 bg-green-500/10" : "text-red-400 bg-red-500/10"
            )}>
              {trendUp && <ArrowUpRight className="w-3 h-3" />}
              {trend}
            </div>
          )}
        </div>
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <div className="flex items-baseline gap-1.5 mt-1">
          <h3 className="text-2xl font-bold font-display tracking-tight">{value}</h3>
          <span className="text-xs text-muted-foreground font-medium">{unit}</span>
        </div>
        {sub && <p className="text-[11px] text-muted-foreground/70 mt-1.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}
