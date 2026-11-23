// The OpenAI adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example. Each is optional here, so that importing the adapter never throws, and
// checked when it starts. LLM_MODEL_DEFAULT is the variable the anthropic adapter reads too, with
// this adapter's own default: the owner sets one line, whichever adapter runs.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { DEFAULT_EFFORT, DEFAULT_MODEL } from "./constants.ts";

export const openaiConfig = defineConfig("packages/providers", {
  LLM_OPENAI_API_KEY: secret(z.string().optional()),
  LLM_OPENAI_REASONING_EFFORT: z.string().default(DEFAULT_EFFORT),
  LLM_MODEL_DEFAULT: z.string().min(1).default(DEFAULT_MODEL),
});
