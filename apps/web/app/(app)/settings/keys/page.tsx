import type { Metadata } from "next";
import Link from "next/link";
import { requireViewer } from "@/lib/auth/viewer";

export const metadata: Metadata = { title: "Keys · Settings · Earshot" };

/** Placeholder: adding, validating, and vaulting provider keys lands in the next pull request. */
export default async function KeysSettingsPage() {
  await requireViewer("/settings/keys");

  return (
    <div className="flex max-w-prose flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="font-serif text-4xl tracking-tight">Keys</h1>
        <p className="text-pretty text-muted-foreground">
          Earshot runs on your own speech-to-text and model keys. They&apos;re encrypted on this
          device and sent only with the requests that need them; the server never stores them unless
          you turn on the optional vault.
        </p>
      </header>
      <div className="rounded-xl border border-dashed p-5">
        <h2 className="font-medium">Coming next</h2>
        <p className="mt-1 text-muted-foreground text-sm">
          Adding and checking keys arrives in the next update. Meanwhile, the{" "}
          <Link
            href="/demo"
            className="rounded-sm underline underline-offset-4 outline-none hover:text-foreground focus-visible:focus-ring"
          >
            replay demo
          </Link>{" "}
          works without one.
        </p>
      </div>
    </div>
  );
}
