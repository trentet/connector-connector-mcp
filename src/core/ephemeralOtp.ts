import fs from "node:fs/promises";
import path from "node:path";

/**
 * One-time browser handoff for a user-provided six-digit code.
 * No Vault entry and no persisted output. Caller creates the file only when the
 * login browser has displayed a verification input, then this helper deletes it
 * before returning the value for immediate field entry.
 */
export async function waitForEphemeralOtp(filePath: string, timeoutMs: number, pollMs = 750): Promise<string | undefined> {
  if (!path.isAbsolute(filePath)) throw new Error("OTP handoff path must be absolute");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid OTP handoff timeout");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let raw: string | undefined;
    try {
      const stats = await fs.stat(filePath);
      if (stats.size > 64) throw new Error("OTP handoff input exceeds length limit");
      raw = await fs.readFile(filePath, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (raw !== undefined) {
      // Delete immediately, whether the format is good or bad. Never retry,
      // print, log, or write an entered OTP.
      await fs.unlink(filePath).catch(() => {});
      const code = raw.trim();
      if (!/^\d{6}$/.test(code)) throw new Error("OTP handoff contains no valid six-digit code");
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return undefined;
}
