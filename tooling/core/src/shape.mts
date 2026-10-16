/**
 * A small description language for the JSON files the tooling reads
 * (sdlc.config.json), and the one validator built from
 * it. Hand-written, with no dependency, so hooks keep running with plain
 * `node` before `pnpm install`. The validator and the JSON Schema are both
 * derived from a shape, so they cannot describe two different files.
 */
export type Shape =
  | { t: "string"; minLength?: number; pattern?: string }
  | { t: "integer"; min?: number; max?: number }
  | { t: "number"; min?: number; max?: number }
  | { t: "boolean" }
  | { t: "enum"; values: string[] }
  | { t: "array"; items: Shape }
  | { t: "object"; props: Record<string, Field> }
  | { t: "record"; values: Shape }
  | { t: "nullable"; inner: Shape };

export interface Field {
  shape: Shape;
  optional?: boolean;
  description?: string;
}

const typeName = (v: unknown): string =>
  v === null
    ? "null"
    : Array.isArray(v)
      ? "an array"
      : typeof v === "object"
        ? "an object"
        : typeof v;

const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 40 ? `${s.slice(0, 39)}…` : s;
};

/** Problems with `value` against `shape`, each naming its path. Empty: valid. */
export function check(shape: Shape, value: unknown, path = ""): string[] {
  const at = path || "(root)";
  switch (shape.t) {
    case "string":
      if (typeof value !== "string") return [`${at}: expected a string, got ${typeName(value)}`];
      if (shape.minLength !== undefined && value.length < shape.minLength)
        return [`${at}: must not be empty`];
      if (shape.pattern !== undefined && !new RegExp(shape.pattern).test(value))
        return [`${at}: ${show(value)} does not match ${shape.pattern}`];
      return [];
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value))
        return [`${at}: expected a number, got ${typeName(value)}`];
      if (shape.t === "integer" && !Number.isInteger(value))
        return [`${at}: expected an integer, got ${value}`];
      if (shape.min !== undefined && value < shape.min)
        return [`${at}: ${value} is below the minimum ${shape.min}`];
      if (shape.max !== undefined && value > shape.max)
        return [`${at}: ${value} is above the maximum ${shape.max}`];
      return [];
    }
    case "boolean":
      return typeof value === "boolean"
        ? []
        : [`${at}: expected a boolean, got ${typeName(value)}`];
    case "enum":
      return typeof value === "string" && shape.values.includes(value)
        ? []
        : [
            `${at}: expected one of ${shape.values.map((v) => `"${v}"`).join(", ")}, got ${show(value)}`,
          ];
    case "nullable":
      return value === null ? [] : check(shape.inner, value, path);
    case "array":
      if (!Array.isArray(value)) return [`${at}: expected an array, got ${typeName(value)}`];
      return value.flatMap((v, i) => check(shape.items, v, `${path}[${i}]`));
    case "record":
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return [`${at}: expected an object, got ${typeName(value)}`];
      const rec = value as Record<string, unknown>;
      const sub = (k: string) => (path ? `${path}.${k}` : k);
      if (shape.t === "record")
        return Object.entries(rec).flatMap(([k, v]) => check(shape.values, v, sub(k)));
      const out: string[] = [];
      for (const k of Object.keys(rec))
        if (!Object.hasOwn(shape.props, k)) out.push(`${at}: unknown key "${k}"`);
      for (const [k, f] of Object.entries(shape.props)) {
        if (rec[k] === undefined) {
          if (!f.optional) out.push(`${sub(k)}: required`);
        } else out.push(...check(f.shape, rec[k], sub(k)));
      }
      return out;
    }
  }
}

/** JSON Schema (draft 2020-12) for a shape: what editors and other tools read. */
export function toJsonSchema(shape: Shape, description?: string): Record<string, unknown> {
  const d = description ? { description } : {};
  switch (shape.t) {
    case "string":
      return {
        type: "string",
        ...d,
        ...(shape.minLength !== undefined ? { minLength: shape.minLength } : {}),
        ...(shape.pattern !== undefined ? { pattern: shape.pattern } : {}),
      };
    case "integer":
    case "number":
      return {
        type: shape.t,
        ...d,
        ...(shape.min !== undefined ? { minimum: shape.min } : {}),
        ...(shape.max !== undefined ? { maximum: shape.max } : {}),
      };
    case "boolean":
      return { type: "boolean", ...d };
    case "enum":
      return { type: "string", ...d, enum: [...shape.values] };
    case "nullable":
      return { anyOf: [toJsonSchema(shape.inner), { type: "null" }], ...d };
    case "array":
      return { type: "array", ...d, items: toJsonSchema(shape.items) };
    case "record":
      return { type: "object", ...d, additionalProperties: toJsonSchema(shape.values) };
    case "object": {
      const entries = Object.entries(shape.props);
      return {
        type: "object",
        ...d,
        properties: Object.fromEntries(
          entries.map(([k, f]) => [k, toJsonSchema(f.shape, f.description)]),
        ),
        required: entries.filter(([, f]) => !f.optional).map(([k]) => k),
        additionalProperties: false,
      };
    }
  }
}
