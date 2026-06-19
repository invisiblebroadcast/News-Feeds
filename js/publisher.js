// Publisher — generates a coherent article from a cluster of
// stories covering the same topic.
//
// The user explicitly does NOT want a direct copy-paste of any
// single source's title or summary. The output is a fresh
// composition: a topic label, a short framed intro, and 2–4
// body sentences, each attributed to one of the covering
// sources. No LLM, no AI — pure deterministic selection +
// templates + (when available) TF.js Universal Sentence Encoder
// to pick the most central sentences.
//
// Pipeline:
//   1. Collect every sentence from every article in the cluster.
//   2. Score every sentence:
//        centrality = similarity to the cluster centroid
//                     (average of all sentence embeddings)
//        novelty   = 1 - max similarity to already-picked
//                     sentences (so we don't repeat ourselves)
//        score     = 0.7 * centrality + 0.3 * novelty
//      This is a TextRank-lite with USE embeddings, plus a
//      MMR-style novelty term to keep the body diverse.
//   3. Pick the top-N sentences, in original order, with each
//      sentence attributed to its source article.
//   4. Frame the body with templates: a lead sentence that
//      summarises the cluster topic, the picked sentences, and
//      a closing line.
//   5. The headline is the cluster's topic label (already
//      derived by Clustering.deriveTopicLabel).

const Publisher = (() => {
  // Split a string into sentences. Treats ".", "!", "?" as
  // terminators and keeps non-empty trimmed pieces.
  function splitSentences(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  // Strip HTML / decode entities from a string. Lightweight —
  // mirrors what cleanSummary does in app.js, duplicated here
  // so the publisher has no app.js dependency.
  function cleanText(s) {
    return String(s || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Compress a single sentence: trim, cap, add ellipsis.
  function capLen(s, max) {
    if (!s) return '';
    if (s.length <= max) return s;
    const slice = s.slice(0, max);
    const lastSpace = slice.lastIndexOf(' ');
    const cut = lastSpace > 40 ? slice.slice(0, lastSpace) : slice;
    return cut.trim() + '…';
  }

  // Pick the most central + diverse sentences from a cluster,
  // using USE embeddings if available. Falls back to TF-IDF
  // word-frequency centrality if USE isn't ready yet.
  async function pickKeySentences(cluster) {
    // Collect every sentence with its source article.
    const all = [];
    for (const a of cluster.articles) {
      const title = cleanText(a.title);
      const summary = cleanText(a.summary);
      const sentences = [
        ...splitSentences(title),
        ...splitSentences(summary)
      ];
      for (const s of sentences) {
        if (s.length < 20) continue;          // skip fragments
        if (s.length > 400) continue;         // skip walls of text
        all.push({ text: s, article: a });
      }
    }
    if (!all.length) return [];

    const useReady = window.Embeddings && Embeddings.isReady && Embeddings.isReady();

    if (useReady) {
      return pickByUse(all, cluster);
    }
    return pickByTfidf(all);
  }

  // USE-based picker: compute the centroid of all sentence
  // embeddings, then greedily pick the most-central sentence
  // that is also maximally novel (lowest similarity to
  // already-picked sentences). This is MMR-lite.
  async function pickByUse(all, cluster) {
    const texts = all.map(x => x.text);
    const embeddings = await Embeddings.embedBatch(texts);
    if (!embeddings || embeddings.length !== texts.length) {
      return pickByTfidf(all);
    }
    // Centroid.
    const dim = embeddings[0].length;
    const centroid = new Array(dim).fill(0);
    for (const v of embeddings) for (let i = 0; i < dim; i++) centroid[i] += v[i];
    for (let i = 0; i < dim; i++) centroid[i] /= embeddings.length;

    const N = all.length;
    const centrality = embeddings.map(v => Embeddings.cosineSimilarity(v, centroid));

    const PICK_COUNT = 4;
    const picked = [];
    const pickedIdx = new Set();
    const pickedEmbeds = [];

    for (let p = 0; p < PICK_COUNT && picked.length < N; p++) {
      let bestIdx = -1, bestScore = -Infinity;
      for (let i = 0; i < N; i++) {
        if (pickedIdx.has(i)) continue;
        let novelty = 1;
        if (pickedEmbeds.length) {
          let maxSim = 0;
          for (const pe of pickedEmbeds) {
            const s = Embeddings.cosineSimilarity(embeddings[i], pe);
            if (s > maxSim) maxSim = s;
          }
          novelty = 1 - maxSim;
        }
        const score = 0.7 * centrality[i] + 0.3 * novelty;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
      if (bestIdx < 0) break;
      pickedIdx.add(bestIdx);
      picked.push(all[bestIdx]);
      pickedEmbeds.push(embeddings[bestIdx]);
    }
    // Restore original order so the body reads naturally.
    picked.sort((a, b) => all.indexOf(a) - all.indexOf(b));
    return picked;
  }

  // TF-IDF fallback. Word-frequency centrality, just like
  // the old share-caption pipeline.
  function pickByTfidf(all) {
    const STOPWORDS = new Set((
      'a an the and or but if then else when while of in on at to for from by with as is are was were be been being do does did has have had this that these those it its their there here all any some no not so very just can could may might will would shall should into about over under between through during before after above below up down out off again further once upon without within along across behind beyond despite except like near per via says said reports'
    ).split(/\s+/));

    const wordFreq = {};
    for (const x of all) {
      for (const w of x.text.toLowerCase().split(/[^a-z0-9]+/)) {
        if (!w || w.length < 4 || STOPWORDS.has(w)) continue;
        wordFreq[w] = (wordFreq[w] || 0) + 1;
      }
    }

    function scoreSentence(text) {
      const words = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      if (!words.length) return 0;
      let s = 0;
      for (const w of words) {
        if (STOPWORDS.has(w) || w.length < 4) continue;
        s += wordFreq[w] || 0;
      }
      return s / Math.sqrt(words.length);
    }

    const scored = all.map((x, i) => ({ x, i, s: scoreSentence(x.text) }));
    scored.sort((a, b) => b.s - a.s);
    const PICK_COUNT = 4;
    const picked = scored.slice(0, PICK_COUNT).sort((a, b) => a.i - b.i).map(x => x.x);
    return picked;
  }

  // ── Title generation ──
  // The headline is built from a pool of templates that each
  // frame the cluster's topic slightly differently. We pick
  // one at random per build so consecutive regenerations feel
  // fresh (the user asked for the title to be regenerative,
  // not just re-derived from the same keywords).
  const TITLE_TEMPLATES = [
    s => `What we know about ${s.topic}`,
    s => `${s.topic}: a developing story`,
    s => `The latest on ${s.topic}`,
    s => `${s.topic} — coverage roundup`,
    s => `Why ${s.topic} is in the news`,
    s => `Inside the ${s.topic} story`,
    s => `${s.topic}, explained`,
    s => `${s.topic}: what ${s.n} outlets are reporting`,
    s => `The story behind ${s.topic}`,
    s => `${s.topic} in brief`,
    s => `How ${s.topic} unfolded`,
    s => `${s.topic}: the key details`
  ];
  function buildTitle(cluster) {
    const topic = cluster.topic || 'this story';
    const n = cluster.sourceCount || (cluster.sources || []).length || 1;
    const tpl = TITLE_TEMPLATES[Math.floor(Math.random() * TITLE_TEMPLATES.length)];
    return tpl({ topic, n });
  }

  // ── Lead / closing sentence pools ──
  // Single-sentence framings, picked at random so each
  // regeneration produces a slightly different intro/outro.
  const LEAD_TEMPLATES = [
    s => `Multiple outlets are covering ${s.topic}. Here's the picture so far.`,
    s => `${s.topic} has been drawing coverage across ${s.n} source${s.n === 1 ? '' : 's'}.`,
    s => `Here's what's known about ${s.topic} as reporting develops.`,
    s => `${s.topic} is in the news. The story, so far, is this.`,
    s => `A roundup of reporting on ${s.topic}, based on ${s.n} outlet${s.n === 1 ? '' : 's'}.`
  ];
  const CLOSING_TEMPLATES = [
    s => `Coverage is ongoing; expect further updates.`,
    s => `This is a developing story.`,
    s => `More reporting is expected in the coming hours.`,
    s => `The situation remains fluid.`,
    s => `Additional details are likely to emerge.`
  ];
  function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // Build the article. Returns:
  //   {
  //     headline,        — generative title (varies per build)
  //     lead,            — single intro sentence
  //     body,            — single cohesive paragraph (2–3 sentences
  //                        joined with light transitions, NO inline
  //                        source attribution)
  //     closing,         — single outro sentence
  //     sources,         — array of { name, title, link } for the
  //                        sources section at the bottom
  //     cluster
  //   }
  //
  // The user's brief: "Collectively one description. Sources can
  // be mentioned at the later half of the page with links." So
  // the body is a single flowing paragraph, NOT a list of
  // attributed sentences. Sources live in a dedicated section
  // below the body with the original article title + source
  // name + clickable link.
  async function buildArticle(cluster) {
    if (!cluster || !cluster.articles || !cluster.articles.length) {
      return { headline: '', lead: '', body: '', closing: '', sources: [], cluster };
    }

    const topic = cluster.topic || 'this story';
    const n = cluster.sourceCount || (cluster.sources || []).length || 1;

    const lead = pickRandom(LEAD_TEMPLATES)({ topic, n });
    const closing = pickRandom(CLOSING_TEMPLATES)({ topic, n });

    // Pick 2–3 central, diverse sentences. Fewer than the old
    // 4-sentence output because the body is now ONE paragraph
    // and we want it tight, not a wall of text.
    let picked = await pickKeySentences(cluster);
    if (picked.length > 3) picked = picked.slice(0, 3);
    if (picked.length < 1) picked = picked; // keep empty

    // Stitch the picked sentences into a single flowing
    // paragraph. We cap each sentence to keep the total under
    // ~600 chars (a comfortable read), join with a single
    // space (they already end with sentence-final punctuation),
    // and skip any that turn out to be empty after cleaning.
    const sentences = picked
      .map(x => capLen(x.text, 220))
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const body = sentences.join(' ');

    // Sources section. We use the cluster's actual articles
    // (not just the unique source names) so the user can see
    // which specific piece ran where, and click through.
    const sources = (cluster.articles || []).map(a => ({
      name: a.source || 'Unknown',
      title: a.title || a.link || 'Untitled',
      link: a.link || '',
      pubDate: a.pubDate || ''
    })).filter(s => s.link);

    return {
      headline: buildTitle(cluster),
      lead,
      body,
      closing,
      sources,
      cluster
    };
  }

  return { buildArticle, splitSentences, cleanText };
})();

window.Publisher = Publisher;
