// Signing in, on music.apple.com in a window the app shows, with a
// media-user-token the listener gives in the settings, or as an account the
// listener's wrapper holds (wrapperaccount.ts). A token given goes first,
// then the wrapper's account, and the window only without either.

import { me, storefront } from "./api.ts";
import { art } from "./artwork.ts";
import { UA, WEB } from "./constants.ts";
import { forgetLibrary } from "./library.ts";
import { signedIn } from "./session.ts";
import type { Account } from "./types/music.ts";
import { codeOf, fail, t } from "./util.ts";
import { askWrapper, type FromWrapper, wrapperAccount, wrapperAndAccount } from "./wrapperaccount.ts";

function cookieValue(cookie: string, name: string): string {
  for (const part of cookie.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return "";
}

// The token the sign-in gives, kept, and what was kept for whoever signed in
// before forgotten.
function keep(token: string): void {
  host.storage.set("mediaUserToken", token);
  host.storage.remove("storefront");
  host.storage.remove("profile");
  forgetLibrary();
}

// The window can't sign in to an account that signs in with a passkey or a
// security key, as it has no WebAuthn: such a listener copies the
// media-user-token out of their own browser's cookies for music.apple.com,
// and gives it in the settings, as the token alone or the cookies as copied.
export function givenToken(): string {
  let given = host.setting("mediaUserToken").trim();
  const cookie = given.replace(/^cookie:\s*/i, "");
  if (/(^|[\s;])media-user-token=/.test(cookie)) given = cookieValue(cookie, "media-user-token");
  return given.replace(/^"(.*)"$/, "$1").trim();
}

// Signs in with the token given in the settings as it changes, and out once
// it's taken away, unless the listener signed in another way since. Which one
// was used is kept, as the app may have changed it while the plugin wasn't
// running to hear of it.
export function useGivenToken(): void {
  const given = givenToken();
  const used = host.storage.get<string>("givenToken") ?? "";
  if (given === used) return;
  if (given && /[\s;,]/.test(given)) {
    throw fail("setup", t("That isn't a media-user-token: paste the value of the media-user-token cookie"));
  }
  if (given) {
    host.storage.set("givenToken", given);
    keep(given);
    return;
  }
  host.storage.remove("givenToken");
  if (host.storage.get<string>("mediaUserToken") === used) signOut();
}

// Signs in as the account of the wrapper the settings name, once it's named
// or the wrapper changes, and out of the one named before. Not again after
// the listener signed out, until they sign in. A wrapper that didn't answer
// isn't asked again for a minute, as the app asks for the account often and
// a wrapper not there takes long to fail.
let failed: { of: string; at: number } | null = null;
const RETRY_AFTER = 60 * 1000;

export async function useWrapperAccount(force = false): Promise<void> {
  const kept = host.storage.get<FromWrapper>("wrapperAccount");
  const wanted = wrapperAccount() && !givenToken() ? wrapperAndAccount() : "";
  if (kept && kept.of === wanted && !force) return;
  if (kept) {
    host.storage.remove("wrapperAccount");
    if (host.storage.get<string>("mediaUserToken") === kept.token) signOut();
  }
  if (!wanted) return;
  if (!force && failed?.of === wanted && Date.now() - failed.at < RETRY_AFTER) return;
  try {
    const got = await askWrapper();
    failed = null;
    host.storage.set("wrapperAccount", got);
    keep(got.token);
  } catch (e) {
    failed = { of: wanted, at: Date.now() };
    throw e;
  }
}

/** Forgets that the wrapper didn't answer, as its address or key changed. */
export function retryWrapper(): void {
  failed = null;
}

export async function signIn(): Promise<Account | null> {
  if (!givenToken() && wrapperAccount()) {
    await useWrapperAccount(true);
    try {
      return await account();
    } catch (e) {
      if (codeOf(e) !== "signIn") throw e;
      throw fail(
        "setup",
        t("Apple Music didn't accept the token of the wrapper's account. Log it in to the wrapper again."),
      );
    }
  }
  if (givenToken()) {
    // Again, as after signing out the token there hasn't changed. The window
    // won't help while it's there: it wouldn't be used.
    useGivenToken();
    keep(givenToken());
    try {
      return await account();
    } catch (e) {
      if (codeOf(e) !== "signIn") throw e;
      throw fail(
        "setup",
        t(
          "Apple Music didn't accept the Media User Token in the settings. Paste a new one, or empty it to sign in here.",
        ),
      );
    }
  }
  if (!host.webSignIn) throw fail("unsupported", t("This version of MyGo Music can't show Apple's sign-in page"));
  const { cookie } = await host.webSignIn({
    url: `${WEB}/us/browse`,
    cookiesOf: WEB,
    until: ["media-user-token"],
    userAgent: UA,
  });
  const token = cookieValue(cookie ?? "", "media-user-token");
  if (!token) throw new Error(t("Apple Music didn't sign you in"));
  keep(token);
  return account();
}

export function signOut(): void {
  host.storage.remove("mediaUserToken");
  host.storage.remove("storefront");
  host.storage.remove("profile");
  forgetLibrary();
}

// Who's signed in, as the web player shows them: the name and picture of
// their Apple Music profile, or, without one, the picture of their account.
// Kept for a day, as the app asks for the account often.

interface Profile {
  name?: string;
  imageUrl?: string;
  at: number;
}

const PROFILE_KEPT = 24 * 60 * 60 * 1000;

async function profile(): Promise<Profile> {
  const kept = host.storage.get<Profile>("profile");
  if (kept && Date.now() - kept.at < PROFILE_KEPT) return kept;
  const [social, own] = await Promise.all([me("/social-profile").catch(() => null), me("/account").catch(() => null)]);
  const a = social?.data?.[0]?.attributes;
  const found: Profile = {
    name: a?.name || undefined,
    imageUrl: art(a?.artwork ?? own?.data?.[0]?.attributes?.avatarArtwork)?.replace("{size}x{size}", "300x300"),
    at: Date.now(),
  };
  // Apple not answering isn't who they are: try again next time.
  if (social || own) host.storage.set("profile", found);
  return found;
}

export async function account(): Promise<Account | null> {
  try {
    useGivenToken();
  } catch {
    // Said as it was given; until then, whoever is signed in stays.
  }
  try {
    await useWrapperAccount();
  } catch {
    // Said as the listener signs in.
  }
  if (!signedIn()) return null;
  const [sf, p] = await Promise.all([storefront(), profile()]);
  return { id: sf, name: p.name ?? `Apple Music (${sf.toUpperCase()})`, imageUrl: p.imageUrl };
}
