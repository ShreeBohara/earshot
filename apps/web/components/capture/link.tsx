"use client";

import { type ComponentType, createContext, type ReactNode, use } from "react";

export interface CaptureLinkProps {
  href: string;
  className?: string;
  children: ReactNode;
}

/**
 * The link the capture components render. The app provides `next/link` (client navigation, so a
 * debrief survives following a link); without a provider, as in Storybook, it's a plain anchor.
 * Storybook can't load `next/link` outside Next.
 */
export const CaptureLinkContext = createContext<ComponentType<CaptureLinkProps> | null>(null);

export function CaptureLink(props: CaptureLinkProps) {
  const Component = use(CaptureLinkContext);
  return Component ? <Component {...props} /> : <a {...props} />;
}
