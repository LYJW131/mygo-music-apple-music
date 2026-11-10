// Apple's API at amp-api.music.apple.com, as the web player asks it.

import { AMP, UA, WEB } from "./constants.ts";
import { developerToken, needAccount, signedIn, userToken } from "./session.ts";
import type { Body, Resource } from "./types/apple.ts";
import { fail, t } from "./util.ts";
import { inUse, renewIfDue, renewRefused } from "./wrapperaccount.ts";

export type Params = Record<string, string | number | undefined | null> | null | undefined;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Whether to send the listener's token, if they're signed in. */
  user?: boolean;
  /** The header the listener's token goes in. */
  userHeader?: string;
}

export function query(params: Params): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

const signInAgain = () =>
  inUse()
    ? fail("setup", t("Apple Music didn't accept the token of the wrapper's account. Log it in to the wrapper again."))
    : fail("signIn", t("Apple Music didn't accept the sign-in. Sign in again."));

/** JSON from Apple, or null for an empty answer. */
export async function request<T = Body>(
  url: string,
  { method = "GET", body, user = true, userHeader = "media-user-token" }: RequestOptions = {},
): Promise<T | null> {
  if (user) renewIfDue();
  let renewed = false;
  let freshDev = false;
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await developerToken(freshDev)}`,
      Origin: WEB,
      Referer: `${WEB}/`,
      "User-Agent": UA,
      Accept: "application/json",
    };
    const mine = user ? userToken() : "";
    if (mine) headers[userHeader] = mine;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    // A 401 can be a developer token that has run out: try once with a new one.
    if (res.status === 401 && attempt === 0) {
      freshDev = true;
      continue;
    }
    freshDev = false;
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      // A token from the wrapper may have been replaced by its own refresh.
      if (mine && !renewed && (await renewRefused(mine))) {
        renewed = true;
        continue;
      }
      if (mine) throw signInAgain();
      throw new Error(`Apple Music: HTTP ${res.status}`);
    }
    if (res.status === 404) throw fail("unavailable", t("Apple Music doesn't have this"));
    if (res.status >= 400) {
      let why = "";
      try {
        const err = JSON.parse(text).errors?.[0];
        why = err?.detail || err?.title || "";
      } catch {
        // not JSON: the status says enough
      }
      throw new Error(`Apple Music: HTTP ${res.status}${why ? ` ${why}` : ""}`);
    }
    return text ? (JSON.parse(text) as T) : null;
  }
}

export const api = <T = Body>(path: string, params?: Params, options?: RequestOptions) =>
  request<T>(AMP + path + query(params), options);

/**
 * Apple's catalog, in the listener's storefront. The songs in it come with
 * the address of their lossless master playlist, which a song played lossless
 * starts from (lossless.ts).
 */
export async function catalog<T = Body>(path: string, params?: Params, options?: RequestOptions) {
  return api<T>(
    `/v1/catalog/${await storefront()}${path}`,
    { "extend[songs]": "extendedAssetUrls", ...params },
    options,
  );
}

/** The listener's own: their library, ratings and recommendations. */
export function me<T = Body>(path: string, params?: Params, options?: RequestOptions) {
  needAccount();
  return api<T>(`/v1/me${path}`, params, options);
}

/** The one resource an answer is about. */
export function first(body: Body | null): Resource {
  const item = body?.data?.[0];
  if (!item) throw fail("unavailable", t("Apple Music doesn't have this"));
  return item;
}

/** How many pages of a list are asked for at once while the app waits for it. */
const PAGES_AT_ONCE = 3;

/**
 * next, the address Apple gives of a list's next page, with the parameters
 * the first page was asked with that it leaves out: Apple's says the offset
 * only, and without the limit the pages after the first come 25 at a time.
 */
export function continued(next: string, params: Params): string {
  const url = new URL(next, AMP);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== "" && !url.searchParams.has(k)) url.searchParams.set(k, String(v));
  }
  return url.pathname + url.search;
}

/**
 * Every page of a list, up to `max` items. In the background, one page at a
 * time, calling pause between them. While the app waits for it (urgent, by
 * default), the pages after the first come a few at once, by their offsets,
 * once the first has said how long the list is.
 */
export async function allPages(
  path: string,
  params: Params,
  max = 1000,
  pause?: () => Promise<void>,
  urgent: () => boolean = () => true,
): Promise<Resource[]> {
  if (path.startsWith("/v1/me")) needAccount();
  const out: Resource[] = [];
  let total: number | undefined;
  let size = 0;
  let next: string | undefined = path + query(params);
  while (next && out.length < max) {
    if (out.length && pause) await pause();
    const pages: string[] = [continued(next, params)];
    const url = new URL(pages[0], AMP);
    const offset = Number(url.searchParams.get("offset"));
    if (urgent() && total !== undefined && size > 0 && offset > 0) {
      for (let i = 1; i < PAGES_AT_ONCE && offset + i * size < Math.min(total, max); i++) {
        url.searchParams.set("offset", String(offset + i * size));
        pages.push(url.pathname + url.search);
      }
    }
    const bodies: (Body | null)[] = await Promise.all(pages.map((page) => request(AMP + page)));
    for (const body of bodies) out.push(...(body?.data ?? []));
    total ??= bodies[0]?.meta?.total;
    size ||= bodies[0]?.data?.length ?? 0;
    next = bodies[bodies.length - 1]?.next;
  }
  return out;
}

/**
 * The storefront: the account's, once signed in; else the US. Catalog
 * requests made as the listener have to be in theirs.
 */
export async function storefront(): Promise<string> {
  if (!signedIn()) return "us";
  let sf = host.storage.get<string>("storefront");
  if (sf) return sf;
  sf = (await api("/v1/me/storefront"))?.data?.[0]?.id;
  if (!sf) throw signInAgain();
  host.storage.set("storefront", sf);
  return sf;
}
