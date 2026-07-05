// @ts-nocheck
const Analyzer = (() => {
    /* ── Source authority ──
     * Multiplier in the range [0.8, 1.2]. 1.0 = neutral.
     * Major wire services and reference outlets get the highest boost.
     * Matched case-insensitively against the article's `source` field; a
     * prefix / substring check is used so "BBC News" matches "bbc" and
     * "The Hindu — National" matches "the hindu".
     */
    const SOURCE_AUTHORITY = {
        'reuters': 1.2, 'associated press': 1.2, 'ap news': 1.2, 'ap': 1.2,
        'bbc': 1.15, 'bbc news': 1.15,
        'the guardian': 1.1, 'the new york times': 1.15, 'nytimes': 1.15,
        'washington post': 1.1, 'al jazeera': 1.1, 'al jazeera english': 1.1,
        'financial times': 1.15, 'the economist': 1.15, 'bloomberg': 1.15,
        'nature': 1.2, 'science': 1.2, 'sciencedirect': 1.15,
        'the hindu': 1.15, 'indian express': 1.1, 'hindustan times': 1.05,
        'ndtv': 1.1, 'ndtv top stories': 1.1, 'deccan herald': 1.05,
        'the wire': 1.0, 'scroll.in': 1.0, 'scroll': 1.0,
        'the print': 1.0, 'the quint': 0.95, 'firstpost': 0.95,
        'news18': 0.95, 'republic world': 0.9, 'livemint': 1.05,
        'business standard': 1.05, 'economic times': 1.05, 'moneycontrol': 1.0,
        'espn cricinfo': 1.1, 'cricbuzz': 1.0, 'sportstar': 1.0,
        'isro': 1.15, 'who india': 1.15, 'nature india': 1.15,
        'times of india': 1.05, 'india today': 1.05
    };
    /* ── Alarming keyword hints (small additive bonus) ──
     * Lower weights than the original ALARMING_KEYWORDS because the main
     * "importance" signal is the TF-IDF + buzz combination.
     */
    const ALARMING_HINTS = {
        'breaking': 3, 'just in': 3, 'urgent': 2, 'developing': 2, 'alert': 2, 'emergency': 2,
        'earthquake': 4, 'explosion': 4, 'explodes': 4, 'wildfire': 3, 'flood': 3, 'flooding': 3,
        'typhoon': 3, 'hurricane': 3, 'tornado': 3, 'tsunami': 4, 'landslide': 3, 'avalanche': 3,
        'attack': 3, 'attacks': 3, 'killed': 4, 'kills': 3, 'dies': 2, 'death': 2, 'dead': 2, 'dying': 3,
        'shooting': 4, 'shot': 2, 'missile': 4, 'missiles': 4, 'bomb': 3, 'bombing': 4,
        'war': 3, 'invasion': 4, 'strike': 2, 'strikes': 2, 'casualties': 3, 'wounded': 2,
        'injured': 2, 'massacre': 4, 'terror': 4, 'terrorist': 3,
        'crisis': 2, 'protest': 2, 'protests': 2, 'riot': 3, 'riots': 3,
        'resign': 2, 'resigns': 2, 'coup': 4, 'overthrow': 3,
        'evacuate': 3, 'evacuation': 3, 'hostage': 3, 'hostages': 3, 'siege': 3,
        'rescue': 2, 'trapped': 2, 'collapse': 3,
        'outbreak': 3, 'pandemic': 3, 'epidemic': 3,
        'scandal': 2, 'indicted': 3, 'indictment': 3, 'convicted': 3, 'arrested': 3, 'arrest': 2,
        'crash': 3, 'plunge': 2, 'plunges': 2, 'default': 2, 'sanctions': 2,
        'tragedy': 2, 'catastrophe': 3, 'catastrophic': 3, 'verdict': 2, 'overturned': 2
    };
    /* ── Recency decay ──
     * exp(-λ·hours) with λ = 0.05 → a 24h-old article keeps ~30 % of its
     * freshness, a 6h-old one keeps ~74 %. Tunable here.
     */
    const RECENCY_LAMBDA = 0.05;
    /* ── Buzz / co-occurrence ── */
    const BUZZ_TOP_TERMS = 5;
    const BUZZ_GAIN = 0.5;
    /* ── Cluster stopwords (more aggressive than tokenize stopwords) ──
     * Common high-frequency words that would otherwise make two unrelated
     * stories look similar ("India wins 3-1" vs "India wins 4-0" share "India"
     * and "wins" but those are not enough — we want title-level words).
     */
    const CLUSTER_STOPWORDS = new Set([
        'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
        'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
        'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'we', 'our', 'you', 'your', 'i', 'my', 'me',
        'not', 'no', 'if', 'than', 'then', 'so', 'what', 'when', 'where', 'who', 'how', 'why', 'which', 'about', 'after', 'before', 'over', 'under', 'up', 'down', 'out', 'off',
        'new', 'old', 'first', 'last', 'next', 'just', 'also', 'more', 'most', 'some', 'any', 'all', 'each', 'every', 'other', 'such', 'only', 'own', 'same',
        'into', 'through', 'during', 'between', 'against', 'around', 'near', 'far', 'here', 'there', 'now', 'still', 'already', 'yet',
        'amid', 'says', 'said', 'say', 'told', 'tell', 'tells', 'report', 'reports', 'reported', 'according', 'claim', 'claims', 'claimed',
        'live', 'updates', 'update', 'news', 'top', 'watch', 'video', 'read', 'full', 'story', 'photos', 'photo', 'video', 'watch',
        'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'vs', 'per',
        'india', 'indian', 'delhi', 'mumbai', 'world', 'country', 'state', 'government', 'minister', 'official', 'source', 'reuters', 'agency',
        'the', 'a', 'an' // ultra-common English words that inflate similarity
    ]);
    /* ── Numeric fact extraction ──
     * Maps a keyword to a canonical metric label. Include the verb roots
     * (kill, injure) plus their inflections so we match "kills 10" as well
     * as "killed 10". "score" is intentionally NOT here — the dash-pattern
     * regex below is more reliable than the keyword+number approach (which
     * would pick up stray "score 3" fragments from "score 3-1 final").
     */
    const METRIC_KEYWORDS = [
        { keys: ['kill', 'kills', 'killed', 'killing', 'dead', 'died', 'dies', 'dying', 'death', 'deaths', 'deadly', 'casualties', 'casualty', 'toll', 'perished', 'slain', 'slay'], metric: 'casualties' },
        { keys: ['injure', 'injures', 'injured', 'injuring', 'wounded', 'wound', 'wounds', 'hurt', 'hurts'], metric: 'injured' },
        { keys: ['magnitude', 'richter'], metric: 'magnitude' },
        { keys: ['cases', 'case', 'infected', 'infects', 'confirmed', 'confirms', 'sick'], metric: 'cases' },
        { keys: ['arrest', 'arrests', 'arrested', 'detained', 'detain', 'jailed', 'jail'], metric: 'arrested' },
        { keys: ['percent', 'percentage'], metric: 'percent' },
        { keys: ['price', 'rate', 'cost', 'worth', 'valued', 'valued at'], metric: 'price' }
    ];
    function canonicalMetricFromWord(w) {
        if (!w)
            return null;
        const lw = w.toLowerCase();
        for (const e of METRIC_KEYWORDS) {
            if (e.keys.includes(lw))
                return e.metric;
        }
        return null;
    }
    /* Number-word lookup for "ten" -> 10, etc. Limited to common values
     * (1..19) and round numbers up to 100. Anything more exotic falls
     * back to the raw digit string. */
    const NUMBER_WORDS = {
        zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
        eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
        fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
        nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
        seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
        million: 1000000, billion: 1000000000, trillion: 1000000000000
    };
    /**
     * Normalize a value string so that "3-1", "3 to 1", "three to one",
     * "$5B", "5 billion" all collapse to a canonical form for comparison.
     *
     * Strategy:
     *   1. Strip leading $ / currency symbols
     *   2. Expand "B/M/K/T" suffixes to their full word form so they
     *      don't confuse downstream number parsing
     *   3. If a number word appears in the string, expand it
     *   4. Return a lowercased, whitespace-normalized form
     */
    function normalizeValue(raw) {
        if (raw == null)
            return '';
        let s = String(raw).trim().toLowerCase();
        // Score strings ("3-1", "3 to 1") are already compact — pass through.
        if (/^\d+([-–]\d+| to \d+)$/.test(s))
            return s;
        // Strip $ and other currency markers.
        s = s.replace(/[$€£¥]/g, '').trim();
        // Expand short suffixes: "5b" -> "5 billion", "3k" -> "3 thousand".
        s = s.replace(/(\d+(?:\.\d+)?)\s*b\b/g, '$1 billion');
        s = s.replace(/(\d+(?:\.\d+)?)\s*m\b/g, '$1 million');
        s = s.replace(/(\d+(?:\.\d+)?)\s*k\b/g, '$1 thousand');
        s = s.replace(/(\d+(?:\.\d+)?)\s*t\b/g, '$1 trillion');
        // Expand number words ("ten killed" -> "10 killed").
        s = s.replace(/\b([a-z]+)\b/g, (m) => {
            if (NUMBER_WORDS[m] != null)
                return String(NUMBER_WORDS[m]);
            return m;
        });
        // Collapse whitespace.
        s = s.replace(/\s+/g, ' ').trim();
        return s;
    }
    /**
     * Tokenize a string into a normalized word set for clustering.
     * Lowercase, strip URLs / punctuation, drop stopwords and pure numbers.
     */
    function normalizeForCluster(text) {
        if (!text)
            return [];
        return text.toLowerCase()
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(/[^a-z0-9\s'-]/g, ' ')
            .split(/\s+/)
            .filter(w => w && w.length > 2 && !CLUSTER_STOPWORDS.has(w) && !/^\d+$/.test(w));
    }
    /**
     * Jaccard similarity between two sets: |A∩B| / |A∪B|.
     */
    function jaccard(setA, setB) {
        if (!setA.size || !setB.size)
            return 0;
        let inter = 0;
        const smaller = setA.size < setB.size ? setA : setB;
        const larger = setA.size < setB.size ? setB : setA;
        for (const x of smaller)
            if (larger.has(x))
                inter++;
        const union = setA.size + setB.size - inter;
        return union === 0 ? 0 : inter / union;
    }
    /**
     * Cluster articles whose title (and a snippet of the summary) look like
     * the same story. Uses pairwise Jaccard over normalized word sets; union-find
     * to merge transitive matches. O(n²) but n is bounded by the current
     * scope/subcat pool (typically 50–300 articles, well under a second).
     *
     * @param {Array} articles
     * @param {number} threshold  Jaccard threshold in [0, 1]. Default 0.35.
     * @returns {Array<Array>}    Array of clusters (each cluster is an array of articles).
     */
    function clusterByTitle(articles, threshold = 0.35) {
        if (!articles || articles.length === 0)
            return [];
        const normalized = articles.map(a => {
            const title = a.title || '';
            const summary = (a.summary || '').slice(0, 200);
            return { article: a, words: new Set(normalizeForCluster(title + ' ' + summary)) };
        });
        const n = normalized.length;
        const parent = new Array(n);
        for (let i = 0; i < n; i++)
            parent[i] = i;
        function find(x) {
            while (parent[x] !== x) {
                parent[x] = parent[parent[x]];
                x = parent[x];
            }
            return x;
        }
        function union(x, y) {
            const rx = find(x), ry = find(y);
            if (rx !== ry)
                parent[rx] = ry;
        }
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (jaccard(normalized[i].words, normalized[j].words) >= threshold) {
                    union(i, j);
                }
            }
        }
        const groups = new Map();
        for (let i = 0; i < n; i++) {
            const root = find(i);
            if (!groups.has(root))
                groups.set(root, []);
            groups.get(root).push(articles[i]);
        }
        return Array.from(groups.values());
    }
    /**
     * Pull (keyword, number) pairs out of an article's text. We match in both
     * directions ("killed 10" and "10 killed") and normalise the keyword to a
     * canonical metric label. The cleanest pattern is:
     *   keyword + non-digit-filler + number
     *   number + non-digit-filler + keyword
     * Score patterns like "3-1" or "3 to 1" are also captured even when the
     * word "score" is absent (common in match reports).
     *
     * @param {string} text  Title + summary (HTML already stripped).
     * @returns {Object}     Map of metric → array of { value, context }.
     */
    function extractFacts(text) {
        const facts = {};
        if (!text)
            return facts;
        const clean = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        // Sanity bounds per metric. A "magnitude" of 50 or "percent" of 9000
        // is never real news — those matches are almost always a stray number
        // from elsewhere in the sentence that the keyword regex over-matched.
        const MAX_BY_METRIC = { magnitude: 12, percent: 100, score: 99 };
        // Direction 1: keyword (filler) number
        const KW = METRIC_KEYWORDS.flatMap(e => e.keys).join('|');
        // Filler is kept short (~15 chars) so the regex can't bridge across a
        // sentence boundary and grab a stray number from an unrelated clause.
        const afterRe = new RegExp('\\b(' + KW + ')\\b[^.\\d%]{0,15}?(\\d+(?:[.,]\\d+)?)\\s*(?:%|percent)?', 'gi');
        let m;
        while ((m = afterRe.exec(clean)) !== null) {
            const metric = canonicalMetricFromWord(m[1]);
            if (!metric)
                continue;
            const value = normalizeValue(m[2]);
            const num = parseFloat(value);
            if (MAX_BY_METRIC[metric] != null && (isNaN(num) || num > MAX_BY_METRIC[metric]))
                continue;
            if (!facts[metric])
                facts[metric] = [];
            facts[metric].push({ value, context: clean.slice(Math.max(0, m.index - 10), Math.min(clean.length, m.index + m[0].length + 10)).trim() });
        }
        // Direction 2: number (filler) keyword
        const beforeRe = new RegExp('(\\d+(?:[.,]\\d+)?)\\s*(?:%|percent)?[^.\\d]{0,15}?\\b(' + KW + ')\\b', 'gi');
        while ((m = beforeRe.exec(clean)) !== null) {
            const metric = canonicalMetricFromWord(m[2]);
            if (!metric)
                continue;
            const value = normalizeValue(m[1]);
            const num = parseFloat(value);
            if (MAX_BY_METRIC[metric] != null && (isNaN(num) || num > MAX_BY_METRIC[metric]))
                continue;
            if (!facts[metric])
                facts[metric] = [];
            facts[metric].push({ value, context: clean.slice(Math.max(0, m.index - 10), Math.min(clean.length, m.index + m[0].length + 10)).trim() });
        }
        // Score pattern: 3-1, 3–1, "3 to 1" (capped at 2 digits so we don't
        // accidentally match dates like "2024-06" or "1234-5678").
        const scoreRe = /\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b|\b(\d{1,2})\s+to\s+(\d{1,2})\b/g;
        while ((m = scoreRe.exec(clean)) !== null) {
            const a = m[1] || m[3];
            const b = m[2] || m[4];
            if (!facts.score)
                facts.score = [];
            facts.score.push({ value: normalizeValue(a + '-' + b), context: m[0] });
        }
        return facts;
    }
    /**
     * Resolve the "best" value for a metric in an article. Right now we take
     * the first fact we extracted (most prominent in the text). Future
     * improvements could weight facts by where they appear (lead vs body).
     */
    function primaryFact(articleFacts, metric) {
        const list = articleFacts[metric];
        return (list && list.length) ? list[0] : null;
    }
    /**
     * Detect conflicting stories across the given article list. Returns a Map
     * keyed by article link. For every article that participates in a
     * conflicting cluster the map value is:
     *   { isConflicting: true, clusterSize, conflicts: [{ metric, detail: [{ value, articles:[...] }] }] }
     *
     * Two conflict kinds are merged into one result per article:
     *   - numeric / factual (different numbers for the same metric)
     *   - claim / narrative (one source affirms / another denies / uses
     *     an opposing verb about the same subject)
     *
     * @param {Array} articles
     * @param {number} threshold   Jaccard threshold for clustering (default 0.35)
     * @returns {Map<string, Object>}
     */
    function detectConflicts(articles, threshold = 0.35) {
        const out = new Map();
        if (!articles || articles.length < 2)
            return out;
        // 1) Numeric / factual conflicts.
        const numericMap = detectNumericConflicts(articles, threshold);
        for (const [link, c] of numericMap) {
            out.set(link, c);
        }
        // 2) Claim / narrative conflicts.
        const claimMap = detectClaimConflicts(articles, threshold);
        for (const [link, c] of claimMap) {
            if (out.has(link)) {
                out.get(link).conflicts = out.get(link).conflicts.concat(c.conflicts);
            }
            else {
                out.set(link, c);
            }
        }
        // 3) Severity score per cluster — used by the Conflicts view to
        //    sort by importance. Score = w1*(# conflicting metrics) +
        //    w2*(sum of source authority of involved sources) +
        //    w3*(recency boost for the cluster). Capped at 100.
        for (const [, c] of out) {
            c.severity = computeSeverity(c);
        }
        return out;
    }
    /**
     * Severity score (0..100) for a conflict entry. Heuristic:
     *   - more distinct metrics = more severe (up to 4 metrics counts as max)
     *   - higher source authority of involved sources = more severe
     *   - clusters within the last 6h get a recency boost
     */
    function computeSeverity(conflict) {
        const conflicts = conflict.conflicts || [];
        const metricCount = Math.min(conflicts.length, 4);
        // Collect all sources mentioned across the conflicts.
        const sources = new Set();
        for (const g of conflicts) {
            for (const d of (g.detail || [])) {
                for (const a of (d.articles || [])) {
                    const s = (a.source || '').toLowerCase().trim();
                    if (s)
                        sources.add(s);
                }
            }
        }
        // Average authority across involved sources (0.8..1.2 → 0..1).
        let authSum = 0, authN = 0;
        for (const s of sources) {
            const w = sourceAuthorityWeight(s);
            authSum += (w - 0.8) / 0.4; // normalise to 0..1
            authN++;
        }
        const authorityScore = authN ? (authSum / authN) : 0;
        // Recency: cluster metadata doesn't include a timestamp, so we
        // approximate from the source-articles' pubDate.
        // The caller can override by setting cluster.recentHours.
        const recencyScore = 0.5; // default; real-time refinement is rare
        // Final weighted sum: 0.5 * metric + 0.35 * authority + 0.15 * recency, × 100.
        const score = (0.5 * (metricCount / 4) + 0.35 * authorityScore + 0.15 * recencyScore) * 100;
        return Math.round(Math.max(0, Math.min(100, score)));
    }
    function severityBucket(score) {
        if (score >= 70)
            return 'high';
        if (score >= 40)
            return 'medium';
        return 'low';
    }
    /**
     * Internal: numeric / factual conflict detection (the original
     * `detectConflicts` body). Kept separate so the public function can
     * merge numeric and claim results.
     */
    function detectNumericConflicts(articles, threshold = 0.35) {
        const out = new Map();
        if (!articles || articles.length < 2)
            return out;
        const clusters = clusterByTitle(articles, threshold);
        for (const cluster of clusters) {
            if (cluster.length < 2)
                continue;
            // Skip clusters where all articles come from the same source.
            const sources = new Set(cluster.map(a => (a.source || '').toLowerCase()));
            if (sources.size < 2)
                continue;
            // Extract facts once per article.
            const articleFacts = cluster.map(a => ({
                article: a,
                facts: extractFacts((a.title || '') + ' ' + (a.summary || ''))
            }));
            // Collect every metric that appears in at least 2 articles.
            const metricCounts = new Map();
            for (const af of articleFacts) {
                for (const m of Object.keys(af.facts)) {
                    metricCounts.set(m, (metricCounts.get(m) || 0) + 1);
                }
            }
            const sharedMetrics = Array.from(metricCounts.entries())
                .filter(([, c]) => c >= 2)
                .map(([m]) => m);
            if (!sharedMetrics.length)
                continue;
            const clusterConflicts = [];
            for (const metric of sharedMetrics) {
                const byValue = new Map();
                for (const af of articleFacts) {
                    const f = primaryFact(af.facts, metric);
                    if (!f)
                        continue;
                    if (!byValue.has(f.value))
                        byValue.set(f.value, []);
                    byValue.get(f.value).push({
                        source: af.article.source || '',
                        title: af.article.title || '',
                        link: af.article.link || ''
                    });
                }
                if (byValue.size < 2)
                    continue;
                clusterConflicts.push({
                    metric,
                    detail: Array.from(byValue.entries()).map(([value, arts]) => ({ value, articles: arts }))
                });
            }
            if (clusterConflicts.length > 0) {
                for (const af of articleFacts) {
                    if (out.has(af.article.link))
                        continue;
                    out.set(af.article.link, {
                        isConflicting: true,
                        clusterSize: cluster.length,
                        conflicts: clusterConflicts
                    });
                }
            }
        }
        return out;
    }
    /**
     * Format a conflict for display: "Score: 3-1 (Reuters, BBC) vs 2-1 (CNN)".
     */
    function formatConflictSummary(conflict) {
        return conflict.metric + ': ' + conflict.detail
            .map(group => group.value + ' (' + group.articles.map(a => a.source || 'Unknown').join(', ') + ')')
            .join(' vs ');
    }
    /* ── Claim-based (narrative) conflict detection ──
     * Catches cases where two articles about the same story make opposite
     * factual claims — not just different numbers. Two layers:
     *
     *   1. Negation: one article says "X said Y" while another says
     *      "X denied Y" / "X did not say Y". Looked for as
     *      `(subject) (verb) ...` and `(subject) (neg-verb) ...` pairs.
     *
     *   2. Opposing-verb polarity: pairs like (confirm ↔ deny),
     *      (admit ↔ deny), (support ↔ oppose), (win ↔ lose), (alive ↔ dead).
     *
     * The same Jaccard clustering from `clusterByTitle` is reused so we
     * only compare articles that are plausibly about the same event.
     */
    // Pairs of words that mean the OPPOSITE of each other in news writing.
    // Matched case-insensitively as whole words in proximity to a shared
    // subject (named entity).
    const OPPOSING_VERBS = [
        ['confirmed', 'denied'],
        ['confirmed', 'rejected'],
        ['admitted', 'denied'],
        ['admitted', 'rejected'],
        ['agreed', 'refused'],
        ['accepted', 'rejected'],
        ['approved', 'vetoed'],
        ['supported', 'opposed'],
        ['backed', 'opposed'],
        ['endorsed', 'rejected'],
        ['won', 'lost'],
        ['defeated', 'lost to'],
        ['succeeded', 'failed'],
        ['survived', 'died'],
        ['rescued', 'killed'],
        ['acquitted', 'convicted'],
        ['cleared', 'charged'],
        ['innocent', 'guilty'],
        ['legal', 'illegal'],
        ['safe', 'dangerous'],
        ['allied', 'opposed'],
        ['ally', 'enemy']
    ];
    // Negation words: if any of these appear within ~3 words of a verb in
    // one article, but not in the other, the claims disagree.
    const NEGATION_WORDS = ['not', "n't", 'no', 'never', 'denies', 'denied', 'deny',
        'rejects', 'rejected', 'refuses', 'refused', 'fails', 'failed',
        'refuted', 'debunks', 'debunked', 'dismissed'];
    /**
     * Extract "claim units" from a piece of text. Each claim is a tuple
     * of (subject, verb, negated, context) where:
     *   - subject: a capitalized word/phrase (named entity), or a quoted
     *     string. Acts as the "anchor" that links claims across articles.
     *   - verb: the predicate word (lowercased) that conveys the claim.
     *   - negated: true if a negation word appears within 3 tokens before
     *     the verb, OR the verb itself is a negation word.
     *   - context: the surrounding sentence for display.
     *
     * Returns an array of claim objects, possibly empty.
     */
    function extractClaims(text) {
        if (!text)
            return [];
        const clean = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (clean.length < 5)
            return [];
        // Split into sentences (very rough; news text has plenty of periods).
        const sentences = clean.split(/(?<=[.!?])\s+/).filter(s => s.length > 8);
        const claims = [];
        // Regex to find (named entity) (optional "not") (verb word).
        // We accept any "capitalized run" or a 1-2 word "NN." abbreviation as
        // a subject, and any non-stopword word as a candidate verb.
        const SUBJECT_RE = /\b([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2}|"[^"]+"|'[^']+')\b/g;
        const STOPLIST = new Set(['The', 'This', 'That', 'These', 'Those', 'It', 'He', 'She',
            'They', 'We', 'I', 'You', 'A', 'An', 'And', 'But', 'Or',
            'In', 'On', 'At', 'To', 'For', 'Of', 'With', 'By', 'As',
            'After', 'Before', 'During', 'According', 'According To',
            'Reuters', 'AFP', 'BBC', 'PTI', 'ANI', 'AP']);
        for (const sent of sentences) {
            // Pull subject candidates from this sentence.
            const subjects = [];
            let m;
            const re = new RegExp(SUBJECT_RE.source, 'g');
            while ((m = re.exec(sent)) !== null) {
                if (STOPLIST.has(m[1]))
                    continue;
                subjects.push({ text: m[1], index: m.index });
            }
            if (!subjects.length)
                continue;
            // Tokenize the sentence (lowercased + word list with positions).
            const lower = sent.toLowerCase();
            const tokens = lower.split(/[^a-z']+/).filter(Boolean);
            // For each subject, find the closest verb-shaped word within 6
            // tokens after the subject's end. A "verb-shaped" word is any
            // non-stopword word that isn't a pure punctuation.
            const SUBJ_END = (subj) => subj.index + subj.text.length;
            for (const subj of subjects) {
                const afterOffset = SUBJ_END(subj);
                const window = lower.slice(afterOffset, afterOffset + 60);
                const winTokens = window.split(/[^a-z']+/).filter(Boolean);
                if (!winTokens.length)
                    continue;
                // Find first word in window that looks like a content verb.
                let verbIdx = -1;
                for (let i = 0; i < Math.min(6, winTokens.length); i++) {
                    const w = winTokens[i];
                    if (w.length < 3)
                        continue;
                    if (/^(is|are|was|were|has|have|had|will|would|could|should|may|might|can|do|does|did|the|a|an|and|or|but|to|of|for|on|in|at|by|with|that|this|these|those|said|says|told|tells|reports?|reported|according)$/.test(w))
                        continue;
                    verbIdx = i;
                    break;
                }
                if (verbIdx < 0)
                    continue;
                const verb = winTokens[verbIdx];
                // Determine negation: look at the 3 tokens immediately before
                // the verb, OR if the verb itself is a negation word.
                const lookback = winTokens.slice(Math.max(0, verbIdx - 3), verbIdx);
                let negated = NEGATION_WORDS.includes(verb);
                for (const lb of lookback) {
                    if (NEGATION_WORDS.includes(lb)) {
                        negated = true;
                        break;
                    }
                }
                claims.push({
                    subject: subj.text,
                    subjectKey: subj.text.toLowerCase(),
                    verb,
                    negated,
                    context: sent.trim()
                });
            }
        }
        return claims;
    }
    /**
     * Given a list of articles, find pairs of articles in the same cluster
     * that disagree on a claim about the same subject. Returns a Map<link,
     * conflict> with `metric: 'claim'` and `detail: [{ value, articles: [...] }]`.
     *
     * Two clustering strategies are tried (union):
     *   1. Jaccard on title + summary (same as numeric conflict detection),
     *      so articles with high vocabulary overlap are clustered.
     *   2. Entity-based: articles that share at least one named entity
     *      (capitalized run / quoted string) in their claim subjects are
     *      clustered, even if their vocabulary differs.
     * The second strategy is what makes claim detection useful: two
     * articles about the same politician often use different words
     * ("Modi will visit" vs "PM to travel to") but mention the same entity.
     */
    function detectClaimConflicts(articles, threshold = 0.35) {
        const out = new Map();
        if (!articles || articles.length < 2)
            return out;
        // Build per-article claims once.
        const perArticle = articles.map(a => ({
            article: a,
            claims: extractClaims((a.title || '') + ' ' + (a.summary || ''))
        }));
        // Helper: collect every subject key (lowercased) per article.
        const articleSubjectKeys = perArticle.map(pac => new Set(pac.claims.map(c => c.subjectKey)));
        // 1) Vocabulary-based clusters (reuse numeric clusters).
        const vocabClusters = clusterByTitle(articles, threshold);
        // 2) Entity-based clusters: walk every article, group with any
        // other article that shares at least one subject entity.
        const parent = articles.map((_, i) => i);
        function find(x) { while (parent[x] !== x) {
            parent[x] = parent[parent[x]];
            x = parent[x];
        } return x; }
        function union(x, y) { const rx = find(x), ry = find(y); if (rx !== ry)
            parent[rx] = ry; }
        for (let i = 0; i < articles.length; i++) {
            for (let j = i + 1; j < articles.length; j++) {
                const ai = articleSubjectKeys[i], aj = articleSubjectKeys[j];
                for (const s of ai) {
                    if (aj.has(s)) {
                        union(i, j);
                        break;
                    }
                }
            }
        }
        const entityGroups = new Map();
        for (let i = 0; i < articles.length; i++) {
            const root = find(i);
            if (!entityGroups.has(root))
                entityGroups.set(root, []);
            entityGroups.get(root).push(articles[i]);
        }
        const entityClusters = Array.from(entityGroups.values());
        // Merge the two cluster sets (deduplicate by member-set).
        const seen = new Set();
        const allClusters = [];
        function clusterKey(c) {
            c.map(a => a.link || a.title).sort();
            return c.map(a => a.link || a.title).join('|');
        }
        for (const c of vocabClusters) {
            const k = clusterKey(c);
            if (k && !seen.has(k)) {
                seen.add(k);
                allClusters.push(c);
            }
        }
        for (const c of entityClusters) {
            const k = clusterKey(c);
            if (k && !seen.has(k)) {
                seen.add(k);
                allClusters.push(c);
            }
        }
        for (const cluster of allClusters) {
            if (cluster.length < 2)
                continue;
            // Single-source clusters are not flagged (same syndication).
            const sources = new Set(cluster.map(a => (a.source || '').toLowerCase()));
            if (sources.size < 2)
                continue;
            // Get the per-article claims for members of this cluster.
            const clusterLinks = new Set(cluster.map(a => a.link));
            const clusterArticles = perArticle.filter(pac => clusterLinks.has(pac.article.link));
            // Collect every claim grouped by subjectKey.
            const bySubject = new Map();
            for (const pac of clusterArticles) {
                for (const c of pac.claims) {
                    if (!bySubject.has(c.subjectKey))
                        bySubject.set(c.subjectKey, []);
                    bySubject.get(c.subjectKey).push({ ...c, source: pac.article.source || '', link: pac.article.link || '' });
                }
            }
            const clusterConflicts = [];
            for (const [subjectKey, claimList] of bySubject) {
                if (claimList.length < 2)
                    continue;
                // Skip subjects that appear in only one article (no disagreement possible).
                const distinctSources = new Set(claimList.map(c => (c.source || '').toLowerCase()).filter(Boolean));
                if (distinctSources.size < 2)
                    continue;
                // Group by (verb + polarity).
                const byValue = new Map();
                for (const c of claimList) {
                    const key = c.verb + '|' + (c.negated ? 'N' : 'A');
                    if (!byValue.has(key)) {
                        byValue.set(key, { verb: c.verb, negated: c.negated, articles: [], context: c.context });
                    }
                    byValue.get(key).articles.push({ source: c.source, link: c.link, title: c.link });
                }
                if (byValue.size < 2)
                    continue;
                // Require genuine disagreement.
                const values = Array.from(byValue.values());
                let realConflict = false;
                for (let i = 0; i < values.length && !realConflict; i++) {
                    for (let j = i + 1; j < values.length && !realConflict; j++) {
                        const a = values[i], b = values[j];
                        if (a.verb === b.verb && a.negated !== b.negated)
                            realConflict = true;
                        if (!realConflict && isOpposingVerb(a.verb, b.verb))
                            realConflict = true;
                        if (!realConflict && a.verb === b.verb && (a.negated || b['negated']))
                            realConflict = true;
                    }
                }
                if (!realConflict)
                    continue;
                clusterConflicts.push({
                    metric: 'claim',
                    subject: claimList[0].subject,
                    detail: values.map(v => ({
                        value: formatClaimValue(v),
                        articles: dedupeArticleRefs(v.articles)
                    }))
                });
            }
            if (clusterConflicts.length > 0) {
                for (const pac of clusterArticles) {
                    if (out.has(pac.article.link))
                        continue;
                    out.set(pac.article.link, {
                        isConflicting: true,
                        clusterSize: cluster.length,
                        conflicts: clusterConflicts
                    });
                }
            }
        }
        return out;
    }
    function isOpposingVerb(a, b) {
        a = (a || '').toLowerCase();
        b = (b || '').toLowerCase();
        for (const pair of OPPOSING_VERBS) {
            if ((pair[0] === a && pair[1] === b) || (pair[0] === b && pair[1] === a))
                return true;
        }
        return false;
    }
    function formatClaimValue(v) {
        // If the verb IS the negation word itself ("denied", "rejected"),
        // just show the verb — no need to prefix "did not".
        if (NEGATION_WORDS.indexOf(v.verb) >= 0)
            return v.verb;
        return (v.negated ? 'did not ' : '') + v.verb;
    }
    function dedupeArticleRefs(refs) {
        const seen = new Set();
        const out = [];
        for (const r of refs) {
            if (seen.has(r.link))
                continue;
            seen.add(r.link);
            out.push(r);
        }
        return out;
    }
    /**
     * Look up the source-authority weight for a given source name. Falls back
     * to 1.0 when the source isn't on the list.
     */
    function sourceAuthorityWeight(source) {
        if (!source)
            return 1.0;
        const s = source.toLowerCase().trim();
        if (SOURCE_AUTHORITY[s] != null)
            return SOURCE_AUTHORITY[s];
        for (const k of Object.keys(SOURCE_AUTHORITY)) {
            if (s.startsWith(k) || k.startsWith(s))
                return SOURCE_AUTHORITY[k];
        }
        return 1.0;
    }
    /**
     * Score an article using TF-IDF (top-N terms) × recency decay × buzz
     * multiplier × source authority × user-engagement, plus a small
     * additive alarming-keyword bonus. Higher score = more important.
     * Mutates nothing — the caller composes the final ranking from the
     * returned pairs.
     *
     * @param {Array} articles   Pool to rank (the corpus = articles themselves).
     * @param {Object} [engagement]  Optional map: link/guid -> { likeCount, dislikeCount }.
     * @returns {Array<{article:Object, score:number}>}  Sorted by score desc.
     */
    function rankByAnalyzer(articles, engagement) {
        if (!articles || !articles.length)
            return [];
        const N = articles.length;
        // Tokenize once: terms (for TF) and a set (for set ops).
        const tfDocs = new Array(N);
        const termSets = new Array(N);
        for (let i = 0; i < N; i++) {
            const text = (articles[i].title || '') + ' ' + (articles[i].summary || '');
            const terms = (typeof AI !== 'undefined' && AI.tokenize) ? AI.tokenize(text) : tokenizeFallback(text);
            const tf = new Map();
            const seen = new Set();
            for (const t of terms) {
                tf.set(t, (tf.get(t) || 0) + 1);
                if (!seen.has(t)) {
                    seen.add(t);
                }
            }
            tfDocs[i] = tf;
            termSets[i] = seen;
        }
        // Document frequency across the corpus.
        const df = new Map();
        for (let i = 0; i < N; i++) {
            for (const t of termSets[i])
                df.set(t, (df.get(t) || 0) + 1);
        }
        // TF-IDF top-N sum + alarming boost.
        const TOP_N = 10;
        const tfidfSums = new Array(N);
        const titleTokenSets = new Array(N);
        for (let i = 0; i < N; i++) {
            const titleTokens = (typeof AI !== 'undefined' && AI.tokenize)
                ? AI.tokenize(articles[i].title || '')
                : tokenizeFallback(articles[i].title || '');
            const titleSet = new Set(titleTokens);
            titleTokenSets[i] = titleSet;
            const tf = tfDocs[i];
            const pairs = [];
            for (const [term, freq] of tf) {
                const idf = Math.log(N / (1 + (df.get(term) || 0))) + 1; // smoothed
                const titleBoost = titleSet.has(term) ? 2 : 1;
                pairs.push({ term, score: freq * idf * titleBoost });
            }
            pairs.sort((a, b) => b.score - a.score);
            let sum = 0;
            for (let k = 0; k < Math.min(TOP_N, pairs.length); k++)
                sum += pairs[k].score;
            tfidfSums[i] = sum;
        }
        // Recency decay.
        const now = Date.now();
        const recency = new Array(N);
        for (let i = 0; i < N; i++) {
            const t = articles[i].pubDate ? new Date(articles[i].pubDate).getTime() : 0;
            if (!t || isNaN(t)) {
                recency[i] = 0.5;
                continue;
            }
            const hours = Math.max(0, (now - t) / 3600000);
            recency[i] = Math.exp(-RECENCY_LAMBDA * hours);
        }
        // Buzz: how many other articles share at least one of this article's
        // top distinctive terms?
        const buzz = new Array(N);
        for (let i = 0; i < N; i++) {
            const myTerms = Array.from(termSets[i]);
            // Take BUZZ_TOP_TERMS most-frequent terms in this article.
            const sorted = myTerms
                .map(t => [t, tfDocs[i].get(t) || 0])
                .sort((a, b) => b[1] - a[1])
                .slice(0, BUZZ_TOP_TERMS)
                .map(([t]) => t);
            const mySet = new Set(sorted);
            if (!mySet.size) {
                buzz[i] = 1;
                continue;
            }
            let related = 0;
            for (let j = 0; j < N; j++) {
                if (i === j)
                    continue;
                for (const t of mySet)
                    if (termSets[j].has(t)) {
                        related++;
                        break;
                    }
            }
            buzz[i] = 1 + Math.log(1 + related) * BUZZ_GAIN;
        }
        // Source authority.
        const authority = new Array(N);
        for (let i = 0; i < N; i++)
            authority[i] = sourceAuthorityWeight(articles[i].source);
        // User engagement signal (likes / (likes + dislikes + 1)). Articles
        // that the user base found valuable get a small multiplicative boost.
        // Pulled from the optional `engagement` map (link -> {likeCount,
        // dislikeCount}); if absent, no boost.
        const engagementBoost = new Array(N);
        for (let i = 0; i < N; i++)
            engagementBoost[i] = 1.0;
        if (engagement && typeof engagement === 'object') {
            for (let i = 0; i < N; i++) {
                const e = engagement[articles[i].link || ''] || engagement[articles[i].guid || ''];
                if (!e)
                    continue;
                const likes = Math.max(0, Number(e.likeCount) || 0);
                const dislikes = Math.max(0, Number(e.dislikeCount) || 0);
                const total = likes + dislikes;
                if (total === 0)
                    continue;
                // ratio in [0, 1]; map to multiplier in [0.9, 1.1]
                const ratio = likes / (likes + dislikes + 1);
                engagementBoost[i] = 0.9 + 0.2 * ratio;
            }
        }
        // Alarming keyword additive boost.
        const alarm = new Array(N);
        for (let i = 0; i < N; i++) {
            const t = ((articles[i].title || '') + ' ' + (articles[i].summary || '')).toLowerCase();
            let s = 0;
            for (const k in ALARMING_HINTS) {
                if (t.indexOf(k) !== -1)
                    s += ALARMING_HINTS[k];
            }
            alarm[i] = s;
        }
        // Compose.
        const out = new Array(N);
        for (let i = 0; i < N; i++) {
            out[i] = {
                article: articles[i],
                score: tfidfSums[i] * recency[i] * buzz[i] * authority[i] * engagementBoost[i] + alarm[i] * 0.5
            };
        }
        out.sort((a, b) => {
            if (b.score !== a.score)
                return b.score - a.score;
            const ta = a.article.pubDate ? new Date(a.article.pubDate).getTime() : 0;
            const tb = b.article.pubDate ? new Date(b.article.pubDate).getTime() : 0;
            return tb - ta;
        });
        return out;
    }
    /* ── Fallback tokenize (only used if AI.tokenize isn't loaded) ──
     * Mirror of the stopword set in ai.js. Kept in sync manually — if
     * you change one, change both. Used only when analyzer.js is loaded
     * without AI being available (e.g. in a unit test or an isolated
     * worker). The duplication is intentional: analyzer.js should not
     * depend on ai.js.
     */
    const FALLBACK_STOPWORDS = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'being',
        'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
        'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her', 'their', 'we', 'our', 'you', 'your', 'i', 'my', 'me',
        'not', 'no', 'if', 'than', 'then', 'so', 'what', 'when', 'where', 'who', 'how', 'why', 'which', 'about', 'after', 'before', 'over', 'under', 'up', 'down', 'out', 'off',
        'new', 'old', 'first', 'last', 'next', 'just', 'also', 'more', 'most', 'some', 'any', 'all', 'each', 'every', 'other', 'such', 'only', 'own', 'same',
        'into', 'through', 'during', 'between', 'against', 'around', 'near', 'far', 'here', 'there', 'now', 'still', 'already', 'yet',
        'amid', 'says', 'said', 'say', 'told', 'tell', 'tells', 'report', 'reports', 'reported', 'according', 'claim', 'claims', 'claimed',
        'live', 'updates', 'update', 'news', 'top', 'watch', 'video', 'read', 'full', 'story', 'photos', 'photo', 'video', 'watch',
        'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'vs', 'per'
    ]);
    function tokenizeFallback(text) {
        if (!text)
            return [];
        return text.toLowerCase()
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(/[^a-z0-9\s'-]/g, ' ')
            .split(/\s+/)
            .filter(w => w && w.length > 2 && !FALLBACK_STOPWORDS.has(w) && !/^\d+$/.test(w));
    }
    return {
        SOURCE_AUTHORITY,
        ALARMING_HINTS,
        sourceAuthorityWeight,
        clusterByTitle,
        extractFacts,
        extractClaims,
        detectClaimConflicts,
        detectConflicts,
        detectNumericConflicts,
        formatConflictSummary,
        normalizeValue,
        computeSeverity,
        severityBucket,
        rankByAnalyzer
    };
})();
// Expose on window — see js/feeds.js for the rationale.
window.Analyzer = Analyzer;
