"use client";

import { type EvidenceSession, targetWords } from "@/lib/evidence/state";
import { ProposalCard, type ProposalCardProps } from "../inbox/proposal-card";
import { useCardEvidence } from "./evidence-provider";

/**
 * The inbox's card with its evidence clips (Phase 5 spec WP9): the inbox and the capture tray
 * render this, so each field and the target's words get a play button where this device holds
 * their audio, and the card one line saying why where it doesn't. The pilot renders `ProposalCard`
 * itself, with its own "no audio" line, and never offers playback.
 */
export function EvidenceCard({
  session,
  ...card
}: Omit<ProposalCardProps, "evidence" | "audioNote"> & { readonly session: EvidenceSession }) {
  const evidence = useCardEvidence(session, card.proposal, targetWords(card.model) !== null);
  return <ProposalCard {...card} {...(evidence ? { evidence } : {})} />;
}
