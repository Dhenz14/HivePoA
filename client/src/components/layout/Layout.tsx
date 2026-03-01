import { Sidebar } from "./Sidebar";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-y-auto relative">
        <div className="absolute inset-0 bg-grid-pattern opacity-[0.02] pointer-events-none" />
        <div className="absolute top-0 left-0 right-0 h-80 bg-linear-to-b from-primary/3 to-transparent pointer-events-none" />
        <div className="relative">
          {children}
        </div>
      </main>
    </div>
  );
}
