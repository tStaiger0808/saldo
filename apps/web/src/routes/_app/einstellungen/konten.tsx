import { createFileRoute, redirect } from "@tanstack/react-router";

/** Accounts are managed on the accounts page; the old settings address leads there. */
export const Route = createFileRoute("/_app/einstellungen/konten")({
  beforeLoad: () => {
    throw redirect({ to: "/konten" });
  },
});
