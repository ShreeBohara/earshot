import { ArrowRightIcon, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/** A large link to one way of getting started, used by onboarding and the home page. */
export function StartCard({
  href,
  icon: Icon,
  title,
  action,
  children,
  headingLevel = "h2",
}: {
  href: string;
  icon: LucideIcon;
  title: string;
  action: string;
  children: ReactNode;
  headingLevel?: "h2" | "h3";
}) {
  const Heading = headingLevel;
  return (
    <Link
      href={href}
      className="group flex flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground outline-none transition-colors duration-200 hover:border-foreground/25 focus-visible:focus-ring motion-reduce:transition-none"
    >
      <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
      <Heading className="font-medium text-base">{title}</Heading>
      <p className="text-pretty text-muted-foreground text-sm">{children}</p>
      <span className="mt-auto inline-flex items-center gap-1 pt-2 font-medium text-sm">
        {action}
        <ArrowRightIcon
          aria-hidden="true"
          className="size-4 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
        />
      </span>
    </Link>
  );
}
