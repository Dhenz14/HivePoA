import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowDownLeft, ArrowUpRight, CreditCard, DollarSign, Wallet as WalletIcon } from "lucide-react";
import { useState } from "react";

export default function Wallet() {
  const [amount, setAmount] = useState("");

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-display font-bold">Wallet</h1>
        <p className="text-muted-foreground mt-1">Manage your HBD earnings and payments</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Balance & Actions */}
        <div className="lg:col-span-1 space-y-6">
          <Card className="bg-primary text-primary-foreground border-none shadow-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 -mt-4 -mr-4 w-32 h-32 bg-white/10 rounded-full blur-3xl"></div>
            <div className="absolute bottom-0 left-0 -mb-4 -ml-4 w-24 h-24 bg-black/10 rounded-full blur-xl"></div>
            
            <CardContent className="p-6 relative z-10">
              <div className="flex justify-between items-start mb-8">
                <WalletIcon className="w-8 h-8 text-primary-foreground/80" />
                <span className="bg-black/20 px-2 py-1 rounded text-xs font-mono">HIVE KEYCHAIN</span>
              </div>
              <div className="space-y-1">
                <p className="text-sm text-primary-foreground/80 font-medium">Total Balance</p>
                <h2 className="text-4xl font-display font-bold tracking-tight">452.30 <span className="text-lg opacity-80">HBD</span></h2>
              </div>
              <div className="mt-8 pt-6 border-t border-white/20 flex gap-4">
                <div className="flex-1">
                  <p className="text-xs text-primary-foreground/60 mb-1">Pending Rewards</p>
                  <p className="font-medium font-mono">12.50 HBD</p>
                </div>
                <div className="flex-1 text-right">
                  <p className="text-xs text-primary-foreground/60 mb-1">Node Status</p>
                  <p className="font-medium flex items-center justify-end gap-1">
                    <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
                    Active
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="text-lg">Quick Transfer</CardTitle>
              <CardDescription>Send HBD to another Hive account</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="recipient">Recipient (Hive Username)</Label>
                <Input id="recipient" placeholder="@username" className="font-mono" />
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
              <Button className="w-full bg-primary hover:bg-primary/90">Send HBD</Button>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: History */}
        <div className="lg:col-span-2">
          <Card className="h-full border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle>Transaction History</CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="all" className="w-full">
                <TabsList className="grid w-full grid-cols-3 mb-4">
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="rewards">PoA Rewards</TabsTrigger>
                  <TabsTrigger value="transfers">Transfers</TabsTrigger>
                </TabsList>
                
                <div className="space-y-1">
                  {[
                    { type: "reward", from: "hive.fund", amount: "+1.250 HBD", date: "Today, 10:42 AM", id: "8f2a...9kL" },
                    { type: "reward", from: "hive.fund", amount: "+0.950 HBD", date: "Today, 08:15 AM", id: "3b4c...2mP" },
                    { type: "transfer", from: "You", to: "@3speak", amount: "-10.000 HBD", date: "Yesterday", id: "7n9p...1qR" },
                    { type: "reward", from: "hive.fund", amount: "+2.100 HBD", date: "Yesterday", id: "4x5y...8zT" },
                    { type: "reward", from: "hive.fund", amount: "+1.050 HBD", date: "May 18", id: "2w3e...6rU" },
                  ].map((tx, i) => (
                    <div key={i} className="flex items-center justify-between p-4 rounded-lg hover:bg-accent/50 transition-colors border border-transparent hover:border-border/50">
                      <div className="flex items-center gap-4">
                        <div className={cn(
                          "p-2 rounded-full",
                          tx.type === "reward" ? "bg-green-500/10 text-green-500" : "bg-orange-500/10 text-orange-500"
                        )}>
                          {tx.type === "reward" ? <ArrowDownLeft className="w-4 h-4" /> : <ArrowUpRight className="w-4 h-4" />}
                        </div>
                        <div>
                          <p className="font-medium text-sm">
                            {tx.type === "reward" ? "PoA Reward" : "Transfer"}
                            <span className="text-muted-foreground font-normal ml-1">
                              {tx.type === "reward" ? "from" : "to"} <span className="font-mono text-primary">{tx.type === "reward" ? tx.from : tx.to}</span>
                            </span>
                          </p>
                          <p className="text-xs text-muted-foreground font-mono">{tx.date} • {tx.id}</p>
                        </div>
                      </div>
                      <div className={cn(
                        "font-mono font-medium",
                        tx.type === "reward" ? "text-green-500" : "text-foreground"
                      )}>
                        {tx.amount}
                      </div>
                    </div>
                  ))}
                </div>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

import { cn } from "@/lib/utils";
