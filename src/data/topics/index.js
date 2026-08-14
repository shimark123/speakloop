// This file wires together the topic folders below — you shouldn't need to
// edit it. To add topics, open the relevant category's topics.js file.

import general from "./off-the-cuff/general/topics.js";
import personal from "./off-the-cuff/personal/topics.js";
import hypothetical from "./off-the-cuff/hypothetical/topics.js";
import evaluative from "./off-the-cuff/evaluative/topics.js";
import humorous from "./off-the-cuff/humorous/topics.js";
import toastmasters from "./off-the-cuff/toastmasters/topics.js";

import science from "./deep-research/science/topics.js";
import history from "./deep-research/history/topics.js";
import tech from "./deep-research/tech/topics.js";
import economy from "./deep-research/economy/topics.js";
import society from "./deep-research/society/topics.js";

const CUFF_SOURCES = [
  { cat: "General", items: general },
  { cat: "Personal", items: personal },
  { cat: "Hypothetical", items: hypothetical },
  { cat: "Evaluative", items: evaluative },
  { cat: "Humorous", items: humorous },
  { cat: "Toastmasters", items: toastmasters },
];

const RESEARCH_SOURCES = [
  { cat: "Science", items: science },
  { cat: "History", items: history },
  { cat: "Tech", items: tech },
  { cat: "Economy", items: economy },
  { cat: "Society", items: society },
];

function buildTopics(sources, mode) {
  return sources.flatMap(({ cat, items }) =>
    items.map((text, i) => ({
      id: `${mode}-${cat.toLowerCase()}-${i}`,
      mode,
      cat,
      text,
    }))
  );
}

export const TOPICS = [
  ...buildTopics(CUFF_SOURCES, "cuff"),
  ...buildTopics(RESEARCH_SOURCES, "research"),
];

// "All" is scoped per source list, so Off the Cuff and Deep Research topics
// never mix together no matter how many get added to either side.
export const CUFF_CATS = ["All", ...CUFF_SOURCES.map((s) => s.cat)];
export const RESEARCH_CATS = ["All", ...RESEARCH_SOURCES.map((s) => s.cat)];
