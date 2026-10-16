/**
 * **The capture contract: what an app writes instead of sending mail, and how
 * a journey reads it back.**
 *
 * A journey that signs somebody in has to read the code that was emailed, and
 * one that sends a statement has to open the PDF that was attached. So during a
 * recording the app's mail transport **captures** rather than sends, into the
 * directory the stack host hands its adapter (`StackEnv.outboxDir`, exported to
 * the app and to the test workers as `JOURNEY_OUTBOX_DIR`):
 *
 * ```
 * $JOURNEY_OUTBOX_DIR/index.jsonl            one line per message, appended
 * $JOURNEY_OUTBOX_DIR/<anything>.html|.txt   the renderings the line points at
 * ```
 *
 * Each line is a `Captured`: `{ to[], subject, htmlPath, textPath, attachments? }`,
 * paths absolute. `appendCaptured` writes one for an app (or an adapter) in
 * Node; an app in another language writes the same line.
 *
 * **Read rather than re-rendered.** A spec that renders the template itself
 * answers *does this template render* and assumes the thing worth asserting —
 * that the app sent anything at all. A job that renders a statement correctly
 * and attaches the wrong month is invisible to a re-render and caught by this.
 *
 * **The file accumulates across a run**, so a spec counts messages to one
 * address before and after, never the length of the file. It is swept with the
 * rest of scratch at the start of the next stack — never at the end, because
 * these messages are steps of a journey: nobody signs in without reading the
 * code, so a finished run must stay walkable by hand.
 *
 * **A capture transport must refuse to run on a deployment.** A transport that
 * swallows mail withholds a rent reminder with nothing on any screen saying so;
 * door_nexa refuses it at build time and again at send time.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUTBOX_VAR = "JOURNEY_OUTBOX_DIR";
export const OUTBOX_INDEX = "index.jsonl";

export type Captured = {
  to: string[];
  subject: string;
  htmlPath: string;
  textPath: string;
  attachments?: Array<{ filename: string; path: string }>;
};

/** The run's outbox, from the one definition the stack pinned into the environment. */
export function outboxDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[OUTBOX_VAR];
  if (!dir) {
    throw new Error(
      `JOURNEY-040: ${OUTBOX_VAR} is not set, so there is no outbox to read. It is set by ` +
        "defineJourneyPlaywrightConfig and by the stack host; a spec run outside them has no stack.",
    );
  }
  return dir;
}

/** Every message captured so far, oldest first. An absent index is an empty outbox. */
export function outbox(dir: string = outboxDir()): Captured[] {
  const file = join(dir, OUTBOX_INDEX);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Captured);
}

/** Everything sent to one address. */
export function outboxTo(email: string, dir?: string): Captured[] {
  return outbox(dir).filter((message) => message.to.includes(email));
}

/**
 * The newest message to `email` whose subject matches.
 *
 * **Refuses rather than returning nothing**: a journey that photographed an
 * empty inbox and carried on would record a page proving the opposite of what
 * it claims. The message says what *was* there, because "nothing arrived" and
 * "the wrong one arrived" need different next moves.
 */
export function lastCaptured(email: string, subject: RegExp, dir?: string): Captured {
  const mine = outboxTo(email, dir);
  const match = mine.filter((m) => subject.test(m.subject)).at(-1);
  if (!match) {
    throw new Error(
      `JOURNEY-041: no message to ${email} matching ${subject} — ${mine.length} other message(s) ` +
        `were captured for them${mine.length ? `: ${mine.map((m) => `"${m.subject}"`).join(", ")}` : ""}`,
    );
  }
  return match;
}

/** One attachment's bytes, by the name the recipient would see — never by position. */
export function attachment(message: Captured, filename: string | RegExp): Uint8Array {
  const found = (message.attachments ?? []).find((a) =>
    typeof filename === "string" ? a.filename === filename : filename.test(a.filename),
  );
  if (!found) {
    throw new Error(
      `JOURNEY-042: "${message.subject}" carried no attachment matching ${filename} — it had ` +
        `${(message.attachments ?? []).map((a) => a.filename).join(", ") || "none"}`,
    );
  }
  return readFileSync(found.path);
}

/**
 * Capture one message: its renderings beside the index, and one line in it.
 * The writer half of the contract, for an app or an adapter in Node.
 */
export function appendCaptured(
  dir: string,
  message: {
    to: string[];
    subject: string;
    html: string;
    text: string;
    attachments?: Array<{ filename: string; bytes: Uint8Array }>;
  },
): Captured {
  mkdirSync(dir, { recursive: true });
  // Time plus a counter of what is already there: unique within one outbox
  // without a random number, which would make two runs' captures differ.
  const n = outbox(dir).length + 1;
  const stem = `${Date.now()}-${String(n).padStart(4, "0")}`;
  const htmlPath = join(dir, `${stem}.html`);
  const textPath = join(dir, `${stem}.txt`);
  writeFileSync(htmlPath, message.html);
  writeFileSync(textPath, message.text);
  const attachments = (message.attachments ?? []).map((a, i) => {
    const path = join(dir, `${stem}-${i + 1}-${a.filename}`);
    writeFileSync(path, a.bytes);
    return { filename: a.filename, path };
  });
  const captured: Captured = {
    to: message.to,
    subject: message.subject,
    htmlPath,
    textPath,
    ...(attachments.length ? { attachments } : {}),
  };
  appendFileSync(join(dir, OUTBOX_INDEX), JSON.stringify(captured) + "\n");
  return captured;
}
