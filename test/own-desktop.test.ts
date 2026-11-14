// @reqs REQ-D006
// REQ-D006: the opt-in start of a run's Chrome on its own Windows desktop (CC_CHROME_DESKTOP=own). Every case of the requirement, with stand-ins for the platform and the environment
// (no process is started here). The real runs are recorded in the pull request: HTTP 200 from claude.ai, no window on the input desktop, no foreground sample in the run's process tree.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownDesktopEnabled, quoteArg, commandLine, chromeSpawnSpec, START_ON_DESKTOP_HELPER } from "../src/browser/ownDesktop.js";

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ARGS = ["--remote-debugging-port=9300", "--user-data-dir=C:\\Users\\X\\AppData\\Local\\Temp\\cc-run-abc", "--no-first-run", "about:blank"];

describe("REQ-D006 the switch", () => {
  it("is off by default, on Windows only for the value own", () => {
    expect(ownDesktopEnabled({}, "win32")).toBe(false);
    expect(ownDesktopEnabled({ CC_CHROME_DESKTOP: "own" }, "win32")).toBe(true);
  });
  it("is off for every other value", () => {
    for (const v of ["", "OWN", "1", "true", "yes", "on", "own ", "desktop"]) expect(ownDesktopEnabled({ CC_CHROME_DESKTOP: v }, "win32"), `value "${v}"`).toBe(false);
  });
  it("is off on other systems even for the value own", () => {
    for (const p of ["linux", "darwin"]) expect(ownDesktopEnabled({ CC_CHROME_DESKTOP: "own" }, p)).toBe(false);
  });
});

describe("REQ-D006 quoting of the command line", () => {
  it("leaves a plain argument alone and quotes an empty one", () => {
    expect(quoteArg("--no-first-run")).toBe("--no-first-run");
    expect(quoteArg("")).toBe("\"\"");
  });
  it("quotes an argument with a space and keeps its backslashes", () => {
    expect(quoteArg(EXE)).toBe(`"${EXE}"`);
  });
  it("escapes an embedded quote and doubles the backslashes before it", () => {
    expect(quoteArg("a\"b")).toBe("\"a\\\"b\"");
    expect(quoteArg("a\\\"b")).toBe("\"a\\\\\\\"b\"");
  });
  it("doubles a trailing backslash of a quoted argument", () => {
    expect(quoteArg("C:\\Program Files\\")).toBe("\"C:\\Program Files\\\\\"");
  });
  it("joins the executable and the arguments in order", () => {
    expect(commandLine(EXE, ARGS)).toBe(`"${EXE}" --remote-debugging-port=9300 --user-data-dir=C:\\Users\\X\\AppData\\Local\\Temp\\cc-run-abc --no-first-run about:blank`);
    expect(commandLine("chrome.exe", [])).toBe("chrome.exe");
  });
});

describe("REQ-D006 what launchChrome spawns", () => {
  it("default: chrome.exe itself with the same arguments and windowsHide false (REQ-D004 unchanged)", () => {
    expect(chromeSpawnSpec(EXE, ARGS, {}, "win32")).toEqual({ file: EXE, args: ARGS, windowsHide: false });
  });
  it("other systems and other values: unchanged, whatever CC_CHROME_DESKTOP holds", () => {
    expect(chromeSpawnSpec(EXE, ARGS, { CC_CHROME_DESKTOP: "own" }, "linux")).toEqual({ file: EXE, args: ARGS, windowsHide: false });
    expect(chromeSpawnSpec(EXE, ARGS, { CC_CHROME_DESKTOP: "1" }, "win32")).toEqual({ file: EXE, args: ARGS, windowsHide: false });
  });
  it("own desktop: the PowerShell helper with windowsHide true and the command line as base64 of UTF-16 text", () => {
    const s = chromeSpawnSpec(EXE, ARGS, { CC_CHROME_DESKTOP: "own" }, "win32", "C:\\cc\\scripts\\start-on-desktop.ps1");
    expect(s.file).toBe("powershell.exe");
    expect(s.windowsHide).toBe(true);
    expect(s.args.slice(0, 6)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\cc\\scripts\\start-on-desktop.ps1"]);
    expect(s.args[6]).toBe("-B64");
    expect(Buffer.from(s.args[7], "base64").toString("utf16le")).toBe(commandLine(EXE, ARGS));
    expect(s.args).toHaveLength(8);
  });
  it("own desktop: the CDP port, the profile folder and every other Chrome argument stay in the command line", () => {
    const s = chromeSpawnSpec(EXE, ARGS, { CC_CHROME_DESKTOP: "own" }, "win32");
    const line = Buffer.from(s.args[7], "base64").toString("utf16le");
    for (const a of ARGS) expect(line).toContain(a);
  });
  it("own desktop: the helper path defaults to scripts/start-on-desktop.ps1 of the same copy", () => {
    expect(START_ON_DESKTOP_HELPER.replace(/\\/g, "/")).toMatch(/\/scripts\/start-on-desktop\.ps1$/);
    const s = chromeSpawnSpec(EXE, ARGS, { CC_CHROME_DESKTOP: "own" }, "win32");
    expect(s.args[5]).toBe(START_ON_DESKTOP_HELPER);
  });
});

describe("REQ-D006 the helper script", () => {
  const text = readFileSync(join(process.cwd(), "scripts", "start-on-desktop.ps1"), "utf8");
  it("creates a desktop of the interactive window station and starts the command line on it", () => {
    expect(text).toMatch(/CreateDesktopW/);
    expect(text).toMatch(/lpDesktop = "WinSta0\\\\"/);
    expect(text).toMatch(/CreateProcessW/);
  });
  it("waits for the process and closes the desktop afterwards", () => {
    expect(text).toMatch(/WaitForSingleObject/);
    expect(text).toMatch(/CloseDesktop\(desk\)/);
  });
  it("reports a failing call instead of failing silently", () => {
    expect(text).toMatch(/CreateDesktop failed/);
    expect(text).toMatch(/CreateProcess failed/);
  });
  it("never uses a window style, logs nothing and holds no secret, address or profile name", () => {
    expect(text).not.toMatch(/WindowStyle/i);
    expect(text).not.toMatch(/Out-File|Add-Content|Set-Content/i);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    expect(text).not.toMatch(/browser-master-\w+/);
  });
  it("is used by chrome.ts only through chromeSpawnSpec, so the default start is the one REQ-D004 describes", () => {
    const chrome = readFileSync(join(process.cwd(), "src", "browser", "chrome.ts"), "utf8");
    expect(chrome).toMatch(/chromeSpawnSpec\(exe,/);
    expect(chrome).toMatch(/spawn\(spec\.file, spec\.args, \{ stdio: "ignore", windowsHide: spec\.windowsHide \}\)/);
    expect(chrome).not.toMatch(/START_ON_DESKTOP_HELPER/);
  });
});
