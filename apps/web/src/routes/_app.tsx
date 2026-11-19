import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { type ReactNode, useMemo } from "react";
import { AppShell } from "../components/AppShell.tsx";
import { type ActiveJob, BankJobsProvider } from "../components/BankJobs.tsx";
import { ChatLauncher } from "../components/ChatPanel.tsx";
import { TasksProvider, useTasks } from "../components/Tasks.tsx";
import { useT } from "../i18n/react.tsx";
import { getAiStatus } from "../server/functions/ai.ts";
import { getBankConnectionsFn } from "../server/functions/banking.ts";
import { getUnseenDueCountFn } from "../server/functions/contracts.ts";
import { getUnreadNotificationCountFn } from "../server/functions/notifications.ts";
import { getTasksFn } from "../server/functions/tasks.ts";
import { getTransactions } from "../server/functions/transactions.ts";

export const Route = createFileRoute("/_app")({
  beforeLoad: ({ context }) => {
    const state = context.session.auth;
    if (!state) throw redirect({ to: "/login" });
    return { user: state.user, groups: state.groups };
  },
  loader: async () => {
    const [{ unread }, ai, connections, tasks, notificationsUnread, contractsDue] = await Promise.all([
      getTransactions({ data: { limit: 1 } }),
      getAiStatus().catch(() => ({ ready: false, allowed: false })),
      getBankConnectionsFn().catch(() => []),
      getTasksFn().catch(() => []),
      getUnreadNotificationCountFn().catch(() => 0),
      getUnseenDueCountFn().catch(() => 0),
    ]);
    const syncable = connections.filter((c) => c.status !== "new" && c.linkedAccounts.length > 0).map((c) => ({ id: c.id, name: c.name }));
    // AI entries only appear for people who may use it and once a provider is ready.
    return { unread, aiReady: ai.ready && ai.allowed, aiAllowed: ai.allowed, syncable, tasks, notificationsUnread, contractsDue };
  },
  component: AppLayout,
});

/** The bank jobs provider learns about running jobs, also scheduled ones, from the task list. */
function BankJobs({ connectionNames, children }: { connectionNames: Map<number, string>; children: ReactNode }) {
  const { tasks } = useTasks();
  const active = useMemo(() => tasks.flatMap((task): ActiveJob[] => (task.job && task.status === "running" ? [task.job] : [])), [tasks]);
  return (
    <BankJobsProvider connectionNames={connectionNames} active={active}>
      {children}
    </BankJobsProvider>
  );
}

function AppLayout() {
  const { user } = Route.useRouteContext();
  const { unread, aiReady, syncable, tasks, notificationsUnread, contractsDue } = Route.useLoaderData();
  const t = useT();
  const names = useMemo(() => new Map(syncable.map((c) => [c.id, c.name])), [syncable]);

  return (
    <TasksProvider initial={tasks}>
      <BankJobs connectionNames={names}>
        <AppShell
          user={user}
          unread={unread}
          notificationsUnread={notificationsUnread}
          contractsDue={contractsDue}
          canSync={syncable.length > 0 && !user.impersonation}
          extraNav={aiReady && <ChatLauncher viewName={t("common.allAccounts")} />}
        >
          <Outlet />
        </AppShell>
      </BankJobs>
    </TasksProvider>
  );
}
