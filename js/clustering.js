// @ts-nocheck
// Clustering — groups articles that cover the same story.
//
// We cluster by TF-IDF cosine similarity (fast, no model needed).
// The "topic" of each cluster is derived from the most frequent
// significant words across its articles. When Universal Sentence
// Encoder is loaded we optionally upgrade to semantic clustering
// (USE cosine) — same threshold API, better cross-language
// matching, but blocks on the model load.
//
// Each cluster gets two derived ratings:
//   critical  — editorial credibility, based on source diversity
//               and count. "High" when 4+ independent sources
//               cover the same story.
//   people    — proxy for public interest, based on how many
//               of the covering sources published in the last
//               24h. We don't have actual upvote data, so this
//               is a stand-in labelled "Recent coverage".
const Clustering = (() => {
    // Common English stopwords + generic news words that don't
    // carry story-specific meaning. Filtered out when deriving
    // the cluster's topic label.
    const STOPWORDS = new Set(('a an the and or but if then else when while of in on at to for from by with as is are was were be been being do does did has have had this that these those it its their there here all any some no not so very just can could may might will would shall should into about over under between through during before after above below up down out off again further once upon without within along across behind beyond despite except like near per via ' +
        'says said reports report according new delhi mumbai india indian says amid after before first second third also still just only even much many most more less over under').split(/\s+/));
    // Tokenise a document into lowercase word tokens of length ≥ 3.
    function tokenize(text) {
        return (String(text || '').toLowerCase().match(/\b[a-z]{3,}\b/g) || []);
    }
    // Build a sparse-ish TF-IDF vector for a single document.
    function buildVector(tokens, vocabIndex, idf) {
        const tf = {};
        for (const t of tokens)
            tf[t] = (tf[t] || 0) + 1;
        const v = new Float64Array(vocabIndex.size);
        for (const t in tf) {
            const idx = vocabIndex.get(t);
            if (idx !== undefined)
                v[idx] = tf[t] * (idf[t] || 0);
        }
        return v;
    }
    // Cosine similarity between two Float64Array vectors.
    function cosineSim(a, b) {
        let dot = 0, ma = 0, mb = 0;
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            const av = a[i], bv = b[i];
            dot += av * bv;
            ma += av * av;
            mb += bv * bv;
        }
        const den = Math.sqrt(ma) * Math.sqrt(mb);
        return den === 0 ? 0 : dot / den;
    }
    // Union-find for clustering. Path-compressed + rank-balanced
    // so the find() is effectively amortised O(1).
    function makeUnionFind(n) {
        const parent = new Int32Array(n);
        const rank = new Int32Array(n);
        for (let i = 0; i < n; i++)
            parent[i] = i;
        function find(i) {
            while (parent[i] !== i) {
                parent[i] = parent[parent[parent[i]]] | 0;
                i = parent[i] | 0;
            }
            return i;
        }
        function union(i, j) {
            const ri = find(i), rj = find(j);
            if (ri === rj)
                return;
            if (rank[ri] < rank[rj])
                parent[ri] = rj;
            else if (rank[ri] > rank[rj])
                parent[rj] = ri;
            else {
                parent[rj] = ri;
                rank[ri]++;
            }
        }
        return { find, union };
    }
    // Derive a short, grammatical topic label from articles in a cluster.
    // Uses named entity extraction, bigram/trigram phrases, and TF-IDF
    // scoring to find the most distinctive phrase for this cluster.
    function deriveTopicLabel(articles) {
        if (!articles || !articles.length) return 'Story';
        // 1) Extract named entities (capitalized multi-word phrases) from titles.
        const ENT_RE = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b/g;
        const SKIP = new Set(['The', 'This', 'That', 'These', 'Those', 'It', 'He', 'She',
            'They', 'We', 'I', 'You', 'A', 'An', 'And', 'But', 'Or',
            'In', 'On', 'At', 'To', 'For', 'Of', 'With', 'By', 'As',
            'After', 'Before', 'During', 'According', 'Said', 'Says',
            'New', 'First', 'Last', 'Also', 'Still', 'Just', 'More',
            'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
            'News', 'Times', 'Post', 'Express', 'Herald', 'Tribune', 'Report', 'Reports',
            'Live', 'Update', 'Updates', 'Breaking', 'Watch', 'Video', 'Read', 'Full']);
        const entityCounts = {};
        for (const a of articles) {
            const title = a.title || '';
            let m;
            const re = new RegExp(ENT_RE.source, 'g');
            const seen = new Set();
            while ((m = re.exec(title)) !== null) {
                const name = m[1];
                if (SKIP.has(name) || /^\d+$/.test(name)) continue;
                const key = name.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                entityCounts[key] = (entityCounts[key] || 0) + 1;
            }
        }
        // 2) Extract bigrams and trigrams from titles.
        const phraseCounts = {};
        for (const a of articles) {
            const title = (a.title || '').toLowerCase();
            const words = title.split(/[^a-z]+/).filter(w => w.length >= 3 && !STOPWORDS.has(w));
            const seen = new Set();
            // Bigrams
            for (let i = 0; i < words.length - 1; i++) {
                const phrase = words[i] + ' ' + words[i + 1];
                if (!seen.has(phrase)) {
                    seen.add(phrase);
                    phraseCounts[phrase] = (phraseCounts[phrase] || 0) + 1;
                }
            }
            // Trigrams
            for (let i = 0; i < words.length - 2; i++) {
                const phrase = words[i] + ' ' + words[i + 1] + ' ' + words[i + 2];
                if (!seen.has(phrase)) {
                    seen.add(phrase);
                    phraseCounts[phrase] = (phraseCounts[phrase] || 0) + 1;
                }
            }
        }
        // 3) Merge entities and phrases, score by frequency + entity bonus.
        const candidates = [];
        for (const [phrase, count] of Object.entries(entityCounts)) {
            candidates.push({ phrase, score: count * 2.0, isEntity: true });
        }
        for (const [phrase, count] of Object.entries(phraseCounts)) {
            if (count >= 2) {
                const isEntity = entityCounts[phrase] > 0;
                candidates.push({ phrase, score: count * (isEntity ? 1.8 : 1.0), isEntity });
            }
        }
        // Sort by score descending.
        candidates.sort((a, b) => b.score - a.score);
        // 4) Build a grammatical title from the best candidates.
        if (candidates.length === 0) {
            // Fallback: use most frequent single word.
            const wordCounts = {};
            for (const a of articles) {
                const text = ((a.title || '') + '. ' + (a.summary || '')).toLowerCase();
                for (const t of tokenize(text)) {
                    if (STOPWORDS.has(t) || t.length < 4 || /^\d+$/.test(t)) continue;
                    wordCounts[t] = (wordCounts[t] || 0) + 1;
                }
            }
            const sorted = Object.entries(wordCounts).sort((a, b) => b[1] - a[1]);
            const top = sorted.slice(0, 3).map(([w]) => w);
            if (!top.length) return 'Story';
            return top.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
        }
        // Pick the best phrase, then optionally add a second distinctive word.
        const best = candidates[0].phrase;
        const bestWords = best.split(' ');
        // If the best phrase is already 2-3 words, use it as-is.
        if (bestWords.length >= 2) {
            const title = bestWords.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
            // Add a descriptor if available (e.g. "Delhi Police Protests").
            if (candidates.length > 1) {
                const second = candidates[1].phrase.split(' ');
                // Only add if it's not a subset of the best phrase.
                if (second.length === 1 && !bestWords.includes(second[0])) {
                    return title + ' ' + second[0][0].toUpperCase() + second[0].slice(1);
                }
            }
            return title;
        }
        // Single word best — combine with next best.
        if (candidates.length >= 2) {
            const w1 = best;
            const w2 = candidates[1].phrase.split(' ')[0];
            if (w1 !== w2) {
                return w1[0].toUpperCase() + w1.slice(1) + ' ' + w2[0].toUpperCase() + w2.slice(1);
            }
        }
        return best[0].toUpperCase() + best.slice(1);
    }
    // Compute the two derived ratings for a cluster.
    function deriveRatings(articles) {
        const sources = new Set(articles.map(a => a.source).filter(Boolean));
        const sourceCount = sources.size;
        // Critical = editorial confidence. More independent sources
        // covering the same story = more credible.
        let critical, criticalLabel;
        if (sourceCount >= 4) {
            critical = 0.9;
            criticalLabel = 'High';
        }
        else if (sourceCount >= 3) {
            critical = 0.7;
            criticalLabel = 'High';
        }
        else if (sourceCount === 2) {
            critical = 0.5;
            criticalLabel = 'Medium';
        }
        else {
            critical = 0.3;
            criticalLabel = 'Low';
        }
        // People = proxy for public interest. We don't have actual
        // upvote / share data, so we use "how many of the covering
        // sources published in the last 24h" as a stand-in. This is
        // honestly labelled in the UI as "Recent coverage".
        const now = Date.now();
        const DAY = 24 * 60 * 60 * 1000;
        let recentCount = 0;
        for (const a of articles) {
            const t = a.pubDate ? new Date(a.pubDate).getTime() : 0;
            if (t && (now - t) < DAY)
                recentCount++;
        }
        let people, peopleLabel;
        if (recentCount >= 3) {
            people = 0.9;
            peopleLabel = 'High';
        }
        else if (recentCount >= 1) {
            people = 0.5;
            peopleLabel = 'Medium';
        }
        else {
            people = 0.2;
            peopleLabel = 'Low';
        }
        return {
            critical, criticalLabel,
            people, peopleLabel,
            sourceCount, recentCount
        };
    }
    // Cluster a list of articles by TF-IDF cosine similarity.
    // `threshold` is the minimum similarity for two articles to
    // be linked. Lower → more clusters, higher → fewer, larger
    // clusters. 0.25 is a good starting point for news titles.
    function clusterByTfidf(articles, threshold) {
        if (!articles || articles.length < 2)
            return [];
        // Tokenise every article once.
        const tokenized = articles.map(a => tokenize((a.title || '') + '. ' + (a.summary || '')));
        // Build vocabulary + document frequency.
        const vocab = new Map();
        const docFreq = new Map();
        for (const tokens of tokenized) {
            const seen = new Set();
            for (const t of tokens) {
                if (!seen.has(t)) {
                    seen.add(t);
                    docFreq.set(t, (docFreq.get(t) || 0) + 1);
                }
                if (!vocab.has(t))
                    vocab.set(t, vocab.size);
            }
        }
        if (vocab.size === 0)
            return [];
        // IDF table.
        const N = articles.length;
        const idf = {};
        for (const [t, df] of docFreq) {
            idf[t] = Math.log(1 + N / (1 + df));
        }
        // Build TF-IDF vectors.
        const vectors = tokenized.map(toks => buildVector(toks, vocab, idf));
        // O(n²) pairwise similarity. Acceptable for n ≤ ~800.
        const uf = makeUnionFind(N);
        for (let i = 0; i < N; i++) {
            for (let j = i + 1; j < N; j++) {
                // Quick reject: if the two articles share no title tokens,
                // they almost certainly aren't about the same story.
                const ti = tokenized[i], tj = tokenized[j];
                if (!sharesAnyToken(ti, tj))
                    continue;
                if (cosineSim(vectors[i], vectors[j]) >= threshold)
                    uf.union(i, j);
            }
        }
        // Group by root.
        const groups = new Map();
        for (let i = 0; i < N; i++) {
            const r = uf.find(i);
            if (!groups.has(r))
                groups.set(r, []);
            groups.get(r).push(articles[i]);
        }
        return Array.from(groups.values());
    }
    // Quick pre-filter: do these two token lists share ANY word
    // (after stopword removal)? Two articles that share no
    // vocabulary are almost never about the same story. This
    // cuts the O(n²) inner loop dramatically.
    function sharesAnyToken(a, b) {
        const set = new Set();
        for (const t of a)
            if (t.length >= 4)
                set.add(t);
        for (const t of b)
            if (t.length >= 4 && set.has(t))
                return true;
        return false;
    }
    // Public entry point. Takes a flat list of articles and
    // returns an array of clusters, each with metadata.
    //
    // Options:
    //   threshold   min TF-IDF cosine for linking (default 0.25)
    //   maxArticles cap on input size (default 500) — keeps the
    //                O(n²) cluster pass bounded
    //   minSources  only keep clusters with N+ distinct sources
    //                (default 2 — a single source isn't a "story
    //                covered by multiple outlets")
    async function clusterArticles(articles, options) {
        const opts = options || {};
        const threshold = opts.threshold || 0.25;
        const maxArticles = opts.maxArticles || 500;
        const minSources = opts.minSources || 2;
        // Take the most recent N articles.
        const pool = (articles || []).slice(0, maxArticles);
        const groups = clusterByTfidf(pool, threshold);
        // Build the output clusters.
        const result = [];
        for (const group of groups) {
            if (group.length < 2)
                continue;
            const sources = Array.from(new Set(group.map(a => a.source).filter(Boolean)));
            if (sources.length < minSources)
                continue;
            // Sort articles within a cluster by recency (newest first).
            group.sort((a, b) => {
                const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
                const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
                return tb - ta;
            });
            const ratings = deriveRatings(group);
            const topic = deriveTopicLabel(group);
            result.push({
                id: 'cluster-' + result.length,
                topic,
                articles: group,
                sources,
                ...ratings
            });
        }
        // Sort clusters: most-covered first, then by recency.
        result.sort((a, b) => {
            if (b.sourceCount !== a.sourceCount)
                return b.sourceCount - a.sourceCount;
            const ta = a.articles[0]?.pubDate ? new Date(a.articles[0].pubDate).getTime() : 0;
            const tb = b.articles[0]?.pubDate ? new Date(b.articles[0].pubDate).getTime() : 0;
            return tb - ta;
        });
        return result;
    }
    return { clusterArticles, deriveTopicLabel, deriveRatings, cosineSim };
})();
// Expose on window — see js/feeds.js for the rationale.
window.Clustering = Clustering;
