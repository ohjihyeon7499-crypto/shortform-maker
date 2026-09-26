"""토스 링크 숏폼 → 틱톡 자동 업로드 도구.

사용법 (automation 폴더에서):
    python auto.py render            # 아직 안 만든 영상 전부 만들기
    python auto.py linkhub           # 프로필용 링크 모음 페이지 만들기
    python auto.py login             # 틱톡 로그인 (처음 한 번)
    python auto.py post              # 다음 게시물 1개 업로드
    python auto.py run               # 링크 페이지 갱신 + 다음 게시물 업로드 (예약 실행용)
    python auto.py status            # 게시 현황
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

from linkhub import build_linkhub
from render import build_video, default_opts

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
STATE = HERE / "state.json"


def load_env():
    env = HERE / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def load_posts(path):
    path = Path(path)
    if not path.is_absolute():
        path = HERE / path
    if not path.exists():
        example = HERE / "posts.example.json"
        print(f"※ {path.name} 이 없어 예시 파일({example.name})을 사용합니다. 복사해서 내용을 바꿔 주세요.")
        path = example
    data = json.loads(path.read_text(encoding="utf-8"))
    ids = [p["id"] for p in data["posts"]]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise SystemExit(f"posts 의 id 가 겹칩니다: {', '.join(sorted(dupes))}")
    return data, path.parent


def load_state():
    return json.loads(STATE.read_text(encoding="utf-8")) if STATE.exists() else {"posted": {}}


def save_state(state):
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def build_caption(post, defaults):
    parts = [post.get("caption", "").strip()]
    if post.get("caption_include_link", defaults.get("caption_include_link", False)) and post.get("toss_link"):
        # 틱톡 캡션 속 링크는 눌리지 않는다. 복사용으로만 넣는다.
        parts.append(post["toss_link"])
    tags = post.get("hashtags", defaults.get("hashtags", []))
    if tags:
        parts.append(" ".join(t if t.startswith("#") else f"#{t}" for t in tags))
    caption = "\n\n".join(p for p in parts if p)
    if len(caption.encode("utf-16-le")) // 2 > 2200:
        raise SystemExit(f"[{post['id']}] 캡션이 2200자를 넘습니다.")
    return caption


def video_path(post):
    return OUT / f"{post['id']}.mp4"


def render_post(post, data, base_dir, force=False):
    out = video_path(post)
    if out.exists() and not force:
        return out
    OUT.mkdir(exist_ok=True)
    print(f"▶ 영상 만드는 중: {post['id']}")
    started = time.time()
    build_video(post, default_opts(data.get("defaults", {})), base_dir, out)
    print(f"  완료 {out.relative_to(HERE)} ({out.stat().st_size / 1e6:.1f}MB, {time.time() - started:.0f}초)")
    return out


def pick_posts(data, state, args):
    posts = data["posts"]
    if args.id:
        chosen = [p for p in posts if p["id"] in args.id]
        missing = set(args.id) - {p["id"] for p in chosen}
        if missing:
            raise SystemExit(f"없는 id: {', '.join(sorted(missing))}")
        return chosen
    return [p for p in posts if p["id"] not in state["posted"] and not p.get("skip")]


def tiktok_client():
    from tiktok import TikTok

    return TikTok(
        os.environ.get("TIKTOK_CLIENT_KEY"),
        os.environ.get("TIKTOK_CLIENT_SECRET"),
        os.environ.get("TIKTOK_REDIRECT_URI"),
        HERE / ".tiktok_token.json",
    )


# ---------------- 명령 ----------------


def cmd_render(args):
    data, base = load_posts(args.posts)
    posts = pick_posts(data, load_state(), args) if (args.id or not args.all) else data["posts"]
    for post in posts:
        render_post(post, data, base, force=args.force)
        caption_file = OUT / f"{post['id']}.caption.txt"
        caption_file.write_text(build_caption(post, data.get("defaults", {})), encoding="utf-8")


def cmd_linkhub(args):
    data, base = load_posts(args.posts)
    out_dir = data.get("linkhub", {}).get("out_dir", "../docs")
    out = build_linkhub(data, (base / out_dir).resolve())
    print(f"✔ 링크 모음 페이지: {out}")
    return out


def cmd_login(args):
    tt = tiktok_client()
    url, state = tt.auth_url()
    print("1) 아래 주소를 브라우저에서 열고 틱톡으로 로그인 → 권한 허용")
    print(f"\n{url}\n")
    print("2) 이동된 페이지의 주소창 URL 전체를 복사해서 붙여넣으세요.")
    redirected = input("URL: ")
    tt.exchange_code(redirected, expected_state=state)
    info = tt.creator_info()
    print(f"✔ 로그인 완료: @{info.get('creator_username')} (공개 범위 옵션: {info.get('privacy_level_options')})")


def cmd_post(args):
    data, base = load_posts(args.posts)
    defaults = data.get("defaults", {})
    state = load_state()
    queue = pick_posts(data, state, args)[: args.limit]
    if not queue:
        print("올릴 게시물이 없습니다. posts.json 에 새 게시물을 추가하세요.")
        return

    mode = args.mode or defaults.get("mode", "draft")
    privacy = args.privacy or defaults.get("privacy", "PUBLIC_TO_EVERYONE")
    tt = None if args.dry_run else tiktok_client()

    for n, post in enumerate(queue):
        if n and args.gap:
            print(f"… {args.gap}초 쉬었다가 다음 게시물")
            time.sleep(args.gap)
        video = render_post(post, data, base)
        caption = build_caption(post, defaults)
        caption_file = OUT / f"{post['id']}.caption.txt"
        caption_file.write_text(caption, encoding="utf-8")

        print(f"▶ 업로드 [{mode}] {post['id']}")
        if args.dry_run:
            print(f"  (dry-run) 영상 {video.name}\n  캡션:\n{caption}\n")
            continue

        publish_id = tt.upload(
            video, mode=mode, caption=caption, privacy=privacy, disable_comment=post.get("disable_comment", False)
        )
        status = tt.wait_status(publish_id)
        result = status.get("status", "UNKNOWN")
        if result == "FAILED":
            print(f"  ✘ 실패: {status.get('fail_reason')}")
            continue

        state["posted"][post["id"]] = {
            "at": datetime.now().isoformat(timespec="seconds"),
            "mode": mode,
            "publish_id": publish_id,
            "status": result,
        }
        save_state(state)
        if mode == "draft":
            print("  ✔ 틱톡 앱 알림(받은편지함)으로 보냈습니다. 앱에서 아래 캡션을 붙여넣고 게시하세요.")
            print(f"  캡션 파일: {caption_file.relative_to(HERE)}\n{caption}\n")
        else:
            print(f"  ✔ 게시 요청 완료 ({result})")


def cmd_run(args):
    cmd_linkhub(args)
    cmd_post(args)


def cmd_status(args):
    data, _ = load_posts(args.posts)
    posted = load_state()["posted"]
    for post in data["posts"]:
        info = posted.get(post["id"])
        mark = f"✔ {info['at']} ({info['mode']}, {info['status']})" if info else ("건너뜀" if post.get("skip") else "대기")
        print(f"{post['id']:<20} {mark}")


def main():
    load_env()
    parser = argparse.ArgumentParser(description="토스 링크 숏폼 → 틱톡 자동 업로드")
    parser.add_argument("--posts", default="posts.json", help="게시물 목록 파일 (기본 posts.json)")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("render", help="영상 만들기")
    p.add_argument("--id", nargs="*", help="특정 게시물만")
    p.add_argument("--all", action="store_true", help="이미 올린 게시물도 포함")
    p.add_argument("--force", action="store_true", help="이미 있는 영상도 다시 만들기")
    p.set_defaults(func=cmd_render)

    p = sub.add_parser("linkhub", help="링크 모음 페이지 만들기")
    p.set_defaults(func=cmd_linkhub)

    p = sub.add_parser("login", help="틱톡 로그인")
    p.set_defaults(func=cmd_login)

    for name, func, text in (("post", cmd_post, "업로드"), ("run", cmd_run, "링크 페이지 갱신 + 업로드")):
        p = sub.add_parser(name, help=text)
        p.add_argument("--id", nargs="*", help="특정 게시물만 (이미 올린 것도 다시 올림)")
        p.add_argument("--limit", type=int, default=1, help="한 번에 올릴 개수 (기본 1)")
        p.add_argument("--gap", type=int, default=600, help="여러 개 올릴 때 간격(초, 기본 600)")
        p.add_argument("--mode", choices=["draft", "direct"], help="draft=앱에서 마무리, direct=바로 게시")
        p.add_argument("--privacy", help="direct 모드 공개 범위 (예: PUBLIC_TO_EVERYONE, SELF_ONLY)")
        p.add_argument("--dry-run", action="store_true", help="업로드 없이 영상·캡션만 확인")
        p.set_defaults(func=func)

    p = sub.add_parser("status", help="게시 현황")
    p.set_defaults(func=cmd_status)

    args = parser.parse_args()
    try:
        args.func(args)
    except KeyboardInterrupt:
        sys.exit(130)


if __name__ == "__main__":
    main()
