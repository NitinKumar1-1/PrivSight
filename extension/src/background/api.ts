/**
 * HTTP client for the PrivSight backend.
 *
 * postReason is the only place in the extension that talks to the network.
 * It accepts a body the content-script firewall already approved and, as the
 * final runtime gate, re-runs the structure and pattern checks on the exact
 * string it is about to send. Any failure means no request is made.
 */

import { verifyPayloadPatterns } from "../privacy/leakage";
import type { ApprovedPayload } from "../privacy/types";
import type { ActionResponse } from "../shared/contract";

export const BACKEND_BASE_URL = "http://localhost:8000";
const REASON_ENDPOINT = `${BACKEND_BASE_URL}/reason`;
export const NETWORK_GATE_PREFIX = "Privacy Firewall blocked request at network boundary";

/** Returns the raw JSON body from the backend. It is untrusted until the validator has seen it. */
export async function postReason(body: ApprovedPayload): Promise<unknown> {
  const gate = verifyPayloadPatterns(body);
  if (!gate.safe) throw new Error(`${NETWORK_GATE_PREFIX}: ${gate.reason}`);

  const response = await fetch(REASON_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend returned ${response.status}: ${text}`);
  }

  return (await response.json()) as unknown;
}

/** Type-only re-export so callers can name the wire shape without trusting it. */
export type { ActionResponse };
