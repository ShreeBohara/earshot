"use client";

import { Button } from "@earshot/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@earshot/ui/components/dropdown-menu";
import { LogOutIcon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import { useTransition } from "react";
import { signOut } from "@/app/actions/session";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts.at(-1)] : [parts[0]];
  return (
    letters
      .map((part) => part?.[0] ?? "")
      .join("")
      .toUpperCase() || "?"
  );
}

/** The header's account menu: who's signed in, Settings, and Sign out. */
export function UserMenu({ name, email }: { name: string; email: string }) {
  const [signingOut, startSignOut] = useTransition();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" size="icon" className="rounded-full font-medium" />}
        aria-label={`Account menu for ${name}`}
      >
        <span aria-hidden="true" className="text-xs">
          {initials(name)}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block truncate font-medium text-foreground">{name}</span>
            <span className="block truncate">{email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLinkItem closeOnClick render={<Link href="/settings/account" />}>
          <SettingsIcon aria-hidden="true" />
          Settings
        </DropdownMenuLinkItem>
        <DropdownMenuItem disabled={signingOut} onClick={() => startSignOut(() => signOut())}>
          <LogOutIcon aria-hidden="true" />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
