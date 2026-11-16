import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings-nav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <p className="font-mono text-muted-foreground text-xs uppercase tracking-wider">Settings</p>
      <div className="grid gap-8 md:grid-cols-[12rem_1fr]">
        <SettingsNav />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
