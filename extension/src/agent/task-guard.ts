/**
 * Local task safety guard.
 *
 * Runs on the user's task text before anything else: before the page is
 * read, before any cloud request, before any browser action. A clearly
 * harmful intent is blocked locally with zero cloud requests and zero
 * actions; a blocked task is never sent to the reasoner.
 *
 * This is a deterministic local policy, not a model. It reasons over the
 * COMBINATION of four things found in one sentence:
 *
 *   object     what is asked for: a weapon or harmful means, or an unnamed
 *              item ("something", "anything", "a tool", "an item")
 *   use        the intended use: a harm verb in any inflection (kill,
 *              killing, hurt, injuring, attacked...) or a harm noun
 *              (violence, revenge, murder...)
 *   target     who would be harmed: a person, an animal, or the user
 *   objective  an explicit purpose link ("to", "for", "so I can", "in order
 *              to", "that can") between the object and the harmful use
 *
 * Decision:
 *   BLOCK   harm verb/noun + target in one sentence ("hurt my friend")
 *   BLOCK   object + purpose link + harm verb, even with no named target
 *           ("buy something to injure", "a weapon for attacking")
 *   BLOCK   self-harm, dangerous devices, illegal acts against a person
 *   BLOCK   ambiguous but plausibly harmful: a weapon-type object aimed at
 *           a person with intimidation or retaliation wording ("a knife to
 *           teach my neighbour a lesson"). Fails closed rather than asking
 *           the cloud.
 *   ALLOW   a sensitive noun alone ("kitchen knife", "knife sharpener") or
 *           with an everyday object ("kill the process", "cut the cake")
 *   ALLOW   negated harm when the negation sits right before the harm word
 *           ("make sure it cannot hurt anyone")
 *
 * Input is normalised (case, punctuation, hyphens) so spelling with
 * separators or capitals does not change the verdict. The verdict names
 * only the category, never the task text.
 */

export type GuardVerdict = { safe: true } | { safe: false; reason: string; category: GuardCategory };

export type GuardCategory = "harm-to-person" | "means-for-harm" | "self-harm" | "dangerous-device" | "targeting-person" | "ambiguous-harm";

// --- vocabulary --------------------------------------------------------------

/** Harm verbs with their inflections folded in (kill, kills, killed, killing). */
const HARM_VERB_STEMS = [
  "kill", "murder", "hurt", "harm", "injur", "stab", "shoot", "poison", "strangl", "chok", "assault", "attack", "beat up", "beat",
  "tortur", "rape", "kidnap", "abduct", "maim", "drown", "suffocat", "slaughter", "butcher", "behead", "execut", "blow up", "bomb",
  "burn", "set fire to", "run over", "cut up", "wound", "cripple", "smash", "bash", "slash", "slit", "electrocut", "gas", "shank",
];
const HARM_VERB = `(?:${HARM_VERB_STEMS.map((s) => s.replace(/ /g, "\\s+")).join("|")})(?:e|es|s|ed|ing|ping|ted|ting|ning|ling|ering)?`;
/** Harm as a noun or purpose word. */
const HARM_NOUN = "(?:violence|revenge|murder|assault|torture|abuse|a beating|bodily harm|physical harm|serious harm|injury|injuries)";
/** Objects: weapons and harmful means, plus unnamed items used with a harmful purpose. */
const WEAPON = "(?:knife|knives|blade|blades|dagger|gun|guns|firearm|rifle|pistol|revolver|shotgun|ammo|ammunition|bullets?|poison|toxin|weapons?|bombs?|explosives?|acid|rope|hammer|axe|hatchet|machete|sword|bat|crowbar|chloroform|drugs?|pills|sedatives?|taser|pepper spray|brass knuckles|chain|chains|wire|syringe|needle|blowtorch)";
const UNNAMED_ITEM = "(?:something|anything|an item|some item|a thing|things|stuff|a tool|tools|an object|a product|products|a device|supplies|what i need|whatever i need)";
const OBJECT = `(?:${WEAPON}|${UNNAMED_ITEM})`;
/** Purpose link between an object and its use. */
const PURPOSE = "(?:to|for|so (?:that )?(?:i|we) (?:can|could|may)|in order to|that (?:i|we) can use to|(?:i|we) can use to|(?:i|we) could use to|which (?:i|we) can use to|to use (?:on|against)|for use (?:on|against)|capable of|good for|that (?:can|will|would))";
/** Who could be harmed. */
const PERSON = "(?:friend|friends|wife|husband|partner|girlfriend|boyfriend|ex|neighbou?rs?|boss|teacher|coworkers?|colleagues?|classmates?|roommates?|landlord|someone|somebody|anyone|anybody|everyone|everybody|people|person|persons|him|her|them|kids?|child|children|baby|family|brother|sister|mother|father|mom|dad|parents?|son|daughter|uncle|aunt|cousin|guy|girl|man|woman|men|women|boy|boys|girls|dog|cat|pet|pets|animal|animals|bird|birds|stranger|strangers|crowd|customer|customers|myself|me|himself|herself|themselves|a human|humans|the police|officer|officers)";
const TARGET = `(?:my |his |her |their |our |the |a |that |this |some |these |those |an )?${PERSON}`;
/** Retaliation or intimidation wording: ambiguous on its own, harmful when paired with a weapon and a person. */
const INTIMIDATION = "(?:teach (?:\\w+ ){0,3}a lesson|get back at|get even with|revenge on|payback|make (?:\\w+ ){0,3}pay|make (?:\\w+ ){0,3}suffer|scare|threaten|intimidate|silence|get rid of|take care of|deal with|settle (?:the )?score|punish|finish off|sort out)";

// --- rules -------------------------------------------------------------------

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
  benignObject: /\b(?:kill|attack|beat|shoot|burn|cut|execute|bomb|smash|bash|slash|crush|choke|gas|hammer|drown|strangle)\w*\b[^,]{0,20}?\b(?:process|processes|task|tasks|job|jobs|time|bug|bugs|weeds|germs|bacteria|mold|mould|calories|photo|photos|video|videos|picture|pictures|ball|problem|problems|record|records|score|level|boss level|fat|match|game|games|deadline|it off|off|switch|command|server|app|the lights|the engine|onions|vegetables|the cake|wood|paper|cardboard|bread|cheese|grass|the lawn|the competition|the deal|a workout|the gym|an audition|the exam|the interview)\b/i,
};

// --- entry point ---------------------------------------------------------------

export function assessTask(task: string): GuardVerdict {
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

/** A harm verb followed by a person target, ignoring an everyday object that appears before it. */
function hasPersonAfterHarm(text: string): boolean {
  const match = new RegExp(`\\b${HARM_VERB}\\b[^,]{0,40}?\\b${TARGET}\\b`, "i").exec(text);
  return match !== null;
}

/** Lower-case, letters/digits/apostrophes only, single spaces: "K!ll-my-FRIEND" -> "k ll my friend". */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const REASONS: Record<GuardCategory, string> = {
  "harm-to-person": "harming a person or animal",
  "means-for-harm": "obtaining something in order to harm someone",
  "self-harm": "self-harm",
  "dangerous-device": "a dangerous device",
  "targeting-person": "targeting a person (stalking, hacking, drugging or similar)",
  "ambiguous-harm": "a weapon-type item aimed at a person; the intent could be harmful, so PrivSight does not proceed",
};

function blocked(category: GuardCategory): GuardVerdict {
  return { safe: false, category, reason: `Task blocked locally: it describes ${REASONS[category]}. No request was sent and no action was taken.` };
}
