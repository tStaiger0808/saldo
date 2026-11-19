const euro = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });

export function formatCents(cents: number, currency = "EUR"): string {
  if (currency === "EUR") return euro.format(cents / 100);
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}

/** Parses a decimal amount ("12.34", "-0,5", 7) into integer cents without float drift. */
export function toCents(amount: string | number): number {
  const text = String(amount).trim().replace(",", ".");
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) throw new Error(`Unlesbarer Betrag: ${amount}`);
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = text.replace(/^[+-]/, "").split(".");
  const rounded = Number(whole) * 100 + Number(`${fraction}000`.slice(0, 2)) + (Number(fraction[2] ?? 0) >= 5 ? 1 : 0);
  return negative ? -rounded : rounded;
}
