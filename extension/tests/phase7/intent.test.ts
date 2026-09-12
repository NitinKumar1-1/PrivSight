/**
 * Phase 7: consequential-action policy. Deterministic over the user's task
 * text and the live control's label; never consults the model.
 */

import { describe, expect, it } from "vitest";
import { authorizedIntents, consequentialBlockReason, consequentialCategory } from "../../src/content/intent";

describe("authorizedIntents", () => {
  it("reads purchase intent from an affirmative sentence", () => {
    expect(authorizedIntents("Find the cheapest black shirt and buy it")).toEqual(new Set(["purchase"]));
    expect(authorizedIntents("Find the cheapest black shirt and click Buy Now")).toEqual(new Set(["purchase"]));
  });

  it("ignores negated sentences: 'do not purchase' authorises nothing", () => {
    const task = "Go to Amazon and find the cheapest black shirt. Then add it to the cart. Do not purchase anything. Do not proceed to checkout. Do not enter or submit any payment information. Only add the cheapest black shirt to the cart, then stop.";
    expect(authorizedIntents(task)).toEqual(new Set());
  });

  it("a cart task authorises nothing consequential; sign-in and checkout are separate categories", () => {
    expect(authorizedIntents("Add the cheapest shirt to the cart")).toEqual(new Set());
    expect(authorizedIntents("Sign in and then check out")).toEqual(new Set(["account", "checkout"]));
    expect(authorizedIntents("Delete the old address")).toEqual(new Set(["destructive"]));
  });
});

describe("consequentialCategory", () => {
  it("classifies control labels", () => {
    expect(consequentialCategory("Buy Now A")).toBe("purchase");
    expect(consequentialCategory("Proceed to checkout")).toBe("checkout");
    expect(consequentialCategory("Pay now")).toBe("payment");
    expect(consequentialCategory("Sign in")).toBe("account");
    expect(consequentialCategory("Remove")).toBe("destructive");
    expect(consequentialCategory("Submit")).toBe("submit");
  });

  it("leaves ordinary controls alone", () => {
    for (const label of ["Add to Cart", "Go", "Search", "Products", "Black Shirt C", "View details", "Next page", ""]) {
      expect(consequentialCategory(label), label).toBeNull();
    }
  });
});

describe("consequentialBlockReason", () => {
  it("blocks Buy Now under a cart-only task and allows it under a buy task", () => {
    expect(consequentialBlockReason("Buy Now", authorizedIntents("Add it to the cart. Do not buy."))).toMatch(/purchase action/);
    expect(consequentialBlockReason("Buy Now C", authorizedIntents("Find the cheapest black shirt and buy it"))).toBeNull();
  });

  it("never blocks ordinary controls, whatever the task says", () => {
    expect(consequentialBlockReason("Add to Cart", new Set())).toBeNull();
    expect(consequentialBlockReason("Search", new Set())).toBeNull();
  });
});
