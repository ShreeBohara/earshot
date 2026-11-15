// Hand-authored seed tables for the generator. Everything random (ids, cities, deals, activity
// text) is layered on top of these by `build.ts`, so the confusable structure never depends on
// the PRNG.

export type ConfusionType = "spelling" | "phonetic" | "shared-stem" | "abbreviation";

export type CompanySeed = {
  name: string;
  industry: string;
  /** Extra aliases beyond the automatic first-word alias. */
  aliases?: string[];
};

export type CompanyGroupSeed = {
  confusion: ConfusionType;
  members: CompanySeed[];
};

/** Confusable company groups. Every name is an invented, generic placeholder. */
export const COMPANY_GROUPS: CompanyGroupSeed[] = [
  {
    confusion: "spelling",
    members: [
      { name: "Acme Dynamics", industry: "Manufacturing" },
      { name: "Akme Dynamics", industry: "Manufacturing" },
      { name: "Acmi Dynamics", industry: "Logistics" },
    ],
  },
  {
    confusion: "phonetic",
    members: [
      { name: "Atmos Industrial", industry: "Manufacturing" },
      { name: "Atlas Freight", industry: "Logistics" },
      { name: "Atmas Group", industry: "Energy" },
    ],
  },
  {
    confusion: "phonetic",
    members: [
      { name: "Globelex Systems", industry: "Software" },
      { name: "Glovex Systems", industry: "Software" },
      { name: "Globalex Systems", industry: "Telecom" },
    ],
  },
  {
    confusion: "shared-stem",
    members: [
      { name: "Northwind Labs", industry: "Biotech" },
      { name: "Northwind Logistics", industry: "Logistics" },
      { name: "Northwind Foods", industry: "Food & Beverage" },
    ],
  },
  {
    confusion: "abbreviation",
    members: [
      { name: "Meridian Supply Co", industry: "Wholesale", aliases: ["MSC"] },
      { name: "Midland Steel Corp", industry: "Manufacturing", aliases: ["MSC"] },
    ],
  },
  {
    confusion: "abbreviation",
    members: [
      { name: "Pacific Crest Energy", industry: "Energy", aliases: ["PCE"] },
      { name: "Pacific Coast Electric", industry: "Utilities", aliases: ["PCE"] },
    ],
  },
  {
    confusion: "abbreviation",
    members: [
      { name: "Blue Harbor Analytics", industry: "Software", aliases: ["BHA"] },
      { name: "Bay Harbor Associates", industry: "Consulting", aliases: ["BHA"] },
    ],
  },
  {
    confusion: "abbreviation",
    members: [
      { name: "Consolidated Parts & Supply", industry: "Wholesale", aliases: ["CPS"] },
      { name: "Coastal Power Systems", industry: "Energy", aliases: ["CPS"] },
    ],
  },
  {
    confusion: "shared-stem",
    members: [
      { name: "Summit Ridge Capital", industry: "Financial Services" },
      { name: "Summit Ridge Medical", industry: "Healthcare" },
      { name: "Summit Peak Capital", industry: "Financial Services" },
    ],
  },
  {
    confusion: "shared-stem",
    members: [
      { name: "Harborview Health", industry: "Healthcare" },
      { name: "Harborview Marine", industry: "Maritime" },
    ],
  },
  {
    confusion: "shared-stem",
    members: [
      { name: "Redwood Analytics", industry: "Software" },
      { name: "Redwood Robotics", industry: "Manufacturing" },
    ],
  },
  {
    confusion: "spelling",
    members: [
      { name: "Kestrel Aero", industry: "Aerospace" },
      { name: "Kestral Aero", industry: "Aerospace" },
    ],
  },
  {
    confusion: "spelling",
    members: [
      { name: "Sigma Tooling", industry: "Manufacturing" },
      { name: "Sygma Tooling", industry: "Manufacturing" },
    ],
  },
  {
    confusion: "spelling",
    members: [
      { name: "Zenith Packaging", industry: "Packaging" },
      { name: "Zenyth Packaging", industry: "Packaging" },
    ],
  },
  {
    confusion: "phonetic",
    members: [
      { name: "Knight Security", industry: "Security" },
      { name: "Nite Security Group", industry: "Security" },
    ],
  },
  {
    confusion: "phonetic",
    members: [
      { name: "Wright Fabrication", industry: "Manufacturing" },
      { name: "Right Fabrication", industry: "Manufacturing" },
      { name: "Rite Fabrication", industry: "Construction" },
    ],
  },
  {
    confusion: "phonetic",
    members: [
      { name: "Pier Logistics", industry: "Logistics" },
      { name: "Peer Logistics", industry: "Logistics" },
    ],
  },
  {
    confusion: "phonetic",
    members: [
      { name: "Marsh Medical", industry: "Healthcare" },
      { name: "Marshal Medical", industry: "Healthcare" },
    ],
  },
];

/** Accounts with no look-alike, so the benchmark has easy negatives too. */
export const SINGLE_COMPANIES: CompanySeed[] = [
  { name: "Ironbridge Textiles", industry: "Apparel" },
  { name: "Tidewater Biotech", industry: "Biotech" },
  { name: "Copperleaf Retail", industry: "Retail" },
  { name: "Quarry Lane Media", industry: "Media" },
  { name: "Fernhill Education", industry: "Education" },
  { name: "Oakmont Insurance", industry: "Financial Services" },
  { name: "Sparrow Robotics", industry: "Manufacturing" },
  { name: "Lantern Hospitality", industry: "Hospitality" },
  { name: "Basalt Mining", industry: "Mining" },
  { name: "Willowbrook Pharma", industry: "Pharmaceuticals" },
  { name: "Cobalt Ridge Energy", industry: "Energy" },
  { name: "Juniper Bay Telecom", industry: "Telecom" },
  { name: "Granite State Builders", industry: "Construction" },
  { name: "Maple & Vine Grocers", industry: "Retail" },
  { name: "Delta Crossing Rail", industry: "Transportation" },
  { name: "Opal Street Studios", industry: "Media" },
  { name: "Thistle Software", industry: "Software" },
  { name: "Verdant Agritech", industry: "Agriculture" },
];

export type ContactGroupSeed = {
  confusion: ConfusionType;
  /** [firstName, lastName] per member. */
  members: [string, string][];
  /** Company names to pin the members to, in order. Unpinned groups land on random accounts. */
  pinTo?: string[];
};

/** Confusable contact groups. */
export const CONTACT_GROUPS: ContactGroupSeed[] = [
  {
    confusion: "phonetic",
    members: [
      ["Dana", "Lee"],
      ["Dana", "Li"],
      ["Donna", "Lee"],
    ],
    pinTo: ["Acme Dynamics", "Akme Dynamics", "Acmi Dynamics"],
  },
  {
    confusion: "spelling",
    members: [
      ["Kathryn", "Moore"],
      ["Katherine", "Moore"],
      ["Catherine", "Moore"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Raj", "Patel"],
      ["Raaj", "Patel"],
    ],
    pinTo: ["Atmos Industrial", "Atmas Group"],
  },
  {
    confusion: "spelling",
    members: [
      ["Sean", "Murphy"],
      ["Shawn", "Murphy"],
      ["Shaun", "Murphy"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Steven", "Clarke"],
      ["Stephen", "Clarke"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Aisha", "Khan"],
      ["Ayesha", "Khan"],
    ],
  },
  {
    confusion: "phonetic",
    members: [
      ["Jeffrey", "Walsh"],
      ["Geoffrey", "Walsh"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Eric", "Nilsson"],
      ["Erik", "Nilsson"],
      ["Erick", "Nilsson"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Sara", "Cohen"],
      ["Sarah", "Cohen"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Brian", "Reilly"],
      ["Bryan", "Reilly"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Allan", "Foster"],
      ["Allen", "Foster"],
      ["Alan", "Foster"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Mohammed", "Hassan"],
      ["Muhammad", "Hassan"],
      ["Mohamed", "Hassan"],
    ],
  },
  {
    confusion: "phonetic",
    members: [
      ["Priya", "Nair"],
      ["Preeya", "Nair"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Thomas", "Berg"],
      ["Tomas", "Berg"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Zoe", "Park"],
      ["Zoey", "Park"],
    ],
  },
  {
    confusion: "spelling",
    members: [
      ["Jon", "Whitaker"],
      ["John", "Whitaker"],
    ],
    pinTo: ["Northwind Labs", "Northwind Logistics"],
  },
  {
    confusion: "phonetic",
    members: [
      ["Mary", "Allen"],
      ["Marie", "Allen"],
    ],
  },
];

// Filler people. These pools share no first or last name with CONTACT_GROUPS, so the only
// confusable contacts are the ones listed above.
export const FILLER_FIRST_NAMES = [
  "Marcus",
  "Elena",
  "Tobias",
  "Nadia",
  "Owen",
  "Greta",
  "Hugo",
  "Imani",
  "Felix",
  "Lucia",
  "Victor",
  "Hana",
  "Mateo",
  "Ingrid",
  "Callum",
  "Yara",
  "Dmitri",
  "Noor",
  "Emeka",
  "Freya",
  "Rafael",
  "Sunita",
  "Joaquin",
  "Tamsin",
  "Anders",
  "Leilani",
  "Bruno",
  "Ximena",
  "Kwame",
  "Petra",
  "Idris",
  "Maren",
  "Luca",
  "Odette",
  "Santiago",
  "Wanjiru",
  "Teodor",
  "Mireille",
  "Arjun",
  "Signe",
];

export const FILLER_LAST_NAMES = [
  "Abara",
  "Brandt",
  "Castellano",
  "Dube",
  "Eriksen",
  "Fontaine",
  "Garza",
  "Holm",
  "Ito",
  "Jovanovic",
  "Kowalski",
  "Lindqvist",
  "Moreau",
  "Nakamura",
  "Okafor",
  "Petrov",
  "Quintero",
  "Rasmussen",
  "Sandoval",
  "Tanaka",
  "Underhill",
  "Varga",
  "Whitfield",
  "Yilmaz",
  "Zielinski",
  "Adeyemi",
  "Bianchi",
  "Costa",
  "Dalgaard",
  "Ferreira",
];

export const TITLES = [
  "VP of Operations",
  "Director of Procurement",
  "Head of Finance",
  "Operations Manager",
  "Chief Financial Officer",
  "IT Director",
  "Purchasing Manager",
  "General Manager",
  "Sales Operations Lead",
  "Chief Operating Officer",
  "Facilities Manager",
  "Supply Chain Lead",
  "Controller",
  "Head of Engineering",
  "Account Executive",
  "Office Manager",
];

export const CITIES = [
  "Austin",
  "Denver",
  "Chicago",
  "Seattle",
  "Boston",
  "Atlanta",
  "Portland",
  "Minneapolis",
  "Phoenix",
  "Nashville",
  "Pittsburgh",
  "Raleigh",
  "Salt Lake City",
  "Columbus",
  "Tampa",
  "San Diego",
  "Kansas City",
  "Madison",
];

export const SIZES = ["1-50", "51-200", "201-1000", "1001-5000", "5000+"] as const;

export const DEAL_PRODUCTS = [
  "Platform license",
  "Annual renewal",
  "Pilot program",
  "Expansion",
  "Onboarding package",
  "Support upgrade",
  "Site rollout",
  "Analytics add-on",
  "Multi-year agreement",
  "Starter plan",
];

export const NOTE_SUBJECTS = [
  "Call recap",
  "Pricing feedback",
  "Intro notes",
  "Security review notes",
  "Renewal discussion",
  "Budget check-in",
  "Champion update",
  "Competitor mention",
];

export const NOTE_BODIES = [
  "Spoke for 20 minutes. Interested, wants a revised quote.",
  "Budget is approved for next quarter. Waiting on legal.",
  "Asked about onboarding timeline and data migration.",
  "Concerned about price. Mentioned a competing offer.",
  "Happy with the pilot. Wants to expand to a second site.",
  "New decision maker joined; need to re-intro the product.",
  "Procurement asked for a security questionnaire.",
  "No response to last two emails. Try a call.",
];

export const MEETING_SUBJECTS = [
  "Discovery call",
  "Product demo",
  "Quarterly business review",
  "Onsite visit",
  "Technical deep dive",
  "Contract walkthrough",
];

export const MEETING_BODIES = [
  "Walked through the core workflow. Two follow-ups agreed.",
  "Attendees: operations and finance. Positive reception.",
  "Reviewed usage numbers and open support tickets.",
  "Covered integration questions; sending docs afterward.",
  "Agreed next step is a pilot scoped to one team.",
];

export const TASK_SUBJECTS = [
  "Send proposal",
  "Follow up on quote",
  "Share case study",
  "Schedule technical review",
  "Send updated pricing",
  "Confirm renewal date",
];

export const TASK_BODIES = [
  "Attach the revised pricing sheet.",
  "Check in after their board meeting.",
  "Loop in a solutions engineer.",
  "Confirm who signs on their side.",
  "Send the two-page summary they asked for.",
];
