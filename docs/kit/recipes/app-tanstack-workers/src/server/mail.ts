import type { AppEnv } from "../env";

export type Mail = { to: string[]; subject: string; text: string; html: string };

/** The line prefix the journeys adapter reads from wrangler's output. */
export const CAPTURE_MARKER = "EMAIL-CAPTURE ";

/**
 * Capture is local only (the env schema refuses it elsewhere). A Worker cannot
 * write to the host's disk, so it prints one line and the journeys adapter,
 * which owns wrangler's output, appends it to the outbox (tooling/journeys
 * src/outbox.mts).
 */
export async function sendMail(env: AppEnv, mail: Mail): Promise<void> {
  if (env.EMAIL_TRANSPORT === "capture") {
    console.warn(CAPTURE_MARKER + JSON.stringify(mail));
    return;
  }
  throw new Error(
    "MAIL-001: no deployed transport in this recipe — instantiate the email package kickoff chose",
  );
}
