import { createFileRoute } from "@tanstack/react-router";
import { sessionUser } from "../../../server/auth.ts";
import { db } from "../../../server/db/index.ts";
import { UserError } from "../../../server/errors.ts";
import { bankLogoResponse, connectionLogo, noBankLogoResponse } from "../../../server/modules/banking/index.ts";

export const Route = createFileRoute("/api/bank-logo/$connectionId")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const user = await sessionUser(request.headers);
        if (!user) return noBankLogoResponse(401);
        const id = Number(params.connectionId);
        if (!Number.isSafeInteger(id)) return noBankLogoResponse(404);
        try {
          const logo = await connectionLogo(db(), user, { id });
          return logo ? bankLogoResponse(logo) : noBankLogoResponse(404);
        } catch (error) {
          if (error instanceof UserError) return noBankLogoResponse(error.status);
          throw error;
        }
      },
    },
  },
});
