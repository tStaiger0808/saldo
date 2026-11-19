# Saldo – conventions for contributors and coding agents

Saldo is a self-hosted, read-only household finance app (no payments, ever), organised as a Bun monorepo. All code is
written for Saldo; never copy code from other projects.

## Layout

- `apps/web` – TanStack Start (React 19, file routes in `src/routes`), Nitro `node-server`.
  - `src/server/db/schema.ts` – the only Drizzle schema; migrations in `apps/web/drizzle` (`bun run db:generate`).
  - `src/server/modules/<area>/index.ts` – all server logic. Functions take `(db, viewer, input)` and are
    tested directly against PostgreSQL. Import other modules only via their `index.ts`.
  - `src/server/functions/<area>.ts` – thin `createServerFn` wrappers: `.middleware([authMiddleware|householdAdminMiddleware|superuserMiddleware])`,
    `.validator(zodSchema)`, `.handler(({ data, context }) => module(db(), context.user, data))`. No logic here.
  - `src/routes/api/**` – server routes (auth, health, MCP, CSV export and import, bank callback).
- `packages/core` – pure TypeScript domain logic (classification, transfers, statistics, money, CSV guard).
- `packages/banking` – bank provider clients (Enable Banking, FinTS via lib-fints) and mapping, no DB.

## Rules

- **Roles**: `superuser` (everything, incl. instance settings: bank access, SMTP, AI providers, audit log; sees all
  accounts), `familyAdmin` (household accounts and connections, groups, categories/tags/rules, members), `member` (own
  accounts and bank connections, shares). AI per person (`user.aiAllowed`, superusers always): `requireAi`.
- **Access**: every read and write of accounts/bookings/stats goes through `modules/access`
  (`visibleAccountIds`, `resolveView`, `checkAccounts`, `requireVisibleTransaction`, `requireManageableAccount`,
  `requireManageableConnection`, `requireSuperuser`, `requireHouseholdAdmin`). Accounts and connections have an owner
  and a visibility: household (via groups; family admins see all) or private (owner, superusers and explicit shares,
  directly or through a group). Never query `accounts`/`transactions` for a viewer without going through it; a hidden
  account, group, connection or booking is a 404, a visible one the viewer may not change a 403.
- **Viewing as someone else** (`modules/impersonation`): a superuser's session can act as another person, read-only.
  `sessionUser()` then returns that person, and guards in `server/middleware.ts` refuse every non-GET server function and
  request (except ending the view, sign-out and MCP). So GET server functions and GET routes must never change anything.
- **Errors**: throw `UserError`/`NotFound`/`Forbidden` (`src/server/errors.ts`) with a message key, `new UserError(msg("area.errors.x", vars), 409)`;
  the middleware translates it for the signed-in user. Zod custom messages are message keys, too. Raw provider texts may stay plain strings.
- **Money** is integer cents (`bigint` columns, JS numbers). Dates are ISO strings (`YYYY-MM-DD`).
- **Secrets** (PINs, bank state, keys, AI keys) only via `encrypt`/`decrypt` (`src/server/crypto.ts`), stored
  in `ciphertext` columns, never returned to the client, never logged.
- **Config** via `env()` (`src/server/env.ts`, zod). The bank return address is fixed: `bankRedirectUrl()`.
- **Code** in English (identifiers, comments, logs); comments only where the code cannot explain itself. Accessibility: WCAG 2.1 AA.
- **UI text** lives in `src/i18n/`: `de.ts` is the source (German first), `en.ts`/`fr.ts`/`it.ts` must `satisfy Messages`, so a
  missing key fails `typecheck`. Components use `useT()` / `useFormat()` (`src/i18n/react.tsx`); the server uses
  `t(locale, key, vars)` with `viewer.locale` (notifications: the recipient's `user.locale`, null → German). Plurals are
  `{ one, other }` objects chosen by `count`; money, dates and numbers only through the `Formatter` (`lib/format.ts`).
  French uses `\u202f` before `; ! ?` and inside « », `\u00a0` before `:`. User data (category, tag, rule, dashboard
  names) is never translated. MCP tool texts are English.
- **Tests**: Vitest next to the code (`*.test.ts`), DB tests use `resetDb()`/`makeUser()` from
  `src/server/test-helpers.ts` against the local test PostgreSQL (`TEST_DATABASE_URL`, default
  `postgres://finanzen:finanzen-test@127.0.0.1:54329/finanzen_test`). Never call real banks or AI providers in tests.
- **Checks** before handing work back: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.
- **Git**: never commit or push; the maintainer reviews first.
