// @ts-nocheck
const AppState = (() => {
    const SESSION_KEY = 'newsfeeds_session_state';
    const STORAGE_KEY = 'newsfeeds_persistent_state';
    const DEFAULTS = {
        currentScope: 'global',
        currentNation: 'india',
        currentSubcat: 'all',
        currentMode: 'live',
        currentView: 'list',
        currentSort: 'date-desc',
        currentSearch: '',
        filterDateStart: '',
        filterDateEnd: '',
        filterSources: [],
        lastPage: 'index'
    };
    function load() {
        let state = { ...DEFAULTS };
        try {
            const session = sessionStorage.getItem(SESSION_KEY);
            if (session) {
                const parsed = JSON.parse(session);
                state = { ...state, ...parsed };
            }
            else {
                const stored = localStorage.getItem(STORAGE_KEY);
                if (stored) {
                    const parsed = JSON.parse(stored);
                    state = { ...state, ...parsed };
                }
            }
        }
        catch { }
        return state;
    }
    function save(partial) {
        try {
            const current = load();
            const updated = { ...current, ...partial };
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(updated));
            const persist = { ...updated };
            delete persist.filterSources;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
        }
        catch { }
    }
    function get(key) {
        return load()[key] ?? DEFAULTS[key];
    }
    function set(key, value) {
        save({ [key]: value });
    }
    function clear() {
        try {
            sessionStorage.removeItem(SESSION_KEY);
            localStorage.removeItem(STORAGE_KEY);
        }
        catch { }
    }
    return { load, save, get, set, clear, DEFAULTS };
})();
window.AppState = AppState;
