/**
 * **A tiny static app, served by a `StackAdapter`, for the end-to-end test.**
 *
 * Three pages, each exercising one part of the machinery:
 *
 * | page | what it proves |
 * | --- | --- |
 * | `/` | a stable page — its heading comes from `fixture-title.txt` in the checkout, so a test can make a deliberate pixel change |
 * | `/clock` | a value that differs on every run, marked `data-volatile-clock` — masked by declaration, never learned |
 * | `/welcome-email` | the capture contract: it writes a message to the outbox, and the journey renders it as evidence; its code is `data-volatile-code` |
 *
 * In-process (`node:http`), so there is no child `pid` to hand the host. The
 * volatile values are fixed-width monospace on purpose: a value whose width
 * varies moves its neighbours, which no mask can cover.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";
import { appendCaptured } from "../../outbox.mts";
import type { StackAdapter, StackEnv } from "../../stack/host.mts";

const page = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">` +
  `<style>body{font-family:Helvetica,Arial,sans-serif;margin:40px;color:#222}` +
  `.v{display:inline-block;width:9ch;font-family:monospace}</style></head><body>${body}</body></html>`;

const now = () => new Date().toISOString().slice(11, 19);

let server: Server | undefined;

const adapter: StackAdapter = {
  name: "fixture",
  readyPath: "/",
  mode: { name: "fixture http", devOverlayPossible: false },
  async start(env: StackEnv) {
    let sent = 0;
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", env.appUrl);
      if (url.pathname === "/") {
        let title = "Welcome";
        try {
          title = readFileSync(join(env.checkout, "fixture-title.txt"), "utf8").trim() || title;
        } catch {
          // The default.
        }
        response
          .writeHead(200, { "content-type": "text/html" })
          .end(
            page(
              `<h1>${title}</h1><p>A page that does not change on its own.</p><a href="/clock">See the time</a>`,
            ),
          );
        return;
      }
      if (url.pathname === "/clock") {
        response
          .writeHead(200, { "content-type": "text/html" })
          .end(
            page(
              `<h1>The time</h1><p>Now: <span class="v" data-volatile-clock>${now()}</span></p>`,
            ),
          );
        return;
      }
      if (url.pathname === "/welcome-email") {
        sent += 1;
        const code = String(100000 + ((Date.now() + sent) % 900000));
        appendCaptured(env.outboxDir, {
          to: ["visitor@example.test"],
          subject: "Welcome to the fixture",
          html: page(
            `<h2>Welcome</h2><p>Your code is <span class="v" data-volatile-code>${code}</span>.</p>`,
          ),
          text: `Welcome. Your code is ${code}.`,
        });
        response
          .writeHead(200, { "content-type": "text/html" })
          .end(page("<h1>Sent</h1><p>Check your inbox.</p>"));
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
    });
    const listening = server;
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(env.appPort, () => resolve());
    });
    return {
      async stop() {
        listening.closeAllConnections();
        await new Promise<void>((done) => listening.close(() => done()));
      },
    };
  },
  async reset() {
    // Nothing persists between files: every page is derived from the request and one file.
  },
};

export default adapter;
