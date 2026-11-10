// Home, and the plugin's own pages: the charts and what was added lately.

import { allPages, catalog, me, storefront } from "./api.ts";
import { kept } from "./background.ts";
import { LIST_KEPT, recentTracks } from "./library.ts";
import { songsOf, toAlbum, toPlaylist, toStation } from "./models.ts";
import { listed, shown, warm } from "./prefetch.ts";
import { signedIn } from "./session.ts";
import type { Body, ChartsBody } from "./types/apple.ts";
import type { Browse, Section, Track } from "./types/music.ts";
import { fail, t } from "./util.ts";

async function charts(limit: number) {
  const r = (await catalog<ChartsBody>("/charts", { types: "songs,albums,playlists", limit }))?.results ?? {};
  return { songs: r.songs?.[0], albums: r.albums?.[0], playlists: r.playlists?.[0] };
}

export async function home(): Promise<Browse> {
  warm();
  const [chart, recommendations, recent] = await Promise.all([
    charts(30).catch(() => ({ songs: undefined, albums: undefined, playlists: undefined })),
    signedIn() ? me("/recommendations", { limit: 12 }).catch((): Body | null => null) : null,
    signedIn() ? recentTracks().catch((): Track[] => []) : [],
  ]);
  const sections: Section[] = [];
  if (chart.songs) {
    sections.push({ title: chart.songs.name || t("Top Songs"), tracks: songsOf(chart.songs.data), morePage: "charts" });
  }
  if (recent.length) sections.push({ title: t("Recently Played"), tracks: recent.slice(0, 30) });
  // The app plays a section's songs from the one picked on. It loads home
  // again by itself, every hour, songs playing or not: what's on it is noted,
  // and worked out only as it plays, so that it doesn't wake the wrapper.
  for (const s of sections) shown(s.tracks ?? []);
  for (const rec of recommendations?.data ?? []) {
    const items = rec.relationships?.contents?.data ?? [];
    const albums = items.filter((i) => i.type === "albums").map(toAlbum);
    const playlists = items.filter((i) => i.type === "playlists").map(toPlaylist);
    const stations = items.filter((i) => i.type === "stations" && !i.attributes?.isLive).map(toStation);
    if (!albums.length && !playlists.length && !stations.length) continue;
    const section: Section = { title: rec.attributes?.title?.stringForDisplay ?? "" };
    if (albums.length) section.albums = albums;
    if (playlists.length) section.playlists = playlists;
    if (stations.length) section.stations = stations;
    sections.push(section);
  }
  if (chart.albums) {
    sections.push({
      title: chart.albums.name || t("Top Albums"),
      albums: chart.albums.data.map(toAlbum),
      morePage: "charts",
    });
  }
  if (chart.playlists) {
    sections.push({
      title: chart.playlists.name || t("Top Playlists"),
      playlists: chart.playlists.data.map(toPlaylist),
    });
  }
  return { title: "Apple Music", sections };
}

export async function browse({ page }: { page: string }): Promise<Browse> {
  warm();
  if (page === "charts") {
    const chart = await charts(100);
    const sections: Section[] = [];
    if (chart.songs) {
      const songs = songsOf(chart.songs.data);
      listed(songs);
      sections.push({ title: chart.songs.name || t("Top Songs"), tracks: songs });
    }
    if (chart.albums)
      sections.push({ title: chart.albums.name || t("Top Albums"), albums: chart.albums.data.map(toAlbum) });
    if (chart.playlists) {
      sections.push({
        title: chart.playlists.name || t("Top Playlists"),
        playlists: chart.playlists.data.map(toPlaylist),
      });
    }
    return { title: t("Charts"), subtitle: (await storefront()).toUpperCase(), sections };
  }
  if (page === "recentlyAdded") return recentlyAdded();
  throw fail("unavailable", t("No such page"));
}

/** What the listener added lately, kept a while. */
export function recentlyAdded(ahead = false): Promise<Browse> {
  return kept(
    "recentlyAdded",
    { maxAge: LIST_KEPT },
    async (pause, urgent) => {
      const items = await allPages("/v1/me/library/recently-added", { limit: 25 }, 100, pause, urgent);
      return {
        title: t("Recently Added"),
        sections: [
          {
            title: t("Albums"),
            albums: items.filter((i) => i.type.endsWith("albums")).map(toAlbum),
            empty: t("Nothing added lately"),
          },
          { title: t("Playlists"), playlists: items.filter((i) => i.type.endsWith("playlists")).map(toPlaylist) },
        ],
      };
    },
    ahead,
  );
}
