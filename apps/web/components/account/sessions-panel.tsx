"use client";

import { Badge } from "@earshot/ui/components/badge";
import { Button } from "@earshot/ui/components/button";
import { toast } from "@earshot/ui/components/toast";
import { LaptopIcon, SmartphoneIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { revokeOtherSessions, revokeSession } from "@/app/(app)/settings/account/actions";

export type SessionRow = {
  id: string;
  device: string;
  mobile: boolean;
  ipAddress: string | null;
  lastActive: string;
  current: boolean;
};

/** Devices signed in to the account. Any but this one can be signed out from here. */
export function SessionsPanel({ sessions }: { sessions: SessionRow[] }) {
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<string | null>(null);
  const others = sessions.filter((session) => !session.current).length;

  function signOutSession(id: string) {
    setTarget(id);
    startTransition(async () => {
      const result = await revokeSession(id);
      setTarget(null);
      toast.add({
        title: result.status === "error" ? "Couldn't sign that session out" : "Session signed out",
        ...(result.message ? { description: result.message } : {}),
      });
    });
  }

  function signOutOthers() {
    setTarget("others");
    startTransition(async () => {
      const result = await revokeOtherSessions();
      setTarget(null);
      toast.add({ title: result.message ?? "Signed out everywhere else." });
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col divide-y rounded-lg border">
        {sessions.map((session) => {
          const Icon = session.mobile ? SmartphoneIcon : LaptopIcon;
          return (
            <li key={session.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium text-sm">
                  <span className="truncate">{session.device}</span>
                  {session.current && <Badge variant="neutral">This device</Badge>}
                </p>
                <p className="text-muted-foreground text-xs">
                  {session.current ? "Active now" : `Last active ${session.lastActive}`}
                  {session.ipAddress && (
                    <>
                      {" · "}
                      <span className="font-mono">{session.ipAddress}</span>
                    </>
                  )}
                </p>
              </div>
              {!session.current && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => signOutSession(session.id)}
                  aria-label={`Sign out ${session.device}, last active ${session.lastActive}`}
                >
                  {target === session.id ? "Signing out…" : "Sign out"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {others > 0 && (
        <div>
          <Button variant="outline" disabled={pending} onClick={signOutOthers}>
            {target === "others" ? "Signing out…" : "Sign out of all other sessions"}
          </Button>
        </div>
      )}
    </div>
  );
}
