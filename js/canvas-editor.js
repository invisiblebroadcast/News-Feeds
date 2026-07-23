// @ts-nocheck
// Canvas Image Editor — provides a live-preview modal for adjusting
// the share-image canvas before copying/downloading. Exposed as
// window.CanvasEditor so both app-home.ts and app.ts can use it.

(function() {
  const TITLE_COLORS = ['#e6edf3','#f5e6d3','#d3e8f5','#e6d3f5','#d3f5e0','#f5e0d3','#f0dbe8','#dbe8f0','#d4f0db','#f0ecd4','#e0dbf0','#dbf0ec'];

  // Aspect ratios: label → { w, h } used for the output canvas (base = 1080 wide)
  const RATIOS = {
    '9:16':  { w: 1080, h: 1920 },
    '4:3':   { w: 1080, h: 810  },
    '3:4':   { w: 810,  h: 1080 },
    '16:9':  { w: 1920, h: 1080 },
    '1:1':   { w: 1080, h: 1080 },
  };
  const RATIO_KEYS = Object.keys(RATIOS);

  let _modal = null;
  let _previewCanvas = null;
  let _previewCtx = null;
  let _settings = {};
  let _article = null;
  let _img = null;
  let _includeImage = true;
  let _onComplete = null;
  let _animFrame = null;

  function getCanvasSize() {
    return RATIOS[_settings.aspectRatio] || RATIOS['9:16'];
  }

  function defaults() {
    const cs = RATIOS['9:16'];
    return {
      aspectRatio: '9:16',
      padding: Math.round(cs.w * 0.05),
      imageZoom: 1,
      imageRotation: 0,
      imageCropX: 0.5,
      imageCropY: 0.5,
      imageHeight: 0.55,
      titleColor: TITLE_COLORS[Math.floor(Math.random() * TITLE_COLORS.length)],
      bodyColor: 'rgba(255,255,255,0.78)',
      titleFontSize: 0,
      bodyFontSize: 0,
      bodyColorRaw: '#ffffff',
      shadeOpacity: 0,
      shadeColor: '#000000',
      shadePadding: 14,
      showImage: true,
      imageOffsetX: 0,
      imageOffsetY: 0,
      textPosition: 0.4,
      blendStart: 0.5,
      vignette: true,
    };
  }

  function buildModal() {
    if (_modal) return _modal;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'canvas-editor-overlay';
    overlay.innerHTML = `
      <div class="modal canvas-editor-modal">
        <div class="modal-header">
          <button class="modal-close canvas-editor-close" aria-label="Close">&times;</button>
          <h2>Edit Share Image</h2>
        </div>
        <div class="modal-body canvas-editor-body">
          <div class="ce-preview-wrap" id="ce-preview-wrap">
            <canvas id="ce-preview-canvas" class="ce-preview-canvas"></canvas>
          </div>
          <div class="ce-divider" id="ce-divider"><div class="ce-divider-handle"></div></div>
          <div class="ce-controls" id="ce-controls">
            <!-- Aspect Ratio -->
            <div class="ce-section">
              <div class="ce-section-title">Aspect Ratio</div>
              <div class="ce-ratio-grid" id="ce-ratio-grid">
                <button class="ce-ratio-btn" data-ratio="4:3">4:3</button>
                <button class="ce-ratio-btn" data-ratio="3:4">3:4</button>
                <button class="ce-ratio-btn active" data-ratio="9:16">9:16</button>
                <button class="ce-ratio-btn" data-ratio="16:9">16:9</button>
                <button class="ce-ratio-btn" data-ratio="1:1">1:1</button>
              </div>
              <div class="ce-ratio-dim" id="ce-ratio-dim">1080 × 1920</div>
            </div>
            <!-- Image Transform -->
            <div class="ce-section ce-image-section" id="ce-image-section" style="display:none">
              <div class="ce-section-title">Image</div>
              <label class="ce-label">Zoom <span id="ce-zoom-val" class="ce-val">1.0x</span> <button class="ce-reset-btn" data-slider="ce-zoom" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-zoom" min="0.3" max="3" step="0.05" value="1" data-default="1">
              <label class="ce-label">Rotation <span id="ce-rotate-val" class="ce-val">0&deg;</span> <button class="ce-reset-btn" data-slider="ce-rotate" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-rotate" min="-180" max="180" step="1" value="0" data-default="0">
              <label class="ce-label">Crop X <span id="ce-cropx-val" class="ce-val">50%</span> <button class="ce-reset-btn" data-slider="ce-cropx" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-cropx" min="0" max="1" step="0.01" value="0.5" data-default="0.5">
              <label class="ce-label">Crop Y <span id="ce-cropy-val" class="ce-val">50%</span> <button class="ce-reset-btn" data-slider="ce-cropy" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-cropy" min="0" max="1" step="0.01" value="0.5" data-default="0.5">
              <label class="ce-label">Image Height <span id="ce-imgheight-val" class="ce-val">55%</span> <button class="ce-reset-btn" data-slider="ce-imgheight" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-imgheight" min="0.2" max="0.8" step="0.01" value="0.55" data-default="0.55">
              <label class="ce-label">Offset X <span id="ce-offsetx-val" class="ce-val">0%</span> <button class="ce-reset-btn" data-slider="ce-offsetx" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-offsetx" min="-0.5" max="0.5" step="0.01" value="0" data-default="0">
              <label class="ce-label">Offset Y <span id="ce-offsety-val" class="ce-val">0%</span> <button class="ce-reset-btn" data-slider="ce-offsety" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-offsety" min="-0.5" max="0.5" step="0.01" value="0" data-default="0">
              <label class="ce-toggle-row">
                <input type="checkbox" id="ce-showimage" checked> Show image
              </label>
            </div>
            <!-- Layout -->
            <div class="ce-section">
              <div class="ce-section-title">Layout</div>
              <label class="ce-label">Padding <span id="ce-pad-val" class="ce-val">54px</span> <button class="ce-reset-btn" data-slider="ce-padding" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-padding" min="20" max="100" step="1" value="54" data-default="54">
              <label class="ce-label">Text Position <span id="ce-textpos-val" class="ce-val">40%</span> <button class="ce-reset-btn" data-slider="ce-textpos" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-textpos" min="0.1" max="0.9" step="0.01" value="0.4" data-default="0.4">
            </div>
            <!-- Effects -->
            <div class="ce-section">
              <div class="ce-section-title">Effects</div>
              <label class="ce-label">Blend Start <span id="ce-blend-val" class="ce-val">50%</span> <button class="ce-reset-btn" data-slider="ce-blend" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-blend" min="0.1" max="0.9" step="0.01" value="0.5" data-default="0.5">
              <label class="ce-toggle-row">
                <input type="checkbox" id="ce-vignette" checked> Vignette gradient
              </label>
            </div>
            <!-- Colors -->
            <div class="ce-section">
              <div class="ce-section-title">Title Color</div>
              <div class="ce-color-grid" id="ce-title-colors"></div>
            </div>
            <div class="ce-section">
              <div class="ce-section-title">Body Color</div>
              <div class="ce-color-presets" id="ce-body-colors">
                <button class="ce-color-btn active" data-color="rgba(255,255,255,0.78)" style="background:#fff" title="White"></button>
                <button class="ce-color-btn" data-color="rgba(230,237,243,0.9)" style="background:#e6edf3" title="Light"></button>
                <button class="ce-color-btn" data-color="rgba(200,200,200,0.85)" style="background:#c8c8c8" title="Gray"></button>
                <button class="ce-color-btn" data-color="rgba(255,240,200,0.85)" style="background:#fff0c8" title="Warm"></button>
              </div>
            </div>
            <!-- Advanced Text -->
            <div class="ce-section">
              <div class="ce-section-title">Advanced Text</div>
              <label class="ce-label">Title Font Size <span id="ce-titlefontsize-val" class="ce-val">auto</span> <button class="ce-reset-btn" data-slider="ce-titlefontsize" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-titlefontsize" min="16" max="64" step="1" value="0" data-default="0">
              <label class="ce-label">Body Font Size <span id="ce-bodyfontsize-val" class="ce-val">auto</span> <button class="ce-reset-btn" data-slider="ce-bodyfontsize" title="Reset">&#8634;</button></label>
              <input type="range" class="ce-slider" id="ce-bodyfontsize" min="10" max="40" step="1" value="0" data-default="0">
              <label class="ce-label">Body Color</label>
              <div class="ce-shade-color-row">
                <input type="color" id="ce-bodycolorraw" value="#ffffff" class="ce-shade-color-input">
                <span id="ce-bodycolorraw-val" class="ce-val">#ffffff</span>
              </div>
            </div>
            <!-- Shade -->
            <div class="ce-section">
              <div class="ce-section-title">Text Shade</div>
              <label class="ce-toggle-row">
                <input type="checkbox" id="ce-shadeenabled"> Enable shade box
              </label>
              <div id="ce-shade-options" style="display:none">
                <label class="ce-label">Opacity <span id="ce-shade-val" class="ce-val">0%</span> <button class="ce-reset-btn" data-slider="ce-shade" title="Reset">&#8634;</button></label>
                <input type="range" class="ce-slider" id="ce-shade" min="0" max="0.8" step="0.02" value="0" data-default="0">
                <label class="ce-label">Color</label>
                <div class="ce-shade-color-row">
                  <input type="color" id="ce-shadecolor" value="#000000" class="ce-shade-color-input">
                  <span id="ce-shadecolor-val" class="ce-val">#000000</span>
                </div>
                <label class="ce-label">Text Padding <span id="ce-shadepadding-val" class="ce-val">14px</span> <button class="ce-reset-btn" data-slider="ce-shadepadding" title="Reset">&#8634;</button></label>
                <input type="range" class="ce-slider" id="ce-shadepadding" min="4" max="40" step="1" value="14" data-default="14">
              </div>
            </div>
          </div>
        </div>
        <div class="modal-footer canvas-editor-footer">
          <button class="btn canvas-editor-cancel">Cancel</button>
          <button class="btn btn-primary canvas-editor-copy" id="ce-copy-btn">Copy Image</button>
          <button class="btn canvas-editor-download" id="ce-download-btn">Download</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    _modal = overlay;
    _previewCanvas = overlay.querySelector('#ce-preview-canvas');
    _previewCtx = _previewCanvas.getContext('2d');

    // Build title color swatches
    const colorGrid = overlay.querySelector('#ce-title-colors');
    TITLE_COLORS.forEach(c => {
      const btn = document.createElement('button');
      btn.className = 'ce-color-btn';
      btn.dataset.color = c;
      btn.style.background = c;
      if (c === _settings.titleColor) btn.classList.add('active');
      colorGrid.appendChild(btn);
    });

    // Bind controls
    overlay.querySelector('.canvas-editor-close').addEventListener('click', close);
    overlay.querySelector('.canvas-editor-cancel').addEventListener('click', close);
    overlay.querySelector('.canvas-editor-copy').addEventListener('click', () => doAction('copy'));
    overlay.querySelector('.canvas-editor-download').addEventListener('click', () => doAction('download'));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    // Slider bindings
    const sliders = [
      ['ce-zoom', 'imageZoom', v => v + 'x', 'ce-zoom-val'],
      ['ce-rotate', 'imageRotation', v => v + '\u00B0', 'ce-rotate-val'],
      ['ce-cropx', 'imageCropX', v => Math.round(v * 100) + '%', 'ce-cropx-val'],
      ['ce-cropy', 'imageCropY', v => Math.round(v * 100) + '%', 'ce-cropy-val'],
      ['ce-imgheight', 'imageHeight', v => Math.round(v * 100) + '%', 'ce-imgheight-val'],
      ['ce-offsetx', 'imageOffsetX', v => Math.round(v * 100) + '%', 'ce-offsetx-val'],
      ['ce-offsety', 'imageOffsetY', v => Math.round(v * 100) + '%', 'ce-offsety-val'],
      ['ce-padding', 'padding', v => v + 'px', 'ce-pad-val'],
      ['ce-textpos', 'textPosition', v => Math.round(v * 100) + '%', 'ce-textpos-val'],
      ['ce-blend', 'blendStart', v => Math.round(v * 100) + '%', 'ce-blend-val'],
      ['ce-shade', 'shadeOpacity', v => Math.round(v * 100) + '%', 'ce-shade-val'],
      ['ce-shadepadding', 'shadePadding', v => v + 'px', 'ce-shadepadding-val'],
      ['ce-titlefontsize', 'titleFontSize', v => v === 0 ? 'auto' : v + 'px', 'ce-titlefontsize-val'],
      ['ce-bodyfontsize', 'bodyFontSize', v => v === 0 ? 'auto' : v + 'px', 'ce-bodyfontsize-val'],
    ];
    sliders.forEach(([id, key, fmt, valId]) => {
      const el = overlay.querySelector('#' + id);
      if (!el) return;
      el.addEventListener('input', () => {
        _settings[key] = parseFloat(el.value);
        overlay.querySelector('#' + valId).textContent = fmt(_settings[key]);
        schedulePreview();
      });
    });

    // Reset buttons
    overlay.querySelectorAll('.ce-reset-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.preventDefault();
        const sliderId = btn.dataset.slider;
        const slider = overlay.querySelector('#' + sliderId);
        if (!slider) return;
        const def = parseFloat(slider.dataset.default);
        slider.value = def;
        slider.dispatchEvent(new Event('input'));
      });
    });

    // Checkbox
    overlay.querySelector('#ce-showimage').addEventListener('change', e => {
      _settings.showImage = e.target.checked;
      schedulePreview();
    });
    overlay.querySelector('#ce-vignette').addEventListener('change', e => {
      _settings.vignette = e.target.checked;
      schedulePreview();
    });

    // Shade enable toggle
    const shadeEnabledEl = overlay.querySelector('#ce-shadeenabled');
    const shadeOptionsEl = overlay.querySelector('#ce-shade-options');
    shadeEnabledEl.addEventListener('change', e => {
      const on = e.target.checked;
      shadeOptionsEl.style.display = on ? '' : 'none';
      if (on && _settings.shadeOpacity === 0) {
        _settings.shadeOpacity = 0.45;
        overlay.querySelector('#ce-shade').value = 0.45;
        overlay.querySelector('#ce-shade-val').textContent = '45%';
      }
      if (!on) _settings.shadeOpacity = 0;
      schedulePreview();
    });

    // Shade color picker
    overlay.querySelector('#ce-shadecolor').addEventListener('input', e => {
      _settings.shadeColor = e.target.value;
      overlay.querySelector('#ce-shadecolor-val').textContent = e.target.value;
      schedulePreview();
    });

    // Body color raw picker
    overlay.querySelector('#ce-bodycolorraw').addEventListener('input', e => {
      _settings.bodyColorRaw = e.target.value;
      _settings.bodyColor = e.target.value;
      overlay.querySelector('#ce-bodycolorraw-val').textContent = e.target.value;
      overlay.querySelectorAll('#ce-body-colors .ce-color-btn').forEach(b => b.classList.remove('active'));
      schedulePreview();
    });

    // Title color clicks
    colorGrid.addEventListener('click', e => {
      const btn = e.target.closest('.ce-color-btn');
      if (!btn) return;
      colorGrid.querySelectorAll('.ce-color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _settings.titleColor = btn.dataset.color;
      schedulePreview();
    });

    // Body color clicks
    overlay.querySelector('#ce-body-colors').addEventListener('click', e => {
      const btn = e.target.closest('.ce-color-btn');
      if (!btn) return;
      overlay.querySelectorAll('#ce-body-colors .ce-color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _settings.bodyColor = btn.dataset.color;
      schedulePreview();
    });

    // Aspect ratio buttons
    overlay.querySelector('#ce-ratio-grid').addEventListener('click', e => {
      const btn = e.target.closest('.ce-ratio-btn');
      if (!btn) return;
      overlay.querySelectorAll('.ce-ratio-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _settings.aspectRatio = btn.dataset.ratio;
      // Update padding default for new ratio
      const cs = getCanvasSize();
      _settings.padding = Math.round(cs.w * 0.05);
      overlay.querySelector('#ce-padding').value = _settings.padding;
      overlay.querySelector('#ce-pad-val').textContent = _settings.padding + 'px';
      // Update dimension display
      overlay.querySelector('#ce-ratio-dim').textContent = cs.w + ' × ' + cs.h;
      schedulePreview();
    });

    // Draggable divider
    initDivider();

    return _modal;
  }

  function initDivider() {
    const divider = _modal.querySelector('#ce-divider');
    const previewWrap = _modal.querySelector('#ce-preview-wrap');
    const controls = _modal.querySelector('#ce-controls');
    if (!divider || !previewWrap || !controls) return;
    let dragging = false, startY = 0, startPreviewH = 0;
    const body = _modal.querySelector('.canvas-editor-body');

    divider.addEventListener('mousedown', e => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startPreviewH = previewWrap.getBoundingClientRect().height;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      divider.classList.add('ce-divider-active');
    });
    divider.addEventListener('touchstart', e => {
      e.preventDefault();
      dragging = true;
      startY = e.touches[0].clientY;
      startPreviewH = previewWrap.getBoundingClientRect().height;
      document.addEventListener('touchmove', onMoveT, { passive: false });
      document.addEventListener('touchend', onUpT);
      divider.classList.add('ce-divider-active');
    }, { passive: false });

    function onMove(e) {
      if (!dragging) return;
      const delta = e.clientY - startY;
      const newH = Math.max(120, Math.min(startPreviewH + delta, body.clientHeight - 140));
      previewWrap.style.flex = 'none';
      previewWrap.style.height = newH + 'px';
      controls.style.flex = '1';
      schedulePreview();
    }
    function onUp() {
      dragging = false;
      divider.classList.remove('ce-divider-active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }
    function onMoveT(e) {
      if (!dragging) return;
      e.preventDefault();
      const delta = e.touches[0].clientY - startY;
      const newH = Math.max(120, Math.min(startPreviewH + delta, body.clientHeight - 140));
      previewWrap.style.flex = 'none';
      previewWrap.style.height = newH + 'px';
      controls.style.flex = '1';
      schedulePreview();
    }
    function onUpT() {
      dragging = false;
      divider.classList.remove('ce-divider-active');
      document.removeEventListener('touchmove', onMoveT);
      document.removeEventListener('touchend', onUpT);
    }
  }

  function schedulePreview() {
    if (_animFrame) cancelAnimationFrame(_animFrame);
    _animFrame = requestAnimationFrame(() => renderPreview());
  }

  function renderPreview() {
    if (!_previewCanvas || !_article) return;
    const canvas = renderCanvas(_article, _settings, _img, _includeImage);
    if (!canvas) return;
    const previewWrap = _modal.querySelector('#ce-preview-wrap');
    const wrapRect = previewWrap.getBoundingClientRect();
    const maxPW = wrapRect.width - 24;
    const maxPH = wrapRect.height - 24;
    const aspect = canvas.width / canvas.height;
    let pw, ph;
    if (maxPW / aspect <= maxPH) {
      pw = maxPW;
      ph = pw / aspect;
    } else {
      ph = maxPH;
      pw = ph * aspect;
    }
    pw = Math.max(1, Math.round(pw));
    ph = Math.max(1, Math.round(ph));
    _previewCanvas.width = pw * 2;
    _previewCanvas.height = ph * 2;
    _previewCanvas.style.width = pw + 'px';
    _previewCanvas.style.height = ph + 'px';
    _previewCtx.imageSmoothingQuality = 'high';
    _previewCtx.drawImage(canvas, 0, 0, _previewCanvas.width, _previewCanvas.height);
  }

  function renderCanvas(article, settings, img, includeImage) {
    const cs = getCanvasSize();
    const W = cs.w;
    const H = cs.h;
    const pad = settings.padding || Math.round(W * 0.05);
    const gap = Math.round(W * 0.04);
    const titleFontSize = settings.titleFontSize > 0 ? settings.titleFontSize : Math.round(W * 0.052);
    const bodyFontSize = settings.bodyFontSize > 0 ? settings.bodyFontSize : Math.round(W * 0.028);
    const sourceFontSize = Math.round(W * 0.022);
    const titleLineH = Math.round(titleFontSize * 1.28);
    const bodyLineH = Math.round(bodyFontSize * 1.5);
    const textW = W - pad * 2;
    const rightSafePad = Math.round(W * 0.04);
    const textWR = textW - rightSafePad;

    const fullSummary = (typeof Settings !== 'undefined' && Settings.get('showDescription'))
      ? cleanSummary(stripHtml(article.summary)) : '';

    const hasImg = includeImage && settings.showImage && img && img.naturalWidth > 0;
    const imgW = hasImg ? img.naturalWidth : 0;
    const imgH = hasImg ? img.naturalHeight : 0;

    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    const c = document.createElement('canvas');
    c.width = W * dpr;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.scale(dpr, dpr);

    // Quote type
    if (article._pubType === 'quote') {
      return renderQuote(article, settings, img, includeImage);
    }

    // Measure title and summary
    ctx.font = 'bold ' + titleFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
    const titleLines = wrapText(ctx, article.title || '', 0, 0, textW, titleLineH);
    ctx.font = bodyFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
    const summaryLines = fullSummary ? wrapText(ctx, fullSummary, 0, 0, textW, bodyLineH) : 0;

    const titleH = titleLines * titleLineH;
    const summaryH = summaryLines * bodyLineH;
    const sourceH = article.source ? sourceFontSize : 0;
    const medGap = Math.round(W * 0.03);

    const textBlockH = sourceH
      + (sourceH ? medGap : 0)
      + titleH
      + medGap
      + (summaryH > 0 ? summaryH + medGap : 0);

    const imgMaxAreaH = Math.round(H * settings.imageHeight);
    const ibHeaderH = hasImg ? Math.round(W * 0.08) : 0;
    // textPosition controls the split: 0 = all image, 1 = all text
    const textPositionRatio = settings.textPosition || 0.4;

    let imgDrawW = 0, imgDrawH = 0, imgBlockH = 0;
    if (hasImg) {
      const maxW = W;
      const maxH = imgMaxAreaH - ibHeaderH;
      const zoom = settings.imageZoom || 1;
      const baseScale = Math.max(maxW / imgW, maxH / imgH);
      const scale = baseScale * zoom;
      imgDrawW = Math.round(imgW * scale);
      imgDrawH = Math.round(imgH * scale);
      imgBlockH = ibHeaderH + maxH;
    }

    const totalContentH = hasImg ? (imgBlockH + gap + textBlockH) : textBlockH;
    c.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingQuality = 'high';
    // textPosition shifts content: lower value → image gets more space upward
    const topOffset = Math.round(H * (1 - textPositionRatio) * 0.15);

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    let cursorY = topOffset;

    if (hasImg) {
      const maxW = W;
      const maxH = imgMaxAreaH - ibHeaderH;
      const offX = Math.round((settings.imageOffsetX || 0) * W);
      const offY = Math.round((settings.imageOffsetY || 0) * H);
      const drawX = Math.round((maxW - imgDrawW) / 2) + offX;
      const imageTopY = cursorY + ibHeaderH;
      const drawY = imageTopY + Math.round((maxH - imgDrawH) / 2) + offY;

      ctx.save();
      roundRect(ctx, 0, imageTopY, maxW, maxH, 0);
      ctx.clip();

      // Apply rotation
      const rotation = settings.imageRotation || 0;
      if (rotation !== 0) {
        ctx.translate(imageTopY + maxH / 2, maxW / 2);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.translate(-(imageTopY + maxH / 2), -maxW / 2);
      }

      // Multi-pass downscale
      const cropX = settings.imageCropX != null ? settings.imageCropX : 0.5;
      const cropY = settings.imageCropY != null ? settings.imageCropY : 0.5;
      if (imgW > imgDrawW * 2) {
        let curW = imgW, curH = imgH;
        let curSrc = img;
        while (curW > imgDrawW * 2) {
          const nextW = Math.max(imgDrawW, Math.floor(curW / 2));
          const nextH = Math.max(Math.round(curH * nextW / curW), 1);
          const off = document.createElement('canvas');
          off.width = nextW; off.height = nextH;
          const octx = off.getContext('2d');
          octx.imageSmoothingEnabled = true;
          octx.imageSmoothingQuality = 'high';
          octx.drawImage(curSrc, 0, 0, nextW, nextH);
          curSrc = off;
          curW = nextW; curH = nextH;
        }
        const srcVisW = Math.min(imgDrawW, curW);
        const srcVisH = Math.min(imgDrawH, curH);
        const srcX = Math.round((curW - srcVisW) * cropX);
        const srcY = Math.round((curH - srcVisH) * cropY);
        ctx.drawImage(curSrc, srcX, srcY, srcVisW, srcVisH, drawX, drawY, imgDrawW, imgDrawH);
      } else {
        const srcVisW = Math.min(imgDrawW, imgW);
        const srcVisH = Math.min(imgDrawH, imgH);
        const srcX = Math.round((imgW - srcVisW) * cropX);
        const srcY = Math.round((imgH - srcVisH) * cropY);
        ctx.drawImage(img, srcX, srcY, srcVisW, srcVisH, drawX, drawY, imgDrawW, imgDrawH);
      }

      if (rotation !== 0) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Bottom blend: where image fades to black before text
      // blendStart controls the start position (0 = top, 1 = bottom)
      const clipH = ibHeaderH + maxH;
      const blendY = imageTopY + Math.round(clipH * (settings.blendStart || 0.5));
      const botFadeH = imageTopY + clipH - blendY;
      if (botFadeH > 0) {
        const botGrad = ctx.createLinearGradient(0, blendY, 0, imageTopY + clipH);
        botGrad.addColorStop(0, 'rgba(0,0,0,0)');
        botGrad.addColorStop(0.4, 'rgba(0,0,0,0.5)');
        botGrad.addColorStop(0.8, 'rgba(0,0,0,0.92)');
        botGrad.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = botGrad;
        ctx.fillRect(0, blendY, W, botFadeH);
      }

      // Vignette: top fade + side fades (only when enabled)
      if (settings.vignette) {
        const fadeH = Math.round(maxH * 0.2);
        const topGrad = ctx.createLinearGradient(0, imageTopY, 0, imageTopY + fadeH);
        topGrad.addColorStop(0, 'rgba(0,0,0,0.85)');
        topGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = topGrad;
        ctx.fillRect(0, imageTopY, W, fadeH);
        const fadeW = Math.round(W * 0.18);
        const leftGrad = ctx.createLinearGradient(0, 0, fadeW, 0);
        leftGrad.addColorStop(0, 'rgba(0,0,0,0.85)');
        leftGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = leftGrad;
        ctx.fillRect(0, imageTopY, fadeW, clipH);
        const rightGrad = ctx.createLinearGradient(W - fadeW, 0, W, 0);
        rightGrad.addColorStop(0, 'rgba(0,0,0,0)');
        rightGrad.addColorStop(1, 'rgba(0,0,0,0.85)');
        ctx.fillStyle = rightGrad;
        ctx.fillRect(W - fadeW, imageTopY, fadeW, clipH);
      }

      ctx.restore();
      ctx.fillStyle = '#000';
      ctx.fillRect(0, imageTopY + clipH, W, gap);
      cursorY += imgBlockH + gap;
    }

    // Source label
    if (article.source) {
      ctx.fillStyle = '#ff2929';
      ctx.font = '700 ' + sourceFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
      ctx.fillText(article.source.toUpperCase(), pad, cursorY + sourceFontSize);
      if (article.pubDate) {
        const d = new Date(article.pubDate);
        const pubDateText = isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
        if (pubDateText) {
          ctx.fillStyle = 'rgba(230, 237, 243, 0.65)';
          ctx.font = '500 ' + sourceFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(pubDateText, W - pad, cursorY + sourceFontSize);
          ctx.textAlign = 'left';
        }
      }
      cursorY += sourceFontSize + medGap;
    }

    // Title
    ctx.fillStyle = settings.titleColor;
    ctx.font = 'bold ' + titleFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
    ctx.textBaseline = 'alphabetic';
    wrapText(ctx, article.title || '', pad, cursorY + titleLineH, textW, titleLineH);
    cursorY += titleH + medGap;

    // Summary
    if (fullSummary) {
      ctx.fillStyle = settings.bodyColor;
      ctx.font = bodyFontSize + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
      ctx.textBaseline = 'alphabetic';
      wrapText(ctx, fullSummary, pad, cursorY + bodyLineH, textW, bodyLineH);
      cursorY += summaryH + medGap;
    }

    return c;
  }

  function renderQuote(article, settings, img, includeImage) {
    const cs = getCanvasSize();
    const W = cs.w;
    const H = cs.h;
    const pad = settings.padding || Math.round(W * 0.05);
    const gap = Math.round(W * 0.04);
    const rightSafePad = Math.round(W * 0.04);
    const textW = W - pad * 2;
    const textWR = textW - rightSafePad;

    const quoteFrom = article._pubQuoteFrom || '';
    const quoteOccupation = article._pubQuoteOccupation || '';
    const quoteDate = article._pubQuoteDate || '';
    const quoteText = article.summary || article.title || '';

    const quoteFontSize = Math.round(W * 0.038);
    const quoteLineH = Math.round(quoteFontSize * 1.5);
    const fromFontSize = Math.round(W * 0.043);
    const occFontSize = Math.round(W * 0.028);
    const wmFontSize = Math.round(W * 0.029);
    const dateFontSize = Math.round(W * 0.03);
    const quoteOpenSize = Math.round(W * 0.19);
    const medGap = Math.round(quoteLineH * 0.25);

    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    const c = document.createElement('canvas');
    c.width = W * dpr;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.scale(dpr, dpr);

    // Measure quote
    const quoteParagraphs = quoteText.split('\n').filter(p => p.trim());
    const paraGap = Math.round(quoteLineH * 0.5);
    ctx.font = 'italic 700 ' + quoteFontSize + 'px Georgia, "Times New Roman", serif';
    let totalQLines = 0;
    const paraLineCounts = [];
    for (const para of quoteParagraphs) {
      const n = wrapText(ctx, para, 0, 0, textWR, quoteLineH);
      paraLineCounts.push(n);
      totalQLines += n;
    }
    if (totalQLines === 0) { paraLineCounts.push(1); totalQLines = 1; }
    const qH = totalQLines * quoteLineH + Math.max(0, quoteParagraphs.length - 1) * paraGap;
    const fromH = quoteFrom ? fromFontSize : 0;

    const occLineH = Math.round(occFontSize * 1.3);
    let occLines = [];
    let occWrappedH = 0;
    if (quoteOccupation) {
      ctx.font = 'italic 700 ' + occFontSize + 'px Georgia, "Times New Roman", serif';
      const occParagraphs = quoteOccupation.split('\n');
      for (const para of occParagraphs) {
        const words = para.split(' ');
        let occLine = '';
        for (const w of words) {
          const test = occLine ? occLine + ' ' + w : w;
          if (ctx.measureText(test).width > textWR && occLine) {
            occLines.push(occLine);
            occLine = w;
          } else {
            occLine = test;
          }
        }
        if (occLine) occLines.push(occLine);
      }
      if (occLines.length > 3) occLines = occLines.slice(0, 3);
      occWrappedH = occLines.length * occLineH;
    }
    const occH = quoteOccupation ? occWrappedH : 0;
    const quoteRowH = quoteOpenSize;
    const dateBelowH = (quoteDate && quoteDate.trim()) ? dateFontSize + medGap : 0;
    const textBlockH = quoteRowH + medGap + qH + medGap * 3 + fromH + occH + medGap + medGap + wmFontSize + dateBelowH;

    const hasImg = includeImage && settings.showImage && img && img.naturalWidth > 0;

    const padTop = hasImg ? Math.round(W * 0.4) : pad;
    const padBottom = hasImg ? Math.round(W * 0.04) : pad;
    const neededH = padTop + textBlockH + padBottom;
    const canvasH = Math.max(H, neededH);
    c.height = canvasH * dpr;
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingQuality = 'high';

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, canvasH);

    if (hasImg) {
      const imgNatW = img.naturalWidth;
      const imgNatH = img.naturalHeight;
      const imgBlockH = Math.round(canvasH * 0.6);
      const zoom = settings.imageZoom || 1;
      const baseScale = Math.max(W / imgNatW, imgBlockH / imgNatH);
      const scale = baseScale * zoom;
      const imgDrawW = Math.round(imgNatW * scale);
      const imgDrawH = Math.round(imgNatH * scale);
      const offX = Math.round((settings.imageOffsetX || 0) * W);
      const offY = Math.round((settings.imageOffsetY || 0) * canvasH);
      const drawX = Math.round((W - imgDrawW) / 2) + offX;
      const drawY = Math.round((imgBlockH - imgDrawH) / 2) + offY;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, imgBlockH);
      ctx.clip();

      const rotation = settings.imageRotation || 0;
      if (rotation !== 0) {
        ctx.translate(imgBlockH / 2, W / 2);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.translate(-imgBlockH / 2, -W / 2);
      }

      const cropX = settings.imageCropX != null ? settings.imageCropX : 0.5;
      const cropY = settings.imageCropY != null ? settings.imageCropY : 0.5;
      if (imgNatW > imgDrawW * 2) {
        let curW = imgNatW, curH = imgNatH;
        let curSrc = img;
        while (curW > imgDrawW * 2) {
          const nextW = Math.max(imgDrawW, Math.floor(curW / 2));
          const nextH = Math.max(Math.round(curH * nextW / curW), 1);
          const off = document.createElement('canvas');
          off.width = nextW; off.height = nextH;
          const octx = off.getContext('2d');
          octx.imageSmoothingEnabled = true;
          octx.imageSmoothingQuality = 'high';
          octx.drawImage(curSrc, 0, 0, nextW, nextH);
          curSrc = off;
          curW = nextW; curH = nextH;
        }
        const srcVisW = Math.min(imgDrawW, curW);
        const srcVisH = Math.min(imgDrawH, curH);
        const srcX = Math.round((curW - srcVisW) * cropX);
        const srcY = Math.round((curH - srcVisH) * cropY);
        ctx.drawImage(curSrc, srcX, srcY, srcVisW, srcVisH, drawX, drawY, imgDrawW, imgDrawH);
      } else {
        const srcVisW = Math.min(imgDrawW, imgNatW);
        const srcVisH = Math.min(imgDrawH, imgNatH);
        const srcX = Math.round((imgNatW - srcVisW) * cropX);
        const srcY = Math.round((imgNatH - srcVisH) * cropY);
        ctx.drawImage(img, srcX, srcY, srcVisW, srcVisH, drawX, drawY, imgDrawW, imgDrawH);
      }

      if (rotation !== 0) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Bottom blend: where image fades to black before text
      const blendStart = settings.blendStart || 0.5;
      const blendY = Math.round(imgBlockH * blendStart);
      const botFadeH = imgBlockH - blendY;
      if (botFadeH > 0) {
        const botGrad = ctx.createLinearGradient(0, blendY, 0, imgBlockH);
        botGrad.addColorStop(0, 'rgba(0,0,0,0)');
        botGrad.addColorStop(0.4, 'rgba(0,0,0,0.25)');
        botGrad.addColorStop(0.75, 'rgba(0,0,0,0.7)');
        botGrad.addColorStop(1, 'rgba(0,0,0,1)');
        ctx.fillStyle = botGrad;
        ctx.fillRect(0, blendY, W, botFadeH);
      }

      // Vignette: side fades (only when enabled)
      if (settings.vignette) {
        const fadeW = Math.round(W * 0.18);
        const leftGrad = ctx.createLinearGradient(0, 0, fadeW, 0);
        leftGrad.addColorStop(0, 'rgba(0,0,0,0.85)');
        leftGrad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = leftGrad;
        ctx.fillRect(0, 0, fadeW, imgBlockH);
        const rightGrad = ctx.createLinearGradient(W - fadeW, 0, W, 0);
        rightGrad.addColorStop(0, 'rgba(0,0,0,0)');
        rightGrad.addColorStop(1, 'rgba(0,0,0,0.85)');
        ctx.fillStyle = rightGrad;
        ctx.fillRect(W - fadeW, 0, fadeW, imgBlockH);
      }

      ctx.restore();
    }

    // Text block
    const regionH = canvasH - padTop - padBottom;
    const textStartY = padTop + Math.max(0, Math.round((regionH - textBlockH) / 2));

    const dateText = quoteDate ? formatDateActual(quoteDate) : '';
    const rowCenterY = textStartY + Math.round(quoteRowH / 2);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ff2929';
    ctx.font = '700 ' + quoteOpenSize + 'px Georgia, "Times New Roman", serif';
    drawDualShadowTextTight(ctx, '\u201C', pad, rowCenterY);

    ctx.fillStyle = '#fff';
    ctx.font = 'italic 700 ' + quoteFontSize + 'px Georgia, "Times New Roman", serif';
    const textBoxY = textStartY + quoteRowH + medGap * 0.7;

    const shadeOp = settings.shadeOpacity || 0;
    if (shadeOp > 0 || (typeof Settings !== 'undefined' && Settings.get('quoteTextBox'))) {
      const effectiveShade = Math.max(shadeOp, shadeOp > 0 ? shadeOp : 0.45);
      const shadePad = settings.shadePadding || 14;
      const shadeCol = settings.shadeColor || '#000000';
      const r = parseInt(shadeCol.slice(1,3), 16);
      const g = parseInt(shadeCol.slice(3,5), 16);
      const b = parseInt(shadeCol.slice(5,7), 16);
      const tbPadX = shadePad;
      const tbPadY = Math.round(shadePad * 0.86);
      const boxTop = textBoxY - tbPadY;
      const contentEndY = textBoxY + qH + medGap * 6
        + (quoteFrom ? fromH + medGap : 0)
        + (quoteOccupation ? occH + medGap : 0)
        + medGap;
      const boxBottom = contentEndY + tbPadY;
      const boxH = boxBottom - boxTop;
      const boxX = pad - tbPadX;
      const boxW = textWR + tbPadX * 2;
      const boxRadius = Math.round(W * 0.012);
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(boxX, boxTop, boxW, boxH, boxRadius);
      else ctx.rect(boxX, boxTop, boxW, boxH);
      ctx.fillStyle = 'rgba(' + r + ',' + g + ',' + b + ',' + effectiveShade + ')';
      ctx.fill();
      ctx.restore();
    }

    const paraDrawPasses = [
      { color: 'rgba(0,0,0,0.9)', blur: 12, offsetY: 3 },
      { color: 'rgba(0,0,0,0.8)', blur: 6, offsetY: 1 },
      { color: 'rgba(0,0,0,0.7)', blur: 3, offsetY: 0 },
      { color: 'transparent', blur: 0, offsetY: 0 }
    ];
    for (const pass of paraDrawPasses) {
      ctx.shadowColor = pass.color;
      ctx.shadowBlur = pass.blur;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = pass.offsetY;
      let tY = textBoxY + quoteLineH;
      let pIdx = 0;
      for (const para of quoteParagraphs) {
        if (pIdx > 0) tY += paraGap;
        wrapText(ctx, para, pad, tY, textWR, quoteLineH);
        tY += paraLineCounts[pIdx] * quoteLineH;
        pIdx++;
      }
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    let afterTextY = textBoxY + qH + medGap * 6;
    if (quoteFrom) {
      const fromText = '\u2014 ' + quoteFrom;
      ctx.textBaseline = 'alphabetic';
      const fromY = afterTextY + fromFontSize;
      ctx.fillStyle = '#ff2929';
      ctx.font = '700 ' + fromFontSize + 'px Georgia, "Times New Roman", serif';
      drawDualShadowTextTight(ctx, fromText, W - pad - rightSafePad, fromY, { align: 'right' });
      afterTextY += fromH + medGap;
    }

    if (quoteOccupation && occLines.length > 0) {
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#fff';
      ctx.font = 'italic 700 ' + occFontSize + 'px Georgia, "Times New Roman", serif';
      for (let oi = 0; oi < occLines.length; oi++) {
        drawDualShadowTextTight(ctx, occLines[oi], W - pad - rightSafePad, afterTextY + occLineH * (oi + 1), { align: 'right' });
      }
      afterTextY += occH + medGap;
    }

    afterTextY += medGap;

    const sepW = Math.round(textW * 0.6);
    const sepX = W - pad - sepW;
    const sepGrad = ctx.createLinearGradient(sepX, 0, sepX + sepW, 0);
    sepGrad.addColorStop(0, 'rgba(255,255,255,0)');
    sepGrad.addColorStop(0.3, 'rgba(255,255,255,0.5)');
    sepGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.strokeStyle = sepGrad;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sepX, afterTextY);
    ctx.lineTo(sepX + sepW, afterTextY);
    ctx.stroke();
    afterTextY += medGap;

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '700 ' + wmFontSize + 'px Georgia, "Times New Roman", serif';
    ctx.textBaseline = 'alphabetic';
    drawDualShadowTextTight(ctx, 'Invisible Broadcast', pad, afterTextY + wmFontSize);
    afterTextY += wmFontSize + medGap;

    if (dateText) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.font = '700 ' + dateFontSize + 'px Georgia, "Times New Roman", serif';
      drawDualShadowTextTight(ctx, dateText, pad, afterTextY + dateFontSize);
    }

    return c;
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    const lines = [];
    const paragraphs = text.split('\n');
    for (const para of paragraphs) {
      if (para.trim() === '') { lines.push(''); continue; }
      const words = para.split(' ');
      let line = '';
      for (const word of words) {
        const test = line ? line + ' ' + word : word;
        if (ctx.measureText(test).width > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = test;
        }
      }
      if (line) lines.push(line);
    }
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], x, y + i * lineHeight);
    }
    return lines.length;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function drawDualShadowTextTight(ctx, text, x, y, opts) {
    const prevAlign = ctx.textAlign;
    if (opts && opts.align) ctx.textAlign = opts.align;
    ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;
    ctx.fillText(text, x, y);
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 2;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 1;
    ctx.fillText(text, x, y);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillText(text, x, y);
    ctx.textAlign = prevAlign;
  }

  function formatDateActual(d) {
    try {
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return '';
      return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
    } catch { return ''; }
  }

  function cleanSummary(s) {
    if (!s) return '';
    return s.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n').trim();
  }

  function stripHtml(s) {
    if (!s) return '';
    let t = s;
    // Preserve structure: block tags become newlines
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
    t = t.replace(/<(p|div|h[1-6])[^>]*>/gi, '\n');
    // List items get bullet
    t = t.replace(/<li[^>]*>/gi, '\u2022 ');
    // Strip remaining tags
    t = t.replace(/<[^>]+>/g, '');
    // Decode common entities
    t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    // Collapse runs of 3+ newlines to 2
    t = t.replace(/\n{3,}/g, '\n\n');
    return t.trim();
  }

  async function doAction(action) {
    const btn = action === 'copy'
      ? _modal.querySelector('#ce-copy-btn')
      : _modal.querySelector('#ce-download-btn');
    btn.classList.add('btn-busy');
    btn.disabled = true;
    try {
      const canvas = renderCanvas(_article, _settings, _img, _includeImage);
      if (!canvas) return;
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      if (!blob) return;

      if (action === 'copy') {
        try {
          const item = new ClipboardItem({ 'image/png': blob });
          await navigator.clipboard.write([item]);
          flashBtn(btn, 'Copied!');
        } catch {
          flashBtn(btn, 'Copy failed');
        }
      } else {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        const cs = getCanvasSize();
        const ratioSlug = _settings.aspectRatio.replace(':', 'x');
        a.download = 'invisible-broadcast-' + ratioSlug + '.png';
        a.click();
        URL.revokeObjectURL(a.href);
        flashBtn(btn, 'Downloaded!');
      }

      if (_onComplete) {
        try { _onComplete(canvas, blob); } catch {}
      }
    } catch (e) {
      console.warn('[CanvasEditor] action failed:', e.message);
      flashBtn(btn, 'Failed');
    } finally {
      btn.classList.remove('btn-busy');
      btn.disabled = false;
    }
  }

  function flashBtn(btn, msg) {
    const orig = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }

  function open(article, includeImage, loadedImg, onComplete) {
    _article = article;
    _includeImage = includeImage;
    _img = loadedImg;
    _onComplete = onComplete || null;
    _settings = defaults();
    const modal = buildModal();
    // Sync control values
    const syncMap = [
      ['ce-zoom', _settings.imageZoom],
      ['ce-rotate', _settings.imageRotation],
      ['ce-cropx', _settings.imageCropX],
      ['ce-cropy', _settings.imageCropY],
      ['ce-imgheight', _settings.imageHeight],
      ['ce-offsetx', _settings.imageOffsetX],
      ['ce-offsety', _settings.imageOffsetY],
      ['ce-padding', _settings.padding],
      ['ce-textpos', _settings.textPosition],
      ['ce-blend', _settings.blendStart],
      ['ce-shade', _settings.shadeOpacity],
      ['ce-shadepadding', _settings.shadePadding],
      ['ce-titlefontsize', _settings.titleFontSize],
      ['ce-bodyfontsize', _settings.bodyFontSize],
    ];
    syncMap.forEach(([id, val]) => {
      const el = modal.querySelector('#' + id);
      if (el) el.value = val;
    });
    modal.querySelector('#ce-showimage').checked = _settings.showImage;
    modal.querySelector('#ce-vignette').checked = _settings.vignette;
    // Reset shade state
    const shadeOn = _settings.shadeOpacity > 0;
    modal.querySelector('#ce-shadeenabled').checked = shadeOn;
    modal.querySelector('#ce-shade-options').style.display = shadeOn ? '' : 'none';
    modal.querySelector('#ce-shadecolor').value = _settings.shadeColor;
    modal.querySelector('#ce-shadecolor-val').textContent = _settings.shadeColor;
    modal.querySelector('#ce-bodycolorraw').value = _settings.bodyColorRaw;
    modal.querySelector('#ce-bodycolorraw-val').textContent = _settings.bodyColorRaw;
    // Show/hide image section
    const imgSection = modal.querySelector('#ce-image-section');
    if (imgSection) imgSection.style.display = (includeImage && loadedImg) ? '' : 'none';
    // Reset color selections
    modal.querySelectorAll('#ce-title-colors .ce-color-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.color === _settings.titleColor);
    });
    modal.querySelectorAll('#ce-body-colors .ce-color-btn').forEach((b, i) => {
      b.classList.toggle('active', i === 0);
    });
    // Reset ratio selection
    modal.querySelectorAll('.ce-ratio-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.ratio === _settings.aspectRatio);
    });
    const cs = getCanvasSize();
    modal.querySelector('#ce-ratio-dim').textContent = cs.w + ' × ' + cs.h;
    // Update value labels
    modal.querySelector('#ce-zoom-val').textContent = _settings.imageZoom + 'x';
    modal.querySelector('#ce-rotate-val').textContent = _settings.imageRotation + '\u00B0';
    modal.querySelector('#ce-cropx-val').textContent = Math.round(_settings.imageCropX * 100) + '%';
    modal.querySelector('#ce-cropy-val').textContent = Math.round(_settings.imageCropY * 100) + '%';
    modal.querySelector('#ce-imgheight-val').textContent = Math.round(_settings.imageHeight * 100) + '%';
    modal.querySelector('#ce-pad-val').textContent = _settings.padding + 'px';
    modal.querySelector('#ce-textpos-val').textContent = Math.round(_settings.textPosition * 100) + '%';
    modal.querySelector('#ce-blend-val').textContent = Math.round(_settings.blendStart * 100) + '%';
    modal.querySelector('#ce-shade-val').textContent = Math.round(_settings.shadeOpacity * 100) + '%';
    modal.querySelector('#ce-shadepadding-val').textContent = _settings.shadePadding + 'px';
    modal.querySelector('#ce-offsetx-val').textContent = Math.round(_settings.imageOffsetX * 100) + '%';
    modal.querySelector('#ce-offsety-val').textContent = Math.round(_settings.imageOffsetY * 100) + '%';
    modal.querySelector('#ce-titlefontsize-val').textContent = _settings.titleFontSize === 0 ? 'auto' : _settings.titleFontSize + 'px';
    modal.querySelector('#ce-bodyfontsize-val').textContent = _settings.bodyFontSize === 0 ? 'auto' : _settings.bodyFontSize + 'px';
    // Reset divider: preview takes 55%, controls 45%
    const previewWrap = modal.querySelector('#ce-preview-wrap');
    const controlsEl = modal.querySelector('#ce-controls');
    previewWrap.style.flex = '';
    previewWrap.style.height = '';
    controlsEl.style.flex = '';
    // Show modal
    modal.classList.add('open');
    document.body.classList.add('modal-open');
    // Render preview
    schedulePreview();
  }

  function close() {
    if (_modal) {
      _modal.classList.remove('open');
      document.body.classList.remove('modal-open');
    }
    if (_animFrame) { cancelAnimationFrame(_animFrame); _animFrame = null; }
    _article = null;
    _img = null;
  }

  window.CanvasEditor = { open, close, renderCanvas };
})();
