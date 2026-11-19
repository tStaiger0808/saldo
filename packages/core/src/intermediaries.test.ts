import { describe, expect, it } from "vitest";
import { merchantFromPurpose, paymentIntermediary } from "./intermediaries.ts";

describe("payment intermediaries", () => {
  it("recognizes the spellings banks use, whatever case, accents and punctuation", () => {
    for (const name of [
      "PayPal Europe S.a.r.l. et Cie S.C.A",
      "PayPal (Europe) S.a r.l. et Cie, S.C.A.",
      "PayPal (Europe) S.à r.l. et Cie, SCA",
      "PAYPAL",
    ]) {
      expect(paymentIntermediary(name), name).toBe("PayPal");
    }
    expect(paymentIntermediary("Riverty Bank S.A.")).toBe("Riverty");
    expect(paymentIntermediary("AfterPay")).toBe("AfterPay");
    expect(paymentIntermediary("SumUp Payments Limited")).toBe("SumUp");
    expect(paymentIntermediary("Klarna Bank AB (publ)")).toBe("Klarna");
    expect(paymentIntermediary("AMAZON PAYMENTS EUROPE S.C.A.")).toBe("Amazon Payments");
    expect(paymentIntermediary("Stripe Payments Europe Ltd")).toBe("Stripe");
    expect(paymentIntermediary("Adyen N.V.")).toBe("Adyen");
    expect(paymentIntermediary("Mollie B.V.")).toBe("Mollie");
    expect(paymentIntermediary("Unzer E-Com GmbH")).toBe("Unzer");
    expect(paymentIntermediary("Computop Paygate GmbH")).toBe("Computop");
    expect(paymentIntermediary("Google Payment Ireland Limited")).toBe("Google Pay");
    expect(paymentIntermediary("VISA Debitkartenumsatz")).toBe("Visa");
    expect(paymentIntermediary("Mastercard Europe")).toBe("Mastercard");
  });

  it("leaves merchants alone, also when a payment service is only part of their card text", () => {
    for (const name of [
      "AMAZON EU S.A R.L.",
      "REWE Markt GmbH",
      "Spotify AB",
      "PAYPAL *SPOTIFY 35314369001",
      "Visana Versicherung",
      "",
      "Sofortbild GmbH",
    ]) {
      expect(paymentIntermediary(name), name).toBeNull();
    }
  });

  it("reads the merchant from a payment service's purpose", () => {
    expect(merchantFromPurpose("1043567891234 PP.6543.PP . Spotify AB, Ihr Einkauf bei Spotify AB")).toBe("Spotify AB");
    expect(merchantFromPurpose("1043567891234/PP.6543.PP/. Zalando SE, Ihr Einkauf bei Zalando SE")).toBe("Zalando SE");
    expect(merchantFromPurpose("PP.1234.PP . Deutsche Bahn AG")).toBe("Deutsche Bahn AG");
    expect(merchantFromPurpose("PAYPAL *STEAM GAMES 35314369001")).toBe("STEAM GAMES");
    expect(merchantFromPurpose("SumUp *Baeckerei Mayer, Immenstadt")).toBe("Baeckerei Mayer");
    expect(merchantFromPurpose("Rueckzahlung Ihre Erstattung von Otto GmbH & Co KG, Referenz 1234")).toBe("Otto GmbH & Co KG");
  });

  it("finds no merchant in references, payment service names or plain texts", () => {
    expect(merchantFromPurpose("PayPal Ueberweisung 4711")).toBe("");
    expect(merchantFromPurpose("PP.1234.PP . PayPal Europe")).toBe("");
    expect(merchantFromPurpose("PP.1234.PP . 12345")).toBe("");
    expect(merchantFromPurpose("")).toBe("");
  });
});

describe("card wrappers that name the merchant", () => {
  it("treats SumUp/PayPal names with the shop after dots or a star as the shop itself", () => {
    for (const name of [
      "SumUp...Stadtle.Kebap/Immenstadt",
      "SUMUP...CORRAN.COFFEE/UIG",
      "PAYPAL *SPOTIFY 3531",
      "SumUp *Baeckerei Mayer",
    ]) {
      expect(paymentIntermediary(name)).toBeNull();
    }
    for (const name of ["PayPal (Europe) S.a r.l. et Cie, S.C.A.", "Riverty Bank S.A.", "PAYPAL", "SumUp Payments Ltd"]) {
      expect(paymentIntermediary(name)).not.toBeNull();
    }
  });
});
