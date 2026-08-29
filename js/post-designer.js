// @ts-nocheck
// ── Post Designer ──
// Canvas-based post designer for title + description posts.
// Provides shape selection, dynamic color system, text effects,
// background removal, and per-post settings persistence via Supabase.
//
// Exposed as window.PostDesigner
const PostDesigner = (() => {
    /* ── Constants ── */
    const SHAPES = {
        square: { label: 'Square', clipPath: 'inset(5% round 4px)' },
        rectangle: { label: 'Rectangle', clipPath: 'inset(5% round 8px)' },
        hexagon: { label: 'Hexagon', clipPath: 'polygon(25% 2%, 75% 2%, 98% 50%, 75% 98%, 25% 98%, 2% 50%)' },
        cloud: { label: 'Cloud', clipPath: 'polygon(15% 70%, 5% 55%, 8% 40%, 15% 30%, 25% 25%, 30% 15%, 42% 10%, 55% 12%, 62% 20%, 70% 15%, 80% 18%, 88% 28%, 92% 40%, 90% 55%, 82% 68%, 75% 72%, 65% 75%, 55% 78%, 40% 80%, 28% 78%)' },
        speech: { label: 'Speech Bubble', clipPath: 'polygon(0% 0%, 100% 0%, 100% 75%, 35% 75%, 20% 100%, 25% 75%, 0% 75%)' },
        quoteSil: { label: 'Quote Mark', clipPath: 'ellipse(42% 38% at 45% 48%)' },
    };
    const TEXT_EFFECTS = ['none', 'shadow', 'outline', 'glow', 'gradient'];
    const GRADIENT_PRESETS = [
        'linear-gradient(135deg, #0f0c29, #302b63, #24243e)',
        'linear-gradient(135deg, #141e30, #243b55)',
        'linear-gradient(135deg, #1a1a2e, #16213e, #0f3460)',
        'linear-gradient(135deg, #0d1117, #161b22, #21262d)',
        'linear-gradient(135deg, #232526, #414345)',
        'linear-gradient(135deg, #1f1c2c, #928dab)',
        'linear-gradient(135deg, #0f2027, #203a43, #2c5364)',
        'linear-gradient(135deg, #200122, #6f0000)',
        'linear-gradient(135deg, #1d0b1e, #3d1c3e, #5c2d5e)',
        'linear-gradient(135deg, #0b0b0f, #1a1a2e)',
        'linear-gradient(135deg, #0a0a12, #1a0a2e, #0a1a3e)',
        'linear-gradient(135deg, #0d0d0d, #1a1a1a, #2d2d2d)',
    ];
    function randomGradient() {
        const h1 = Math.floor(Math.random() * 360);
        const h2 = (h1 + 30 + Math.floor(Math.random() * 120)) % 360;
        const h3 = (h2 + 30 + Math.floor(Math.random() * 120)) % 360;
        const s1 = 40 + Math.floor(Math.random() * 50);
        const s2 = 40 + Math.floor(Math.random() * 50);
        const s3 = 40 + Math.floor(Math.random() * 50);
        const l1 = 10 + Math.floor(Math.random() * 25);
        const l2 = 15 + Math.floor(Math.random() * 30);
        const l3 = 10 + Math.floor(Math.random() * 25);
        const c1 = 'hsl(' + h1 + ',' + s1 + '%,' + l1 + '%)';
        const c2 = 'hsl(' + h2 + ',' + s2 + '%,' + l2 + '%)';
        const c3 = 'hsl(' + h3 + ',' + s3 + '%,' + l3 + '%)';
        const angle = Math.floor(Math.random() * 360);
        return 'linear-gradient(' + angle + 'deg, ' + c1 + ', ' + c2 + ', ' + c3 + ')';
    }
    const COLOR_PALETTE = [
        '#ffffff','#c0c0c0','#808080','#404040','#000000','#ff0000','#ff6600','#ffcc00',
        '#33cc33','#0099ff','#0033cc','#6633cc','#ff3399','#ff99cc','#cc6633','#669933',
        '#006666','#333399','#993366','#cc0000','#ff3300','#ff9900','#ffff00','#00ff00',
        '#00ffcc','#00ccff','#0066ff','#3300ff','#cc00ff','#ff00ff','#ff6699','#993300',
        '#66cc99','#6666ff','#cc99ff','#ffcc99','#336666','#660033','#003300','#000066',
    ];
    function createColorPicker(container, opts) {
        const { id, value, onInput } = opts;
        const wrap = document.createElement('div');
        wrap.className = 'qcp-wrap';
        const swatch = document.createElement('button');
        swatch.className = 'qcp-swatch';
        swatch.type = 'button';
        const inner = document.createElement('span');
        inner.className = 'qcp-swatch-inner';
        inner.style.background = value || '#ffffff';
        swatch.appendChild(inner);
        const hexInput = document.createElement('input');
        hexInput.className = 'qcp-hex-input';
        hexInput.type = 'text';
        hexInput.value = (value || '#ffffff').replace(/[^#0-9a-fA-F]/g, '').slice(0, 7);
        const dropdown = document.createElement('div');
        dropdown.className = 'qcp-dropdown';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'qcp-close';
        closeBtn.textContent = '\u00d7';
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); dropdown.classList.remove('open'); });
        dropdown.appendChild(closeBtn);
        const grid = document.createElement('div');
        grid.className = 'qcp-grid';
        COLOR_PALETTE.forEach(c => {
            const cell = document.createElement('button');
            cell.className = 'qcp-cell';
            cell.type = 'button';
            cell.style.background = c;
            cell.title = c;
            if (c.toLowerCase() === (value || '').toLowerCase()) cell.classList.add('active');
            cell.addEventListener('click', (e) => {
                e.stopPropagation();
                applyColor(c);
            });
            grid.appendChild(cell);
        });
        dropdown.appendChild(grid);
        const row = document.createElement('div');
        row.className = 'qcp-row';
        const lbl = document.createElement('label');
        lbl.textContent = 'Hex';
        const hexFull = document.createElement('input');
        hexFull.type = 'text';
        hexFull.value = (value || '#ffffff').slice(0, 7);
        hexFull.placeholder = '#000000';
        row.appendChild(lbl);
        row.appendChild(hexFull);
        dropdown.appendChild(row);
        function applyColor(c) {
            if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
            inner.style.background = c;
            hexInput.value = c;
            hexFull.value = c;
            grid.querySelectorAll('.qcp-cell').forEach(cl => cl.classList.toggle('active', cl.title.toLowerCase() === c.toLowerCase()));
            if (onInput) onInput(c);
        }
        swatch.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = dropdown.classList.contains('open');
            document.querySelectorAll('.qcp-dropdown.open').forEach(d => d.classList.remove('open'));
            if (!wasOpen) dropdown.classList.add('open');
        });
        hexInput.addEventListener('change', () => { applyColor(hexInput.value); });
        hexInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyColor(hexInput.value); });
        hexFull.addEventListener('change', () => { applyColor(hexFull.value); });
        hexFull.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyColor(hexFull.value); });
        wrap.appendChild(swatch);
        wrap.appendChild(hexInput);
        wrap.appendChild(dropdown);
        container.appendChild(wrap);
        document.addEventListener('click', () => { dropdown.classList.remove('open'); });
        return {
            setValue(c) { applyColor(c); },
            getValue() { return hexInput.value; },
            element: wrap,
        };
    }
    function enhanceColorInputs(root) {
        root.querySelectorAll('input[type="color"]').forEach(inp => {
            const picker = createColorPicker(inp.parentNode, {
                id: inp.id,
                value: inp.value,
                onInput: (c) => { inp.value = c; inp.dispatchEvent(new Event('input', { bubbles: true })); },
            });
            inp.style.display = 'none';
        });
    }
    const FONT_FAMILIES = [
        'Tahoma, Geneva, sans-serif',
        'Verdana, Geneva, sans-serif',
        'Garamond, serif',
        'Georgia, "Times New Roman", serif',
        '"Playfair Display", Georgia, serif',
        '"Raleway", sans-serif',
        '"Montserrat", sans-serif',
        '"Open Sans", sans-serif',
        '"Lato", sans-serif',
        '"Inter", sans-serif',
        '"Plus Jakarta Sans", sans-serif',
        '"DM Sans", sans-serif',
        '"Poppins", sans-serif',
        '"Nunito", sans-serif',
        '"Lora", Georgia, serif',
        '"Source Serif 4", Georgia, serif',
        '"Instrument Serif", Georgia, serif',
        '"Instrument Sans", sans-serif',
        '"Clash Display", sans-serif',
        '"Geist", sans-serif',
        '"Satoshi", sans-serif',
        '"Fraunces", Georgia, serif',
        'Impact, "Arial Black", sans-serif',
        '"Trebuchet MS", sans-serif',
        'Palatino, "Book Antiqua", serif',
        '"Courier New", Courier, monospace',
        '"Lucida Console", Monaco, monospace',
    ];
    function defaultFgImage(seq) {
        return {
            seq: seq || 0,
            dataUrl: null,
            bgRemovedDataUrl: null,
            removeBgEnabled: false,
            scale: 100,
            scaleEnabled: false,
            cropEnabled: false,
            cropLeft: 0,
            cropRight: 0,
            cropTop: 0,
            cropBottom: 0,
            posEnabled: false,
            posTop: -1,
            posLeft: -1,
            zIndex: 50,
            borderEnabled: false,
            borderStyle: 'none',
            borderColor: '#ffffff',
            borderOpacity: 100,
            borderGradient: 'linear-gradient(135deg, #ffffff, #888888)',
            borderWidth: 4,
            edgeEnabled: false,
            edgeEffect: 'none',
            edgeIntensity: 50,
        };
    }
    function defaultSettings() {
        return {
            titleShape: 'rectangle',
            titleShapeWidth: 100,
            titleRoundness: 2,
            titleShapePosY: 50,
            titleShapeOffsetX: 0,
            titleShapeOffsetY: 0,
            descShape: 'rectangle',
            descShapeWidth: 100,
            descRoundness: 2,
            descShapePosY: 60,
            descShapeOffsetX: 0,
            descShapeOffsetY: 0,
            textPadTop: 40,
            textPadRight: 30,
            textPadBottom: 40,
            textPadLeft: 30,
            containerColor: '#000000',
            containerBorderWidth: 3,
            containerBorderColor: '#ffffff',
            containerBorderStyle: 'solid',
            containerBorderGradient: 'linear-gradient(135deg, #ffffff, #888888)',
            containerBorderGradientAngle: 135,
            containerOpacity: 30,
            containerBorderRadius: 12,
            roundness: 4,
            shapeGap: 30,
            separator: {
                show: false,
                thickness: 2,
                width: 80,
                color: '#ffffff',
                length: 30,
                topOffset: 0,
                leftOffset: 0,
            },

            cardBackground: GRADIENT_PRESETS[Math.floor(Math.random() * GRADIENT_PRESETS.length)],
            cardBgType: 'gradient',
            bgImageFit: 'cover',
            bgFillEmpty: false,
            bgEdgeOverlay: 'none',
            bgEdgeLR: 0,
            bgEdgeTB: 0,
            bgCrop: false,
            bgCropLR: 0,
            bgCropTB: 0,
            bgOffsetX: 0,
            bgOffsetY: 0,
            bgPosEnabled: false,
            bgImageScale: 100,
            bgImageScaleEnabled: false,
            borderStyle: 'none',
            borderPlacement: 'all',
            borderColor: '#ffffff',
            borderOpacity: 100,
            borderGradient: 'linear-gradient(135deg, #ffffff, #888888)',
            borderWidth: 0,
            textAlignment: 'left',
            textVerticalAlign: 'center',
            fgImages: [],
            aspectRatio: '9:16',

            title: {
                fontSize: 22, color: '#ffffff', fontFamily: FONT_FAMILIES[0],
                bold: true, italic: false, underline: false, show: true,
                textEffect: 'shadow', textEffectColor: '#000000', textEffectIntensity: 3, opacity: 100,
                _forced: true,
            },
            description: {
                fontSize: 14, color: '#ffffff', fontFamily: FONT_FAMILIES[0],
                bold: false, italic: false, underline: false, show: true,
                textEffect: 'none', textEffectColor: '#000000', textEffectIntensity: 2, opacity: 85,
            },
            watermark: {
                fontSize: 22, color: '#ffffff', fontFamily: FONT_FAMILIES[0],
                bold: true, italic: false, underline: false, show: true,
                textEffect: 'none', textEffectColor: '#000000', textEffectIntensity: 0, opacity: 60,
            },
            date: {
                fontSize: 22, color: '#ffffff', fontFamily: FONT_FAMILIES[0],
                bold: true, italic: false, underline: false, show: true,
                textEffect: 'none', textEffectColor: '#000000', textEffectIntensity: 0, opacity: 60,
            },
        };
    }
    /* ── Luminance / Contrast Helpers ── */
    function parseColor(str) {
        if (!str)
            return { r: 0, g: 0, b: 0 };
        const temp = document.createElement('div');
        temp.style.color = str;
        document.body.appendChild(temp);
        const computed = getComputedStyle(temp).color;
        document.body.removeChild(temp);
        const m = computed.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m)
            return { r: 0, g: 0, b: 0 };
        return { r: +m[1], g: +m[2], b: +m[3] };
    }
    function relativeLuminance(r, g, b) {
        const a = [r, g, b].map(v => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    }
    function isDarkColor(colorStr) {
        const c = parseColor(colorStr);
        return relativeLuminance(c.r, c.g, c.b) < 0.4;
    }
    function smartContrast(bgColor) {
        if (isDarkColor(bgColor)) {
            return {
                containerColor: 'rgba(255,255,255,0.85)',
                textColor: '#111111',
                containerBorder: '#cccccc',
            };
        }
        return {
            containerColor: 'rgba(0,0,0,0.7)',
            textColor: '#ffffff',
            containerBorder: '#333333',
        };
    }
    /* ── SVG Shape Paths (for canvas export) ── */
    function getShapeCanvasPath(shape, cx, cy, w, h) {
        const path = new Path2D();
        const roundness = (_settings.roundness || 4) / 100;
        switch (shape) {
            case 'square': {
                const s = Math.min(w, h) * 0.85;
                const x = cx - s / 2, y = cy - s / 2;
                const r = s * roundness;
                if (r > 0) {
                    path.moveTo(x + r, y);
                    path.lineTo(x + s - r, y);
                    path.quadraticCurveTo(x + s, y, x + s, y + r);
                    path.lineTo(x + s, y + s - r);
                    path.quadraticCurveTo(x + s, y + s, x + s - r, y + s);
                    path.lineTo(x + r, y + s);
                    path.quadraticCurveTo(x, y + s, x, y + s - r);
                    path.lineTo(x, y + r);
                    path.quadraticCurveTo(x, y, x + r, y);
                    path.closePath();
                } else {
                    path.rect(x, y, s, s);
                }
                break;
            }
            case 'rectangle': {
                const rx = cx - w * 0.42, ry = cy - h * 0.38;
                const rw = w * 0.84, rh = h * 0.76;
                const r = Math.min(rw, rh) * roundness;
                if (r > 0) {
                    path.moveTo(rx + r, ry);
                    path.lineTo(rx + rw - r, ry);
                    path.quadraticCurveTo(rx + rw, ry, rx + rw, ry + r);
                    path.lineTo(rx + rw, ry + rh - r);
                    path.quadraticCurveTo(rx + rw, ry + rh, rx + rw - r, ry + rh);
                    path.lineTo(rx + r, ry + rh);
                    path.quadraticCurveTo(rx, ry + rh, rx, ry + rh - r);
                    path.lineTo(rx, ry + r);
                    path.quadraticCurveTo(rx, ry, rx + r, ry);
                    path.closePath();
                } else {
                    path.rect(rx, ry, rw, rh);
                }
                break;
            }
            case 'hexagon': {
                const hexR = Math.min(w, h) * 0.48;
                const cornerR = hexR * roundness * 2;
                const points = [];
                for (let i = 0; i < 6; i++) {
                    const angle = (i * 2 * Math.PI / 6) - Math.PI / 6;
                    points.push({
                        x: cx + hexR * Math.cos(angle),
                        y: cy + hexR * Math.sin(angle)
                    });
                }
                if (cornerR > 0) {
                    for (let i = 0; i < 6; i++) {
                        const prev = points[(i + 5) % 6];
                        const curr = points[i];
                        const next = points[(i + 1) % 6];
                        const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y;
                        const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
                        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
                        const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                        const t = Math.min(cornerR / len1, 0.5);
                        const t2 = Math.min(cornerR / len2, 0.5);
                        const sx = curr.x - dx1 * t, sy = curr.y - dy1 * t;
                        const ex = curr.x + dx2 * t2, ey = curr.y + dy2 * t2;
                        if (i === 0) path.moveTo(sx, sy);
                        else path.lineTo(sx, sy);
                        path.quadraticCurveTo(curr.x, curr.y, ex, ey);
                    }
                    path.closePath();
                } else {
                    for (let i = 0; i < 6; i++) {
                        i === 0 ? path.moveTo(points[i].x, points[i].y) : path.lineTo(points[i].x, points[i].y);
                    }
                    path.closePath();
                }
                break;
            }
            case 'cloud': {
                const cw = w * 0.92, ch = h * 0.70;
                const x0 = cx - cw / 2, y0 = cy - ch / 2;
                const bumps = [
                    { x: cw * 0.15, y: ch * 0.1, rx: cw * 0.18, ry: ch * 0.32 },
                    { x: cw * 0.38, y: ch * -0.05, rx: cw * 0.22, ry: ch * 0.38 },
                    { x: cw * 0.62, y: ch * 0.0, rx: cw * 0.2, ry: ch * 0.35 },
                    { x: cw * 0.82, y: ch * 0.12, rx: cw * 0.17, ry: ch * 0.3 },
                    { x: cw * 0.28, y: ch * 0.3, rx: cw * 0.35, ry: ch * 0.22 },
                    { x: cw * 0.58, y: ch * 0.28, rx: cw * 0.32, ry: ch * 0.24 },
                ];
                for (const b of bumps) {
                    path.ellipse(x0 + b.x, y0 + b.y, b.rx, b.ry, 0, 0, Math.PI * 2);
                }
                break;
            }
            case 'speech': {
                const bw = w * 0.84, bh = h * 0.60;
                const bx = cx - bw / 2, by = cy - bh / 2 - h * 0.05;
                const r = Math.min(bw, bh) * roundness * 0.45;
                const tail = _settings.tailPosition || 'bl';
                path.moveTo(bx + r, by);
                path.lineTo(bx + bw - r, by);
                path.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
                path.lineTo(bx + bw, by + bh - r);
                path.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
                // Tail on appropriate edge, then continue perimeter
                if (tail === 'bl') {
                    path.lineTo(bx + bw * 0.35, by + bh);
                    path.lineTo(bx + bw * 0.15, by + bh + h * 0.15);
                    path.lineTo(bx + bw * 0.25, by + bh);
                } else if (tail === 'br') {
                    path.lineTo(bx + bw * 0.75, by + bh);
                    path.lineTo(bx + bw * 0.85, by + bh + h * 0.15);
                    path.lineTo(bx + bw * 0.65, by + bh);
                }
                path.lineTo(bx + r, by + bh);
                path.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
                path.lineTo(bx, by + r);
                if (tail === 'tl') {
                    path.lineTo(bx, by + r);
                    path.quadraticCurveTo(bx, by, bx + r, by);
                    path.closePath();
                    // Rebuild with tail at top-left
                    path.moveTo(bx + bw * 0.25, by);
                    path.lineTo(bx + bw * 0.15, by - h * 0.15);
                    path.lineTo(bx + bw * 0.35, by);
                    // Continue the full shape from scratch
                    const sp = new Path2D();
                    sp.moveTo(bx + r, by);
                    sp.lineTo(bx + bw * 0.25, by);
                    sp.lineTo(bx + bw * 0.15, by - h * 0.15);
                    sp.lineTo(bx + bw * 0.35, by);
                    sp.lineTo(bx + bw - r, by);
                    sp.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
                    sp.lineTo(bx + bw, by + bh - r);
                    sp.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
                    sp.lineTo(bx + r, by + bh);
                    sp.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
                    sp.lineTo(bx, by + r);
                    sp.quadraticCurveTo(bx, by, bx + r, by);
                    sp.closePath();
                    return sp;
                } else if (tail === 'tr') {
                    path.lineTo(bx, by + r);
                    path.quadraticCurveTo(bx, by, bx + r, by);
                    path.closePath();
                    // Rebuild with tail at top-right
                    const sp = new Path2D();
                    sp.moveTo(bx + r, by);
                    sp.lineTo(bx + bw * 0.65, by);
                    sp.lineTo(bx + bw * 0.85, by - h * 0.15);
                    sp.lineTo(bx + bw * 0.75, by);
                    sp.lineTo(bx + bw - r, by);
                    sp.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
                    sp.lineTo(bx + bw, by + bh - r);
                    sp.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
                    sp.lineTo(bx + r, by + bh);
                    sp.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
                    sp.lineTo(bx, by + r);
                    sp.quadraticCurveTo(bx, by, bx + r, by);
                    sp.closePath();
                    return sp;
                }
                path.quadraticCurveTo(bx, by, bx + r, by);
                path.closePath();
                break;
            }
            case 'quoteSil': {
                const qs = Math.min(w, h) * 0.7;
                const qx = cx - qs * 0.35, qy = cy - qs * 0.15;
                path.moveTo(qx, qy);
                path.quadraticCurveTo(qx, qy - qs * 0.45, qx + qs * 0.22, qy - qs * 0.45);
                path.quadraticCurveTo(qx + qs * 0.42, qy - qs * 0.45, qx + qs * 0.42, qy - qs * 0.28);
                path.quadraticCurveTo(qx + qs * 0.42, qy - qs * 0.12, qx + qs * 0.22, qy - qs * 0.06);
                path.lineTo(qx + qs * 0.18, qy + qs * 0.12);
                path.quadraticCurveTo(qx, qy + qs * 0.05, qx, qy);
                path.closePath();
                const q2x = qx + qs * 0.32, q2y = qy;
                path.moveTo(q2x, q2y);
                path.quadraticCurveTo(q2x, q2y - qs * 0.45, q2x + qs * 0.22, q2y - qs * 0.45);
                path.quadraticCurveTo(q2x + qs * 0.42, q2y - qs * 0.45, q2x + qs * 0.42, q2y - qs * 0.28);
                path.quadraticCurveTo(q2x + qs * 0.42, q2y - qs * 0.12, q2x + qs * 0.22, q2y - qs * 0.06);
                path.lineTo(q2x + qs * 0.18, q2y + qs * 0.12);
                path.quadraticCurveTo(q2x, q2y + qs * 0.05, q2x, q2y);
                path.closePath();
                break;
            }
            default:
                path.rect(cx - w * 0.42, cy - h * 0.38, w * 0.84, h * 0.76);
        }
        return path;
    }
    function getClipPathCSS(shape) {
        const def = SHAPES[shape];
        return def ? def.clipPath : 'none';
    }
    /* Returns the fraction of container (w, h) the shape actually occupies.
       Text must be constrained inside these bounds. */
    function getShapeBounds(shape) {
        switch (shape) {
            case 'square':   return { wFrac: 0.85, hFrac: 0.85 };
            case 'rectangle':return { wFrac: 0.84, hFrac: 0.76 };
            case 'hexagon':  return { wFrac: 0.80, hFrac: 0.80 };
            case 'cloud':    return { wFrac: 0.92, hFrac: 0.78 };
            case 'speech':   return { wFrac: 0.80, hFrac: 0.60 };
            case 'quoteSil': return { wFrac: 0.70, hFrac: 0.60 };
            default:         return { wFrac: 0.84, hFrac: 0.76 };
        }
    }
    function escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    /* ── Module State ── */
    let _modal = null;
    let _settings = defaultSettings();
    let _article = null;
    let _bgImage = null;
    let _fgImages = [];
    let _articleId = null;
    let _cardMeta = null;
    let _userId = null;
    let _storageKey = null;
    let _deletedFgPaths = [];
    let _onComplete = null;
    let _previewDebounce = null;
    /* ── Helper: Build a collapsible element section ── */
    function buildElementSection(prefix, label, sectionId) {
        const fontOpts = FONT_FAMILIES.map((f, i) =>
            `<option value="${f.replace(/"/g, '&quot;')}">${f.split(',')[0].replace(/"/g, '')}</option>`
        ).join('');
        return `
        <div class="qcs-collapsible">
          <div class="qcs-collapsible-header" data-target="${sectionId}">
            <span class="qcs-collapsible-label"><label class="qcs-toggle-row qcs-collapsible-toggle"><input type="checkbox" id="qcs-${prefix}-show" checked> ${label}</label></span>
            <span class="qcs-chevron">&#9660;</span>
          </div>
          <div class="qcs-collapsible-body" id="${sectionId}">
            <label class="qcs-label">Size <span class="qcs-val" id="qcs-${prefix}-size-val">28px</span></label>
            <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-${prefix}-size" min="8" max="120" step="1" value="28"><button class="qcs-reset-btn" data-reset="qcs-${prefix}-size" title="Reset">&#x21bb;</button></div>
            <label class="qcs-label">Color</label>
            <input type="color" id="qcs-${prefix}-color" value="#ffffff" class="qcs-color-input">
            <label class="qcs-label">Font</label>
            <select class="qcs-select" id="qcs-${prefix}-font">${fontOpts}</select>
            <label class="qcs-label">Style</label>
            <div class="qcs-style-row" id="qcs-${prefix}-style-row">
              <button class="qcs-style-btn" data-style="bold"><b>B</b></button>
              <button class="qcs-style-btn" data-style="italic"><i>I</i></button>
              <button class="qcs-style-btn" data-style="underline"><u>U</u></button>
            </div>
            <label class="qcs-label">Opacity <span class="qcs-val" id="qcs-${prefix}-opacity-val">100%</span></label>
            <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-${prefix}-opacity" min="5" max="100" step="1" value="100"><button class="qcs-reset-btn" data-reset="qcs-${prefix}-opacity" title="Reset">&#x21bb;</button></div>
            <div class="qcs-section" style="margin-top:8px">
              <div class="qcs-section-title">Text Effect</div>
              <div class="qcs-effect-grid" id="qcs-${prefix}-effect-grid">
                <button class="qcs-effect-btn active" data-effect="none">None</button>
                <button class="qcs-effect-btn" data-effect="shadow">Shadow</button>
                <button class="qcs-effect-btn" data-effect="outline">Outline</button>
                <button class="qcs-effect-btn" data-effect="glow">Glow</button>
                <button class="qcs-effect-btn" data-effect="gradient">Gradient</button>
              </div>
              <div id="qcs-${prefix}-effect-opts" style="display:none">
                <label class="qcs-label">Effect Color</label>
                <input type="color" id="qcs-${prefix}-effect-color" value="#000000" class="qcs-color-input">
                <label class="qcs-label">Intensity <span class="qcs-val" id="qcs-${prefix}-effect-int-val">2</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-${prefix}-effect-int" min="1" max="8" step="1" value="2"><button class="qcs-reset-btn" data-reset="qcs-${prefix}-effect-int" title="Reset">&#x21bb;</button></div>
              </div>
            </div>
          </div>
        </div>`;
    }
    /* ── Build Modal ── */
    function buildModal() {
        if (_modal)
            return _modal;
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay qcs-overlay';
        overlay.id = 'qcs-overlay';
        overlay.innerHTML = `
      <div class="modal qcs-modal">
        <div class="modal-header">
          <button class="modal-close qcs-close" aria-label="Close">&times;</button>
          <h2><span class="h2-icon">&#x1F4DD;</span> Post Designer</h2>
        </div>
        <div class="modal-body qcs-body">
          <div class="qcs-preview-wrap" id="qcs-preview-wrap">
            <canvas id="qcs-preview-canvas"></canvas>
          </div>
          <div class="qcs-divider" id="qcs-divider"><div class="qcs-divider-handle"></div></div>
          <div class="qcs-controls" id="qcs-controls">

            <!-- Layout tab -->
            <div class="qcs-tab-bar">
              <button class="qcs-tab active" data-pd-tab="layout">Layout</button>
              <button class="qcs-tab" data-pd-tab="titleShape">Title Shape</button>
              <button class="qcs-tab" data-pd-tab="descShape">Desc Shape</button>
              <button class="qcs-tab" data-pd-tab="separator">Separator</button>
              <button class="qcs-tab" data-pd-tab="colors">Colors</button>
              <button class="qcs-tab" data-pd-tab="text">Text</button>
              <button class="qcs-tab" data-pd-tab="images">Images</button>
            </div>

            <!-- Layout Tab -->
            <div class="qcs-tab-pane active" data-pd-pane="layout">
              <div class="qcs-section">
                <div class="qcs-section-title">Aspect Ratio</div>
                <div class="qcs-ratio-grid" id="qcs-ratio-grid">
                  <button class="qcs-ratio-btn active" data-ratio="9:16">9:16</button>
                  <button class="qcs-ratio-btn" data-ratio="4:3">4:3</button>
                  <button class="qcs-ratio-btn" data-ratio="3:4">3:4</button>
                  <button class="qcs-ratio-btn" data-ratio="16:9">16:9</button>
                  <button class="qcs-ratio-btn" data-ratio="1:1">1:1</button>
                </div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Watermark</div>
                <label class="qcs-toggle-row">
                  <input type="checkbox" id="qcs-watermark-toggle" checked> Show watermark
                </label>
                <label class="qcs-toggle-row">
                  <input type="checkbox" id="qcs-date-toggle" checked> Show date
                </label>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Group Position</div>
                <div class="qcs-ratio-grid" id="qcs-group-pos-grid">
                  <button class="qcs-ratio-btn" data-gpos="15">Top</button>
                  <button class="qcs-ratio-btn active" data-gpos="50">Medium</button>
                  <button class="qcs-ratio-btn" data-gpos="75">Bottom</button>
                </div>
                <label class="qcs-label" style="margin-top:6px">Position % <span class="qcs-val" id="qcs-gpos-val">${_settings.titleShapePosY}%</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-gpos" min="10" max="88" step="1" value="${_settings.titleShapePosY}"><button class="qcs-reset-btn" data-reset="qcs-gpos" title="Reset">&#x21bb;</button></div>
              </div>
            </div>

            <!-- Title Shape Tab -->
            <div class="qcs-tab-pane" data-pd-pane="titleShape">
              <div class="qcs-section">
                <div class="qcs-section-title">Title Shape</div>
                <div class="qcs-shape-grid" id="qcs-title-shape-grid">
                  ${Object.entries(SHAPES).map(([k, v]) => `<button class="qcs-shape-btn${k === _settings.titleShape ? ' active' : ''}" data-shape="${k}" title="${v.label}">
                      <span class="qcs-shape-icon" data-shape-icon="${k}"></span>
                      <span class="qcs-shape-label">${v.label}</span>
                    </button>`).join('')}
                </div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Title Shape Size</div>
                <label class="qcs-label">Width <span class="qcs-val" id="qcs-tsw-val">${_settings.titleShapeWidth}%</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-tsw" min="20" max="100" step="1" value="${_settings.titleShapeWidth}"><button class="qcs-reset-btn" data-reset="qcs-tsw" title="Reset">&#x21bb;</button></div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Title Position</div>
                <label class="qcs-label">Position Y <span class="qcs-val" id="qcs-tpy-val">${_settings.titleShapePosY}%</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-tpy" min="10" max="88" step="1" value="${_settings.titleShapePosY}"><button class="qcs-reset-btn" data-reset="qcs-tpy" title="Reset">&#x21bb;</button></div>
                <label class="qcs-label">Offset X <span class="qcs-val" id="qcs-tox-val">${_settings.titleShapeOffsetX}%</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-tox" min="-30" max="30" step="1" value="${_settings.titleShapeOffsetX}"><button class="qcs-reset-btn" data-reset="qcs-tox" title="Reset">&#x21bb;</button></div>
                <label class="qcs-label">Offset Y <span class="qcs-val" id="qcs-toy-val">${_settings.titleShapeOffsetY}%</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-toy" min="-30" max="30" step="1" value="${_settings.titleShapeOffsetY}"><button class="qcs-reset-btn" data-reset="qcs-toy" title="Reset">&#x21bb;</button></div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Gap Between Shapes</div>
                <label class="qcs-label">Gap <span class="qcs-val" id="qcs-gap-val">${_settings.shapeGap}px</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-gap" min="0" max="80" step="1" value="${_settings.shapeGap}"><button class="qcs-reset-btn" data-reset="qcs-gap" title="Reset">&#x21bb;</button></div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Text Padding (inside shapes)</div>
                <label class="qcs-label">Top <span class="qcs-val" id="qcs-tpt-val">${_settings.textPadTop}px</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-tpt" min="0" max="60" step="1" value="${_settings.textPadTop}"><button class="qcs-reset-btn" data-reset="qcs-tpt" title="Reset">&#x21bb;</button></div>
                <label class="qcs-label">Bottom <span class="qcs-val" id="qcs-tpb-val">${_settings.textPadBottom}px</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-tpb" min="0" max="60" step="1" value="${_settings.textPadBottom}"><button class="qcs-reset-btn" data-reset="qcs-tpb" title="Reset">&#x21bb;</button></div>
                <label class="qcs-label">Left <span class="qcs-val" id="qcs-tpl-val">${_settings.textPadLeft}px</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-tpl" min="0" max="60" step="1" value="${_settings.textPadLeft}"><button class="qcs-reset-btn" data-reset="qcs-tpl" title="Reset">&#x21bb;</button></div>
                <label class="qcs-label">Right <span class="qcs-val" id="qcs-tpr-val">${_settings.textPadRight}px</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-tpr" min="0" max="60" step="1" value="${_settings.textPadRight}"><button class="qcs-reset-btn" data-reset="qcs-tpr" title="Reset">&#x21bb;</button></div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Container Color</div>
                <div class="qcs-color-row">
                  <input type="color" id="qcs-cc-color" value="${_settings.containerColor}" class="qcs-color-input">
                  <label class="qcs-label">Opacity <span class="qcs-val" id="qcs-cc-opacity-val">${_settings.containerOpacity}%</span></label>
                </div>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-cc-opacity" min="0" max="100" step="1" value="${_settings.containerOpacity}"><button class="qcs-reset-btn" data-reset="qcs-cc-opacity" title="Reset">&#x21bb;</button></div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Container Border</div>
                <div class="qcs-align-row" id="qcs-cb-style-row">
                  <button class="qcs-align-btn qcs-cb-style-btn${(_settings.containerBorderStyle || 'solid') === 'solid' ? ' active' : ''}" data-cbstyle="solid">Solid</button>
                  <button class="qcs-align-btn qcs-cb-style-btn${(_settings.containerBorderStyle || 'solid') === 'gradient' ? ' active' : ''}" data-cbstyle="gradient">Gradient</button>
                </div>
                <div id="qcs-cb-solid-opts"${(_settings.containerBorderStyle || 'solid') === 'gradient' ? ' style="display:none"' : ''}>
                  <div class="qcs-color-row">
                    <input type="color" id="qcs-cb-color" value="${_settings.containerBorderColor}" class="qcs-color-input">
                    <label class="qcs-label">Width <span class="qcs-val" id="qcs-cb-width-val">${_settings.containerBorderWidth}px</span></label>
                  </div>
                </div>
                <div id="qcs-cb-gradient-opts"${(_settings.containerBorderStyle || 'solid') === 'gradient' ? '' : ' style="display:none"'}>
                  <div class="qcs-color-row"><label class="qcs-label" style="margin:0">Color 1</label><input type="color" id="qcs-cbg-c1" value="#ffffff" class="qcs-color-input"></div>
                  <div class="qcs-color-row"><label class="qcs-label" style="margin:0">Color 2</label><input type="color" id="qcs-cbg-c2" value="#888888" class="qcs-color-input"></div>
                  <div class="qcs-slider-label"><span>Angle</span><span id="qcs-cbg-angle-val">135°</span></div>
                  <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-cbg-angle" min="0" max="360" step="1" value="135"></div>
                </div>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-cb-width" min="0" max="8" step="1" value="${_settings.containerBorderWidth}"><button class="qcs-reset-btn" data-reset="qcs-cb-width" title="Reset">&#x21bb;</button></div>
              </div>
            </div>

            <!-- Description Shape Tab -->
            <div class="qcs-tab-pane" data-pd-pane="descShape">
              <div class="qcs-section">
                <div class="qcs-section-title">Description Shape</div>
                <div class="qcs-shape-grid" id="qcs-desc-shape-grid">
                  ${Object.entries(SHAPES).map(([k, v]) => `<button class="qcs-shape-btn${k === _settings.descShape ? ' active' : ''}" data-shape="${k}" title="${v.label}">
                      <span class="qcs-shape-icon" data-shape-icon="${k}"></span>
                      <span class="qcs-shape-label">${v.label}</span>
                    </button>`).join('')}
                </div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Description Shape Size</div>
                <label class="qcs-label">Width <span class="qcs-val" id="qcs-dsw-val">${_settings.descShapeWidth}%</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-dsw" min="20" max="100" step="1" value="${_settings.descShapeWidth}"><button class="qcs-reset-btn" data-reset="qcs-dsw" title="Reset">&#x21bb;</button></div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Description Position</div>
                <label class="qcs-label">Position Y <span class="qcs-val" id="qcs-dpy-val">${_settings.descShapePosY}%</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-dpy" min="5" max="90" step="1" value="${_settings.descShapePosY}"><button class="qcs-reset-btn" data-reset="qcs-dpy" title="Reset">&#x21bb;</button></div>
                <label class="qcs-label">Offset X <span class="qcs-val" id="qcs-dox-val">${_settings.descShapeOffsetX}%</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-dox" min="-30" max="30" step="1" value="${_settings.descShapeOffsetX}"><button class="qcs-reset-btn" data-reset="qcs-dox" title="Reset">&#x21bb;</button></div>
                <label class="qcs-label">Offset Y <span class="qcs-val" id="qcs-doy-val">${_settings.descShapeOffsetY}%</span></label>
                <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-doy" min="-30" max="30" step="1" value="${_settings.descShapeOffsetY}"><button class="qcs-reset-btn" data-reset="qcs-doy" title="Reset">&#x21bb;</button></div>
              </div>
            </div>

            <!-- Separator Tab -->
            <div class="qcs-tab-pane" data-pd-pane="separator">
              <div class="qcs-section">
                <div class="qcs-section-title">Separator Line</div>
                <label class="qcs-toggle-row">
                  <input type="checkbox" id="qcs-sep-show" ${(_settings.separator && _settings.separator.show) ? 'checked' : ''}> Show separator
                </label>
              </div>
              <div id="qcs-sep-opts" style="display:${(_settings.separator && _settings.separator.show) ? '' : 'none'}">
                <div class="qcs-section">
                  <div class="qcs-section-title">Separator Style</div>
                  <label class="qcs-label">Thickness <span class="qcs-val" id="qcs-sep-thick-val">${(_settings.separator && _settings.separator.thickness) || 2}px</span></label>
                  <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-sep-thick" min="1" max="10" step="1" value="${(_settings.separator && _settings.separator.thickness) || 2}"><button class="qcs-reset-btn" data-reset="qcs-sep-thick" title="Reset">&#x21bb;</button></div>
                  <label class="qcs-label">Length <span class="qcs-val" id="qcs-sep-len-val">${(_settings.separator && _settings.separator.length) || 30}%</span></label>
                  <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-sep-len" min="5" max="100" step="1" value="${(_settings.separator && _settings.separator.length) || 30}"><button class="qcs-reset-btn" data-reset="qcs-sep-len" title="Reset">&#x21bb;</button></div>
                  <label class="qcs-label">Width <span class="qcs-val" id="qcs-sep-width-val">${(_settings.separator && _settings.separator.width) || 80}%</span></label>
                  <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-sep-width" min="10" max="100" step="1" value="${(_settings.separator && _settings.separator.width) || 80}"><button class="qcs-reset-btn" data-reset="qcs-sep-width" title="Reset">&#x21bb;</button></div>
                  <div class="qcs-color-row">
                    <label class="qcs-label" style="margin:0">Color</label>
                    <input type="color" id="qcs-sep-color" value="${(_settings.separator && _settings.separator.color) || '#ffffff'}" class="qcs-color-input">
                  </div>
                </div>
                <div class="qcs-section">
                  <div class="qcs-section-title">Separator Position</div>
                  <label class="qcs-label">Top Offset <span class="qcs-val" id="qcs-sep-top-val">${(_settings.separator && _settings.separator.topOffset) || 0}px</span></label>
                  <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-sep-top" min="-50" max="50" step="1" value="${(_settings.separator && _settings.separator.topOffset) || 0}"><button class="qcs-reset-btn" data-reset="qcs-sep-top" title="Reset">&#x21bb;</button></div>
                  <label class="qcs-label">Left Offset <span class="qcs-val" id="qcs-sep-left-val">${(_settings.separator && _settings.separator.leftOffset) || 0}%</span></label>
                  <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-sep-left" min="-50" max="50" step="1" value="${(_settings.separator && _settings.separator.leftOffset) || 0}"><button class="qcs-reset-btn" data-reset="qcs-sep-left" title="Reset">&#x21bb;</button></div>
                </div>
              </div>
            </div>

            <!-- Colors Tab -->
            <div class="qcs-tab-pane" data-pd-pane="colors">
              <div class="qcs-section">
                <div class="qcs-section-title">Card Background</div>
                <div class="qcs-bg-type-row">
                  <button class="qcs-bg-type-btn active" data-bgtype="gradient">Gradient</button>
                  <button class="qcs-bg-type-btn" data-bgtype="solid">Solid</button>
                  <button class="qcs-bg-type-btn" data-bgtype="image">Image</button>
                </div>
                <div id="qcs-gradient-presets" class="qcs-gradient-grid"></div>
                <div style="display:flex;gap:6px;margin-top:6px">
                  <button class="qcs-btn-action" id="qcs-grad-randomize" style="flex:1">Randomize</button>
                  <button class="qcs-btn-action" id="qcs-grad-customize-toggle" style="flex:1">Customize</button>
                </div>
                <div id="qcs-gradient-customize" style="display:none">
                  <div class="qcs-color-row" style="margin-top:6px">
                    <label class="qcs-label" style="margin:0">Color 1</label>
                    <input type="color" id="qcs-grad-c1" value="#0f0c29" class="qcs-color-input">
                  </div>
                  <div class="qcs-color-row">
                    <label class="qcs-label" style="margin:0">Color 2</label>
                    <input type="color" id="qcs-grad-c2" value="#302b63" class="qcs-color-input">
                  </div>
                  <div class="qcs-color-row">
                    <label class="qcs-label" style="margin:0">Color 3</label>
                    <input type="color" id="qcs-grad-c3" value="#24243e" class="qcs-color-input">
                  </div>
                  <div class="qcs-slider-label"><span>Angle</span><span id="qcs-grad-angle-val">135°</span></div>
                  <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-grad-angle" min="0" max="360" step="1" value="135"></div>
                  <button class="qcs-btn-action" id="qcs-grad-apply" style="margin-top:6px;width:100%">Apply Custom Gradient</button>
                </div>
                <div id="qcs-solid-color" style="display:none">
                  <input type="color" id="qcs-bg-solid-color" value="#0f0c29" class="qcs-color-input">
                </div>
                <div id="qcs-bg-image-upload" style="display:none">
                  <input type="file" id="qcs-bg-image-file" accept="image/png,image/jpeg" class="qcs-file-input">
                  <div id="qcs-bg-image-preview" style="display:none">
                    <img id="qcs-bg-image-preview-img" class="qcs-img-preview">
                    <button class="qcs-btn-ghost" id="qcs-bg-image-remove">Remove</button>
                  </div>
                  <div class="qcs-section-title" style="margin-top:8px">Fit Mode</div>
                  <div class="qcs-bg-type-row">
                    <button class="qcs-bg-fit-btn active" data-fit="cover">Crop & Fill</button>
                    <button class="qcs-bg-fit-btn" data-fit="contain">Fit to Screen</button>
                    <button class="qcs-bg-fit-btn" data-fit="fill">Stretch</button>
                  </div>
                  <div class="qcs-section-title" style="margin-top:8px">Fill Empty Space</div>
                  <label class="qcs-toggle-label"><input type="checkbox" id="qcs-bg-fill-empty"> Fill with background color</label>
                  <div class="qcs-section-title" style="margin-top:8px">Crop Edges</div>
                  <label class="qcs-toggle-label"><input type="checkbox" id="qcs-bg-crop"> Enable cropping</label>
                  <div id="qcs-crop-opts" style="display:none">
                    <div class="qcs-slider-label"><span>Left / Right</span><span id="qcs-clr-val">0%</span></div>
                    <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-clr" min="0" max="40" step="1" value="0"></div>
                    <div class="qcs-slider-label"><span>Top / Bottom</span><span id="qcs-ctb-val">0%</span></div>
                    <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-ctb" min="0" max="40" step="1" value="0"></div>
                  </div>
                  <div class="qcs-section-title" style="margin-top:8px">Image Offset</div>
                  <label class="qcs-toggle-label"><input type="checkbox" id="qcs-bg-pos-cb"${_settings.bgPosEnabled ? ' checked' : ''}> Enable position</label>
                  <div id="qcs-bg-pos-opts" style="display:${_settings.bgPosEnabled ? '' : 'none'}">
                    <div class="qcs-slider-label"><span>Left</span><span id="qcs-boffx-val">${_settings.bgOffsetX || 0}%</span></div>
                    <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-boffx" min="-50" max="50" step="1" value="${_settings.bgOffsetX || 0}"><button class="qcs-reset-btn" data-reset="qcs-boffx" title="Reset">&#x21bb;</button></div>
                    <div class="qcs-slider-label"><span>Top</span><span id="qcs-boffy-val">${_settings.bgOffsetY || 0}%</span></div>
                    <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-boffy" min="-50" max="50" step="1" value="${_settings.bgOffsetY || 0}"><button class="qcs-reset-btn" data-reset="qcs-boffy" title="Reset">&#x21bb;</button></div>
                  </div>
                  <div class="qcs-section-title" style="margin-top:8px">Image Scale</div>
                  <label class="qcs-toggle-label"><input type="checkbox" id="qcs-bg-scale-cb"${_settings.bgImageScaleEnabled ? ' checked' : ''}> Enable scale</label>
                  <div id="qcs-bg-scale-opts" style="display:${_settings.bgImageScaleEnabled ? '' : 'none'}">
                    <div class="qcs-slider-label"><span>Scale</span><span id="qcs-bgscale-val">${_settings.bgImageScale || 100}%</span></div>
                    <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-bgscale" min="20" max="200" step="1" value="${_settings.bgImageScale || 100}"><button class="qcs-reset-btn" data-reset="qcs-bgscale" title="Reset">&#x21bb;</button></div>
                  </div>
                </div>
                <div class="qcs-section-title" style="margin-top:8px">Edge Overlay</div>
                <select id="qcs-bg-edge-overlay" class="qcs-select">
                  <option value="none">None</option>
                  <option value="vignette">Vignette</option>
                </select>
                <div id="qcs-vignette-opts" style="display:none">
                  <div class="qcs-slider-label"><span>Left / Right</span><span id="qcs-vl-val">0%</span></div>
                  <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-vl" min="0" max="100" step="1" value="0"></div>
                  <div class="qcs-slider-label"><span>Top / Bottom</span><span id="qcs-vt-val">0%</span></div>
                  <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-vt" min="0" max="100" step="1" value="0"></div>
                </div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Card Border</div>
                <div class="qcs-bg-type-row">
                  <button class="qcs-border-style-btn active" data-bstyle="none">None</button>
                  <button class="qcs-border-style-btn" data-bstyle="solid">Solid</button>
                  <button class="qcs-border-style-btn" data-bstyle="gradient">Gradient</button>
                </div>
                <div id="qcs-border-opts" style="display:none">
                  <div class="qcs-section-title" style="margin-top:8px">Placement</div>
                  <div class="qcs-bg-type-row">
                    <button class="qcs-border-place-btn active" data-bplace="all">All</button>
                    <button class="qcs-border-place-btn" data-bplace="tb">Top+Bottom</button>
                    <button class="qcs-border-place-btn" data-bplace="lr">Sides</button>
                    <button class="qcs-border-place-btn" data-bplace="t">Top</button>
                    <button class="qcs-border-place-btn" data-bplace="r">Right</button>
                    <button class="qcs-border-place-btn" data-bplace="b">Bottom</button>
                    <button class="qcs-border-place-btn" data-bplace="l">Left</button>
                  </div>
                  <div class="qcs-slider-label"><span>Width</span><span id="qcs-bw-val">0px</span></div>
                  <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-bw" min="0" max="20" step="1" value="0"></div>
                  <div class="qcs-slider-row"><label style="margin-right:4px">Opacity</label><input type="range" class="qcs-slider" id="qcs-bo" min="0" max="100" step="1" value="100"><span class="qcs-val" id="qcs-bo-val">100%</span></div>
                  <div id="qcs-border-solid-color-row">
                    <div class="qcs-color-row"><label class="qcs-label" style="margin:0">Color</label><input type="color" id="qcs-border-color" value="#ffffff" class="qcs-color-input"></div>
                  </div>
                  <div id="qcs-border-gradient-opts" style="display:none">
                    <div class="qcs-color-row"><label class="qcs-label" style="margin:0">Color 1</label><input type="color" id="qcs-bgc1" value="#ffffff" class="qcs-color-input"></div>
                    <div class="qcs-color-row"><label class="qcs-label" style="margin:0">Color 2</label><input type="color" id="qcs-bgc2" value="#888888" class="qcs-color-input"></div>
                    <div class="qcs-slider-label"><span>Angle</span><span id="qcs-bga-val">135°</span></div>
                    <div class="qcs-slider-row"><input type="range" class="qcs-slider" id="qcs-bga" min="0" max="360" step="1" value="135"></div>
                  </div>
                </div>
              </div>
              <div class="qcs-section">
                <div class="qcs-section-title">Smart Contrast</div>
                <button class="qcs-btn-action" id="qcs-smart-contrast">Auto-detect & Apply</button>
              </div>
            </div>

            <!-- Text Tab -->
            <div class="qcs-tab-pane" data-pd-pane="text">
              <div class="qcs-section">
                <div class="qcs-section-title">Text Layout</div>
                <div class="qcs-align-row" id="qcs-align-row">
                  <button class="qcs-align-btn" data-align="left">&#8676;</button>
                  <button class="qcs-align-btn active" data-align="center">&#8596;</button>
                  <button class="qcs-align-btn" data-align="right">&#8677;</button>
                  <button class="qcs-align-btn" data-align="justify">&#9776;</button>
                </div>
                <div class="qcs-align-row" id="qcs-vpos-row" style="margin-top:6px">
                  <button class="qcs-align-btn" data-vpos="top">&#8679; Top</button>
                  <button class="qcs-align-btn active" data-vpos="center">&#8596; Center</button>
                  <button class="qcs-align-btn" data-vpos="bottom">&#8681; Bottom</button>
                </div>
              </div>
              ${buildElementSection('pt', 'Title', 'pt-section')}
              ${buildElementSection('pd', 'Description', 'pd-section')}
              <div class="qcs-divider"></div>
              ${buildElementSection('wm', 'Watermark', 'wm-section')}
              ${buildElementSection('dt', 'Date', 'dt-section')}
            </div>

            <!-- Images Tab -->
            <div class="qcs-tab-pane" data-pd-pane="images">
              <div id="qcs-fg-images-container"></div>
              <div class="qcs-section" style="text-align:center;padding:8px">
                <button type="button" class="btn qcs-btn-ghost" id="qcs-fg-add-image">+ Add Image</button>
              </div>
            </div>

          </div>
        </div>
        <div class="modal-footer qcs-footer">
          <button class="btn qcs-preview-btn" id="qcs-preview-btn">&#x1F441; Preview</button>
          <button class="btn qcs-cancel">Cancel</button>
          <button class="btn btn-primary qcs-export">Save</button>
        </div>
      </div>
    `;
        document.body.appendChild(overlay);
        _modal = overlay;
        bindControls();
        return _modal;
    }
    /* ── FG Images Panel (dynamic) ── */
    function buildFgImageHtml(img, idx) {
        const is = img || defaultFgImage(idx);
        return `
        <div class="qcs-section qcs-fg-card" data-fg-idx="${idx}">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div class="qcs-section-title" style="margin:0">Image #${idx + 1}</div>
            <button class="qcs-btn-ghost qcs-fg-del" data-fg-del="${idx}" title="Remove">&times;</button>
          </div>
          <div class="qcs-fg-upload-area">
            <input type="file" accept="image/png,image/jpeg" class="qcs-file-input qcs-fg-file" data-fg-file="${idx}">
            ${is.dataUrl ? `<img class="qcs-img-preview" src="${is.dataUrl}" style="max-height:80px;width:auto;border-radius:6px">` : '<span style="opacity:0.4;font-size:0.8rem">Click to upload</span>'}
          </div>
          <label class="qcs-toggle-row"><input type="checkbox" class="qcs-fg-cb" data-fg-cb="removeBgEnabled" data-fg-idx="${idx}" ${is.removeBgEnabled ? 'checked' : ''}> Remove Background</label>
          <div class="qcs-fg-progress" data-fg-progress="${idx}" style="display:none">
            <div class="qcs-progress-bar"><div class="qcs-progress-fill"></div></div>
            <span class="qcs-progress-text">Processing...</span>
          </div>
          <div class="qcs-dropdown-group">
            <label class="qcs-dropdown-toggle"><input type="checkbox" class="qcs-fg-cb" data-fg-cb="cropEnabled" data-fg-idx="${idx}" ${is.cropEnabled ? 'checked' : ''}> Crop</label>
            <div class="qcs-dropdown-body" ${is.cropEnabled ? '' : 'style="display:none"'}>
              <div class="qcs-slider-row"><label>Left</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="cropLeft" data-fg-idx="${idx}" min="0" max="50" value="${is.cropLeft}"><span>${is.cropLeft}%</span></div>
              <div class="qcs-slider-row"><label>Right</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="cropRight" data-fg-idx="${idx}" min="0" max="50" value="${is.cropRight}"><span>${is.cropRight}%</span></div>
              <div class="qcs-slider-row"><label>Top</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="cropTop" data-fg-idx="${idx}" min="0" max="50" value="${is.cropTop}"><span>${is.cropTop}%</span></div>
              <div class="qcs-slider-row"><label>Bottom</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="cropBottom" data-fg-idx="${idx}" min="0" max="50" value="${is.cropBottom}"><span>${is.cropBottom}%</span></div>
              <button class="qcs-btn-ghost qcs-fg-reset" data-fg-reset="crop" data-fg-idx="${idx}" style="font-size:0.72rem;width:100%;margin-top:4px;text-align:center;color:var(--text-tertiary)">Reset</button>
            </div>
          </div>
          <div class="qcs-dropdown-group">
            <label class="qcs-dropdown-toggle"><input type="checkbox" class="qcs-fg-cb" data-fg-cb="scaleEnabled" data-fg-idx="${idx}" ${is.scaleEnabled ? 'checked' : ''}> Size</label>
            <div class="qcs-dropdown-body" ${is.scaleEnabled ? '' : 'style="display:none"'}>
              <div class="qcs-slider-row"><label>Scale</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="scale" data-fg-idx="${idx}" min="20" max="200" value="${is.scale}"><span class="qcs-fg-slider-val">${is.scale}%</span></div>
              <button class="qcs-btn-ghost qcs-fg-reset" data-fg-reset="scale" data-fg-idx="${idx}" style="font-size:0.72rem;width:100%;margin-top:4px;text-align:center;color:var(--text-tertiary)">Reset</button>
            </div>
          </div>
          <div class="qcs-dropdown-group">
            <label class="qcs-dropdown-toggle"><input type="checkbox" class="qcs-fg-cb" data-fg-cb="posEnabled" data-fg-idx="${idx}" ${is.posEnabled ? 'checked' : ''}> Position</label>
            <div class="qcs-dropdown-body" ${is.posEnabled ? '' : 'style="display:none"'}>
              <div class="qcs-slider-row"><label>Top</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="posTop" data-fg-idx="${idx}" min="-20" max="120" value="${is.posTop}"><span class="qcs-fg-slider-val">${is.posTop === -1 ? 'auto' : is.posTop + '%'}</span></div>
              <div class="qcs-slider-row"><label>Left</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="posLeft" data-fg-idx="${idx}" min="-20" max="120" value="${is.posLeft}"><span class="qcs-fg-slider-val">${is.posLeft === -1 ? 'auto' : is.posLeft + '%'}</span></div>
              <div class="qcs-slider-row"><label>Z-Index</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="zIndex" data-fg-idx="${idx}" min="0" max="100" value="${is.zIndex}"><span class="qcs-fg-slider-val">${is.zIndex}</span></div>
              <button class="qcs-btn-ghost qcs-fg-reset" data-fg-reset="pos" data-fg-idx="${idx}" style="font-size:0.72rem;width:100%;margin-top:4px;text-align:center;color:var(--text-tertiary)">Reset</button>
            </div>
          </div>
          <div class="qcs-dropdown-group">
            <label class="qcs-dropdown-toggle"><input type="checkbox" class="qcs-fg-cb" data-fg-cb="borderEnabled" data-fg-idx="${idx}" ${is.borderEnabled ? 'checked' : ''}> Border</label>
            <div class="qcs-dropdown-body" ${is.borderEnabled ? '' : 'style="display:none"'}>
              <div class="qcs-position-grid" style="grid-template-columns:1fr 1fr 1fr 1fr;margin-bottom:4px">
                <button class="qcs-align-btn qcs-fg-border-style ${is.borderStyle==='none'?'active':''}" data-fg-idx="${idx}" data-fg-bstyle="none">None</button>
                <button class="qcs-align-btn qcs-fg-border-style ${is.borderStyle==='solid'?'active':''}" data-fg-idx="${idx}" data-fg-bstyle="solid">Solid</button>
                <button class="qcs-align-btn qcs-fg-border-style ${is.borderStyle==='gradient'?'active':''}" data-fg-idx="${idx}" data-fg-bstyle="gradient">Gradient</button>
                <button class="qcs-align-btn qcs-fg-border-style ${is.borderStyle==='outline'?'active':''}" data-fg-idx="${idx}" data-fg-bstyle="outline">Outline</button>
              </div>
              <div class="qcs-slider-row"><label>Width</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="borderWidth" data-fg-idx="${idx}" min="0" max="30" value="${is.borderWidth}"><span>${is.borderWidth}px</span></div>
              <div class="qcs-fg-border-solid" ${is.borderStyle==='solid'||is.borderStyle==='outline'?'':'style="display:none"'}>
                <div class="qcs-slider-row"><label>Color</label><input type="color" class="qcs-fg-color" data-fg-prop="borderColor" data-fg-idx="${idx}" value="${is.borderColor}"></div>
                <div class="qcs-slider-row"><label>Opacity</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="borderOpacity" data-fg-idx="${idx}" min="0" max="100" value="${is.borderOpacity}"><span>${is.borderOpacity}%</span></div>
              </div>
              <div class="qcs-fg-border-grad" ${is.borderStyle==='gradient'?'':'style="display:none"'}>
                <div class="qcs-position-grid" style="grid-template-columns:repeat(6,1fr);margin-top:4px">
                  <button class="qcs-grad-btn qcs-fg-grad ${is.borderGradient.includes('#fff')?'active':''}" data-fg-idx="${idx}" data-fggrad="linear-gradient(135deg, #ffffff, #888888)" style="background:linear-gradient(135deg,#fff,#888)"></button>
                  <button class="qcs-grad-btn qcs-fg-grad ${is.borderGradient.includes('#FFD700')?'active':''}" data-fg-idx="${idx}" data-fggrad="linear-gradient(135deg, #FFD700, #FFA500)" style="background:linear-gradient(135deg,#FFD700,#FFA500)"></button>
                  <button class="qcs-grad-btn qcs-fg-grad ${is.borderGradient.includes('#FF6B6B')?'active':''}" data-fg-idx="${idx}" data-fggrad="linear-gradient(135deg, #FF6B6B, #C62828)" style="background:linear-gradient(135deg,#FF6B6B,#C62828)"></button>
                  <button class="qcs-grad-btn qcs-fg-grad ${is.borderGradient.includes('#4FC3F7')?'active':''}" data-fg-idx="${idx}" data-fggrad="linear-gradient(135deg, #4FC3F7, #1565C0)" style="background:linear-gradient(135deg,#4FC3F7,#1565C0)"></button>
                  <button class="qcs-grad-btn qcs-fg-grad ${is.borderGradient.includes('#81C784')?'active':''}" data-fg-idx="${idx}" data-fggrad="linear-gradient(135deg, #81C784, #2E7D32)" style="background:linear-gradient(135deg,#81C784,#2E7D32)"></button>
                  <button class="qcs-grad-btn qcs-fg-grad ${is.borderGradient.includes('#CE93D8')?'active':''}" data-fg-idx="${idx}" data-fggrad="linear-gradient(135deg, #CE93D8, #6A1B9A)" style="background:linear-gradient(135deg,#CE93D8,#6A1B9A)"></button>
                </div>
              </div>
              <button class="qcs-btn-ghost qcs-fg-reset" data-fg-reset="border" data-fg-idx="${idx}" style="font-size:0.72rem;width:100%;margin-top:4px;text-align:center;color:var(--text-tertiary)">Reset</button>
            </div>
          </div>
          <div class="qcs-dropdown-group">
            <label class="qcs-dropdown-toggle"><input type="checkbox" class="qcs-fg-cb" data-fg-cb="edgeEnabled" data-fg-idx="${idx}" ${is.edgeEnabled ? 'checked' : ''}> Edge Effect</label>
            <div class="qcs-dropdown-body" ${is.edgeEnabled ? '' : 'style="display:none"'}>
              <div class="qcs-position-grid" style="grid-template-columns:repeat(5,1fr);margin-bottom:4px">
                <button class="qcs-align-btn qcs-fg-edge-style ${is.edgeEffect==='none'?'active':''}" data-fg-idx="${idx}" data-fg-edge="none">None</button>
                <button class="qcs-align-btn qcs-fg-edge-style ${is.edgeEffect==='torn'?'active':''}" data-fg-idx="${idx}" data-fg-edge="torn">Torn</button>
                <button class="qcs-align-btn qcs-fg-edge-style ${is.edgeEffect==='spray'?'active':''}" data-fg-idx="${idx}" data-fg-edge="spray">Spray</button>
                <button class="qcs-align-btn qcs-fg-edge-style ${is.edgeEffect==='rough'?'active':''}" data-fg-idx="${idx}" data-fg-edge="rough">Rough</button>
                <button class="qcs-align-btn qcs-fg-edge-style ${is.edgeEffect==='feather'?'active':''}" data-fg-idx="${idx}" data-fg-edge="feather">Feather</button>
              </div>
              <div class="qcs-slider-row"><label>Intensity</label><input type="range" class="qcs-slider qcs-fg-slider" data-fg-prop="edgeIntensity" data-fg-idx="${idx}" min="10" max="100" value="${is.edgeIntensity}"><span>${is.edgeIntensity}%</span></div>
              <button class="qcs-btn-ghost qcs-fg-reset" data-fg-reset="edge" data-fg-idx="${idx}" style="font-size:0.72rem;width:100%;margin-top:4px;text-align:center;color:var(--text-tertiary)">Reset</button>
            </div>
          </div>
        </div>`;
    }
    function renderFgImagesPanel() {
        const container = _modal.querySelector('#qcs-fg-images-container');
        if (!container) return;
        container.innerHTML = _settings.fgImages.map((img, i) => buildFgImageHtml(img, i)).join('');
        enhanceColorInputs(container);
        bindFgImageEvents();
    }
    function bindFgImageEvents() {
        const m = _modal;
        if (!m) return;
        m.querySelectorAll('.qcs-fg-file').forEach(inp => {
            inp.addEventListener('change', () => {
                const idx = +inp.dataset.fgFile;
                const file = inp.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                    _settings.fgImages[idx].dataUrl = reader.result;
                    _settings.fgImages[idx].bgRemovedDataUrl = null;
                    const img = new Image();
                    img.onload = () => {
                        if (!_fgImages[idx]) _fgImages[idx] = {};
                        _fgImages[idx].img = img;
                        _fgImages[idx].cleanImg = img;
                        renderFgImagesPanel();
                        schedulePreview();
                    };
                    img.src = reader.result;
                };
                reader.readAsDataURL(file);
            });
        });
        m.querySelectorAll('.qcs-fg-del').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = +btn.dataset.fgDel;
                // Track storage path for deletion on save
                const fg = _settings.fgImages[idx];
                if (fg && fg.dataUrl && fg.dataUrl.startsWith('http')) {
                    try {
                        const url = new URL(fg.dataUrl);
                        const path = url.pathname.split('/').pop();
                        _deletedFgPaths.push(path);
                    } catch (_) {}
                }
                _settings.fgImages.splice(idx, 1);
                _fgImages.splice(idx, 1);
                renderFgImagesPanel();
                schedulePreview();
            });
        });
        m.querySelectorAll('.qcs-fg-cb').forEach(cb => {
            cb.addEventListener('change', async () => {
                const idx = +cb.dataset.fgIdx;
                const key = cb.dataset.fgCb;
                const img = _settings.fgImages[idx];
                if (!img) return;
                img[key] = cb.checked;
                if (key === 'removeBgEnabled') {
                    if (cb.checked && _fgImages[idx] && _fgImages[idx].cleanImg && !img.bgRemovedDataUrl) {
                        await processBackgroundRemovalFor(idx);
                    }
                    else if (cb.checked && img.bgRemovedDataUrl) {
                        loadBgRemovedImageFor(idx, img.bgRemovedDataUrl);
                    }
                    else if (_fgImages[idx]) {
                        _fgImages[idx].img = _fgImages[idx].cleanImg;
                        schedulePreview();
                    }
                }
                const group = cb.closest('.qcs-dropdown-group');
                if (group) {
                    const body = group.querySelector('.qcs-dropdown-body');
                    if (body) body.style.display = cb.checked ? '' : 'none';
                }
                if (key !== 'removeBgEnabled') schedulePreview();
            });
        });
        m.querySelectorAll('.qcs-fg-slider').forEach(sl => {
            sl.addEventListener('input', () => {
                const idx = +sl.dataset.fgIdx;
                const prop = sl.dataset.fgProp;
                const img = _settings.fgImages[idx];
                if (!img) return;
                img[prop] = +sl.value;
                const row = sl.closest('.qcs-slider-row');
                const span = row?.querySelector('.qcs-fg-slider-val') || row?.querySelector('span');
                if (span) {
                    if (prop === 'posTop' || prop === 'posLeft') {
                        span.textContent = +sl.value === -1 ? 'auto' : sl.value + '%';
                    }
                    else if (prop === 'zIndex') span.textContent = sl.value;
                    else if (prop.includes('Opacity')) span.textContent = sl.value + '%';
                    else if (prop.includes('Width') || prop.includes('Intensity') || prop.includes('crop') || prop.includes('Crop')) span.textContent = sl.value + '%';
                    else if (prop === 'scale') span.textContent = sl.value + '%';
                    else span.textContent = sl.value;
                }
                schedulePreview();
            });
        });
        m.querySelectorAll('.qcs-fg-color').forEach(inp => {
            inp.addEventListener('input', () => {
                const idx = +inp.dataset.fgIdx;
                const prop = inp.dataset.fgProp;
                _settings.fgImages[idx][prop] = inp.value;
                schedulePreview();
            });
        });
        m.querySelectorAll('.qcs-fg-border-style').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = +btn.dataset.fgIdx;
                const style = btn.dataset.fgBstyle;
                _settings.fgImages[idx].borderStyle = style;
                const card = btn.closest('.qcs-fg-card');
                card.querySelectorAll('.qcs-fg-border-style').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const solid = card.querySelector('.qcs-fg-border-solid');
                const grad = card.querySelector('.qcs-fg-border-grad');
                if (solid) solid.style.display = (style === 'solid' || style === 'outline') ? '' : 'none';
                if (grad) grad.style.display = style === 'gradient' ? '' : 'none';
                schedulePreview();
            });
        });
        m.querySelectorAll('.qcs-fg-grad').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = +btn.dataset.fgIdx;
                _settings.fgImages[idx].borderGradient = btn.dataset.fggrad;
                const card = btn.closest('.qcs-fg-card');
                card.querySelectorAll('.qcs-fg-grad').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                schedulePreview();
            });
        });
        m.querySelectorAll('.qcs-fg-edge-style').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = +btn.dataset.fgIdx;
                _settings.fgImages[idx].edgeEffect = btn.dataset.fgEdge;
                const card = btn.closest('.qcs-fg-card');
                card.querySelectorAll('.qcs-fg-edge-style').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                schedulePreview();
            });
        });
        m.querySelectorAll('.qcs-fg-reset').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = +btn.dataset.fgIdx;
                const group = btn.dataset.fgReset;
                const img = _settings.fgImages[idx];
                const d = defaultFgImage(idx);
                if (!img) return;
                if (group === 'crop') { img.cropLeft = d.cropLeft; img.cropRight = d.cropRight; img.cropTop = d.cropTop; img.cropBottom = d.cropBottom; }
                else if (group === 'scale') { img.scale = d.scale; }
                else if (group === 'pos') { img.posTop = d.posTop; img.posLeft = d.posLeft; img.zIndex = d.zIndex; }
                else if (group === 'border') { img.borderStyle = d.borderStyle; img.borderColor = d.borderColor; img.borderOpacity = d.borderOpacity; img.borderGradient = d.borderGradient; img.borderWidth = d.borderWidth; }
                else if (group === 'edge') { img.edgeEffect = d.edgeEffect; img.edgeIntensity = d.edgeIntensity; }
                renderFgImagesPanel();
                schedulePreview();
            });
        });
        m.querySelector('#qcs-fg-add-image')?.addEventListener('click', () => {
            if (m._fgAddLock) return;
            m._fgAddLock = true;
            setTimeout(() => { m._fgAddLock = false; }, 300);
            _settings.fgImages.push(defaultFgImage(_settings.fgImages.length));
            _fgImages.push({});
            renderFgImagesPanel();
            schedulePreview();
        });
    }
    /* ── BG Removal per image ── */
    async function processBackgroundRemovalFor(idx) {
        const img = _fgImages[idx];
        if (!img || !img.cleanImg) return;
        const progEl = _modal.querySelector(`[data-fg-progress="${idx}"]`);
        if (progEl) {
            progEl.style.display = '';
            const fill = progEl.querySelector('.qcs-progress-fill');
            const text = progEl.querySelector('.qcs-progress-text');
            if (fill) fill.style.width = '10%';
            if (text) text.textContent = 'Loading AI model...';
        }
        const removeBg = window.ImglyBackgroundRemoval || window.BackgroundRemoval;
        if (!removeBg) {
            try {
                const mod = await import('https://esm.sh/@imgly/background-removal@1.5.8');
                window.ImglyBackgroundRemoval = mod.default || mod.removeBackground || mod;
            } catch {}
        }
        const fn = window.ImglyBackgroundRemoval || window.BackgroundRemoval;
        if (fn && img.cleanImg) {
            if (progEl) { const f = progEl.querySelector('.qcs-progress-fill'); const t = progEl.querySelector('.qcs-progress-text'); if (f) f.style.width = '30%'; if (t) t.textContent = 'Removing background...'; }
            try {
                const canvas = document.createElement('canvas');
                canvas.width = img.cleanImg.naturalWidth;
                canvas.height = img.cleanImg.naturalHeight;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img.cleanImg, 0, 0);
                const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
                const resultBlob = await fn(blob, {
                    progress: (key, current, total) => {
                        if (progEl) { const f = progEl.querySelector('.qcs-progress-fill'); const t = progEl.querySelector('.qcs-progress-text'); if (f) f.style.width = Math.round((current / total) * 80 + 20) + '%'; if (t) t.textContent = key + '...'; }
                    }
                });
                const url = URL.createObjectURL(resultBlob);
                _settings.fgImages[idx].bgRemovedDataUrl = url;
                loadBgRemovedImageFor(idx, url);
            } catch (e) {
                if (progEl) { const t = progEl.querySelector('.qcs-progress-text'); if (t) t.textContent = 'Failed'; }
            }
        } else {
            if (progEl) { const t = progEl.querySelector('.qcs-progress-text'); if (t) t.textContent = 'Model unavailable'; }
        }
        if (progEl) setTimeout(() => { progEl.style.display = 'none'; }, 2000);
    }
    function loadBgRemovedImageFor(idx, url) {
        const newImg = new Image();
        newImg.onload = () => {
            if (!_fgImages[idx]) _fgImages[idx] = {};
            _fgImages[idx].img = newImg;
            schedulePreview();
        };
        newImg.src = url;
    }
    /* ── Bind All Controls ── */
    function bindControls() {
        const m = _modal;
        m.querySelector('.qcs-close').addEventListener('click', close);
        m.querySelector('.qcs-cancel').addEventListener('click', close);
        m.querySelector('.qcs-export').addEventListener('click', handleSave);
        m.querySelector('#qcs-preview-btn').addEventListener('click', openFullScreenPreview);
        m.addEventListener('click', e => { if (e.target === m)
            close(); });
        // Tab switching
        m.querySelectorAll('.qcs-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                m.querySelectorAll('.qcs-tab').forEach(t => t.classList.toggle('active', t === tab));
                m.querySelectorAll('.qcs-tab-pane').forEach(p => {
                    p.classList.toggle('active', p.dataset.pdPane === tab.dataset.pdTab);
                });
            });
        });
        // Slider reset buttons
        const sliderDefaults = {
            'qcs-tsw': 100, 'qcs-dsw': 100,
            'qcs-tpy': 35, 'qcs-tox': 0, 'qcs-toy': 0,
            'qcs-dpy': 60, 'qcs-dox': 0, 'qcs-doy': 0,
            'qcs-gpos': 50,
            'qcs-boffx': 0, 'qcs-boffy': 0,
            'qcs-bgscale': 100,
            'qcs-gap': 30,
            'qcs-tpt': 40, 'qcs-tpr': 30, 'qcs-tpb': 40, 'qcs-tpl': 30,
            'qcs-cc-opacity': 30, 'qcs-cb-width': 0,
        };
        // Generate per-element slider defaults from defaultSettings()
        const defSettings = defaultSettings();
        const EL_PREFIXES = ['pt', 'pd', 'wm', 'dt'];
        const EL_KEYS = { pt: 'title', pd: 'description', wm: 'watermark', dt: 'date' };
        EL_PREFIXES.forEach(p => {
            const s = defSettings[EL_KEYS[p]];
            if (!s) return;
            sliderDefaults['qcs-' + p + '-size'] = s.fontSize;
            sliderDefaults['qcs-' + p + '-opacity'] = s.opacity;
            sliderDefaults['qcs-' + p + '-effect-int'] = s.textEffectIntensity;
        });
        m.addEventListener('click', e => {
            const btn = e.target.closest('.qcs-reset-btn');
            if (!btn)
                return;
            const sliderId = btn.dataset.reset;
            const slider = m.querySelector('#' + sliderId);
            if (!slider)
                return;
            const def = sliderDefaults[sliderId];
            if (def === undefined)
                return;
            slider.value = def;
            slider.dispatchEvent(new Event('input'));
        });
        // Sliders
        const sliders = [
            ['qcs-tsw', 'titleShapeWidth', v => v + '%', 'qcs-tsw-val'],
            ['qcs-dsw', 'descShapeWidth', v => v + '%', 'qcs-dsw-val'],
            ['qcs-tpy', 'titleShapePosY', v => v + '%', 'qcs-tpy-val'],
            ['qcs-tox', 'titleShapeOffsetX', v => v + '%', 'qcs-tox-val'],
            ['qcs-toy', 'titleShapeOffsetY', v => v + '%', 'qcs-toy-val'],
            ['qcs-dpy', 'descShapePosY', v => v + '%', 'qcs-dpy-val'],
            ['qcs-dox', 'descShapeOffsetX', v => v + '%', 'qcs-dox-val'],
            ['qcs-doy', 'descShapeOffsetY', v => v + '%', 'qcs-doy-val'],
            ['qcs-gap', 'shapeGap', v => v + 'px', 'qcs-gap-val'],
            ['qcs-tpt', 'textPadTop', v => v + 'px', 'qcs-tpt-val'],
            ['qcs-tpr', 'textPadRight', v => v + 'px', 'qcs-tpr-val'],
            ['qcs-tpb', 'textPadBottom', v => v + 'px', 'qcs-tpb-val'],
            ['qcs-tpl', 'textPadLeft', v => v + 'px', 'qcs-tpl-val'],
            ['qcs-cc-opacity', 'containerOpacity', v => v + '%', 'qcs-cc-opacity-val'],
            ['qcs-cb-width', 'containerBorderWidth', v => v + 'px', 'qcs-cb-width-val'],
        ];
        sliders.forEach(([id, key, fmt, valId]) => {
            const el = m.querySelector('#' + id);
            if (!el)
                return;
            el.addEventListener('input', () => {
                _settings[key] = parseFloat(el.value);
                m.querySelector('#' + valId).textContent = fmt(_settings[key]);
                schedulePreview();
            });
        });
        // Title Shape buttons
        m.querySelector('#qcs-title-shape-grid').addEventListener('click', e => {
            const btn = e.target.closest('.qcs-shape-btn');
            if (!btn) return;
            m.querySelectorAll('#qcs-title-shape-grid .qcs-shape-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _settings.titleShape = btn.dataset.shape;
            schedulePreview();
        });
        // Description Shape buttons
        m.querySelector('#qcs-desc-shape-grid').addEventListener('click', e => {
            const btn = e.target.closest('.qcs-shape-btn');
            if (!btn) return;
            m.querySelectorAll('#qcs-desc-shape-grid .qcs-shape-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _settings.descShape = btn.dataset.shape;
            schedulePreview();
        });
        // Separator toggle
        const sepShow = m.querySelector('#qcs-sep-show');
        if (sepShow) sepShow.addEventListener('change', () => {
            if (!_settings.separator) _settings.separator = {};
            _settings.separator.show = sepShow.checked;
            m.querySelector('#qcs-sep-opts').style.display = sepShow.checked ? '' : 'none';
            schedulePreview();
        });
        // Separator sliders
        const sepSliders = [
            ['qcs-sep-thick', 'thickness', v => v + 'px', 'qcs-sep-thick-val'],
            ['qcs-sep-len', 'length', v => v + '%', 'qcs-sep-len-val'],
            ['qcs-sep-width', 'width', v => v + '%', 'qcs-sep-width-val'],
            ['qcs-sep-top', 'topOffset', v => v + 'px', 'qcs-sep-top-val'],
            ['qcs-sep-left', 'leftOffset', v => v + '%', 'qcs-sep-left-val'],
        ];
        sepSliders.forEach(([id, key, fmt, valId]) => {
            const el = m.querySelector('#' + id);
            if (!el) return;
            el.addEventListener('input', () => {
                if (!_settings.separator) _settings.separator = {};
                _settings.separator[key] = parseFloat(el.value);
                m.querySelector('#' + valId).textContent = fmt(_settings.separator[key]);
                schedulePreview();
            });
        });
        // Separator color
        const sepColor = m.querySelector('#qcs-sep-color');
        if (sepColor) sepColor.addEventListener('input', () => {
            if (!_settings.separator) _settings.separator = {};
            _settings.separator.color = sepColor.value;
            schedulePreview();
        });
        // Separator reset buttons
        const sepDefaults = { 'qcs-sep-thick': 2, 'qcs-sep-len': 30, 'qcs-sep-width': 80, 'qcs-sep-top': 0, 'qcs-sep-left': 0 };
        m.addEventListener('click', e => {
            const btn = e.target.closest('.qcs-reset-btn');
            if (!btn) return;
            const sliderId = btn.dataset.reset;
            if (!(sliderId in sepDefaults)) return;
            const slider = m.querySelector('#' + sliderId);
            if (!slider) return;
            slider.value = sepDefaults[sliderId];
            slider.dispatchEvent(new Event('input'));
        });
        // Alignment buttons
        m.querySelector('#qcs-align-row').addEventListener('click', e => {
            const btn = e.target.closest('.qcs-align-btn');
            if (!btn) return;
            m.querySelector('#qcs-align-row').querySelectorAll('.qcs-align-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _settings.textAlignment = btn.dataset.align;
            schedulePreview();
        });
        // Vertical position buttons
        m.querySelector('#qcs-vpos-row').addEventListener('click', e => {
            const btn = e.target.closest('.qcs-align-btn');
            if (!btn) return;
            m.querySelector('#qcs-vpos-row').querySelectorAll('.qcs-align-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _settings.textVerticalAlign = btn.dataset.vpos;
            schedulePreview();
        });
        // Effect buttons (now per-element)
        const ELEMENTS = ['pt', 'pd', 'wm', 'dt'];
        const ELEMENT_KEYS = { pt: 'title', pd: 'description', wm: 'watermark', dt: 'date' };
        ELEMENTS.forEach(p => {
            const grid = m.querySelector('#qcs-' + p + '-effect-grid');
            if (grid) {
                grid.addEventListener('click', e => {
                    const btn = e.target.closest('.qcs-effect-btn');
                    if (!btn) return;
                    grid.querySelectorAll('.qcs-effect-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    _settings[ELEMENT_KEYS[p]].textEffect = btn.dataset.effect;
                    const opts = m.querySelector('#qcs-' + p + '-effect-opts');
                    if (opts) opts.style.display = btn.dataset.effect !== 'none' ? '' : 'none';
                    schedulePreview();
                });
            }
        });
        // Per-element color pickers
        ELEMENTS.forEach(p => {
            const key = ELEMENT_KEYS[p];
            const colorEl = m.querySelector('#qcs-' + p + '-color');
            if (colorEl) colorEl.addEventListener('input', () => { _settings[key].color = colorEl.value; schedulePreview(); });
            const effectColorEl = m.querySelector('#qcs-' + p + '-effect-color');
            if (effectColorEl) effectColorEl.addEventListener('input', () => { _settings[key].textEffectColor = effectColorEl.value; schedulePreview(); });
        });
        // Per-element font family selects
        ELEMENTS.forEach(p => {
            const key = ELEMENT_KEYS[p];
            const fontEl = m.querySelector('#qcs-' + p + '-font');
            if (fontEl) fontEl.addEventListener('change', () => { _settings[key].fontFamily = fontEl.value; schedulePreview(); });
        });
        // Per-element size sliders
        ELEMENTS.forEach(p => {
            const key = ELEMENT_KEYS[p];
            const slider = m.querySelector('#qcs-' + p + '-size');
            const valEl = m.querySelector('#qcs-' + p + '-size-val');
            if (slider) slider.addEventListener('input', () => {
                _settings[key].fontSize = parseFloat(slider.value);
                if (valEl) valEl.textContent = slider.value + 'px';
                schedulePreview();
            });
        });
        // Per-element opacity sliders
        ELEMENTS.forEach(p => {
            const key = ELEMENT_KEYS[p];
            const slider = m.querySelector('#qcs-' + p + '-opacity');
            const valEl = m.querySelector('#qcs-' + p + '-opacity-val');
            if (slider) slider.addEventListener('input', () => {
                _settings[key].opacity = parseFloat(slider.value);
                if (valEl) valEl.textContent = slider.value + '%';
                schedulePreview();
            });
        });
        // Per-element effect intensity sliders
        ELEMENTS.forEach(p => {
            const key = ELEMENT_KEYS[p];
            const slider = m.querySelector('#qcs-' + p + '-effect-int');
            const valEl = m.querySelector('#qcs-' + p + '-effect-int-val');
            if (slider) slider.addEventListener('input', () => {
                _settings[key].textEffectIntensity = parseFloat(slider.value);
                if (valEl) valEl.textContent = slider.value;
                schedulePreview();
            });
        });
        // Per-element show toggles
        ELEMENTS.forEach(p => {
            const key = ELEMENT_KEYS[p];
            const toggle = m.querySelector('#qcs-' + p + '-show');
            if (toggle) toggle.addEventListener('change', () => {
                _settings[key].show = toggle.checked;
                schedulePreview();
            });
        });
        // Title is mandatory — force checkbox checked and disabled
        const titleToggle = m.querySelector('#qcs-pt-show');
        if (titleToggle) { titleToggle.checked = true; titleToggle.disabled = true; }
        // Per-element style buttons (bold/italic/underline)
        ELEMENTS.forEach(p => {
            const key = ELEMENT_KEYS[p];
            const row = m.querySelector('#qcs-' + p + '-style-row');
            if (row) row.addEventListener('click', e => {
                const btn = e.target.closest('.qcs-style-btn');
                if (!btn) return;
                const style = btn.dataset.style;
                btn.classList.toggle('active');
                _settings[key][style] = btn.classList.contains('active');
                schedulePreview();
            });
        });
        // Collapsible sections
        m.querySelectorAll('.qcs-collapsible-header').forEach(header => {
            header.addEventListener('click', e => {
                if (e.target.closest('input[type=checkbox]')) return;
                header.closest('.qcs-collapsible').classList.toggle('open');
            });
        });
        // Watermark toggle (legacy from colors tab)
        const wmToggle = m.querySelector('#qcs-watermark-toggle');
        if (wmToggle)
            wmToggle.addEventListener('change', () => { _settings.watermark.show = wmToggle.checked; schedulePreview(); });
        const dateToggle = m.querySelector('#qcs-date-toggle');
        if (dateToggle)
            dateToggle.addEventListener('change', () => { _settings.date.show = dateToggle.checked; schedulePreview(); });
        // Aspect ratio buttons
        m.querySelector('#qcs-ratio-grid').addEventListener('click', e => {
            const btn = e.target.closest('.qcs-ratio-btn');
            if (!btn)
                return;
            m.querySelector('#qcs-ratio-grid').querySelectorAll('.qcs-ratio-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _settings.aspectRatio = btn.dataset.ratio;
            schedulePreview();
        });
        // Group position buttons (Top / Center / Bottom)
        m.querySelector('#qcs-group-pos-grid').addEventListener('click', e => {
            const btn = e.target.closest('.qcs-ratio-btn');
            if (!btn)
                return;
            m.querySelector('#qcs-group-pos-grid').querySelectorAll('.qcs-ratio-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            _settings.titleShapePosY = parseFloat(btn.dataset.gpos);
            const tpySlider = m.querySelector('#qcs-tpy');
            if (tpySlider) tpySlider.value = _settings.titleShapePosY;
            const tpyVal = m.querySelector('#qcs-tpy-val');
            if (tpyVal) tpyVal.textContent = _settings.titleShapePosY + '%';
            const gposSlider = m.querySelector('#qcs-gpos');
            if (gposSlider) gposSlider.value = _settings.titleShapePosY;
            const gposVal = m.querySelector('#qcs-gpos-val');
            if (gposVal) gposVal.textContent = _settings.titleShapePosY + '%';
            schedulePreview();
        });
        // Group position slider
        const gposSlider = m.querySelector('#qcs-gpos');
        if (gposSlider) {
            gposSlider.addEventListener('input', () => {
                _settings.titleShapePosY = parseFloat(gposSlider.value);
                const gposVal = m.querySelector('#qcs-gpos-val');
                if (gposVal) gposVal.textContent = _settings.titleShapePosY + '%';
                const tpySlider2 = m.querySelector('#qcs-tpy');
                if (tpySlider2) tpySlider2.value = _settings.titleShapePosY;
                const tpyVal2 = m.querySelector('#qcs-tpy-val');
                if (tpyVal2) tpyVal2.textContent = _settings.titleShapePosY + '%';
                m.querySelector('#qcs-group-pos-grid').querySelectorAll('.qcs-ratio-btn').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.gpos) === _settings.titleShapePosY));
                schedulePreview();
            });
        }
        // Background type buttons
        m.querySelectorAll('.qcs-bg-type-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                m.querySelectorAll('.qcs-bg-type-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                _settings.cardBgType = btn.dataset.bgtype;
                m.querySelector('#qcs-gradient-presets').style.display = btn.dataset.bgtype === 'gradient' ? '' : 'none';
                m.querySelector('#qcs-solid-color').style.display = btn.dataset.bgtype === 'solid' ? '' : 'none';
                m.querySelector('#qcs-bg-image-upload').style.display = btn.dataset.bgtype === 'image' ? '' : 'none';
                schedulePreview();
            });
        });
        // Build gradient presets
        const gradGrid = m.querySelector('#qcs-gradient-presets');
        GRADIENT_PRESETS.forEach((g, i) => {
            const btn = document.createElement('button');
            btn.className = 'qcs-grad-btn';
            btn.style.background = g;
            btn.dataset.gradient = g;
            if (g === _settings.cardBackground)
                btn.classList.add('active');
            btn.addEventListener('click', () => {
                gradGrid.querySelectorAll('.qcs-grad-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                _settings.cardBackground = g;
                schedulePreview();
            });
            gradGrid.appendChild(btn);
        });
        // Gradient randomize
        const gradRandomize = m.querySelector('#qcs-grad-randomize');
        if (gradRandomize) {
            gradRandomize.addEventListener('click', () => {
                const randomGrad = randomGradient();
                _settings.cardBackground = randomGrad;
                gradGrid.querySelectorAll('.qcs-grad-btn').forEach(b => {
                    b.classList.remove('active');
                });
                schedulePreview();
            });
        }
        // Smart contrast
        m.querySelector('#qcs-smart-contrast').addEventListener('click', () => {
            const contrast = smartContrast(_settings.cardBackground);
            _settings.containerColor = contrast.containerColor;
            _settings.containerBorderColor = contrast.containerBorder;
            // Apply contrast color to all text elements
            ['title', 'description', 'watermark', 'date'].forEach(k => {
                _settings[k].color = contrast.textColor;
            });
            const ccColor = m.querySelector('#qcs-cc-color');
            const cbColor = m.querySelector('#qcs-cb-color');
            if (ccColor)
                ccColor.value = '#' + [parseColor(contrast.containerColor).r, parseColor(contrast.containerColor).g, parseColor(contrast.containerColor).b].map(v => v.toString(16).padStart(2, '0')).join('');
            if (cbColor)
                cbColor.value = contrast.containerBorder;
            // Update all per-element color pickers
            ELEMENTS.forEach(p => {
                const colorEl = m.querySelector('#qcs-' + p + '-color');
                if (colorEl) colorEl.value = contrast.textColor;
            });
            schedulePreview();
        });
        // Container color picker
        const ccInput = m.querySelector('#qcs-cc-color');
        if (ccInput) ccInput.addEventListener('input', () => { _settings.containerColor = ccInput.value; schedulePreview(); });
        // Container border color picker
        const cbInput = m.querySelector('#qcs-cb-color');
        if (cbInput) cbInput.addEventListener('input', () => { _settings.containerBorderColor = cbInput.value; schedulePreview(); });
        // Container border style (solid/gradient)
        const cbStyleBtns = m.querySelectorAll('.qcs-cb-style-btn');
        if (cbStyleBtns.length) {
            cbStyleBtns.forEach(btn => btn.addEventListener('click', () => {
                cbStyleBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                _settings.containerBorderStyle = btn.dataset.cbstyle;
                const solidOpts = m.querySelector('#qcs-cb-solid-opts');
                const gradOpts = m.querySelector('#qcs-cb-gradient-opts');
                if (solidOpts) solidOpts.style.display = _settings.containerBorderStyle === 'gradient' ? 'none' : '';
                if (gradOpts) gradOpts.style.display = _settings.containerBorderStyle === 'gradient' ? '' : 'none';
                schedulePreview();
            }));
        }
        // Container border gradient colors
        const cbgC1 = m.querySelector('#qcs-cbg-c1');
        const cbgC2 = m.querySelector('#qcs-cbg-c2');
        const cbgAngle = m.querySelector('#qcs-cbg-angle');
        const cbgAngleVal = m.querySelector('#qcs-cbg-angle-val');
        function updateContainerBorderGradient() {
            const c1 = cbgC1 ? cbgC1.value : '#ffffff';
            const c2 = cbgC2 ? cbgC2.value : '#888888';
            const angle = cbgAngle ? cbgAngle.value : 135;
            _settings.containerBorderGradient = `linear-gradient(${angle}deg, ${c1}, ${c2})`;
            _settings.containerBorderGradientAngle = +angle;
            if (cbgAngleVal) cbgAngleVal.textContent = angle + '°';
            schedulePreview();
        }
        if (cbgC1) cbgC1.addEventListener('input', updateContainerBorderGradient);
        if (cbgC2) cbgC2.addEventListener('input', updateContainerBorderGradient);
        if (cbgAngle) cbgAngle.addEventListener('input', updateContainerBorderGradient);
        // Render multi-image panel
        renderFgImagesPanel();
        // Background image upload
        const bgImgInput = m.querySelector('#qcs-bg-image-file');
        if (bgImgInput) {
            bgImgInput.addEventListener('change', () => {
                const file = bgImgInput.files[0];
                if (!file)
                    return;
                // Track old bg for storage deletion
                if (_settings.cardBgType === 'image' && _settings.cardBackground && _settings.cardBackground.startsWith('http')) {
                    try {
                        const url = new URL(_settings.cardBackground);
                        _deletedFgPaths.push(url.pathname.split('/').pop());
                    } catch (_) {}
                }
                const reader = new FileReader();
                reader.onload = () => {
                    _settings.cardBackground = reader.result;
                    _settings.cardBgType = 'image';
                    const img = new Image();
                    img.onload = () => {
                        _bgImage = img;
                        schedulePreview();
                    };
                    img.src = reader.result;
                    m.querySelector('#qcs-bg-image-preview').style.display = '';
                    m.querySelector('#qcs-bg-image-preview-img').src = reader.result;
                };
                reader.readAsDataURL(file);
            });
        }
        const bgImgRemove = m.querySelector('#qcs-bg-image-remove');
        if (bgImgRemove) {
            bgImgRemove.addEventListener('click', () => {
                // Track old bg image for storage deletion
                if (_settings.cardBgType === 'image' && _settings.cardBackground && _settings.cardBackground.startsWith('http')) {
                    try {
                        const url = new URL(_settings.cardBackground);
                        const path = url.pathname.split('/').pop();
                        _deletedFgPaths.push(path);
                    } catch (_) {}
                }
                _settings.cardBackground = GRADIENT_PRESETS[0];
                _settings.cardBgType = 'gradient';
                const bgImgInput = m.querySelector('#qcs-bg-image-file');
                if (bgImgInput)
                    bgImgInput.value = '';
                m.querySelector('#qcs-bg-image-preview').style.display = 'none';
                m.querySelectorAll('.qcs-bg-type-btn').forEach(b => {
                    b.classList.toggle('active', b.dataset.bgtype === 'gradient');
                });
                m.querySelector('#qcs-gradient-presets').style.display = '';
                m.querySelector('#qcs-solid-color').style.display = 'none';
                m.querySelector('#qcs-bg-image-upload').style.display = 'none';
                schedulePreview();
            });
        }
        // Background image fit mode
        m.querySelectorAll('.qcs-bg-fit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                _settings.bgImageFit = btn.dataset.fit;
                m.querySelectorAll('.qcs-bg-fit-btn').forEach(b => b.classList.toggle('active', b.dataset.fit === _settings.bgImageFit));
                schedulePreview();
            });
        });
        // Fill empty space toggle
        const fillEmptyToggle = m.querySelector('#qcs-bg-fill-empty');
        if (fillEmptyToggle) {
            fillEmptyToggle.addEventListener('change', () => { _settings.bgFillEmpty = fillEmptyToggle.checked; schedulePreview(); });
        }
        // Edge overlay select
        const edgeOverlaySelect = m.querySelector('#qcs-bg-edge-overlay');
        if (edgeOverlaySelect) {
            edgeOverlaySelect.addEventListener('change', () => {
                _settings.bgEdgeOverlay = edgeOverlaySelect.value;
                m.querySelector('#qcs-vignette-opts').style.display = edgeOverlaySelect.value === 'vignette' ? '' : 'none';
                schedulePreview();
            });
        }
        // Vignette sliders
        const vlSlider = m.querySelector('#qcs-vl');
        const vtSlider = m.querySelector('#qcs-vt');
        if (vlSlider) {
            vlSlider.addEventListener('input', () => {
                _settings.bgEdgeLR = parseFloat(vlSlider.value);
                m.querySelector('#qcs-vl-val').textContent = _settings.bgEdgeLR + '%';
                schedulePreview();
            });
        }
        if (vtSlider) {
            vtSlider.addEventListener('input', () => {
                _settings.bgEdgeTB = parseFloat(vtSlider.value);
                m.querySelector('#qcs-vt-val').textContent = _settings.bgEdgeTB + '%';
                schedulePreview();
            });
        }
        // Crop toggle
        const cropToggle = m.querySelector('#qcs-bg-crop');
        if (cropToggle) {
            cropToggle.addEventListener('change', () => {
                _settings.bgCrop = cropToggle.checked;
                m.querySelector('#qcs-crop-opts').style.display = cropToggle.checked ? '' : 'none';
                schedulePreview();
            });
        }
        // Crop sliders
        const clrSlider = m.querySelector('#qcs-clr');
        const ctbSlider = m.querySelector('#qcs-ctb');
        if (clrSlider) {
            clrSlider.addEventListener('input', () => {
                _settings.bgCropLR = parseFloat(clrSlider.value);
                m.querySelector('#qcs-clr-val').textContent = _settings.bgCropLR + '%';
                schedulePreview();
            });
        }
        if (ctbSlider) {
            ctbSlider.addEventListener('input', () => {
                _settings.bgCropTB = parseFloat(ctbSlider.value);
                m.querySelector('#qcs-ctb-val').textContent = _settings.bgCropTB + '%';
                schedulePreview();
            });
        }
        // BG offset sliders
        const bgPosCb = m.querySelector('#qcs-bg-pos-cb');
        if (bgPosCb) {
            bgPosCb.addEventListener('change', () => {
                _settings.bgPosEnabled = bgPosCb.checked;
                m.querySelector('#qcs-bg-pos-opts').style.display = bgPosCb.checked ? '' : 'none';
                schedulePreview();
            });
        }
        const boffxSlider = m.querySelector('#qcs-boffx');
        const boffySlider = m.querySelector('#qcs-boffy');
        if (boffxSlider) {
            boffxSlider.addEventListener('input', () => {
                _settings.bgOffsetX = parseFloat(boffxSlider.value);
                m.querySelector('#qcs-boffx-val').textContent = _settings.bgOffsetX + '%';
                schedulePreview();
            });
        }
        if (boffySlider) {
            boffySlider.addEventListener('input', () => {
                _settings.bgOffsetY = parseFloat(boffySlider.value);
                m.querySelector('#qcs-boffy-val').textContent = _settings.bgOffsetY + '%';
                schedulePreview();
            });
        }
        // BG scale slider
        const bgScaleCb = m.querySelector('#qcs-bg-scale-cb');
        if (bgScaleCb) {
            bgScaleCb.addEventListener('change', () => {
                _settings.bgImageScaleEnabled = bgScaleCb.checked;
                m.querySelector('#qcs-bg-scale-opts').style.display = bgScaleCb.checked ? '' : 'none';
                schedulePreview();
            });
        }
        const bgScaleSlider = m.querySelector('#qcs-bgscale');
        if (bgScaleSlider) {
            bgScaleSlider.addEventListener('input', () => {
                _settings.bgImageScale = parseFloat(bgScaleSlider.value);
                m.querySelector('#qcs-bgscale-val').textContent = _settings.bgImageScale + '%';
                schedulePreview();
            });
        }
        // Border style buttons
        m.querySelectorAll('.qcs-border-style-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                m.querySelectorAll('.qcs-border-style-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                _settings.borderStyle = btn.dataset.bstyle;
                m.querySelector('#qcs-border-opts').style.display = btn.dataset.bstyle === 'none' ? 'none' : '';
                m.querySelector('#qcs-border-solid-color-row').style.display = btn.dataset.bstyle === 'gradient' ? 'none' : '';
                m.querySelector('#qcs-border-gradient-opts').style.display = btn.dataset.bstyle === 'gradient' ? '' : 'none';
                schedulePreview();
            });
        });
        // Border placement buttons
        m.querySelectorAll('.qcs-border-place-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                m.querySelectorAll('.qcs-border-place-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                _settings.borderPlacement = btn.dataset.bplace;
                schedulePreview();
            });
        });
        // Border width
        const bwSlider = m.querySelector('#qcs-bw');
        if (bwSlider) {
            bwSlider.addEventListener('input', () => {
                _settings.borderWidth = parseFloat(bwSlider.value);
                m.querySelector('#qcs-bw-val').textContent = _settings.borderWidth + 'px';
                schedulePreview();
            });
        }
        // Border color + opacity
        const bColor = m.querySelector('#qcs-border-color');
        if (bColor) {
            bColor.addEventListener('input', () => { _settings.borderColor = bColor.value; schedulePreview(); });
        }
        const boSlider = m.querySelector('#qcs-bo');
        if (boSlider) {
            boSlider.addEventListener('input', () => {
                _settings.borderOpacity = parseFloat(boSlider.value);
                m.querySelector('#qcs-bo-val').textContent = _settings.borderOpacity + '%';
                schedulePreview();
            });
        }
        // Border gradient
        const bgc1 = m.querySelector('#qcs-bgc1');
        const bgc2 = m.querySelector('#qcs-bgc2');
        const bgaSlider = m.querySelector('#qcs-bga');
        function updateBorderGradient() {
            const c1 = bgc1 ? bgc1.value : '#ffffff';
            const c2 = bgc2 ? bgc2.value : '#888888';
            const angle = bgaSlider ? parseFloat(bgaSlider.value) : 135;
            _settings.borderGradient = 'linear-gradient(' + angle + 'deg, ' + c1 + ', ' + c2 + ')';
            _settings.borderGradientAngle = angle;
            schedulePreview();
        }
        if (bgc1) bgc1.addEventListener('input', updateBorderGradient);
        if (bgc2) bgc2.addEventListener('input', updateBorderGradient);
        if (bgaSlider) {
            bgaSlider.addEventListener('input', () => {
                m.querySelector('#qcs-bga-val').textContent = bgaSlider.value + '°';
                updateBorderGradient();
            });
        }
        // Gradient customize
        const gradCustomizeBtn = m.querySelector('#qcs-grad-customize-toggle');
        const gradCustomizePanel = m.querySelector('#qcs-gradient-customize');
        if (gradCustomizeBtn) {
            gradCustomizeBtn.addEventListener('click', () => {
                const show = gradCustomizePanel.style.display === 'none';
                gradCustomizePanel.style.display = show ? '' : 'none';
                gradCustomizeBtn.textContent = show ? 'Close Customize' : 'Customize';
            });
        }
        // Gradient custom apply
        const gradApplyBtn = m.querySelector('#qcs-grad-apply');
        const gc1 = m.querySelector('#qcs-grad-c1');
        const gc2 = m.querySelector('#qcs-grad-c2');
        const gc3 = m.querySelector('#qcs-grad-c3');
        const gaSlider = m.querySelector('#qcs-grad-angle');
        if (gradApplyBtn) {
            gradApplyBtn.addEventListener('click', () => {
                const angle = gaSlider ? parseFloat(gaSlider.value) : 135;
                const c1 = gc1 ? gc1.value : '#0f0c29';
                const c2 = gc2 ? gc2.value : '#302b63';
                const c3 = gc3 ? gc3.value : '#24243e';
                _settings.cardBackground = 'linear-gradient(' + angle + 'deg, ' + c1 + ', ' + c2 + ', ' + c3 + ')';
                m.querySelectorAll('.qcs-grad-btn').forEach(b => b.classList.remove('active'));
                schedulePreview();
            });
        }
        if (gaSlider) {
            gaSlider.addEventListener('input', () => {
                m.querySelector('#qcs-grad-angle-val').textContent = gaSlider.value + '°';
            });
        }
        // Draggable divider
        initDivider();
    }
    function initDivider() {
        const divider = _modal.querySelector('#qcs-divider');
        const previewWrap = _modal.querySelector('#qcs-preview-wrap');
        const controls = _modal.querySelector('#qcs-controls');
        if (!divider || !previewWrap || !controls)
            return;
        let dragging = false, startY = 0, startH = 0;
        const body = _modal.querySelector('.qcs-body');
        divider.addEventListener('mousedown', e => {
            e.preventDefault();
            dragging = true;
            startY = e.clientY;
            startH = previewWrap.getBoundingClientRect().height;
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            divider.classList.add('qcs-divider-active');
        });
        divider.addEventListener('touchstart', e => {
            e.preventDefault();
            dragging = true;
            startY = e.touches[0].clientY;
            startH = previewWrap.getBoundingClientRect().height;
            document.addEventListener('touchmove', onMoveT, { passive: false });
            document.addEventListener('touchend', onUpT);
            divider.classList.add('qcs-divider-active');
        }, { passive: false });
        function onMove(e) {
            if (!dragging)
                return;
            const delta = e.clientY - startY;
            const newH = Math.max(120, Math.min(startH + delta, body.clientHeight - 140));
            previewWrap.style.flex = 'none';
            previewWrap.style.height = newH + 'px';
            controls.style.flex = '1';
            schedulePreview();
        }
        function onUp() {
            dragging = false;
            divider.classList.remove('qcs-divider-active');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        }
        function onMoveT(e) {
            if (!dragging)
                return;
            e.preventDefault();
            const delta = e.touches[0].clientY - startY;
            const newH = Math.max(120, Math.min(startH + delta, body.clientHeight - 140));
            previewWrap.style.flex = 'none';
            previewWrap.style.height = newH + 'px';
            controls.style.flex = '1';
            schedulePreview();
        }
        function onUpT() {
            dragging = false;
            divider.classList.remove('qcs-divider-active');
            document.removeEventListener('touchmove', onMoveT);
            document.removeEventListener('touchend', onUpT);
        }
    }
    /* ── Preview Rendering ── */
    function schedulePreview() {
        if (_previewDebounce)
            cancelAnimationFrame(_previewDebounce);
        _previewDebounce = requestAnimationFrame(() => renderPreview());
    }
    function renderPreview() {
        if (!_modal || !_article)
            return;
        const previewCanvas = _modal.querySelector('#qcs-preview-canvas');
        if (!previewCanvas)
            return;
        const RATIOS = {
            '9:16': { w: 1080, h: 1920 },
            '4:3': { w: 1080, h: 810 },
            '3:4': { w: 810, h: 1080 },
            '16:9': { w: 1920, h: 1080 },
            '1:1': { w: 1080, h: 1080 },
        };
        const cs = RATIOS[_settings.aspectRatio] || RATIOS['9:16'];
        previewCanvas.width = cs.w;
        previewCanvas.height = cs.h;
        const exportCanvas = renderExportCanvas();
        if (exportCanvas) {
            const ctx = previewCanvas.getContext('2d');
            ctx.clearRect(0, 0, cs.w, cs.h);
            ctx.drawImage(exportCanvas, 0, 0, cs.w, cs.h);
        }
    }
    function formatDateShort(d) {
        try {
            const dt = new Date(d);
            if (isNaN(dt.getTime()))
                return '';
            return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
        }
        catch {
            return '';
        }
    }
    /* ── Full-Screen Preview ── */
    function openFullScreenPreview() {
        if (!_article)
            return;
        const prevOverlay = document.querySelector('.qcs-fullscreen-overlay');
        if (prevOverlay)
            prevOverlay.remove();
        const overlay = document.createElement('div');
        overlay.className = 'qcs-fullscreen-overlay';
        overlay.innerHTML = `
      <div class="qcs-fs-header">
        <button class="qcs-fs-close" id="qcs-fs-close">&times;</button>
        <span class="qcs-fs-title">Preview</span>
        <button class="qcs-fs-download" id="qcs-fs-download">&#x2B07; Save Image</button>
      </div>
      <div class="qcs-fs-body">
        <div class="qcs-fs-card-wrap" id="qcs-fs-card-wrap">
          <canvas id="qcs-fs-canvas"></canvas>
        </div>
      </div>
    `;
        document.body.appendChild(overlay);
        // Render the same canvas — identical to editor preview, just displayed larger
        const fsCanvas = overlay.querySelector('#qcs-fs-canvas');
        const RATIOS = {
            '9:16': { w: 1080, h: 1920 },
            '4:3': { w: 1080, h: 810 },
            '3:4': { w: 810, h: 1080 },
            '16:9': { w: 1920, h: 1080 },
            '1:1': { w: 1080, h: 1080 },
        };
        const cs = RATIOS[_settings.aspectRatio] || RATIOS['9:16'];
        fsCanvas.width = cs.w;
        fsCanvas.height = cs.h;
        const exportCanvas = renderExportCanvas();
        if (exportCanvas) {
            const ctx = fsCanvas.getContext('2d');
            ctx.clearRect(0, 0, cs.w, cs.h);
            ctx.drawImage(exportCanvas, 0, 0, cs.w, cs.h);
        }
        // Constrain canvas so it fits within viewport
        fsCanvas.style.maxWidth = '98vw';
        fsCanvas.style.maxHeight = '98vh';
        fsCanvas.style.width = 'auto';
        fsCanvas.style.height = 'auto';
        fsCanvas.style.borderRadius = '8px';
        fsCanvas.style.boxShadow = '0 4px 32px rgba(0,0,0,0.6)';
        // Size to fill viewport — 9:16 fills height, others fill available space
        function sizeFullscreen() {
            const fsBody = overlay.querySelector('.qcs-fs-body');
            const headerH = overlay.querySelector('.qcs-fs-header');
            const availW = (fsBody && fsBody.clientWidth > 0 ? fsBody.clientWidth : window.innerWidth) - 32;
            const headerHt = (headerH && headerH.clientHeight > 0 ? headerH.clientHeight : 0);
            const availH = (fsBody && fsBody.clientHeight > 0 ? fsBody.clientHeight : window.innerHeight) - headerHt - 32;
            const aspect = cs.h / cs.w;
            // For tall ratios (9:16, 3:4), prioritize height. For wide, prioritize width
            let fsW;
            if (aspect >= 1) {
                // Tall: fill height first
                fsW = Math.min(availW, availH / aspect);
            } else {
                // Wide: fill width first
                fsW = Math.min(availW, availH / aspect);
            }
            fsCanvas.style.width = Math.round(fsW) + 'px';
            fsCanvas.style.height = Math.round(fsW * aspect) + 'px';
        }
        requestAnimationFrame(() => requestAnimationFrame(sizeFullscreen));
        // Wire up close
        overlay.querySelector('#qcs-fs-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', e => { if (e.target === overlay)
            overlay.remove(); });
        // Download: render to canvas from the same export function
        overlay.querySelector('#qcs-fs-download').addEventListener('click', async () => {
            const canvas = renderExportCanvas();
            if (!canvas)
                return;
            const a = document.createElement('a');
            a.download = 'post-card-' + Date.now() + '.png';
            a.href = canvas.toDataURL('image/png');
            a.click();
        });
    }
    /* ── Export to Canvas ── */
    async function handleSave() {
        const btn = _modal.querySelector('.qcs-export');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Saving...';
        }
        try {
            if (_articleId && _userId) {
                await saveSettings(_articleId, _userId);
            } else {
                console.warn('[QCS handleSave] SKIPPING save — articleId or userId is null');
            }
            if (_onComplete) {
                const canvas = renderExportCanvas();
                if (canvas) {
                    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
                    try {
                        _onComplete(canvas, blob);
                    }
                    catch { }
                }
            }
            close();
        }
        catch (e) {
            void 0;
        }
        finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Save';
            }
        }
    }
    function renderExportCanvas() {
        const RATIOS = {
            '9:16': { w: 1080, h: 1920 },
            '4:3': { w: 1080, h: 810 },
            '3:4': { w: 810, h: 1080 },
            '16:9': { w: 1920, h: 1080 },
            '1:1': { w: 1080, h: 1080 },
        };
        const cs = RATIOS[_settings.aspectRatio] || RATIOS['9:16'];
        const W = cs.w, H = cs.h;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const c = document.createElement('canvas');
        c.width = W * dpr;
        c.height = H * dpr;
        const ctx = c.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.imageSmoothingQuality = 'high';
        // Background
        if (_settings.cardBgType === 'image' && _bgImage) {
            // 1) Draw background color/gradient first (for fill-empty-space)
            if (_settings.bgFillEmpty) {
                const bg = _settings.cardBackground || '';
                const hexColors = bg.match(/#[0-9a-fA-F]{3,8}/g) || [];
                const hslColors = bg.match(/hsl\([^)]+\)/g) || [];
                const colors = hexColors.concat(hslColors);
                if (_settings.cardBgType === 'image' && _settings.cardBackground && colors.length >= 2) {
                    const grad = ctx.createLinearGradient(0, 0, W, H);
                    colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c));
                    ctx.fillStyle = grad;
                } else if (_settings.cardBgType === 'image') {
                    ctx.fillStyle = '#000000';
                } else {
                    ctx.fillStyle = _settings.cardBackground || '#000000';
                }
                ctx.fillRect(0, 0, W, H);
            }
            // 2) Draw image with fit mode
            const fit = _settings.bgImageFit || 'cover';
            const imgAspect = _bgImage.naturalWidth / _bgImage.naturalHeight;
            const canvasAspect = W / H;
            let sx = 0, sy = 0, sw = _bgImage.naturalWidth, sh = _bgImage.naturalHeight;
            let dx = 0, dy = 0, dw = W, dh = H;
            const offX = _settings.bgPosEnabled ? ((_settings.bgOffsetX || 0) / 100) : 0;
            const offY = _settings.bgPosEnabled ? ((_settings.bgOffsetY || 0) / 100) : 0;
            const bgScale = _settings.bgImageScaleEnabled ? ((_settings.bgImageScale || 100) / 100) : 1;
            if (fit === 'contain') {
                if (imgAspect > canvasAspect) {
                    dh = W / imgAspect;
                    dy = (H - dh) / 2;
                } else {
                    dw = H * imgAspect;
                    dx = (W - dw) / 2;
                }
                dw *= bgScale;
                dh *= bgScale;
                if (imgAspect > canvasAspect) {
                    dy = (H - dh) / 2;
                } else {
                    dx = (W - dw) / 2;
                }
                dx += offX * W;
                dy += offY * H;
            } else if (fit === 'cover') {
                if (imgAspect > canvasAspect) {
                    sw = _bgImage.naturalHeight * canvasAspect;
                    sx = (_bgImage.naturalWidth - sw) / 2;
                } else {
                    sh = _bgImage.naturalWidth / canvasAspect;
                    sy = (_bgImage.naturalHeight - sh) / 2;
                }
                sw /= bgScale;
                sh /= bgScale;
                if (imgAspect > canvasAspect) {
                    sx = (_bgImage.naturalWidth - sw) / 2;
                } else {
                    sy = (_bgImage.naturalHeight - sh) / 2;
                }
                sx += offX * _bgImage.naturalWidth * 0.5;
                sy += offY * _bgImage.naturalHeight * 0.5;
            } else {
                // fill/stretch mode
                dw *= bgScale;
                dh *= bgScale;
                dx = (W - dw) / 2;
                dy = (H - dh) / 2;
                dx += offX * W;
                dy += offY * H;
            }
            ctx.drawImage(_bgImage, sx, sy, sw, sh, dx, dy, dw, dh);
        }
        else if (_settings.cardBgType === 'solid') {
            ctx.fillStyle = _settings.cardBackground;
            ctx.fillRect(0, 0, W, H);
        }
        else {
            // Parse CSS gradient string — support #hex and hsl() colors
            const bg = _settings.cardBackground || '';
            const hexColors = bg.match(/#[0-9a-fA-F]{3,8}/g) || [];
            const hslColors = bg.match(/hsl\([^)]+\)/g) || [];
            const colors = hexColors.concat(hslColors);
            if (colors.length >= 2) {
                const grad = ctx.createLinearGradient(0, 0, W, H);
                colors.forEach((c, i) => grad.addColorStop(i / (colors.length - 1), c));
                ctx.fillStyle = grad;
            }
            else if (colors.length === 1) {
                ctx.fillStyle = colors[0];
            }
            else {
                const grad = ctx.createLinearGradient(0, 0, W, H);
                grad.addColorStop(0, '#0f0c29');
                grad.addColorStop(0.5, '#302b63');
                grad.addColorStop(1, '#24243e');
                ctx.fillStyle = grad;
            }
            ctx.fillRect(0, 0, W, H);
        }
        // ── Crop edges (black bars outside cropped area) ──
        if (_settings.bgCrop && _settings.cardBgType === 'image' && _bgImage) {
            const cropLR = (_settings.bgCropLR || 0) / 100;
            const cropTB = (_settings.bgCropTB || 0) / 100;
            const cropL = W * cropLR;
            const cropR = W * cropLR;
            const cropT = H * cropTB;
            const cropB = H * cropTB;
            if (cropL > 0 || cropT > 0) {
                ctx.save();
                // Fill cropped areas with black
                if (cropL > 0) { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, cropL, H); }
                if (cropR > 0) { ctx.fillStyle = '#000000'; ctx.fillRect(W - cropR, 0, cropR, H); }
                if (cropT > 0) { ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, W, cropT); }
                if (cropB > 0) { ctx.fillStyle = '#000000'; ctx.fillRect(0, H - cropB, W, cropB); }
                ctx.restore();
            }
        }
        // ── Edge overlay (vignette) ──
        const edgeType = _settings.bgEdgeOverlay || 'none';
        const vigL = (_settings.bgEdgeLR || 0) / 100;
        const vigT = (_settings.bgEdgeTB || 0) / 100;
        if (edgeType === 'vignette' && (vigL > 0 || vigT > 0)) {
            ctx.save();
            ctx.globalCompositeOperation = 'multiply';
            if (vigL > 0) {
                const vigW = W * vigL;
                const gL = ctx.createLinearGradient(0, 0, vigW, 0);
                gL.addColorStop(0, `rgba(0,0,0,${vigL})`);
                gL.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = gL;
                ctx.fillRect(0, 0, vigW, H);
                const gR = ctx.createLinearGradient(W - vigW, 0, W, 0);
                gR.addColorStop(0, 'rgba(0,0,0,0)');
                gR.addColorStop(1, `rgba(0,0,0,${vigL})`);
                ctx.fillStyle = gR;
                ctx.fillRect(W - vigW, 0, vigW, H);
            }
            if (vigT > 0) {
                const vigH = H * vigT;
                const gT = ctx.createLinearGradient(0, 0, 0, vigH);
                gT.addColorStop(0, `rgba(0,0,0,${vigT})`);
                gT.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = gT;
                ctx.fillRect(0, 0, W, vigH);
                const gB = ctx.createLinearGradient(0, H - vigH, 0, H);
                gB.addColorStop(0, 'rgba(0,0,0,0)');
                gB.addColorStop(1, `rgba(0,0,0,${vigT})`);
                ctx.fillStyle = gB;
                ctx.fillRect(0, H - vigH, W, vigH);
            }
            ctx.restore();
        }
        // ── Render all foreground images ──
        (_settings.fgImages || []).forEach((fg, idx) => {
            const fgRuntime = _fgImages[idx];
            const src = fgRuntime && fgRuntime.img;
            if (!src || !src.naturalWidth || !src.naturalHeight) return;
            const imgAspect = src.naturalWidth / src.naturalHeight;
            let drawW, drawH;
            const scaleFactor = fg.scaleEnabled ? (fg.scale || 100) / 100 : 1;
            if (imgAspect > 1) { drawW = W * 0.4 * scaleFactor; drawH = drawW / imgAspect; }
            else { drawH = H * 0.4 * scaleFactor; drawW = drawH * imgAspect; }
            let imgX = (W - drawW) / 2;
            let imgY = H * 0.1;
            if (fg.posEnabled) {
                imgX = fg.posLeft >= 0 ? W * fg.posLeft / 100 : (W - drawW) / 2;
                imgY = fg.posTop >= 0 ? H * fg.posTop / 100 : H * 0.1;
            }
            const edgeEffect = fg.edgeEnabled ? (fg.edgeEffect || 'none') : 'none';
            if (edgeEffect !== 'none') {
                const cL = (fg.cropLeft || 0) / 100, cR = (fg.cropRight || 0) / 100;
                const cT = (fg.cropTop || 0) / 100, cB = (fg.cropBottom || 0) / 100;
                let sx = 0, sy = 0, sw = src.naturalWidth, sh = src.naturalHeight;
                if (fg.cropEnabled) {
                    sx = sw * cL; sy = sh * cT;
                    sw = sw * (1 - cL - cR); sh = sh * (1 - cT - cB);
                }
                const offscreen = document.createElement('canvas');
                offscreen.width = Math.round(drawW);
                offscreen.height = Math.round(drawH);
                const octx = offscreen.getContext('2d');
                octx.drawImage(src, sx, sy, sw, sh, 0, 0, drawW, drawH);
                const imgData = octx.getImageData(0, 0, Math.round(drawW), Math.round(drawH));
                const d = imgData.data;
                const intensity = (fg.edgeIntensity || 50) / 100;
                const w = Math.round(drawW), h = Math.round(drawH);
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const i = (y * w + x) * 4;
                        if (d[i + 3] === 0) continue;
                        const nx = x / w, ny = y / h;
                        const edgeDist = Math.min(nx, 1 - nx, ny, 1 - ny);
                        const edgeZone = intensity * 0.25;
                        if (edgeDist > edgeZone) continue;
                        let alpha = 1;
                        if (edgeEffect === 'feather') alpha = edgeDist / edgeZone;
                        else if (edgeEffect === 'torn') { const seed = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; const noise = seed - Math.floor(seed); alpha = edgeDist < (edgeZone + (noise - 0.5) * intensity * 0.15) ? 0 : 1; }
                        else if (edgeEffect === 'spray') { const seed = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; const noise = seed - Math.floor(seed); alpha = noise < (edgeDist / edgeZone) ? 0 : 1; }
                        else if (edgeEffect === 'rough') { const s1 = Math.sin(x * 0.15 + y * 0.1) * 43758.5453; const s2 = Math.sin(x * 0.08 + y * 0.12) * 23421.631; const n = (s1 - Math.floor(s1)) * 0.5 + (s2 - Math.floor(s2)) * 0.5; alpha = edgeDist < edgeZone * (0.7 + n * 0.6) ? 0 : 1; }
                        d[i + 3] = Math.round(d[i + 3] * Math.max(0, Math.min(1, alpha)));
                    }
                }
                octx.putImageData(imgData, 0, 0);
                if (fg.cropEnabled) {
                    const cL = (fg.cropLeft || 0) / 100, cR = (fg.cropRight || 0) / 100;
                    const cT = (fg.cropTop || 0) / 100, cB = (fg.cropBottom || 0) / 100;
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(imgX + drawW * cL, imgY + drawH * cT, drawW * (1 - cL - cR), drawH * (1 - cT - cB));
                    ctx.clip();
                    ctx.drawImage(offscreen, imgX, imgY, drawW, drawH);
                    ctx.restore();
                } else {
                    ctx.drawImage(offscreen, imgX, imgY, drawW, drawH);
                }
            } else if (fg.cropEnabled) {
                const cL = (fg.cropLeft || 0) / 100, cR = (fg.cropRight || 0) / 100;
                const cT = (fg.cropTop || 0) / 100, cB = (fg.cropBottom || 0) / 100;
                ctx.save();
                ctx.beginPath();
                ctx.rect(imgX + drawW * cL, imgY + drawH * cT, drawW * (1 - cL - cR), drawH * (1 - cT - cB));
                ctx.clip();
                ctx.drawImage(src, imgX, imgY, drawW, drawH);
                ctx.restore();
            } else {
                ctx.drawImage(src, imgX, imgY, drawW, drawH);
            }
            // Border
            if (fg.borderEnabled) {
                const bw = fg.borderWidth || 0;
                const bs = fg.borderStyle || 'none';
                if (bw > 0 && bs !== 'none') {
                    const bOp = (fg.borderOpacity || 100) / 100;
                    ctx.save();
                    ctx.globalAlpha = bOp;
                    if (bs === 'outline') {
                        const c = fg.borderColor || '#ffffff';
                        const r2 = parseInt(c.slice(1, 3), 16), g2 = parseInt(c.slice(3, 5), 16), b2 = parseInt(c.slice(5, 7), 16);
                        const oCanvas = document.createElement('canvas');
                        oCanvas.width = Math.round(drawW);
                        oCanvas.height = Math.round(drawH);
                        const oCtx = oCanvas.getContext('2d');
                        if (fg.cropEnabled) {
                            const cL = (fg.cropLeft || 0) / 100, cR = (fg.cropRight || 0) / 100;
                            const cT = (fg.cropTop || 0) / 100, cB = (fg.cropBottom || 0) / 100;
                            oCtx.drawImage(src, src.naturalWidth * cL, src.naturalHeight * cT, src.naturalWidth * (1 - cL - cR), src.naturalHeight * (1 - cT - cB), 0, 0, drawW, drawH);
                        } else {
                            oCtx.drawImage(src, 0, 0, drawW, drawH);
                        }
                        const imgData = oCtx.getImageData(0, 0, oCanvas.width, oCanvas.height);
                        const d = imgData.data;
                        const w = oCanvas.width, h = oCanvas.height;
                        ctx.strokeStyle = `rgba(${r2},${g2},${b2},${bOp})`;
                        ctx.lineWidth = bw;
                        ctx.lineJoin = 'round';
                        for (let y = 0; y < h; y++) {
                            for (let x = 0; x < w; x++) {
                                const i = (y * w + x) * 4;
                                if (d[i + 3] < 10) continue;
                                const isEdge = (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
                                    d[((y - 1) * w + x) * 4 + 3] < 10 || d[((y + 1) * w + x) * 4 + 3] < 10 ||
                                    d[(y * w + x - 1) * 4 + 3] < 10 || d[(y * w + x + 1) * 4 + 3] < 10);
                                if (isEdge) {
                                    ctx.beginPath();
                                    ctx.moveTo(imgX + x + 0.5, imgY + y + 0.5);
                                    ctx.lineTo(imgX + x + 1, imgY + y + 1);
                                    ctx.stroke();
                                }
                            }
                        }
                    } else {
                        ctx.lineWidth = bw;
                        if (bs === 'solid') {
                            const c = fg.borderColor || '#ffffff';
                            const r2 = parseInt(c.slice(1, 3), 16), g2 = parseInt(c.slice(3, 5), 16), b2 = parseInt(c.slice(5, 7), 16);
                            ctx.strokeStyle = `rgba(${r2},${g2},${b2},${bOp})`;
                        } else if (bs === 'gradient') {
                            const gradStr = fg.borderGradient || 'linear-gradient(135deg, #ffffff, #888888)';
                            const gradColors = [];
                            const colorRe = /#[0-9a-fA-F]{3,8}/g;
                            let m2;
                            while ((m2 = colorRe.exec(gradStr)) !== null) gradColors.push(m2[0]);
                            const angleMatch = gradStr.match(/(\d+)deg/);
                            const angle = angleMatch ? +angleMatch[1] : 135;
                            const rad = (angle - 90) * Math.PI / 180;
                            const cx = imgX + drawW / 2, cy = imgY + drawH / 2;
                            const len = Math.max(drawW, drawH) / 2;
                            const g = ctx.createLinearGradient(cx - Math.cos(rad) * len, cy - Math.sin(rad) * len, cx + Math.cos(rad) * len, cy + Math.sin(rad) * len);
                            if (gradColors.length >= 2) gradColors.forEach((c, ci) => g.addColorStop(ci / (gradColors.length - 1), c));
                            else { g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#888888'); }
                            ctx.strokeStyle = g;
                        }
                        if (fg.cropEnabled) {
                            const cL = (fg.cropLeft || 0) / 100, cR = (fg.cropRight || 0) / 100;
                            const cT = (fg.cropTop || 0) / 100, cB = (fg.cropBottom || 0) / 100;
                            const cropX = imgX + drawW * cL;
                            const cropY = imgY + drawH * cT;
                            const cropW = drawW * (1 - cL - cR);
                            const cropH = drawH * (1 - cT - cB);
                            ctx.strokeRect(cropX - bw / 2, cropY - bw / 2, cropW + bw, cropH + bw);
                        } else {
                            ctx.strokeRect(imgX - bw / 2, imgY - bw / 2, drawW + bw, drawH + bw);
                        }
                    }
                    ctx.globalAlpha = 1;
                    ctx.restore();
                }
            }
        });
        // ── Two-shape system: titleShape + descShape with independent settings ──
        const fontScale = W / 420;

        // Helper: build canvas font string from element settings
        function elemFont(settings, sz) {
            return (settings.italic ? 'italic ' : '') + (settings.bold ? '700 ' : '400 ') + sz + 'px ' + settings.fontFamily;
        }
        function applyEffect(settings) {
            const e = settings.textEffect;
            const i = settings.textEffectIntensity;
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
            ctx.strokeStyle = 'transparent'; ctx.lineWidth = 0;
            if (e === 'shadow') { ctx.shadowColor = settings.textEffectColor; ctx.shadowBlur = i * 2; ctx.shadowOffsetY = i; }
            else if (e === 'outline') { ctx.strokeStyle = settings.textEffectColor; ctx.lineWidth = Math.max(1, Math.round(i * 0.5)); }
            else if (e === 'glow') { ctx.shadowColor = settings.textEffectColor; ctx.shadowBlur = i * 3; }
        }
        function resetEffect() { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; ctx.strokeStyle = 'transparent'; ctx.lineWidth = 0; }

        const tt = _settings.title || { fontSize: 22, color: '#ffffff', bold: true, italic: false, fontFamily: 'sans-serif', textEffect: 'shadow', textEffectColor: '#000000', textEffectIntensity: 3, opacity: 100, show: true };
        const dt = _settings.description || { fontSize: 14, color: '#ffffff', bold: false, italic: false, fontFamily: 'sans-serif', textEffect: 'none', textEffectColor: '#000000', textEffectIntensity: 2, opacity: 85, show: true };
        const titleText = _article.title || '';
        const descText = _article.description || _article.summary || '';
        const descVisible = dt.show && descText;

        // Shape bounds for each shape type
        const titleShapeB = getShapeBounds(_settings.titleShape);
        const descShapeB = getShapeBounds(_settings.descShape);

        // Compute shape pixel widths from percentage settings
        const titleRawW = W * (_settings.titleShapeWidth / 100);
        const descRawW = W * (_settings.descShapeWidth / 100);
        const titleShapeW = titleRawW * titleShapeB.wFrac;
        const descShapeW = descRawW * descShapeB.wFrac;

        // Font sizing: scale proportionally to actual visible shape width
        const titleSizeFactor = titleShapeW / (W * 0.8);
        const descSizeFactor = descShapeW / (W * 0.8);
        let titleFontSize = Math.round(tt.fontSize * titleSizeFactor * fontScale);
        let descFontSize = Math.round(dt.fontSize * descSizeFactor * fontScale);
        let titleLineH = Math.round(titleFontSize * 1.5);
        let descLineH = Math.round(descFontSize * 1.5);

        // Text padding inside shapes
        const tpTop = _settings.textPadTop || 40;
        const tpRight = _settings.textPadRight || 30;
        const tpBottom = _settings.textPadBottom || 40;
        const tpLeft = _settings.textPadLeft || 30;

        // Measure title text — use actual visible shape width for wrapping
        const titleMaxTextW = titleShapeW - tpLeft - tpRight;
        ctx.font = elemFont(tt, titleFontSize);
        let tTotalH = countLines(ctx, titleText, titleMaxTextW) * titleLineH;

        // Measure description text
        const descMaxTextW = descShapeW - tpLeft - tpRight;
        ctx.font = elemFont(dt, descFontSize);
        let dTotalH = descVisible ? countLines(ctx, descText, descMaxTextW) * descLineH : 0;

        // Auto-fit: shrink font until text fits comfortably within shape
        // Max shape height is 40% of canvas; compute max text from that
        const maxTitleShapeH = H * 0.4;
        const maxDescShapeH = H * 0.35;
        const maxTitleH = Math.max(60, maxTitleShapeH * titleShapeB.hFrac - tpTop - tpBottom);
        const maxDescH = Math.max(40, maxDescShapeH * descShapeB.hFrac - tpTop - tpBottom);

        if (tTotalH > maxTitleH && titleText) {
            let fs = titleFontSize;
            while (fs > 8) {
                fs -= 1;
                const lh = Math.round(fs * 1.5);
                ctx.font = elemFont(tt, fs);
                const h = countLines(ctx, titleText, titleMaxTextW) * lh;
                if (h <= maxTitleH) {
                    titleFontSize = fs;
                    titleLineH = lh;
                    tTotalH = h;
                    break;
                }
            }
            if (fs <= 8) {
                titleFontSize = 8;
                titleLineH = 12;
                ctx.font = elemFont(tt, 8);
                tTotalH = countLines(ctx, titleText, titleMaxTextW) * titleLineH;
            }
        }
        if (dTotalH > maxDescH && descVisible) {
            let fs = descFontSize;
            while (fs > 6) {
                fs -= 1;
                const lh = Math.round(fs * 1.5);
                ctx.font = elemFont(dt, fs);
                const h = countLines(ctx, descText, descMaxTextW) * lh;
                if (h <= maxDescH) {
                    descFontSize = fs;
                    descLineH = lh;
                    dTotalH = h;
                    break;
                }
            }
            if (fs <= 6) {
                descFontSize = 6;
                descLineH = 9;
                ctx.font = elemFont(dt, 6);
                dTotalH = countLines(ctx, descText, descMaxTextW) * descLineH;
            }
        }

        // Shape height: divide by hFrac so actual drawn shape is tall enough for text
        const minTitleH = H * 0.08;
        const minDescH = H * 0.06;
        const titleShapeH = Math.max(minTitleH, (tTotalH + tpTop + tpBottom + 20) / titleShapeB.hFrac);
        const descShapeH = descVisible ? Math.max(minDescH, (dTotalH + tpTop + tpBottom + 20) / descShapeB.hFrac) : 0;
        const groupGap = descVisible ? (_settings.shapeGap || 30) : 0;

        // Position the whole group (title + gap + desc) centered vertically
        // Compute from actual drawn shape edges, not bounding box edges
        const titleDrawnH = titleShapeH * titleShapeB.hFrac;
        const descDrawnH = descVisible ? descShapeH * descShapeB.hFrac : 0;
        const totalVisibleH = titleDrawnH + groupGap + descDrawnH;
        const groupCenterYRaw = H * (_settings.titleShapePosY / 100) + (_settings.titleShapeOffsetY || 0) * H / 100;
        const safeTop = H * 0.10;
        const safeBottom = H * 0.88;
        const groupCenterY = Math.max(safeTop + totalVisibleH / 2, Math.min(safeBottom - totalVisibleH / 2, groupCenterYRaw));
        const groupTop = groupCenterY - totalVisibleH / 2;

        // Title drawn shape center = top + half drawn height
        const titleCenterY = groupTop + titleDrawnH / 2;
        // Desc drawn shape center = title bottom edge + gap + half desc drawn height
        const descCenterY = descVisible ? groupTop + titleDrawnH + groupGap + descDrawnH / 2 : 0;

        // X positions
        const edgeMargin = 10;
        const titleClampedX = Math.max(titleRawW / 2 + edgeMargin, Math.min(W - titleRawW / 2 - edgeMargin, W / 2 + (_settings.titleShapeOffsetX || 0) * W / 100));
        const descClampedX = Math.max(descRawW / 2 + edgeMargin, Math.min(W - descRawW / 2 - edgeMargin, W / 2 + (_settings.descShapeOffsetX || 0) * W / 100));

        const align = _settings.textAlignment || 'left';
        const cc = parseColor(_settings.containerColor);
        const opacity = _settings.containerOpacity / 100;
        const vAlign = _settings.textVerticalAlign || 'center';

        // ── Draw title shape ──
        const titleShapePath = getShapeCanvasPath(_settings.titleShape, titleClampedX, titleCenterY, titleRawW, titleShapeH);
        ctx.fillStyle = `rgba(${cc.r},${cc.g},${cc.b},${opacity})`;
        ctx.fill(titleShapePath);
        if (_settings.containerBorderWidth > 0) {
            const bStyle = _settings.containerBorderStyle || 'solid';
            ctx.lineWidth = _settings.containerBorderWidth;
            if (bStyle === 'gradient') {
                const bg = _settings.containerBorderGradient || '';
                const bgColors = bg.match(/#[0-9a-fA-F]{3,8}/g) || ['#ffffff', '#888888'];
                const bAngle = (_settings.containerBorderGradientAngle || 135) * Math.PI / 180;
                const gcx = W / 2, gcy = H / 2;
                const len = Math.max(W, H);
                const g = ctx.createLinearGradient(
                    gcx - Math.cos(bAngle) * len / 2, gcy - Math.sin(bAngle) * len / 2,
                    gcx + Math.cos(bAngle) * len / 2, gcy + Math.sin(bAngle) * len / 2
                );
                bgColors.forEach((c, i) => g.addColorStop(i / Math.max(bgColors.length - 1, 1), c));
                ctx.strokeStyle = g;
            } else {
                const bc = parseColor(_settings.containerBorderColor);
                ctx.strokeStyle = `rgb(${bc.r},${bc.g},${bc.b})`;
            }
            ctx.stroke(titleShapePath);
        }

        // ── Draw title text (clipped to shape) ──
        ctx.save();
        ctx.clip(titleShapePath);
        ctx.font = elemFont(tt, titleFontSize);
        ctx.fillStyle = tt.color;
        ctx.globalAlpha = tt.opacity / 100;
        applyEffect(tt);
        const titleActualH = titleShapeH * titleShapeB.hFrac;
        const titleTextAreaTop = titleCenterY - titleActualH / 2 + tpTop;
        const titleTextAreaH = titleActualH - tpTop - tpBottom;
        const titleVisualH = tTotalH - titleLineH + titleFontSize;
        const titleAsc = titleFontSize * 0.8;
        let titleCursorY;
        const titleTextLeft = titleClampedX - titleShapeW / 2 + tpLeft;
        const titleTextX = align === 'center' ? titleClampedX : align === 'right' ? titleTextLeft + titleMaxTextW : titleTextLeft;
        if (vAlign === 'top') titleCursorY = titleTextAreaTop + titleAsc;
        else if (vAlign === 'bottom') titleCursorY = titleTextAreaTop + titleTextAreaH - titleVisualH + titleAsc;
        else titleCursorY = titleTextAreaTop + (titleTextAreaH - titleVisualH) / 2 + titleAsc;
        if (tt.textEffect === 'gradient') {
            const grad = ctx.createLinearGradient(0, titleCursorY, 0, titleCursorY + tTotalH);
            grad.addColorStop(0, tt.color); grad.addColorStop(1, tt.textEffectColor);
            ctx.fillStyle = grad;
        }
        if (tt.textEffect === 'glow') {
            for (let pass = 0; pass < 3; pass++) { ctx.shadowBlur = tt.textEffectIntensity * (3 + pass * 2); wrapText(ctx, titleText, titleTextX, titleCursorY, titleMaxTextW, titleLineH, align); }
        } else { wrapText(ctx, titleText, titleTextX, titleCursorY, titleMaxTextW, titleLineH, align); }
        ctx.globalAlpha = 1;
        resetEffect();
        ctx.restore();

        // ── Separator line (configurable) ──
        const sep = _settings.separator || {};
        if (descVisible && sep.show) {
            const sepColor = sep.color || '#ffffff';
            const sepThickness = sep.thickness || 2;
            const sepLengthPct = (sep.length || 30) / 100;
            const sepWidthPct = (sep.width || 80) / 100;
            const sepTopOff = sep.topOffset || 0;
            const sepLeftOff = (sep.leftOffset || 0) / 100;
            const sepY = titleCenterY + titleDrawnH / 2 + groupGap / 2 + sepTopOff;
            const sepW = Math.min(titleShapeW, descShapeW) * sepLengthPct;
            const sepCX = titleClampedX + W * sepLeftOff * sepWidthPct;
            const sepX = sepCX - sepW / 2;
            ctx.globalAlpha = 1;
            ctx.strokeStyle = sepColor;
            ctx.lineWidth = sepThickness;
            ctx.beginPath();
            ctx.moveTo(sepX, sepY);
            ctx.lineTo(sepX + sepW, sepY);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // ── Draw description shape ──
        if (descVisible) {
            const descShapePath = getShapeCanvasPath(_settings.descShape, descClampedX, descCenterY, descRawW, descShapeH);
            ctx.fillStyle = `rgba(${cc.r},${cc.g},${cc.b},${opacity})`;
            ctx.fill(descShapePath);
            if (_settings.containerBorderWidth > 0) {
                const bStyle = _settings.containerBorderStyle || 'solid';
                ctx.lineWidth = _settings.containerBorderWidth;
                if (bStyle === 'gradient') {
                    const bg = _settings.containerBorderGradient || '';
                    const bgColors = bg.match(/#[0-9a-fA-F]{3,8}/g) || ['#ffffff', '#888888'];
                    const bAngle = (_settings.containerBorderGradientAngle || 135) * Math.PI / 180;
                    const gcx = W / 2, gcy = H / 2;
                    const len = Math.max(W, H);
                    const g = ctx.createLinearGradient(
                        gcx - Math.cos(bAngle) * len / 2, gcy - Math.sin(bAngle) * len / 2,
                        gcx + Math.cos(bAngle) * len / 2, gcy + Math.sin(bAngle) * len / 2
                    );
                    bgColors.forEach((c, i) => g.addColorStop(i / Math.max(bgColors.length - 1, 1), c));
                    ctx.strokeStyle = g;
                } else {
                    const bc = parseColor(_settings.containerBorderColor);
                    ctx.strokeStyle = `rgb(${bc.r},${bc.g},${bc.b})`;
                }
                ctx.stroke(descShapePath);
            }

            // ── Draw description text (clipped to shape) ──
            ctx.save();
            ctx.clip(descShapePath);
            ctx.font = elemFont(dt, descFontSize);
            ctx.fillStyle = dt.color;
            ctx.globalAlpha = dt.opacity / 100;
            applyEffect(dt);
            const descActualH = descShapeH * descShapeB.hFrac;
            const descTextAreaTop = descCenterY - descActualH / 2 + tpTop;
            const descTextAreaH = descActualH - tpTop - tpBottom;
            const descVisualH = dTotalH - descLineH + descFontSize;
            const descAsc = descFontSize * 0.8;
            let descCursorY;
            const descTextLeft = descClampedX - descShapeW / 2 + tpLeft;
            const descTextX = align === 'center' ? descClampedX : align === 'right' ? descTextLeft + descMaxTextW : descTextLeft;
            if (vAlign === 'top') descCursorY = descTextAreaTop + descAsc;
            else if (vAlign === 'bottom') descCursorY = descTextAreaTop + descTextAreaH - descVisualH + descAsc;
            else descCursorY = descTextAreaTop + (descTextAreaH - descVisualH) / 2 + descAsc;
            if (dt.textEffect === 'gradient') {
                const grad = ctx.createLinearGradient(0, descCursorY, 0, descCursorY + dTotalH);
                grad.addColorStop(0, dt.color); grad.addColorStop(1, dt.textEffectColor);
                ctx.fillStyle = grad;
            }
            if (dt.textEffect === 'glow') {
                for (let pass = 0; pass < 3; pass++) { ctx.shadowBlur = dt.textEffectIntensity * (3 + pass * 2); wrapText(ctx, descText, descTextX, descCursorY, descMaxTextW, descLineH, align); }
            } else { wrapText(ctx, descText, descTextX, descCursorY, descMaxTextW, descLineH, align); }
            ctx.globalAlpha = 1;
            resetEffect();
            ctx.restore();
        }

        // ── Watermark — bottom-left of PAGE ──
        const wm = _settings.watermark || { fontSize: 22, color: '#ffffff', show: true, opacity: 60, fontFamily: 'sans-serif', bold: true, italic: false };
        const dd = _settings.date || { fontSize: 22, color: '#ffffff', show: true, opacity: 60, fontFamily: 'sans-serif', bold: true, italic: false };
        const marginX = W * 0.05;
        const wmSize = Math.round(wm.fontSize * fontScale * 0.55);
        const wmLineH = Math.round(wmSize * 1.4);
        const wmY = H - H * 0.18;
        const dateY = wmY + wmLineH;
        if (wm.show) {
            const wmText = wm.text || _article._sourceName || _article._pubPostId || 'Invisible Broadcast';
            ctx.font = elemFont(wm, wmSize);
            ctx.fillStyle = wm.color;
            ctx.globalAlpha = wm.opacity / 100;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            applyEffect(wm);
            ctx.fillText(wmText, marginX, wmY);
            resetEffect();
            ctx.globalAlpha = 1;
        }
        const articleDate = _article.pubDate || _article.date_published || '';
        if (articleDate && dd.show) {
            const dateSize = Math.round(dd.fontSize * fontScale * 0.45);
            ctx.font = elemFont(dd, dateSize);
            ctx.fillStyle = dd.color;
            ctx.globalAlpha = dd.opacity / 100;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            applyEffect(dd);
            ctx.fillText(formatDateShort(articleDate), marginX, dateY);
            resetEffect();
            ctx.globalAlpha = 1;
        }
        // ── Card View Badges: rank (top-left) + trending (top-right) above title shape ──
        if (_cardMeta && _settings.titleShape) {
            const rank = _cardMeta._rank;
            const trendingCount = _cardMeta._trendingCount;
            if (rank || trendingCount) {
                const badgeH = Math.round(H * 0.036);
                const badgePadX = Math.round(W * 0.025);
                const badgeGap = Math.round(H * 0.010);
                const badgeFontSize = Math.round(badgeH * 0.65);
                const titleTop = titleCenterY - titleDrawnH / 2;
                const shapeLeft = titleClampedX - titleShapeW / 2;
                const shapeRight = titleClampedX + titleShapeW / 2;
                const badgeY = titleTop - badgeH - badgeGap;
                ctx.save();
                ctx.textBaseline = 'middle';
                ctx.textAlign = 'left';
                // Rank badge — above shape, left-aligned
                if (rank) {
                    const rankText = '#' + rank;
                    ctx.font = 'bold ' + badgeFontSize + 'px sans-serif';
                    const rankW = ctx.measureText(rankText).width + badgePadX * 2;
                    const rankX = shapeLeft;
                    ctx.fillStyle = 'rgba(0,0,0,0.7)';
                    ctx.beginPath();
                    const rr = 6;
                    ctx.moveTo(rankX + rr, badgeY);
                    ctx.lineTo(rankX + rankW - rr, badgeY);
                    ctx.arcTo(rankX + rankW, badgeY, rankX + rankW, badgeY + rr, rr);
                    ctx.lineTo(rankX + rankW, badgeY + badgeH - rr);
                    ctx.arcTo(rankX + rankW, badgeY + badgeH, rankX + rankW - rr, badgeY + badgeH, rr);
                    ctx.lineTo(rankX + rr, badgeY + badgeH);
                    ctx.arcTo(rankX, badgeY + badgeH, rankX, badgeY + badgeH - rr, rr);
                    ctx.lineTo(rankX, badgeY + rr);
                    ctx.arcTo(rankX, badgeY, rankX + rr, badgeY, rr);
                    ctx.closePath();
                    ctx.fill();
                    ctx.fillStyle = rank <= 3 ? '#ff4444' : '#ffffff';
                    ctx.fillText(rankText, rankX + badgePadX, badgeY + badgeH / 2);
                }
                // Trending badge — above shape, right-aligned
                if (trendingCount) {
                    const trendText = '\u2197 ' + trendingCount;
                    ctx.font = 'bold ' + badgeFontSize + 'px sans-serif';
                    const trendW = ctx.measureText(trendText).width + badgePadX * 2;
                    const trendX = shapeRight - trendW;
                    ctx.fillStyle = 'rgba(0,0,0,0.7)';
                    ctx.beginPath();
                    const tr = 6;
                    ctx.moveTo(trendX + tr, badgeY);
                    ctx.lineTo(trendX + trendW - tr, badgeY);
                    ctx.arcTo(trendX + trendW, badgeY, trendX + trendW, badgeY + tr, tr);
                    ctx.lineTo(trendX + trendW, badgeY + badgeH - tr);
                    ctx.arcTo(trendX + trendW, badgeY + badgeH, trendX + trendW - tr, badgeY + badgeH, tr);
                    ctx.lineTo(trendX + tr, badgeY + badgeH);
                    ctx.arcTo(trendX, badgeY + badgeH, trendX, badgeY + badgeH - tr, tr);
                    ctx.lineTo(trendX, badgeY + tr);
                    ctx.arcTo(trendX, badgeY, trendX + tr, badgeY, tr);
                    ctx.closePath();
                    ctx.fill();
                    ctx.fillStyle = '#00cc66';
                    ctx.fillText(trendText, trendX + badgePadX, badgeY + badgeH / 2);
                }
                ctx.restore();
            }
        }
        // ── Card Border ──
        if (_settings.borderStyle !== 'none' && _settings.borderWidth > 0) {
            const bw = _settings.borderWidth;
            const bAlpha = (_settings.borderOpacity || 100) / 100;
            const placement = _settings.borderPlacement || 'all';
            ctx.save();
            ctx.globalAlpha = bAlpha;
            if (_settings.borderStyle === 'solid') {
                ctx.strokeStyle = _settings.borderColor;
                ctx.lineWidth = bw;
            } else if (_settings.borderStyle === 'gradient') {
                const bg = _settings.borderGradient || '';
                const bgColors = bg.match(/#[0-9a-fA-F]{3,8}/g) || ['#ffffff', '#888888'];
                const bAngle = (_settings.borderGradientAngle || 135) * Math.PI / 180;
                const cx = W / 2, cy = H / 2;
                const len = Math.max(W, H);
                const g = ctx.createLinearGradient(
                    cx - Math.cos(bAngle) * len / 2, cy - Math.sin(bAngle) * len / 2,
                    cx + Math.cos(bAngle) * len / 2, cy + Math.sin(bAngle) * len / 2
                );
                bgColors.forEach((c, i) => g.addColorStop(i / Math.max(bgColors.length - 1, 1), c));
                ctx.strokeStyle = g;
                ctx.lineWidth = bw;
            }
            const hw = bw / 2;
            if (placement === 'all') {
                ctx.strokeRect(hw, hw, W - bw, H - bw);
            } else {
                if (placement === 't' || placement === 'tb' || placement === 'all') {
                    ctx.beginPath(); ctx.moveTo(0, hw); ctx.lineTo(W, hw); ctx.stroke();
                }
                if (placement === 'b' || placement === 'tb' || placement === 'all') {
                    ctx.beginPath(); ctx.moveTo(0, H - hw); ctx.lineTo(W, H - hw); ctx.stroke();
                }
                if (placement === 'l' || placement === 'lr' || placement === 'all') {
                    ctx.beginPath(); ctx.moveTo(hw, 0); ctx.lineTo(hw, H); ctx.stroke();
                }
                if (placement === 'r' || placement === 'lr' || placement === 'all') {
                    ctx.beginPath(); ctx.moveTo(W - hw, 0); ctx.lineTo(W - hw, H); ctx.stroke();
                }
            }
            ctx.restore();
        }
        return c;
    }
    function countLines(ctx, text, maxW) {
        const lines = [];
        const paragraphs = text.split('\n');
        for (const para of paragraphs) {
            if (para.trim() === '') {
                lines.push('');
                continue;
            }
            const words = para.split(' ');
            let line = '';
            for (const word of words) {
                const test = line ? line + ' ' + word : word;
                if (ctx.measureText(test).width > maxW && line) {
                    lines.push(line);
                    line = word;
                }
                else {
                    line = test;
                }
            }
            if (line)
                lines.push(line);
        }
        return lines.length;
    }
    function wrapText(ctx, text, x, y, maxW, lineH, align) {
        const lines = [];
        const paragraphs = text.split('\n');
        for (const para of paragraphs) {
            if (para.trim() === '') {
                lines.push('');
                continue;
            }
            const words = para.split(' ');
            let line = '';
            for (const word of words) {
                const test = line ? line + ' ' + word : word;
                if (ctx.measureText(test).width > maxW && line) {
                    lines.push(line);
                    line = word;
                }
                else {
                    line = test;
                }
            }
            if (line)
                lines.push(line);
        }
        const prevAlign = ctx.textAlign;
        if (align)
            ctx.textAlign = align;
        ctx.textBaseline = 'alphabetic';
        for (let i = 0; i < lines.length; i++) {
            ctx.fillText(lines[i], x, y + i * lineH);
            if (ctx.lineWidth > 0) ctx.strokeText(lines[i], x, y + i * lineH);
        }
        ctx.textAlign = prevAlign;
        return lines.length;
    }
    /* ── Supabase Save/Load ── */
    async function saveSettings(articleId, userId) {
        const client = window.SupabaseStore && SupabaseStore.getClient();
        if (!client) return;
        const fileBase = _storageKey || articleId;
        if (_deletedFgPaths.length) {
            try { await client.storage.from('ib-post-images').remove(_deletedFgPaths); } catch (_) {}
            _deletedFgPaths = [];
        }
        const designData = JSON.parse(JSON.stringify(_settings));
        // Upload images to Supabase Storage
        for (let i = 0; i < designData.fgImages.length; i++) {
            const fg = designData.fgImages[i];
            if (fg.removeBgEnabled && fg.bgRemovedDataUrl) {
                let blob = null;
                if (fg.bgRemovedDataUrl.startsWith('blob:')) {
                    try { blob = await (await fetch(fg.bgRemovedDataUrl)).blob(); } catch (e) { console.error('[QCS Save] fg bg fetch error:', e); }
                } else if (fg.bgRemovedDataUrl.startsWith('data:')) {
                    try { blob = await (await fetch(fg.bgRemovedDataUrl)).blob(); } catch (e) { console.error('[QCS Save] fg bg fetch error:', e); }
                }
                if (blob) {
                    const path = `${fileBase}_fg_${i}.png`;
                    const { error } = await client.storage.from('ib-post-images').upload(path, blob, { upsert: true });
                    if (error) { console.error('[QCS Save] fg upload error:', error.message); }
                    else {
                        const { data: urlData } = client.storage.from('ib-post-images').getPublicUrl(path);
                        fg.bgRemovedDataUrl = urlData.publicUrl;
                        fg.dataUrl = urlData.publicUrl;
                        _settings.fgImages[i].dataUrl = urlData.publicUrl;
                        _settings.fgImages[i].bgRemovedDataUrl = urlData.publicUrl;
                    }
                }
            } else if (fg.dataUrl && fg.dataUrl.startsWith('data:')) {
                try {
                    const ext = fg.dataUrl.includes('image/png') ? 'png' : 'jpg';
                    const path = `${fileBase}_fg_${i}.${ext}`;
                    const blob = await (await fetch(fg.dataUrl)).blob();
                    const { error } = await client.storage.from('ib-post-images').upload(path, blob, { upsert: true });
                    if (error) { console.error('[QCS Save] fg upload error:', error.message); }
                    else {
                        const { data: urlData } = client.storage.from('ib-post-images').getPublicUrl(path);
                        fg.dataUrl = urlData.publicUrl;
                        _settings.fgImages[i].dataUrl = urlData.publicUrl;
                    }
                } catch (e) { console.error('[QCS Save] fg error:', e); }
            }
        }
        // Upload background image
        if (designData.cardBgType === 'image' && designData.cardBackground && designData.cardBackground.startsWith('data:')) {
            try {
                const ext = designData.cardBackground.includes('image/png') ? 'png' : 'jpg';
                const path = `${fileBase}_bg.${ext}`;
                const blob = await (await fetch(designData.cardBackground)).blob();
                const { error } = await client.storage.from('ib-post-images').upload(path, blob, { upsert: true });
                if (error) { console.error('[QCS Save] bg upload error:', error.message); }
                else {
                    const { data: urlData } = client.storage.from('ib-post-images').getPublicUrl(path);
                    designData.cardBackground = urlData.publicUrl;
                    _settings.cardBackground = urlData.publicUrl;
                }
            } catch (e) { console.error('[QCS Save] bg error:', e); }
        }
        console.log('[QCS Save] Upserting design_data for article:', articleId);
        try {
            const { error } = await client
                .from('post_design_settings')
                .upsert({
                    article_id: articleId,
                    user_id: userId,
                    design_data: designData,
                }, { onConflict: 'article_id,user_id' });
            if (error) console.error('[QCS Save] upsert error:', error.message);
        }
        catch (e) { console.error('[QCS Save] upsert catch:', e); }
    }
    async function loadSettings(articleId, userId) {
        const client = window.SupabaseStore && SupabaseStore.getClient();
        if (!client)
            return null;
        try {
            const { data, error } = await client
                .from('post_design_settings')
                .select('design_data')
                .eq('article_id', articleId)
                .eq('user_id', userId)
                .single();
            if (error || !data)
                return null;
            const saved = data.design_data;
            // Migrate old flat format to new fgImages array
            if (!saved.fgImages) {
                saved.fgImages = [];
                if (saved.foregroundImage) {
                    saved.fgImages.push({
                        seq: 0,
                        dataUrl: saved.foregroundImage,
                        bgRemovedDataUrl: saved.bgRemovedDataUrl || null,
                        removeBgEnabled: saved.removeBgEnabled || false,
                        scale: 100, scaleEnabled: false,
                        cropEnabled: false, cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0,
                        borderEnabled: (saved.fgBorderWidth || 0) > 0 && (saved.fgBorderStyle || 'none') !== 'none',
                        borderStyle: saved.fgBorderStyle || 'none',
                        borderColor: saved.fgBorderColor || '#ffffff',
                        borderOpacity: saved.fgBorderOpacity || 100,
                        borderGradient: saved.fgBorderGradient || 'linear-gradient(135deg, #ffffff, #888888)',
                        borderWidth: saved.fgBorderWidth || 4,
                        edgeEnabled: (saved.fgEdgeEffect || 'none') !== 'none',
                        edgeEffect: saved.fgEdgeEffect || 'none',
                        edgeIntensity: saved.fgEdgeIntensity || 50,
                    });
                    delete saved.foregroundImage;
                    delete saved.bgRemovedDataUrl;
                    delete saved.removeBgEnabled;
                    delete saved.fgBorderStyle;
                    delete saved.fgBorderColor;
                    delete saved.fgBorderOpacity;
                    delete saved.fgBorderWidth;
                    delete saved.fgBorderGradient;
                    delete saved.fgEdgeEffect;
                    delete saved.fgEdgeIntensity;
                }
            }
            return saved;
        }
        catch {
            return null;
        }
    }
    /* ── Open / Close ── */
    async function open(article, opts) {
        if (window.QuoteCardStudio) QuoteCardStudio.close();
        _article = article;
        _onComplete = (opts && opts.onComplete) || null;
        _articleId = (opts && opts.articleId) || null;
        _userId = (opts && opts.userId) || null;
        _storageKey = (opts && opts.storageKey) || null;
        _deletedFgPaths = [];
        _settings = defaultSettings();
        let hasSavedSettings = false;
        // Apply initial settings from duplicate
        if (opts && opts.initialSettings) {
            Object.assign(_settings, JSON.parse(JSON.stringify(opts.initialSettings)));
            _settings.title = _settings.title || defaultSettings().title;
            _settings.title.show = true;
            hasSavedSettings = true;
        }
        // Load saved settings if available
        if (_articleId && _userId) {
            const saved = await loadSettings(_articleId, _userId);
            if (saved) {
                const def = defaultSettings();
                // Merge old flat settings into per-element if needed
                if (saved.fontSize && !saved.title) {
                    saved.title = { ...def.title, fontSize: saved.fontSize, color: saved.textColor || def.title.color, fontFamily: saved.fontFamily || def.title.fontFamily, textEffect: saved.textEffect || 'none', textEffectColor: saved.textEffectColor || '#000000', textEffectIntensity: saved.textEffectIntensity || 2 };
                    if (saved.watermarkColor) saved.watermark = { ...def.watermark, color: saved.watermarkColor };
                    if (saved.dateColor) saved.date = { ...def.date, color: saved.dateColor };
                    if (saved.showWatermark !== undefined) saved.watermark = { ...(saved.watermark || def.watermark), show: saved.showWatermark };
                    if (saved.showDate !== undefined) saved.date = { ...(saved.date || def.date), show: saved.showDate };
                }
                Object.assign(_settings, saved);
                // Migrate old hardcoded textPad defaults (16px) to new defaults
                if (_settings.textPadTop === 16 && _settings.textPadRight === 16) {
                    _settings.textPadTop = 40;
                    _settings.textPadRight = 30;
                    _settings.textPadBottom = 40;
                    _settings.textPadLeft = 30;
                }
                // Ensure all per-element sub-objects exist
                for (const k of ['title', 'description', 'watermark', 'date']) {
                    if (!_settings[k]) _settings[k] = def[k];
                }
                // Ensure separator defaults exist
                if (!_settings.separator) _settings.separator = def.separator;
                else {
                    for (const k of Object.keys(def.separator)) {
                        if (_settings.separator[k] === undefined) _settings.separator[k] = def.separator[k];
                    }
                }
                // Title is mandatory
                _settings.title.show = true;
                hasSavedSettings = true;
            }
        }
        // Randomize title color with contrast against background (only on first load)
        if (!hasSavedSettings) {
            let bgHex = _settings.cardBackground || '#1a1a2e';
            // If gradient, extract first color
            const gradMatch = bgHex.match(/#([0-9a-fA-F]{3,8})/);
            if (gradMatch) bgHex = '#' + gradMatch[1];
            const bgC = parseColor(bgHex);
            const bgLum = relativeLuminance(bgC.r, bgC.g, bgC.b);
            const LIGHT_COLORS = ['#ffffff', '#f0f0f0', '#e0e0e0', '#ffd93d', '#ff6b6b', '#6bcb77', '#4d96ff', '#ff8fab', '#a0c4ff', '#caffbf'];
            const DARK_COLORS = ['#111111', '#222222', '#eeeeee', '#ffffff', '#ffd93d', '#ff6b6b', '#6bcb77', '#4d96ff', '#ff8fab', '#a0c4ff'];
            if (bgLum < 0.35) {
                _settings.title.color = LIGHT_COLORS[Math.floor(Math.random() * LIGHT_COLORS.length)];
            } else {
                _settings.title.color = DARK_COLORS[Math.floor(Math.random() * DARK_COLORS.length)];
            }
        }
        // Load fg images into runtime
        _fgImages = [];
        for (let i = 0; i < _settings.fgImages.length; i++) {
            const fg = _settings.fgImages[i];
            if (!fg.dataUrl) { _fgImages.push({}); continue; }
            const img = new Image();
            img.crossOrigin = 'anonymous';
            await new Promise(resolve => { img.onload = resolve; img.onerror = resolve; img.src = fg.dataUrl; });
            _fgImages.push({ img, cleanImg: img });
            if (fg.bgRemovedDataUrl) {
                const bgImg = new Image();
                bgImg.crossOrigin = 'anonymous';
                await new Promise(resolve => { bgImg.onload = resolve; bgImg.onerror = resolve; bgImg.src = fg.bgRemovedDataUrl; });
                _fgImages[i].img = bgImg;
            }
        }
        // Load background image into runtime from saved Supabase Storage URL
        _bgImage = null;
        if (_settings.cardBgType === 'image' && _settings.cardBackground && _settings.cardBackground.startsWith('http')) {
            try {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = _settings.cardBackground; });
                _bgImage = img;
            } catch (_) {}
        }
        // Auto-fit on first load (no saved settings)
        if (!hasSavedSettings) {
            autoFitContent();
        }
        // Wait for fonts to be loaded so canvas rendering uses correct typefaces
        try {
            await document.fonts.ready;
            const googleFonts = ['Playfair Display', 'Raleway', 'Montserrat', 'Open Sans', 'Lato', 'Inter', 'Plus Jakarta Sans', 'DM Sans', 'Poppins', 'Nunito', 'Lora', 'Source Serif 4', 'Instrument Serif', 'Instrument Sans', 'Fraunces'];
            const cdnFonts = ['Clash Display', 'Geist', 'Satoshi'];
            const allFonts = [...googleFonts, ...cdnFonts];
            const forceEl = document.createElement('div');
            forceEl.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;font-size:72px;';
            forceEl.innerHTML = allFonts.map(f => '<span style="font-family:\'' + f + '\'">.</span>').join('');
            document.body.appendChild(forceEl);
            void forceEl.offsetHeight;
            await document.fonts.ready;
            document.body.removeChild(forceEl);
        } catch (_) {}
        const modal = buildModal();
        enhanceColorInputs(modal);
        syncControlValues();
        renderPreview();
        modal.classList.add('open');
        document.body.classList.add('modal-open');
    }
    function autoFitContent() {
        const rawText = _article.title || _article.summary || '';
        if (!rawText)
            return;
        const text = rawText;
        const testCanvas = document.createElement('canvas');
        const testCtx = testCanvas.getContext('2d');
        const W = 1080, H = 1920;
        const fontScale = W / 420;
        const tpTop = _settings.textPadTop || 40;
        const tpBottom = _settings.textPadBottom || 40;
        const tpLeft = _settings.textPadLeft || 30;
        const tpRight = _settings.textPadRight || 30;
        const edgeMargin = 10;
        const shapeB = getShapeBounds(_settings.titleShape);

        _settings.title.fontSize = 15;
        const tt = _settings.title || { fontSize: 15 };

        for (let attempt = 0; attempt < 20; attempt++) {
            const tryFontSize = tt.fontSize + 1;
            const containerW = W * (_settings.titleShapeWidth / 100);
            const sizeFactor = containerW / (W * 0.8);
            let shapeW = containerW * shapeB.wFrac;
            const maxTextW = shapeW - tpLeft - tpRight;
            const fontSize = Math.round(tryFontSize * sizeFactor * fontScale);
            const lineH = Math.round(fontSize * 1.5);
            testCtx.font = (tt.italic ? 'italic ' : '') + (tt.bold ? '700 ' : '400 ') + fontSize + 'px ' + tt.fontFamily;
            const lineCount = wrapText(testCtx, text, 0, 0, maxTextW, lineH);
            const totalTextH = lineCount * lineH;
            const computedH = totalTextH + tpTop + tpBottom + 10;

            const halfW = containerW / 2;
            const halfH = computedH / 2;
            const minCenterX = halfW + edgeMargin;
            const maxCenterX = W - halfW - edgeMargin;
            if (minCenterX >= maxCenterX) break;
            if (computedH > H * 0.35) break;

            tt.fontSize = tryFontSize;
        }
    }
    function close() {
        if (_modal) {
            _modal.classList.remove('open');
            document.body.classList.remove('modal-open');
        }
        _article = null;
        _fgImages = [];
        _bgImage = null;
    }
    function syncControlValues() {
        const m = _modal;
        if (!m)
            return;
        const setSlider = (id, val) => {
            const el = m.querySelector('#' + id);
            if (el)
                el.value = val;
        };
        setSlider('qcs-tsw', _settings.titleShapeWidth);
        setSlider('qcs-dsw', _settings.descShapeWidth);
        setSlider('qcs-tpy', _settings.titleShapePosY);
        setSlider('qcs-gpos', _settings.titleShapePosY);
        setSlider('qcs-tox', _settings.titleShapeOffsetX || 0);
        setSlider('qcs-toy', _settings.titleShapeOffsetY || 0);
        setSlider('qcs-dpy', _settings.descShapePosY);
        setSlider('qcs-dox', _settings.descShapeOffsetX || 0);
        setSlider('qcs-doy', _settings.descShapeOffsetY || 0);
        setSlider('qcs-gap', _settings.shapeGap);
        setSlider('qcs-tpt', _settings.textPadTop);
        setSlider('qcs-tpr', _settings.textPadRight);
        setSlider('qcs-tpb', _settings.textPadBottom);
        setSlider('qcs-tpl', _settings.textPadLeft);
        setSlider('qcs-cc-opacity', _settings.containerOpacity);
        setSlider('qcs-cb-width', _settings.containerBorderWidth);
        // Update value labels
        const tswVal = m.querySelector('#qcs-tsw-val'); if (tswVal) tswVal.textContent = _settings.titleShapeWidth + '%';
        const dswVal = m.querySelector('#qcs-dsw-val'); if (dswVal) dswVal.textContent = _settings.descShapeWidth + '%';
        const tpyVal = m.querySelector('#qcs-tpy-val'); if (tpyVal) tpyVal.textContent = _settings.titleShapePosY + '%';
        const gposVal = m.querySelector('#qcs-gpos-val'); if (gposVal) gposVal.textContent = _settings.titleShapePosY + '%';
        const toxVal = m.querySelector('#qcs-tox-val'); if (toxVal) toxVal.textContent = (_settings.titleShapeOffsetX || 0) + '%';
        const toyVal = m.querySelector('#qcs-toy-val'); if (toyVal) toyVal.textContent = (_settings.titleShapeOffsetY || 0) + '%';
        const dpyVal = m.querySelector('#qcs-dpy-val'); if (dpyVal) dpyVal.textContent = _settings.descShapePosY + '%';
        const doxVal = m.querySelector('#qcs-dox-val'); if (doxVal) doxVal.textContent = (_settings.descShapeOffsetX || 0) + '%';
        const doyVal = m.querySelector('#qcs-doy-val'); if (doyVal) doyVal.textContent = (_settings.descShapeOffsetY || 0) + '%';
        const gapVal = m.querySelector('#qcs-gap-val'); if (gapVal) gapVal.textContent = _settings.shapeGap + 'px';
        const tptVal = m.querySelector('#qcs-tpt-val'); if (tptVal) tptVal.textContent = _settings.textPadTop + 'px';
        const tprVal = m.querySelector('#qcs-tpr-val'); if (tprVal) tprVal.textContent = _settings.textPadRight + 'px';
        const tpbVal = m.querySelector('#qcs-tpb-val'); if (tpbVal) tpbVal.textContent = _settings.textPadBottom + 'px';
        const tplVal = m.querySelector('#qcs-tpl-val'); if (tplVal) tplVal.textContent = _settings.textPadLeft + 'px';
        m.querySelector('#qcs-cc-opacity-val').textContent = _settings.containerOpacity + '%';
        m.querySelector('#qcs-cb-width-val').textContent = _settings.containerBorderWidth + 'px';
        // Background image fit + vignette + crop + border
        setSlider('qcs-vl', _settings.bgEdgeLR || 0);
        setSlider('qcs-vt', _settings.bgEdgeTB || 0);
        const vlVal = m.querySelector('#qcs-vl-val'); if (vlVal) vlVal.textContent = (_settings.bgEdgeLR || 0) + '%';
        const vtVal = m.querySelector('#qcs-vt-val'); if (vtVal) vtVal.textContent = (_settings.bgEdgeTB || 0) + '%';
        m.querySelectorAll('.qcs-bg-fit-btn').forEach(b => b.classList.toggle('active', b.dataset.fit === (_settings.bgImageFit || 'cover')));
        // Fill empty
        const fillToggle = m.querySelector('#qcs-bg-fill-empty');
        if (fillToggle) fillToggle.checked = !!_settings.bgFillEmpty;
        // Edge overlay
        const edgeSel = m.querySelector('#qcs-bg-edge-overlay');
        if (edgeSel) { edgeSel.value = _settings.bgEdgeOverlay || 'none'; m.querySelector('#qcs-vignette-opts').style.display = edgeSel.value === 'vignette' ? '' : 'none'; }
        // Crop
        const cropToggle = m.querySelector('#qcs-bg-crop');
        if (cropToggle) { cropToggle.checked = !!_settings.bgCrop; m.querySelector('#qcs-crop-opts').style.display = cropToggle.checked ? '' : 'none'; }
        setSlider('qcs-clr', _settings.bgCropLR || 0);
        setSlider('qcs-ctb', _settings.bgCropTB || 0);
        const clrVal = m.querySelector('#qcs-clr-val'); if (clrVal) clrVal.textContent = (_settings.bgCropLR || 0) + '%';
        const ctbVal = m.querySelector('#qcs-ctb-val'); if (ctbVal) ctbVal.textContent = (_settings.bgCropTB || 0) + '%';
        // BG Offset
        const bgPosCb2 = m.querySelector('#qcs-bg-pos-cb');
        if (bgPosCb2) { bgPosCb2.checked = !!_settings.bgPosEnabled; m.querySelector('#qcs-bg-pos-opts').style.display = bgPosCb2.checked ? '' : 'none'; }
        setSlider('qcs-boffx', _settings.bgOffsetX || 0);
        setSlider('qcs-boffy', _settings.bgOffsetY || 0);
        const boffxVal = m.querySelector('#qcs-boffx-val'); if (boffxVal) boffxVal.textContent = (_settings.bgOffsetX || 0) + '%';
        const boffyVal = m.querySelector('#qcs-boffy-val'); if (boffyVal) boffyVal.textContent = (_settings.bgOffsetY || 0) + '%';
        const bgScaleCb2 = m.querySelector('#qcs-bg-scale-cb');
        if (bgScaleCb2) { bgScaleCb2.checked = !!_settings.bgImageScaleEnabled; m.querySelector('#qcs-bg-scale-opts').style.display = bgScaleCb2.checked ? '' : 'none'; }
        setSlider('qcs-bgscale', _settings.bgImageScale || 100);
        const bgScaleVal = m.querySelector('#qcs-bgscale-val'); if (bgScaleVal) bgScaleVal.textContent = (_settings.bgImageScale || 100) + '%';
        // Border
        m.querySelectorAll('.qcs-border-style-btn').forEach(b => b.classList.toggle('active', b.dataset.bstyle === (_settings.borderStyle || 'none')));
        m.querySelectorAll('.qcs-border-place-btn').forEach(b => b.classList.toggle('active', b.dataset.bplace === (_settings.borderPlacement || 'all')));
        const borderOptsEl = m.querySelector('#qcs-border-opts');
        if (borderOptsEl) borderOptsEl.style.display = (_settings.borderStyle || 'none') === 'none' ? 'none' : '';
        const bSolidRow = m.querySelector('#qcs-border-solid-color-row');
        const bGradOpts = m.querySelector('#qcs-border-gradient-opts');
        if (bSolidRow) bSolidRow.style.display = (_settings.borderStyle || 'none') === 'gradient' ? 'none' : '';
        if (bGradOpts) bGradOpts.style.display = (_settings.borderStyle || 'none') === 'gradient' ? '' : 'none';
        setSlider('qcs-bw', _settings.borderWidth || 0);
        const bwVal = m.querySelector('#qcs-bw-val'); if (bwVal) bwVal.textContent = (_settings.borderWidth || 0) + 'px';
        const bColor = m.querySelector('#qcs-border-color'); if (bColor) bColor.value = _settings.borderColor || '#ffffff';
        setSlider('qcs-bo', _settings.borderOpacity || 100);
        const boVal = m.querySelector('#qcs-bo-val'); if (boVal) boVal.textContent = (_settings.borderOpacity || 100) + '%';
        // Per-element sync
        const ELEMENTS = ['pt', 'pd', 'wm', 'dt'];
        const ELEMENT_KEYS = { pt: 'title', pd: 'description', wm: 'watermark', dt: 'date' };
        ELEMENTS.forEach(p => {
            const s = _settings[ELEMENT_KEYS[p]];
            if (!s) return;
            setSlider('qcs-' + p + '-size', s.fontSize);
            const sizeVal = m.querySelector('#qcs-' + p + '-size-val');
            if (sizeVal) sizeVal.textContent = s.fontSize + 'px';
            setSlider('qcs-' + p + '-opacity', s.opacity);
            const opVal = m.querySelector('#qcs-' + p + '-opacity-val');
            if (opVal) opVal.textContent = s.opacity + '%';
            const colorEl = m.querySelector('#qcs-' + p + '-color');
            if (colorEl) colorEl.value = s.color;
            const fontEl = m.querySelector('#qcs-' + p + '-font');
            if (fontEl) fontEl.value = s.fontFamily;
            const showEl = m.querySelector('#qcs-' + p + '-show');
            if (showEl) showEl.checked = s.show;
            // Title is always forced on
            if (p === 'pt' && showEl) { showEl.checked = true; showEl.disabled = true; }
            // Style buttons
            const styleRow = m.querySelector('#qcs-' + p + '-style-row');
            if (styleRow) {
                styleRow.querySelectorAll('.qcs-style-btn').forEach(btn => {
                    btn.classList.toggle('active', s[btn.dataset.style]);
                });
            }
            // Effect grid
            const effectGrid = m.querySelector('#qcs-' + p + '-effect-grid');
            if (effectGrid) {
                effectGrid.querySelectorAll('.qcs-effect-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.effect === s.textEffect);
                });
            }
            const effectOpts = m.querySelector('#qcs-' + p + '-effect-opts');
            if (effectOpts) effectOpts.style.display = s.textEffect !== 'none' ? '' : 'none';
            const ecEl = m.querySelector('#qcs-' + p + '-effect-color');
            if (ecEl) ecEl.value = s.textEffectColor;
            const eiSlider = m.querySelector('#qcs-' + p + '-effect-int');
            if (eiSlider) eiSlider.value = s.textEffectIntensity;
            const eiVal = m.querySelector('#qcs-' + p + '-effect-int-val');
            if (eiVal) eiVal.textContent = s.textEffectIntensity;
        });
        // Toggle uniform vs separate sizing — removed for two-shape system
        // Title shape buttons
        m.querySelectorAll('#qcs-title-shape-grid .qcs-shape-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.shape === _settings.titleShape);
        });
        // Description shape buttons
        m.querySelectorAll('#qcs-desc-shape-grid .qcs-shape-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.shape === _settings.descShape);
        });
        // Alignment
        m.querySelector('#qcs-align-row').querySelectorAll('.qcs-align-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.align === _settings.textAlignment);
        });
        // Vertical position
        const vposRow = m.querySelector('#qcs-vpos-row');
        if (vposRow) {
            vposRow.querySelectorAll('.qcs-align-btn').forEach(b => {
                b.classList.toggle('active', b.dataset.vpos === _settings.textVerticalAlign);
            });
        }
        // Color pickers
        const ccColor = parseColor(_settings.containerColor);
        const ccHex = '#' + [ccColor.r, ccColor.g, ccColor.b].map(v => v.toString(16).padStart(2, '0')).join('');
        const ccInput = m.querySelector('#qcs-cc-color');
        if (ccInput) ccInput.value = ccHex;
        const cbInput = m.querySelector('#qcs-cb-color');
        if (cbInput) cbInput.value = _settings.containerBorderColor;
        // Container border style sync
        const cbStyle = _settings.containerBorderStyle || 'solid';
        m.querySelectorAll('.qcs-cb-style-btn').forEach(b => b.classList.toggle('active', b.dataset.cbstyle === cbStyle));
        const cbSolidOpts = m.querySelector('#qcs-cb-solid-opts');
        const cbGradOpts = m.querySelector('#qcs-cb-gradient-opts');
        if (cbSolidOpts) cbSolidOpts.style.display = cbStyle === 'gradient' ? 'none' : '';
        if (cbGradOpts) cbGradOpts.style.display = cbStyle === 'gradient' ? '' : 'none';
        const cbgC1 = m.querySelector('#qcs-cbg-c1');
        const cbgC2 = m.querySelector('#qcs-cbg-c2');
        const cbgAngle = m.querySelector('#qcs-cbg-angle');
        const cbgAngleVal = m.querySelector('#qcs-cbg-angle-val');
        if (cbgC1 && _settings.containerBorderGradient) {
            const gColors = _settings.containerBorderGradient.match(/#[0-9a-fA-F]{3,8}/g) || ['#ffffff','#888888'];
            cbgC1.value = gColors[0] || '#ffffff';
            if (cbgC2) cbgC2.value = gColors[1] || '#888888';
        }
        if (cbgAngle) cbgAngle.value = _settings.containerBorderGradientAngle || 135;
        if (cbgAngleVal) cbgAngleVal.textContent = (_settings.containerBorderGradientAngle || 135) + '°';
        // Ratio buttons
        m.querySelector('#qcs-ratio-grid').querySelectorAll('.qcs-ratio-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.ratio === _settings.aspectRatio);
        });
        // Group position buttons
        m.querySelectorAll('#qcs-group-pos-grid .qcs-ratio-btn').forEach(b => {
            b.classList.toggle('active', parseFloat(b.dataset.gpos) === _settings.titleShapePosY);
        });
        // Preview gradient selection
        m.querySelectorAll('.qcs-grad-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.gradient === _settings.cardBackground);
        });
        // FG images panel re-render
        renderFgImagesPanel();
        // Separator controls
        const sep = _settings.separator || {};
        const sepShowEl = m.querySelector('#qcs-sep-show');
        if (sepShowEl) { sepShowEl.checked = !!sep.show; }
        const sepOptsEl = m.querySelector('#qcs-sep-opts');
        if (sepOptsEl) sepOptsEl.style.display = sep.show ? '' : 'none';
        const setSepSlider = (id, val) => { const el = m.querySelector('#' + id); if (el) el.value = val; };
        setSepSlider('qcs-sep-thick', sep.thickness || 2);
        setSepSlider('qcs-sep-len', sep.length || 30);
        setSepSlider('qcs-sep-width', sep.width || 80);
        setSepSlider('qcs-sep-top', sep.topOffset || 0);
        setSepSlider('qcs-sep-left', sep.leftOffset || 0);
        const setSepLabel = (id, val) => { const el = m.querySelector('#' + id); if (el) el.textContent = val; };
        setSepLabel('qcs-sep-thick-val', (sep.thickness || 2) + 'px');
        setSepLabel('qcs-sep-len-val', (sep.length || 30) + '%');
        setSepLabel('qcs-sep-width-val', (sep.width || 80) + '%');
        setSepLabel('qcs-sep-top-val', (sep.topOffset || 0) + 'px');
        setSepLabel('qcs-sep-left-val', (sep.leftOffset || 0) + '%');
        const sepColorEl = m.querySelector('#qcs-sep-color');
        if (sepColorEl) sepColorEl.value = sep.color || '#ffffff';
        // Preview shape icons
        m.querySelectorAll('[data-shape-icon]').forEach(el => {
            const shape = el.dataset.shapeIcon;
            const clip = getClipPathCSS(shape);
            el.style.clipPath = clip || 'none';
            el.style.webkitClipPath = clip || 'none';
        });
    }
    /* ── Public API ── */
    let _renderLock = Promise.resolve();
    async function renderCardCanvas(designData, articleData, cardMeta) {
        // Serialize: wait for any in-progress render to finish first
        await _renderLock;
        let release;
        _renderLock = new Promise(r => { release = r; });
        const prevSettings = JSON.parse(JSON.stringify(_settings));
        const prevArticle = _article;
        const prevBg = _bgImage;
        const prevFg = _fgImages;
        _settings = designData || defaultSettings();
        _article = articleData;
        _cardMeta = cardMeta || null;
        _bgImage = null;
        _fgImages = [];
        if (_settings.cardBgType === 'image' && _settings.cardBackground && _settings.cardBackground.startsWith('http')) {
            try {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = _settings.cardBackground; });
                _bgImage = img;
            } catch (_) {}
        }
        // Load foreground images from storage URLs
        if (_settings.fgImages && _settings.fgImages.length) {
            for (let i = 0; i < _settings.fgImages.length; i++) {
                const fg = _settings.fgImages[i];
                const url = (fg.removeBgEnabled && fg.bgRemovedDataUrl) ? fg.bgRemovedDataUrl : fg.dataUrl;
                if (url && url.startsWith('http')) {
                    try {
                        const img = new Image();
                        img.crossOrigin = 'anonymous';
                        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
                        _fgImages[i] = { img, cleanImg: img };
                    } catch (_) { _fgImages[i] = {}; }
                } else { _fgImages[i] = {}; }
            }
        }
        try {
            await document.fonts.ready;
            const googleFonts = ['Playfair Display', 'Raleway', 'Montserrat', 'Open Sans', 'Lato', 'Inter', 'Plus Jakarta Sans', 'DM Sans', 'Poppins', 'Nunito', 'Lora', 'Source Serif 4', 'Instrument Serif', 'Instrument Sans', 'Fraunces'];
            const cdnFonts = ['Clash Display', 'Geist', 'Satoshi'];
            const allFonts = [...googleFonts, ...cdnFonts];
            const forceEl = document.createElement('div');
            forceEl.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;font-size:72px;';
            forceEl.innerHTML = allFonts.map(f => '<span style="font-family:\'' + f + '\'">.</span>').join('');
            document.body.appendChild(forceEl);
            void forceEl.offsetHeight;
            await document.fonts.ready;
            document.body.removeChild(forceEl);
        } catch (_) {}
        const canvas = renderExportCanvas();
        _settings = prevSettings;
        _article = prevArticle;
        _bgImage = prevBg;
        _fgImages = prevFg;
        _cardMeta = null;
        release();
        return canvas;
    }
    return {
        open,
        close,
        getSettings: () => JSON.parse(JSON.stringify(_settings)),
        setSettings: (s) => { Object.assign(_settings, s); if (_modal && _modal.classList.contains('open')) {
            syncControlValues();
            renderPreview();
        } },
        saveSettings,
        loadSettings,
        renderExportCanvas,
        renderCardCanvas,
        smartContrast,
        defaultSettings,
    };
})();
window.PostDesigner = PostDesigner;
