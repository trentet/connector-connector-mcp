import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { waitForEphemeralOtp } from "../src/core/ephemeralOtp.js";

describe("Direct OTP browser handoff", () => {
  it("accepts one six-digit code and deletes the temporary handoff immediately", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-otp-"));
    const file = path.join(dir, "code");
    try {
      const pending = waitForEphemeralOtp(file, 3000, 10);
      await fs.writeFile(file, "654321\n", { flag: "wx" });
      expect(await pending).toBe("654321");
      await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(dir, { recursive:true, force:true }); }
  });
  it("does not reuse an absent or previous code", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-otp-"));
    const file = path.join(dir, "code");
    try { expect(await waitForEphemeralOtp(file, 35, 10)).toBeUndefined(); }
    finally { await fs.rm(dir, { recursive:true, force:true }); }
  });
  it("rejects malformed input without returning or retaining its value", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cc-otp-"));
    const file = path.join(dir, "code");
    try {
      await fs.writeFile(file, "private-not-a-code");
      await expect(waitForEphemeralOtp(file, 200, 10)).rejects.toThrow("valid six-digit");
      await expect(fs.access(file)).rejects.toMatchObject({code:"ENOENT"});
    } finally { await fs.rm(dir, { recursive:true, force:true }); }
  });
  it("rejects non-absolute paths", async () => {
    await expect(waitForEphemeralOtp("relative-code", 100)).rejects.toThrow("absolute");
  });
});
