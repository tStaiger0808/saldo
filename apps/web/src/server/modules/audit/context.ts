import { AsyncLocalStorage } from "node:async_hooks";
import { clientIp } from "../../client-ip.ts";

/** Where a request came from, as recorded with each audit event. */
export type RequestMeta = { ip: string | null; userAgent: string | null };

/** A superuser viewing Saldo as someone else in this request: events in the target's name also name the superuser. */
export type ImpersonationNote = { targetUserId: string; actorName: string };

type RequestStore = RequestMeta & { impersonation?: ImpersonationNote };

const MAX_USER_AGENT = 256;
const MAX_IP = 64;

/** The client address (see client-ip.ts) and a shortened user agent. */
export function requestMeta(request: Request): RequestMeta {
  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent")?.trim() || null;
  return { ip: ip?.slice(0, MAX_IP) ?? null, userAgent: userAgent?.slice(0, MAX_USER_AGENT) ?? null };
}

// Nitro plugins and the SSR bundle may load separate module copies; the store must be process-wide.
const KEY = Symbol.for("saldo.auditRequest");
const holder = globalThis as unknown as Record<symbol, AsyncLocalStorage<RequestStore> | undefined>;

function storage(): AsyncLocalStorage<RequestStore> {
  holder[KEY] ??= new AsyncLocalStorage<RequestStore>();
  return holder[KEY];
}

/** Runs one request with its origin available to `record()`, also for jobs it starts detached. */
export function withRequestMeta<T>(meta: RequestMeta, run: () => T): T {
  return storage().run({ ...meta }, run);
}

export function currentRequestMeta(): RequestMeta | undefined {
  const store = storage().getStore();
  return store && { ip: store.ip, userAgent: store.userAgent };
}

/** Set once the session of the request is resolved; outside a request there is nothing to note. */
export function noteImpersonation(note: ImpersonationNote): void {
  const store = storage().getStore();
  if (store) store.impersonation = note;
}

export function currentImpersonation(): ImpersonationNote | undefined {
  return storage().getStore()?.impersonation;
}
