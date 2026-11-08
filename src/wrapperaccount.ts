// Signing in as an account the listener's wrapper holds. AMDL-Web's wrapper
// gives the media-user-token of each account it holds (GET /token) and
// refreshes it on its own, so a listener who logged their account in to the
// wrapper needn't sign in here too: not with the window, nor by copying the
// token out of a browser, which an account with a passkey would need.
//
// A wrapper-manager holds up to ten accounts, perhaps a household's or one
// for each region, each with its own library. Which one /token answers
// without being told is whichever happens to come first, so the listener
// names theirs in the Wrapper Account setting: its Apple ID, or a region
// where the wrapper holds one. The songs played lossless are the wrapper's
// business either way: it plays each with any account whose region has it.
//
// amhelper asks the wrapper, as the plugin may reach only Apple, and it
// already holds the wrapper's address and key.

import { hasWrapper, helperBase, helperMissing } from "./amhelper.ts";
import { fail, t } from "./util.ts";

/** What the wrapper gave, kept in host.storage ("wrapperAccount"). */
export interface FromWrapper {
  /** The wrapper and the account, as the settings named them when asked. */
  of: string;
  token: string;
  /** When to ask the wrapper again, in ms. */
  next: number;
}

/** The account named in the settings, or "" for none. */
export const wrapperAccount = (): string => host.setting("wrapperAccount").trim();

/** The wrapper and the account named, as one, to tell when either changes. */
export const wrapperAndAccount = (): string => `${host.setting("wrapper").trim()}\n${wrapperAccount()}`;

// Asked again a little after the wrapper refreshes the token, though not
// within a minute, nor later than an hour: a wrapper on Cloudflare that was
// asleep answers with a time long past. After a failure, in five minutes.
const SOONEST = 60 * 1000;
const LATEST = 60 * 60 * 1000;
const RETRY = 5 * 60 * 1000;

function askAt(nextRefresh: number): number {
  const wait = nextRefresh * 1000 + 5000 - Date.now();
  return Date.now() + Math.min(LATEST, Math.max(SOONEST, wait || LATEST));
}

/** Asks the wrapper for the token of the account named in the settings. */
export async function askWrapper(): Promise<FromWrapper> {
  if (!hasWrapper()) {
    throw fail("setup", t("Set the Wrapper Address too, to sign in with an account the wrapper holds"));
  }
  const of = wrapperAndAccount();
  let base: string;
  try {
    base = await helperBase();
  } catch (e) {
    if (helperMissing()) {
      throw fail(
        "unsupported",
        t("Signing in with the wrapper needs amhelper, which the plugin for this platform lacks"),
      );
    }
    throw e;
  }
  const res = await fetch(`${base}/token?account=${encodeURIComponent(wrapperAccount())}`);
  const body = (await res.json()) as { token?: string; next?: number; code?: string; message?: string };
  if (res.status === 404 && body.code === "account") {
    throw Object.assign(fail("setup", `${t("Check the Wrapper Account in the settings")} (${body.message})`), {
      notHeld: true,
    });
  }
  if (!res.ok || !body.token) throw new Error(`amhelper: ${body.message ?? res.status}`);
  return { of, token: body.token, next: askAt(body.next ?? 0) };
}

/** Whether the error is the wrapper not holding the account named, or it not being ready. */
export const notHeld = (e: unknown): boolean => !!(e as { notHeld?: boolean } | null)?.notHeld;

const kept = (): FromWrapper | null => host.storage.get<FromWrapper>("wrapperAccount") ?? null;

/** What the wrapper gave, while the listener is signed in with it. */
export function inUse(): FromWrapper | null {
  const k = kept();
  return k && k.token === host.storage.get<string>("mediaUserToken") ? k : null;
}

let renewing: Promise<string | null> | null = null;

// Asks the wrapper again for the account signed in with, and takes what it
// gives: the same account, so nothing kept for it is forgotten. Not after
// the listener signed out, or in another way, or named another account,
// which account.ts sees to.
function renew(): Promise<string | null> {
  renewing ??= (async () => {
    const was = inUse();
    if (!was || was.of !== wrapperAndAccount()) return null;
    try {
      const got = await askWrapper();
      if (inUse()?.token !== was.token) return null;
      host.storage.set("wrapperAccount", got);
      host.storage.set("mediaUserToken", got.token);
      return got.token;
    } catch (e) {
      if (inUse()?.token === was.token) host.storage.set("wrapperAccount", { ...was, next: Date.now() + RETRY });
      throw e;
    }
  })().finally(() => {
    renewing = null;
  });
  return renewing;
}

/** Asks the wrapper again, in the background, once the token it gave is due. */
export function renewIfDue(): void {
  const k = inUse();
  if (k && Date.now() >= k.next && !renewing) renew().catch(() => {});
}

/**
 * After Apple refused the token: whether the wrapper gives another, which is
 * then used, as its own refresh may have replaced the one refused.
 */
export async function renewRefused(refused: string): Promise<boolean> {
  if (inUse()?.token !== refused) return false;
  const got = await renew().catch(() => null);
  return !!got && got !== refused;
}
