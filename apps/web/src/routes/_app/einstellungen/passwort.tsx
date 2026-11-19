import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/einstellungen/passwort")({
  beforeLoad: () => {
    throw redirect({ to: "/persoenlich/passwort" });
  },
});
