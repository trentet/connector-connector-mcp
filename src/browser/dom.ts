import type { Locator } from "patchright";

/** Native click: survives overlays that make Playwright's actionability checks fail (verified on claude.ai). */
export async function domClick(l: Locator): Promise<void> {
  await l.evaluate((el) => (el as HTMLElement).click());
}

/**
 * Fill through the native value setter: React tracks its own state, so plain `el.value = x` looks filled but
 * isn't. Same technique the old per-repo registrar needed on claude.ai.
 */
export async function domFill(l: Locator, value: string): Promise<void> {
  await l.evaluate((el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, v); else (el as HTMLInputElement).value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
