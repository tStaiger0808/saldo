import { DEFAULT_LOCALE, INTL_LOCALES, LOCALES, type Locale } from "../i18n/locales.ts";

/** Money, numbers and dates in one reader's language; get it from `useFormat()` or `formatter(locale)` on the server. */
export type Formatter = {
  locale: Locale;
  euro(cents: number, currency?: string): string;
  euroWhole(cents: number): string;
  /** With an explicit plus sign, so incoming and outgoing amounts read apart without colour. */
  signed(cents: number, currency?: string): string;
  /** Sub-cent prices such as AI usage, `micro` in millionths of the currency unit. */
  micro(micro: number, currency: string): string;
  integer(value: number): string;
  decimal(value: number, maximumFractionDigits?: number): string;
  percent(value: number, maximumFractionDigits?: number): string;
  /** `YYYY-MM-DD` as a short local date, without timezone surprises. */
  date(iso: string | null | undefined): string;
  dateTime(value: string | Date | null | undefined): string;
  /** Day and month only, for chart axes. */
  dayShort(iso: string): string;
  /** Weekday and full date, for day headings in booking lists. */
  dayLong(iso: string): string;
  monthShort(key: string): string;
  monthLong(key: string): string;
  /** Year of a date or month key, for chart axes. */
  year(key: string): string;
  /** Two `YYYY-MM-DD` days as one short range ("28.08.–17.11.2026"). */
  dateRange(from: string, to: string): string;
  /** Chart axis label for cents in whole euros, compact for large values ("12 Tsd."). */
  axis(cents: number): string;
  /** A file size in decimal units ("1,4 MB"). */
  bytes(value: number): string;
};

const BYTE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const;

function monthDate(key: string): Date {
  return new Date(`${key.slice(0, 7)}-01T00:00:00Z`);
}

function create(locale: Locale): Formatter {
  const tag = INTL_LOCALES[locale];
  const euro = new Intl.NumberFormat(tag, { style: "currency", currency: "EUR" });
  const euroWhole = new Intl.NumberFormat(tag, { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const integer = new Intl.NumberFormat(tag);
  const percent = new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits: 0 });
  const date = new Intl.DateTimeFormat(tag, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
  const dateTime = new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" });
  const dayShort = new Intl.DateTimeFormat(tag, { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const dayLong = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const monthShort = new Intl.DateTimeFormat(tag, { month: "short", timeZone: "UTC" });
  const monthLong = new Intl.DateTimeFormat(tag, { month: "long", year: "numeric", timeZone: "UTC" });
  const year = new Intl.DateTimeFormat(tag, { year: "numeric", timeZone: "UTC" });
  const axisCompact = new Intl.NumberFormat(tag, { notation: "compact", maximumFractionDigits: 1 });
  const axisWhole = new Intl.NumberFormat(tag, { maximumFractionDigits: 0 });

  const formatEuro = (cents: number, currency = "EUR") =>
    currency === "EUR" ? euro.format(cents / 100) : new Intl.NumberFormat(tag, { style: "currency", currency }).format(cents / 100);

  return {
    locale,
    euro: formatEuro,
    euroWhole: (cents) => euroWhole.format(cents / 100),
    signed(cents, currency) {
      const text = formatEuro(Math.abs(cents), currency);
      if (cents > 0) return `+${text}`;
      if (cents < 0) return `−${text}`;
      return text;
    },
    micro: (value, currency) =>
      new Intl.NumberFormat(tag, { style: "currency", currency, maximumFractionDigits: 4 }).format(value / 1_000_000),
    integer: (value) => integer.format(value),
    decimal: (value, maximumFractionDigits = 2) => new Intl.NumberFormat(tag, { maximumFractionDigits }).format(value),
    percent: (value, maximumFractionDigits = 0) =>
      maximumFractionDigits === 0
        ? percent.format(value)
        : new Intl.NumberFormat(tag, { style: "percent", maximumFractionDigits }).format(value),
    date(iso) {
      if (!iso) return "–";
      return date.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));
    },
    dateTime(value) {
      if (!value) return "–";
      return dateTime.format(typeof value === "string" ? new Date(value) : value);
    },
    dayShort: (iso) => dayShort.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)),
    dayLong: (iso) => dayLong.format(new Date(`${iso.slice(0, 10)}T00:00:00Z`)),
    // German short months carry a dot ("Nov."), which reads as noise on a chart axis.
    monthShort: (key) => monthShort.format(monthDate(key)).replace(".", ""),
    monthLong: (key) => monthLong.format(monthDate(key)),
    year: (key) => year.format(monthDate(key)),
    dateRange: (from, to) => date.formatRange(new Date(`${from.slice(0, 10)}T00:00:00Z`), new Date(`${to.slice(0, 10)}T00:00:00Z`)),
    axis(cents) {
      const euros = cents / 100;
      return Math.abs(euros) >= 10_000 ? axisCompact.format(euros) : axisWhole.format(euros);
    },
    bytes(value) {
      const exponent = Math.min(BYTE_UNITS.length - 1, Math.max(0, Math.floor(Math.log10(Math.max(1, value)) / 3)));
      return new Intl.NumberFormat(tag, {
        style: "unit",
        unit: BYTE_UNITS[exponent],
        unitDisplay: "short",
        maximumFractionDigits: exponent === 0 ? 0 : 1,
      }).format(value / 1000 ** exponent);
    },
  };
}

const FORMATTERS = Object.fromEntries(LOCALES.map((locale) => [locale, create(locale)])) as Record<Locale, Formatter>;

export function formatter(locale: Locale = DEFAULT_LOCALE): Formatter {
  return FORMATTERS[locale];
}
