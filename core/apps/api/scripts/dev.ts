// `pnpm -F api dev` (README "Start"): the build once, then the compiler and the api both watching:
// tsc -b --watch rewrites dist/, node --watch restarts on it. Stopping one stops the other.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";

const built = spawnSync("pnpm", ["run", "build"], { stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);
const children: ChildProcess[] = [
  spawn("tsc", ["-b", "--watch", "--preserveWatchOutput"], { stdio: "inherit" }),
  spawn(process.execPath, ["--watch", "--enable-source-maps", "dist/src/main.js"], {
    stdio: "inherit",
  }),
];
const stop = () => {
  for (const child of children) child.kill("SIGTERM");
};
process.once("SIGINT", stop).once("SIGTERM", stop);
for (const child of children) child.once("exit", stop);
