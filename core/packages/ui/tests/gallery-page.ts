// The gallery in a page, for every spec of this package. esbuild bundles tests/gallery-entry.tsx in
// memory, and Tailwind compiles tests/gallery.css, once per worker. The page sits at a loopback address that the test's own route answers, a
// secure context, as the Clipboard API needs, and every other request is aborted: no server runs and
// nothing leaves the machine.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import tailwind from "@tailwindcss/postcss";
import { build } from "esbuild";
import postcss, { type AcceptedPlugin } from "postcss";

export type Messages = Record<string, string>;
type Bundle = { gallery: { render: (messages: Messages, locale: string) => void } };

const here = import.meta.dirname;
const address = "http://127.0.0.1/gallery";
// No message goes into the HTML: the title is set as text once the page is there.
const html =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title></title></head><body><div id="root"></div></body></html>';
const read = (path: string) => readFileSync(`${here}/${path}`, "utf8");
let bundle: Promise<string> | undefined;
let styles: Promise<string> | undefined;

/** ui's messages, the platform's generic error text and the fixture's error code, in one flat object. */
export function galleryMessages(): Messages {
  const files = [
    "../messages/en.json",
    "../../platform/messages/en.json",
    "fixtures/gallery/messages.json",
  ];
  return Object.assign({}, ...files.map((file) => JSON.parse(read(file)) as Messages));
}

/** The same keys, each its own text: a word on the page that is no key came from somewhere else. */
export function keysOnly(messages: Messages): Messages {
  return Object.fromEntries(Object.keys(messages).map((key) => [key, key]));
}

/**
 * The gallery in `page`, rendered with `messages`, its numbers and dates formatted for `locale`; it
 * resolves once the gallery's `main` is there.
 */
export async function openGallery(page: Page, messages: Messages, locale = "en"): Promise<void> {
  bundle ??= build({
    entryPoints: [`${here}/gallery-entry.tsx`],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "gallery",
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "warning",
  }).then((result) => result.outputFiles[0]?.text ?? "");
  await page.route("**", (route) => route.abort());
  await page.route(address, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(address);
  // The plugin is typed against the postcss that next brings (8.5.23); this package runs 8.5.31.
  styles ??= postcss([tailwind() as unknown as AcceptedPlugin])
    .process(read("gallery.css"), { from: `${here}/gallery.css` })
    .then((result) => result.css);
  await page.addStyleTag({ content: await styles });
  await page.addScriptTag({ content: await bundle });
  await page.evaluate(
    ({ m, locale }) => {
      document.title = m["ui.gallery.title"] ?? "";
      (globalThis as unknown as Bundle).gallery.render(m, locale);
    },
    { m: messages, locale },
  );
  await page.getByRole("main").waitFor();
}
