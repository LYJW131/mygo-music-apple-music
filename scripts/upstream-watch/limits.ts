// What the plugin can't do because MyGo's plugin interface doesn't give it,
// as README.md lists it under <a id="limits">, with the comparison with Ringo
// above it naming an entry for each feature the plugin lacks. That section is
// the only list: each check reads it from the plugin commit it checks, and a
// feature made because a release lifted an entry takes the entry out of it.

// From the comparison's anchor to the next section: the table, whose last
// column names an entry, and the entries. Null for a README without them.
export function limitsSection(readme: string): string | null {
  const start = readme.indexOf('<a id="ringo"></a>');
  if (start < 0 || !readme.includes('<a id="limits"></a>', start)) return null;
  const end = readme.indexOf("\n## ", readme.indexOf("\n## ", start) + 1);
  return readme.slice(start, end < 0 ? undefined : end).trim();
}

// The entries' names, as their bullets give them in bold.
export function limitNames(section: string): string[] {
  const list = section.slice(section.indexOf('<a id="limits"></a>'));
  return [...list.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1]!.trim());
}

// An entry's text, its bullet and the lines that carry it on, or null when the
// list no longer has it.
export function limitEntry(section: string, name: string): string | null {
  const lines = section.slice(section.indexOf('<a id="limits"></a>')).split("\n");
  const at = lines.findIndex((line) => line.startsWith(`- **${name}**`));
  if (at < 0) return null;
  const end = lines.findIndex((line, i) => i > at && (line.startsWith("- ") || !line.trim()));
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

// What the comparison's tables give as the reason the plugin lacks a feature.
export function reasonsGiven(section: string): string[] {
  const lines = section.slice(0, section.indexOf('<a id="limits"></a>')).split("\n");
  const isRule = (line = "") => /^\|\s*-/.test(line);
  // A row under the header and its rule, not the header itself.
  const rows = lines.filter((line, i) => line.startsWith("|") && !isRule(line) && !isRule(lines[i + 1]));
  const reasons = rows.map((row) => row.split("|").slice(1, -1).at(-1)!.trim()).filter(Boolean);
  return [...new Set(reasons)];
}
