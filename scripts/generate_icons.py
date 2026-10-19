"""Rebuild the existing Pitchwork mark as app icons. Requires Pillow."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'public'

for name, size in [('icon-192.png', 192), ('icon-512.png', 512), ('icon-maskable.png', 512), ('apple-touch-icon.png', 180)]:
    scale = 4
    image = Image.new('RGB', (size * scale, size * scale), '#142b26')
    draw = ImageDraw.Draw(image)
    def box(coords):
        return tuple(round(value / 512 * size * scale) for value in coords)
    # Central 60% safe area keeps the mark intact under circular home-screen masks.
    draw.rounded_rectangle(box((154, 128, 362, 326)), radius=round(75 / 512 * size * scale), fill='#dbef9d')
    draw.rectangle(box((154, 202, 216, 384)), fill='#dbef9d')
    draw.rounded_rectangle(box((216, 190, 300, 264)), radius=round(30 / 512 * size * scale), fill='#142b26')
    image.resize((size, size), Image.Resampling.LANCZOS).save(root / name)
