import { createRequire } from "node:module";
import { editor } from "@mastra/editor/ee";
export const license = createRequire(import.meta.url)("@mastra/core/dist/license/index.cjs");
export const deep = await import("../../../node_modules/@mastra/core/dist/auth/ee/index.js");
export const vendored = await import("../../../vendor/@mastra/core/auth/index.js");
export const editors = [editor];
