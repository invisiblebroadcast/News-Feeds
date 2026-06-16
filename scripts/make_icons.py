#!/usr/bin/env python3
"""
Generate IB logo PNGs from a vector definition. We don't have rsvg-convert
or ImageMagick, so we draw the icon directly with Pillow (PIL).

Output:
  icons/icon-192.png        PWA standard
  icons/icon-512.png        PWA standard
  icons/icon-maskable-512.png  PWA maskable (extra padding for safe area)
  icons/apple-touch-icon.png  180x180
  icons/social-2000x3000.png 2:3 social media banner with wordmark
"""
import os
import math
from PIL import Image, ImageDraw, ImageFont

# Brand colors
RED   = (255, 41, 41, 255)        # #ff2929
DARK  = (10, 10, 15, 255)         # #0a0a0f
WHITE = (255, 255, 255, 255)

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(OUT_DIR, exist_ok=True)

def get_font(size, weight='regular'):
    """Find a bold sans-serif font that exists on the system."""
    candidates = [
        # Linux common paths
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
        # macOS
        '/System/Library/Fonts/Helvetica.ttc',
        '/Library/Fonts/Arial Bold.ttf',
        # Windows
        'C:/Windows/Fonts/arialbd.ttf',
        'C:/Windows/Fonts/calibrib.ttf',
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()

def draw_ib_icon(size, rounded=True, padding=0, fg=WHITE, bg=RED):
    """Draw a red rounded square with the white 'IB' monogram inside.

    size: outer canvas edge length (square).
    padding: extra inner margin (used for the maskable icon safe area).
    """
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Rounded rectangle
    radius = int(size * 0.1875) if rounded else 0
    if padding > 0:
        d.rounded_rectangle(
            (padding, padding, size - padding - 1, size - padding - 1),
            radius=max(0, radius - padding // 2),
            fill=bg
        )
    else:
        d.rounded_rectangle(
            (0, 0, size - 1, size - 1),
            radius=radius,
            fill=bg
        )
    # The 'IB' monogram. Pick a font size proportional to canvas.
    inner = size - 2 * padding
    font_size = int(inner * 0.40)
    font = get_font(font_size)
    text = 'IB'
    # Measure text
    bbox = d.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    # Center
    x = (size - text_w) // 2 - bbox[0]
    y = (size - text_h) // 2 - bbox[1]
    d.text((x, y), text, font=font, fill=fg)
    return img

def main():
    # 192x192 PWA
    img = draw_ib_icon(192)
    img.save(os.path.join(OUT_DIR, 'icon-192.png'), 'PNG', optimize=True)
    print('Wrote icon-192.png')

    # 512x512 PWA
    img = draw_ib_icon(512)
    img.save(os.path.join(OUT_DIR, 'icon-512.png'), 'PNG', optimize=True)
    print('Wrote icon-512.png')

    # 512x512 maskable (extra ~12% safe-area padding so the OS can
    # round/crop without clipping the monogram)
    img = draw_ib_icon(512, padding=int(512 * 0.12))
    img.save(os.path.join(OUT_DIR, 'icon-maskable-512.png'), 'PNG', optimize=True)
    print('Wrote icon-maskable-512.png')

    # 180x180 Apple touch icon (no rounding — iOS applies its own)
    img = draw_ib_icon(180, rounded=False)
    img.save(os.path.join(OUT_DIR, 'apple-touch-icon.png'), 'PNG', optimize=True)
    print('Wrote apple-touch-icon.png')

    # 2000x3000 social media (2:3). Logo on top, wordmark below.
    social = Image.new('RGB', (2000, 3000), DARK[:3])
    d = ImageDraw.Draw(social)
    # Top 2/3 holds the logo, bottom 1/3 the wordmark/tagline.
    logo_size = 1400
    logo = draw_ib_icon(logo_size)
    logo_x = (2000 - logo_size) // 2
    logo_y = 300
    social.paste(logo, (logo_x, logo_y), logo)

    # Wordmark "Invisible Broadcast" + tagline
    title_font = get_font(160)
    sub_font = get_font(70)
    title = 'Invisible Broadcast'
    sub = 'Global & Local News Aggregator'

    # Centered text
    def centered_text(d, text, font, y, fill=WHITE):
        bbox = d.textbbox((0, 0), text, font=font)
        w = bbox[2] - bbox[0]
        x = (2000 - w) // 2 - bbox[0]
        d.text((x, y), text, font=font, fill=fill)

    centered_text(d, title, title_font, 1900)
    centered_text(d, sub, sub_font, 2150, fill=(200, 200, 200))

    # Save at high quality
    social.save(os.path.join(OUT_DIR, 'social-2000x3000.png'), 'PNG', optimize=True)
    print('Wrote social-2000x3000.png')

if __name__ == '__main__':
    main()
