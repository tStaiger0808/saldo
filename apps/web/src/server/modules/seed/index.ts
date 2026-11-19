import { eq, sql } from "drizzle-orm";
import { DEFAULT_LOCALE, type Messages, t } from "../../../i18n/index.ts";
import type { Locale } from "../../../i18n/locales.ts";
import type { Db } from "../../db/index.ts";
import { categories, type DashboardCard, dashboards, rules } from "../../db/schema.ts";
import type { Group, Viewer } from "../access/index.ts";

export const CATEGORIES: [name: string, kind: "expense" | "income" | "savings", color: string][] = [
  ["Wohnen", "expense", "#8b5cf6"],
  ["Lebensmittel", "expense", "#16a34a"],
  ["Restaurant & Café", "expense", "#f97316"],
  ["Mobilität", "expense", "#0ea5e9"],
  ["Versicherungen", "expense", "#64748b"],
  ["Abos & Medien", "expense", "#e11d48"],
  ["Shopping", "expense", "#d946ef"],
  ["Drogerie & Gesundheit", "expense", "#14b8a6"],
  ["Freizeit & Sport", "expense", "#eab308"],
  ["Reisen", "expense", "#06b6d4"],
  ["Bildung", "expense", "#6366f1"],
  ["Geschenke & Spenden", "expense", "#ec4899"],
  ["Bargeld", "expense", "#a3a3a3"],
  ["Gebühren & Zinsen", "expense", "#78716c"],
  ["Steuern & Abgaben", "expense", "#b45309"],
  ["Sonstiges", "expense", "#9ca3af"],
  ["Sparen & Investieren", "savings", "#059669"],
  ["Gehalt", "income", "#22c55e"],
  ["Erstattungen", "income", "#84cc16"],
  ["Zinsen & Dividenden", "income", "#10b981"],
  ["Sonstige Einnahmen", "income", "#4ade80"],
];

export const SEED_RULES: Record<string, string[]> = {
  Lebensmittel: ["rewe", "edeka", "aldi", "lidl", "kaufland", "netto", "penny", "feneberg", "tegut"],
  "Drogerie & Gesundheit": ["dm-drogerie", "dm drogerie", "rossmann", "müller", "apotheke"],
  "Abos & Medien": ["netflix", "spotify", "disney plus", "apple.com/bill", "youtube premium", "audible"],
  Mobilität: ["db vertrieb", "deutsche bahn", "aral", "shell", "esso", "totalenergies", "jet tankstelle"],
  Versicherungen: ["allianz", "huk-coburg", "huk coburg", "axa", "ergo versicherung"],
  Shopping: ["amazon", "zalando", "ikea", "mediamarkt", "otto"],
  "Restaurant & Café": ["lieferando", "mcdonalds", "starbucks"],
  Bargeld: ["bargeldauszahlung", "geldautomat", "atm"],
  Gehalt: ["gehalt", "lohn/gehalt"],
  "Sparen & Investieren": ["sparplan", "wertpapier"],
};

/** The first dashboards of a user, titled in their language; afterwards the titles are the user's own data. */
export function defaultCards(locale: Locale): DashboardCard[] {
  const title = (key: keyof Messages["dashboard"]["seed"]) => t(locale, `dashboard.seed.${key}`);
  return [
    { id: "summary", type: "summary", title: title("summary"), width: "full", options: { period: "dashboard" } },
    { id: "recent", type: "recent_transactions", title: title("recent"), width: "half", options: { limit: 8 } },
    {
      id: "categories",
      type: "category_breakdown",
      title: title("categories"),
      width: "half",
      options: { period: "dashboard", kind: "expense" },
    },
    { id: "trend", type: "monthly_trend", title: title("trend"), width: "full", options: { period: "last_12_months" } },
    { id: "top", type: "top_counterparties", title: title("top"), width: "half", options: { period: "last_3_months", limit: 8 } },
    { id: "balances", type: "balances", title: title("balances"), width: "half", options: {} },
  ];
}

export async function seedDefaults(db: Db): Promise<void> {
  if ((await db.select({ id: categories.id }).from(categories).limit(1)).length > 0) return;
  const inserted = await db
    .insert(categories)
    .values(CATEGORIES.map(([name, kind, color], position) => ({ name, kind, color, position })))
    .returning({ id: categories.id, name: categories.name });
  const byName = new Map(inserted.map((c) => [c.name, c.id]));
  await db.insert(rules).values(
    Object.entries(SEED_RULES).flatMap(([category, patterns]) =>
      patterns.map((pattern) => ({
        pattern,
        field: "any" as const,
        categoryId: byName.get(category) ?? null,
        priority: 10,
        source: "seed" as const,
      })),
    ),
  );
}

/** A user without dashboards gets one for all visible accounts and one per visible group. */
export async function ensureDashboards(db: Db, viewer: Viewer, groups: Group[]): Promise<void> {
  await db.transaction(async (tx) => {
    // Parallel first page loads of the same user must not each create the defaults.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`dashboards:${viewer.id}`}))`);
    const locale = viewer.locale ?? DEFAULT_LOCALE;
    const cards = defaultCards(locale);
    if ((await tx.select({ id: dashboards.id }).from(dashboards).where(eq(dashboards.ownerId, viewer.id)).limit(1)).length > 0) return;
    await tx
      .insert(dashboards)
      .values([
        { ownerId: viewer.id, groupId: null, name: t(locale, "common.allAccounts"), position: 0, cards },
        ...groups.map((g, i) => ({ ownerId: viewer.id, groupId: g.id, name: g.name, position: i + 1, cards })),
      ]);
  });
}
