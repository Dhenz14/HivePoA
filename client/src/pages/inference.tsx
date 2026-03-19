import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Brain, Zap, Send, Loader2, Globe, Cpu, Server } from "lucide-react";
import { getApiBase } from "@/lib/api-mode";

type InferenceMode = "medium" | "high_intel";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  mode?: string;
  model?: string;
  latencyMs?: number;
  tokensGenerated?: number;
}

export default function Inference() {
  const [mode, setMode] = useState<InferenceMode>("medium");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Get community tier info
  const { data: tierData } = useQuery({
    queryKey: ["/api/community/tier"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/community/tier`);
      return res.json();
    },
    refetchInterval: 30000,
  });

  // Get contribution stats
  const { data: contribStats } = useQuery({
    queryKey: ["/api/community/contributions/stats"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/community/contributions/stats`);
      return res.json();
    },
    refetchInterval: 10000,
  });

  // Send inference request
  const inferMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const res = await fetch(`${getApiBase()}/api/compute/inference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          mode,
          max_tokens: 2048,
          temperature: 0.7,
        }),
      });
      return res.json();
    },
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.text || data.error?.message || "No response",
          mode: data.strategy_used || mode,
          model: data.model_used || "unknown",
          latencyMs: data.latency_ms,
          tokensGenerated: data.tokens_generated,
        },
      ]);
    },
  });

  const handleSend = () => {
    if (!input.trim() || inferMutation.isPending) return;
    const prompt = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    inferMutation.mutate(prompt);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const tier = tierData?.tier || 1;
  const totalGpus = tierData?.totalGpus || 0;
  const hasCluster = totalGpus >= 2;

  return (
    <div className="flex flex-col h-full max-h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b">
        <div className="flex items-center gap-3">
          <Brain className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-xl font-bold">AI Inference</h1>
            <p className="text-sm text-muted-foreground">
              Spirit Bomb Community Cloud — Tier {tier}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={tier >= 2 ? "default" : "secondary"}>
            {totalGpus} GPUs
          </Badge>
          <Badge variant={hasCluster ? "default" : "outline"}>
            {hasCluster ? "Cluster Available" : "Local Only"}
          </Badge>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Chat area */}
        <div className="flex-1 flex flex-col">
          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                <Brain className="h-12 w-12 mb-4 opacity-50" />
                <p className="text-lg font-medium">Spirit Bomb AI</p>
                <p className="text-sm">
                  {mode === "medium"
                    ? "Local inference — private, free, offline-capable"
                    : "Cluster inference — more powerful, community GPU pool"}
                </p>
              </div>
            )}

            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-4 py-3 ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{msg.content}</p>
                  {msg.role === "assistant" && (
                    <div className="flex items-center gap-2 mt-2 text-xs opacity-70">
                      {msg.mode && (
                        <Badge variant="outline" className="text-xs">
                          {msg.mode === "local" ? <Cpu className="h-3 w-3 mr-1" /> : <Globe className="h-3 w-3 mr-1" />}
                          {msg.mode}
                        </Badge>
                      )}
                      {msg.latencyMs != null && (
                        <span>{Math.round(msg.latencyMs)}ms</span>
                      )}
                      {msg.tokensGenerated != null && (
                        <span>{msg.tokensGenerated} tokens</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {inferMutation.isPending && (
              <div className="flex justify-start">
                <div className="bg-muted rounded-lg px-4 py-3">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="border-t p-4">
            <div className="flex gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything..."
                className="resize-none min-h-[60px]"
                rows={2}
              />
              <Button
                onClick={handleSend}
                disabled={!input.trim() || inferMutation.isPending}
                size="icon"
                className="h-auto"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Sidebar — Mode selector + Stats */}
        <div className="w-72 border-l p-4 space-y-4 overflow-y-auto hidden lg:block">
          {/* Mode Selector */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Inference Mode</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <button
                onClick={() => setMode("medium")}
                className={`w-full text-left p-3 rounded-lg border-2 transition-colors ${
                  mode === "medium"
                    ? "border-primary bg-primary/5"
                    : "border-transparent hover:border-muted-foreground/20"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4" />
                  <span className="font-medium text-sm">Medium</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Local, free, private, offline
                </p>
              </button>

              <button
                onClick={() => setMode("high_intel")}
                disabled={!hasCluster}
                className={`w-full text-left p-3 rounded-lg border-2 transition-colors ${
                  mode === "high_intel"
                    ? "border-primary bg-primary/5"
                    : "border-transparent hover:border-muted-foreground/20"
                } ${!hasCluster ? "opacity-50 cursor-not-allowed" : ""}`}
              >
                <div className="flex items-center gap-2">
                  <Globe className="h-4 w-4" />
                  <span className="font-medium text-sm">High-Intel</span>
                  {!hasCluster && (
                    <Badge variant="outline" className="text-xs">
                      No cluster
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Cluster GPU pool, more powerful
                </p>
              </button>
            </CardContent>
          </Card>

          {/* Tier Info */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Community Tier</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tier</span>
                  <Badge>{tier}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">GPUs</span>
                  <span>{totalGpus}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Model</span>
                  <span className="text-xs">{tierData?.baseModel || "Qwen3-14B"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Experts</span>
                  <span>{tierData?.activeExperts || 2}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Contribution Stats */}
          {contribStats && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Contributions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tokens</span>
                    <span>{(contribStats.totalTokens || 0).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Requests</span>
                    <span>{(contribStats.totalRequests || 0).toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Contributors</span>
                    <span>{contribStats.activeContributors || 0}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">HBD Earned</span>
                    <span>{(contribStats.totalHbdEarned || 0).toFixed(3)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
