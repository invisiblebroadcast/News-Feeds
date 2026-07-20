// @ts-nocheck
/* ── Publish Modal ──
 *
 * YouTube transcript + Quotes → Supabase publishing pipeline.
 * FAB + modal with YouTube/Audio/Quotes tabs. Only visible to
 * signed-in users.
 *
 * Dependencies:
 *   - SupabaseStore (for auth user id + DB writes)
 *   - youtubetranscript.com API (free, no API key)
 */
const PublishModal = (() => {
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return [...(ctx || document).querySelectorAll(sel)]; }

  let currentUser = null;

  /** Format integer post_id as IB00001, IB00002, etc. */
  function formatPostId(id) {
    if (!id && id !== 0) return '';
    return 'IB' + String(id).padStart(5, '0');
  }

  /* ── YouTube helpers ── */
  function getVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  async function fetchTranscript(videoId) {
    const res = await fetch(`https://youtubetranscript.com/?v=${videoId}`);
    if (!res.ok) throw new Error('Transcript unavailable for this video');
    return res.json();
  }

  async function fetchVideoTitle(videoId) {
    try {
      const res = await fetch(`https://youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
      if (res.ok) {
        const data = await res.json();
        return data.title || '';
      }
    } catch {}
    return '';
  }

  /* ── Actions ── */
  function setMsg(el, text, type) {
    if (!el) return;
    el.textContent = text;
    el.className = 'publish-msg';
    if (type) el.classList.add(type);
  }

  /* ── YouTube: publish to Supabase ── */
  async function handleFetchTranscript() {
    const urlInput = $('#publish-url');
    const titleInput = $('#publish-title');
    const descInput = $('#publish-desc');
    const msg = $('#publish-msg');
    const fetchBtn = $('#publish-fetch-btn');

    const url = urlInput?.value?.trim();
    if (!url) { setMsg(msg, 'Please enter a YouTube URL', 'error'); return; }

    const videoId = getVideoId(url);
    if (!videoId) { setMsg(msg, 'Invalid YouTube URL', 'error'); return; }

    if (fetchBtn) { fetchBtn.disabled = true; fetchBtn.textContent = 'Fetching\u2026'; }
    setMsg(msg, 'Fetching transcript\u2026', '');

    try {
      const [transcript, videoTitle] = await Promise.all([
        fetchTranscript(videoId),
        fetchVideoTitle(videoId)
      ]);

      if (!transcript || !transcript.length) {
        throw new Error('No transcript available for this video');
      }

      if (videoTitle && titleInput) {
        titleInput.value = videoTitle;
      }

      const transcriptText = transcript.map(t => t.text).join('\n');
      if (descInput) {
        descInput.value = transcriptText;
      }

      setMsg(msg, 'Transcript fetched successfully!', 'success');
    } catch (e) {
      setMsg(msg, e.message || 'Failed to fetch transcript', 'error');
    } finally {
      if (fetchBtn) { fetchBtn.disabled = false; fetchBtn.textContent = 'Fetch Transcript'; }
    }
  }

  async function handlePublish() {
    // Skip if we're in edit mode (app-home.ts sets this flag)
    if ((window as any)._ibSkipPublish) { (window as any)._ibSkipPublish = false; return; }
    const title = $('#publish-title')?.value?.trim();
    const desc = $('#publish-desc')?.value?.trim();
    const url = $('#publish-url')?.value?.trim();
    const msg = $('#publish-msg');

    if (!currentUser) { setMsg(msg, 'Please sign in first', 'error'); return; }
    if (!title) { setMsg(msg, 'Please enter a title', 'error'); return; }
    if (!desc) { setMsg(msg, 'Please enter content', 'error'); return; }

    const publishBtn = $('#yt-publish-btn');
    if (publishBtn) { publishBtn.disabled = true; publishBtn.textContent = 'Publishing\u2026'; }

    try {
      const client = window.SupabaseStore && SupabaseStore.getClient();
      if (!client) throw new Error('Supabase client not available');

      const { error } = await client
        .from('published_articles')
        .insert({
          user_id: currentUser.id,
          user_email: currentUser.email || '',
          author: currentUser.email || '',
          title: title,
          body: desc,
          source_name: 'YouTube',
          source_link: url || '',
          scope: 'global',
          nation: '',
          category: 'all',
          type: 'feeds',
          quote_from: ''
        });

      if (error) throw error;

      setMsg(msg, 'Post published successfully!', 'success');
      if ($('#publish-title')) $('#publish-title').value = '';
      if ($('#publish-desc')) $('#publish-desc').value = '';
      if ($('#publish-url')) $('#publish-url').value = '';
    } catch (e) {
      setMsg(msg, e.message || 'Publish failed', 'error');
    } finally {
      if (publishBtn) { publishBtn.disabled = false; publishBtn.textContent = 'Publish'; }
    }
  }

  /* ── Quotes: publish to Supabase ── */
  let _quoteImageFile = null;

  function initQuoteImageHandlers() {
    const fileInput = $('#quote-image');
    const preview = $('#quote-image-preview');
    const previewImg = $('#quote-image-preview-img');
    const removeBtn = $('#quote-image-remove');

    if (fileInput) {
      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        if (file.type !== 'image/png' && file.type !== 'image/jpeg') {
          fileInput.value = '';
          return;
        }
        if (file.size > 2 * 1024 * 1024) {
          fileInput.value = '';
          return;
        }
        _quoteImageFile = file;
        if (preview && previewImg) {
          previewImg.src = URL.createObjectURL(file);
          preview.style.display = 'block';
        }
      });
    }
    if (removeBtn) {
      removeBtn.addEventListener('click', () => {
        _quoteImageFile = null;
        if (fileInput) fileInput.value = '';
        if (preview) preview.style.display = 'none';
      });
    }
  }

  async function handlePublishQuote() {
    // Skip if we're in edit mode (app-home.ts sets this flag)
    if ((window as any)._ibSkipPublish) { (window as any)._ibSkipPublish = false; return; }
    const desc = $('#quote-desc')?.value?.trim();
    const quoteFrom = $('#quote-from')?.value?.trim();
    const quoteOccupation = $('#quote-occupation')?.value?.trim() || '';
    const quoteDate = $('#quote-date')?.value || '';
    const sourceLink = $('#quote-source-link')?.value?.trim();
    const scopeVal = $('#quote-scope-select')?.value || 'global';
    const msg = $('#quote-publish-msg');

    if (!currentUser) { setMsg(msg, 'Please sign in first', 'error'); return; }
    if (!desc) { setMsg(msg, 'Please enter the quote text', 'error'); return; }

    const publishBtn = $('#quote-publish-btn');
    if (publishBtn) { publishBtn.disabled = true; publishBtn.textContent = 'Publishing\u2026'; }

    try {
      const client = window.SupabaseStore && SupabaseStore.getClient();
      if (!client) throw new Error('Supabase client not available');

      const { data: inserted, error } = await client
        .from('published_articles')
        .insert({
          user_id: currentUser.id,
          user_email: currentUser.email || '',
          author: currentUser.email || '',
          title: '',
          body: desc,
          source_name: quoteFrom || '',
          source_link: sourceLink || '',
          scope: scopeVal,
          nation: scopeVal === 'nation' ? 'india' : '',
          category: 'quotes',
          type: 'quote',
          quote_from: quoteFrom || '',
          quote_date: quoteDate,
          quote_occupation: quoteOccupation
        })
        .select('post_id')
        .single();

      if (error) throw error;

      const postId = inserted?.post_id;

      if (_quoteImageFile && postId) {
        const ext = _quoteImageFile.type === 'image/png' ? 'png' : 'jpg';
        const filePath = formatPostId(postId) + '.' + ext;
        const { error: uploadErr } = await client.storage
          .from('ib-post-images')
          .upload(filePath, _quoteImageFile, {
            contentType: _quoteImageFile.type,
            upsert: true
          });
        if (uploadErr) {
          console.warn('[PublishModal] Image upload failed:', uploadErr.message);
        }
      }

      setMsg(msg, 'Quote published successfully!', 'success');
      _quoteImageFile = null;
      if ($('#quote-from')) $('#quote-from').value = '';
      if ($('#quote-occupation')) $('#quote-occupation').value = '';
      if ($('#quote-desc')) $('#quote-desc').value = '';
      if ($('#quote-date')) $('#quote-date').value = '';
      if ($('#quote-source-link')) $('#quote-source-link').value = '';
      if ($('#quote-image')) $('#quote-image').value = '';
      if ($('#quote-image-preview')) $('#quote-image-preview').style.display = 'none';
    } catch (e) {
      setMsg(msg, e.message || 'Publish failed', 'error');
    } finally {
      if (publishBtn) { publishBtn.disabled = false; publishBtn.textContent = 'Publish Quote'; }
    }
  }

  /* ── Tab switching ── */
  function showTab(tab) {
    $$('.publish-tab').forEach(t => t.classList.toggle('active', t.dataset.publishTab === tab));
    $$('.publish-pane').forEach(p => p.classList.toggle('active', p.dataset.publishPane === tab));
  }

  /* ── FAB visibility (called from app-home.js updateAuthUI) ── */
  function updateFabVisibility() {
    const fab = $('#publish-fab');
    if (!fab) return;
    fab.classList.toggle('fab-hidden', !currentUser);
  }

  function setCurrentUser(user) {
    currentUser = user;
    updateFabVisibility();
  }

  function openModal() {
    const modal = $('#yt-publish-modal');
    if (!modal) return;

    const publishBtn = $('#yt-publish-btn');
    if (publishBtn) publishBtn.textContent = 'Publish';
    const msg = $('#publish-msg');
    if (msg) { msg.textContent = ''; msg.className = 'publish-msg'; }

    if (window.appState && typeof window.appState.openModal === 'function') {
      window.appState.openModal('publish', modal);
    } else {
      modal.classList.add('open');
    }

    showTab('youtube');
  }

  function closeModal() {
    if (window.appState && typeof window.appState.closeModal === 'function') {
      window.appState.closeModal('publish');
    } else {
      const modal = $('#yt-publish-modal');
      if (modal) modal.classList.remove('open');
    }
  }

  /* ── Bindings ── */
  function bindAll() {
    const fab = $('#publish-fab');
    if (fab) {
      fab.addEventListener('click', openModal);
    }

    $$('.publish-tab').forEach(tab => {
      tab.addEventListener('click', () => showTab(tab.dataset.publishTab));
    });

    const fetchBtn = $('#publish-fetch-btn');
    if (fetchBtn) {
      fetchBtn.addEventListener('click', handleFetchTranscript);
    }

    const publishBtn = $('#yt-publish-btn');
    if (publishBtn) {
      publishBtn.addEventListener('click', handlePublish);
    }

    const closeBtn = $('#yt-publish-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    const modal = $('#yt-publish-modal');
    if (modal) {
      modal.addEventListener('click', e => {
        if (e.target === modal) closeModal();
      });
    }

    // Quotes tab
    const quotePublishBtn = $('#quote-publish-btn');
    if (quotePublishBtn) {
      quotePublishBtn.addEventListener('click', handlePublishQuote);
    }
    initQuoteImageHandlers();
  }

  function escHtml(s) {
    return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function escAttr(s) {
    return (s == null ? '' : String(s)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return {
    bindAll,
    setCurrentUser,
    openModal,
    closeModal
  };
})();

window.PublishModal = PublishModal;
