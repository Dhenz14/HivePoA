import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useQuery } from "@tanstack/react-query";
import { Wallet, ArrowDownLeft, FileText, CheckCircle2, Clock, Loader2, TrendingUp, Users, DollarSign } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { getApiBase } from "@/lib/api-mode";

interface WalletDeposit {
  id: string;
  fromUsername: string;
  hbdAmount: string;
  memo: string | null;
  txHash: string;
  purpose: string;
  processed: boolean;
  createdAt: string;
}

interface PayoutReport {
  id: string;
  validatorUsername: string;
  periodStart: string;
  periodEnd: string;
  totalHbd: string;
  recipientCount: number;
  status: string;
  executedAt: string | null;
  createdAt: string;
}

interface WalletDashboardData {
  balance: {
    totalDeposits: string;
    totalPaid: string;
    available: string;
  };
  recentDeposits: WalletDeposit[];
  pendingReports: PayoutReport[];
  executedReports: PayoutReport[];
}

export default function WalletDashboard() {
  const { data, isLoading } = useQuery<WalletDashboardData>({
    queryKey: ["wallet-dashboard"],
    queryFn: async () => {
      const res = await fetch(`${getApiBase()}/api/wallet/dashboard`);
      if (!res.ok) throw new Error("Failed to fetch wallet data");
      return res.json();
    },
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-wallet-dashboard">
        <div>
          <h1 className="text-3xl font-display font-bold">Network Wallet</h1>
          <p className="text-muted-foreground mt-1">Loading wallet data...</p>
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  const balance = data?.balance || { totalDeposits: "0", totalPaid: "0", available: "0" };
  const deposits = data?.recentDeposits || [];
  const pendingReports = data?.pendingReports || [];
  const executedReports = data?.executedReports || [];

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto" data-testid="page-wallet-dashboard">
      <div>
        <h1 className="text-3xl font-display font-bold">Network Wallet</h1>
        <p className="text-muted-foreground mt-1">Central wallet for storage payments and operator payouts</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="bg-gradient-to-br from-green-500/20 to-green-600/10 border-green-500/30">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Total Deposits</p>
                <p className="text-3xl font-bold font-mono" data-testid="text-total-deposits">
                  {parseFloat(balance.totalDeposits ?? "0").toFixed(3)} <span className="text-lg opacity-70">HBD</span>
                </p>
              </div>
              <div className="p-3 bg-green-500/20 rounded-full">
                <ArrowDownLeft className="w-6 h-6 text-green-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-orange-500/20 to-orange-600/10 border-orange-500/30">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Total Paid Out</p>
                <p className="text-3xl font-bold font-mono" data-testid="text-total-paid">
                  {parseFloat(balance.totalPaid ?? "0").toFixed(3)} <span className="text-lg opacity-70">HBD</span>
                </p>
              </div>
              <div className="p-3 bg-orange-500/20 rounded-full">
                <TrendingUp className="w-6 h-6 text-orange-500" />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-blue-500/20 to-blue-600/10 border-blue-500/30">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground mb-1">Available Balance</p>
                <p className="text-3xl font-bold font-mono" data-testid="text-available">
                  {parseFloat(balance.available ?? "0").toFixed(3)} <span className="text-lg opacity-70">HBD</span>
                </p>
              </div>
              <div className="p-3 bg-blue-500/20 rounded-full">
                <Wallet className="w-6 h-6 text-blue-500" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ArrowDownLeft className="w-5 h-5 text-green-500" />
              Recent Deposits
            </CardTitle>
            <CardDescription>HBD received for storage services</CardDescription>
          </CardHeader>
          <CardContent>
            {deposits.length > 0 ? (
              <div className="space-y-3">
                {deposits.map((deposit) => (
                  <div
                    key={deposit.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-accent/30 border border-border/50"
                    data-testid={`deposit-${deposit.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-green-500/10 rounded-full">
                        <DollarSign className="w-4 h-4 text-green-500" />
                      </div>
                      <div>
                        <p className="font-mono text-sm">@{deposit.fromUsername}</p>
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(deposit.createdAt), "MMM d, h:mm a")}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-mono font-medium text-green-500">+{deposit.hbdAmount} HBD</p>
                      <p className="text-xs text-muted-foreground">{deposit.purpose}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">No deposits yet</p>
            )}
          </CardContent>
        </Card>

        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="w-5 h-5 text-yellow-500" />
              Pending Payouts
            </CardTitle>
            <CardDescription>Payout reports awaiting execution</CardDescription>
          </CardHeader>
          <CardContent>
            {pendingReports.length > 0 ? (
              <div className="space-y-3">
                {pendingReports.map((report) => (
                  <div
                    key={report.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-accent/30 border border-border/50"
                    data-testid={`pending-report-${report.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-yellow-500/10 rounded-full">
                        <Clock className="w-4 h-4 text-yellow-500" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          {format(new Date(report.periodStart), "MMM d")} - {format(new Date(report.periodEnd), "MMM d")}
                        </p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          <Users className="w-3 h-3" /> {report.recipientCount} recipients
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-mono font-medium">{report.totalHbd} HBD</p>
                      <Badge variant="outline" className="bg-yellow-500/10 text-yellow-500 text-xs">
                        Pending
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-8">No pending payouts</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-green-500" />
            Executed Payouts
          </CardTitle>
          <CardDescription>Successfully completed payout reports</CardDescription>
        </CardHeader>
        <CardContent>
          {executedReports.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Validator</TableHead>
                  <TableHead className="text-right">Recipients</TableHead>
                  <TableHead className="text-right">Total Paid</TableHead>
                  <TableHead>Executed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executedReports.map((report) => (
                  <TableRow key={report.id} data-testid={`executed-report-${report.id}`}>
                    <TableCell className="font-mono text-sm">
                      {format(new Date(report.periodStart), "MMM d")} - {format(new Date(report.periodEnd), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell>@{report.validatorUsername}</TableCell>
                    <TableCell className="text-right">{report.recipientCount}</TableCell>
                    <TableCell className="text-right font-mono text-green-500">{report.totalHbd} HBD</TableCell>
                    <TableCell>{report.executedAt ? format(new Date(report.executedAt), "MMM d, yyyy") : "-"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-muted-foreground text-center py-8">No executed payouts yet</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
