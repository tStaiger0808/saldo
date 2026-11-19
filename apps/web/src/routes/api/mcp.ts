import { createFileRoute } from "@tanstack/react-router";
import { clientIp } from "../../server/client-ip.ts";
import { db } from "../../server/db/index.ts";
import { handleMcpRequest } from "../../server/modules/mcp/index.ts";

const handle = ({ request }: { request: Request }) => handleMcpRequest(db(), request, clientIp(request));

export const Route = createFileRoute("/api/mcp")({
  server: { handlers: { POST: handle, GET: handle, DELETE: handle } },
});
