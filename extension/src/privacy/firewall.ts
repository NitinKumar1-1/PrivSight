/**
 * Privacy Firewall.
 *
 * The last step inside the content script before a request may leave the
 * device. It serializes the request, hands the exact bytes to the
 * independent leakage verifier, and returns either the approved bytes or a
 * block with a value-free reason. There is no other way to obtain an
 * ApprovedPayload.
 */

import type { ReasonRequest } from "../shared/contract";
import { verifySerializedPayload } from "./leakage";
import type { ApprovedPayload, FirewallVerdict, KnownValue } from "./types";

export const FIREWALL_BLOCK_PREFIX = "Privacy Firewall blocked request";

export function inspectOutgoingRequest(request: ReasonRequest, known: KnownValue[]): FirewallVerdict {
  let body: string;
  try {
    body = JSON.stringify(request);
  } catch {
    return { verdict: "blocked", reason: `${FIREWALL_BLOCK_PREFIX}: request could not be serialized`, checks: [] };
  }

  const result = verifySerializedPayload(body, known);
  if (!result.safe) {
    return { verdict: "blocked", reason: `${FIREWALL_BLOCK_PREFIX}: ${result.reason}`, checks: result.checks };
  }
  return { verdict: "allowed", body: body as ApprovedPayload, checks: result.checks };
}
