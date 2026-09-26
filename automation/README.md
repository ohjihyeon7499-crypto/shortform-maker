# 🤖 토스 링크 숏폼 → 틱톡 자동 업로드

`posts.json` 에 게시물(문구 + 토스 공유 링크)만 적어 두면 아래 작업을 자동으로 합니다.

1. **영상 제작**: 9:16 1080×1920 MP4. 슬라이드 문구·사진, 줌/페이드 효과, 배경음악, "프로필 링크 클릭" 엔딩 카드가 들어갑니다.
2. **링크 모음 페이지**: 틱톡 프로필에 걸어 둘 페이지로, 게시물마다 토스 링크 버튼이 하나씩 들어갑니다.
3. **틱톡 업로드**: 틱톡 **공식 Content Posting API**를 사용합니다. 이미 올린 게시물은 기억해 두고 중복으로 올리지 않습니다.

> ⚠️ **틱톡 영상 캡션에 넣은 링크는 눌리지 않습니다.** 그래서 "영상/캡션: 프로필 링크 클릭 → 프로필: 링크 모음 페이지 → 토스" 구조로 만들었습니다.
> 프로필에 링크를 걸려면 **비즈니스 계정**으로 바꾸거나 팔로워 1,000명 이상이어야 합니다(틱톡 정책).

## 1. 설치

Python 3.9 이상이 필요합니다.

```bash
cd automation
pip install -r requirements.txt     # ffmpeg 도 같이 설치됩니다
cp posts.example.json posts.json    # 윈도우: copy posts.example.json posts.json
cp .env.example .env
```

## 2. 게시물 적기 (`posts.json`)

```jsonc
{
  "id": "toss-003",                      // 고유 이름 (중복 업로드 방지용)
  "title": "상단 고정 제목",
  "slides": [
    { "text": "첫 화면 문구" },
    { "text": "사진 위 자막", "image": "assets/photo1.jpg", "seconds": 3 }
  ],
  "toss_link": "https://toss.me/...",    // 토스에서 '공유하기'로 복사한 링크
  "link_title": "링크 페이지에 보일 이름",
  "caption": "틱톡 캡션",
  "hashtags": ["토스", "앱테크"]           // 생략하면 defaults.hashtags
}
```

- 사진은 `automation/assets/` 에 넣고 경로를 적으면 됩니다. 가로 사진은 흐린 배경 위에 원본 비율로 배치되고, `"fit": "cover"` 를 넣으면 화면을 꽉 채웁니다.
- 배경음악은 `defaults.bgm` 에 `"assets/bgm.mp3"` 처럼 적습니다. 저작권 문제가 없는 음악만 쓰세요.
- 색상(`theme`), 엔딩 문구(`cta`, `button`), 슬라이드 길이 같은 설정은 `defaults` 에서 바꿀 수 있습니다.
- 올리고 싶지 않은 게시물에는 `"skip": true` 를 넣습니다.

영상만 먼저 확인하려면:

```bash
python auto.py render               # out/ 폴더에 mp4 + 캡션 txt 생성
python auto.py post --dry-run       # 업로드 없이 무엇이 올라갈지 확인
```

## 3. 링크 모음 페이지 (틱톡 프로필용)

```bash
python auto.py linkhub              # ../docs/index.html 생성
```

GitHub 저장소 **Settings → Pages → Branch: main, 폴더: /docs** 로 설정하면
`https://<아이디>.github.io/shortform-maker/` 주소가 생깁니다. 이 주소를 틱톡 프로필 웹사이트 칸에 넣으세요.
게시물을 추가한 뒤 `linkhub` 를 다시 실행하고 커밋·푸시하면 페이지도 갱신됩니다.

## 4. 틱톡 연결 (처음 한 번)

1. <https://developers.tiktok.com> 에서 앱을 만듭니다.
2. 제품에 **Login Kit** 과 **Content Posting API** 를 추가하고 scope `user.info.basic`, `video.upload`, `video.publish` 를 켭니다.
3. Login Kit 의 Redirect URI 에 위의 GitHub Pages 주소를 등록합니다. 로그인한 뒤 돌아올 페이지이며, 어떤 페이지든 상관없습니다.
4. `.env` 에 Client key / Client secret / Redirect URI 를 넣습니다.
5. 로그인합니다.

```bash
python auto.py login
```

터미널에 나온 주소를 브라우저로 열어 틱톡에 로그인하고 권한을 허용하세요. 로그인 후 이동한 페이지의 **주소창 URL 전체**를 복사해 터미널에 붙여넣으면 됩니다.
토큰은 `.tiktok_token.json` 에 저장되고 만료되면 자동으로 갱신됩니다. 약 1년 뒤에는 다시 로그인해야 합니다.

## 5. 업로드

```bash
python auto.py post                 # 아직 안 올린 다음 게시물 1개
python auto.py post --limit 3       # 3개 (기본 10분 간격)
python auto.py post --id toss-001   # 특정 게시물 (다시 올리기)
python auto.py status               # 현황
```

업로드 모드는 두 가지입니다.

| 모드 | 동작 | 조건 |
| --- | --- | --- |
| `draft` (기본) | 영상이 틱톡 앱 **알림(받은편지함)** 으로 옵니다. 앱에서 `out/<id>.caption.txt` 의 캡션을 붙여넣고 게시하면 됩니다. | 앱 심사 없이 바로 사용 가능 |
| `direct` | 캡션까지 넣어 **바로 게시**합니다. | 틱톡 **앱 심사(Audit)** 를 통과해야 전체 공개가 됩니다. 심사 전에는 '나만 보기'로만 올라갑니다. |

`posts.json` 의 `defaults.mode` 나 `--mode direct` 로 모드를 고를 수 있습니다.

## 6. 매일 자동 실행

`run` 명령은 링크 페이지를 갱신한 뒤 다음 게시물을 올립니다.

**맥/리눅스 (cron)**: 매일 저녁 7시 55분

```
55 19 * * * cd /경로/shortform-maker/automation && /usr/bin/python3 auto.py run >> run.log 2>&1
```

**윈도우**: 작업 스케줄러 → 기본 작업 만들기 → 매일 →
프로그램 `python`, 인수 `auto.py run`, 시작 위치 `C:\경로\shortform-maker\automation`

> 링크 페이지를 GitHub Pages 로 쓰고 있다면 새 링크가 생겼을 때 `docs/` 를 커밋·푸시해야 반영됩니다.

## 꼭 지켜 주세요

- **토스 이벤트 약관**: 추천·공유 이벤트 중에는 부정 참여(자동화, 허위 홍보, 대가성 모집)를 하면 리워드를 회수하는 경우가 있습니다. 링크를 퍼뜨리기 전에 해당 이벤트의 유의사항을 확인하세요.
- **틱톡 커뮤니티 가이드**: 똑같은 영상을 반복해서 올리거나, 링크를 과도하게 홍보하거나, 과장·허위 수익 광고를 하면 노출 제한이나 계정 정지를 당할 수 있습니다. 게시물마다 내용을 다르게 만들고 하루 1~3개 정도로 올리세요.
- 이 도구는 공식 API만 사용합니다. 브라우저 자동 클릭 방식의 업로드는 틱톡 약관 위반이라 계정 정지 위험이 커서 넣지 않았습니다.

## 파일 구조

```
auto.py              명령어 (render / linkhub / login / post / run / status)
render.py            슬라이드 그리기 + ffmpeg 영상 조립
tiktok.py            틱톡 로그인·업로드 (Content Posting API)
linkhub.py           프로필용 링크 모음 페이지
posts.example.json   게시물 예시
.env.example         틱톡 앱 키 예시
```

`.env`, `.tiktok_token.json`, `state.json`, `posts.json`, `out/` 은 `.gitignore` 에 들어 있어 커밋되지 않습니다.
