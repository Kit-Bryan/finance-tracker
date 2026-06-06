// Tier-1 synonym search: hand-curated keywords per category so a query like
// "shoes" surfaces "Clothing" even though the names share no letters.
// Keyed by LOWERCASED category name. Categories not listed just fall back to
// matching their own name. Renaming a category drops its aliases (by design —
// the key is the name); add new keys here if you add/rename categories.
export const CATEGORY_ALIASES: Record<string, string[]> = {
  // Food & Drink
  "food & drink": ["meal", "lunch", "dinner", "breakfast", "makan", "snack", "eat", "hawker", "mamak", "kopitiam", "drink"],
  "groceries": ["grocery", "supermarket", "market", "mart", "tesco", "lotus", "aeon", "jaya grocer", "village grocer", "produce"],
  "restaurants": ["restaurant", "dine", "dining", "cafe", "eatery", "bistro"],
  "takeaway / delivery": ["takeaway", "takeout", "delivery", "grabfood", "foodpanda", "food panda"],

  // Transport
  "transport": ["commute", "travel", "ride", "fare", "vehicle", "car"],
  "fuel": ["petrol", "gas", "diesel", "shell", "petronas", "caltex", "bhp"],
  "public transit": ["mrt", "lrt", "ktm", "train", "bus", "rapidkl", "monorail", "transit"],
  "ride share": ["grab", "taxi", "ehailing", "e-hailing", "ride", "indrive"],
  "parking": ["park", "carpark", "parking lot"],
  "car maintenance": ["service", "workshop", "tyre", "tire", "mechanic", "repair"],

  // Housing
  "housing": ["home", "house", "accommodation"],
  "rent": ["rental", "lease", "landlord"],
  "mortgage": ["home loan", "housing loan"],
  "utilities": ["electric", "electricity", "water", "tnb", "air selangor", "syabas", "bill", "indah water"],
  "internet": ["wifi", "broadband", "unifi", "maxis", "time", "fibre", "fiber", "celcom", "digi"],
  "home maintenance": ["repair", "plumber", "renovation", "cleaning"],

  // Health
  "health": ["medical", "wellness", "clinic", "doctor"],
  "medical": ["doctor", "clinic", "hospital", "gp", "checkup", "consultation"],
  "pharmacy": ["medicine", "drug", "guardian", "watsons", "caring", "prescription"],
  "gym": ["fitness", "workout", "gymnasium", "anytime fitness", "celebrity fitness"],
  "mental health": ["therapy", "therapist", "counselling", "psychologist"],

  // Shopping
  "shopping": ["shop", "store", "retail", "buy"],
  "clothing": ["clothes", "shoes", "shirt", "pants", "dress", "apparel", "fashion", "uniqlo", "zara", "h&m", "sneakers", "wardrobe", "jacket"],
  "electronics": ["gadget", "phone", "laptop", "charger", "headphones", "computer", "tech"],
  "household": ["home goods", "ikea", "furniture", "kitchenware", "appliance"],
  "online": ["lazada", "shopee", "amazon", "online shopping"],

  // Entertainment
  "entertainment": ["fun", "leisure", "hobby"],
  "subscriptions": ["subscription", "netflix", "spotify", "youtube", "disney", "subs", "membership"],
  "movies": ["movie", "cinema", "gsc", "tgv", "film"],
  "games": ["game", "gaming", "steam", "playstation", "xbox", "nintendo"],
  "events": ["concert", "ticket", "show", "festival", "gig"],

  // Travel
  "travel": ["trip", "vacation", "holiday", "tour"],
  "flights": ["flight", "airline", "airasia", "mas", "malaysia airlines", "plane"],
  "hotels": ["hotel", "airbnb", "booking", "agoda", "stay", "lodging"],
  "activities": ["tour", "excursion", "attraction", "sightseeing"],

  // Education
  "education": ["learning", "study", "school"],
  "courses": ["course", "class", "tuition", "udemy", "coursera", "workshop"],
  "books": ["book", "kinokuniya", "bookstore", "ebook", "textbook"],
  "software": ["app", "license", "saas", "subscription", "tool"],

  // Finance
  "finance": ["banking", "money"],
  "bank fees": ["fee", "charge", "service charge", "atm fee"],
  "interest": ["interest charge"],
  "insurance": ["takaful", "premium", "policy", "coverage", "prudential", "aia", "great eastern"],
  "tax": ["lhdn", "income tax", "gst", "sst", "duty"],

  // Giving
  "giving": ["charity", "donate", "generosity"],
  "treats & meals": ["treat", "belanja", "treat someone", "group meal"],
  "gifts": ["gift", "present", "birthday"],
  "donations": ["donation", "charity", "donate", "fundraiser"],
  "tithe / offering": ["tithe", "offering", "zakat", "church", "persembahan"],

  // Income
  "income": ["earnings", "revenue"],
  "salary": ["wage", "pay", "paycheck", "payroll", "gaji"],
  "freelance": ["gig", "contract", "side income", "commission"],
  "investment": ["dividend", "returns", "capital gain", "stock", "interest income"],
  "other income": ["refund", "reimbursement", "cashback", "rebate"],

  // Transfer
  "transfer": ["move", "topup", "top up", "reload", "withdrawal", "atm", "duitnow", "internal"],
};

/** True if the query matches the category's name or any of its aliases (substring, case-insensitive). */
export function categoryMatchesQuery(name: string, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (!q) return true;
  const n = name.toLowerCase();
  if (n.includes(q)) return true;
  const aliases = CATEGORY_ALIASES[n] ?? [];
  return aliases.some((a) => a.includes(q));
}
