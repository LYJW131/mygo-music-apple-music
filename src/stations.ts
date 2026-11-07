// Stations: the listener's own, and those they played lately. Live radio
// isn't one: it has no next tracks to play.

import { catalog, me } from "./api.ts";
import { songsOf, toStation } from "./models.ts";
import { signedIn } from "./session.ts";
import type { Station, Track } from "./types/music.ts";
import { t } from "./util.ts";

export async function stations(): Promise<Station[]> {
  if (!signedIn()) return [];
  const out: Station[] = [];
  const own = await catalog("/stations", { "filter[identity]": "personal" }).catch(() => null);
  out.push(...(own?.data ?? []).map((s) => ({ ...toStation(s), name: s.attributes?.name || t("Your Station") })));
  const recent = await me("/recent/radio-stations", { limit: 10 }).catch(() => null);
  for (const s of recent?.data ?? []) {
    if (s.type === "stations" && !s.attributes?.isLive && !out.some((o) => o.id === s.id)) out.push(toStation(s));
  }
  return out;
}

export async function stationNext({ id }: { id: string }): Promise<Track[]> {
  return songsOf((await me(`/stations/next-tracks/${id}`, { limit: 10 }, { method: "POST" }))?.data);
}
