/* ── Subject Registry ──
 *
 * A static lookup table of public figures whose public statements we
 * want to analyse. The application uses this to detect when an article
 * is about a known person and to attach a Twitter handle so the
 * deterministic scoring engine can pull their recent tweets.
 *
 * Each entry:
 *   display_name    — Friendly name shown in chips and the dashboard
 *   twitter_handle  — Plain handle (no @) used for the Twitter v2 API
 *   aliases         — Lowercase variants of the name to match in text
 *
 * To add a new person, drop in a new key. The aliases are scanned
 * case-insensitively against article title + summary via word boundaries.
 * Keep aliases short and unambiguous (e.g. "Modi" not "The PM of India")
 * to avoid false positives.
 */
const SUBJECT_REGISTRY = {
  // Indian politicians
  'Narendra Modi': {
    display_name: 'Narendra Modi',
    twitter_handle: 'narendramodi',
    aliases: ['modi', 'pm modi', 'narendra damodardas modi']
  },
  'Amit Shah': {
    display_name: 'Amit Shah',
    twitter_handle: 'AmitShah',
    aliases: ['amit shah', 'shah']
  },
  'Rahul Gandhi': {
    display_name: 'Rahul Gandhi',
    twitter_handle: 'RahulGandhi',
    aliases: ['rahul gandhi', 'rahul']
  },
  'Yogi Adityanath': {
    display_name: 'Yogi Adityanath',
    twitter_handle: 'myogiadityanath',
    aliases: ['yogi adityanath', 'yogi', 'adityanath']
  },
  'Arvind Kejriwal': {
    display_name: 'Arvind Kejriwal',
    twitter_handle: 'ArvindKejriwal',
    aliases: ['arvind kejriwal', 'kejriwal']
  },
  'Mamata Banerjee': {
    display_name: 'Mamata Banerjee',
    twitter_handle: 'MamataOfficial',
    aliases: ['mamata banerjee', 'mamata', 'didi']
  },

  // World leaders
  'Joe Biden': {
    display_name: 'Joe Biden',
    twitter_handle: 'JoeBiden',
    aliases: ['joe biden', 'biden', 'president biden']
  },
  'Donald Trump': {
    display_name: 'Donald Trump',
    twitter_handle: 'realDonaldTrump',
    aliases: ['donald trump', 'trump']
  },
  'Vladimir Putin': {
    display_name: 'Vladimir Putin',
    twitter_handle: 'KremlinRussia_E',
    aliases: ['vladimir putin', 'putin']
  },
  'Xi Jinping': {
    display_name: 'Xi Jinping',
    twitter_handle: 'XiJinping',
    aliases: ['xi jinping', 'xi']
  },
  'Emmanuel Macron': {
    display_name: 'Emmanuel Macron',
    twitter_handle: 'EmmanuelMacron',
    aliases: ['emmanuel macron', 'macron']
  },
  'Rishi Sunak': {
    display_name: 'Rishi Sunak',
    twitter_handle: 'RishiSunak',
    aliases: ['rishi sunak', 'sunak']
  },
  'Volodymyr Zelenskyy': {
    display_name: 'Volodymyr Zelenskyy',
    twitter_handle: 'ZelenskyyUa',
    aliases: ['volodymyr zelenskyy', 'zelenskyy', 'zelensky']
  },
  'Benjamin Netanyahu': {
    display_name: 'Benjamin Netanyahu',
    twitter_handle: 'netanyahu',
    aliases: ['benjamin netanyahu', 'netanyahu']
  },

  // Tech leaders
  'Elon Musk': {
    display_name: 'Elon Musk',
    twitter_handle: 'elonmusk',
    aliases: ['elon musk', 'musk']
  },
  'Mark Zuckerberg': {
    display_name: 'Mark Zuckerberg',
    twitter_handle: 'finkd',
    aliases: ['mark zuckerberg', 'zuckerberg', 'zuck']
  },
  'Sundar Pichai': {
    display_name: 'Sundar Pichai',
    twitter_handle: 'sundarpichai',
    aliases: ['sundar pichai', 'pichai']
  },
  'Sam Altman': {
    display_name: 'Sam Altman',
    twitter_handle: 'sama',
    aliases: ['sam altman', 'altman']
  },
  'Tim Cook': {
    display_name: 'Tim Cook',
    twitter_handle: 'tim_cook',
    aliases: ['tim cook']
  },

  // Sports
  'Virat Kohli': {
    display_name: 'Virat Kohli',
    twitter_handle: 'imVkohli',
    aliases: ['virat kohli', 'kohli']
  },
  'MS Dhoni': {
    display_name: 'MS Dhoni',
    twitter_handle: 'msdhoni',
    aliases: ['ms dhoni', 'dhoni', 'm.s. dhoni']
  },
  'Lionel Messi': {
    display_name: 'Lionel Messi',
    twitter_handle: 'TeamMessi',
    aliases: ['lionel messi', 'messi']
  },
  'Cristiano Ronaldo': {
    display_name: 'Cristiano Ronaldo',
    twitter_handle: 'Cristiano',
    aliases: ['cristiano ronaldo', 'ronaldo']
  },
  'Rafael Nadal': {
    display_name: 'Rafael Nadal',
    twitter_handle: 'RafaelNadal',
    aliases: ['rafael nadal', 'nadal']
  }
};

/* Escape a string for safe insertion into a RegExp.
 * Prevents user-entered aliases from accidentally injecting regex
 * metacharacters like ".", "*" or "(".
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Build a flat array of [canonicalKey, subject, alias] tuples once
 * so we don't rebuild the regex for every article. Aliases are
 * lowercased so the comparison is case-insensitive.
 */
const SUBJECT_MATCH_TABLE = (() => {
  const out = [];
  for (const key of Object.keys(SUBJECT_REGISTRY)) {
    const subject = SUBJECT_REGISTRY[key];
    const seen = new Set();
    for (const alias of [key, ...(subject.aliases || [])]) {
      const lower = (alias || '').toLowerCase().trim();
      if (!lower || seen.has(lower)) continue;
      seen.add(lower);
      out.push({ subject, alias: lower, regex: new RegExp('\\b' + escapeRegExp(lower) + '\\b', 'i') });
    }
  }
  // Longer aliases first so "Narendra Modi" wins over "Modi" when both match.
  out.sort((a, b) => b.alias.length - a.alias.length);
  return out;
})();

/* Detect the first registered subject that appears in the given text.
 * Returns the subject object (display_name, twitter_handle, ...) or null.
 * If multiple subjects match, the one with the longest-matching alias
 * wins (e.g. "Narendra Modi" beats "Modi").
 */
function detectSubjectInText(text) {
  if (!text) return null;
  for (const entry of SUBJECT_MATCH_TABLE) {
    if (entry.regex.test(text)) return entry.subject;
  }
  return null;
}

/* Attach a `subject` property to the article if a registered person
 * is mentioned in its title or summary. Returns the subject or null.
 *
 * Memoised: once an article has been tagged (i.e. we've run the
 * detection against it), subsequent calls are O(1). The article
 * gets a `_subjectChecked` flag so we don't re-do the regex sweep
 * every time displayCurrentSubcat runs. This is a big deal when
 * the background-fetch re-render fires every 10 new articles:
 * the 4990 existing articles skip the work, only the 10 new
 * ones are checked.
 */
function tagArticleWithSubject(article) {
  if (!article) return null;
  if (article._subjectChecked) return article.subject || null;
  const text = ((article.title || '') + ' ' + (article.summary || ''));
  const subject = detectSubjectInText(text);
  if (subject) article.subject = subject;
  article._subjectChecked = true;
  return subject;
}
