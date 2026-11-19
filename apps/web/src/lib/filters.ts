import type { Translate } from "../i18n/index.ts";
import type { Formatter } from "./format.ts";
import type { Period } from "./periods.ts";

export type FilterValue = string | number | boolean | undefined;
export type FilterValues = Readonly<Record<string, FilterValue>>;

/** `chip` replaces "Label: option" in the chip when the option reads well on its own ("Nur Ausgänge"). */
export type FilterOption = { value: string | number; label: string; chip?: string };

/** One control in the filter dialog; its search parameter keys are left out (undefined) while it is not in use. */
export type FilterDef =
  | { kind: "select"; key: string; label: string; anyLabel: string; options: readonly FilterOption[] }
  | { kind: "flag"; key: string; label: string }
  | { kind: "dateRange"; from: string; to: string; label: string }
  /** Euro bounds (`from`/`to`) on the amount regardless of its sign. */
  | { kind: "amountRange"; from: string; to: string; label: string }
  /** A relative period (`key`) or, as "custom", fixed dates (`from`/`to`); the period wins when both are set. */
  | { kind: "period"; key: string; from: string; to: string; label: string; anyLabel: string; options: readonly FilterOption[] };

/** The free-text search, shown inline and as the last chip. */
export type SearchDef = { key: string; label: string };

export type FilterChip = { id: string; text: string; keys: string[] };

const isSet = (value: FilterValue) => value !== undefined && value !== "" && value !== false;

export function filterKeys(def: FilterDef): string[] {
  if (def.kind === "period") return [def.key, def.from, def.to];
  return def.kind === "dateRange" || def.kind === "amountRange" ? [def.from, def.to] : [def.key];
}

function rangeText(from: FilterValue, to: FilterValue, t: Translate, f: Formatter): string | null {
  if (isSet(from) && isSet(to)) return t("filters.range", { from: f.date(String(from)), to: f.date(String(to)) });
  if (isSet(from)) return t("filters.rangeFrom", { date: f.date(String(from)) });
  if (isSet(to)) return t("filters.rangeTo", { date: f.date(String(to)) });
  return null;
}

function amountText(from: FilterValue, to: FilterValue, t: Translate, f: Formatter): string | null {
  const euro = (value: FilterValue) => f.euro(Math.round(Number(value) * 100));
  if (isSet(from) && isSet(to)) return t("filters.range", { from: euro(from), to: euro(to) });
  if (isSet(from)) return t("filters.amountFrom", { amount: euro(from) });
  if (isSet(to)) return t("filters.amountTo", { amount: euro(to) });
  return null;
}

export function activeFilterCount(defs: readonly FilterDef[], values: FilterValues): number {
  return defs.filter((def) => filterKeys(def).some((key) => isSet(values[key]))).length;
}

/** The dialog's own copy of the values: only its keys, unset ones left out. */
export function pickFilterValues(defs: readonly FilterDef[], values: FilterValues): FilterValues {
  return Object.fromEntries(defs.flatMap(filterKeys).map((key) => [key, isSet(values[key]) ? values[key] : undefined]));
}

/** A patch that clears the given keys. */
export function clearKeys(keys: readonly string[]): FilterValues {
  return Object.fromEntries(keys.map((key) => [key, undefined]));
}

function chipText(def: FilterDef, values: FilterValues, t: Translate, f: Formatter): string | null {
  switch (def.kind) {
    case "select": {
      const value = values[def.key];
      if (!isSet(value)) return null;
      const option = def.options.find((o) => String(o.value) === String(value));
      return option?.chip ?? t("filters.chip", { label: def.label, value: option?.label ?? String(value) });
    }
    case "flag":
      return isSet(values[def.key]) ? def.label : null;
    case "dateRange": {
      const range = rangeText(values[def.from], values[def.to], t, f);
      return range && t("filters.chip", { label: def.label, value: range });
    }
    case "amountRange": {
      const range = amountText(values[def.from], values[def.to], t, f);
      return range && t("filters.chip", { label: def.label, value: range });
    }
    case "period": {
      const preset = values[def.key];
      const option = isSet(preset) ? def.options.find((o) => String(o.value) === String(preset)) : undefined;
      const range = option ? option.label : rangeText(values[def.from], values[def.to], t, f);
      return range && t("filters.chip", { label: def.label, value: range });
    }
  }
}

/** Active filters as removable chips, in the order of the definitions and the search last; defaults show no chip. */
export function filterChips(
  defs: readonly FilterDef[],
  values: FilterValues,
  search: SearchDef | null,
  t: Translate,
  f: Formatter,
): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const def of defs) {
    const text = chipText(def, values, t, f);
    const keys = filterKeys(def);
    if (text) chips.push({ id: keys.join("+"), text, keys });
  }
  const q = search ? values[search.key] : undefined;
  if (search && typeof q === "string" && q) {
    chips.push({ id: search.key, text: t("filters.searchChip", { label: search.label, value: q }), keys: [search.key] });
  }
  return chips;
}

export function categoryFilter(t: Translate, categories: readonly { id: number; name: string }[]): FilterDef {
  return {
    kind: "select",
    key: "kategorie",
    label: t("common.fields.category"),
    anyLabel: t("transactions.filter.allCategories"),
    options: categories.map((c) => ({ value: c.id, label: c.name })),
  };
}

export function directionFilter(t: Translate): FilterDef {
  return {
    kind: "select",
    key: "richtung",
    label: t("transactions.filter.direction"),
    anyLabel: t("transactions.filter.directionAll"),
    options: [
      { value: "ein", label: t("transactions.filter.directionIn"), chip: t("transactions.filter.directionInChip") },
      { value: "aus", label: t("transactions.filter.directionOut"), chip: t("transactions.filter.directionOutChip") },
    ],
  };
}

export function periodFilter(t: Translate, periods: readonly Period[]): FilterDef {
  return {
    kind: "period",
    key: "zeitraum",
    from: "von",
    to: "bis",
    label: t("common.fields.period"),
    anyLabel: t("transactions.filter.anyPeriod"),
    options: periods.map((value) => ({ value, label: t(`periods.${value}`) })),
  };
}

export function amountFilter(t: Translate): FilterDef {
  return { kind: "amountRange", from: "betragAb", to: "betragBis", label: t("transactions.filter.amount") };
}

export function groupFilter(t: Translate, groups: readonly { id: number; name: string }[]): FilterDef {
  return {
    kind: "select",
    key: "gruppe",
    label: t("common.fields.group"),
    anyLabel: t("common.allAccounts"),
    options: groups.map((g) => ({ value: g.id, label: g.name })),
  };
}

export function tagFilter(t: Translate, tags: readonly { id: number; name: string }[]): FilterDef {
  return {
    kind: "select",
    key: "tag",
    label: t("common.fields.tag"),
    anyLabel: t("transactions.filter.allTags"),
    options: tags.map((tag) => ({ value: tag.id, label: tag.name })),
  };
}
