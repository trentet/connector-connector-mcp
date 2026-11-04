import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The version in package.json, read from the file next to src/ (or dist/), so /health reports the code that is running. */
export function packageVersion(): string {
  const file = fileURLToPath(new URL("../../package.json", import.meta.url));
  const v = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
  if (typeof v !== "string" || !v) throw new Error("package.json has no version");
  return v;
}
