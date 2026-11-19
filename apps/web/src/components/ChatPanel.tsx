import { getRouteApi, Link, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { useFormat, useI18n, useT } from "../i18n/react.tsx";
import { errorMessage, useAction } from "../lib/action.ts";
import { chatUsageLine, useAiDetails } from "../lib/ai-details.ts";
import { type BookingView, filterToSearch, parseTransactionSearch, searchToFilter, type TransactionSearch } from "../lib/booking-filter.ts";
import {
  chatFn,
  deleteAllChatConversationsFn,
  deleteChatConversationFn,
  getChatConversationFn,
  getChatConversationsFn,
  getChatRetentionFn,
  renameChatConversationFn,
} from "../server/functions/ai.ts";
import type { ChatUsage, ConversationSummary, StoredMessage } from "../server/modules/ai/index.ts";
import type { Lookup, ShownBookings } from "../server/modules/tools/index.ts";
import { ActionMenu } from "./ActionMenu.tsx";
import { NavAction } from "./AppShell.tsx";
import { Amount, MaskedText, useMaskAmounts } from "./Bits.tsx";
import { ConfirmDialog, FormDialog } from "./Dialog.tsx";
import { DictationControls } from "./Dictation.tsx";
import { Field } from "./Field.tsx";
import { Icon } from "./Icon.tsx";
import { Markdown } from "./Markdown.tsx";
import { Banner } from "./Status.tsx";

type Message = { role: "user" | "assistant"; content: string; meta?: string; lookups?: Lookup[]; usage?: ChatUsage };

/** A saved chat to continue: its id and the messages shown so far. */
type Opened = { id: number; messages: Message[] };

const appRoute = getRouteApi("/_app");

const LOOKUP_KEYS = {
  search_transactions: "ai.chat.lookup.search_transactions",
  show_bookings: "ai.chat.lookup.show_bookings",
  summary: "ai.chat.lookup.summary",
  top_counterparties: "ai.chat.lookup.top_counterparties",
  recurring_payments: "ai.chat.lookup.recurring_payments",
  list_accounts: "ai.chat.lookup.list_accounts",
  list_categories: "ai.chat.lookup.list_categories",
} as const;

const CATEGORY_KEYS = {
  expense: "ai.chat.lookup.category_expense",
  income: "ai.chat.lookup.category_income",
  savings: "ai.chat.lookup.category_savings",
} as const;

const COUNTED = new Set(["search_transactions", "show_bookings"]);

/** The address of the bookings page showing a list the AI found. */
export function bookingsSearch(bookings: Pick<ShownBookings, "filter" | "sort">): TransactionSearch {
  const sort = bookings.sort && bookings.sort !== "datum" ? bookings.sort : undefined;
  return { ...filterToSearch(bookings.filter), ...(sort ? { sortierung: sort } : {}) };
}

/** What the AI looked at for one answer, e.g. "Buchungen November 2026 (41)". */
function LookupList({ lookups }: { lookups: Lookup[] }) {
  const t = useT();
  const f = useFormat();
  const period = ({ dateFrom: from, dateTo: to }: Lookup) => {
    if (from && to && from.endsWith("-01") && to.slice(0, 7) === from.slice(0, 7)) return f.monthLong(from);
    if (from && to) return t("filters.range", { from: f.date(from), to: f.date(to) });
    if (from) return t("filters.rangeFrom", { date: f.date(from) });
    if (to) return t("filters.rangeTo", { date: f.date(to) });
    return "";
  };
  const label = (lookup: Lookup) => {
    const name =
      lookup.tool === "category_totals"
        ? t(CATEGORY_KEYS[lookup.kind ?? "expense"])
        : lookup.tool in LOOKUP_KEYS
          ? t(LOOKUP_KEYS[lookup.tool as keyof typeof LOOKUP_KEYS])
          : lookup.tool;
    const when = period(lookup);
    const count = COUNTED.has(lookup.tool) && lookup.count !== null ? ` (${f.integer(lookup.count)})` : "";
    return `${name}${when ? ` ${when}` : ""}${count}`;
  };
  return (
    <details className="chat-lookups">
      <summary>{t("ai.chat.lookups", { count: lookups.length })}</summary>
      <ul>
        {lookups.map((lookup, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the same query can repeat; the list never changes
          <li key={i}>{label(lookup)}</li>
        ))}
      </ul>
    </details>
  );
}

/** The totals of a booking list the AI found, with the way to it; `onLeave` runs as the link is followed. */
function BookingsResult({ bookings, onLeave }: { bookings: ShownBookings; onLeave?: () => void }) {
  const { t, f } = useI18n();
  const { count, incomeCents, expenseCents, sumCents } = bookings.totals;
  return (
    <div className="chat-bookings">
      <dl className="chat-bookings-figures">
        <div>
          <dt>{t("transactions.totals.count")}</dt>
          <dd className="num">{f.integer(count)}</dd>
        </div>
        <div>
          <dt>{t("transactions.totals.income")}</dt>
          <dd>
            <Amount cents={incomeCents} />
          </dd>
        </div>
        <div>
          <dt>{t("transactions.totals.expenses")}</dt>
          <dd>
            <Amount cents={expenseCents} />
          </dd>
        </div>
        <div>
          <dt>{t("transactions.totals.sum")}</dt>
          <dd>
            <Amount cents={sumCents} />
          </dd>
        </div>
      </dl>
      <Link to="/buchungen" search={bookingsSearch(bookings)} className="btn btn-sm" onClick={onLeave}>
        {t("ai.chat.showInBookings")} <Icon name="chevron-right" size={16} />
      </Link>
    </div>
  );
}

/** Token counts and context window of an answer, when the person turned AI details on. */
function UsageLine({ usage }: { usage: ChatUsage }) {
  const { t, f } = useI18n();
  const { user } = appRoute.useRouteContext();
  const { aiAllowed } = appRoute.useLoaderData();
  const shown = useAiDetails(user, aiAllowed);
  const line = chatUsageLine(usage, t, f);
  if (!shown || !line) return null;
  return <p className="chat-usage">{line}</p>;
}

function ChatMessage({ message, onLeave }: { message: Message; onLeave?: () => void }) {
  const t = useT();
  const bookings = message.lookups?.findLast((lookup) => lookup.bookings)?.bookings;
  return (
    <div className={`chat-msg chat-msg-${message.role}`}>
      <span className="chat-msg-meta">{message.role === "user" ? t("ai.chat.you") : (message.meta ?? t("ai.chat.ai"))}</span>
      {message.role === "assistant" ? <Markdown text={message.content} /> : <MaskedText text={message.content} />}
      {bookings && <BookingsResult bookings={bookings} onLeave={onLeave} />}
      {message.lookups && message.lookups.length > 0 && <LookupList lookups={message.lookups} />}
      {message.usage && <UsageLine usage={message.usage} />}
    </div>
  );
}

type Meta = Pick<ChatUsage, "providerName" | "model" | "mode">;

function metaText({ providerName, model, mode }: Meta, t: ReturnType<typeof useT>): string {
  const source = t("ai.chat.meta", { provider: providerName, model });
  return mode === "attached" ? `${source} · ${t("ai.chat.attached")}` : source;
}

function shownMessage(stored: StoredMessage, t: ReturnType<typeof useT>): Message {
  return {
    role: stored.role,
    content: stored.content,
    meta: stored.usage ? metaText(stored.usage, t) : undefined,
    lookups: stored.lookups,
    usage: stored.usage ?? undefined,
  };
}

/**
 * One conversation with the configured AI. It lives in whoever calls this, not in the view showing it, so the chat
 * over the page can close while an answer is still on its way and show it, the draft and the whole conversation again
 * when it reopens. Each question and answer is saved to the person's own history.
 */
export function useChatSession(groupId: number | null) {
  const send = useServerFn(chatFn);
  const t = useT();
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [answered, setAnswered] = useState(false);
  const [draft, setDraft] = useState("");
  const [busySince, setBusySince] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A question still on its way when the chat is reset or another one is opened must not write into that one.
  const generation = useRef(0);

  const restore = useCallback((opened: Opened | null) => {
    generation.current += 1;
    setMessages(opened?.messages ?? []);
    setConversationId(opened?.id ?? null);
    setAnswered(false);
    setBusySince(null);
    setError(null);
  }, []);

  async function ask(text: string, view: BookingView | null) {
    const run = ++generation.current;
    const before = messages;
    const history = [...messages, { role: "user" as const, content: text }];
    setMessages(history);
    setAnswered(false);
    setDraft("");
    setBusySince(Date.now());
    setError(null);
    try {
      const result = await send({ data: { groupId, conversationId, question: text, view } });
      if (run !== generation.current) return;
      setConversationId(result.conversation?.id ?? null);
      setMessages([
        ...history,
        { role: "assistant", content: result.reply, meta: metaText(result, t), lookups: result.lookups, usage: result.tokens },
      ]);
      setAnswered(true);
    } catch (e) {
      if (run !== generation.current) return;
      setError(errorMessage(e, t));
      setMessages(before);
      setDraft((current) => (current.trim() ? current : text));
    } finally {
      if (run === generation.current) setBusySince(null);
    }
  }

  return { messages, conversationId, answered, draft, setDraft, busySince, busy: busySince !== null, error, ask, restore };
}

type ChatSession = ReturnType<typeof useChatSession>;

const ELAPSED_AFTER_S = 3;

/** While the AI answers: a turning icon, typing dots and, after a few seconds, how long it has been working. */
function ChatProgress({ since }: { since: number }) {
  const t = useT();
  const elapsed = () => Math.floor((Date.now() - since) / 1000);
  const [seconds, setSeconds] = useState(elapsed);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `elapsed` only reads `since`
  useEffect(() => {
    setSeconds(elapsed());
    const timer = setInterval(() => setSeconds(elapsed()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return (
    <div className="chat-progress">
      <p className="chat-progress-line">
        <Icon name="loader" size={16} />
        <span>{t("ai.chat.answering")}</span>
        {/* The status region is read as a whole on every change, so the ticking time stays out of it. */}
        {seconds >= ELAPSED_AFTER_S && (
          <span className="chat-progress-time" aria-hidden="true">
            {t("ai.chat.answeringFor", { seconds })}
          </span>
        )}
      </p>
      <span className="chat-typing" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}

/**
 * Chat with the configured AI about the selected view. The model looks up what it needs through read-only tools
 * scoped to the view; the server never sends IBANs, notes or balances.
 */
export function ChatBody({ groupId, compact = false }: { groupId: number | null; compact?: boolean }) {
  const session = useChatSession(groupId);
  return <ChatConversation session={session} compact={compact} />;
}

/**
 * `view` is the booking list on screen, sent along so follow-up questions can refine it; `onLeave` runs when a link
 * in the chat leads elsewhere. While a superuser views Saldo as someone else, that person's chats stay private and
 * nothing is asked or saved.
 */
function ChatConversation({
  session,
  compact = false,
  view = null,
  inputRef,
  onLeave,
}: {
  session: ChatSession;
  compact?: boolean;
  view?: BookingView | null;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  onLeave?: () => void;
}) {
  const t = useT();
  const { user } = appRoute.useRouteContext();
  const { messages, draft, setDraft, busy, busySince, error } = session;
  const [invalid, setInvalid] = useState<string | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const ownInput = useRef<HTMLTextAreaElement>(null);
  const input = inputRef ?? ownInput;
  const inputId = useId();

  const last = messages.at(-1);
  const newest = session.answered && last?.role === "assistant" ? last : null;
  const earlier = newest ? messages.slice(0, -1) : messages;

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the newest message whenever the log changes
  useEffect(() => {
    log.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [messages]);

  if (user.impersonation) {
    return <p className="muted chat-note">{t("ai.chat.viewingAs", { name: user.name || user.username })}</p>;
  }

  function submit(event?: FormEvent, spoken?: string) {
    event?.preventDefault();
    const text = (spoken ?? draft).trim();
    if (!text) {
      setInvalid(t("ai.chat.emptyQuestion"));
      input.current?.focus();
      return;
    }
    setInvalid(null);
    void session.ask(text, view);
  }

  return (
    <div className="stack chat-body">
      <div ref={log} className={compact ? "chat-log chat-log-compact" : "chat-log"}>
        {messages.length === 0 && <p className="muted">{t("ai.chat.example")}</p>}
        {earlier.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows; messages have no ids
          <ChatMessage key={i} message={m} onLeave={onLeave} />
        ))}
        {/* Only the progress and the newest answer are read out as they arrive, not the question just typed. */}
        <div className="chat-live" role="status">
          {busySince !== null ? <ChatProgress since={busySince} /> : newest && <ChatMessage message={newest} onLeave={onLeave} />}
        </div>
      </div>
      {error && <Banner tone="danger">{error}</Banner>}
      <form className="chat-form" onSubmit={submit} noValidate>
        <DictationControls
          text={draft}
          disabled={busy}
          onText={(text) => {
            setDraft(text);
            setInvalid(null);
          }}
        >
          {({ mic, notices }) => (
            <>
              {notices}
              <div className="field">
                <label className="visually-hidden" htmlFor={inputId}>
                  {t("ai.chat.question")}
                </label>
                <div className="chat-composer" data-invalid={invalid ? true : undefined}>
                  <textarea
                    ref={input}
                    id={inputId}
                    placeholder={t("ai.chat.placeholder")}
                    aria-describedby={`${inputId}-hint ${inputId}-privacy${invalid ? ` ${inputId}-error` : ""}`}
                    aria-invalid={invalid ? true : undefined}
                    value={draft}
                    maxLength={6000}
                    rows={compact ? 2 : 3}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setInvalid(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !busy) submit();
                    }}
                  />
                  <div className="chat-composer-tools">
                    {mic}
                    <button type="submit" className="composer-icon composer-send" disabled={busy} aria-busy={busy}>
                      <Icon name="send" size={18} />
                      <span className="visually-hidden">{t("ai.chat.send")}</span>
                    </button>
                  </div>
                </div>
                {invalid && (
                  <span id={`${inputId}-error`} className="field-error">
                    {invalid}
                  </span>
                )}
                <span id={`${inputId}-hint`} className="field-hint">
                  {t("ai.chat.sendHint")}
                </span>
                <span id={`${inputId}-privacy`} className="field-hint">
                  {t("ai.chat.privacy")}
                </span>
              </div>
            </>
          )}
        </DictationControls>
        {messages.length > 0 && (
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                session.restore(null);
                input.current?.focus();
              }}
            >
              {t("ai.chat.newChat")}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}

function RenameForm({ item, onDone }: { item: ConversationSummary; onDone: (saved: boolean) => void }) {
  const t = useT();
  const rename = useAction(renameChatConversationFn, { invalidate: false });
  const [title, setTitle] = useState(item.title);
  const [invalid, setInvalid] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) {
      setInvalid(t("ai.history.titleRequired"));
      field.current?.focus();
      return;
    }
    const result = await rename.run({ data: { id: item.id, title: title.trim() } });
    if (result.ok) onDone(true);
  }

  return (
    <form className="chat-history-rename" onSubmit={submit} noValidate>
      <Field label={t("ai.history.title")} error={invalid ?? rename.error ?? undefined}>
        {(control) => (
          <input
            {...control}
            ref={field}
            value={title}
            maxLength={80}
            onChange={(event) => {
              setTitle(event.target.value);
              setInvalid(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onDone(false);
              }
            }}
          />
        )}
      </Field>
      <div className="actions">
        <button type="button" className="btn btn-sm" onClick={() => onDone(false)}>
          {t("common.cancel")}
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={rename.busy} aria-busy={rename.busy}>
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}

/** The person's saved chats, newest first: reopen, rename, delete one or all. */
function ChatHistory({
  onOpen,
  onDeleted,
  onLeave,
}: {
  onOpen: (id: number) => void;
  onDeleted: (ids: number[] | "all") => void;
  onLeave: () => void;
}) {
  const { t, f } = useI18n();
  const mask = useMaskAmounts();
  const list = useServerFn(getChatConversationsFn);
  const retention = useServerFn(getChatRetentionFn);
  const removeOne = useAction(deleteChatConversationFn, { invalidate: false });
  const removeAll = useAction(deleteAllChatConversationsFn, { invalidate: false });
  const [items, setItems] = useState<ConversationSummary[] | null>(null);
  const [days, setDays] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<ConversationSummary | "all" | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();

  const load = useCallback(async () => {
    try {
      setItems(await list());
      setError(null);
    } catch (e) {
      setError(errorMessage(e, t));
      setItems([]);
    }
  }, [list, t]);

  useEffect(() => {
    void load();
    retention().then(
      (r) => setDays(r.days),
      () => setDays(undefined),
    );
  }, [load, retention]);

  async function remove(target: ConversationSummary | "all") {
    const result = target === "all" ? await removeAll.run() : await removeOne.run({ data: { id: target.id } });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onDeleted(target === "all" ? "all" : [target.id]);
    setNotice(target === "all" ? t("ai.history.allDeleted") : t("ai.history.deleted", { title: mask(target.title) }));
    await load();
    heading.current?.focus();
  }

  return (
    <section className="chat-history stack-sm" aria-labelledby={headingId}>
      <h3 id={headingId} ref={heading} tabIndex={-1}>
        {t("ai.history.heading")}
      </h3>
      {notice && (
        <Banner tone="ok" onClose={() => setNotice(null)}>
          {notice}
        </Banner>
      )}
      {error && <Banner tone="danger">{error}</Banner>}
      {items === null ? (
        <p className="loading">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p className="muted">{t("ai.history.empty")}</p>
      ) : (
        <ul className="chat-history-list">
          {items.map((item) => (
            <li key={item.id} className="chat-history-item">
              {renaming === item.id ? (
                <RenameForm
                  item={item}
                  onDone={async (saved) => {
                    setRenaming(null);
                    if (saved) await load();
                  }}
                />
              ) : (
                <>
                  <button type="button" className="chat-history-open" onClick={() => onOpen(item.id)}>
                    <span className="chat-history-name">
                      <MaskedText text={item.title} />
                    </span>
                    <span className="chat-history-date">{f.dateTime(item.updatedAt)}</span>
                  </button>
                  <ActionMenu
                    name={mask(item.title)}
                    items={[
                      { label: t("ai.history.rename"), onSelect: () => setRenaming(item.id) },
                      { label: t("common.delete"), danger: true, onSelect: () => setDeleting(item) },
                    ]}
                  />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="field-hint">
        {days === null ? t("ai.history.keptForever") : days !== undefined ? t("ai.history.keptFor", { count: days }) : null}{" "}
        <Link to="/persoenlich/daten" onClick={onLeave}>
          {t("ai.history.changeRetention")}
        </Link>
      </p>
      {items && items.length > 0 && (
        <div className="actions">
          <button type="button" className="btn btn-destructive" onClick={() => setDeleting("all")}>
            <Icon name="trash" size={18} /> {t("ai.history.deleteAll")}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        danger
        title={
          deleting === "all"
            ? t("ai.history.confirmAllTitle", { count: items?.length ?? 0 })
            : t("ai.history.confirmTitle", { title: deleting ? mask(deleting.title) : "" })
        }
        confirmLabel={deleting === "all" ? t("ai.history.deleteAll") : t("ai.history.delete")}
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
        onClose={() => setDeleting(null)}
      >
        <p>{deleting === "all" ? t("ai.history.confirmAllText") : t("ai.history.confirmText")}</p>
      </ConfirmDialog>
    </section>
  );
}

/** The booking list on screen, from the address of the bookings page; null on every other page. */
function useShownView(): BookingView | null {
  const location = useRouterState({ select: (s) => s.location });
  if (location.pathname !== "/buchungen") return null;
  const search = parseTransactionSearch(location.search as Record<string, unknown>);
  return { filter: searchToFilter(search), ...(search.sortierung ? { sort: search.sortierung } : {}) };
}

/**
 * The chat as a modal over the page, which stays as it is behind it: a drawer like the booking details on wide screens,
 * a sheet at the bottom on phones. Escape, the close button, a click outside and every link in it close it; the
 * conversation is the caller's.
 */
function ChatDialog({ session, viewName, onClose }: { session: ChatSession; viewName: string; onClose: () => void }) {
  const t = useT();
  const { user } = appRoute.useRouteContext();
  const view = useShownView();
  const question = useRef<HTMLTextAreaElement>(null);
  const [screen, setScreen] = useState<"chat" | "history">("chat");
  const [openError, setOpenError] = useState<string | null>(null);
  const load = useServerFn(getChatConversationFn);
  const historyAllowed = !user.impersonation;
  const historyLabel = t("ai.history.open");

  function focusQuestion() {
    requestAnimationFrame(() => question.current?.focus());
  }

  async function open(id: number) {
    try {
      const conversation = await load({ data: { id } });
      session.restore({ id: conversation.id, messages: conversation.messages.map((m) => shownMessage(m, t)) });
      setOpenError(null);
      setScreen("chat");
      focusQuestion();
    } catch (e) {
      setOpenError(errorMessage(e, t));
    }
  }

  return (
    <FormDialog
      title={t("ai.chat.dialogTitle", { view: viewName })}
      variant="drawer"
      className="chat-dialog"
      onClose={onClose}
      headTools={
        historyAllowed && (
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={historyLabel}
            title={historyLabel}
            aria-pressed={screen === "history"}
            onClick={() => {
              setScreen(screen === "history" ? "chat" : "history");
              if (screen === "history") focusQuestion();
            }}
          >
            <Icon name="history" />
          </button>
        )
      }
    >
      {openError && (
        <Banner tone="danger" onClose={() => setOpenError(null)}>
          {openError}
        </Banner>
      )}
      {screen === "history" && historyAllowed && (
        <ChatHistory
          onOpen={(id) => void open(id)}
          onDeleted={(ids) => {
            const current = session.conversationId;
            if (ids === "all" || (current !== null && ids.includes(current))) session.restore(null);
          }}
          onLeave={onClose}
        />
      )}
      <div hidden={screen !== "chat"}>
        <ChatConversation session={session} view={view} inputRef={question} onLeave={onClose} />
      </div>
    </FormDialog>
  );
}

/**
 * "KI fragen" in the sidebar and the chat it opens. Opening it changes nothing on the page. The conversation is kept
 * here, so closing the chat, even while the AI is still answering, loses nothing; the button turns until the answer is in.
 */
/** Answers (or failures) that finished while the chat was closed; opening it marks them seen. */
function useUnseenAnswers(busy: boolean, open: boolean) {
  const [count, setCount] = useState(0);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy && !open) setCount((n) => n + 1);
    wasBusy.current = busy;
  }, [busy, open]);
  useEffect(() => {
    if (open) setCount(0);
  }, [open]);
  return { count };
}

export function ChatLauncher({ viewName }: { viewName: string }) {
  const t = useT();
  const session = useChatSession(null);
  const [open, setOpen] = useState(false);
  const unseen = useUnseenAnswers(session.busy, open);
  return (
    <>
      <NavAction
        icon="chat"
        label={t("shell.askAi")}
        opensDialog
        shortcut="chat"
        busy={session.busy}
        busyLabel={t("ai.chat.answering")}
        badge={unseen.count}
        badgeSuffix={t("ai.chat.unseenSuffix", { count: unseen.count })}
        onClick={() => setOpen(true)}
      />
      <p className="visually-hidden" role="status">
        {unseen.count > 0 ? t("ai.chat.answeredClosed") : ""}
      </p>
      {open && <ChatDialog session={session} viewName={viewName} onClose={() => setOpen(false)} />}
    </>
  );
}
