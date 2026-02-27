import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowDownLeft, ArrowUpRight, DollarSign, Wallet as WalletIcon, Loader2, AlertTriangle, Search } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useValidatorAuth } from "@/contexts/ValidatorAuthContext";
import { cn } from "@/lib/utils";
import { format } from "date-fns";

interface WalletTransaction {
  id: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  hbdAmount: string;
  date: string;
  txHash: string | null;
  status: string;
}

interface WalletData {
  username: string;
  hbdBalance: string;
  totalEarned: string;
  earningsByType: {
    storage: string;
    encoding: string;
    beneficiary: string;
    validation: string;
  };
  transactions: WalletTransaction[];
}

export default function Wallet() {
  const { user, isAuthenticated } = useValidatorAuth();
  const [lookupUsername, setLookupUsername] = useState("");
  const [activeUsername, setActiveUsername] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [activeTab, setActiveTab] = useState("all");

  const walletUsername = activeUsername || (isAuthenticated ? user?.username : null);

  const { data, isLoading, error } = useQuery<WalletData>({
    queryKey: ["wallet-user", walletUsername],
    queryFn: async () => {
      const res = await fetch(`/api/wallet/user/${walletUsername}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to fetch wallet");
      }
      return res.json();
    },
    enabled: !!walletUsername,
    refetchInterval: 30000,
  });

  const handleLookup = () => {
    const cleaned = lookupUsername.trim().toLowerCase().replace("@", "");
    if (cleaned) setActiveUsername(cleaned);
  };

  const filteredTransactions = (data?.transactions || []).filter((tx) => {
    if (activeTab === "all") return true;
    if (activeTab === "rewards") return tx.type === "reward";
    if (activeTab === "transfers") return tx.type !== "reward";
    return true;
  });

  // No user selected — show lookup form
  if (!walletUsername) {
    return (
      <div className="p-8 space-y-8 max-w-7xl mx-auto">
        <div>
          <h1 className="text-3xl font-display font-bold">Wallet</h1>
          <p className="text-muted-foreground mt-1">Manage your HBD earnings and payments</p>
        </div>
        <Card className="max-w-md mx-auto">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 p-3 rounded-full bg-primary/20 w-fit">
              <WalletIcon className="h-8 w-8 text-primary" />
            </div>
            <CardTitle>View Wallet</CardTitle>
            <CardDescription>
              Enter a Hive username to view their wallet, or log in as a validator to see yours automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="hive username"
                value={lookupUsername}
                onChange={(e) => setLookupUsername(e.target.value.toLowerCase().replace("@", ""))}
                onKeyDown={(e) => e.key === "Enter" && handleLookup()}
                className="font-mono"
              />
              <Button onClick={handleLookup} disabled={!lookupUsername.trim()}>
                <Search className="w-4 h-4 mr-2" />
                Look Up
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold">Wallet</h1>
          <p className="text-muted-foreground mt-1">
            {isAuthenticated && user?.username === walletUsername
              ? "Manage your HBD earnings and payments"
              : `Viewing wallet for @${walletUsername}`}
          </p>
        </div>
        {activeUsername && (
          <Button variant="outline" size="sm" onClick={() => setActiveUsername(null)}>
            Change User
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
          <span className="ml-3 text-muted-foreground">Loading wallet...</span>
        </div>
      ) : error ? (
        <Card className="border-destructive/50 bg-destructive/5 max-w-md mx-auto">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="w-8 h-8 text-destructive mx-auto mb-3" />
            <p className="font-medium">Failed to load wallet</p>
            <p className="text-sm text-muted-foreground mt-1">{(error as Error).message}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => setActiveUsername(null)}>
              Try Another User
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Left Column: Balance & Actions */}
          <div className="lg:col-span-1 space-y-6">
            <Card className="bg-primary text-primary-foreground border-none shadow-xl relative overflow-hidden">
              <div className="absolute top-0 right-0 -mt-4 -mr-4 w-32 h-32 bg-white/10 rounded-full blur-3xl"></div>
              <div className="absolute bottom-0 left-0 -mb-4 -ml-4 w-24 h-24 bg-black/10 rounded-full blur-xl"></div>

              <CardContent className="p-6 relative z-10">
                <div className="flex justify-between items-start mb-8">
                  <WalletIcon className="w-8 h-8 text-primary-foreground/80" />
                  <span className="bg-black/20 px-2 py-1 rounded text-xs font-mono">@{data?.username}</span>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-primary-foreground/80 font-medium">HBD Balance</p>
                  <h2 className="text-4xl font-display font-bold tracking-tight">
                    {data?.hbdBalance || "0.000"} <span className="text-lg opacity-80">HBD</span>
                  </h2>
                </div>
                <div className="mt-8 pt-6 border-t border-white/20 flex gap-4">
                  <div className="flex-1">
                    <p className="text-xs text-primary-foreground/60 mb-1">Total Earned</p>
                    <p className="font-medium font-mono">{data?.totalEarned || "0.000"} HBD</p>
                  </div>
                  <div className="flex-1 text-right">
                    <p className="text-xs text-primary-foreground/60 mb-1">Transactions</p>
                    <p className="font-medium">{data?.transactions.length || 0}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Earnings Breakdown */}
            {data?.earningsByType && parseFloat(data.totalEarned) > 0 && (
              <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
                <CardHeader>
                  <CardTitle className="text-lg">Earnings Breakdown</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {[
                    { label: "Storage", value: data.earningsByType.storage, color: "text-green-500" },
                    { label: "Validation", value: data.earningsByType.validation, color: "text-blue-500" },
                    { label: "Encoding", value: data.earningsByType.encoding, color: "text-purple-500" },
                    { label: "Beneficiary", value: data.earningsByType.beneficiary, color: "text-orange-500" },
                  ].filter(e => parseFloat(e.value) > 0).map((earning) => (
                    <div key={earning.label} className="flex justify-between items-center">
                      <span className="text-sm text-muted-foreground">{earning.label}</span>
                      <span className={cn("font-mono font-medium", earning.color)}>
                        {parseFloat(earning.value).toFixed(3)} HBD
                      </span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
              <CardHeader>
                <CardTitle className="text-lg">Quick Transfer</CardTitle>
                <CardDescription>Send HBD to another Hive account</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="recipient">Recipient (Hive Username)</Label>
                  <Input
                    id="recipient"
                    placeholder="@username"
                    className="font-mono"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value.toLowerCase().replace("@", ""))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="amount">Amount (HBD)</Label>
                  <div className="relative">
                    <DollarSign className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="amount"
                      placeholder="0.00"
                      className="pl-9 font-mono"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </div>
                </div>
                <Button className="w-full" disabled>
                  Send HBD (Requires Keychain)
                </Button>
                <p className="text-xs text-center text-muted-foreground">
                  Transfers require Hive Keychain active key authorization
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Right Column: History */}
          <div className="lg:col-span-2">
            <Card className="h-full border-border/50 bg-card/50 backdrop-blur-sm">
              <CardHeader>
                <CardTitle>Transaction History</CardTitle>
                <CardDescription>
                  {data?.transactions.length
                    ? `${data.transactions.length} transactions found`
                    : "No transactions yet"}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                  <TabsList className="grid w-full grid-cols-3 mb-4">
                    <TabsTrigger value="all">All</TabsTrigger>
                    <TabsTrigger value="rewards">PoA Rewards</TabsTrigger>
                    <TabsTrigger value="transfers">Transfers</TabsTrigger>
                  </TabsList>

                  <div className="space-y-1">
                    {filteredTransactions.length > 0 ? (
                      filteredTransactions.map((tx) => (
                        <div
                          key={tx.id}
                          className="flex items-center justify-between p-4 rounded-lg hover:bg-accent/50 transition-colors border border-transparent hover:border-border/50"
                        >
                          <div className="flex items-center gap-4">
                            <div className={cn(
                              "p-2 rounded-full",
                              tx.type === "reward" ? "bg-green-500/10 text-green-500" : "bg-orange-500/10 text-orange-500"
                            )}>
                              {tx.type === "reward"
                                ? <ArrowDownLeft className="w-4 h-4" />
                                : <ArrowUpRight className="w-4 h-4" />}
                            </div>
                            <div>
                              <p className="font-medium text-sm">
                                {tx.type === "reward" ? "PoA Reward" : tx.type}
                                <span className="text-muted-foreground font-normal ml-1">
                                  from <span className="font-mono text-primary">{tx.from}</span>
                                </span>
                              </p>
                              <p className="text-xs text-muted-foreground font-mono">
                                {format(new Date(tx.date), "MMM d, h:mm a")}
                                {tx.txHash && ` • ${tx.txHash.substring(0, 8)}...`}
                              </p>
                            </div>
                          </div>
                          <div className={cn(
                            "font-mono font-medium",
                            tx.type === "reward" ? "text-green-500" : "text-foreground"
                          )}>
                            {tx.amount}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="text-center py-12 text-muted-foreground">
                        <WalletIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
                        <p>No {activeTab !== "all" ? activeTab : "transactions"} found</p>
                        <p className="text-sm mt-1">
                          Transactions will appear here as PoA rewards are earned
                        </p>
                      </div>
                    )}
                  </div>
                </Tabs>
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
