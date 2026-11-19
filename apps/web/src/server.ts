import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { withBodyLimits } from "./server/body-limit.ts";

// Body limits wrap the whole app: request middleware cannot hand route handlers a different request to read from.
export default createServerEntry({ fetch: withBodyLimits((request) => handler.fetch(request)) });
