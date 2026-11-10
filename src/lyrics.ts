// Lyrics: Apple's TTML, word by word where Apple has it, with the
// translation into the listener's language when there is one.

import { catalog } from "./api.ts";
import { signedIn } from "./session.ts";
import type { LyricLine, LyricWord, Lyrics } from "./types/music.ts";
import { isCatalogID } from "./util.ts";

const lyricsLanguage = (): string => (host.language() === "zh-CN" ? "zh-Hans-CN" : "en-US");

export async function lyrics({ id }: { id: string }): Promise<Lyrics | null> {
  if (!isCatalogID(id) || !signedIn()) return null;
  const language = lyricsLanguage();
  const params = { "l[lyrics]": language, extend: "ttmlLocalizations", "l[script]": "en-Latn" };
  for (const kind of ["syllable-lyrics", "lyrics"]) {
    const body = await catalog(`/songs/${id}/${kind}`, params).catch(() => null);
    const a = body?.data?.[0]?.attributes;
    const ttml = a?.ttmlLocalizations || a?.ttml;
    if (ttml) return parseTTML(ttml, language.split("-")[0]);
  }
  return null;
}

/** Milliseconds, from TTML's 1.5, 1:02.25 or 1.5s. */
function milliseconds(time: string | undefined): number {
  if (!time) return 0;
  let s = 0;
  for (const p of time.replace(/s$/, "").split(":").map(Number)) s = s * 60 + p;
  return Math.round(s * 1000);
}

function unescapeXML(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

const attribute = (tag: string, name: string): string | undefined => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

const stripTags = (s: string): string => unescapeXML(s.replace(/<[^>]+>/g, ""));

/** TTML's lines, with the translation into `language` (zh, en) where there is one. */
export function parseTTML(ttml: string, language: string): Lyrics | null {
  // Translations, by the line they're for.
  const translations: Record<string, string> = {};
  const blocks = [...ttml.matchAll(/<translation\b([^>]*)>([\s\S]*?)<\/translation>/g)];
  const pick = blocks.find((b) => (attribute(b[1], "xml:lang") ?? attribute(b[1], "lang") ?? "").startsWith(language));
  if (pick) {
    for (const m of pick[2].matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
      const key = attribute(m[1], "for");
      if (key) translations[key] = stripTags(m[2]).trim();
    }
  }
  const body = ttml.slice(ttml.indexOf("<body"));
  const lines: LyricLine[] = [];
  for (const m of body.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const key = attribute(m[1], "itunes:key");
    const inner = m[2];
    // Background vocals are spans inside a span: leave them in the text, in
    // brackets, without timing each word twice.
    const main = inner.replace(
      /<span\b[^>]*ttm:role="x-bg"[^>]*>([\s\S]*?)<\/span>\s*<\/span>|<span\b[^>]*ttm:role="x-bg"[^>]*>([\s\S]*?)<\/span>/g,
      "",
    );
    const words: LyricWord[] = [];
    for (const w of main.matchAll(/<span\b([^>]*)>([^<]*)<\/span>(\s*)/g)) {
      const begin = attribute(w[1], "begin");
      if (!begin) continue;
      words.push({
        start: milliseconds(begin),
        end: milliseconds(attribute(w[1], "end")),
        text: unescapeXML(w[2]) + (w[3] ? " " : ""),
      });
    }
    const text = stripTags(inner).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const line: LyricLine = {
      start: milliseconds(attribute(m[1], "begin")),
      end: milliseconds(attribute(m[1], "end")),
      text,
    };
    if (words.length) {
      words[words.length - 1].text = words[words.length - 1].text.trimEnd();
      line.words = words;
    }
    if (key && translations[key]) line.translation = translations[key];
    lines.push(line);
  }
  // Lyrics that aren't timed at all come as lines at 0, which MyGo shows
  // stopped at the last line: it has no way to show lyrics untimed, and drops
  // LRC lines without a time.
  return lines.length ? { lines } : null;
}
