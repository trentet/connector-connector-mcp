// REQ-D006: an opt-in start of a run's Chrome on its OWN Windows desktop (CC_CHROME_DESKTOP=own), so the run shows no window and never takes the keyboard focus.
// Pure functions only (no process is started here): chrome.ts calls chromeSpawnSpec and spawns what it returns, so every case is testable without a browser.
// Default (variable not set), other systems and any other value: the start is exactly the one REQ-D004 describes (chrome.exe itself, windowsHide false).
import { fileURLToPath } from "node:url";

/** The helper that creates the desktop, starts Chrome on it, waits for it and closes the desktop. Lives next to the other scripts of the deployed copy. */
export const START_ON_DESKTOP_HELPER = fileURLToPath(new URL("../../scripts/start-on-desktop.ps1", import.meta.url));

export function ownDesktopEnabled(e: Record<string, string | undefined> = process.env, platform: string = process.platform): boolean {
  return platform === "win32" && e.CC_CHROME_DESKTOP === "own";
}

/** One argument as CommandLineToArgvW reads it back: quotes only when needed, backslashes before a quote doubled, a quote escaped. */
export function quoteArg(a: string): string {
  if (a === "") return "\"\"";
  if (!/[\s"]/.test(a)) return a;
  let out = "\"";
  let backslashes = 0;
  for (const ch of a) {
    if (ch === "\\") { backslashes++; continue; }
    if (ch === "\"") { out += "\\".repeat(backslashes * 2 + 1) + "\""; backslashes = 0; continue; }
    out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + "\\".repeat(backslashes * 2) + "\"";
}

export function commandLine(exe: string, args: string[]): string {
  return [exe, ...args].map(quoteArg).join(" ");
}

export interface SpawnSpec { file: string; args: string[]; windowsHide: boolean }

/** What launchChrome spawns. Default: chrome.exe itself, windowsHide false (REQ-D004). Own desktop (REQ-D006): the helper, windowsHide true, the command line passed as base64 of UTF-16 text. */
export function chromeSpawnSpec(exe: string, args: string[], env: Record<string, string | undefined> = process.env, platform: string = process.platform, helper: string = START_ON_DESKTOP_HELPER): SpawnSpec {
  if (!ownDesktopEnabled(env, platform)) return { file: exe, args, windowsHide: false };
  return {
    file: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-B64", Buffer.from(commandLine(exe, args), "utf16le").toString("base64")],
    windowsHide: true,
  };
}
