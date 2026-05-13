#!/usr/bin/env python3
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import math

ROOT = Path(__file__).resolve().parent
OUT_1X = ROOT / "firmware-ui-preview-1x.png"
OUT_2X = ROOT / "firmware-ui-preview-2x.png"

W, H = 240, 135

COLORS = {
    "bg": "#121212",
    "text": "#ffffff",
    "text_dim": "#a0a0a0",
    "clawd": "#ff6b35",
    "orange": "#ff6b35",
    "orange_text": "#ff8c42",
    "green": "#a8e6cf",
    "track": "#3d3d3d",
    "badge_bg": "#4a3b5c",
    "badge_text": "#d8b4e2",
    "red": "#ff4d4d",
}

try:
    FONT_SMALL = ImageFont.truetype("/System/Library/Fonts/Monaco.ttf", 10)
    FONT_MED = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 16)
    FONT_TITLE = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 16)
except Exception:
    FONT_SMALL = ImageFont.load_default()
    FONT_MED = ImageFont.load_default()
    FONT_TITLE = ImageFont.load_default()


def text_size(draw, text, font):
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


def text_tl(draw, text, x, y, font, fill):
    draw.text((x, y), text, font=font, fill=fill)


def text_mc(draw, text, x, y, font, fill):
    tw, th = text_size(draw, text, font)
    draw.text((x - tw / 2, y - th / 2), text, font=font, fill=fill)


def draw_clawd(draw, x, y, scale):
    rows = [
        "...XXXXXXXXXXXX...",
        "...XX.XXXXXX.XX...",
        ".XXXXXXXXXXXXXXXX.",
        "...XXXXXXXXXXXX...",
        "....X.X....X.X....",
    ]
    cell_w = scale
    cell_h = scale * 2
    for row, line in enumerate(rows):
        for col, ch in enumerate(line):
            if ch == "X":
                draw.rectangle(
                    [
                        x + col * cell_w,
                        y + row * cell_h,
                        x + (col + 1) * cell_w - 1,
                        y + (row + 1) * cell_h - 1,
                    ],
                    fill=COLORS["clawd"],
                )


def draw_battery(draw, x, y, pct=72, charging=False):
    w, h = 18, 8
    if pct <= 5:
        blocks = 0
    elif pct <= 25:
        blocks = 1
    elif pct <= 50:
        blocks = 2
    elif pct <= 75:
        blocks = 3
    else:
        blocks = 4
    low = blocks <= 1 and not charging
    color = COLORS["red"] if low else COLORS["text"]
    draw.rectangle([x, y, x + w, y + h], outline=color)
    draw.rectangle([x + w, y + 2, x + w + 1, y + 5], fill=color)
    for i in range(4):
        bx = x + 2 + i * 4
        if i < blocks:
            draw.rectangle([bx, y + 2, bx + 2, y + h - 2], fill=color)
        elif low:
            draw.rectangle([bx, y + 2, bx + 2, y + h - 2], outline=color)


def draw_spark(draw, x, y):
    for i in range(8):
        angle = i * math.pi / 4
        x2 = x + int(math.cos(angle) * 4)
        y2 = y + int(math.sin(angle) * 4)
        draw.line([x, y, x2, y2], fill=COLORS["orange_text"], width=1)
    draw.ellipse([x - 1, y - 1, x + 1, y + 1], fill=COLORS["orange_text"])


def draw_badge(draw, x, y, label):
    draw.rounded_rectangle([x, y, x + 46, y + 12], radius=4, fill=COLORS["badge_bg"])
    text_x = x + 24
    text_y = y + 6
    if label == "Weekly":
        text_x += 2
    text_mc(draw, label, text_x, text_y, FONT_SMALL, COLORS["badge_text"])


def draw_progress(draw, x, y, w, h, pct, fill):
    pct = max(0, min(100, pct))
    draw.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=COLORS["track"])
    fill_w = int(w * pct / 100)
    if fill_w > 0:
        draw.rounded_rectangle([x, y, x + fill_w, y + h], radius=h // 2, fill=fill)


def draw_usage_section(draw, y, label, used_pct, reset_text, fill):
    padding_x = 10
    text_tl(draw, f"{used_pct}%", padding_x, y - 1, FONT_MED, COLORS["text"])
    draw_badge(draw, 184, y + 2, label)
    draw_progress(draw, padding_x, y + 20, 220, 6, used_pct, fill)
    text_tl(draw, f"Resets in {reset_text}", padding_x, y + 28, FONT_SMALL, COLORS["text_dim"])


def render():
    img = Image.new("RGB", (W, H), COLORS["bg"])
    draw = ImageDraw.Draw(img)

    draw_clawd(draw, 8, 6, 2)
    text_mc(draw, "Usage", 120, 13, FONT_TITLE, COLORS["text"])
    draw_battery(draw, 214, 8)

    draw_usage_section(draw, 32, "Current", 50, "1h 22m", COLORS["orange"])
    draw_usage_section(draw, 76, "Weekly", 11, "6d 8h", COLORS["green"])

    status = "Live data"
    icon_w = 8
    spacing = 4
    text_w, _ = text_size(draw, status, FONT_SMALL)
    start_x = int((240 - icon_w - spacing - text_w) / 2)
    draw_spark(draw, start_x + 4, 125)
    text_tl(draw, status, start_x + icon_w + spacing, 119, FONT_SMALL, COLORS["orange_text"])

    img.save(OUT_1X)
    img.resize((W * 2, H * 2), Image.Resampling.NEAREST).save(OUT_2X)
    print(OUT_1X)
    print(OUT_2X)


if __name__ == "__main__":
    render()
