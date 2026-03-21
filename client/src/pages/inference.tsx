import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Brain, Send, Loader2, Globe, Cpu, Users, AlertCircle, Download, ExternalLink } from "lucide-react";
import { Link } from "wouter";
import { getApiBase } from "@/lib/api-mode";

type InferenceMode = "medium" | "pool" | "high_intel";

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  mode?: string;
  model?: string;
  latencyMs?: number;
  tokensGenerated?: number;
  routedTo?: string;
  isError?: boolean;
}

export default function Inference() {
  const [mode, setMode] = useState<InferenceMode>("medium");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Check which backends are available
  const { data: modes } = useQuery({
    queryKey: ["/api/compute/inference/modes"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/compute/inference/modes`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 15000,
  });

  // Get community tier
  const { data: tierData } = useQuery({
    queryKey: ["/api/community/tier"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/community/tier`);
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 30000,
  });

  const ollamaReady = modes?.modes?.medium?.available ?? false;
  const poolReady = modes?.modes?.pool?.available ?? false;
  const poolNodes = modes?.modes?.pool?.healthyNodes ?? 0;
  const clusterReady = modes?.modes?.high_intel?.available ?? false;
  const anyBackend = ollamaReady || poolReady || clusterReady;

  // Send inference request
  const inferMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const res = await fetch(`${getApiBase()}/api/compute/inference`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, mode, max_tokens: 2048, temperature: 0.7 }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error?.message || data.error || "Request failed");
      }
      return data;
    },
    onSuccess: (data) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.text || "No response received.",
          mode: data.strategy_used || mode,
          model: data.model_used,
          latencyMs: data.latency_ms,
          tokensGenerated: data.tokens_generated,
          routedTo: data.routed_to,
        },
      ]);
    },
    onError: (error: Error) => {
      // Show error as a system message AND a toast
      setMessages((prev) => [
        ...prev,
        { role: "system", content: error.message, isError: true },
      ]);
      toast({
        variant: "destructive",
        title: "Inference failed",
        description: error.message.includes("backend")
          ? "No AI engine is running. See the setup guide below."
          : error.message,
      });
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

  return (
    <div className="flex flex-col h-full max-h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b">
        <div className="flex items-center gap-3">
          <Brain className="h-5 w-5 text-primary" />
          <h1 className="text-lg font-bold">AI Chat</h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Mode toggle — visible on ALL screen sizes */}
          <Button
            variant={mode === "medium" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("medium")}
          >
            <Cpu className="h-3 w-3 mr-1" /> Local
          </Button>
          <Button
            variant={mode === "pool" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("pool")}
            disabled={!poolReady}
            title={poolReady ? `${poolNodes} GPUs in pool` : "No pool available"}
          >
            <Users className="h-3 w-3 mr-1" /> Pool{poolReady && ` (${poolNodes})`}
            {!poolReady && <span className="ml-1 text-xs opacity-60">offline</span>}
          </Button>
          <Button
            variant={mode === "high_intel" ? "default" : "outline"}
            size="sm"
            onClick={() => setMode("high_intel")}
            disabled={!clusterReady}
            title={!clusterReady ? "No community GPU cluster available yet" : "Use community GPU cluster"}
          >
            <Globe className="h-3 w-3 mr-1" /> Cluster
            {!clusterReady && <span className="ml-1 text-xs opacity-60">offline</span>}
          </Button>
        </div>
      </div>

      {/* Ollama not running banner */}
      {!anyBackend && (
        <div className="mx-6 mt-4 p-4 rounded-lg border border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
            <div className="space-y-2">
              <p className="font-medium text-amber-800 dark:text-amber-200">
                AI engine not detected
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                To use AI chat, you need <strong>Ollama</strong> — a free, private AI engine that runs on your computer.
                No data leaves your machine.
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                <a href="https://ollama.ai" target="_blank" rel="noopener noreferrer">
                  <Button size="sm" variant="outline" className="gap-1">
                    <Download className="h-3 w-3" /> Install Ollama (free)
                    <ExternalLink className="h-3 w-3" />
                  </Button>
                </a>
                <p className="text-xs text-amber-600 dark:text-amber-400 self-center">
                  After installing, Ollama starts automatically. Then refresh this page.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground max-w-md mx-auto">
            <Brain className="h-12 w-12 mb-4 opacity-30" />
            <p className="text-lg font-medium mb-2">Ask me anything</p>
            <p className="text-sm">
              {mode === "medium"
                ? "Your messages are processed locally on your computer. Nothing is sent to the internet."
                : "Your message will be processed by the community GPU cluster for faster, more powerful responses."}
            </p>
            {!anyBackend && (
              <p className="text-sm mt-4 text-amber-600">
                Install Ollama above to get started.
              </p>
            )}
          </div>
        )}

        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-4 py-3 ${
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : msg.isError
                  ? "bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800"
                  : "bg-muted"
              }`}
            >
              {msg.isError && (
                <div className="flex items-center gap-1 text-red-600 dark:text-red-400 text-xs font-medium mb-1">
                  <AlertCircle className="h-3 w-3" /> Error
                </div>
              )}
              <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
              {msg.role === "assistant" && !msg.isError && (
                <div className="flex flex-wrap items-center gap-2 mt-2 text-xs opacity-60">
                  <Badge variant="outline" className="text-xs py-0">
                    {msg.mode === "pool" || msg.mode === "failover" ? (
                      <><Users className="h-3 w-3 mr-1" />pool</>
                    ) : msg.mode === "local" || msg.mode === "medium" || msg.mode === "hive-ai" ? (
                      <><Cpu className="h-3 w-3 mr-1" />local</>
                    ) : (
                      <><Globe className="h-3 w-3 mr-1" />cluster</>
                    )}
                  </Badge>
                  {msg.routedTo && <span className="opacity-80">→ {msg.routedTo.replace("gpu-", "").replace(/-/g, " ")}</span>}
                  {msg.latencyMs != null && <span>{(msg.latencyMs / 1000).toFixed(1)}s</span>}
                  {msg.tokensGenerated != null && <span>{msg.tokensGenerated} tokens</span>}
                </div>
              )}
            </div>
          </div>
        ))}

        {inferMutation.isPending && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-4 py-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Thinking...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t p-4">
        <div className="flex gap-2 max-w-3xl mx-auto">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={anyBackend ? "Type a message..." : "Install Ollama to start chatting"}
            className="resize-none min-h-12 max-h-[200px]"
            rows={1}
            disabled={!anyBackend}
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || inferMutation.isPending || !anyBackend}
            size="icon"
            className="h-12 w-12 shrink-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
