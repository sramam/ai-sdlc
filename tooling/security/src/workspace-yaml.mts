/**
 * The few top-level keys of pnpm-workspace.yaml and .npmrc this module reads.
 *
 * Not a YAML parser: top-level `key: scalar`, `key: [a, b]` and a block list of
 * `- item` lines under `key:`. Anything else at the top level (a nested map) is
 * recorded as `undefined`-valued "complex" so a reader can tell *present but
 * unreadable* from *absent* — the could-not-ask answer, not a guess.
 */
export type YamlValue = string | number | boolean | string[] | { complex: true };

function scalar(raw: string): string | number | boolean {
  const v = raw.trim();
  if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function stripComment(line: string): string {
  // A `#` starts a comment at line start or after whitespace, outside quotes.
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1] as string)))
      return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

export function parseTopLevelYaml(text: string): Map<string, YamlValue> {
  const out = new Map<string, YamlValue>();
  let current: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line.trim() === "") continue;
    const top = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(line);
    if (top) {
      const key = top[1] as string;
      const rest = (top[2] ?? "").trim();
      current = null;
      if (rest === "") {
        current = key;
        out.set(key, []);
      } else if (rest.startsWith("[")) {
        const inner = rest.replace(/^\[/, "").replace(/\]$/, "").trim();
        out.set(key, inner === "" ? [] : inner.split(",").map((s) => String(scalar(s))));
      } else out.set(key, scalar(rest));
      continue;
    }
    if (current !== null && /^\s+-\s*/.test(line)) {
      const list = out.get(current);
      if (Array.isArray(list)) list.push(String(scalar(line.replace(/^\s+-\s*/, ""))));
      continue;
    }
    if (current !== null && /^\s+\S/.test(line)) {
      // An indented map under the key: present, and not something we read.
      out.set(current, { complex: true });
    }
  }
  return out;
}

/** `.npmrc`: `key=value` lines, `;` and `#` comments. */
export function parseNpmrc(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

export function asList(v: YamlValue | undefined): string[] | null {
  return Array.isArray(v) ? v : null;
}
