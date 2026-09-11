/**
 * Executes a validated action against the current page.
 *
 * Only click and done are implemented. The action validator rejects every
 * other action as "unsupported by current executor" before it gets here, so
 * the default branch is defense in depth, not a normal path.
 */

import type { ExecuteActionResult } from "../shared/messages";
import type { ValidatedAction } from "./action-validator";
import { findElementByPsId } from "./element-ids";

export function executeAction(action: ValidatedAction): ExecuteActionResult {
  switch (action.action) {
    case "click":
      return clickTarget(action.target);
    case "done":
      return { ok: true, message: "Task reported as done", validation: "pass" };
    default:
      return { ok: false, message: `Action "${action.action}" is not supported by the executor`, validation: "pass" };
  }
}

function clickTarget(target: string | null | undefined): ExecuteActionResult {
  if (!target) {
    return { ok: false, message: "Click action has no target", validation: "pass" };
  }

  const element = findElementByPsId(target);
  if (!element) {
    return { ok: false, message: `No element found with data-ps-id="${target}"`, validation: "pass" };
  }

  element.scrollIntoView({ block: "center" });
  element.click();
  return { ok: true, message: `Clicked ${target}`, validation: "pass" };
}
