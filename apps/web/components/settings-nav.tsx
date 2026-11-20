"use client";

import { cn } from "@earshot/ui/lib/utils";
import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/settings/account", label: "Account" },
  { href: "/settings/keys", label: "Keys" },
  { href: "/settings/capture", label: "Capture" },
  { href: "/settings/review", label: "Review" },
  { href: "/settings/data", label: "Data" },
] as const;

/** Settings sections: a column on wide screens, a row on narrow ones. */
export function SettingsNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings">
      <ul className="flex gap-1 md:flex-col">
        {LINKS.map(({ href, label }) => {
          const current = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex min-h-8 items-center rounded-md px-3 py-1.5 text-sm outline-none transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:focus-ring motion-reduce:transition-none",
                  current ? "bg-muted font-medium text-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
