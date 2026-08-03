"""Generate Presence launcher/splash/PWA icons from the concentric-circle mark."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "frontend" / "public"
ANDROID_RES = ROOT / "frontend" / "android" / "app" / "src" / "main" / "res"
BG = (14, 17, 20, 255)  # #0E1114
FG = (196, 204, 212, 255)  # #C4CCD4


def draw_mark(size: int, *, pad_ratio: float = 0.18) -> Image.Image:
    img = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(img)
    pad = size * pad_ratio
    # Outer ring
    ring_inset = pad
    stroke = max(2, int(size * 0.05))
    draw.ellipse(
        [ring_inset, ring_inset, size - ring_inset, size - ring_inset],
        outline=FG,
        width=stroke,
    )
    # Center dot
    r = max(2, int(size * 0.05))
    cx = cy = size / 2
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=FG)
    return img


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG")
    print(f"wrote {path.relative_to(ROOT)}")


def main() -> None:
    # PWA / web
    save(draw_mark(192), PUBLIC / "icon-192.png")
    save(draw_mark(512), PUBLIC / "icon-512.png")

    # Launcher icons (legacy flat)
    launcher = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    for folder, size in launcher.items():
        icon = draw_mark(size)
        save(icon, ANDROID_RES / folder / "ic_launcher.png")
        save(icon, ANDROID_RES / folder / "ic_launcher_round.png")

    # Adaptive foreground (safe zone ~66% — use more pad)
    foreground = {
        "mipmap-mdpi": 108,
        "mipmap-hdpi": 162,
        "mipmap-xhdpi": 216,
        "mipmap-xxhdpi": 324,
        "mipmap-xxxhdpi": 432,
    }
    for folder, size in foreground.items():
        save(
            draw_mark(size, pad_ratio=0.28),
            ANDROID_RES / folder / "ic_launcher_foreground.png",
        )

    # Splash screens — full-bleed dark with centered mark
    splash_sizes = {
        "drawable": (480, 800),
        "drawable-port-mdpi": (320, 480),
        "drawable-port-hdpi": (480, 800),
        "drawable-port-xhdpi": (720, 1280),
        "drawable-port-xxhdpi": (1080, 1920),
        "drawable-port-xxxhdpi": (1440, 2560),
        "drawable-land-mdpi": (480, 320),
        "drawable-land-hdpi": (800, 480),
        "drawable-land-xhdpi": (1280, 720),
        "drawable-land-xxhdpi": (1920, 1080),
        "drawable-land-xxxhdpi": (2560, 1440),
    }
    for folder, (w, h) in splash_sizes.items():
        canvas = Image.new("RGBA", (w, h), BG)
        mark_size = min(w, h) // 4
        mark = draw_mark(mark_size)
        canvas.paste(
            mark,
            ((w - mark_size) // 2, (h - mark_size) // 2),
            mark,
        )
        save(canvas, ANDROID_RES / folder / "splash.png")

    # Adaptive background color
    bg_xml = ANDROID_RES / "values" / "ic_launcher_background.xml"
    bg_xml.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        '    <color name="ic_launcher_background">#0E1114</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )
    print(f"wrote {bg_xml.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
