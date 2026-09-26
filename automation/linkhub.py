"""틱톡 프로필(바이오)에 걸어 둘 '링크 모음' 페이지를 만든다.

틱톡은 영상 캡션 속 링크를 누를 수 없고 프로필에 링크 1개만 걸 수 있다.
그래서 게시물마다 버튼이 있는 페이지 하나를 만들고, 그 주소를 프로필에 건다.
"""

import html
from pathlib import Path

PAGE = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  :root {{ --bg:#f2f4f6; --card:#fff; --text:#191f28; --sub:#6b7684; --btn:#3182f6; }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#101113; --card:#1c1d21; --text:#f2f4f6; --sub:#9aa2ad; }}
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--text);
         font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif; }}
  main {{ max-width:480px; margin:0 auto; padding:32px 16px 48px; }}
  h1 {{ font-size:22px; margin:0 0 6px; }}
  p.sub {{ color:var(--sub); margin:0 0 24px; font-size:15px; }}
  a.item {{ display:block; background:var(--card); border-radius:16px; padding:18px 20px; margin-bottom:12px;
           text-decoration:none; color:inherit; box-shadow:0 1px 3px rgba(0,0,0,.06); }}
  a.item strong {{ display:block; font-size:17px; margin-bottom:4px; }}
  a.item span {{ color:var(--sub); font-size:14px; }}
  a.item em {{ display:inline-block; margin-top:12px; background:var(--btn); color:#fff; font-style:normal;
              font-weight:600; font-size:15px; padding:10px 16px; border-radius:10px; }}
  footer {{ color:var(--sub); font-size:12px; margin-top:24px; line-height:1.5; }}
</style>
</head>
<body>
<main>
  <h1>{title}</h1>
  <p class="sub">{subtitle}</p>
{items}
  <footer>{footer}</footer>
</main>
</body>
</html>
"""

ITEM = """  <a class="item" href="{url}" target="_blank" rel="noopener">
    <strong>{name}</strong>
    <span>{desc}</span><br>
    <em>{button}</em>
  </a>"""


def build_linkhub(data, out_dir):
    hub = data.get("linkhub", {})
    items = []
    # 최신 게시물이 위로 오도록 역순
    for post in reversed(data["posts"]):
        if not post.get("toss_link") or post.get("hide_in_linkhub"):
            continue
        items.append(
            ITEM.format(
                url=html.escape(post["toss_link"], quote=True),
                name=html.escape(post.get("link_title") or post.get("title") or post["id"]),
                desc=html.escape(post.get("link_desc", "")),
                button=html.escape(hub.get("button", "토스에서 열기")),
            )
        )
    page = PAGE.format(
        title=html.escape(hub.get("title", "토스 혜택 모음")),
        subtitle=html.escape(hub.get("subtitle", "영상에서 본 혜택을 눌러서 받아가세요")),
        items="\n".join(items) or "  <p class=\"sub\">아직 등록된 링크가 없어요.</p>",
        footer=html.escape(hub.get("footer", "")),
    )
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "index.html"
    out.write_text(page, encoding="utf-8")
    return out
