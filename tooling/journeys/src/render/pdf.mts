/**
 * **A PDF, rendered to one image per page, so a recording can show a document**
 * — and its text, and where its dates were drawn.
 *
 * ## Why a browser rather than a Node library
 *
 * `pdfjs-dist`'s Node path wants a native canvas. The journey suite already has
 * a browser and already renders a captured email in a page of its own, so this
 * is that mechanism with a canvas in place of markup — and a PDF page is then
 * gated by exactly the machinery a step's screenshot is.
 *
 * **One image per page, deliberately.** A single tall strip renders the same
 * pixels and hides how many pages there are — the property #902 was
 * about: a statement silently drew its totals off the document.
 *
 * ## `pdfjs-dist` is an optional peer, resolved from the project
 *
 * A project that never captures a PDF installs nothing. One that does pins the
 * version it previews PDFs with, and this resolves **that** copy — from the
 * directories `pdfjsFrom` names, the root first — rather than carrying a second
 * one. The worker build must match the library exactly, so two copies is how a
 * render breaks at runtime rather than at install.
 *
 * ## The package is served to the page rather than imported from `file://`
 *
 * A dynamic `import()` of a `file://` URL from a `setContent` document is
 * cross-origin and fails as *"Failed to fetch dynamically imported module"*,
 * which reads like a missing file. The sheet gets a real origin and its requests
 * are fulfilled from disk — the **whole package**, because pdf.js fetches the
 * Standard 14 font metrics while rendering, and routing only the module renders
 * text that is subtly wrong with a warning nobody sees.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { Page } from "@playwright/test";
import type { DomBox } from "../mask/boxes.mts";
import { boxOf } from "../mask/dom.mts";

const ORIGIN = "https://pdfjs.journey.invalid";

const TYPES: Record<string, string> = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".icc": "application/octet-stream",
};

/**
 * The `pdfjs-dist` package directory, from the first of `from` that has one.
 * Throws `JOURNEY-050` naming every place it looked — a missing optional peer
 * is a configuration answer, not a crash in a browser.
 */
export function resolvePdfjs(root: string, from: readonly string[] = ["."]): string {
  const tried: string[] = [];
  for (const dir of from) {
    const base = isAbsolute(dir) ? dir : join(root, dir);
    tried.push(base);
    try {
      const require = createRequire(join(base, "noop.cjs"));
      return dirname(dirname(require.resolve("pdfjs-dist/build/pdf.min.mjs", { paths: [base] })));
    } catch {
      // Not here; the next directory may have it.
    }
  }
  throw new Error(
    "JOURNEY-050: a step captured a PDF and `pdfjs-dist` is not installed where the recorder " +
      `looked (${tried.join(", ")}). It is an optional peer of @ai-sdlc/journeys: add it to the ` +
      "package that previews PDFs, and name that directory in `pdfjsFrom` in journeys.config.mts.",
  );
}

/** Serve the package, open the document, and say how many pages it has. */
async function open(sheet: Page, bytes: Uint8Array, pkg: string): Promise<number> {
  await sheet.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") {
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><style>html,body{margin:0;padding:0;background:#f1f2f4}canvas{display:block}</style><canvas id="sheet"></canvas>`,
      });
    }
    // Checked against the package root: a route that reads whatever path it is
    // given is a file-read primitive, and `..` survives into `pathname`.
    const file = normalize(join(pkg, path));
    if (file !== pkg && !file.startsWith(pkg + sep))
      return route.fulfill({ status: 403, body: "" });
    try {
      return route.fulfill({
        contentType: TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream",
        body: readFileSync(file),
      });
    } catch {
      return route.fulfill({ status: 404, body: "" });
    }
  });

  await sheet.goto(`${ORIGIN}/`, { waitUntil: "load" });

  return sheet.evaluate(async (data) => {
    // Typed `string` so TypeScript stops resolving the specifier: it is a URL on
    // the page's origin, served by the route above.
    const src: string = "/build/pdf.min.mjs";
    const lib = await import(/* @vite-ignore */ src);
    // Served, not disabled: pdf.js 5 ignores `disableWorker` and throws.
    lib.GlobalWorkerOptions.workerSrc = "/build/pdf.worker.min.mjs";
    const binary = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const doc = await lib.getDocument({
      data: binary,
      standardFontDataUrl: "/standard_fonts/",
      cMapUrl: "/cmaps/",
      cMapPacked: true,
    }).promise;
    (window as unknown as { __pdf: unknown; __pdfjs: unknown }).__pdf = doc;
    (window as unknown as { __pdfjs: unknown }).__pdfjs = lib;
    return doc.numPages as number;
  }, Buffer.from(bytes).toString("base64"));
}

/** One PNG per page. `scale` 2 is retina, for a document read on screen. */
export async function pdfPageImages(
  sheet: Page,
  bytes: Uint8Array,
  pkg: string,
  scale = 2,
): Promise<Buffer[]> {
  const count = await open(sheet, bytes, pkg);
  const images: Buffer[] = [];
  for (let n = 1; n <= count; n += 1) {
    const size = await sheet.evaluate(
      async ([pageNumber, atScale]) => {
        const doc = (window as unknown as { __pdf: { getPage: (n: number) => Promise<PdfPage> } })
          .__pdf;
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: atScale });
        const canvas = document.getElementById("sheet") as HTMLCanvasElement;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d")!;
        // Paper carries no background of its own; without this the page reads
        // as a grey rectangle with type on it.
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
        return { width: canvas.width, height: canvas.height };
      },
      [n, scale] as const,
    );
    await sheet.setViewportSize({
      width: Math.min(size.width, 2000),
      height: Math.min(size.height, 2000),
    });
    images.push(await sheet.locator("#sheet").screenshot());
  }
  await sheet.unroute(`${ORIGIN}/**`);
  return images;
}

/**
 * Where a date was drawn on each page — the render's `data-volatile-date`.
 *
 * A mask learned from two runs cannot learn a date: both passes land on the
 * same day. A screen *declares* the region in markup; a PDF page is a canvas,
 * so the declaration comes from its text layer: runs matching `shapes` (the
 * project's `dateShapes`) or containing a string the renderer `declared`
 * volatile. **Declared first**, because a string the renderer said it drew
 * cannot be wrong the way a shape guess can — `September 2026` matches no
 * shape. Padded by half the glyph height, measured: rounded digits overshoot
 * the baseline and antialiasing spreads past that (#963).
 *
 * Paths are `pdf-date[i]`, an index and never the text: a value-keyed path
 * changes when the value does, and would write the value into a committed file.
 */
export async function pdfDateBoxes(
  sheet: Page,
  bytes: Uint8Array,
  pkg: string,
  {
    scale = 2,
    shapes,
    declared = [],
  }: { scale?: number; shapes: readonly string[]; declared?: readonly string[] },
): Promise<DomBox[][]> {
  const count = await open(sheet, bytes, pkg);
  const pages: DomBox[][] = [];
  for (let n = 1; n <= count; n += 1) {
    const raw = await sheet.evaluate(
      async ([pageNumber, atScale, sources, declaredText]) => {
        const SHAPES = sources.map((source) => new RegExp(source));
        const lib = (window as unknown as { __pdfjs: PdfLib }).__pdfjs;
        const doc = (window as unknown as { __pdf: { getPage: (n: number) => Promise<PdfPage> } })
          .__pdf;
        const page = await doc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: atScale });
        const content = await page.getTextContent();
        const out: Array<{
          left: number;
          top: number;
          right: number;
          bottom: number;
          path: string;
        }> = [];
        for (const item of content.items) {
          const str = item.str ?? "";
          if (str.trim() === "") continue;
          const isDeclared = declaredText.some(
            (want) => want.length > 0 && (str.includes(want) || want.includes(str.trim())),
          );
          if (!isDeclared && !SHAPES.some((shape) => shape.test(str))) continue;
          // The transform puts the origin on the baseline; the box's top is that
          // minus the glyph height. Edges stay un-rounded: `boxOf` rounds, once.
          const t = lib.Util.transform(viewport.transform, item.transform!);
          const glyphHeight = Math.hypot(t[2]!, t[3]!);
          const glyphWidth = (item.width ?? 0) * atScale;
          const PAD = Math.max(2, glyphHeight / 2);
          out.push({
            left: Math.max(0, t[4]! - PAD),
            top: Math.max(0, t[5]! - glyphHeight - PAD),
            right: t[4]! + glyphWidth + PAD,
            bottom: t[5]! + PAD,
            path: `pdf-date[${out.length}]`,
          });
        }
        return out;
      },
      [n, scale, [...shapes], [...declared]] as const,
    );
    pages.push(
      raw.map(({ left, top, right, bottom, path }) => ({
        ...boxOf(left, top, right, bottom),
        path,
      })),
    );
  }
  await sheet.unroute(`${ORIGIN}/**`);
  return pages;
}

/**
 * What the document *says*, page by page — the gate a picture cannot be. A
 * screenshot proves a reviewer can see the total; reading the text is what lets
 * a run fail when the total stops agreeing with the screen.
 */
export async function pdfText(sheet: Page, bytes: Uint8Array, pkg: string): Promise<string[]> {
  const count = await open(sheet, bytes, pkg);
  const pages: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    pages.push(
      await sheet.evaluate(async (pageNumber) => {
        const doc = (window as unknown as { __pdf: { getPage: (n: number) => Promise<PdfPage> } })
          .__pdf;
        const page = await doc.getPage(pageNumber);
        const content = await page.getTextContent();
        return content.items
          .map((item) => item.str ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
      }, n),
    );
  }
  await sheet.unroute(`${ORIGIN}/**`);
  return pages;
}

type PdfLib = { Util: { transform: (a: number[], b: number[]) => number[] } };

type PdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number; transform: number[] };
  render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => {
    promise: Promise<void>;
  };
  getTextContent: () => Promise<{
    items: Array<{ str?: string; transform?: number[]; width?: number }>;
  }>;
};
