/** Web Push (RFC 8030/8291 via `web-push`): one VAPID key pair per instance, one subscription per browser. */
import { and, eq, inArray } from "drizzle-orm";
import { generateVAPIDKeys } from "web-push";
import { z } from "zod";
import { decrypt, encrypt } from "../../crypto.ts";
import type { Db } from "../../db/index.ts";
import { pushSubscriptions, settings } from "../../db/schema.ts";
import { env } from "../../env.ts";
import type { Viewer } from "../access/index.ts";
import { deps, logFailure } from "./deps.ts";
import { readSetting } from "./settings.ts";

const VAPID_KEY = "web_push_vapid";

type VapidKeys = { publicKey: string; privateKey: string };

async function storedVapidKeys(db: Db): Promise<VapidKeys | null> {
  const row = await readSetting(db, VAPID_KEY);
  const publicKey = (row?.value as { publicKey?: unknown } | null)?.publicKey;
  return typeof publicKey === "string" && row?.ciphertext ? { publicKey, privateKey: decrypt(row.ciphertext) } : null;
}

/** Created at startup or on first send; concurrent first calls agree on whichever pair was stored first. */
export async function ensureVapidKeys(db: Db): Promise<VapidKeys> {
  const existing = await storedVapidKeys(db);
  if (existing) return existing;
  const fresh = generateVAPIDKeys();
  await db
    .insert(settings)
    .values({ key: VAPID_KEY, value: { publicKey: fresh.publicKey }, ciphertext: encrypt(fresh.privateKey) })
    .onConflictDoNothing();
  const stored = await storedVapidKeys(db);
  if (!stored) throw new Error("VAPID keys missing after insert");
  return stored;
}

/** Only reads: null until `ensureVapidKeys` ran. */
export async function vapidPublicKey(db: Db): Promise<string | null> {
  return (await storedVapidKeys(db))?.publicKey ?? null;
}

/** Push services need a contact; the sender address if mail is set up, otherwise the instance address if it is public HTTPS. */
function vapidSubject(fromAddress: string | null): string {
  if (fromAddress) return `mailto:${fromAddress}`;
  const url = new URL(env().APP_URL);
  if (url.protocol === "https:" && url.hostname !== "localhost") return url.origin;
  return "mailto:saldo@example.invalid";
}

// The browsers' push services; anything else would let a user make the server post to arbitrary hosts.
const PUSH_HOSTS = [".googleapis.com", ".mozilla.com", ".push.apple.com", ".notify.windows.com"];

const base64url = (max: number) =>
  z
    .string()
    .min(8)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+=*$/, "notifications.errors.invalidKey");

export const pushSubscriptionInput = z.object({
  endpoint: z
    .url("notifications.errors.invalidPushEndpoint")
    .max(2000)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && PUSH_HOSTS.some((host) => `.${url.hostname}`.endsWith(host));
    }, "notifications.errors.unsupportedPushService"),
  keys: z.object({ p256dh: base64url(200), auth: base64url(100) }),
});

export const pushEndpointInput = z.object({ endpoint: z.string().min(1).max(2000) });

/** A browser belongs to whoever subscribed last on it. */
export async function savePushSubscription(
  db: Db,
  viewer: Viewer,
  input: z.input<typeof pushSubscriptionInput>,
  userAgent = "",
): Promise<void> {
  const { endpoint, keys } = pushSubscriptionInput.parse(input);
  const values = { userId: viewer.id, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent: userAgent.slice(0, 200) };
  await db.insert(pushSubscriptions).values(values).onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: values });
}

export async function deletePushSubscription(db: Db, viewer: Viewer, input: z.input<typeof pushEndpointInput>): Promise<void> {
  const { endpoint } = pushEndpointInput.parse(input);
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, viewer.id), eq(pushSubscriptions.endpoint, endpoint)));
}

export async function pushDeviceCount(db: Db, viewer: Viewer): Promise<number> {
  return (await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, viewer.id))).length;
}

export type PushPayload = { title: string; body: string; link: string | null };
export type PushResult = { sent: number; failed: number; removed: number };

const GONE = new Set([404, 410]);

/** Sends to every browser of the user; subscriptions the push service reports as gone are deleted. */
export async function pushToUser(db: Db, userId: string, payload: PushPayload, fromAddress: string | null): Promise<PushResult> {
  const targets = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  const result: PushResult = { sent: 0, failed: 0, removed: 0 };
  if (targets.length === 0) return result;
  const keys = await ensureVapidKeys(db);
  const options = {
    vapidDetails: { subject: vapidSubject(fromAddress), publicKey: keys.publicKey, privateKey: keys.privateKey },
    TTL: 24 * 3600,
    timeout: 10_000,
  };
  const gone: number[] = [];
  const body = JSON.stringify(payload);
  await Promise.all(
    targets.map(async (target) => {
      try {
        await deps.sendPush({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, body, options);
        result.sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: unknown }).statusCode;
        if (typeof status === "number" && GONE.has(status)) {
          gone.push(target.id);
        } else {
          result.failed += 1;
          logFailure(`Web push (status ${typeof status === "number" ? status : "none"})`, error);
        }
      }
    }),
  );
  if (gone.length > 0) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
  result.removed = gone.length;
  return result;
}
