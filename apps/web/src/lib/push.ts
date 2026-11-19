/** This browser's push subscription for Saldo, if notifications were turned on here. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

type RemoveEndpoint = (input: { data: { endpoint: string } }) => Promise<unknown>;

/**
 * Before signing out: the server forgets this browser and the browser stops receiving pushes, so the next person
 * at this device gets no notifications about the bookings. Best effort; signing out never waits on a failure here.
 */
export async function forgetPushSubscription(remove: RemoveEndpoint): Promise<void> {
  try {
    const subscription = await currentPushSubscription();
    if (!subscription) return;
    await remove({ data: { endpoint: subscription.endpoint } }).catch(() => undefined);
    await subscription.unsubscribe();
  } catch {
    // No service worker or push support: nothing to forget.
  }
}
