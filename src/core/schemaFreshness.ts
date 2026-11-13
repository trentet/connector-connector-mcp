/**
 * REQ-D011, REQ-D012, REQ-D014 — fail-closed, identity-safe schema reconciliation.
 *
 * Platform integrations supply source/installed readers and a native in-place
 * refresh action. A general remove/re-add operation MUST NEVER be passed as
 * refreshNative. No account is assumed from a browser's cookie.
 */
import { compareToolCatalogs, type CatalogComparison, type ToolCatalog } from "./toolSchema.js";

export type FreshnessStatus = "CURRENT" | "STALE" | "UNKNOWN" | "ACCOUNT_BLOCKED" | "REFRESH_FAILED";

export type FreshnessResult = {
  status: FreshnessStatus;
  attemptedRefresh: boolean;
  refreshed: boolean;
  reason?: string;
  comparison?: CatalogComparison;
};

type RefreshAcknowledgement = {
  acknowledged: boolean;
  /** Must equal the original platform installation id. */
  installationId: string;
  mode: "native-in-place";
};

export type FreshnessServices = {
  /** Exact owner-authorized account (never a default or inferred account). */
  expectedAccount: string;
  /** Independently verifies the account in the live platform session. */
  readAccount: () => Promise<string | null>;
  /** Read a complete current MCP tools/list contract from the server. */
  readServerCatalog: () => Promise<ToolCatalog>;
  /** Read all currently installed tool contracts from the named platform. */
  readPlatformCatalog: () => Promise<ToolCatalog>;
  /** Optional only when this platform has a verified non-destructive native Refresh. */
  refreshNative?: (installationId: string) => Promise<RefreshAcknowledgement>;
};

const result = (status: FreshnessStatus, reason: string, comparison?: CatalogComparison,
  attemptedRefresh = false, refreshed = false): FreshnessResult =>
  ({ status, reason, comparison, attemptedRefresh, refreshed });

async function accountMatches(services: FreshnessServices): Promise<boolean> {
  // No expected account, ambiguous identity, or an unreadable session is a hard refusal.
  if (!services.expectedAccount || services.expectedAccount !== services.expectedAccount.trim()) return false;
  try {
    const observed = await services.readAccount();
    return observed === services.expectedAccount;
  } catch {
    return false;
  }
}

async function readBoth(services: FreshnessServices): Promise<{
  upstream: ToolCatalog; downstream: ToolCatalog; comparison: CatalogComparison;
} | null> {
  try {
    const upstream = await services.readServerCatalog();
    const downstream = await services.readPlatformCatalog();
    const comparison = compareToolCatalogs(upstream, downstream);
    return { upstream, downstream, comparison };
  } catch {
    return null;
  }
}

/**
 * REQ-D012 — may refresh only the existing installation, once, via a native
 * action; post-action HTTP 200 or UI acknowledgement does NOT prove freshness.
 *
 * REQ-D014 — platform identity is checked both before and after refresh. No
 * source or platform reads occur when the account is not proven.
 */
export async function reconcileToolSchemas(services: FreshnessServices): Promise<FreshnessResult> {
  if (!(await accountMatches(services))) return result("ACCOUNT_BLOCKED", "account-unverified-or-mismatched");
  const first = await readBoth(services);
  if (!first) return result("UNKNOWN", "source-or-platform-read-failed");
  const initial = first.comparison;
  if (initial.status === "UNKNOWN") return result("UNKNOWN", initial.reason ?? "catalog-unverified", initial);
  if (initial.status === "CURRENT") return result("CURRENT", "catalogs-match", initial);

  if (!services.refreshNative) return result("STALE", "native-refresh-unavailable", initial);
  const originalId = first.downstream.installationId;
  if (!originalId || !originalId.trim()) {
    return result("STALE", "installation-identity-unavailable", initial);
  }

  let acknowledged: RefreshAcknowledgement;
  try {
    acknowledged = await services.refreshNative(originalId);
  } catch {
    return result("REFRESH_FAILED", "native-refresh-threw", initial, true);
  }
  if (!acknowledged || !acknowledged.acknowledged ||
      acknowledged.mode !== "native-in-place" || acknowledged.installationId !== originalId) {
    return result("REFRESH_FAILED", "native-refresh-not-verified", initial, true);
  }
  if (!(await accountMatches(services))) {
    return result("ACCOUNT_BLOCKED", "account-changed-after-refresh", initial, true);
  }

  // Read the *current* server schema again to catch concurrent server deployment,
  // then compare against the *new* platform catalog; don't trust stale pre-refresh data.
  const after = await readBoth(services);
  if (!after) return result("REFRESH_FAILED", "post-refresh-read-failed", initial, true);
  if (after.downstream.installationId !== originalId) {
    return result("REFRESH_FAILED", "installation-identity-changed", after.comparison, true);
  }
  if (after.comparison.status !== "CURRENT") {
    return result("REFRESH_FAILED", "post-refresh-catalog-not-current", after.comparison, true);
  }
  return result("CURRENT", "refresh-and-readback-verified", after.comparison, true, true);
}