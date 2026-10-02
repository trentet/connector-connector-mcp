import type { BrowserContext, Page } from "patchright";
import { domClick, domFill, sleep } from "./dom.js";

/**
 * An OAuth connector's authorization page opens in the automation Chrome when a platform's Connect step runs, with nobody
 * at the host. When the registry names a vault credential for it (auth.oauthLogin), this signs in to that page with it.
 * Deliberately narrow: only pages at the CONNECTOR'S OWN origin, only a page that shows a password field (a login form),
 * never a consent/Approve button, never any other site. A login form with no credential configured is reported, not guessed.
 */
export interface LoginCredential { username?: string; password?: string }
export interface LoginReport { signedIn: number; needsLogin: boolean }
export interface LoginWatcher { stop(): Promise<LoginReport> }

const SUBMIT_NAME = /^(sign in|log in|login|continue)$/i;

/** Handle one page. Exported for tests. */
export async function handleLoginPage(page: Page, cred: LoginCredential | undefined): Promise<"signed-in" | "needs-login" | "nothing"> {
  const pw = page.locator("input[type=password]");
  if (!(await pw.count())) return "nothing";
  if (!cred?.password) return "needs-login";
  if (cred.username) {
    const user = page.locator("input[autocomplete=username], input[name=username], input[type=email], input[type=text]").first();
    if (await user.count()) await domFill(user, cred.username);
  }
  await domFill(pw.first(), cred.password);
  const submit = page.locator("button[type=submit], input[type=submit]").first();
  if (await submit.count()) await domClick(submit);
  else await domClick(page.getByRole("button", { name: SUBMIT_NAME }).first());
  return "signed-in";
}

export function watchLogin(context: BrowserContext, connectorUrl: string, cred: LoginCredential | undefined, opts: { pollMs?: number } = {}): LoginWatcher {
  const origin = new URL(connectorUrl).origin;
  const report: LoginReport = { signedIn: 0, needsLogin: false };
  const handled = new Set<string>();
  let running = true;
  const open = () => context.pages().filter((p) => { try { const u = new URL(p.url()); return u.origin === origin && !handled.has(u.href); } catch { return false; } });
  const loop = (async () => {
    while (running) {
      for (const p of open()) {
        try {
          const r = await handleLoginPage(p, cred);
          if (r === "signed-in") { handled.add(new URL(p.url()).href); report.signedIn++; await sleep(1500); }
          else if (r === "needs-login") report.needsLogin = true;
        } catch { /* page closed or navigating: next tick */ }
      }
      await sleep(opts.pollMs ?? 1000);
    }
  })();
  return {
    async stop() {
      // The popup can still be loading when the platform's Connect step returns: keep polling briefly if a connector-origin page is open and unhandled.
      for (let i = 0; i < 8 && open().length > 0 && report.signedIn === 0; i++) await sleep(1000);
      running = false;
      await loop;
      return report;
    },
  };
}
