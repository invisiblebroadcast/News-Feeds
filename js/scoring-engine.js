// @ts-nocheck
/* ── Scoring Engine ──
 *
 * Computes four deterministic scores about a public figure:
 *
 *   1. Hypocrisy (0-100)        — sentiment opposition between
 *                                  tweets and articles about the
 *                                  same subject.
 *   2. Relevance (0-100)        — TF-IDF cosine similarity between
 *                                  the subject's tweets and the
 *                                  articles in scope.
 *   3. Bias (Left | Center | Right)
 *                                — vocabulary lean on the political
 *                                  spectrum.
 *   4. Factual Clarity (0-100)  — source-authority weighting of the
 *                                  sources covering the subject.
 *
 * All four scores are pure functions of the inputs. No LLM, no
 * external service. The math is intentionally simple so the result
 * is easy to inspect and reproduce.
 */
const ScoringEngine = (() => {
    // ── AFINN-style sentiment lexicon (subset) ──
    // Each entry maps a lowercase word to a polarity in [-5, +5].
    // The full AFINN-165 list has ~3,300 words; this subset covers the
    // most common news vocabulary. Positive numbers = good/positive,
    // negative = bad/negative.
    const SENTIMENT_LEXICON = {
        // Strongly positive
        'great': 3, 'excellent': 3, 'outstanding': 3, 'wonderful': 3, 'fantastic': 3,
        'amazing': 4, 'superb': 3, 'brilliant': 3, 'incredible': 3, 'awesome': 4,
        'success': 3, 'successful': 3, 'triumph': 3, 'victory': 3, 'win': 2,
        'celebrate': 2, 'celebration': 2, 'congratulations': 2, 'praise': 2,
        'love': 2, 'support': 2, 'unite': 2, 'united': 2, 'together': 1, 'strong': 2,
        'progress': 2, 'achievement': 2, 'milestone': 2, 'record': 1, 'best': 3,
        'good': 2, 'great': 3, 'happy': 3, 'proud': 2, 'hope': 2, 'optimistic': 2,
        // Strongly negative
        'bad': -2, 'terrible': -3, 'awful': -3, 'horrible': -3, 'worst': -3,
        'fail': -2, 'failure': -2, 'crisis': -2, 'disaster': -3, 'catastrophe': -3,
        'tragedy': -3, 'attack': -2, 'attacks': -2, 'killed': -3, 'killing': -3,
        'death': -2, 'deaths': -2, 'died': -2, 'dead': -2, 'injured': -2, 'wounded': -2,
        'destroyed': -3, 'destroy': -3, 'damage': -2, 'damaged': -2, 'devastating': -3,
        'fear': -2, 'angry': -2, 'rage': -2, 'protest': -1, 'protests': -1,
        'riot': -2, 'riots': -2, 'violence': -2, 'violent': -2, 'war': -2,
        'threat': -2, 'threats': -2, 'hate': -3, 'corrupt': -3, 'corruption': -3,
        'scandal': -2, 'fraud': -3, 'cheat': -2, 'cheating': -2, 'lie': -2, 'lies': -2,
        'liar': -3, 'betray': -2, 'betrayal': -2, 'shame': -2, 'shameful': -3,
        'weak': -2, 'broken': -2, 'collapse': -2, 'collapsed': -2, 'crash': -2,
        'crashed': -2, 'explosion': -2, 'blast': -2, 'bomb': -3, 'terror': -3,
        'terrorism': -3, 'terrorist': -3, 'hostage': -2, 'kidnap': -2, 'flee': -1,
        'fled': -1, 'arrested': -1, 'jailed': -2, 'prison': -1, 'convicted': -2,
        'guilty': -2, 'innocent': 1, 'safe': 2, 'safety': 2, 'secure': 2, 'security': 1,
        'peace': 2, 'peaceful': 2, 'agreement': 1, 'deal': 1, 'treaty': 1,
        'condemn': -2, 'condemned': -2, 'denounce': -2, 'denounced': -2,
        'ban': -1, 'banned': -1, 'reject': -1, 'rejected': -1, 'deny': -1, 'denied': -1
    };
    // Negators flip the polarity of the next sentiment-bearing word in
    // the same sentence. Same list as Analyzer.NEGATION_WORDS.
    const NEGATORS = new Set([
        'not', 'no', 'never', 'none', 'nothing', 'nobody', 'neither', 'nor',
        "n't", 'cannot', "can't", "won't", "wouldn't", "shouldn't", "isn't",
        "wasn't", "aren't", "weren't", "doesn't", "didn't", "don't", "hadn't",
        'hardly', 'barely', 'scarcely', 'without'
    ]);
    // Political vocabulary lists. The score is a simple frequency
    // comparison; whichever side dominates decides the lean.
    // To keep things neutral, both lists contain the same number of
    // distinctive terms.
    const LEFT_WORDS = new Set([
        'equity', 'inequality', 'systemic', 'inclusive', 'inclusion', 'progressive',
        'climate', 'crisis', 'green', 'renewable', 'union', 'labor', 'workers',
        'universal', 'healthcare', 'tax', 'taxes', 'taxation', 'wealth', 'redistribution',
        'diversity', 'lgbtq', 'reform', 'regulation', 'public', 'welfare',
        'socialist', 'progressive', 'left', 'liberal', 'democratic', 'grassroots',
        'organize', 'organizing', 'solidarity', 'collective', 'community', 'mutual',
        'cooperative', 'subsidy', 'affordable', 'rights', 'human', 'humanity'
    ]);
    const RIGHT_WORDS = new Set([
        'deregulation', 'sovereignty', 'traditional', 'tradition', 'freedom', 'liberty',
        'election', 'integrity', 'border', 'borders', 'security', 'military',
        'veterans', 'patriot', 'constitution', 'second', 'amendment', 'religious',
        'faith', 'family', 'values', 'conservative', 'right', 'republican',
        'free', 'market', 'capitalism', 'private', 'enterprise', 'small', 'business',
        'job', 'jobs', 'creator', 'energy', 'oil', 'gas', 'nuclear', 'fossil',
        'gun', 'guns', 'firearm', 'self-defense', 'nato', 'allies', 'stronger',
        'law', 'order', 'enforce', 'enforcement', 'back', 'blue'
    ]);
    // Tokenise text. Strip URLs, mentions, hashtags, punctuation.
    // We do NOT strip stopwords because the bias detector and the
    // sentiment analyser both rely on the raw word frequencies.
    function tokenize(text) {
        if (!text)
            return [];
        return String(text)
            .toLowerCase()
            .replace(/https?:\/\/\S+/g, ' ')
            .replace(/@\w+/g, ' ')
            .replace(/#\w+/g, ' ')
            .replace(/[^a-z0-9\s']/g, ' ')
            .split(/\s+/)
            .filter(t => t && t.length > 1);
    }
    // Split a blob of text into sentences for sentiment analysis. The
    // granularity matters for negator handling: a negator only flips
    // the polarity of words in its own sentence.
    function splitSentences(text) {
        if (!text)
            return [];
        return String(text)
            .replace(/\s+/g, ' ')
            .split(/(?<=[.!?])\s+/)
            .map(s => s.trim())
            .filter(s => s.length > 0);
    }
    // Per-sentence sentiment. Returns a number in [-5, +5] (ish). Each
    // word in the lexicon contributes its weight; negators within the
    // same sentence invert the next lexicon hit.
    function sentenceSentiment(sentence) {
        const tokens = tokenize(sentence);
        let total = 0;
        let negate = false;
        for (const tok of tokens) {
            if (NEGATORS.has(tok)) {
                negate = !negate;
                continue;
            }
            const w = SENTIMENT_LEXICON[tok];
            if (w !== undefined) {
                total += negate ? -w : w;
                negate = false; // one-shot
            }
            else if (tok.length > 3) {
                // Reset the negator if we hit a non-lexicon word, so a long
                // sentence with one "not" doesn't flip every later word.
                // Only for words >3 chars to avoid resetting on filler like
                // "to" or "of".
                negate = false;
            }
        }
        return total;
    }
    // Average sentiment of a corpus. Returns a number in roughly
    // [-5, +5]. A document with 0 sentences returns 0.
    function corpusSentiment(text) {
        const sents = splitSentences(text);
        if (!sents.length)
            return 0;
        let total = 0;
        for (const s of sents)
            total += sentenceSentiment(s);
        return total / sents.length;
    }
    // ── TF-IDF cosine similarity ──
    // Implementation: bag-of-words with TF-IDF weighting, similarity
    // = (A · B) / (||A|| · ||B||). Term frequency is log-normalised
    // and we use idf = log(N / df) with smoothing.
    function buildTfidfVectors(docs) {
        if (!docs.length)
            return { vectors: [], vocab: new Map() };
        const N = docs.length;
        const tokenized = docs.map(d => tokenize(d));
        // Document frequency
        const df = new Map();
        for (const tokens of tokenized) {
            const seen = new Set();
            for (const t of tokens) {
                if (seen.has(t))
                    continue;
                seen.add(t);
                df.set(t, (df.get(t) || 0) + 1);
            }
        }
        // IDF with smoothing
        const idf = new Map();
        for (const [term, freq] of df) {
            idf.set(term, Math.log((N + 1) / (freq + 1)) + 1);
        }
        // TF-IDF vectors as Maps (sparse)
        const vectors = tokenized.map(tokens => {
            const tf = new Map();
            for (const t of tokens)
                tf.set(t, (tf.get(t) || 0) + 1);
            const v = new Map();
            let norm = 0;
            for (const [term, count] of tf) {
                const w = (1 + Math.log(count)) * (idf.get(term) || 0);
                v.set(term, w);
                norm += w * w;
            }
            v.__norm = Math.sqrt(norm) || 1;
            return v;
        });
        return { vectors, vocab: idf, N };
    }
    function cosineSimilarity(a, b) {
        if (!a || !b)
            return 0;
        // Iterate the smaller of the two for speed
        const [small, big] = a.size <= b.size ? [a, b] : [b, a];
        let dot = 0;
        for (const [term, w] of small) {
            const w2 = big.get(term);
            if (w2 !== undefined)
                dot += w * w2;
        }
        return dot / ((a.__norm || 1) * (b.__norm || 1));
    }
    // ── Score 1: Hypocrisy ──
    // Compare the sentiment of the subject's tweets against the
    // sentiment of the articles about them. Pairs with opposing
    // sentiment (>1 polarity difference) on the same topic count
    // toward the score.
    //
    // The "topic" axis is intentionally coarse: we only check whether
    // opposing sentiment exists at all. A more sophisticated version
    // would align claims sentence-for-sentence, but at this scale
    // a coarser metric is more reliable.
    function scoreHypocrisy(articles, tweets) {
        if (!tweets || !tweets.length)
            return { score: 0, opposingPairs: 0, totalPairs: 0, reason: 'no-tweets' };
        const articleText = (articles || []).map(a => (a.title || '') + '. ' + (a.summary || '')).join(' ');
        if (!articleText.trim())
            return { score: 0, opposingPairs: 0, totalPairs: 0, reason: 'no-articles' };
        const articleSent = corpusSentiment(articleText);
        // Score each tweet individually
        let opposing = 0;
        let total = 0;
        for (const t of tweets) {
            const ts = sentenceSentiment(t.text || '');
            total++;
            // Strong opposition = one side >1, the other <-1, signs differ
            if (Math.sign(ts) !== 0 && Math.sign(articleSent) !== 0 && Math.sign(ts) !== Math.sign(articleSent)) {
                const mag = Math.min(Math.abs(ts), Math.abs(articleSent));
                if (mag >= 1)
                    opposing++;
            }
        }
        if (total === 0)
            return { score: 0, opposingPairs: 0, totalPairs: 0, reason: 'no-pairs' };
        const score = Math.round((opposing / total) * 100);
        return {
            score: Math.max(0, Math.min(100, score)),
            opposingPairs: opposing,
            totalPairs: total,
            articleSentiment: round2(articleSent),
            reason: 'ok'
        };
    }
    // ── Score 2: Relevance ──
    // TF-IDF cosine similarity of the concatenated tweet text and the
    // concatenated article text. Returns 0-100.
    function scoreRelevance(articles, tweets) {
        if (!tweets || !tweets.length)
            return { score: 0, reason: 'no-tweets' };
        const tweetText = (tweets || []).map(t => t.text || '').join(' ');
        const articleText = (articles || []).map(a => (a.title || '') + ' ' + (a.summary || '')).join(' ');
        if (!tweetText.trim() || !articleText.trim())
            return { score: 0, reason: 'no-text' };
        const { vectors } = buildTfidfVectors([tweetText, articleText]);
        const sim = cosineSimilarity(vectors[0], vectors[1]);
        // Clamp to [0, 1] just in case (cosine should already be non-negative here)
        const clamped = Math.max(0, Math.min(1, sim));
        return {
            score: Math.round(clamped * 100),
            similarity: round4(sim),
            reason: 'ok'
        };
    }
    // ── Score 3: Bias ──
    // Count left-vs-right vocabulary in the last 100 tweets (or as
    // many as we have). Whichever side is 1.5x more frequent wins;
    // otherwise "Center".
    function scoreBias(tweets) {
        if (!tweets || !tweets.length)
            return { bias: 'Center', left: 0, right: 0, reason: 'no-tweets' };
        let left = 0, right = 0;
        for (const t of tweets) {
            const tokens = tokenize(t.text || '');
            for (const tok of tokens) {
                if (LEFT_WORDS.has(tok))
                    left++;
                else if (RIGHT_WORDS.has(tok))
                    right++;
            }
        }
        let bias = 'Center';
        if (left === 0 && right === 0)
            bias = 'Center';
        else if (left > right * 1.5)
            bias = 'Left';
        else if (right > left * 1.5)
            bias = 'Right';
        return { bias, left, right, totalTweets: tweets.length, reason: 'ok' };
    }
    // ── Score 4: Factual Clarity ──
    // Look at the sources covering this subject. Each unique source
    // contributes its SOURCE_AUTHORITY weight (from analyzer.js).
    //
    // The previous formula `(sum of weights) / (max_per_source * N) * 100`
    // always returned ~83 for any subject because the median source
    // has the default weight of 1.0 and the formula treats that as
    // 1.0/1.2 of the maximum. The new formula is anchored at 50
    // (the neutral midpoint) and moves up or down based on the
    // AVERAGE authority of the unique sources:
    //
    //   score = clamp(50 + (avg_weight - 1.0) * 200, 0, 100)
    //
    //   avg=0.8 (low-tier blogs)  → 10
    //   avg=0.9 (Republic World)  → 30
    //   avg=1.0 (default source)  → 50
    //   avg=1.1 (NDTV, The Hindu) → 70
    //   avg=1.2 (Reuters, AP)     → 90
    //   avg=1.25+                 → 100
    //
    // The score reflects "how authoritative are the sources covering
    // this subject?" rather than "what fraction of the maximum
    // authority do we have?"
    //
    // To make the score meaningful even when the user has only a few
    // sources enabled, we blend two signals:
    //   1. ACTUAL coverage: average weight of sources that have
    //      actually written about this subject (from the article
    //      pool passed in).
    //   2. POTENTIAL coverage: average weight of high-authority
    //      sources from the FULL feeds.json database that COULD
    //      cover this subject based on name/category match. The
    //      user subscribes to a subset of the database; the score
    //      shouldn't drop just because the user hasn't subscribed
    //      to Reuters.
    function scoreFactualClarity(articles, opts) {
        opts = opts || {};
        if ((!articles || !articles.length) && !opts.potentialSources) {
            return { score: 0, sources: [], reason: 'no-data' };
        }
        const sourceWeights = [];
        const seen = new Set();
        // 1) ACTUAL coverage from articles.
        for (const a of (articles || [])) {
            const src = a.source || '';
            if (!src || seen.has(src))
                continue;
            seen.add(src);
            let w = 1.0;
            if (window.Analyzer && typeof Analyzer.sourceAuthorityWeight === 'function') {
                w = Analyzer.sourceAuthorityWeight(src);
            }
            sourceWeights.push({ source: src, weight: w, count: (articles || []).filter(x => x.source === src).length, type: 'actual' });
        }
        // 2) POTENTIAL coverage from the full feeds database. This
        //    pulls every source in feeds.json that could plausibly
        //    cover the subject (matched on the subject's name tokens
        //    against the source's name / region / hint). Each is
        //    added with its SOURCE_AUTHORITY weight. We only add
        //    sources that the user hasn't already seen above (no
        //    double-counting).
        if (opts.potentialSources && Array.isArray(opts.potentialSources)) {
            for (const src of opts.potentialSources) {
                if (!src || !src.name || seen.has(src.name))
                    continue;
                seen.add(src.name);
                let w = 1.0;
                if (window.Analyzer && typeof Analyzer.sourceAuthorityWeight === 'function') {
                    w = Analyzer.sourceAuthorityWeight(src.name);
                }
                sourceWeights.push({ source: src.name, weight: w, count: 0, type: 'potential' });
            }
        }
        if (!sourceWeights.length)
            return { score: 0, sources: [], reason: 'no-sources' };
        // Average weight, anchored at 50. Same formula as before.
        const avg = sourceWeights.reduce((s, x) => s + x.weight, 0) / sourceWeights.length;
        const score = Math.max(0, Math.min(100, Math.round(50 + (avg - 1.0) * 200)));
        return {
            score,
            sources: sourceWeights.sort((a, b) => b.weight - a.weight),
            actualCount: sourceWeights.filter(x => x.type === 'actual').length,
            potentialCount: sourceWeights.filter(x => x.type === 'potential').length,
            reason: 'ok'
        };
    }
    // ── Orchestrator ──
    // Find the feeds in the full database (data/feeds.json) that
    // could plausibly cover this subject. Without an LLM we can't do
    // semantic matching, so the best signal is:
    //   1. The subject's display_name tokens, against each feed's
    //      name / region / hint field (case-insensitive).
    //   2. If no tokens match (e.g. a synthesised subject we don't
    //      know about), fall back to "all top-tier sources" (weight
    //      >= 1.1) so the user still gets a meaningful score for
    //      the *ecosystem* of authoritative outlets.
    function findPotentialSources(subject, allFeeds) {
        if (!subject || !allFeeds || !Array.isArray(allFeeds))
            return [];
        const tokens = tokenize(subject.display_name || '');
        if (!tokens.length) {
            return allFeeds.filter(f => {
                if (!f.name)
                    return false;
                let w = 1.0;
                if (window.Analyzer && typeof Analyzer.sourceAuthorityWeight === 'function') {
                    w = Analyzer.sourceAuthorityWeight(f.name);
                }
                return w >= 1.1;
            });
        }
        const tokenSet = new Set(tokens);
        const matched = [];
        for (const f of allFeeds) {
            if (!f || !f.name)
                continue;
            const hay = ((f.name || '') + ' ' + (f.region || '') + ' ' + (f.hint || '')).toLowerCase();
            let hit = false;
            for (const t of tokenSet) {
                if (hay.indexOf(t) !== -1) {
                    hit = true;
                    break;
                }
            }
            if (hit)
                matched.push(f);
        }
        return matched;
    }
    // Run all four scores and return a single report object.
    //   opts = { focusTopic, allFeeds }
    function analyze({ subject, articles, tweets, opts }) {
        opts = opts || {};
        // Optional topic-focus weighting: when the user provides a focus
        // topic, weight articles that mention the topic terms more
        // heavily in the hypocrisy and relevance calculations.
        let focusedArticles = articles || [];
        if (opts.focusTopic) {
            const focusTokens = tokenize(opts.focusTopic);
            if (focusTokens.length) {
                focusedArticles = articles.filter(a => {
                    const text = ((a.title || '') + ' ' + (a.summary || '')).toLowerCase();
                    return focusTokens.some(t => text.includes(t));
                });
                if (!focusedArticles.length)
                    focusedArticles = articles;
            }
        }
        const hypocrisy = scoreHypocrisy(focusedArticles, tweets);
        const relevance = scoreRelevance(focusedArticles, tweets);
        const bias = scoreBias(tweets);
        // Pass the full feeds database into the clarity score so we can
        // include the "potential coverage" from sources the user hasn't
        // subscribed to.
        const potentialSources = opts.allFeeds
            ? findPotentialSources(subject, opts.allFeeds)
            : null;
        const clarity = scoreFactualClarity(articles, { potentialSources });
        // Top words from the tweets for the word cloud.
        const wordFreq = new Map();
        for (const t of tweets || []) {
            const toks = tokenize(t.text || '');
            for (const tk of toks) {
                if (tk.length < 4)
                    continue;
                if (SENTIMENT_LEXICON[tk])
                    continue;
                if (LEFT_WORDS.has(tk) || RIGHT_WORDS.has(tk))
                    continue;
                wordFreq.set(tk, (wordFreq.get(tk) || 0) + 1);
            }
        }
        const topWords = [...wordFreq.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 24)
            .map(([word, count]) => ({ word, count }));
        return {
            subject,
            generatedAt: Date.now(),
            focusTopic: opts.focusTopic || null,
            hypocrisy,
            relevance,
            bias,
            clarity,
            topWords,
            tweetCount: (tweets || []).length,
            articleCount: (articles || []).length
        };
    }
    function round2(n) { return Math.round(n * 100) / 100; }
    function round4(n) { return Math.round(n * 10000) / 10000; }
    return {
        analyze,
        // Exposed for testing / future use
        scoreHypocrisy,
        scoreRelevance,
        scoreBias,
        scoreFactualClarity,
        findPotentialSources,
        corpusSentiment,
        sentenceSentiment,
        buildTfidfVectors,
        cosineSimilarity,
        tokenize,
        SENTIMENT_LEXICON,
        LEFT_WORDS,
        RIGHT_WORDS
    };
})();
// Expose on window — see js/feeds.js for the rationale.
window.ScoringEngine = ScoringEngine;
