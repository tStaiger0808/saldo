import { createFileRoute } from "@tanstack/react-router";
import { PasswordForm } from "../../../components/PasswordForm.tsx";

export const Route = createFileRoute("/_app/persoenlich/passwort")({ component: PasswordForm });
