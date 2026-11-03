import { encryptSecret } from "@whytide/platform";
import { startTelemetry } from "@whytide/platform/telemetry";
export const store = [encryptSecret, startTelemetry];
