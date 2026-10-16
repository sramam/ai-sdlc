/**
 * `node tooling/core/src/config-schema.mts [--write | --check]`
 *
 * Generates `config.schema.json` (JSON Schema draft 2020-12) from the shape the
 * validator uses, so an editor and the loader cannot disagree about the file.
 * `--check` exits 1 when the committed schema is stale; config.test.ts asserts
 * the same.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SHAPE } from "./config.mts";
import { isEntry } from "./exec.mts";
import { toJsonSchema } from "./shape.mts";

export const SCHEMA_PATH = join(import.meta.dirname, "config.schema.json");

export function configSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "sdlc.config.json",
    description:
      "The project's knobs for the ai-sdlc tooling. Declarative: read, validated and never executed (tooling/core/src/config.mts).",
    ...toJsonSchema(SHAPE),
  };
}

export const schemaText = (): string => `${JSON.stringify(configSchema(), null, 2)}\n`;

if (isEntry(import.meta.url)) {
  const arg = process.argv[2];
  if (arg === "--write") {
    writeFileSync(SCHEMA_PATH, schemaText());
    console.log(`  wrote ${SCHEMA_PATH}`);
  } else if (arg === "--check") {
    // Compared as data: prettier may lay the committed file out differently.
    const current: unknown = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    if (JSON.stringify(current) === JSON.stringify(configSchema()))
      console.log("  config.schema.json matches the validator's shape");
    else {
      console.error(
        "  config.schema.json is stale: node tooling/core/src/config-schema.mts --write",
      );
      process.exitCode = 1;
    }
  } else process.stdout.write(schemaText());
}
