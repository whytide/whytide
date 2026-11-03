import { parseSecretBlob } from "./blob.ts";
import { unwrapperOf } from "./keys.ts";
export const decryptSecret = [parseSecretBlob, unwrapperOf];
