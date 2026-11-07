// Tokens. The developer token is the web player's own, read out of its
// script. The media-user-token is the listener's, from signing in on
// music.apple.com.

import { UA, WEB } from "./constants.ts";
import { fail, t } from "./util.ts";

let devToken: string | null = null;

function jwtExpiry(jwt: string): number {
  try {
    const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "=".repeat((4 - (part.length % 4)) % 4))).exp * 1000;
  } catch {
    return 0;
  }
}

export async function developerToken(fresh = false): Promise<string> {
  if (!fresh) {
    devToken ??= host.storage.get<string>("devToken") ?? null;
    if (devToken && jwtExpiry(devToken) > Date.now() + 3600 * 1000) return devToken;
  }
  const page = await (await fetch(WEB, { headers: { "User-Agent": UA } })).text();
  const scripts = [...new Set(page.match(/\/assets\/index[~-][^"'\s]+\.js/g) ?? [])];
  for (const path of scripts) {
    const js = await (await fetch(WEB + path, { headers: { "User-Agent": UA } })).text();
    const found = js.match(/eyJ[\w-]{10,}\.[\w-]+\.[\w-]+/);
    if (found) {
      devToken = found[0];
      host.storage.set("devToken", devToken);
      return devToken;
    }
  }
  throw new Error(t("Couldn't read the Apple Music web player's token"));
}

export function userToken(): string {
  return host.storage.get<string>("mediaUserToken") ?? "";
}

export const signedIn = (): boolean => !!userToken();

export function needAccount(): void {
  if (!signedIn()) throw fail("signIn");
}
