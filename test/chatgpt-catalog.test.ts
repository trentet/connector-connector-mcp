import { describe, expect, it } from "vitest";
import { parseChatGPTConnectorCatalog, inputContractCatalog } from "../src/adapters/chatgptCatalog.js";
import { compareToolCatalogs } from "../src/core/toolSchema.js";

/** REQ-D011 REQ-D012 — parse the authenticated native GET action catalog safely. */
const id = "asdk_app_example";
const actual = {
  id, actions: [
    { name: "vault_request_secret", description: "Submit a credential", params: {
      type: "object", properties: { label: { type: "string" }, username: { type: "string" } },
      required: ["label"],
    }},
  ],
};
describe("REQ-D012 native ChatGPT action-catalog readback", () => {
  it("retains exact installed-connector identity and input contracts", () => {
    const catalog = parseChatGPTConnectorCatalog(actual, id);
    expect(catalog.installationId).toBe(id);
    expect(catalog.complete).toBe(true);
    expect((catalog.tools[0].inputSchema as any).properties.username).toEqual({ type: "string" });
  });
  it("rejects an unexpected installation identity, missing actions or duplicate actions", () => {
    expect(() => parseChatGPTConnectorCatalog(actual, "other")).toThrow("mismatched");
    expect(() => parseChatGPTConnectorCatalog({ id, actions: [] }, id)).toThrow("mismatched");
    expect(() => parseChatGPTConnectorCatalog({ id, actions: [actual.actions[0], actual.actions[0]] }, id)).toThrow("duplicate");
  });
  it("cannot turn a malformed parameter contract into a valid match", () => {
    expect(() => parseChatGPTConnectorCatalog({
      id, actions: [{ name: "vault_request_secret", params: null }],
    }, id)).toThrow("Invalid");
  });
  it("can compare tool names and input schemas independently from provider metadata", () => {
    const platform = parseChatGPTConnectorCatalog(actual, id);
    const source = { complete: true, tools: [{
      name: "vault_request_secret", description: "Different provider wording", inputSchema: {
        required: ["label"], properties: { username: { type: "string" }, label: { type: "string" } },
        type: "object", additionalProperties: false,
      },
    }] };
    expect(compareToolCatalogs(inputContractCatalog(source), inputContractCatalog(platform)).status).toBe("CURRENT");
  });
});