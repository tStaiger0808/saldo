import { describe, expect, it } from "vitest";
import { translator } from "../i18n/index.ts";
import { adoptActive, escalate, type SyncJob, settleQuiet, syncingConnections, syncNotice, type Tracked } from "./sync-state.ts";

const t = translator("de");

function job(id: string, connectionId: number, status: SyncJob["status"], extra: Partial<SyncJob> = {}): SyncJob {
  return { id, connectionId, kind: "sync", status, accounts: [], error: null, next: null, ...extra };
}

const quiet = (j: SyncJob, observed = false): Tracked => ({ job: j, label: `Bank ${j.connectionId}`, mode: "quiet", observed });

describe("sync state", () => {
  it("opens the dialog only when the bank needs input or a fetch started here failed", () => {
    const list = [
      quiet(job("a", 1, "running")),
      quiet(job("b", 2, "tan_required")),
      quiet(job("c", 3, "error")),
      quiet(job("d", 4, "tan_required"), true),
      quiet(job("e", 5, "done")),
    ];
    expect(escalate(list).map((t) => t.mode)).toEqual(["quiet", "dialog", "dialog", "quiet", "quiet"]);
  });

  it("rings the connections being requested, followed or reported running", () => {
    const tracked = [quiet(job("a", 1, "running")), quiet(job("b", 2, "done")), quiet(job("x", 7, "running"), true)];
    const active = [
      { id: "b", connectionId: 2, kind: "sync", status: "running" },
      { id: "c", connectionId: 3, kind: "sync", status: "running" },
      { id: "d", connectionId: 4, kind: "discover", status: "running" },
    ];
    expect([...syncingConnections(tracked, active, [5])].sort()).toEqual([1, 3, 5, 7]);
  });

  it("adopts running syncs from the task list once, not those already reported", () => {
    const tracked = [quiet(job("a", 1, "running"))];
    const active = [
      { id: "a", connectionId: 1, kind: "sync", status: "running" },
      { id: "b", connectionId: 2, kind: "sync", status: "running" },
      { id: "c", connectionId: 3, kind: "sync", status: "running" },
      { id: "d", connectionId: 4, kind: "discover", status: "running" },
    ];
    const adopted = adoptActive(tracked, active, new Set(["c"]), (id) => `Bank ${id}`);
    expect(adopted).toEqual([{ job: job("b", 2, "running"), label: "Bank 2", mode: "quiet", observed: true }]);
  });

  it("reports the quiet fetches together once none runs anymore", () => {
    const dialog: Tracked = { ...quiet(job("t", 9, "tan_required")), mode: "dialog" };
    expect(settleQuiet([quiet(job("a", 1, "done")), quiet(job("b", 2, "running")), dialog])).toBeNull();
    const done = settleQuiet([quiet(job("a", 1, "done")), quiet(job("b", 2, "cancelled")), dialog]);
    expect(done?.finished.map((t) => t.job.id)).toEqual(["a", "b"]);
    expect(done?.remaining).toEqual([dialog]);
    expect(settleQuiet([dialog])).toBeNull();
  });

  it("lists accounts with new bookings, failures first", () => {
    const paypal = job("a", 1, "done", {
      accounts: [
        { accountId: 1, name: "PayPal", newBookings: 1, firstImport: false },
        { accountId: 2, name: "Giro", newBookings: 0, firstImport: false },
      ],
    });
    expect(syncNotice([quiet(paypal)], t)).toEqual({ tone: "ok", text: "PayPal: 1 neue Buchung" });
    expect(syncNotice([quiet(job("b", 2, "done"))], t)).toEqual({ tone: "ok", text: "Keine neuen Buchungen." });
    const failed = job("c", 3, "error", { error: "Bank nicht erreichbar" });
    expect(syncNotice([quiet(paypal), quiet(failed, true)], t)).toEqual({
      tone: "warn",
      text: "Bank 3: Bank nicht erreichbar · PayPal: 1 neue Buchung",
    });
  });
});
