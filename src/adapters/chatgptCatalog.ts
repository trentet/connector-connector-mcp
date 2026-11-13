/**
 * REQ-D011 REQ-D012 — read the same authenticated connector-action response
 * ChatGPT's own management page requests. A stand-alone fetch from the page
 * is not equivalent: it returned 401 in the 2026-11-12 live test, while the
 * native UI GET returned 200. We observe the response without copying tokens.
 */
import type { Page } from "patchright";
import type { ToolCatalog } from "../core/toolSchema.js";

export interface ChatGPTAction {
  name?: unknown;
  description?: unknown;
  description_model?: unknown;
  title?: unknown;
  params?: unknown;
  return_type?: unknown;
}
export type ChatGPTConnectorMetadata = {
  id?: unknown;
  name?: unknown;
  actions?: unknown;
};

export function parseChatGPTConnectorCatalog(
  payload: ChatGPTConnectorMetadata, expectedId: string,
): ToolCatalog {
  if (!payload || payload.id !== expectedId || !Array.isArray(payload.actions) ||
      payload.actions.length === 0 || payload.actions.length > 2500) {
    throw new Error("ChatGPT connector action catalog unavailable or mismatched");
  }
  const names = new Set<string>();
  const tools = payload.actions.map((raw: ChatGPTAction) => {
    if (!raw || typeof raw.name !== "string" || !raw.name.trim() ||
        names.has(raw.name) || raw.name !== raw.name.trim() ||
        !raw.params || typeof raw.params !== "object" || Array.isArray(raw.params)) {
      throw new Error("Invalid or duplicate ChatGPT action contract");
    }
    names.add(raw.name);
    return {
      name: raw.name,
      ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      ...(typeof raw.description_model === "string" ? { description: raw.description_model } :
        typeof raw.description === "string" ? { description: raw.description } : {}),
      inputSchema: raw.params,
      ...(raw.return_type && typeof raw.return_type === "object" ? { outputSchema: raw.return_type } : {}),
    };
  });
  return { tools, complete: true, installationId: expectedId };
}

/**
 * A page has already been opened under the exact account and exact installed
 * connector identity; it is reloaded so we can observe the platform's real
 * authenticated GET response (not an unauthenticated direct fetch).
 */
export async function readChatGPTInstalledToolCatalog(
  page: Page, exactName: string, expectedId?: string,
): Promise<ToolCatalog> {
  const u = new URL(page.url());
  const match = /^\/settings\/plugins-settings\/plugin_([a-zA-Z0-9_-]+)$/.exec(u.pathname);
  if (u.hostname !== "chatgpt.com" || !match || (expectedId && expectedId !== match[1])) {
    throw new Error("Wrong ChatGPT connector detail identity");
  }
  const id = match[1], endpoint = "/backend-api/aip/connectors/" + id;
  if ((await page.getByRole("heading", { name: exactName, exact: true }).count()) !== 1) {
    throw new Error("ChatGPT detail does not uniquely name requested connector");
  }
  // Establish listener before navigating. Consume only this exact GET response.
  const observed = page.waitForResponse((resp) => {
    const address = new URL(resp.url());
    return address.hostname === "chatgpt.com" && address.pathname === endpoint &&
      resp.request().method() === "GET";
  }, { timeout: 20000 });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  const response = await observed;
  if (response.status() !== 200) throw new Error("ChatGPT authenticated metadata read refused");
  if ((await page.getByRole("heading", { name: exactName, exact: true }).count()) !== 1) {
    throw new Error("ChatGPT detail identity changed during read");
  }
  let payload: ChatGPTConnectorMetadata;
  try { payload = await response.json(); }
  catch { throw new Error("ChatGPT metadata response could not be parsed"); }
  return parseChatGPTConnectorCatalog(payload, id);
}

/**
 * REQ-D011: exact tool names and input field definitions/required are compared
 * separately from provider-owned title/description/return-type metadata. This
 * proves input contract freshness, NOT full output/description equivalence.
 */
export function inputContractCatalog(catalog: ToolCatalog): ToolCatalog {
  return {
    installationId: catalog.installationId,
    complete: catalog.complete,
    tools: catalog.tools.map((t) => {
      const raw = t.inputSchema as Record<string, unknown> | undefined;
      const schema = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      return {
        name: t.name,
        inputSchema: {
          type: schema.type ?? "object",
          properties: schema.properties ?? {},
          required: schema.required ?? [],
        },
      };
    }),
  };
}