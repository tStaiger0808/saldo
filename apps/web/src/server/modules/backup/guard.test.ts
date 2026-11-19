import { describe, expect, it } from "vitest";
import { restorableList } from "./guard.ts";

/** Lines as `pg_restore --list` prints them for Saldo's own dump. */
const OWN = `;
; Archive created at 2026-11-19 13:29:18 UTC
;     Format: CUSTOM
;
; Selected TOC Entries:
;
7; 2615 6230912 SCHEMA - drizzle saldo
6; 2615 6230911 SCHEMA - public saldo
4055; 0 0 COMMENT - SCHEMA public saldo
4056; 0 0 ACL - SCHEMA public saldo
2; 3079 6231321 EXTENSION - unaccent 
4057; 0 0 COMMENT - EXTENSION unaccent 
220; 1259 6230914 TABLE drizzle __drizzle_migrations saldo
219; 1259 6230913 SEQUENCE drizzle __drizzle_migrations_id_seq saldo
4058; 0 0 SEQUENCE OWNED BY drizzle __drizzle_migrations_id_seq saldo
221; 1259 6230922 TABLE public user saldo
3523; 2604 6230917 DEFAULT drizzle __drizzle_migrations id saldo
3976; 0 6230914 TABLE DATA drizzle __drizzle_migrations saldo
3977; 0 6230922 TABLE DATA public user saldo
4059; 0 0 SEQUENCE SET drizzle __drizzle_migrations_id_seq saldo
3631; 2606 6230921 CONSTRAINT drizzle __drizzle_migrations __drizzle_migrations_pkey saldo
3700; 1259 6231000 INDEX public transactions_account_date_idx saldo
3800; 2606 6231100 FK CONSTRAINT public accounts accounts_owner_user_id_user_id_fk saldo
`;

describe("restorable dump entries", () => {
  it("keeps tables, data, sequences, defaults, indexes and constraints of public and drizzle, in order", () => {
    const kept = restorableList(OWN).trim().split("\n");
    expect(kept.map((line) => line.split(";")[0])).toEqual([
      "7",
      "220",
      "219",
      "4058",
      "221",
      "3523",
      "3976",
      "3977",
      "4059",
      "3631",
      "3700",
      "3800",
    ]);
  });

  it.each([
    "300; 1255 7000 FUNCTION public stolen() saldo",
    "301; 1255 7001 PROCEDURE public run() saldo",
    "302; 3079 7002 EXTENSION - plpython3u ",
    "303; 2620 7003 TRIGGER public settings stolen saldo",
    "304; 3466 7004 EVENT TRIGGER - on_ddl saldo",
    "305; 2618 7005 RULE public settings take saldo",
    "306; 0 0 ACL public TABLE settings saldo",
    "307; 2613 7006 LARGE OBJECT - 7006 saldo",
    "308; 6104 7007 PUBLICATION - everything saldo",
    "309; 6100 7008 SUBSCRIPTION - pull saldo",
    "310; 1259 7009 TABLE elsewhere notes saldo",
    "311; 2615 7010 SCHEMA - elsewhere saldo",
    "312; 1259 7011 VIEW public peek saldo",
    "313; 1247 7012 TYPE public mood saldo",
    "314; 0 0 COMMENT public TABLE settings saldo",
    "315; 0 7013 TABLE DATA elsewhere notes saldo",
    "not a list line",
  ])("refuses %s", (line) => {
    expect(() => restorableList(`${OWN}${line}\n`)).toThrow(
      expect.objectContaining({ text: expect.objectContaining({ key: "backup.errors.unsafeDump" }) }),
    );
  });

  it("refuses an empty list", () => {
    expect(() => restorableList("; nothing\n")).toThrow();
  });
});
