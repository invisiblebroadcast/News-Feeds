// Track per-RSS-source health (consecutive failure counts + manually-disabled flag).
//
// A "failure" is a single fetch attempt that returned 0 articles (network
// error, parse error, empty XML, etc.). When a source accumulates
// FAILURE_THRESHOLD consecutive failures AND the user has turned on the
// "Auto-disable failing sources" toggle in Settings, we flag it as
// disabled and skip it in subsequent fetches — so one dead RSS feed can
// no longer hold up the whole "Fetching N sources…" spinner.
//
// The user can re-enable disabled sources from:
//   1. Settings → Feed Health → "Re-enable all" (clears every flag).
//   2. Activity → Failed sources tab → per-source "Re-enable" button.
//
// We persist the map of { url: { failures, lastError, lastFailureAt,
// disabled, lastSuccessAt } } in localStorage so the count survives
// page reloads — otherwise a flaky feed that fails twice before the
// user opens the app would never trip the threshold.

const SourceHealth = (() => {
  const STORAGE_KEY = 'newsfeeds_source_health';
  const FAILURE_THRESHOLD = 5;
  // Treat a source as "in trouble" (and show it under Failed sources in
  // Settings/Activity) once it has at least this many consecutive
  // failures, even if it hasn't yet been auto-disabled. This lets the
  // user see the buildup before the threshold is reached.
  const WARN_AT = 2;

  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
  }

  function save(map) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); }
    catch {}
  }

  function get(url) {
    const map = load();
    return map[url] || null;
  }

  // Hooks the Settings page can install so we can react to changes
  // (e.g. when the user toggles "Auto-disable", invalidate the
  // currently-fetching scope so the change takes effect immediately).
  const listeners = new Set();
  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit(evt) { for (const fn of listeners) { try { fn(evt); } catch {} } }

  function recordSuccess(url) {
    if (!url) return;
    const map = load();
    const prev = map[url] || {};
    map[url] = {
      ...prev,
      failures: 0,
      lastSuccessAt: Date.now(),
      lastError: ''
    };
    save(map);
    emit({ type: 'success', url, state: map[url] });
  }

  function recordFailure(url, err) {
    if (!url) return;
    const map = load();
    const prev = map[url] || {};
    const failures = (prev.failures || 0) + 1;
    map[url] = {
      ...prev,
      failures,
      lastError: (err && err.message) ? String(err.message).slice(0, 240) : 'Unknown error',
      lastFailureAt: Date.now()
    };
    // Auto-disable when the user has the toggle on and the threshold is
    // hit. The toggle check happens here (not in recordFailure) so that
    // when the user FLIPS the toggle on after a few failures have
    // already accumulated, we still trip immediately.
    if (Settings && Settings.get && Settings.get('autoDisableFailingSources') && failures >= FAILURE_THRESHOLD) {
      map[url].disabled = true;
    }
    save(map);
    emit({ type: 'failure', url, state: map[url] });
  }

  // Re-evaluate the `disabled` flag for every tracked source against
  // the current auto-disable setting. Called when the user toggles the
  // setting in the UI so that flipping it ON immediately disables any
  // source that's already at/above the threshold (and flipping it OFF
  // doesn't re-enable them — only the "Re-enable All" button does that,
  // to keep the action explicit).
  function syncDisabledState() {
    const map = load();
    const on = !!(Settings && Settings.get && Settings.get('autoDisableFailingSources'));
    for (const url of Object.keys(map)) {
      const s = map[url];
      if (!s) continue;
      if (on && (s.failures || 0) >= FAILURE_THRESHOLD) s.disabled = true;
    }
    save(map);
    emit({ type: 'sync', map });
  }

  function isDisabled(url) {
    if (!url) return false;
    // Disabled state only takes effect when the user has the toggle on.
    // With the toggle off, we record failures (visible in Activity) but
    // never skip the source. The user wants the choice.
    if (!(Settings && Settings.get && Settings.get('autoDisableFailingSources'))) return false;
    const map = load();
    return !!(map[url] && map[url].disabled);
  }

  function getFailureCount(url) {
    const map = load();
    return (map[url] && map[url].failures) || 0;
  }

  // A source is considered "refused" once it has hit the auto-disable
  // threshold (or has been explicitly disabled by the user / toggle).
  // Used by the Configure Sources modal's status filter and to render
  // a refused badge on the source row.
  function isRefused(url) {
    if (!url) return false;
    const map = load();
    const s = map[url];
    if (!s) return false;
    return (s.failures || 0) >= FAILURE_THRESHOLD || !!s.disabled;
  }

  // Return every source we've ever seen a failure from, sorted by
  // most-recent failure first. Used by the Activity → Failed sources
  // tab. Includes currently-disabled AND warned-but-still-active ones
  // so the user can see the buildup before the threshold is reached.
  // We require at least WARN_AT failures before showing a row, so a
  // one-off hiccup doesn't clutter the list — but the Settings →
  // Feed Health count still tracks the raw totals.
  function getTrackedSources() {
    const map = load();
    const list = [];
    for (const [url, state] of Object.entries(map)) {
      if (!state) continue;
      const f = state.failures || 0;
      if (f === 0 && !state.disabled) continue;
      list.push({ url, ...state });
    }
    list.sort((a, b) => (b.lastFailureAt || 0) - (a.lastFailureAt || 0));
    return list;
  }

  // Same as getTrackedSources but with the WARN_AT floor applied. Used
  // for the user-facing lists (Activity → Failed sources, Settings →
  // Feed Health per-source list) so a single transient hiccup doesn't
  // become a confusing row the user feels they have to clean up.
  function getVisibleSources() {
    return getTrackedSources().filter(s => (s.failures || 0) >= WARN_AT || s.disabled);
  }

  // Re-enable a single source. Resets its failure count and clears
  // the disabled flag so it will be tried again on the next fetch.
  function reEnable(url) {
    const map = load();
    if (!map[url]) return;
    map[url] = { ...map[url], disabled: false, failures: 0, lastError: '' };
    save(map);
    emit({ type: 'reenabled', url, state: map[url] });
  }

  // Re-enable every disabled source. This is the "Include all" /
  // "Re-enable all" button in Settings — the user explicitly opted
  // back into the previously-broken feeds.
  function reEnableAll() {
    const map = load();
    let count = 0;
    for (const url of Object.keys(map)) {
      if (map[url] && map[url].disabled) {
        map[url] = { ...map[url], disabled: false, failures: 0, lastError: '' };
        count++;
      }
    }
    save(map);
    emit({ type: 'reenabledAll', count });
    return count;
  }

  // Forget all history for a URL. Not currently used by the UI but
  // useful for tests / hard reset.
  function reset(url) {
    const map = load();
    delete map[url];
    save(map);
    emit({ type: 'reset', url });
  }

  function resetAll() {
    localStorage.removeItem(STORAGE_KEY);
    emit({ type: 'resetAll' });
  }

  return {
    FAILURE_THRESHOLD,
    WARN_AT,
    get,
    isDisabled,
    isRefused,
    getFailureCount,
    getTrackedSources,
    getVisibleSources,
    recordSuccess,
    recordFailure,
    reEnable,
    reEnableAll,
    reset,
    resetAll,
    syncDisabledState,
    onChange
  };
})();
