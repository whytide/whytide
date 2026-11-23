// Loading this file registers signals' reader with qualification (domain/reader.ts; gamma-p5-030):
// index.ts imports it, and so do events.ts and workflows/index.ts, which the worker loads from dist/
// without index.ts. A module is evaluated once per process, so the reader is registered once.
import { defineSignalReader } from "@whytide/qualification";
import { signalReader } from "./reader.ts";

defineSignalReader(signalReader);
