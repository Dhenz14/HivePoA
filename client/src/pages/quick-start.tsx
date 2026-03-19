import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Brain, Download, CheckCircle2, Loader2, Zap, ArrowRight, Cpu, Globe, Rocket } from "lucide-react";
import { Link } from "wouter";
import { detectDesktopAgent } from "@/lib/desktop-agent";
import { getApiBase } from "@/lib/api-mode";

type Step = "detect" | "configure" | "ready";

export default function QuickStart() {
  const [step, setStep] = useState<Step>("detect");
  const [agentDetected, setAgentDetected] = useState(false);
  const [detecting, setDetecting] = useState(true);
  const [hiveUsername, setHiveUsername] = useState("");
  const [configuring, setConfiguring] = useState(false);

  // Auto-detect desktop agent on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDetecting(true);
      try {
        const status = await detectDesktopAgent();
        if (!cancelled) {
          setAgentDetected(!!status?.running);
          if (status?.hiveUsername) {
            setHiveUsername(status.hiveUsername);
            setStep("ready"); // Already configured
          } else if (status?.running) {
            setStep("configure");
          }
        }
      } catch {
        if (!cancelled) setAgentDetected(false);
      } finally {
        if (!cancelled) setDetecting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Check community tier
  const { data: tierData } = useQuery({
    queryKey: ["/api/community/tier"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/community/tier`);
      return res.json();
    },
  });

  const handleConfigure = async () => {
    if (!hiveUsername.trim()) return;
    setConfiguring(true);
    try {
      // Try to configure desktop agent
      await fetch("http://127.0.0.1:5111/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiveUsername: hiveUsername.trim() }),
      });
      setStep("ready");
    } catch {
      // Agent might not support config yet — proceed anyway
      setStep("ready");
    } finally {
      setConfiguring(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-lg w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <div className="rounded-full bg-primary/10 p-4">
              <Rocket className="h-8 w-8 text-primary" />
            </div>
          </div>
          <h1 className="text-3xl font-bold">Spirit Bomb Quick Start</h1>
          <p className="text-muted-foreground">
            Join the community GPU cloud in 2 clicks
          </p>
        </div>

        {/* Progress */}
        <div className="flex items-center justify-center gap-2">
          {(["detect", "configure", "ready"] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                step === s ? "bg-primary text-primary-foreground" :
                (["detect", "configure", "ready"].indexOf(step) > i) ? "bg-primary/20 text-primary" :
                "bg-muted text-muted-foreground"
              }`}>
                {["detect", "configure", "ready"].indexOf(step) > i ? (
                  <CheckCircle2 className="h-4 w-4" />
                ) : (
                  i + 1
                )}
              </div>
              {i < 2 && <div className="w-8 h-0.5 bg-muted" />}
            </div>
          ))}
        </div>

        {/* Step 1: Detect */}
        {step === "detect" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Download className="h-5 w-5" />
                Step 1: Desktop Agent
              </CardTitle>
              <CardDescription>
                The desktop agent runs your local AI inference engine
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {detecting ? (
                <div className="flex items-center gap-3 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span>Detecting desktop agent...</span>
                </div>
              ) : agentDetected ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-green-600">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="font-medium">Desktop agent detected!</span>
                  </div>
                  <Button onClick={() => setStep("configure")} className="w-full">
                    Continue <ArrowRight className="h-4 w-4 ml-2" />
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    No desktop agent found. Download it to run local AI inference.
                  </p>
                  <Link href="/download">
                    <Button variant="outline" className="w-full">
                      <Download className="h-4 w-4 mr-2" />
                      Download Desktop Agent
                    </Button>
                  </Link>
                  <Button
                    variant="ghost"
                    className="w-full"
                    onClick={() => setStep("configure")}
                  >
                    Skip — use server mode instead
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Step 2: Configure */}
        {step === "configure" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Step 2: Connect Your Identity
              </CardTitle>
              <CardDescription>
                Link your Hive account to earn HBD rewards
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="hive-username">Hive Username</Label>
                <Input
                  id="hive-username"
                  value={hiveUsername}
                  onChange={(e) => setHiveUsername(e.target.value)}
                  placeholder="your-hive-username"
                  onKeyDown={(e) => e.key === "Enter" && handleConfigure()}
                />
                <p className="text-xs text-muted-foreground">
                  Your Hive account earns HBD for GPU contributions
                </p>
              </div>
              <Button
                onClick={handleConfigure}
                disabled={!hiveUsername.trim() || configuring}
                className="w-full"
              >
                {configuring ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Configuring...</>
                ) : (
                  <>Connect <ArrowRight className="h-4 w-4 ml-2" /></>
                )}
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => setStep("ready")}
              >
                Skip — try without account
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Ready */}
        {step === "ready" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                You're Ready!
              </CardTitle>
              <CardDescription>
                Choose how you want to use AI inference
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Mode cards */}
              <Link href="/inference">
                <div className="p-4 rounded-lg border-2 border-primary bg-primary/5 cursor-pointer hover:bg-primary/10 transition-colors">
                  <div className="flex items-center gap-3">
                    <Cpu className="h-6 w-6 text-primary" />
                    <div>
                      <p className="font-bold">Start Local Inference</p>
                      <p className="text-sm text-muted-foreground">
                        Free, private, works offline — runs on your GPU
                      </p>
                    </div>
                  </div>
                </div>
              </Link>

              <Link href="/community-cloud">
                <div className="p-4 rounded-lg border cursor-pointer hover:border-primary/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <Globe className="h-6 w-6 text-muted-foreground" />
                    <div>
                      <p className="font-bold">Explore Community Cloud</p>
                      <p className="text-sm text-muted-foreground">
                        See cluster stats, contribute GPU power, earn HBD
                      </p>
                    </div>
                  </div>
                </div>
              </Link>

              {/* Tier badge */}
              {tierData && (
                <div className="flex items-center justify-center gap-2 pt-2">
                  <Badge variant="outline">
                    Community Tier {tierData.tier || 1}
                  </Badge>
                  <Badge variant="outline">
                    {tierData.totalGpus || 0} GPUs online
                  </Badge>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
