import { describe, expect, it } from "vitest";
import { z } from "zod";
import { msg } from "../i18n/index.ts";
import { Forbidden, localizeError, NotFound, UserError, userMessage } from "./errors.ts";
import { usernameSchema } from "./modules/users/index.ts";

describe("server error translation", () => {
  it("keeps German as the default message", () => {
    expect(new UserError(msg("users.errors.usernameTaken"), 409).message).toBe("Diesen Benutzernamen gibt es schon");
    expect(new Forbidden().message).toBe("Nur für Super-User und Familien-Admins");
    expect(new NotFound().status).toBe(404);
  });

  it("translates a UserError for the reader and keeps its status", () => {
    const error = localizeError(new UserError(msg("users.errors.lastSuperuser")), "fr") as UserError;
    expect(error.message).toBe("Il doit y avoir au moins un super-utilisateur");
    expect(error.status).toBe(400);
    expect((localizeError(new NotFound(msg("errors.accountNotFound")), "it") as UserError).message).toBe("Conto non trovato");
  });

  it("leaves raw provider texts as they are", () => {
    expect((localizeError(new UserError("Bank says no", 502), "en") as UserError).message).toBe("Bank says no");
  });

  it("translates zod issues that carry a message key, from parse() and from server function validators", () => {
    const parsed = usernameSchema.safeParse("x");
    expect(parsed.success).toBe(false);
    const fromParse = localizeError(parsed.error, "en");
    expect(fromParse).toBeInstanceOf(UserError);
    expect((fromParse as UserError).message).toBe("Username: 3 to 30 characters, only letters, digits, full stop and underscore");

    const fromValidator = new Error(JSON.stringify(parsed.error?.issues, undefined, 2));
    expect((localizeError(fromValidator, "it") as UserError).message).toMatch(/^Nome utente/);
  });

  it("passes other errors through unchanged", () => {
    const plain = new Error("boom");
    expect(localizeError(plain, "en")).toBe(plain);
    const zodDefault = z.string().safeParse(1).error;
    expect(localizeError(zodDefault, "en")).toBe(zodDefault);
  });

  it("gives a safe text for any error", () => {
    expect(userMessage(new Error("internal detail"), "en")).toBe("That didn’t work. Please try again later.");
    expect(userMessage(new UserError(msg("errors.notSignedIn"), 401), "it")).toBe("Accesso non effettuato");
  });
});
