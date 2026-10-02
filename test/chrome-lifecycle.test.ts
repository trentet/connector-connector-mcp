import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "patchright";
import { afterEach, describe, expect, it } from "vitest";
import { openSession, readOwner } from "../src/browser/chrome.js";

const CHROME = process.env.CC_TEST_CHROME ?? [...(fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter((d) => d.startsWith("chromium-")).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`) : [])].find((p) => fs.existsSync(p));
const HEADLESS = "--headless=new --no-sandbox --disable-gpu";
const up = async (port: string) => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { return false; } };
const waitDown = async (port: string) => { for (let i = 0; i < 40; i++) { if (!(await up(port))) return true; await new Promise((r) => setTimeout(r, 250)); } return false; };
const killers: (() => void)[] = [];
afterEach(() => { while (killers.length) killers.pop()!(); delete process.env.CC_CHROME_PATH; delete process.env.CC_CHROME_PROFILE; delete process.env.CC_CHROME_EXTRA_ARGS; });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cc-chrome-"));

describe.skipIf(!CHROME)("browser lifecycle (real Chromium)", () => {
  const env = (profile: string) => { process.env.CC_CHROME_PATH = CHROME!; process.env.CC_CHROME_PROFILE = profile; process.env.CC_CHROME_EXTRA_ARGS = HEADLESS; };

  it("a Chrome cc launched is shut down when the run closes", async () => {
    const port = "9341", profile = tmp(); env(profile);
    const s = await openSession({ port, artifactsDir: tmp() });
    expect(await up(port)).toBe(true);
    expect(readOwner(profile, port)).toBeDefined();
    await s.close();
    expect(await waitDown(port)).toBe(true);
    expect(readOwner(profile, port)).toBeUndefined();
  }, 60000);

  it("a Chrome somebody else started is left running", async () => {
    const port = "9342", profile = tmp(); env(profile);
    const child = spawn(CHROME!, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, ...HEADLESS.split(" "), "about:blank"], { stdio: "ignore", detached: true });
    killers.push(() => { try { process.kill(child.pid!); } catch { /* gone */ } });
    for (let i = 0; i < 40 && !(await up(port)); i++) await new Promise((r) => setTimeout(r, 250));
    const s = await openSession({ port, artifactsDir: tmp() });
    await s.close();
    await new Promise((r) => setTimeout(r, 1000));
    expect(await up(port)).toBe(true);
  }, 60000);

  it("a cc-launched Chrome with another tab in use is left running", async () => {
    const port = "9343", profile = tmp(); env(profile);
    const s = await openSession({ port, artifactsDir: tmp() });
    const other = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const p = await other.contexts()[0].newPage();
    await p.goto("data:text/html,<title>someone-else</title>");
    await s.close();
    await new Promise((r) => setTimeout(r, 1000));
    expect(await up(port)).toBe(true);
    await (await other.newBrowserCDPSession()).send("Browser.close").catch(() => {});
    expect(await waitDown(port)).toBe(true);
  }, 60000);
});
