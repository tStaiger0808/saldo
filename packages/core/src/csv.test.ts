import { describe, expect, it } from "vitest";
import { CSV_PRESETS, detectDelimiter, guessMapping, parseCsv, parseCsvAmount, parseCsvDate, readCsvBookings } from "./csv.ts";

const GIVVE = `﻿Datum;Händler;Beschreibung;Betrag
05.11.2026;REWE Markt;"Einkauf; Filiale 12";-23,45
01.11.2026;givve;Aufladung November;50,00
"31.10.2026";"Bäckerei ""Krume""";;-3,20
`;

describe("CSV import", () => {
  it("parses quotes, escaped quotes, delimiters inside quotes, CRLF, a BOM and blank lines", () => {
    expect(parseCsv('a;"b;c";"d ""e"""\r\n\r\n1;2;3', ";")).toEqual([
      ["a", "b;c", 'd "e"'],
      ["1", "2", "3"],
    ]);
    expect(detectDelimiter(GIVVE)).toBe(";");
    expect(detectDelimiter("date,amount,payee\n2026-11-01,-1.5,Shop")).toBe(",");
    expect(detectDelimiter("date\tamount\n2026-11-01\t-1.5")).toBe("\t");
  });

  it("reads dates as DD.MM.YYYY or YYYY-MM-DD and rejects impossible ones", () => {
    expect(parseCsvDate("05.11.2026", "dmy")).toBe("2026-11-05");
    expect(parseCsvDate("5/11/26", "dmy")).toBe("2026-11-05");
    expect(parseCsvDate("2026-11-05", "ymd")).toBe("2026-11-05");
    expect(parseCsvDate("2026-11-05T10:00:00Z", "ymd")).toBe("2026-11-05");
    expect(parseCsvDate("31.02.2026", "dmy")).toBeNull();
    expect(parseCsvDate("2026-11-05", "dmy")).toBeNull();
    expect(parseCsvDate("Datum", "dmy")).toBeNull();
  });

  it("reads amounts with decimal comma or point, thousands separators, signs and currency", () => {
    expect(parseCsvAmount("-1.234,56", "comma")).toBe(-123_456);
    expect(parseCsvAmount("1 234,5 €", "comma")).toBe(123_450);
    expect(parseCsvAmount("12,34-", "comma")).toBe(-1_234);
    expect(parseCsvAmount("-1,234.56", "point")).toBe(-123_456);
    expect(parseCsvAmount("(12.00)", "point")).toBe(-1_200);
    expect(parseCsvAmount("+7", "point")).toBe(700);
    expect(parseCsvAmount("1,234.56", "comma")).toBeNull();
    expect(parseCsvAmount("abc", "comma")).toBeNull();
    expect(parseCsvAmount("", "comma")).toBeNull();
  });

  it("guesses the mapping from the header and the data", () => {
    expect(guessMapping(GIVVE)).toEqual({ hasHeader: true, date: 0, amount: 3, payee: 1, purpose: 2, ...CSV_PRESETS.de });
    expect(guessMapping("Date,Description,Amount\n2026-11-01,Coffee,-3.50")).toMatchObject({
      delimiter: ",",
      hasHeader: true,
      date: 0,
      amount: 2,
      purpose: 1,
      decimal: "point",
      dateFormat: "ymd",
    });
    expect(guessMapping("01.11.2026;-3,50\n02.11.2026;4,00")).toMatchObject({ hasHeader: false, date: 0, amount: 1 });
  });

  it("turns rows into bookings, cleans text and reports unreadable rows by line", () => {
    const result = readCsvBookings(`${GIVVE}kaputt;x;y;z\n06.11.2026;Kiosk\u0007;;nix\n`, guessMapping(GIVVE));
    expect(result.bookings).toEqual([
      { line: 2, bookingDate: "2026-11-05", amountCents: -2_345, counterparty: "REWE Markt", purpose: "Einkauf; Filiale 12" },
      { line: 3, bookingDate: "2026-11-01", amountCents: 5_000, counterparty: "givve", purpose: "Aufladung November" },
      { line: 4, bookingDate: "2026-10-31", amountCents: -320, counterparty: 'Bäckerei "Krume"', purpose: "" },
    ]);
    expect(result.errors).toEqual([
      { line: 5, field: "date" },
      { line: 6, field: "amount" },
    ]);
    expect(result.tooMany).toBe(false);
  });
});
