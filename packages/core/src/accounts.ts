/** What a bank says about an account (name, product, ISO 20022 cash account type), turned into a Saldo account. */
export type AccountKindGuess = "checking" | "savings" | "credit_card" | "brokerage" | "prepaid";

const KIND_HINTS: [AccountKindGuess, RegExp][] = [
  ["credit_card", /\b(card|kreditkarte|credit|visa|mastercard|amex)\b|^card$/i],
  ["brokerage", /depot|wertpapier|broker|securities|invest|aktien|etf/i],
  ["savings", /tagesgeld|festgeld|spar|savings|^svgs$|^sacc$|^onds$|extra-konto/i],
  ["prepaid", /prepaid|gutschein|voucher|guthabenkarte/i],
];

export function guessAccountKind(remote: { name?: string | null; product?: string | null; type?: string | null }): AccountKindGuess {
  const type = (remote.type ?? "").trim().toUpperCase();
  if (type === "CARD") return "credit_card";
  if (type === "SVGS" || type === "ONDP" || type === "MOMA") return "savings";
  // Set by our own clients: FinTS securities accounts and unofficial depots, prepaid cards named "… Card".
  if (type === "DEPOT") return "brokerage";
  if (type === "PREPAID") return "prepaid";
  const text = [remote.product, remote.name].filter(Boolean).join(" ");
  for (const [kind, pattern] of KIND_HINTS) if (pattern.test(text) || pattern.test(type)) return kind;
  return "checking";
}

/** The bank's name for the account, or the bank and the last four IBAN digits when the bank names none. */
export function remoteAccountName(remote: { name?: string | null; product?: string | null; iban?: string | null }, bank: string): string {
  const iban = (remote.iban ?? "").replace(/\s+/g, "");
  const named = [remote.name, remote.product]
    .map((v) => (v ?? "").trim())
    .find((v) => v && v !== "Konto" && v.replace(/\s+/g, "") !== iban);
  if (named) return named.slice(0, 100);
  return (iban ? `${bank} ${iban.slice(-4)}` : bank).slice(0, 100);
}
