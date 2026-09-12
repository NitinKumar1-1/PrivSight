/**
 * Phase 6: the popup's status word follows the controller's stage events.
 * Pure state machine, no DOM.
 */

import { describe, expect, it } from "vitest";
import { nextState, stateHint, stateKind, TERMINAL_STATES, type AgentState } from "../../src/popup/state";
import type { PipelineStage, StageState } from "../../src/shared/messages";

function replay(events: Array<[PipelineStage, StageState]>, start: AgentState = "Observing"): AgentState[] {
  const states: AgentState[] = [];
  let current = start;
  for (const [stage, state] of events) {
    current = nextState(current, stage, state);
    states.push(current);
  }
  return states;
}

describe("popup agent state", () => {
  it("walks Observing -> Protecting privacy -> Reasoning -> Validating -> Executing -> Complete on a successful run", () => {
    const states = replay([
      ["vision", "pass"], ["dom", "pass"], ["detect", "pass"], ["visual-redaction", "pass"], ["leakage", "pass"], ["firewall", "pass"],
      ["reason", "pending"], ["reason", "pass"], ["validate", "pending"], ["validate", "pass"], ["execute", "pass"],
    ]);
    expect(states).toEqual([
      "Observing", "Observing", "Protecting privacy", "Protecting privacy", "Protecting privacy", "Reasoning",
      "Reasoning", "Validating", "Validating", "Executing", "Complete",
    ]);
  });

  it("a firewall block ends in Blocked and the skipped stages do not move it", () => {
    const states = replay([["dom", "pass"], ["detect", "pass"], ["leakage", "fail"], ["firewall", "fail"], ["reason", "skipped"], ["validate", "skipped"], ["execute", "skipped"]]);
    expect(states.at(-1)).toBe("Blocked");
    expect(states.slice(3)).toEqual(["Blocked", "Blocked", "Blocked", "Blocked"]);
  });

  it("a validator block is Blocked, and a re-observation returns to Observing", () => {
    const states = replay([["validate", "fail"], ["vision", "pass"], ["dom", "pass"]], "Validating");
    expect(states).toEqual(["Blocked", "Observing", "Observing"]);
  });

  it("vision fallback keeps observing; reason and execute failures are Failed", () => {
    expect(nextState("Observing", "vision", "fallback")).toBe("Observing");
    expect(nextState("Reasoning", "reason", "fail")).toBe("Failed");
    expect(nextState("Executing", "execute", "fail")).toBe("Failed");
  });

  it("every state has a kind and a hint, and only Complete/Unverified/Blocked/Failed are terminal", () => {
    const all: AgentState[] = ["Idle", "Observing", "Protecting privacy", "Reasoning", "Validating", "Executing", "Re-observing", "Complete", "Unverified", "Blocked", "Failed"];
    for (const state of all) {
      expect(stateHint(state).length).toBeGreaterThan(10);
      expect(["idle", "busy", "ok", "blocked", "failed", "unverified"]).toContain(stateKind(state));
    }
    expect([...TERMINAL_STATES].sort()).toEqual(["Blocked", "Complete", "Failed", "Unverified"]);
  });
});
