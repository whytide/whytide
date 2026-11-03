import { decryptSecret as built } from "../../packages/platform/dist/secrets/worker.js";
import { decryptSecret } from "../../packages/platform/secrets/worker.ts";
export const read = [decryptSecret, built];
