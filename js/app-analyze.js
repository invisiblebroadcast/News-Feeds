// @ts-nocheck
(async () => {
    const $ = (sel, ctx) => (ctx || document).querySelector(sel);
    const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];
    function init() {
        bindAnalyzeButton();
        bindSubjectSuggest();
        bindRunAnalysis();
        bindHeaderAnalyze();
        bindAuth();
    }
    function bindAnalyzeButton() {
        const btn = $('#hero-analyze-btn');
        if (btn) {
            btn.addEventListener('click', () => {
                openAnalyzeConfig();
            });
        }
    }
    function bindHeaderAnalyze() {
        const btn = $('#analyze-btn');
        if (btn) {
            btn.addEventListener('click', () => {
                openAnalyzeConfig();
            });
        }
    }
    function openAnalyzeConfig(subject) {
        if (window.AnalyzeModal && typeof AnalyzeModal.openConfig === 'function') {
            AnalyzeModal.openConfig({ subject: subject || null });
        }
        else {
            const modal = $('#analyze-config-modal');
            if (modal)
                modal.classList.add('open');
        }
    }
    function bindSubjectSuggest() {
        const input = $('#acf-subject-input');
        const suggest = $('#acf-subject-suggest');
        if (!input || !suggest)
            return;
        let timer = null;
        input.addEventListener('input', () => {
            clearTimeout(timer);
            const q = input.value.trim().toLowerCase();
            if (q.length < 2) {
                suggest.innerHTML = '';
                suggest.style.display = 'none';
                return;
            }
            timer = setTimeout(() => {
                const subjects = window.SUBJECT_REGISTRY || [];
                const matches = subjects.filter(s => s.name && s.name.toLowerCase().includes(q)).slice(0, 8);
                if (!matches.length) {
                    suggest.innerHTML = '';
                    suggest.style.display = 'none';
                    return;
                }
                suggest.innerHTML = matches.map(s => '<div class="acf-suggest-item" data-subject=\'' + JSON.stringify(s).replace(/'/g, '&#39;') + '\'>' +
                    '<strong>' + s.name + '</strong>' +
                    (s.twitter ? ' <span style="color:var(--text-tertiary);font-size:0.75rem;">@' + s.twitter + '</span>' : '') +
                    '</div>').join('');
                suggest.style.display = 'block';
                suggest.querySelectorAll('.acf-suggest-item').forEach(item => {
                    item.addEventListener('click', () => {
                        try {
                            const subject = JSON.parse(item.dataset.subject);
                            input.value = subject.name || '';
                            suggest.innerHTML = '';
                            suggest.style.display = 'none';
                        }
                        catch { }
                    });
                });
            }, 200);
        });
        document.addEventListener('click', e => {
            if (!suggest.contains(e.target) && e.target !== input) {
                suggest.style.display = 'none';
            }
        });
    }
    function bindRunAnalysis() {
        const runBtn = $('#analyze-config-run');
        if (!runBtn)
            return;
        runBtn.addEventListener('click', async () => {
            const subjectInput = $('#acf-subject-input');
            const sourceRadios = $$('input[name="acf-source"]');
            const dateStart = $('#acf-date-start');
            const dateEnd = $('#acf-date-end');
            const focusInput = $('#acf-focus-input');
            const modal = $('#analyze-config-modal');
            const subjectName = subjectInput ? subjectInput.value.trim() : '';
            if (!subjectName) {
                if (subjectInput)
                    subjectInput.classList.add('acf-input-error');
                setTimeout(() => { if (subjectInput)
                    subjectInput.classList.remove('acf-input-error'); }, 600);
                return;
            }
            let source = 'both';
            for (const radio of sourceRadios) {
                if (radio.checked) {
                    source = radio.value;
                    break;
                }
            }
            const config = {
                subject: { display_name: subjectName, handle: subjectName.toLowerCase().replace(/\s+/g, '_') },
                source: source,
                dateStart: dateStart ? dateStart.value : '',
                dateEnd: dateEnd ? dateEnd.value : '',
                focus: focusInput ? focusInput.value.trim() : ''
            };
            if (modal)
                modal.classList.remove('open');
            if (window.AnalyzeModal && typeof AnalyzeModal.runAnalysis === 'function') {
                const subject = window.SUBJECT_REGISTRY?.find(s => s.name?.toLowerCase() === subjectName.toLowerCase());
                if (subject) {
                    AnalyzeModal.runAnalysis({ ...config, subject });
                }
                else {
                    AnalyzeModal.runAnalysis(config);
                }
            }
        });
    }
    function bindAuth() {
        const authBtn = $('#auth-btn');
        if (authBtn) {
            authBtn.addEventListener('click', () => {
                const modal = $('#auth-modal');
                if (modal)
                    modal.classList.add('open');
            });
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    }
    else {
        init();
    }
})();
