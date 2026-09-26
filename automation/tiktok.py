"""TikTok 공식 Content Posting API 클라이언트.

- 로그인(OAuth) → 토큰을 .tiktok_token.json 에 저장, 만료되면 자동 갱신
- draft  모드: 틱톡 앱 '받은편지함'으로 영상 전송 → 앱에서 캡션 붙여넣고 게시 (심사 전 앱도 사용 가능)
- direct 모드: 캡션까지 넣어 바로 게시 (앱 심사 통과 전에는 '나만 보기'로만 올라감)

문서: https://developers.tiktok.com/doc/content-posting-api-get-started
"""

import json
import secrets
import time
import urllib.parse
from pathlib import Path

import requests

AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/"
API = "https://open.tiktokapis.com/v2"
SCOPES = "user.info.basic,video.upload,video.publish"

MIN_CHUNK = 5 * 1024 * 1024
CHUNK = 10 * 1024 * 1024


class TikTokError(RuntimeError):
    pass


class TikTok:
    def __init__(self, client_key, client_secret, redirect_uri, token_path):
        if not (client_key and client_secret and redirect_uri):
            raise SystemExit(
                "TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET / TIKTOK_REDIRECT_URI 를 .env 에 넣어 주세요."
            )
        self.client_key = client_key
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.token_path = Path(token_path)

    # ---------------- 로그인 ----------------

    def auth_url(self):
        state = secrets.token_urlsafe(16)
        query = urllib.parse.urlencode(
            {
                "client_key": self.client_key,
                "scope": SCOPES,
                "response_type": "code",
                "redirect_uri": self.redirect_uri,
                "state": state,
            }
        )
        return f"{AUTH_URL}?{query}", state

    def exchange_code(self, redirected_url_or_code, expected_state=None):
        value = redirected_url_or_code.strip()
        code = value
        if value.startswith("http"):
            params = urllib.parse.parse_qs(urllib.parse.urlparse(value).query)
            if "error" in params:
                raise TikTokError(f"로그인 실패: {params.get('error_description', params['error'])[0]}")
            if expected_state and params.get("state", [None])[0] != expected_state:
                raise TikTokError("state 값이 다릅니다. 방금 연 로그인 링크로 다시 시도해 주세요.")
            code = params["code"][0]
        self._token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": self.redirect_uri})

    def _token_request(self, data):
        res = requests.post(
            f"{API}/oauth/token/",
            data={"client_key": self.client_key, "client_secret": self.client_secret, **data},
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=30,
        )
        body = res.json()
        if "access_token" not in body:
            raise TikTokError(f"토큰 발급 실패: {body}")
        now = time.time()
        body["expires_at"] = now + body["expires_in"] - 60
        body["refresh_expires_at"] = now + body.get("refresh_expires_in", 0) - 60
        self.token_path.write_text(json.dumps(body, indent=2))
        return body

    def access_token(self):
        if not self.token_path.exists():
            raise SystemExit("틱톡 로그인이 필요합니다: python auto.py login")
        token = json.loads(self.token_path.read_text())
        if time.time() < token["expires_at"]:
            return token["access_token"]
        if time.time() >= token.get("refresh_expires_at", 0):
            raise SystemExit("로그인이 만료됐습니다. 다시 로그인해 주세요: python auto.py login")
        return self._token_request({"grant_type": "refresh_token", "refresh_token": token["refresh_token"]})[
            "access_token"
        ]

    # ---------------- API ----------------

    def _post(self, path, payload):
        res = requests.post(
            f"{API}{path}",
            json=payload,
            headers={
                "Authorization": f"Bearer {self.access_token()}",
                "Content-Type": "application/json; charset=UTF-8",
            },
            timeout=60,
        )
        body = res.json()
        err = body.get("error", {})
        if err.get("code") not in (None, "ok"):
            raise TikTokError(f"{path}: {err.get('code')} - {err.get('message')}")
        return body.get("data", {})

    def creator_info(self):
        return self._post("/post/publish/creator_info/query/", {})

    def upload(self, video_path, mode="draft", caption="", privacy=None, disable_comment=False):
        """영상을 올리고 publish_id 를 돌려준다."""
        video_path = Path(video_path)
        size = video_path.stat().st_size
        if size < MIN_CHUNK:
            chunk_size, count = size, 1
        else:
            chunk_size = CHUNK
            count = max(1, size // chunk_size)  # 나머지는 마지막 조각에 합친다
        source = {
            "source": "FILE_UPLOAD",
            "video_size": size,
            "chunk_size": chunk_size,
            "total_chunk_count": count,
        }

        if mode == "direct":
            info = self.creator_info()
            options = info.get("privacy_level_options", [])
            level = privacy if privacy in options else ("SELF_ONLY" if "SELF_ONLY" in options else options[0])
            if privacy and privacy != level:
                print(f"  ! '{privacy}' 공개 설정을 쓸 수 없어 '{level}' 로 올립니다 (앱 심사 전이면 SELF_ONLY 만 가능).")
            data = self._post(
                "/post/publish/video/init/",
                {
                    "post_info": {
                        "title": caption,
                        "privacy_level": level,
                        "disable_comment": disable_comment,
                        "disable_duet": False,
                        "disable_stitch": False,
                        "video_cover_timestamp_ms": 1000,
                    },
                    "source_info": source,
                },
            )
        else:
            data = self._post("/post/publish/inbox/video/init/", {"source_info": source})

        self._put_chunks(data["upload_url"], video_path, size, chunk_size, count)
        return data["publish_id"]

    def _put_chunks(self, url, path, size, chunk_size, count):
        with open(path, "rb") as f:
            for i in range(count):
                start = i * chunk_size
                end = size - 1 if i == count - 1 else start + chunk_size - 1
                f.seek(start)
                data = f.read(end - start + 1)
                for attempt in range(4):
                    res = requests.put(
                        url,
                        data=data,
                        headers={
                            "Content-Type": "video/mp4",
                            "Content-Length": str(len(data)),
                            "Content-Range": f"bytes {start}-{end}/{size}",
                        },
                        timeout=300,
                    )
                    if res.status_code in (200, 201, 206):
                        break
                    time.sleep(2 ** (attempt + 1))
                else:
                    raise TikTokError(f"업로드 실패 ({i + 1}/{count}): {res.status_code} {res.text[:200]}")

    def wait_status(self, publish_id, timeout=300):
        deadline = time.time() + timeout
        status = {}
        while time.time() < deadline:
            status = self._post("/post/publish/status/fetch/", {"publish_id": publish_id})
            s = status.get("status")
            if s in ("PUBLISH_COMPLETE", "SEND_TO_USER_INBOX", "FAILED"):
                return status
            time.sleep(5)
        return status

