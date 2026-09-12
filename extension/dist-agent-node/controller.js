const DONE_REASON_CODES = /* @__PURE__ */ new Set(["MISSING_REQUIRED_DATA", "AMBIGUOUS_TARGET", "INSUFFICIENT_EVIDENCE"]);
function outcomeForValidation(code) {
  switch (code) {
    case "unknown_target":
    case "incompatible_target":
    case "target_not_clickable":
      return "STALE_TARGET";
    case "target_occluded":
      return "TARGET_OCCLUDED";
    case "ambiguous_target":
      return "AMBIGUOUS_TARGET";
    case "unsupported_action":
    case "unsupported_by_executor":
      return "UNSUPPORTED_ACTION";
    case "repeated_action":
      return "REPEATED_ACTION";
    case "consequential_action":
    case "navigation_not_authorised":
    case "sensitive_policy":
    case "dangerous_navigation":
      return "SAFETY_BLOCK";
    case void 0:
      return "UNKNOWN_ERROR";
    default:
      return "INVALID_MODEL_RESPONSE";
  }
}
function classifyError(message) {
  const text = message.toLowerCase();
  if (/privacy firewall|leakage/.test(text)) return "PRIVACY_BLOCK";
  if (/timed? ?out|timeout|aborted/.test(text)) return "CLOUD_TIMEOUT";
  if (/invalid action from reasoning provider|not valid json|does not match the contract|unusable action/.test(text)) return "INVALID_MODEL_RESPONSE";
  if (/failed to fetch|networkerror|network error|econnrefused|could not connect|fetch failed/.test(text)) return "NETWORK_ERROR";
  if (/backend returned \d{3}|reasoning provider error|cloud reasoner unavailable|quota/.test(text)) return "CLOUD_ERROR";
  if (/could not establish connection|receiving end does not exist|message port closed|no active tab|cannot access|frame was removed|no web page|execution context was destroyed|because of a navigation/.test(text)) return "PAGE_UNAVAILABLE";
  if (/page extraction failed|extract/.test(text)) return "PAGE_UNAVAILABLE";
  return "UNKNOWN_ERROR";
}
function scaleRegions(regions, devicePixelRatio) {
  const f = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  return regions.map((r) => ({ x: Math.round(r.x * f), y: Math.round(r.y * f), width: Math.round(r.width * f), height: Math.round(r.height * f) }));
}
const MAX_TEXT = 2e4;
const CART = "(?:cart|bag|basket|trolley)";
const CART_ADD = new RegExp(`\\badd(?:ed|ing)?\\b[^.]{0,20}?\\bto (?:the |my |your )?${CART}\\b`, "i");
const CART_COUNT_PATTERNS = [
  new RegExp(`(\\d+)\\s*(?:items?|products?)?\\s*(?:in|added to)\\s+(?:your |the |my )?${CART}\\b`, "i"),
  new RegExp(`\\b${CART}\\b\\D{0,3}(\\d+)\\b`, "i"),
  new RegExp(`\\b(\\d+)\\s*\\b${CART}\\b`, "i")
];
const GO_TO_CART = new RegExp(`^(?:go to|view|open|see|proceed to)\\s+(?:your |the |my )?${CART}\\b|^${CART}\\s*\\(\\d+\\)`, "i");
const CART_CONFIRMATION = new RegExp(`\\badded to (?:your |the |my )?${CART}\\b|\\bitems? added\\b|\\bin your ${CART}\\b|\\bsuccessfully added\\b`, "i");
const PURCHASE_LABEL = /\b(buy( it)? now|buy|purchase|place (your |the )?order|order now|check ?out|proceed to (checkout|pay|payment|buy))\b/i;
const CHECKOUT_STATE = /checkout|payment|\bpay\b|order|purchase|\bbuy\b|address|shipping/i;
const SEARCH_CONTROL = /\b(search|go|find|submit|lookup|look up)\b|^🔍$|magnif/i;
const QUERY_PARAMS = ["q", "query", "search", "k", "s", "keyword", "keywords", "term", "text", "searchterm", "search_query", "field-keywords"];
const RESULTS_TEXT = /\bresults?\b|\bshowing\b|\bfound\b/i;
const STOPWORDS = /* @__PURE__ */ new Set(["the", "and", "for", "with", "from", "that", "this", "open", "page", "site", "website", "then", "please", "into", "onto", "about", "search", "find", "look", "show", "article", "click", "under", "over", "cheapest", "best"]);
function goalOf(task) {
  const text = task.toLowerCase();
  if (CART_ADD.test(text) || new RegExp(`\\b(?:put|place)\\b[^.]{0,30}\\bin (?:the |my )?${CART}\\b`).test(text)) return "cart";
  if (/\b(buy|purchase|order|checkout|check out|pay for)\b/.test(text)) return "purchase";
  if (/\b(search|find|look for|look up|show me|locate|browse for)\b/.test(text)) return "search";
  if (/\b(open|go to|visit|navigate to|load)\b/.test(text)) return "open";
  return "other";
}
function pageFactsFromBody(body) {
  try {
    const parsed = JSON.parse(body);
    const page = parsed.page;
    if (!page) return null;
    return {
      url: (page.url ?? "").toLowerCase(),
      title: (page.title ?? "").toLowerCase(),
      labels: Array.isArray(page.elements) ? page.elements.map((e) => (e.text ?? "").toLowerCase().trim()).filter(Boolean) : [],
      text: (page.text ?? "").toLowerCase().slice(0, MAX_TEXT)
    };
  } catch {
    return null;
  }
}
function verifyCompletion(task, history, observations) {
  const goal = goalOf(task);
  const first = observations.find((o) => o !== null) ?? null;
  const last = [...observations].reverse().find((o) => o !== null) ?? null;
  const actions = history.filter((h) => h.action !== "done");
  switch (goal) {
    case "search":
      return verifySearch(actions, first, last);
    case "cart":
      return verifyCart(actions, observations);
    case "purchase":
      return verifyPurchase(actions, last);
    case "open":
      return verifyOpen(task, actions, last);
    default:
      if (actions.length === 0) return { state: "verified", goal, evidence: ["no browser state change was requested; the answer is in the reasoner's report"], missing: "" };
      return { state: "unverified", goal, evidence: [], missing: "the task names no end state that can be checked on the page" };
  }
}
function verifySearch(actions, first, last) {
  const evidence = [];
  const typedIndex = findLastIndex(actions, (a) => a.action === "type" && a.value !== null);
  const typed = typedIndex >= 0 ? (actions[typedIndex].value ?? "").toLowerCase().trim() : "";
  const afterTyping = typedIndex >= 0 ? actions.slice(typedIndex + 1) : [];
  const submissions = afterTyping.filter((a) => (a.action === "press" || a.action === "click") && a.effect !== "no_change" && a.effect !== "unknown");
  const submitted = submissions.length > 0;
  const navigated = submissions.some((a) => a.effect === "url_changed");
  const viaSearchControl = submissions.some((a) => a.action === "press" || SEARCH_CONTROL.test(a.label ?? ""));
  if (navigated) evidence.push("the typed query was submitted and the browser moved to a results page");
  else if (submitted) evidence.push(viaSearchControl ? "the typed query was submitted through the search control and the page changed" : "a control was used after typing and the page changed");
  if (last) {
    const query = queryFromUrl(last.url);
    if (query && (!typed || query.includes(typed) || typed.includes(query))) evidence.push("the page url carries the search query");
    if (typed && last.title.includes(typed)) evidence.push("the page title names the query");
    if (RESULTS_TEXT.test(last.text) && (!typed || last.text.includes(typed))) evidence.push("the page shows results");
    if (first && last.url !== first.url && /search|results|\?q=|\?k=|query=/.test(last.url)) evidence.push("the url moved to a results page");
  }
  if (typed && !submitted && !evidence.some((e) => /url|title|results/.test(e))) {
    return { state: "not_complete", goal: "search", evidence, missing: "the query was typed but never submitted: no search button was clicked and Enter was not pressed, and the page shows no results" };
  }
  if (evidence.length >= 2 || evidence.length === 1 && /url|title|results/.test(evidence[0]) || navigated) return { state: "verified", goal: "search", evidence, missing: "" };
  if (actions.length === 0) return { state: "not_complete", goal: "search", evidence, missing: "no search was performed and the page shows no results for it" };
  return { state: "unverified", goal: "search", evidence, missing: "the page shows no results signal that can be checked" };
}
function verifyCart(actions, observations) {
  const evidence = [];
  const cartClicks = actions.filter((a) => a.action === "click" && a.label !== void 0 && CART_ADD.test(a.label));
  if (cartClicks.some((c) => c.cartAdded)) evidence.push("the executor saw the cart change right after the add-to-cart click");
  const facts = observations.filter((o) => o !== null);
  if (facts.length >= 2) {
    const before = facts[0];
    const after = facts[facts.length - 1];
    const countBefore = cartCount(before);
    const countAfter = cartCount(after);
    if (countBefore !== null && countAfter !== null && countAfter > countBefore) evidence.push("the cart count went up");
    if (!before.labels.some((l) => GO_TO_CART.test(l)) && after.labels.some((l) => GO_TO_CART.test(l))) evidence.push("a go-to-cart control appeared");
    if (!CART_CONFIRMATION.test(before.text) && CART_CONFIRMATION.test(after.text)) evidence.push("an added-to-cart confirmation appeared");
  }
  if (evidence.length > 0) return { state: "verified", goal: "cart", evidence, missing: "" };
  if (cartClicks.length === 0) return { state: "not_complete", goal: "cart", evidence, missing: "no add-to-cart control was used and the cart shows no change" };
  if (cartClicks.every((c) => c.effect === "no_change")) return { state: "not_complete", goal: "cart", evidence, missing: "the add-to-cart click changed nothing on the page" };
  return { state: "unverified", goal: "cart", evidence, missing: "an add-to-cart control was clicked and the page changed, but no cart count, confirmation or go-to-cart control could be found to confirm it" };
}
function verifyPurchase(actions, last) {
  const evidence = [];
  const purchaseClicks = actions.filter((a) => a.action === "click" && a.label !== void 0 && PURCHASE_LABEL.test(a.label) && a.effect !== "no_change");
  if (purchaseClicks.length > 0) evidence.push("a purchase control was clicked and the page changed");
  if (last && (CHECKOUT_STATE.test(last.url) || CHECKOUT_STATE.test(last.title))) evidence.push("the page is a checkout, payment or order page");
  if (last && /order (?:placed|confirmed)|thank you for your (?:order|purchase)/.test(last.text)) evidence.push("the page confirms the order");
  if (evidence.length >= 2) return { state: "verified", goal: "purchase", evidence, missing: "" };
  if (purchaseClicks.length === 0) return { state: "not_complete", goal: "purchase", evidence, missing: "no purchase control was used and the page is not a checkout page" };
  return { state: "unverified", goal: "purchase", evidence, missing: "the purchase flow could not be confirmed from the page" };
}
function verifyOpen(task, actions, last) {
  const evidence = [];
  const moved = actions.some((a) => a.effect === "url_changed" || a.action === "navigate");
  if (moved) evidence.push("the browser moved to a new page");
  if (last) {
    const keywords = task.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
    const hit = keywords.find((w) => last.title.includes(w) || last.url.includes(w));
    if (hit) evidence.push("the page title or url names what the task asked to open");
  }
  if (evidence.length >= 2 || evidence.length === 1 && !moved) return { state: "verified", goal: "open", evidence, missing: "" };
  if (!moved && actions.length === 0) return { state: "not_complete", goal: "open", evidence, missing: "nothing was opened" };
  return { state: "unverified", goal: "open", evidence, missing: "the opened page could not be matched to the task" };
}
const BLOCKER_PHRASES = [
  "out of stock",
  "sold out",
  "currently unavailable",
  "not available",
  "unavailable",
  "no longer available",
  "no results",
  "no matching",
  "notify me",
  "coming soon",
  "discontinued",
  "cannot be delivered",
  "not deliverable",
  "does not deliver",
  "sign in",
  "log in",
  "login",
  "access denied",
  "captcha",
  "verify you are human",
  "something went wrong",
  "error",
  "minimum order",
  "not eligible",
  "restricted",
  "temporarily"
];
function assessBlockerClaim(reason, facts) {
  const text = reason.toLowerCase();
  if (!text.trim()) return { claimed: false, supported: false, phrase: null };
  const claimedPhrases = BLOCKER_PHRASES.filter((p) => text.includes(p));
  if (claimedPhrases.length === 0) return { claimed: true, supported: false, phrase: null };
  if (!facts) return { claimed: true, supported: false, phrase: claimedPhrases[0] };
  const haystack = `${facts.text} ${facts.labels.join(" ")} ${facts.title}`;
  const shown = claimedPhrases.find((p) => haystack.includes(p));
  return { claimed: true, supported: shown !== void 0, phrase: shown ?? claimedPhrases[0] };
}
function goalEndState(goal) {
  switch (goal) {
    case "search":
      return "the search is submitted and results are visible";
    case "cart":
      return "the item is in the cart (count up, added confirmation or a go-to-cart control)";
    case "purchase":
      return "the checkout or payment page is reached";
    case "open":
      return "the requested page is open";
    default:
      return "the task's requested outcome is visible on the page";
  }
}
function cartCount(facts) {
  for (const label of facts.labels) {
    if (!/cart|bag|basket|trolley/i.test(label)) continue;
    for (const pattern of CART_COUNT_PATTERNS) {
      const m = pattern.exec(label);
      if (m) return Number(m[1]);
    }
  }
  for (const pattern of CART_COUNT_PATTERNS) {
    const m = pattern.exec(facts.text);
    if (m && Number(m[1]) < 1e3) return Number(m[1]);
  }
  return null;
}
function queryFromUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of QUERY_PARAMS) {
      const value = parsed.searchParams.get(key);
      if (value) return value.toLowerCase().replace(/\+/g, " ").trim();
    }
    if (/\/search\b/.test(parsed.pathname)) return parsed.pathname.split("/").pop()?.replace(/[-_]+/g, " ") || "";
  } catch {
  }
  return null;
}
function findLastIndex(items, predicate) {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
}
const HARM_VERB_STEMS = [
  "kill",
  "murder",
  "hurt",
  "harm",
  "injur",
  "stab",
  "shoot",
  "poison",
  "strangl",
  "chok",
  "assault",
  "attack",
  "beat up",
  "beat",
  "tortur",
  "rape",
  "kidnap",
  "abduct",
  "maim",
  "drown",
  "suffocat",
  "slaughter",
  "butcher",
  "behead",
  "execut",
  "blow up",
  "bomb",
  "burn",
  "set fire to",
  "run over",
  "cut up",
  "wound",
  "cripple",
  "smash",
  "bash",
  "slash",
  "slit",
  "electrocut",
  "gas",
  "shank"
];
const HARM_VERB = `(?:${HARM_VERB_STEMS.map((s) => s.replace(/ /g, "\\s+")).join("|")})(?:e|es|s|ed|ing|ping|ted|ting|ning|ling|ering)?`;
const HARM_NOUN = "(?:violence|revenge|murder|assault|torture|abuse|a beating|bodily harm|physical harm|serious harm|injury|injuries)";
const WEAPON = "(?:knife|knives|blade|blades|dagger|gun|guns|firearm|rifle|pistol|revolver|shotgun|ammo|ammunition|bullets?|poison|toxin|weapons?|bombs?|explosives?|acid|rope|hammer|axe|hatchet|machete|sword|bat|crowbar|chloroform|drugs?|pills|sedatives?|taser|pepper spray|brass knuckles|chain|chains|wire|syringe|needle|blowtorch)";
const UNNAMED_ITEM = "(?:something|anything|an item|some item|a thing|things|stuff|a tool|tools|an object|a product|products|a device|supplies|what i need|whatever i need)";
const OBJECT = `(?:${WEAPON}|${UNNAMED_ITEM})`;
const PURPOSE = "(?:to|for|so (?:that )?(?:i|we) (?:can|could|may)|in order to|that (?:i|we) can use to|(?:i|we) can use to|(?:i|we) could use to|which (?:i|we) can use to|to use (?:on|against)|for use (?:on|against)|capable of|good for|that (?:can|will|would))";
const PERSON = "(?:friend|friends|wife|husband|partner|girlfriend|boyfriend|ex|neighbou?rs?|boss|teacher|coworkers?|colleagues?|classmates?|roommates?|landlord|someone|somebody|anyone|anybody|everyone|everybody|people|person|persons|him|her|them|kids?|child|children|baby|family|brother|sister|mother|father|mom|dad|parents?|son|daughter|uncle|aunt|cousin|guy|girl|man|woman|men|women|boy|boys|girls|dog|cat|pet|pets|animal|animals|bird|birds|stranger|strangers|crowd|customer|customers|myself|me|himself|herself|themselves|a human|humans|the police|officer|officers)";
const TARGET = `(?:my |his |her |their |our |the |a |that |this |some |these |those |an )?${PERSON}`;
const INTIMIDATION = "(?:teach (?:\\w+ ){0,3}a lesson|get back at|get even with|revenge on|payback|make (?:\\w+ ){0,3}pay|make (?:\\w+ ){0,3}suffer|scare|threaten|intimidate|silence|get rid of|take care of|deal with|settle (?:the )?score|punish|finish off|sort out)";
const RE = {
  harmVerbTarget: new RegExp(`\\b${HARM_VERB}\\b[^,]{0,40}?\\b${TARGET}\\b`, "i"),
  harmNounTarget: new RegExp(`\\b${HARM_NOUN}\\b[^,]{0,30}?\\b(?:on|to|against|toward|towards|for|at)\\b\\s+${TARGET}\\b`, "i"),
  /** "buy something to hurt", "a weapon for attacking", "a knife so I can stab" */
  objectPurposeHarm: new RegExp(`\\b${OBJECT}\\b[^,]{0,60}?\\b${PURPOSE}\\b[^,]{0,25}?\\b(?:${HARM_VERB}|${HARM_NOUN})\\b`, "i"),
  /** "put a weapon in the cart so I can attack", verb before the object */
  harmPurposeObject: new RegExp(`\\b(?:${HARM_VERB}|${HARM_NOUN})\\b[^,]{0,30}?\\b(?:with|using)\\b\\s+(?:a |an |the |some |my )?${WEAPON}\\b`, "i"),
  /** Object, intimidation wording and a person in one sentence, in any order. */
  objectPresent: new RegExp(`\\b${OBJECT}\\b`, "i"),
  intimidationPresent: new RegExp(`\\b${INTIMIDATION}\\b`, "i"),
  personPresent: new RegExp(`\\b${TARGET}\\b`, "i"),
  /** Throwing or spraying a harmful substance at a person. */
  substanceAtPerson: new RegExp(`\\b(?:throw|throwing|splash|splashing|spray|spraying|pour|pouring)\\b[^,]{0,25}?\\b(?:on|at|over|in the face of|into the eyes of)\\b\\s+${TARGET}\\b`, "i"),
  selfHarm: /\b(?:kill(?:ing)? myself|end(?:ing)? my (?:own )?life|commit(?:ting)? suicide|suicide|hang(?:ing)? myself|cut(?:ting)? myself|overdose|overdosing|hurt(?:ing)? myself|harm(?:ing)? myself|take my (?:own )?life|self[- ]harm|end it all)\b/i,
  illegalAgainstPerson: new RegExp(`\\b(?:stalk(?:ing)?|track(?:ing)?(?:\\s+down)?|spy(?:ing)?\\s+on|hack(?:ing)?(?:\\s+into)?|drug(?:ging)?|dox(?:x)?(?:ing)?|swat(?:ting)?|blackmail(?:ing)?|kidnap(?:ping)?|groom(?:ing)?)\\s+${TARGET}\\b`, "i"),
  dangerousDevice: /\b(?:make|build|assemble|buy|get|acquire|order|purchase|find)\b[^,]{0,30}\b(?:a |an |the )?(?:pipe bomb|bomb|explosive|explosives|nerve agent|bioweapon|ghost gun|molotov|ied|detonator|silencer for)\b/i,
  /** The harm word directly preceded by a negation: "cannot hurt", "won't harm", "don't want to hurt" */
  negatedHarm: new RegExp(`\\b(?:not|never|cannot|can't|won't|wouldn't|don't|doesn't|didn't|no|without|avoid|prevent|stop|protect(?:ed|s|ing)? (?:\\w+ )?from)\\b(?:\\s+\\w+){0,3}?\\s+(?:${HARM_VERB}|${HARM_NOUN})\\b`, "i"),
  /** Everyday objects of otherwise violent verbs. */
  benignObject: /\b(?:kill|attack|beat|shoot|burn|cut|execute|bomb|smash|bash|slash|crush|choke|gas|hammer|drown|strangle)\w*\b[^,]{0,20}?\b(?:process|processes|task|tasks|job|jobs|time|bug|bugs|weeds|germs|bacteria|mold|mould|calories|photo|photos|video|videos|picture|pictures|ball|problem|problems|record|records|score|level|boss level|fat|match|game|games|deadline|it off|off|switch|command|server|app|the lights|the engine|onions|vegetables|the cake|wood|paper|cardboard|bread|cheese|grass|the lawn|the competition|the deal|a workout|the gym|an audition|the exam|the interview)\b/i
};
function assessTask(task) {
  for (const raw of task.split(/[.!?;\n]+/)) {
    const text = normalise(raw);
    if (!text) continue;
    if (RE.selfHarm.test(text)) return blocked("self-harm");
    if (RE.dangerousDevice.test(text)) return blocked("dangerous-device");
    const negated = RE.negatedHarm.test(text);
    const benign = RE.benignObject.test(text);
    if (!negated && RE.harmVerbTarget.test(text) && !(benign && !hasPersonAfterHarm(text))) return blocked("harm-to-person");
    if (!negated && RE.harmNounTarget.test(text)) return blocked("harm-to-person");
    if (!negated && (RE.objectPurposeHarm.test(text) || RE.harmPurposeObject.test(text)) && !benign) return blocked("means-for-harm");
    if (RE.illegalAgainstPerson.test(text)) return blocked("targeting-person");
    if (!negated && RE.objectPresent.test(text) && RE.substanceAtPerson.test(text)) return blocked("means-for-harm");
    if (!negated && RE.objectPresent.test(text) && RE.intimidationPresent.test(text) && RE.personPresent.test(text) && !benign) return blocked("ambiguous-harm");
  }
  return { safe: true };
}
function hasPersonAfterHarm(text) {
  const match = new RegExp(`\\b${HARM_VERB}\\b[^,]{0,40}?\\b${TARGET}\\b`, "i").exec(text);
  return match !== null;
}
function normalise(text) {
  return text.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}
const REASONS = {
  "harm-to-person": "harming a person or animal",
  "means-for-harm": "obtaining something in order to harm someone",
  "self-harm": "self-harm",
  "dangerous-device": "a dangerous device",
  "targeting-person": "targeting a person (stalking, hacking, drugging or similar)",
  "ambiguous-harm": "a weapon-type item aimed at a person; the intent could be harmful, so PrivSight does not proceed"
};
function blocked(category) {
  return { safe: false, category, reason: `Task blocked locally: it describes ${REASONS[category]}. No request was sent and no action was taken.` };
}
const MAX_ROUNDS = 3;
const DEFAULT_MAX_STEPS = 30;
const MAX_STEPS = DEFAULT_MAX_STEPS;
const DEFAULT_MAX_RECOVERIES = 3;
const DEFAULT_MAX_FAILED_ACTIONS = 2;
const MAX_GUIDANCE_LENGTH = 400;
const RETRYABLE_VALIDATION = /* @__PURE__ */ new Set(["unknown_target", "incompatible_target", "ambiguous_target", "target_not_clickable", "target_occluded"]);
async function runAgent(task, ports, options = {}) {
  const startedAt = ports.now();
  const state = {
    task,
    goal: goalOf(task),
    maxSteps: Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS),
    maxRecoveries: Math.max(0, options.maxRecoveries ?? DEFAULT_MAX_RECOVERIES),
    maxFailedActions: Math.max(0, options.maxFailedActions ?? DEFAULT_MAX_FAILED_ACTIONS),
    step: 0,
    cloudContacted: false,
    browserActed: false,
    confirmingFinal: false,
    lightObservation: false,
    observations: [],
    rejectedDones: 0,
    recoveries: 0,
    failedActions: 0,
    policyRecoveries: 0,
    staleRetries: 0,
    repeatWarnings: 0,
    guidance: null,
    completion: null
  };
  const verdict = assessTask(task);
  if (!verdict.safe) {
    ports.report({ kind: "stage", stage: "dom", state: "skipped", detail: "task blocked by the local safety guard" });
    skip(ports, ["vision", "detect", "visual-redaction", "leakage", "firewall", "reason", "validate", "execute"]);
    ports.report({ kind: "status", text: verdict.reason, level: "error" });
    return outcome("blocked", "SAFETY_BLOCK", 0, 0, verdict.reason, state);
  }
  await ports.ensureContentScript();
  const info = await ports.visionInfo().catch(() => null);
  const history = [];
  let totalRounds = 0;
  let previousSignature = null;
  const recentSignatures = [];
  let noEffectStreak = 0;
  for (let step = 1; step <= state.maxSteps; step++) {
    state.step = step;
    if (ports.isCancelled?.()) {
      return outcome("blocked", "CANCELLED", totalRounds, history.length, "Task cancelled: a new task was started", state);
    }
    if (step > 1) {
      ports.report({ kind: "phase", phase: "re-observing" });
      ports.report({ kind: "status", text: `Step ${step} (budget ${state.maxSteps}): observing the page again${state.lightObservation ? " (DOM only)" : ""}...`, level: "info" });
      resetStages(ports);
    }
    const stepResult = await runStep(ports, info, history, step, startedAt, state);
    totalRounds += stepResult.rounds;
    if (stepResult.kind === "verified") {
      reportFinal(ports, state, "SUCCESS", stepResult.message);
      return outcome("completed", "COMPLETED", totalRounds, history.length, stepResult.message, state);
    }
    if (stepResult.kind === "recover") {
      if (stepResult.policy) {
        reportState(ports, state, stepResult.action, "blocked", verifyCompletion(task, history, state.observations), "observe and use an allowed path");
      } else {
        state.failedActions++;
        state.guidance = clip(`The last action failed: ${stepResult.message}. It was not performed. Choose a different way to reach the goal (${goalEndState(state.goal)}); attempt ${state.failedActions} of ${state.maxFailedActions}.`);
        reportState(ports, state, stepResult.action, "failed", verifyCompletion(task, history, state.observations), "observe and choose another way");
      }
      state.lightObservation = false;
      if (ports.settle) await ports.settle().catch(() => void 0);
      await ports.ensureContentScript();
      continue;
    }
    if (stepResult.kind !== "executed") {
      reportFinal(ports, state, stepResult.status === "failed" ? "FAILED" : "BLOCKED", stepResult.message);
      return outcome(stepResult.status, stepResult.code, totalRounds, history.length, stepResult.message, state);
    }
    const { record } = stepResult;
    state.guidance = null;
    ports.report({ kind: "step", step, maxSteps: state.maxSteps, action: describeRecord(record) });
    if (record.action === "done") {
      const stopCode = record.value && DONE_REASON_CODES.has(record.value) ? record.value : null;
      const claim = stopCode ? "blocked" : "complete";
      const completion2 = verifyCompletion(task, history, state.observations);
      state.completion = completion2;
      const lastFacts = [...state.observations].reverse().find((o) => o !== null) ?? null;
      const blocker = assessBlockerClaim(claim === "blocked" ? stepResult.reason : "", lastFacts);
      ports.report({
        kind: "status",
        text: `Completion check (${completion2.goal} task): claim=${claim}; ${completion2.state.replace("_", " ")}${completion2.evidence.length ? `; evidence: ${completion2.evidence.join("; ")}` : ""}${completion2.missing ? `; missing: ${completion2.missing}` : ""}${claim === "blocked" ? `; blocker ${blocker.supported ? "is shown on the current page" : "is NOT shown on the current page"}` : ""}`,
        level: completion2.state === "verified" ? "success" : "info"
      });
      if (completion2.state === "verified") {
        history.push(record);
        const message3 = `${stepResult.message}; verified: ${completion2.evidence.join("; ")}`;
        reportFinal(ports, state, "SUCCESS", message3);
        return outcome("completed", "COMPLETED", totalRounds, history.length, message3, state);
      }
      const contradicted = completion2.state === "not_complete" || claim === "blocked";
      const dataStop = stopCode === "MISSING_REQUIRED_DATA" || stopCode === "AMBIGUOUS_TARGET";
      const budget = dataStop ? Math.min(1, state.maxRecoveries) : state.maxRecoveries;
      if (contradicted && state.recoveries < budget) {
        state.recoveries++;
        state.rejectedDones++;
        state.lightObservation = true;
        const attempt = `${state.recoveries} of ${state.maxRecoveries}`;
        const why = claim === "blocked" ? blocker.supported ? `you reported a blocker (${blocker.phrase}) and the current page shows it for the current item, but the task is not complete` : "you reported a blocker that the current page does not show" : `the task is not complete: ${completion2.missing}`;
        state.guidance = clip(`TASK NOT COMPLETE (local check, recovery attempt ${attempt}): ${why}. Do not stop. Recover: go back to the results or search again, choose a different listing or path that satisfies the task, and continue until ${goalEndState(state.goal)}. Report done with a stop code only after recovery fails.`);
        history.push({ action: "done", target: null, value: null, effect: "no_change", note: `done was rejected locally (attempt ${attempt}): ${why}`, synthetic: true });
        ports.report({ kind: "status", text: `The reasoner reported ${claim === "blocked" ? "a blocker" : "done"}, but the goal is not reached: ${why}. Asking it to recover (attempt ${attempt}).`, level: "info" });
        reportState(ports, state, "done (claim)", "success", completion2, "recover: re-observe and replan");
        continue;
      }
      history.push(record);
      const acted = history.some((h) => h.action !== "done");
      if (claim === "blocked" && blocker.supported) {
        const message3 = `Blocked: ${stepResult.reason || blocker.phrase} (shown on the current page; ${state.recoveries} recovery attempt(s) made)`;
        reportFinal(ports, state, "BLOCKED", message3);
        return outcome("blocked", "TASK_BLOCKED", totalRounds, history.length, message3, state);
      }
      if (dataStop && stopCode) {
        const message3 = `Stopped: ${stepResult.reason || completion2.missing} (re-checked once; the page offers no way to verify or resolve it)`;
        reportFinal(ports, state, "BLOCKED", message3);
        return outcome("blocked", stopCode, totalRounds, history.length, message3, state);
      }
      if (claim === "blocked" || !acted && completion2.state === "not_complete") {
        const message3 = `Stopped without reaching the goal: ${completion2.missing || stepResult.reason} (${state.recoveries} recovery attempt(s) made; the claimed blocker is not shown on the page)`;
        reportFinal(ports, state, "BLOCKED", message3);
        return outcome("blocked", "INSUFFICIENT_EVIDENCE", totalRounds, history.length, message3, state);
      }
      const message2 = `Action completed, but the final result could not be verified: ${completion2.missing}`;
      reportFinal(ports, state, "UNVERIFIED", message2);
      return outcome("unverified", "COMPLETION_UNVERIFIED", totalRounds, history.length, message2, state);
    }
    history.push(record);
    state.browserActed = true;
    const completion = verifyCompletion(task, history, state.observations);
    state.completion = completion;
    reportState(ports, state, describeRecord(record), "success", completion, completion.state === "verified" ? "observe; the reasoner should confirm done" : "observe and continue toward the goal");
    const signature = JSON.stringify({ action: record.action, target: record.target, value: record.value });
    recentSignatures.push(signature);
    if (recentSignatures.length > 8) recentSignatures.shift();
    const repeats = recentSignatures.filter((sig) => sig === signature).length;
    if (signature === previousSignature || repeats >= 3) {
      if (completion.state === "verified") {
        const message3 = `Goal verified on the page while the reasoner kept repeating actions: ${completion.evidence.join("; ")}`;
        reportFinal(ports, state, "SUCCESS", message3);
        return outcome("completed", "COMPLETED", totalRounds, history.length, message3, state);
      }
      const message2 = signature === previousSignature ? `Stopped: the reasoner repeated the same action (${describeRecord(record)}) without progress` : `Stopped: the reasoner is cycling between the same actions (${describeRecord(record)} recurred ${repeats} times) without reaching the goal`;
      reportFinal(ports, state, "BLOCKED", message2);
      return outcome("blocked", "NO_PROGRESS", totalRounds, history.length, message2, state);
    }
    previousSignature = signature;
    noEffectStreak = record.effect === "no_change" ? noEffectStreak + 1 : 0;
    if (noEffectStreak >= 3) {
      const message2 = "Stopped: three actions in a row had no effect on the page";
      reportFinal(ports, state, "BLOCKED", message2);
      return outcome("blocked", "NO_PROGRESS", totalRounds, history.length, message2, state);
    }
    state.confirmingFinal = stepResult.final && record.action !== "type";
    if (state.confirmingFinal) ports.report({ kind: "status", text: "The reasoner expects the task to be complete; verifying on the resulting page.", level: "info" });
    state.lightObservation = record.effect === "no_change" || record.action === "type" || record.action === "scroll";
    if (ports.settle) await ports.settle().catch(() => void 0);
    await ports.ensureContentScript();
  }
  const message = `Stopped after ${state.maxSteps} steps (the execution budget) without the goal being verified`;
  reportFinal(ports, state, "BLOCKED", message);
  return outcome("blocked", "STEP_LIMIT", totalRounds, history.length, message, state);
}
async function runStep(ports, info, history, step, startedAt, state) {
  const task = state.task;
  let lastRetryCode;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const metrics = { round, step, engine: info?.engine, webgpu: info?.webgpu };
    if (round > 1) {
      ports.report({ kind: "phase", phase: "re-observing" });
      ports.report({ kind: "status", text: `Re-observing the page (round ${round} of ${MAX_ROUNDS})...`, level: "info" });
    }
    const urlBefore = ports.pageUrl ? await ports.pageUrl().catch(() => "") : "";
    const offPage = ports.pageUrl && ports.observeOffPage && ports.executeOffPage ? !/^https?:\/\//i.test(urlBefore) : false;
    const light = state.lightObservation && round === 1;
    const captureStart = ports.now();
    let captureError = null;
    const capture = offPage || light ? null : await ports.capture().catch((error) => {
      captureError = describe(error);
      return null;
    });
    metrics.captureMs = round1(ports.now() - captureStart);
    let ocr = null;
    if (capture) {
      const perceiveStart = ports.now();
      try {
        ocr = await ports.perceive(capture);
      } catch (error) {
        ocr = null;
        ports.report({ kind: "stage", stage: "vision", state: "fallback", detail: `local OCR failed: ${describe(error)}; continuing with DOM only` });
      }
      if (ocr) {
        metrics.ocrLoadMs = round1(ocr.timings.loadMs);
        metrics.ocrRecognizeMs = round1(ocr.timings.recognizeMs);
        metrics.perceptionMs = round1(ports.now() - perceiveStart);
        metrics.usedJsHeapMb = ocr.usedJsHeapMb;
        metrics.ocrLines = ocr.lines.length;
        ports.report({ kind: "stage", stage: "vision", state: "pass", detail: `${ocr.engine}: ${ocr.lines.length} lines in ${metrics.ocrRecognizeMs} ms` });
      }
    } else if (offPage) {
      ports.report({ kind: "stage", stage: "vision", state: "skipped", detail: "no web page is open in this tab; nothing to capture" });
      ports.report({ kind: "status", text: "No web page is open in this tab. Asking the reasoner which site to open...", level: "info" });
    } else if (light) {
      ports.report({ kind: "stage", stage: "vision", state: "skipped", detail: "targeted re-observation: the last action changed a field or nothing on the page; DOM only" });
    } else {
      ports.report({
        kind: "stage",
        stage: "vision",
        state: "fallback",
        detail: `screen capture unavailable${captureError ? ` (${captureError})` : ""}; continuing with DOM only`
      });
    }
    const privacyStart = ports.now();
    const guidance = state.guidance ?? void 0;
    let extracted = offPage && ports.observeOffPage ? await ports.observeOffPage(task, history, guidance) : await extractWithRetry(ports, task, ocr, history, guidance);
    metrics.privacyMs = round1(ports.now() - privacyStart);
    if (!extracted.ok) {
      ports.report({ kind: "stage", stage: "dom", state: "fail", detail: extracted.error });
      return stopped(round, "failed", "PAGE_UNAVAILABLE", `Page extraction failed: ${extracted.error}`);
    }
    ports.report({ kind: "stage", stage: "dom", state: "pass", detail: describeDetections(extracted.summary.detections.length, extracted.summary.placeholders.length) });
    ports.report({ kind: "stage", stage: "detect", state: "pass", detail: describePlaceholders(extracted.summary.placeholders, extracted.summary.types) });
    ports.report({ kind: "status", text: describePrivacy(extracted.summary.placeholders, extracted.summary.types), level: "success" });
    const visualPrivacy = extracted.visualPrivacy;
    const images = capture ? scaleRegions(extracted.imageRegions ?? [], capture.devicePixelRatio) : [];
    if (visualPrivacy) {
      metrics.observationsSent = visualPrivacy.observationsSent;
      metrics.maskRegions = visualPrivacy.maskRegions.length;
      const detail = `${visualPrivacy.maskRegions.length} region(s) masked; ${visualPrivacy.observationsSent} observation(s) kept; ${visualPrivacy.fusion.duplicatesDropped} duplicate(s) dropped; ${visualPrivacy.fusion.buttonsMapped} button(s) mapped` + (visualPrivacy.conflicts.length ? `; ${visualPrivacy.conflicts.length} conflict(s), DOM preferred` : "");
      ports.report({ kind: "stage", stage: "visual-redaction", state: "pass", detail });
      if (capture) {
        const masked = await ports.renderMask(capture, visualPrivacy.maskRegions.map((r) => r.bbox), images).catch(() => null);
        ports.report({ kind: "preview", rawDataUrl: capture.dataUrl, maskedDataUrl: masked, maskCount: visualPrivacy.maskRegions.length, imageCount: images.length });
      }
    } else {
      ports.report({ kind: "stage", stage: "visual-redaction", state: "skipped", detail: "no visual observations this round" });
      if (capture) {
        const masked = await ports.renderMask(capture, [], images).catch(() => null);
        ports.report({ kind: "preview", rawDataUrl: capture.dataUrl, maskedDataUrl: masked, maskCount: 0, imageCount: images.length });
      }
    }
    const { firewall } = extracted;
    const checks = firewall.checks.map((c) => `${c.name}:${c.passed ? "pass" : "fail"}`).join(" ");
    if (firewall.verdict === "blocked") {
      ports.report({ kind: "stage", stage: "leakage", state: "fail", detail: checks });
      ports.report({ kind: "stage", stage: "firewall", state: "fail", detail: "REQUEST BLOCKED" });
      skip(ports, ["reason", "validate", "execute"]);
      return stopped(round, "blocked", "PRIVACY_BLOCK", firewall.reason);
    }
    ports.report({ kind: "stage", stage: "leakage", state: "pass", detail: checks });
    ports.report({ kind: "stage", stage: "firewall", state: "pass", detail: "REQUEST ALLOWED" });
    ports.report({ kind: "payload", body: firewall.body });
    const pageFacts = describePage(firewall.body);
    if (pageFacts) ports.report({ kind: "page", ...pageFacts });
    state.observations.push(pageFactsFromBody(firewall.body));
    if (reconcileLastEffect(history, state) && !offPage) {
      const again = await extractWithRetry(ports, task, ocr, history, guidance);
      if (again.ok && again.firewall.verdict === "allowed") {
        extracted = again;
        state.observations[state.observations.length - 1] = pageFactsFromBody(again.firewall.body);
      }
    }
    ports.report({ kind: "stage", stage: "reason", state: "pending" });
    ports.report({ kind: "status", text: "Sending sanitized request to backend...", level: "info" });
    const reasonStart = ports.now();
    let raw;
    try {
      state.cloudContacted = true;
      raw = await ports.reason(firewall.body);
    } catch (error) {
      const message = describe(error);
      const code2 = classifyError(message);
      if (code2 === "INVALID_MODEL_RESPONSE" && round < MAX_ROUNDS) {
        ports.report({ kind: "stage", stage: "reason", state: "fail", detail: message });
        ports.report({ kind: "status", text: "The reasoner returned an unusable action. Observing again.", level: "error" });
        continue;
      }
      ports.report({ kind: "stage", stage: "reason", state: "fail", detail: message });
      skip(ports, ["validate", "execute"]);
      return stopped(round, "failed", code2, message);
    }
    metrics.reasonMs = round1(ports.now() - reasonStart);
    ports.report({ kind: "stage", stage: "reason", state: "pass", detail: "structured action received" });
    ports.report({ kind: "status", text: `Action received: ${describeRaw(raw)}`, level: "info" });
    const proposed = signatureOf(raw);
    const previous = history[history.length - 1];
    if (previous && !previous.synthetic && previous.action !== "done" && proposed === signatureOf(previous) && state.repeatWarnings < 1 && round < MAX_ROUNDS) {
      state.repeatWarnings++;
      state.guidance = clip(`You proposed the same action you just performed (${describeRecord(previous)}); its effect was "${previous.effect ?? "unknown"}". It was not repeated. Do the NEXT step toward ${goalEndState(state.goal)} (for a typed search: submit it; for an opened item: use its controls).`);
      ports.report({ kind: "status", text: `The reasoner repeated its previous action; not repeating it. Asking for the next step.`, level: "info" });
      continue;
    }
    ports.report({ kind: "stage", stage: "validate", state: "pending" });
    const executeStart = ports.now();
    let result;
    try {
      result = offPage && ports.executeOffPage ? await ports.executeOffPage(raw) : await ports.execute(raw, history);
    } catch (error) {
      const message = describe(error);
      if (ports.settle) await ports.settle().catch(() => void 0);
      const urlAfter = ports.pageUrl ? await ports.pageUrl().catch(() => "") : "";
      if (isClickLike(raw) && urlBefore && urlAfter && urlAfter !== urlBefore) {
        result = { ok: true, message: "Action executed; the page navigated", validation: "pass", postAction: { effect: "url_changed", mutations: 0, urlChanged: true, titleChanged: false, controlsChanged: true, modalAppeared: false, modalClosed: false, waitedMs: 0 } };
      } else {
        ports.report({ kind: "stage", stage: "execute", state: "fail", detail: message });
        return stopped(round, "failed", classifyError(message), `The page could not be reached to perform the action: ${message}`);
      }
    }
    metrics.executeMs = round1(ports.now() - executeStart);
    metrics.totalMs = round1(ports.now() - startedAt);
    metrics.stepsTotal = history.length + (result.ok ? 1 : 0);
    ports.report({ kind: "metrics", metrics });
    if (result.trace) ports.report({ kind: "trace", trace: { ...result.trace, reobserve: result.ok && !isDone(raw) ? "YES" : "NO", final: result.ok ? isDone(raw) ? "DONE" : "CONTINUE" : result.validation === "blocked" ? "BLOCKED" : "FAILED" } });
    if (result.validation === "blocked") {
      ports.report({ kind: "stage", stage: "validate", state: "fail", detail: result.message });
      const retryable = result.code !== void 0 && RETRYABLE_VALIDATION.has(result.code);
      if (retryable && round < MAX_ROUNDS) {
        lastRetryCode = result.code;
        state.staleRetries++;
        state.guidance = clip(
          result.code === "target_occluded" ? `The last action was refused: ${result.message}. A dialog or overlay is in front of that control. Deal with the overlay first: use a control inside it, or close it (a close, cancel or × control), then continue toward ${goalEndState(state.goal)}.` : `The last action was refused: ${result.message}. The page changed since it was observed; pick the target again from the current elements.`
        );
        ports.report({ kind: "status", text: `Action stopped by the local validator: ${result.message}. The page may have changed; re-observing.`, level: "error" });
        continue;
      }
      skip(ports, ["execute"]);
      if (result.code === "consequential_action" && state.policyRecoveries < 1) {
        state.policyRecoveries++;
        state.guidance = clip(`The last action was refused by the local policy and NOT performed: ${result.message}. That control needs an authorisation the task does not give. Use only what the task allows (for a checkout task: the cart's proceed-to-checkout control; never a place-order or payment control), and continue toward ${goalEndState(state.goal)}. If no allowed path exists, report done with a stop code.`);
        return { kind: "recover", rounds: round, action: describeRaw(raw), message: result.message, policy: true };
      }
      if (result.code === "repeated_action") {
        const verdict = verifyCompletion(task, history, state.observations);
        ports.report({ kind: "status", text: `Completion check (${verdict.goal} task) after a refused repeat: ${verdict.state.replace("_", " ")}${verdict.evidence.length ? `; evidence: ${verdict.evidence.join("; ")}` : ""}`, level: verdict.state === "verified" ? "success" : "info" });
        if (verdict.state === "verified") return { kind: "verified", rounds: round, message: `Repeated add refused; the goal is already verified: ${verdict.evidence.join("; ")}` };
      }
      const code2 = outcomeForValidation(result.code === "action_failed" ? void 0 : result.code);
      return stopped(round, "blocked", code2, `Action blocked by local validator: ${result.message}`);
    }
    ports.report({ kind: "stage", stage: "validate", state: "pass", detail: "action verified against the live page" });
    if (!result.ok) {
      ports.report({ kind: "stage", stage: "execute", state: "fail", detail: result.message });
      if (state.failedActions < state.maxFailedActions) {
        ports.report({ kind: "status", text: `Action failed: ${result.message}. Recovering (attempt ${state.failedActions + 1} of ${state.maxFailedActions}).`, level: "error" });
        return { kind: "recover", rounds: round, action: describeRaw(raw), message: result.message };
      }
      return stopped(round, "failed", "ACTION_FAILED", `Action failed: ${result.message}`);
    }
    if (result.navigateTo) {
      if (!ports.navigate) {
        ports.report({ kind: "stage", stage: "execute", state: "fail", detail: "navigation is not available in this host" });
        return stopped(round, "failed", "UNSUPPORTED_ACTION", "Navigation is not available in this host");
      }
      ports.report({ kind: "status", text: `Opening ${hostOf(result.navigateTo)}...`, level: "info" });
      try {
        await ports.navigate(result.navigateTo);
      } catch (error) {
        ports.report({ kind: "stage", stage: "execute", state: "fail", detail: describe(error) });
        return stopped(round, "failed", "PAGE_UNAVAILABLE", `Navigation failed: ${describe(error)}`);
      }
    }
    const effect = result.navigateTo ? "url_changed" : result.postAction?.effect ?? (isDone(raw) ? "no_change" : "unknown");
    ports.report({ kind: "stage", stage: "execute", state: "pass", detail: `${result.message}${result.postAction ? ` (${describeEffect(result.postAction.effect)})` : ""}` });
    ports.report({ kind: "status", text: `Action executed: ${result.message}${result.postAction ? `; page: ${describeEffect(result.postAction.effect)}` : ""}`, level: "success" });
    return { kind: "executed", rounds: round, record: toRecord(raw, effect, result.note, result.trace?.target, result.cartEvidence?.added, result.trace?.context), message: result.message, final: isFinal(raw), reason: reasonOf(raw) };
  }
  const code = lastRetryCode === "ambiguous_target" ? "AMBIGUOUS_TARGET" : lastRetryCode === "target_occluded" ? "TARGET_OCCLUDED" : lastRetryCode ? "STALE_TARGET" : "INVALID_MODEL_RESPONSE";
  return stopped(MAX_ROUNDS, "blocked", code, `Stopped after ${MAX_ROUNDS} observation rounds without a valid action`);
  function stopped(rounds, status, code2, message) {
    return { kind: "stopped", rounds, status, code: code2, message };
  }
}
async function extractWithRetry(ports, task, ocr, history, guidance) {
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await ports.extract(task, ocr, history, guidance);
    } catch (error) {
      lastError = describe(error);
      if (attempt === 2) break;
      ports.report({ kind: "status", text: `Page changed during observation (${lastError}); waiting for it to settle and observing again.`, level: "info" });
      if (ports.settle) await ports.settle().catch(() => void 0);
      await ports.ensureContentScript().catch(() => void 0);
    }
  }
  return { ok: false, error: lastError };
}
function reconcileLastEffect(history, state) {
  const last = history[history.length - 1];
  const observations = state.observations;
  if (!last || last.synthetic || last.action === "done" || observations.length < 2) return false;
  if (last.effect !== "no_change" && last.effect !== "unknown") return false;
  const before = observations[observations.length - 2];
  const after = observations[observations.length - 1];
  if (!before || !after) return false;
  let corrected = null;
  if (after.url !== before.url) corrected = "url_changed";
  else if (after.title !== before.title || after.labels.join("|") !== before.labels.join("|")) corrected = "dom_changed";
  if (!corrected) return false;
  last.effect = corrected;
  const note = "the page had changed by the next observation (late render)";
  last.note = last.note ? `${last.note}; ${note}` : note;
  return true;
}
function reportState(ports, state, action, actionResult, completion, next) {
  const last = [...state.observations].reverse().find((o) => o !== null) ?? null;
  ports.report({
    kind: "state",
    state: {
      step: state.step,
      maxSteps: state.maxSteps,
      goal: state.goal,
      page: hostOf(last?.url ?? ""),
      action,
      actionResult,
      taskResult: completion.state === "verified" ? "verified complete" : completion.state === "unverified" ? "unverified" : "not complete",
      taskDetail: completion.state === "verified" ? completion.evidence.join("; ") : completion.missing,
      next,
      recoveries: state.recoveries,
      failedActions: state.failedActions
    }
  });
}
function reportFinal(ports, state, result, reason) {
  ports.report({ kind: "status", text: `TASK RESULT: ${result} · step ${state.step} of budget ${state.maxSteps} · recoveries ${state.recoveries} · stale-target retries ${state.staleRetries} · REASON: ${reason}`, level: result === "SUCCESS" ? "success" : result === "UNVERIFIED" ? "info" : "error" });
}
function clip(text) {
  return text.length > MAX_GUIDANCE_LENGTH ? `${text.slice(0, MAX_GUIDANCE_LENGTH - 1)}…` : text;
}
function outcome(status, code, rounds, steps, message, state) {
  return { status, code, rounds, steps: steps - state.rejectedDones, message, cloudContacted: state.cloudContacted, browserActed: state.browserActed };
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}
function skip(ports, stages) {
  for (const stage of stages) ports.report({ kind: "stage", stage, state: "skipped" });
}
function resetStages(ports) {
  for (const stage of ["dom", "vision", "detect", "visual-redaction", "leakage", "firewall", "reason", "validate", "execute"]) {
    ports.report({ kind: "stage", stage, state: "pending" });
  }
}
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
function describeEffect(effect) {
  switch (effect) {
    case "url_changed":
      return "URL changed";
    case "dom_changed":
      return "page content changed";
    case "no_change":
      return "no visible change";
    default:
      return "effect unknown";
  }
}
function describeDetections(fields, placeholders) {
  return `${fields} sensitive field(s), ${placeholders} value(s) redacted`;
}
function describePlaceholders(placeholders, types) {
  return placeholders.length === 0 ? "nothing sensitive found" : placeholders.map((p) => `${types[p]} -> ${p}`).join(", ");
}
function describePrivacy(placeholders, types) {
  return `Local PII detection: ${describePlaceholders(placeholders, types)}`;
}
function describePage(body) {
  try {
    const parsed = JSON.parse(body);
    const page = parsed.page ?? {};
    let host = "";
    try {
      host = new URL(page.url ?? "").host;
    } catch {
      host = "";
    }
    return {
      title: (page.title ?? "").slice(0, 120),
      host,
      elements: Array.isArray(page.elements) ? page.elements.length : 0,
      placeholders: Array.isArray(parsed.placeholders) ? parsed.placeholders.length : 0,
      visualObservations: Array.isArray(parsed.visual?.observations) ? parsed.visual.observations.length : 0
    };
  } catch {
    return null;
  }
}
function toRecord(raw, effect, note, label, cartAdded, context) {
  const record = typeof raw === "object" && raw !== null ? raw : {};
  const action = typeof record.action === "string" ? record.action : "done";
  return {
    action,
    target: typeof record.target === "string" ? record.target : null,
    value: typeof record.value === "string" ? record.value : null,
    effect,
    ...note ? { note } : {},
    ...label ? { label } : {},
    ...cartAdded ? { cartAdded } : {},
    ...context ? { context } : {}
  };
}
function isFinal(raw) {
  return typeof raw === "object" && raw !== null && raw.final === true;
}
function isDone(raw) {
  return typeof raw === "object" && raw !== null && raw.action === "done";
}
function isClickLike(raw) {
  const action = typeof raw === "object" && raw !== null ? raw.action : void 0;
  return action === "click" || action === "press";
}
function reasonOf(raw) {
  const reason = typeof raw === "object" && raw !== null ? raw.reason : void 0;
  return typeof reason === "string" ? reason.slice(0, 300) : "";
}
function signatureOf(raw) {
  const r = typeof raw === "object" && raw !== null ? raw : {};
  return JSON.stringify({ action: r.action ?? null, target: typeof r.target === "string" ? r.target : null, value: typeof r.value === "string" ? r.value : null });
}
function describeRecord(record) {
  return `${record.action}${record.target ? ` ${record.target}` : ""}${record.value !== null ? ` "${record.value.slice(0, 40)}"` : ""}`;
}
function describeRaw(raw) {
  if (typeof raw !== "object" || raw === null) return "unrecognized response";
  const record = raw;
  const action = typeof record.action === "string" ? record.action : "?";
  const target = typeof record.target === "string" ? ` ${record.target}` : "";
  const confidence = typeof record.confidence === "number" ? ` (confidence ${Math.round(record.confidence * 100)}%)` : "";
  const reason = typeof record.reason === "string" ? ` - ${record.reason}` : "";
  return `${action}${target}${confidence}${reason}`;
}
function round1(value) {
  return Math.round(value * 10) / 10;
}
export {
  DEFAULT_MAX_FAILED_ACTIONS,
  DEFAULT_MAX_RECOVERIES,
  DEFAULT_MAX_STEPS,
  MAX_GUIDANCE_LENGTH,
  MAX_ROUNDS,
  MAX_STEPS,
  runAgent
};
