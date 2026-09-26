"""posts.json 의 게시물 하나를 9:16 숏폼 영상(MP4)으로 만든다.

슬라이드마다 Pillow 로 1080x1920 이미지를 그리고,
ffmpeg 로 줌 + 페이드 효과를 넣어 이어 붙인 뒤 배경음악을 입힌다.
마지막에는 "프로필 링크" 안내 엔딩 카드를 자동으로 붙인다.
"""

import os
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

W, H = 1080, 1920
FPS = 30
FADE = 0.3

FONT_CANDIDATES = [
    # Windows
    "C:/Windows/Fonts/malgunbd.ttf",
    "C:/Windows/Fonts/malgun.ttf",
    # macOS
    "/System/Library/Fonts/AppleSDGothicNeo.ttc",
    "/Library/Fonts/NanumGothicBold.ttf",
    # Linux
    "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]


def find_font(preferred=None):
    for path in [preferred, *FONT_CANDIDATES]:
        if path and Path(path).exists():
            return path
    raise SystemExit(
        "한글 폰트를 찾지 못했습니다. posts.json 의 defaults.font 에 .ttf/.otf 경로를 넣어 주세요."
    )


def find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        raise SystemExit("ffmpeg 가 없습니다. `pip install imageio-ffmpeg` 또는 ffmpeg 를 설치해 주세요.")


def hex_rgb(value):
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))


# ---------------- 텍스트 ----------------


def wrap_text(draw, text, font, max_width):
    """한글도 자연스럽게 줄바꿈: 띄어쓰기 단위로 넣다가 한 단어가 너무 길면 글자 단위로 자른다."""
    lines = []
    for paragraph in text.split("\n"):
        line = ""
        for word in paragraph.split(" "):
            candidate = f"{line} {word}".strip()
            if draw.textlength(candidate, font=font) <= max_width:
                line = candidate
                continue
            if line:
                lines.append(line)
            line = ""
            for ch in word:
                if draw.textlength(line + ch, font=font) > max_width and line:
                    lines.append(line)
                    line = ""
                line += ch
        lines.append(line)
    return lines


def fit_text(draw, text, font_path, max_width, max_height, start_size, min_size=40):
    """영역 안에 들어갈 때까지 글자 크기를 줄인다."""
    size = start_size
    while True:
        font = ImageFont.truetype(font_path, size)
        lines = wrap_text(draw, text, font, max_width)
        line_h = int(size * 1.3)
        if len(lines) * line_h <= max_height or size <= min_size:
            return font, lines, line_h
        size -= 4


def draw_block(draw, lines, font, line_h, center_y, fill, stroke_fill=(0, 0, 0), stroke=6):
    top = center_y - len(lines) * line_h // 2
    for i, line in enumerate(lines):
        draw.text(
            (W // 2, top + i * line_h + line_h // 2),
            line,
            font=font,
            fill=fill,
            anchor="mm",
            stroke_width=stroke,
            stroke_fill=stroke_fill,
        )


# ---------------- 배경 ----------------


def gradient(top, bottom):
    top, bottom = hex_rgb(top), hex_rgb(bottom)
    img = Image.new("RGB", (W, H))
    px = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        color = tuple(int(a + (b - a) * t) for a, b in zip(top, bottom))
        px.line([(0, y), (W, y)], fill=color)
    return img


def image_background(path, fit):
    src = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    if fit == "cover":
        return ImageOps.fit(src, (W, H), Image.LANCZOS)
    # contain: 흐린 배경 위에 원본 비율 그대로
    bg = ImageOps.fit(src, (W, H), Image.LANCZOS).filter(ImageFilter.GaussianBlur(40))
    fg = ImageOps.contain(src, (W, H), Image.LANCZOS)
    bg.paste(fg, ((W - fg.width) // 2, (H - fg.height) // 2))
    return bg


def darken(img, amount):
    if amount <= 0:
        return img
    overlay = Image.new("RGB", img.size, (0, 0, 0))
    return Image.blend(img, overlay, amount)


# ---------------- 슬라이드 ----------------


def render_slide(slide, post, opts, font_path, base_dir):
    theme = opts["theme"]
    if slide.get("image"):
        img = image_background(base_dir / slide["image"], slide.get("fit", "contain"))
        img = darken(img, 0.35 if slide.get("text") else 0)
    else:
        img = gradient(slide.get("bg_top", theme["bg_top"]), slide.get("bg_bottom", theme["bg_bottom"]))
    draw = ImageDraw.Draw(img)

    title = post.get("title")
    if title:
        font, lines, line_h = fit_text(draw, title, font_path, W - 160, 260, 76)
        draw_block(draw, lines, font, line_h, 250, hex_rgb(theme["title_color"]))

    text = slide.get("text")
    if text:
        # 사진 슬라이드는 자막처럼 아래쪽, 텍스트 슬라이드는 가운데
        center_y = 1250 if slide.get("image") else H // 2
        max_h = 420 if slide.get("image") else 900
        font, lines, line_h = fit_text(draw, text, font_path, W - 140, max_h, slide.get("size", 96))
        draw_block(draw, lines, font, line_h, center_y, hex_rgb(slide.get("color", theme["text_color"])))
    return img


def render_end_card(post, opts, font_path):
    theme = opts["theme"]
    img = gradient(theme["bg_top"], theme["bg_bottom"])
    draw = ImageDraw.Draw(img)

    cta = post.get("cta", opts["cta"])
    font, lines, line_h = fit_text(draw, cta, font_path, W - 140, 520, 104)
    draw_block(draw, lines, font, line_h, 760, hex_rgb(theme["text_color"]))

    # 노란 버튼 모양 안내
    btn = post.get("button", opts["button"])
    bfont = ImageFont.truetype(font_path, 68)
    bw = int(draw.textlength(btn, font=bfont)) + 140
    box = [(W - bw) // 2, 1120, (W + bw) // 2, 1280]
    draw.rounded_rectangle(box, radius=80, fill=hex_rgb(theme["accent"]))
    draw.text((W // 2, 1200), btn, font=bfont, fill=(20, 20, 20), anchor="mm")

    # 위쪽 화살표 (프로필 방향)
    ax, ay = W // 2, 1420
    draw.polygon([(ax, ay), (ax - 60, ay + 80), (ax + 60, ay + 80)], fill=hex_rgb(theme["accent"]))
    draw.rectangle([ax - 20, ay + 80, ax + 20, ay + 180], fill=hex_rgb(theme["accent"]))
    return img


# ---------------- 조립 ----------------


def build_video(post, opts, base_dir, out_path, font_path=None, ffmpeg=None):
    """게시물 하나를 영상으로 만든다. 만든 파일 경로를 돌려준다."""
    font_path = find_font(font_path or opts.get("font"))
    ffmpeg = ffmpeg or find_ffmpeg()
    work = out_path.parent / f".{out_path.stem}_frames"
    work.mkdir(parents=True, exist_ok=True)

    slides = []
    for i, slide in enumerate(post["slides"]):
        png = work / f"{i:02d}.png"
        render_slide(slide, post, opts, font_path, base_dir).save(png)
        slides.append((png, float(slide.get("seconds", opts["slide_seconds"]))))
    if opts.get("end_card", True):
        png = work / "end.png"
        render_end_card(post, opts, font_path).save(png)
        slides.append((png, float(opts["end_seconds"])))

    total = sum(d for _, d in slides)
    args = [ffmpeg, "-y", "-loglevel", "error"]
    filters = []
    for i, (png, dur) in enumerate(slides):
        args += ["-i", str(png)]
        frames = max(1, round(dur * FPS))
        zoom = (
            f"scale=2160:-1,zoompan=z='1+0.06*on/{frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
            f":d={frames}:s={W}x{H}:fps={FPS},"
            if opts.get("zoom", True)
            else f"loop={frames - 1}:1:0,fps={FPS},"
        )
        filters.append(
            f"[{i}:v]{zoom}setsar=1,format=yuv420p,"
            f"fade=t=in:st=0:d={FADE},fade=t=out:st={dur - FADE:.3f}:d={FADE}[v{i}]"
        )
    filters.append("".join(f"[v{i}]" for i in range(len(slides))) + f"concat=n={len(slides)}:v=1:a=0[v]")

    bgm = post.get("bgm", opts.get("bgm"))
    audio_idx = len(slides)
    if bgm:
        args += ["-stream_loop", "-1", "-i", str(base_dir / bgm)]
        vol = float(opts.get("bgm_volume", 0.8))
        filters.append(
            f"[{audio_idx}:a]atrim=0:{total:.3f},volume={vol},"
            f"afade=t=out:st={max(0, total - 1.5):.3f}:d=1.5[a]"
        )
    else:
        args += ["-f", "lavfi", "-t", f"{total:.3f}", "-i", "anullsrc=r=44100:cl=stereo"]
        filters.append(f"[{audio_idx}:a]anull[a]")

    args += [
        "-filter_complex", ";".join(filters),
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", str(FPS),
        "-c:a", "aac", "-b:a", "160k",
        "-t", f"{total:.3f}", "-movflags", "+faststart",
        str(out_path),
    ]
    subprocess.run(args, check=True)
    shutil.rmtree(work, ignore_errors=True)
    return out_path


def default_opts(defaults):
    opts = {
        "slide_seconds": 2.5,
        "end_seconds": 3,
        "zoom": True,
        "end_card": True,
        "cta": "지금 토스에서\n바로 받아가세요",
        "button": "프로필 링크 클릭",
        "bgm": None,
        "bgm_volume": 0.8,
        "font": os.environ.get("SHORTFORM_FONT"),
        "theme": {},
    }
    opts.update({k: v for k, v in defaults.items() if k != "theme"})
    opts["theme"] = {
        "bg_top": "#0050FF",
        "bg_bottom": "#001A66",
        "text_color": "#FFFFFF",
        "title_color": "#FFE14D",
        "accent": "#FFE14D",
        **defaults.get("theme", {}),
    }
    return opts
