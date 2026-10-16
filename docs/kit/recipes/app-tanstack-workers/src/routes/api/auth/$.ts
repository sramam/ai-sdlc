import { createFileRoute } from "@tanstack/react-router";
import { createAuth } from "../../../auth";
import { appEnv } from "../../../server/env";
import { sendMail } from "../../../server/mail";
import { openDb } from "../../../db/client";

// Better Auth on Workers: built per request, because its database is a
// per-request client over Hyperdrive.
async function handle(request: Request): Promise<Response> {
  const env = appEnv();
  const db = await openDb(env.HYPERDRIVE);
  try {
    const auth = createAuth(db.db, {
      secret: env.BETTER_AUTH_SECRET,
      baseURL: env.BETTER_AUTH_URL,
      sendOtp: (email, otp) =>
        sendMail(env, {
          to: [email],
          subject: "Your sign-in code",
          text: `Your code is ${otp}`,
          html: `<p>Your code is <b data-volatile-code>${otp}</b></p>`,
        }),
    });
    return await auth.handler(request);
  } finally {
    await db.close();
  }
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: { GET: ({ request }) => handle(request), POST: ({ request }) => handle(request) },
  },
});
