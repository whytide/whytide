// The Anthropic adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example. The key is optional here, so that importing the package never throws, and
// checked when the adapter starts; the model is the one the adapter lists first.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";

export const anthropicConfig = defineConfig("packages/providers", {
  LLM_ANTHROPIC_API_KEY: secret(z.string().optional()),
  LLM_MODEL_DEFAULT: z.string().min(1).default("claude-opus-5-5"),
});
