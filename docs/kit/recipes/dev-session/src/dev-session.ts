// Sign a SEEDED account in, for scripts (curl, Playwright, an agent checking a
// screen), by completing the REAL passwordless sign-in: request a code over
// HTTP, read it back through Better Auth's server-only API, sign in over HTTP.
// Every gate still applies: the account must exist, the code expires, and the
// session is an ordinary one, revocable like any other.
//
// Runtime-free: the HTTP client, the code reader and the account check are
// passed in, so the suite runs it against an in-process Better Auth.

export const ALLOWED_ENVS = ["local", "dev"] as const;

export type DevSessionRefusal = { ok: false; code: string; detail: string };

/**
 * Allow-list: an environment not named is refused, including an undeclared one.
 * `local` must point at this machine, so a shell that says local cannot mint a
 * session on a deployment.
 */
export function envVerdict(
  appEnv: string | undefined,
  baseUrl: string,
): { ok: true } | DevSessionRefusal {
  if (!appEnv) {
    return {
      ok: false,
      code: "DEVSESSION-001",
      detail: "APP_ENV is not set; a session minter must know where it points",
    };
  }
  if (!(ALLOWED_ENVS as readonly string[]).includes(appEnv)) {
    return {
      ok: false,
      code: "DEVSESSION-002",
      detail: `refusing to mint a session on ${appEnv}; allowed: ${ALLOWED_ENVS.join(", ")}`,
    };
  }
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return { ok: false, code: "DEVSESSION-003", detail: `not a URL: ${baseUrl}` };
  }
  if (appEnv === "local" && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    return {
      ok: false,
      code: "DEVSESSION-003",
      detail: `APP_ENV=local but ${host} is not this machine`,
    };
  }
  return { ok: true };
}

export type DevSessionDeps = {
  baseUrl: string;
  email: string;
  /** HTTP to the running app (global fetch in the CLI; the auth handler in tests). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Better Auth's `auth.api.getVerificationOTP`, server-only: a 404 over HTTP. */
  readOtp: (email: string) => Promise<string | null>;
  /** Only seeded accounts: OTP sign-in would otherwise create one. */
  userExists: (email: string) => Promise<boolean>;
};

export type Cookie = { name: string; value: string };

export async function devSignIn(
  d: DevSessionDeps,
): Promise<
  { ok: true; cookies: Cookie[]; user: { id: string; email: string } } | DevSessionRefusal
> {
  const email = d.email.trim().toLowerCase();
  if (!(await d.userExists(email))) {
    return {
      ok: false,
      code: "DEVSESSION-004",
      detail: `${email} is not an account here; seed it first (dev-session signs in, it never signs up)`,
    };
  }
  // Better Auth refuses a state-changing request without an Origin it trusts;
  // Node's fetch sends none. Declaring the app's own origin is not a bypass:
  // the check stops a page on another site, and this runs beside the secret.
  const origin = new URL(d.baseUrl).origin;
  const headers = { "content-type": "application/json", origin };
  let send: Response;
  try {
    send = await d.fetch(`${d.baseUrl}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email, type: "sign-in" }),
    });
  } catch (error) {
    return {
      ok: false,
      code: "DEVSESSION-005",
      detail: `could not reach ${d.baseUrl}: ${String(error)}`,
    };
  }
  if (!send.ok) {
    return {
      ok: false,
      code: "DEVSESSION-005",
      detail: `requesting a code answered ${send.status}; is the app up at ${d.baseUrl}?`,
    };
  }
  const otp = await d.readOtp(email);
  if (!otp)
    return { ok: false, code: "DEVSESSION-006", detail: `no code is outstanding for ${email}` };

  const signIn = await d.fetch(`${d.baseUrl}/api/auth/sign-in/email-otp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, otp }),
  });
  if (!signIn.ok) {
    return {
      ok: false,
      code: "DEVSESSION-007",
      detail: `sign-in answered ${signIn.status}: ${(await signIn.text()).slice(0, 200)}`,
    };
  }
  // The cookie is `<token>.<signature>`: take it from the response, never build it from the body's token.
  const cookies = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .map((pair) => ({
      name: pair.slice(0, pair.indexOf("=")),
      value: pair.slice(pair.indexOf("=") + 1),
    }));
  if (!cookies.some((c) => c.name.endsWith("session_token"))) {
    return {
      ok: false,
      code: "DEVSESSION-008",
      detail: "signed in, but no session cookie came back",
    };
  }
  const body = (await signIn.json()) as { user: { id: string; email: string } };
  return { ok: true, cookies, user: { id: body.user.id, email: body.user.email } };
}

/** A Netscape cookie jar for `curl -b <file>`. */
export function curlJar(cookies: Cookie[], baseUrl: string): string {
  const u = new URL(baseUrl);
  const secure = u.protocol === "https:" ? "TRUE" : "FALSE";
  const lines = cookies.map((c) =>
    [`#HttpOnly_${u.hostname}`, "FALSE", "/", secure, "0", c.name, c.value].join("\t"),
  );
  return `# Netscape HTTP Cookie File\n${lines.join("\n")}\n`;
}

/** Playwright's `storageState` (`browser.newContext({ storageState })`). */
export function storageState(cookies: Cookie[], baseUrl: string) {
  const u = new URL(baseUrl);
  return {
    cookies: cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: u.hostname,
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: u.protocol === "https:",
      sameSite: "Lax" as const,
    })),
    origins: [],
  };
}
