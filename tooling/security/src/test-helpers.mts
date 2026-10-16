/**
 * Fixtures for the security tests. Every secret-shaped string is assembled at
 * runtime from pieces, so this file — and every test — never contains one
 * literally and the repository's own scan stays clean.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const rep = (s: string, n: number) => s.repeat(n);

/** A deterministic, high-entropy body of `n` base62 characters. */
export function randomish(n: number): string {
  const alphabet = "aZ3kQ9mX2bY7pL4wN8cV1tR6sJ5hG0dF";
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[(i * 7 + 3) % alphabet.length];
  return out;
}

/** One sample per built-in rule, keyed by rule id. */
export function secretSamples(): Record<string, string> {
  const dash = "-----";
  return {
    "private-key": `${dash}BEGIN RSA PRIVATE ${"KEY"}${dash}`,
    "aws-access-key-id": `id = ${"AK"}IA${"QWERTYUIOPASDFGH"}`,
    "aws-secret-access-key": `aws_secret_access_key = ${randomish(40)}`,
    "gcp-api-key": `key: ${"AI"}za${randomish(35)}`,
    "gcp-service-account": `"private_key_id": "${rep("ab12", 10)}"`,
    "cloudflare-api-token": `${"CLOUDFLARE"}_API_TOKEN=${randomish(40)}`,
    "cloudflare-origin-ca-key": `v1.0-${rep("a1", 12)}-${rep("b2", 73)}`,
    "github-token": `${"gh"}p_${randomish(36)}`,
    "github-fine-grained-pat": `${"github"}_pat_${randomish(70)}`,
    "anthropic-api-key": `${"sk-"}ant-api03-${randomish(90)}`,
    "openai-api-key": `${"sk-"}proj-${randomish(48)}`,
    "openai-api-key-legacy": `${"sk-"}${randomish(20)}${"T3Blbk"}FJ${randomish(20)}`,
    "stripe-secret-key": `${"sk"}_live_${randomish(30)}`,
    "stripe-webhook-secret": `${"wh"}sec_${randomish(32)}`,
    "slack-token": `${"xo"}xb-${randomish(24)}`,
    "slack-webhook": `https://hooks.slack.com/services/T${"ABC123"}/B${"DEF456"}/${randomish(24)}`,
    "generic-secret-assignment": `MY_${"API"}_KEY=${randomish(32)}`,
  };
}

/** Near misses that must not trip anything. */
export function nearMisses(): string[] {
  return [
    `MY_${"API"}_KEY=your-api-key-goes-here-xxxxxxxx`,
    `MY_${"API"}_KEY=\${process.env.KEY}`,
    `CLIENT_${"SECRET"}=changeme`,
    `const ${"TOKEN"}_HEADER = "authorization";`,
    `DATABASE_${"PASSWORD"}=abcdefghijklmnopqrstuvwxyz`, // long but a word run
    `${"sk"}_live_short`,
    `AKIA lowercase akia${"qwertyuiopasdfgh"}`,
  ];
}

export function tempRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ai-sdlc-security-"));
  for (const [p, body] of Object.entries(files)) {
    const f = join(root, p);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, body);
  }
  return root;
}

/** A pnpm-layout package at node_modules/.pnpm/<id>/node_modules/<name>. */
export function pnpmPackage(
  pkg: Record<string, unknown> & { name: string; version: string },
  extra: Record<string, string> = {},
): Record<string, string> {
  const id = `${pkg.name.replace("/", "+")}@${pkg.version}`;
  const base = `node_modules/.pnpm/${id}/node_modules/${pkg.name}`;
  const out: Record<string, string> = { [`${base}/package.json`]: JSON.stringify(pkg) };
  for (const [p, body] of Object.entries(extra)) out[`${base}/${p}`] = body;
  return out;
}
