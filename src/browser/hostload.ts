import os from "node:os";

/**
 * Host load, for politeness: cc shares its machine with other workloads (transcription, other threads' browsers), so
 * it only starts another browser while the host has headroom. Cheap to call: no WMI, no child processes.
 */

const cpuTimes = () => os.cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq }), { idle: 0, total: 0 });

/** Percent of all CPU capacity in use over the next `ms` milliseconds (0 to 100). */
export async function sampleCpuBusy(ms = 500): Promise<number> {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, ms));
  const b = cpuTimes();
  const total = b.total - a.total;
  return total <= 0 ? 0 : Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / total) * 100));
}

export const freeMemGB = () => os.freemem() / 1024 ** 3;

export interface Headroom { maxCpuPercent: number; minFreeGB: number }
export const headroomLimits = (e = process.env): Headroom => ({
  maxCpuPercent: Number(e.CC_ADMIT_MAX_CPU) || 60,
  minFreeGB: e.CC_ADMIT_MIN_FREE_GB === undefined ? 1.5 : Number(e.CC_ADMIT_MIN_FREE_GB),
});

/**
 * How many cc browsers this hardware can carry at once: the CPU budget (cores x CC_ADMIT_MAX_CPU) divided by what one cc Chrome uses
 * (about 1.7 cores, measured; CC_BROWSER_CORES overrides). Never below 1. A weak laptop gets 2, a 32-core server gets 11, with no per-host tuning.
 */
export function capacityByHardware(limits: Headroom = headroomLimits(), cores = os.cpus().length, e = process.env): number {
  const per = Number(e.CC_BROWSER_CORES) || 1.7;
  return Math.max(1, Math.floor((cores * limits.maxCpuPercent) / 100 / per + 1e-9));
}

/** True when the host can take another browser right now. `sample` is injectable for tests. */
export async function hasHeadroom(limits: Headroom = headroomLimits(), sample: () => Promise<number> = () => sampleCpuBusy(), freeGB: () => number = freeMemGB): Promise<{ ok: boolean; cpu: number; freeGB: number }> {
  const cpu = await sample();
  const free = freeGB();
  return { ok: cpu < limits.maxCpuPercent && free >= limits.minFreeGB, cpu, freeGB: free };
}
