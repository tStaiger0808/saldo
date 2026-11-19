/** Reading booking exports (CSV) of banks and card providers: parsing, column mapping and conversion to bookings. */
import { toCents } from "./money.ts";

export const CSV_DELIMITERS = [";", ",", "\t"] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];
export type DecimalSeparator = "comma" | "point";
/** `dmy` reads DD.MM.YYYY (also with "/" or a two-digit year), `ymd` reads YYYY-MM-DD. */
export type DateFormat = "dmy" | "ymd";

export type CsvMapping = {
  delimiter: CsvDelimiter;
  hasHeader: boolean;
  date: number;
  amount: number;
  payee: number | null;
  purpose: number | null;
  decimal: DecimalSeparator;
  dateFormat: DateFormat;
};

export const CSV_PRESETS = {
  /** German banks: semicolons, 1.234,56 and 31.12.2026. */
  de: { delimiter: ";", decimal: "comma", dateFormat: "dmy" },
  /** International exports: commas, 1,234.56 and 2026-12-31. */
  intl: { delimiter: ",", decimal: "point", dateFormat: "ymd" },
} as const satisfies Record<string, Pick<CsvMapping, "delimiter" | "decimal" | "dateFormat">>;
export type CsvPreset = keyof typeof CSV_PRESETS;

export const MAX_CSV_ROWS = 20_000;

/** RFC 4180 with the usual deviations: any of the delimiters, CRLF or LF, a BOM, blank lines skipped. */
export function parseCsv(text: string, delimiter: CsvDelimiter): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^﻿/, "");
  const endRow = () => {
    row.push(cell);
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
    cell = "";
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i++;
      endRow();
    } else cell += char;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/** The delimiter that splits the first lines most evenly into the most columns. */
export function detectDelimiter(text: string): CsvDelimiter {
  const sample = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, 5)
    .join("\n");
  let best: CsvDelimiter = ";";
  let bestScore = 0;
  for (const delimiter of CSV_DELIMITERS) {
    const widths = parseCsv(sample, delimiter).map((r) => r.length);
    const min = Math.min(...widths);
    const score = widths.length > 0 && widths.every((w) => w === widths[0]) ? min * 2 : min;
    if (min > 1 && score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

const pad = (n: number) => String(n).padStart(2, "0");

function validDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** An ISO date, or null when the text is no date in that format. */
export function parseCsvDate(text: string, format: DateFormat): string | null {
  const value = text.trim();
  if (format === "ymd") {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(value);
    return m ? validDate(Number(m[1]), Number(m[2]), Number(m[3])) : null;
  }
  const m = /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/.exec(value);
  if (!m) return null;
  const year = m[3]?.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return validDate(year, Number(m[2]), Number(m[1]));
}

/** Signed cents; currency signs, spaces and thousands separators are dropped, a trailing minus counts. */
export function parseCsvAmount(text: string, decimal: DecimalSeparator): number | null {
  let value = text.replace(/[\s  €$£]|EUR|USD|CHF/gi, "");
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  if (value.endsWith("-")) {
    negative = true;
    value = value.slice(0, -1);
  }
  if (value.startsWith("-")) {
    negative = !negative;
    value = value.slice(1);
  } else if (value.startsWith("+")) value = value.slice(1);
  const [thousands, point] = decimal === "comma" ? [".", ","] : [",", "."];
  if (!new RegExp(`^\\d{1,3}(\\${thousands}\\d{3})*(\\${point}\\d+)?$|^\\d+(\\${point}\\d+)?$`).test(value)) return null;
  try {
    const cents = toCents(value.split(thousands).join("").replace(point, "."));
    if (!Number.isSafeInteger(cents)) return null;
    return negative ? -cents : cents;
  } catch {
    return null;
  }
}

const HEADER_NAMES: Record<"date" | "amount" | "payee" | "purpose", string[]> = {
  date: ["buchungstag", "buchungsdatum", "datum", "date", "booking date", "transaction date", "data"],
  amount: ["betrag", "amount", "umsatz", "montant", "importo", "value"],
  payee: [
    "empfänger",
    "empfaenger",
    "auftraggeber",
    "begünstigter",
    "zahlungspflichtiger",
    "payee",
    "counterparty",
    "händler",
    "merchant",
    "name",
  ],
  purpose: ["verwendungszweck", "purpose", "description", "beschreibung", "buchungstext", "reference", "memo", "text", "details"],
};

function findColumn(header: string[], names: string[], taken: Set<number>): number | null {
  const cells = header.map((h) => h.trim().toLowerCase());
  for (const name of names) {
    const index = cells.findIndex((cell, i) => !taken.has(i) && cell.includes(name));
    if (index >= 0) return index;
  }
  return null;
}

/** A first guess for the mapping: preset by the separators the data uses, columns by their header names. */
export function guessMapping(text: string): CsvMapping {
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter).slice(0, 20);
  const preset = delimiter === ";" ? CSV_PRESETS.de : CSV_PRESETS.intl;
  const sample = rows.slice(1).flat();
  const dateFormat: DateFormat = sample.some((c) => parseCsvDate(c, "ymd"))
    ? "ymd"
    : sample.some((c) => parseCsvDate(c, "dmy"))
      ? "dmy"
      : preset.dateFormat;
  const header = rows[0] ?? [];
  const hasHeader = !header.some((c) => parseCsvDate(c, dateFormat));
  const taken = new Set<number>();
  const pick = (field: keyof typeof HEADER_NAMES, fallback: number | null) => {
    const found = hasHeader ? findColumn(header, HEADER_NAMES[field], taken) : null;
    const index = found ?? (fallback !== null && !taken.has(fallback) && fallback < header.length ? fallback : null);
    if (index !== null) taken.add(index);
    return index;
  };
  const date = pick("date", 0) ?? 0;
  const amount = pick("amount", null) ?? Math.max(header.length - 1, 0);
  return {
    delimiter,
    hasHeader,
    date,
    amount,
    payee: pick("payee", null),
    purpose: pick("purpose", null),
    decimal: preset.decimal,
    dateFormat,
  };
}

export type CsvBooking = { line: number; bookingDate: string; amountCents: number; counterparty: string; purpose: string };
export type CsvRowError = { line: number; field: "date" | "amount" };
export type CsvResult = { bookings: CsvBooking[]; errors: CsvRowError[]; tooMany: boolean };

// Imported text is only ever shown as text; control characters and runs of whitespace are cleaned all the same.
const cleanText = (value: string | undefined, max: number) =>
  (value ?? "")
    .replace(/\p{Cc}/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .slice(0, max);

/** Bookings of every readable row; rows without a valid date or amount are reported by their line number. */
export function readCsvBookings(text: string, mapping: CsvMapping): CsvResult {
  const rows = parseCsv(text, mapping.delimiter);
  const body = mapping.hasHeader ? rows.slice(1) : rows;
  const offset = mapping.hasHeader ? 2 : 1;
  const bookings: CsvBooking[] = [];
  const errors: CsvRowError[] = [];
  for (const [i, row] of body.slice(0, MAX_CSV_ROWS).entries()) {
    const line = i + offset;
    const bookingDate = parseCsvDate(row[mapping.date] ?? "", mapping.dateFormat);
    const amountCents = parseCsvAmount(row[mapping.amount] ?? "", mapping.decimal);
    if (!bookingDate) errors.push({ line, field: "date" });
    else if (amountCents === null) errors.push({ line, field: "amount" });
    else
      bookings.push({
        line,
        bookingDate,
        amountCents,
        counterparty: mapping.payee === null ? "" : cleanText(row[mapping.payee], 200),
        purpose: mapping.purpose === null ? "" : cleanText(row[mapping.purpose], 1000),
      });
  }
  return { bookings, errors, tooMany: body.length > MAX_CSV_ROWS };
}
