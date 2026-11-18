import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchChrome, shutdownChrome } from "../src/browser/chrome.js";
import { profileInUse, removeProfile } from "../src/browser/profile.js";

// REQ-D015: a Chrome running on a user-data-dir makes it "in use" on every platform, so a clone refuses it with the stated message.
const CHROME = process.env.CC_TEST_CHROME ?? (fs.existsSync("/opt/pw-browsers") ? fs.readdirSync("/opt/pw-browsers").filter((d) => d.startsWith("chromium-")).map((d) => `/opt/pw-browsers/${d}/chrome-linux/chrome`).find((p) => fs.existsSync(p)) : undefined);
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const dirs: string[] = [];
afterEach(() => { for (const k of ["CC_CHROME_PATH", "CC_CHROME_EXTRA_ARGS"]) delete process.env[k]; while (dirs.length) removeProfile(dirs.pop()!); /* retries, and never throws: Chrome releases its files a moment after it exits on Windows */ });

describe.skipIf(!CHROME)("REQ-D015 profileInUse against a real Chrome", () => {
  const start = async () => {
    Object.assign(process.env, { CC_CHROME_PATH: CHROME, CC_CHROME_EXTRA_ARGS: "--headless=new --no-sandbox --disable-gpu" });
    const dir = tmp("cc-inuse-"); dirs.push(dir);
    return { dir, ...(await launchChrome(dir, 9600)) };
  };
  it("TC-D015-01 a running Chrome makes its profile folder in use", async () => {
    const l = await start();
    try { expect(profileInUse(l.dir)).toBe(true); } finally { await shutdownChrome(undefined, l.child, l.exited); }
  }, 60000);
  it("TC-D015-02 the folder is not in use once that Chrome has exited", async () => {
    const l = await start();
    await shutdownChrome(undefined, l.child, l.exited);
    expect(profileInUse(l.dir)).toBe(false);
  }, 60000);
});

describe("REQ-D015 profileInUse without a Chrome", () => {
  it("TC-D015-03 a folder with no Chrome, or a leftover lockfile nobody holds, is not in use", () => {
    const empty = tmp("cc-cold-"); dirs.push(empty);
    expect(profileInUse(empty)).toBe(false);
    const stale = tmp("cc-stale-"); dirs.push(stale);
    fs.writeFileSync(path.join(stale, "lockfile"), "");
    expect(profileInUse(stale)).toBe(false);
  });
});