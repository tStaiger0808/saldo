import { createFileRoute } from "@tanstack/react-router";
import { ShortcutSettings } from "../../../components/ShortcutSettings.tsx";

export const Route = createFileRoute("/_app/persoenlich/tastenkuerzel")({ component: ShortcutSettings });
