import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { msg } from "../../../i18n/index.ts";
import { db } from "../../db/index.ts";
import { UserError } from "../../errors.ts";
import { makeUser, resetDb } from "../../test-helpers.ts";
import type { Viewer } from "../access/index.ts";
import { cancelTask, listTasks, resetTasksForTests, startTask, type TaskControl, taskLimits } from "./index.ts";

/** Work that runs `steps` steps, each waiting until the test releases it. */
function gatedWork(steps: number) {
  const gates: (() => void)[] = [];
  const work = async (task: TaskControl) => {
    let done = 0;
    task.step(0, steps, "batch");
    for (let i = 0; i < steps; i++) {
      if (task.shouldStop()) break;
      await new Promise<void>((resolve) => gates.push(resolve));
      done += 1;
      task.step(done, steps, "batch");
    }
    return done;
  };
  const release = async (index: number) => {
    await vi.waitFor(() => expect(gates.length).toBeGreaterThan(index));
    gates[index]?.();
  };
  return { work, release };
}

const meta = (startedBy: string | null, cancellable = true) => ({
  kind: "aiCategorize" as const,
  title: msg("tasks.kinds.aiAutoCategorize"),
  startedBy,
  cancellable,
});

describe("task registry", () => {
  let admin: Viewer;
  let member: Viewer;
  let other: Viewer;
  beforeEach(async () => {
    await resetDb();
    resetTasksForTests();
    admin = await makeUser("admin", "superuser");
    member = await makeUser("lena", "member");
    other = await makeUser("tom", "member");
  });
  afterEach(() => {
    resetTasksForTests();
    vi.restoreAllMocks();
  });

  it("adds up the reported tokens of the model calls, and has none without one", async () => {
    const metered = startTask(
      meta(member.id),
      async (task) => {
        task.meter({ inputTokens: 1_000, outputTokens: 200, reported: true });
        task.meter({ inputTokens: 0, outputTokens: 0, reported: false });
        task.meter({ inputTokens: 900, outputTokens: 100, reported: true });
      },
      () => "fertig",
    );
    const plain = startTask(
      meta(member.id),
      async () => undefined,
      () => "fertig",
    );
    await Promise.all([metered.settled, plain.settled]);
    const tasks = await listTasks(db(), member);
    expect(tasks.find((t) => t.id === metered.id)?.tokens).toBe(2_200);
    expect(tasks.find((t) => t.id === plain.id)?.tokens).toBeNull();
  });

  it("shows members only their own tasks and admins every task, automatic ones included", async () => {
    const mine = startTask(
      meta(member.id),
      async () => 1,
      () => "fertig",
    );
    const automatic = startTask(
      meta(null),
      async () => 1,
      () => "fertig",
    );
    await Promise.all([mine.settled, automatic.settled]);
    expect((await listTasks(db(), member)).map((t) => t.id)).toEqual([mine.id]);
    expect(await listTasks(db(), other)).toEqual([]);
    const all = await listTasks(db(), admin);
    expect(all.map((t) => t.id).sort()).toEqual([mine.id, automatic.id].sort());
    expect(all.find((t) => t.id === mine.id)).toMatchObject({ startedBy: { name: "lena" }, status: "done", message: "fertig" });
    expect(all.find((t) => t.id === automatic.id)?.startedBy).toBeNull();
    await expect(cancelTask(db(), other, { taskId: mine.id })).rejects.toMatchObject({ status: 404 });
  });

  it("reports progress, lists running tasks first and renders titles in the reader's language", async () => {
    const { work, release } = gatedWork(3);
    const finished = startTask(
      meta(admin.id),
      async () => 0,
      () => "",
    );
    await finished.settled;
    const running = startTask(meta(admin.id), work, (done) => `${done}`);
    await release(0);
    await vi.waitFor(async () => expect((await listTasks(db(), admin))[0]?.progress).toEqual({ done: 1, total: 3, unit: "batch" }));
    const [first, second] = await listTasks(db(), { ...admin, locale: "en" });
    expect(first).toMatchObject({ id: running.id, status: "running", cancellable: true, title: "AI categorization after sync" });
    expect(second?.id).toBe(finished.id);
    await release(1);
    await release(2);
    expect(await running.settled).toEqual({ ok: true, value: 3 });
    expect((await listTasks(db(), admin))[0]).toMatchObject({
      status: "done",
      progress: { done: 3, total: 3 },
      message: "3",
      cancellable: false,
    });
  });

  it("stops between steps on cancel, keeps the finished steps and ends as cancelled", async () => {
    const { work, release } = gatedWork(3);
    const task = startTask(meta(member.id), work, (done) => `${done} von 3`);
    await release(0);
    await vi.waitFor(() => expect(task.progress?.done).toBe(1));
    // The member started it, so the member may stop it.
    await cancelTask(db(), member, { taskId: task.id });
    expect((await listTasks(db(), member))[0]).toMatchObject({
      status: "running",
      cancellable: false,
      message: "Wird nach dem laufenden Schritt abgebrochen …",
    });
    await release(1);
    expect(await task.settled).toEqual({ ok: true, value: 2 });
    expect((await listTasks(db(), member))[0]).toMatchObject({ status: "cancelled", message: "2 von 3", progress: { done: 2, total: 3 } });
  });

  it("ends as done when the cancel arrives after the last step, and refuses to cancel what cannot stop", async () => {
    let finish: () => void = () => undefined;
    const late = startTask(
      meta(admin.id),
      (task) => new Promise<number>((resolve) => (finish = () => resolve(task.shouldStop() ? -1 : 1))),
      () => "",
    );
    const single = startTask(
      meta(admin.id, false),
      () => new Promise<number>(() => undefined),
      () => "",
    );
    await expect(cancelTask(db(), admin, { taskId: single.id })).rejects.toMatchObject({ status: 409 });
    finish();
    await late.settled;
    expect(late.status).toBe("done");
    await cancelTask(db(), admin, { taskId: late.id });
    expect(late.status).toBe("done");
    await expect(cancelTask(db(), admin, { taskId: "unknown" })).rejects.toMatchObject({ status: 404 });
  });

  it("keeps a user-facing failure text and hides any other error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const known = startTask(
      meta(admin.id),
      async () => Promise.reject(new UserError(msg("ai.errors.noActiveProvider"))),
      () => "",
    );
    const unknown = startTask(
      meta(admin.id),
      async () => Promise.reject(new Error("IBAN DE02 in a driver message")),
      () => "",
    );
    expect((await known.settled).ok).toBe(false);
    await unknown.settled;
    const views = await listTasks(db(), admin);
    expect(views.find((t) => t.id === known.id)).toMatchObject({ status: "failed", message: "Kein KI-Anbieter aktiv" });
    expect(views.find((t) => t.id === unknown.id)?.message).not.toContain("DE02");
    expect(error.mock.calls.flat().join(" ")).not.toContain("DE02");
  });

  it("keeps finished tasks for an hour and at most fifty of them", async () => {
    const started = Array.from({ length: 55 }, () =>
      startTask(
        meta(admin.id),
        async () => 0,
        () => "",
      ),
    );
    await Promise.all(started.map((task) => task.settled));
    const blocked = startTask(
      meta(admin.id),
      () => new Promise<number>(() => undefined),
      () => "",
    );
    const views = await listTasks(db(), admin);
    expect(views).toHaveLength(51);
    expect(views[0]?.id).toBe(blocked.id);
    const retention = taskLimits.retentionMs;
    try {
      taskLimits.retentionMs = -1;
      expect((await listTasks(db(), admin)).map((t) => t.id)).toEqual([blocked.id]);
    } finally {
      taskLimits.retentionMs = retention;
    }
  });
});
