// Signing in, on music.apple.com in a window the app shows.

import { storefront } from "./api.ts";
import { UA, WEB } from "./constants.ts";
import { signedIn } from "./session.ts";
import type { Account } from "./types/music.ts";
import { fail, t } from "./util.ts";

function cookieValue(cookie: string, name: string): string {
  for (const part of cookie.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return "";
}

export async function signIn(): Promise<Account | null> {
  if (!host.webSignIn) throw fail("unsupported", t("This version of MyGo Music can't show Apple's sign-in page"));
  const { cookie } = await host.webSignIn({
    url: `${WEB}/us/browse`,
    cookiesOf: WEB,
    until: ["media-user-token"],
    userAgent: UA,
  });
  const token = cookieValue(cookie ?? "", "media-user-token");
  if (!token) throw new Error(t("Apple Music didn't sign you in"));
  host.storage.set("mediaUserToken", token);
  host.storage.remove("storefront");
  return account();
}

export function signOut(): void {
  host.storage.remove("mediaUserToken");
  host.storage.remove("storefront");
}

export async function account(): Promise<Account | null> {
  if (!signedIn()) return null;
  const sf = await storefront();
  return { id: sf, name: `Apple Music (${sf.toUpperCase()})` };
}
