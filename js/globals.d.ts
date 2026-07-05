// ── Global module declarations ──

interface Article {
  title?: string;
  link?: string;
  summary?: string;
  pubDate?: string;
  author?: string;
  imageUrl?: string;
  source?: string;
  feedUrl?: string;
  feedHint?: string;
  guid?: string;
  subcat?: string;
  _rank?: number;
  _trendingKeywords?: string[];
  _trendingCount?: number;
  _trendingScore?: number;
  _conflicts?: {
    isConflicting: boolean;
    clusterSize?: number;
    severity?: number;
    conflicts?: Array<{
      metric: string;
      detail?: Array<{ value: string; articles?: Array<{ source?: string; link?: string; title?: string }> }>;
    }>;
  };
  _tx?: { importance?: number; benefit?: number };
  subject?: { id?: string; display_name?: string };
}

interface Feed {
  name: string;
  url: string;
  hint?: string;
  lang?: string;
  _parliament?: boolean;
  region?: string;
}

interface FeedData {
  subcategories?: string[];
  nations?: Record<string, { label?: string }>;
  subscribableFeeds?: Array<{
    name: string;
    url: string;
    hasRss?: boolean;
    hint?: string;
    lang?: string;
    scope?: string;
    nation?: string;
    region?: string;
  }>;
  parliamentFeeds?: any;
}

interface CustomFeed {
  name: string;
  url: string;
  scope?: string;
  nation?: string;
  subcat?: string;
  lang?: string;
}

interface ModalStackEntry {
  name: string;
  el?: HTMLElement;
  onClose?: () => void;
  frameId: number;
  isRoot: boolean;
}

interface SubViewStackEntry {
  name: string;
  onClose?: () => void;
  frameId: number;
  isRoot: boolean;
}

interface GroupCache {
  articles?: Article[];
  groups?: Record<string, Article[]>;
}

interface ScopeCache {
  [key: string]: GroupCache | undefined;
}

interface AppStateExposed {
  scopeCache: ScopeCache;
  currentMode: string;
  currentScope: string;
  currentNation: string;
  currentSubcat: string;
  currentSection?: string;
  currentUser?: any;
  openModal: (name: string, modalEl: HTMLElement | null, onClose?: () => void) => void;
  closeModal: (name: string) => void;
  pushFrame: (id: number) => void;
  pushState: (state: any) => void;
  dropPushedFrame: (id: number) => void;
  popIsInFlight: () => boolean;
  nextFrameId: number;
}

interface ConflictMapEntry {
  isConflicting: boolean;
  clusterSize?: number;
  severity?: number;
  conflicts?: Array<{
    metric: string;
    subject?: string;
    detail?: Array<{ value: string; articles?: Array<{ source?: string; link?: string; title?: string }> }>;
  }>;
}

interface AnalysisResult {
  subject: any;
  generatedAt: number;
  focusTopic: string | null;
  hypocrisy: { score: number; opposingPairs: number; totalPairs: number; reason: string; articleSentiment?: number };
  relevance: { score: number; reason: string; similarity?: number };
  bias: { bias: string; left: number; right: number; totalTweets?: number; reason: string };
  clarity: { score: number; sources: Array<any>; actualCount?: number; potentialCount?: number; reason: string };
  topWords: Array<{ word: string; count: number }>;
  tweetCount: number;
  articleCount: number;
}

interface Window {
  Settings: {
    load(): any;
    save(settings: any): void;
    get(key: string): any;
    set(key: string, value: any): void;
    reset(): void;
    LANGUAGES: Record<string, string>;
  };

  SourceHealth: {
    FAILURE_THRESHOLD: number;
    WARN_AT: number;
    get(url: string): any;
    isDisabled(url: string): boolean;
    isRefused(url: string): boolean;
    getFailureCount(url: string): number;
    getTrackedSources(): Array<any>;
    getVisibleSources(): Array<any>;
    recordSuccess(url: string): void;
    recordFailure(url: string, err?: Error): void;
    reEnable(url: string): void;
    reEnableAll(): number;
    reset(url: string): void;
    resetAll(): void;
    syncDisabledState(): void;
    onChange(fn: (evt: any) => void): () => void;
  };

  SupabaseStore: {
    load(): Promise<any>;
    get(link: string): any;
    set(link: string, value: any): Promise<void>;
    getAll(): any;
    getClient(): any;
  };

  FeedManager: {
    load(): Promise<FeedData>;
    subcategories(): string[];
    subcategoriesForScope(scope: string): string[];
    subcatLabel(cat: string, scope?: string): string;
    subcatIcon(cat: string): string;
    getNations(): Record<string, string>;
    defaultNation(): string;
    getSelectedNation(): string;
    setSelectedNation(nation: string): void;
    getFeeds(scope: string, nation?: string | null): Array<{ name: string; url: string; hint: string; lang: string }>;
    getFeedsBySubcat(scope: string, nation?: string | null): Record<string, Array<any>>;
    getCustomFeeds(): CustomFeed[];
    addCustomFeed(name: string, url: string, scope?: string, nation?: string, subcat?: string, lang?: string): Promise<void>;
    removeCustomFeed(url: string): Promise<void>;
    loadCustomFeeds(): Promise<CustomFeed[]>;
    syncCustomFeedsOnSignIn(): Promise<void>;
    validateFeed(url: string): Promise<{ valid: boolean; title?: string; count?: number; error?: string }>;
    getSubscribableFeeds(): Array<any>;
    getSubscribedFeeds(): string[];
    saveSubscribedFeeds(urls: string[]): void;
    isSubscribed(url: string): boolean;
    toggleSubscription(url: string): string[];
    getParliamentFeeds(): any;
    getParliamentItemById(id: string): any;
    parliamentItemToFeed(item: any): Feed | null;
    getFeedsForSubcat(scope: string, nation: string | null, subcat: string): Array<any>;
  };

  FeedFetcher: {
    fetchFeed(feed: Feed, perSourceCap?: number): Promise<Article[]>;
    fetchCategory(category: string, feeds: Feed[], skipDedup?: boolean): Promise<Article[]>;
    filterByDate(articles: Article[], dateFrom?: string, dateTo?: string): Article[];
    deduplicate(articles: Article[]): Article[];
    sortByDate(articles: Article[]): Article[];
  };

  AI: {
    tokenize(text: string): string[];
    stripHtml(html: string): string;
    formatDateShort(d: string | number | Date): string;
    todayStr(): string;
    yesterdayStr(): string;
    detectConflicts(articles: Article[]): Map<string, ConflictMapEntry>;
    computeTrendingInfo(articles: Article[], fullCorpus: Article[]): void;
  };

  Analyzer: {
    SOURCE_AUTHORITY: Record<string, number>;
    ALARMING_HINTS: Record<string, number>;
    sourceAuthorityWeight(source: string): number;
    clusterByTitle(articles: Article[], threshold?: number): Article[][];
    extractFacts(text: string): Record<string, Array<{ value: string; context: string }>>;
    extractClaims(text: string): Array<any>;
    detectClaimConflicts(articles: Article[], threshold?: number): Map<string, ConflictMapEntry>;
    detectConflicts(articles: Article[], threshold?: number): Map<string, ConflictMapEntry>;
    detectNumericConflicts(articles: Article[], threshold?: number): Map<string, ConflictMapEntry>;
    formatConflictSummary(conflict: any): string;
    normalizeValue(raw: any): string;
    computeSeverity(conflict: any): number;
    severityBucket(score: number): string;
    rankByAnalyzer(articles: Article[], engagement?: Record<string, any>): Array<{ article: Article; score: number }>;
  };

  ArticleArchive: {
    load(): Promise<void>;
    ingest(article: Article, lang?: string): void;
    getSeenCount(url: string): number;
    getSubjectArticles(subject: string): Article[];
    getArticlesForFeeds(feedUrls: string[]): Article[];
    getAll(): Article[];
    lookupLang(feedUrl: string): string | null;
  };

  ScoringEngine: {
    analyze(args: { subject: any; articles: Article[]; tweets: Array<{ text: string }>; opts?: any }): AnalysisResult;
    scoreHypocrisy(articles: Article[], tweets: Array<{ text: string }>): any;
    scoreRelevance(articles: Article[], tweets: Array<{ text: string }>): any;
    scoreBias(tweets: Array<{ text: string }>): any;
    scoreFactualClarity(articles: Article[], opts?: any): any;
    findPotentialSources(subject: any, allFeeds: Array<any>): Array<any>;
    corpusSentiment(text: string): number;
    sentenceSentiment(sentence: string): number;
    buildTfidfVectors(docs: string[]): { vectors: Array<any>; vocab: Map<string, number> };
    cosineSimilarity(a: any, b: any): number;
    tokenize(text: string): string[];
    SENTIMENT_LEXICON: Record<string, number>;
    LEFT_WORDS: Set<string>;
    RIGHT_WORDS: Set<string>;
  };

  AppState: {
    load(): any;
    save(partial: any): void;
    get(key: string): any;
    set(key: string, value: any): void;
    clear(): void;
    DEFAULTS: Record<string, any>;
  };

  AnalyzeModal: {
    open(article?: Article): void;
    close(): void;
    openDashboard(subject: any): void;
    closeDashboard(): void;
    isOpen(): boolean;
  };

  CategoriesModal: {
    open(): void;
  };

  FilterModal: {
    open(): void;
    getFilters(): { dateFrom?: string; dateTo?: string; sources?: string[] };
  };

  Publisher: {
    publish(title: string, desc: string, ytUrl: string, githubOwner: string, githubRepo: string, githubToken: string): Promise<void>;
    listPosts(githubOwner: string, githubRepo: string, githubToken: string): Promise<Array<any>>;
  };

  Translator: {
    translate(text: string, targetLang: string): Promise<string>;
  };

  Subjects: {
    find(query: string): Promise<Array<any>>;
    getRegistered(): Array<any>;
  };

  ClusteringEngine: {
    cluster(articles: Article[]): Array<Array<Article>>;
  };

  Embeddings: {
    compute(texts: string[]): Promise<Array<Float32Array>>;
    similarity(a: Float32Array, b: Float32Array): number;
  };

  appState?: AppStateExposed;
  onSignIn?: () => void;
  tf?: any;
  html2canvas?: any;
  supabase?: any;
}


