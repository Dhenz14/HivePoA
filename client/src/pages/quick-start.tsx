import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Brain, Download, CheckCircle2, Loader2, Zap, ArrowRight, Cpu, Globe, Rocket, ExternalLink, Gpu, MessageSquare, Coins, Play } from "lucide-react";
import { Link } from "wouter";
import { detectDesktopAgent } from "@/lib/desktop-agent";
import { detectGpuAgent, startGpuContribution } from "@/lib/gpu-agent";
import { getApiBase } from "@/lib/api-mode";

type Goal = "chat" | "contribute" | null;

export default function QuickStart() {
  const [goal, setGoal] = useState<Goal>(null);
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [gpuAgentOk, setGpuAgentOk] = useState<boolean | null>(null);
  const [gpuStarting, setGpuStarting] = useState(false);

  // Check if Ollama is running (chat path)
  useEffect(() => {
    if (goal === "chat") {
      fetch(`${getApiBase()}/api/compute/inference/modes`)
        .then(r => r.json())
        .then(data => setOllamaOk(data?.modes?.medium?.available ?? false))
        .catch(() => setOllamaOk(false));
    }
  }, [goal]);

  // Check if GPU agent is running (contribute path)
  useEffect(() => {
    if (goal === "contribute") {
      detectGpuAgent().then(setGpuAgentOk);
    }
  }, [goal]);

  // Check community stats
  const { data: tierData } = useQuery({
    queryKey: ["/api/community/tier"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/community/tier`);
      return res.json();
    },
  });

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-xl w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-3">
          <div className="flex justify-center">
            <div className="rounded-full bg-primary/10 p-4">
              <Rocket className="h-8 w-8 text-primary" />
            </div>
          </div>
          <h1 className="text-3xl font-bold">Welcome to Spirit Bomb</h1>
          <p className="text-muted-foreground max-w-md mx-auto">
            A community-powered AI that gets smarter as more people join.
            Use it for free, or share your GPU to help the community and earn rewards.
          </p>
        </div>

        {/* Goal selection */}
        {!goal && (
          <div className="space-y-3">
            <p className="text-center text-sm font-medium text-muted-foreground">
              What would you like to do?
            </p>

            <button
              type="button"
              onClick={() => setGoal("chat")}
              className="w-full text-left p-5 rounded-xl border-2 hover:border-primary transition-colors"
            >
              <div className="flex items-center gap-4">
                <div className="rounded-full bg-blue-100 dark:bg-blue-900/30 p-3">
                  <MessageSquare className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <p className="font-bold text-lg">Chat with AI</p>
                  <p className="text-sm text-muted-foreground">
                    Free, private, runs on your computer. No account needed.
                  </p>
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setGoal("contribute")}
              className="w-full text-left p-5 rounded-xl border-2 hover:border-primary transition-colors"
            >
              <div className="flex items-center gap-4">
                <div className="rounded-full bg-green-100 dark:bg-green-900/30 p-3">
                  <Coins className="h-6 w-6 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="font-bold text-lg">Share my GPU & earn rewards</p>
                  <p className="text-sm text-muted-foreground">
                    Donate spare GPU power to the community. Earn HBD cryptocurrency in return.
                  </p>
                </div>
              </div>
            </button>
          </div>
        )}

        {/* GOAL: Chat with AI */}
        {goal === "chat" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MessageSquare className="h-5 w-5" />
                Set Up AI Chat
              </CardTitle>
              <CardDescription>
                You need one thing: <strong>Ollama</strong> — a free app that runs AI models on your computer.
                Your data stays private. Nothing is sent online.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Ollama status */}
              {ollamaOk === null ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Checking...
                </div>
              ) : ollamaOk ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="font-medium">Ollama is running — you're all set!</span>
                  </div>
                  <Link href="/inference">
                    <Button className="w-full" size="lg">
                      Start chatting <ArrowRight className="h-4 w-4 ml-2" />
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="p-4 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
                    <p className="font-medium text-amber-800 dark:text-amber-200 mb-2">
                      Ollama not detected
                    </p>
                    <ol className="text-sm text-amber-700 dark:text-amber-300 space-y-1 list-decimal list-inside">
                      <li>Download Ollama from the link below (it's free)</li>
                      <li>Install and run it — it starts automatically</li>
                      <li>Come back here and click "Check again"</li>
                    </ol>
                  </div>
                  <div className="flex gap-2">
                    <a href="https://ollama.ai" target="_blank" rel="noopener noreferrer" className="flex-1">
                      <Button variant="outline" className="w-full gap-1">
                        <Download className="h-4 w-4" /> Download Ollama
                        <ExternalLink className="h-3 w-3" />
                      </Button>
                    </a>
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setOllamaOk(null);
                        fetch(`${getApiBase()}/api/compute/inference/modes`)
                          .then(r => r.json())
                          .then(data => setOllamaOk(data?.modes?.medium?.available ?? false))
                          .catch(() => setOllamaOk(false));
                      }}
                    >
                      Check again
                    </Button>
                  </div>
                </div>
              )}

              <Button variant="ghost" size="sm" onClick={() => setGoal(null)} className="w-full">
                Back
              </Button>
            </CardContent>
          </Card>
        )}

        {/* GOAL: Share GPU */}
        {goal === "contribute" && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Coins className="h-5 w-5" />
                Contribute My GPU
              </CardTitle>
              <CardDescription>
                Your graphics card powers AI for the whole community.
                Earn <strong>HBD</strong> (Hive-Backed Dollars, pegged to $1 USD) in return.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Auto-detect GPU agent */}
              {gpuAgentOk === null && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Detecting GPU agent...
                </div>
              )}

              {gpuAgentOk === true && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                    <CheckCircle2 className="h-5 w-5" />
                    <span className="font-medium">Desktop Agent detected — ready to contribute!</span>
                  </div>
                  <Button
                    className="w-full gap-2"
                    size="lg"
                    disabled={gpuStarting}
                    onClick={async () => {
                      setGpuStarting(true);
                      await startGpuContribution({ mode: "pool" });
                      setGpuStarting(false);
                      window.location.href = "/gpu-dashboard";
                    }}
                  >
                    {gpuStarting ? (
                      <><Loader2 className="h-5 w-5 animate-spin" /> Starting GPU...</>
                    ) : (
                      <><Play className="h-5 w-5" /> Start Contributing</>
                    )}
                  </Button>
                  <Link href="/gpu-dashboard">
                    <Button variant="outline" className="w-full gap-1">
                      GPU Dashboard <ArrowRight className="h-4 w-4" />
                    </Button>
                  </Link>
                </div>
              )}

              {gpuAgentOk === false && (
                <div className="space-y-4">
                  <div className="space-y-3">
                    <h4 className="font-medium">Get started in 3 steps:</h4>
                    <ol className="text-sm space-y-2 list-decimal list-inside text-muted-foreground">
                      <li>
                        <strong className="text-foreground">Download Spirit Bomb</strong>
                        {" "}— one-click installer for your OS
                      </li>
                      <li>
                        <strong className="text-foreground">Create a Hive account</strong>
                        {" "}— free blockchain account for receiving rewards
                      </li>
                      <li>
                        <strong className="text-foreground">Click "Start Contributing"</strong>
                        {" "}— your GPU earns HBD automatically
                      </li>
                    </ol>
                  </div>

                  <div className="p-3 rounded-lg bg-muted text-sm">
                    <p className="font-medium mb-1">Requirements:</p>
                    <ul className="space-y-1 text-muted-foreground">
                      <li>NVIDIA GPU with 8+ GB VRAM (or AMD/Intel/Apple Silicon)</li>
                      <li>A Hive blockchain account (free to create)</li>
                    </ul>
                  </div>

                  <div className="flex gap-2">
                    <Link href="/download" className="flex-1">
                      <Button className="w-full gap-1">
                        <Download className="h-4 w-4" /> Download Spirit Bomb
                      </Button>
                    </Link>
                    <a href="https://signup.hive.io" target="_blank" rel="noopener noreferrer" className="flex-1">
                      <Button variant="outline" className="w-full gap-1">
                        Create Hive Account <ExternalLink className="h-3 w-3" />
                      </Button>
                    </a>
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setGpuAgentOk(null);
                      detectGpuAgent().then(setGpuAgentOk);
                    }}
                  >
                    Check again
                  </Button>
                </div>
              )}

              <div className="flex gap-2">
                <Link href="/community-cloud" className="flex-1">
                  <Button variant="ghost" size="sm" className="w-full">
                    Community Dashboard <ArrowRight className="h-4 w-4 ml-1" />
                  </Button>
                </Link>
              </div>

              <Button variant="ghost" size="sm" onClick={() => setGoal(null)} className="w-full">
                Back
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Community stats footer */}
        {tierData && (
          <div className="text-center text-xs text-muted-foreground space-y-1">
            <p>
              Community: {tierData.totalGpus || 0} GPUs sharing
              {" · "}Tier {tierData.tier || 1}
              {" · "}Model: {tierData.baseModel || "Qwen3-14B"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
