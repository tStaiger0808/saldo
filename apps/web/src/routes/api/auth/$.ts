import { createFileRoute } from "@tanstack/react-router";
import { handleAuthRequest } from "../../../server/auth.ts";

const handle = ({ request }: { request: Request }) => handleAuthRequest(request);

export const Route = createFileRoute("/api/auth/$")({ server: { handlers: { GET: handle, POST: handle } } });
