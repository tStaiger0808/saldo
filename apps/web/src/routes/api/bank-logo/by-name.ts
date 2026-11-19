import { createFileRoute } from "@tanstack/react-router";
import { sessionUser } from "../../../server/auth.ts";
import { db } from "../../../server/db/index.ts";
import { UserError } from "../../../server/errors.ts";
import { bankLogoInput, bankLogoResponse, enableBankingLogo, noBankLogoResponse } from "../../../server/modules/banking/index.ts";

export const Route = createFileRoute("/api/bank-logo/by-name")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const user = await sessionUser(request.headers);
        if (!user) return noBankLogoResponse(401);
        const query = new URL(request.url).searchParams;
        const input = bankLogoInput.safeParse({ country: query.get("country") ?? "", name: query.get("name") ?? "" });
        if (!input.success) return noBankLogoResponse(404);
        try {
          const logo = await enableBankingLogo(db(), user, input.data);
          return logo ? bankLogoResponse(logo) : noBankLogoResponse(404);
        } catch (error) {
          if (error instanceof UserError) return noBankLogoResponse(error.status);
          throw error;
        }
      },
    },
  },
});
