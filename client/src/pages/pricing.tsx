import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HardDrive, Zap, Crown, Check, Plus, ArrowUp, Clock, Shield, Copy, Loader2, TrendingUp } from "lucide-react";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { getApiBase } from "@/lib/api-mode";

interface StorageTier {
  id: string;
  name: string;
  storageLimitBytes: number;
  storageLimitLabel: string;
  hbdPrice: string;
  durationDays: number;
  description: string;
}

interface StorageUsage {
  usedBytes: number;
  usedLabel: string;
  tier: { id: string; name: string; storageLimitBytes: number; storageLimitLabel: string } | null;
  contract: { id: string; status: string; hbdBudget: string; hbdSpent: string; expiresAt: string } | null;
  remainingBytes: number;
  usagePercent: number;
}

const tierIcons: Record<string, React.ReactNode> = {
  starter: <HardDrive className="h-8 w-8" />,
  standard: <Zap className="h-8 w-8" />,
  creator: <Crown className="h-8 w-8" />,
};

const tierColors: Record<string, string> = {
  starter: "from-blue-500/10 to-blue-600/5 border-blue-500/20",
  standard: "from-emerald-500/10 to-emerald-600/5 border-emerald-500/20",
  creator: "from-amber-500/10 to-amber-600/5 border-amber-500/20",
};

const tierAccents: Record<string, string> = {
  starter: "text-blue-500",
  standard: "text-emerald-500",
  creator: "text-amber-500",
};

export default function Pricing() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedTier, setSelectedTier] = useState<StorageTier | null>(null);
  const [extraHbd, setExtraHbd] = useState(0);
  const [showPurchaseDialog, setShowPurchaseDialog] = useState(false);
  const [showTopUpDialog, setShowTopUpDialog] = useState(false);
  const [topUpTxHash, setTopUpTxHash] = useState("");

  // Fetch tiers
  const { data: tiers = [] } = useQuery<StorageTier[]>({
    queryKey: ["storage-tiers"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/storage/tiers`);
      return res.json();
    },
  });

  // Fetch current usage
  const { data: usage } = useQuery<StorageUsage>({
    queryKey: ["storage-usage"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/storage/usage`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("session_token")}` },
      });
      if (!res.ok) return null;
      return res.json();
    },
    refetchInterval: 30000,
  });

  // Subscribe to a tier
  const subscribeMutation = useMutation({
    mutationFn: async ({ tierId, extraHbd }: { tierId: string; extraHbd?: string }) => {
      const res = await fetch(`${getApiBase()}/api/storage/subscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("session_token")}`,
        },
        body: JSON.stringify({ tierId, extraHbd: extraHbd && parseFloat(extraHbd) > 0 ? extraHbd : undefined }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Subscription failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Plan created", description: `Send ${data.totalBudget} HBD with memo: ${data.depositMemo}` });
      queryClient.invalidateQueries({ queryKey: ["storage-usage"] });
      setShowPurchaseDialog(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  // Top up existing contract
  const topUpMutation = useMutation({
    mutationFn: async ({ contractId, txHash }: { contractId: string; txHash: string }) => {
      const res = await fetch(`${getApiBase()}/api/storage/topup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${localStorage.getItem("session_token")}`,
        },
        body: JSON.stringify({ contractId, txHash }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Top-up failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Top-up confirmed", description: "Your plan budget has been increased." });
      queryClient.invalidateQueries({ queryKey: ["storage-usage"] });
      setShowTopUpDialog(false);
      setTopUpTxHash("");
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const activeTier = usage?.tier;
  const activeContract = usage?.contract;
  const daysRemaining = activeContract?.expiresAt
    ? Math.max(0, Math.ceil((new Date(activeContract.expiresAt).getTime() - Date.now()) / 86400000))
    : 0;

  const handleSelectTier = (tier: StorageTier) => {
    setSelectedTier(tier);
    setExtraHbd(0);
    setShowPurchaseDialog(true);
  };

  const totalPrice = selectedTier
    ? (parseFloat(selectedTier.hbdPrice) + extraHbd).toFixed(3)
    : "0";

  const extraNodesEstimate = selectedTier
    ? Math.max(0, Math.floor(extraHbd / parseFloat(selectedTier.hbdPrice) * 3))
    : 0;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold">Storage Plans</h1>
        <p className="text-muted-foreground max-w-2xl mx-auto">
          Your files, incentivized for a year. Every HBD you pay is distributed to storage nodes
          via Proof of Access challenges — the more you pay, the more nodes store your data.
        </p>
      </div>

      {/* Active Plan Banner */}
      {activeTier && activeContract && (
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className={tierAccents[activeTier.id]}>
                  {tierIcons[activeTier.id]}
                </div>
                <div>
                  <h3 className="font-semibold text-lg">
                    {activeTier.name} Plan
                    <Badge variant="outline" className="ml-2">{activeTier.storageLimitLabel}</Badge>
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {usage?.usedLabel} used of {activeTier.storageLimitLabel}
                    {" "}&middot;{" "}
                    {daysRemaining} days remaining
                    {" "}&middot;{" "}
                    {activeContract.hbdSpent} / {activeContract.hbdBudget} HBD distributed
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setShowTopUpDialog(true)}>
                  <Plus className="h-4 w-4 mr-1" /> Top Up
                </Button>
              </div>
            </div>
            <Progress value={usage?.usagePercent || 0} className="mt-4 h-2" />
            <div className="flex justify-between mt-1">
              <span className="text-xs text-muted-foreground">{usage?.usagePercent}% used</span>
              <span className="text-xs text-muted-foreground">
                {((usage?.remainingBytes || 0) / (1024 * 1024 * 1024)).toFixed(1)} GB free
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tier Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {tiers.map((tier) => {
          const isActive = activeTier?.id === tier.id;
          const isUpgrade = activeTier && tiers.indexOf(tier) > tiers.findIndex(t => t.id === activeTier.id);

          return (
            <Card
              key={tier.id}
              className={`relative overflow-hidden bg-gradient-to-b ${tierColors[tier.id]} transition-all hover:shadow-lg ${
                tier.id === "standard" ? "ring-2 ring-emerald-500/30" : ""
              }`}
            >
              {tier.id === "standard" && (
                <div className="absolute top-0 right-0 bg-emerald-500 text-white text-xs font-bold px-3 py-1 rounded-bl-lg">
                  POPULAR
                </div>
              )}
              <CardHeader className="text-center pb-2">
                <div className={`mx-auto mb-2 ${tierAccents[tier.id]}`}>
                  {tierIcons[tier.id]}
                </div>
                <CardTitle className="text-xl">{tier.name}</CardTitle>
                <CardDescription>{tier.description}</CardDescription>
              </CardHeader>
              <CardContent className="text-center space-y-4">
                <div>
                  <span className="text-4xl font-bold">{parseFloat(tier.hbdPrice).toFixed(2)}</span>
                  <span className="text-muted-foreground"> HBD/year</span>
                </div>
                <div className="space-y-2 text-sm text-left">
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-green-500 shrink-0" /> {tier.storageLimitLabel} storage</div>
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-green-500 shrink-0" /> 365 days of PoA incentivization</div>
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-green-500 shrink-0" /> 3x replication across storage nodes</div>
                  <div className="flex items-center gap-2"><Check className="h-4 w-4 text-green-500 shrink-0" /> On-chain proof of every challenge</div>
                  <div className="flex items-center gap-2"><Shield className="h-4 w-4 text-green-500 shrink-0" /> Overpay anytime for extra redundancy</div>
                </div>
              </CardContent>
              <CardFooter>
                {isActive ? (
                  <Button className="w-full" variant="outline" disabled>
                    <Check className="h-4 w-4 mr-1" /> Current Plan
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    variant={tier.id === "standard" ? "default" : "outline"}
                    onClick={() => handleSelectTier(tier)}
                    disabled={!!activeTier && !isUpgrade}
                  >
                    {isUpgrade ? (
                      <><ArrowUp className="h-4 w-4 mr-1" /> Upgrade</>
                    ) : activeTier ? (
                      "Current plan is higher"
                    ) : (
                      "Get Started"
                    )}
                  </Button>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>

      {/* How It Works */}
      <Card>
        <CardHeader>
          <CardTitle>How It Works</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
            <div className="text-center space-y-2">
              <div className="mx-auto w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary">1</div>
              <h4 className="font-medium">Pick a Plan</h4>
              <p className="text-sm text-muted-foreground">Choose the storage tier that fits your needs</p>
            </div>
            <div className="text-center space-y-2">
              <div className="mx-auto w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary">2</div>
              <h4 className="font-medium">Pay in HBD</h4>
              <p className="text-sm text-muted-foreground">Send HBD via Hive Keychain with the provided memo</p>
            </div>
            <div className="text-center space-y-2">
              <div className="mx-auto w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary">3</div>
              <h4 className="font-medium">Upload Files</h4>
              <p className="text-sm text-muted-foreground">Upload up to your tier's limit — files are pinned to IPFS</p>
            </div>
            <div className="text-center space-y-2">
              <div className="mx-auto w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center font-bold text-primary">4</div>
              <h4 className="font-medium">PoA Distributes</h4>
              <p className="text-sm text-muted-foreground">Your HBD is paid out to storage nodes over 365 days via Proof of Access</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Overpay Explanation */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5" /> Want More Redundancy?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            You can <strong>overpay</strong> beyond the base price when subscribing. Extra HBD increases the
            reward per challenge, which makes your files more profitable for storage nodes to keep. More nodes
            storing your data means better availability and redundancy.
          </p>
          <p className="text-sm text-muted-foreground">
            You can also <strong>top up</strong> an active plan at any time by sending additional HBD. This extends
            the incentivization density — your files stay desirable to store for longer.
          </p>
        </CardContent>
      </Card>

      {/* Purchase Dialog */}
      <Dialog open={showPurchaseDialog} onOpenChange={setShowPurchaseDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Subscribe to {selectedTier?.name} Plan</DialogTitle>
            <DialogDescription>
              {selectedTier?.storageLimitLabel} storage for 365 days
            </DialogDescription>
          </DialogHeader>
          {selectedTier && (
            <div className="space-y-6">
              <div className="space-y-3">
                <div className="flex justify-between text-sm">
                  <span>Base price</span>
                  <span className="font-mono">{parseFloat(selectedTier.hbdPrice).toFixed(3)} HBD</span>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm">Extra HBD (optional — more redundancy)</Label>
                  <Slider
                    min={0}
                    max={Math.ceil(parseFloat(selectedTier.hbdPrice) * 3)}
                    step={0.5}
                    value={[extraHbd]}
                    onValueChange={([v]) => setExtraHbd(v)}
                  />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>+0 HBD</span>
                    <span>+{(parseFloat(selectedTier.hbdPrice) * 3).toFixed(0)} HBD</span>
                  </div>
                  {extraHbd > 0 && (
                    <p className="text-xs text-muted-foreground">
                      +{extraHbd.toFixed(1)} HBD extra incentivizes ~{extraNodesEstimate} additional storage nodes
                    </p>
                  )}
                </div>

                <div className="border-t pt-3 flex justify-between font-medium">
                  <span>Total</span>
                  <span className="font-mono text-lg">{totalPrice} HBD</span>
                </div>
              </div>

              <Button
                className="w-full"
                onClick={() => subscribeMutation.mutate({
                  tierId: selectedTier.id,
                  extraHbd: extraHbd > 0 ? extraHbd.toFixed(3) : undefined,
                })}
                disabled={subscribeMutation.isPending}
              >
                {subscribeMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Create Plan — {totalPrice} HBD
              </Button>

              <p className="text-xs text-center text-muted-foreground">
                After creating, you'll receive a deposit memo. Send HBD via Hive Keychain
                to activate your plan.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Top Up Dialog */}
      <Dialog open={showTopUpDialog} onOpenChange={setShowTopUpDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Top Up Your Plan</DialogTitle>
            <DialogDescription>
              Send additional HBD to increase your plan's reward pool. More HBD = more nodes = better redundancy.
            </DialogDescription>
          </DialogHeader>
          {activeContract && (
            <div className="space-y-4">
              <div className="text-sm space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Current budget</span>
                  <span className="font-mono">{activeContract.hbdBudget} HBD</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Already distributed</span>
                  <span className="font-mono">{activeContract.hbdSpent} HBD</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Days remaining</span>
                  <span>{daysRemaining}</span>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Deposit memo (include in your Hive transfer)</Label>
                <div className="flex gap-2">
                  <code className="flex-1 bg-muted p-2 rounded text-xs font-mono break-all">
                    hivepoa:tier:{activeContract.id}
                  </code>
                  <Button variant="outline" size="sm" onClick={() => {
                    navigator.clipboard.writeText(`hivepoa:tier:${activeContract.id}`);
                    toast({ title: "Copied", description: "Deposit memo copied to clipboard" });
                  }}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Hive Transaction Hash (after sending HBD)</Label>
                <Input
                  value={topUpTxHash}
                  onChange={(e) => setTopUpTxHash(e.target.value)}
                  placeholder="Paste tx hash from Hive Keychain..."
                />
              </div>

              <Button
                className="w-full"
                onClick={() => topUpMutation.mutate({ contractId: activeContract.id, txHash: topUpTxHash })}
                disabled={!topUpTxHash || topUpMutation.isPending}
              >
                {topUpMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Verify Top-Up
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
