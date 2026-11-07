// Signing in, on music.apple.com in a window the app shows.

import { me, storefront } from "./api.ts";
import { art } from "./artwork.ts";
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
  host.storage.remove("profile");
  return account();
}

export function signOut(): void {
  host.storage.remove("mediaUserToken");
  host.storage.remove("storefront");
  host.storage.remove("profile");
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
  if (!signedIn()) return null;
  const [sf, p] = await Promise.all([storefront(), profile()]);
  return { id: sf, name: p.name ?? `Apple Music (${sf.toUpperCase()})`, imageUrl: p.imageUrl };
}
