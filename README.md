# Cafe POS (단일 서버, 가벼운 버전)

Node.js + Express 하나로 돌아가는 카페 운영 프로그램입니다. 데이터베이스 서버가
따로 필요 없고(JSON 파일에 저장), 저사양 VPS 1대에 올려서 바로 쓸 수 있습니다.

## 들어있는 것

- `/pos.html` — 계산대(패드) 화면. 로그인 없이 누구나 사용, 메뉴 눌러서 주문 저장
- `/entry.html` — 구매·지출 입력 화면. 로그인 없이 누구나 사용
- `/admin` — 관리자 페이지 (아이디/비밀번호 필요)
  - 요약: 오늘/일자별 매출·지출·손익
  - 주문 내역: 영수증처럼 쌓인 주문 목록, 삭제 가능
  - 구매·지출: 입력된 내역 목록, 삭제 가능
  - 메뉴 관리: 메뉴 추가/삭제 (지금 추가하면 `/pos.html`에 바로 반영됨)

## 로컬에서 실행해보기

```bash
cd cafe-pos
npm install
ADMIN_USER=luke ADMIN_PASS=여기에_강한_비밀번호 npm start
```

브라우저에서:
- 계산대: http://localhost:3000/pos.html
- 구매·지출: http://localhost:3000/entry.html
- 관리자: http://localhost:3000/admin  (위에서 정한 아이디/비밀번호 입력)

`ADMIN_PASS`를 설정하지 않으면 기본값(`changeme123`)으로 뜨니, **실제로 쓰기 전에 꼭
바꿔주세요.**

## 도메인 연결해서 실제로 운영하기 (예: cafe.eaglewings... 같은 도메인)

가장 간단한 구성: 저렴한 VPS 1대(월 몇 천원대, 예: Vultr/DigitalOcean/Linode 등 아무거나)
+ Node.js + Nginx(앞단에서 https 처리) + pm2(서버가 죽으면 자동 재시작).

1. **VPS 하나 준비** (Ubuntu 22.04 추천), Node.js 20 설치
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
   sudo apt-get install -y nodejs nginx
   sudo npm install -g pm2
   ```

2. **이 폴더를 서버로 복사** (scp, git, 뭐든), 설치 후 pm2로 상시 실행
   ```bash
   cd cafe-pos
   npm install
   ADMIN_USER=luke ADMIN_PASS=강한비밀번호 pm2 start server.js --name cafe-pos
   pm2 save
   pm2 startup   # 서버 재부팅 시에도 자동 시작되게 안내 명령어가 나옵니다
   ```

3. **도메인을 이 서버의 IP로 연결** — 도메인 구입처(가비아, Namecheap 등)의 DNS에서
   A 레코드를 서버 IP로 지정 (예: `cafe.yourdomain.com` → `123.45.67.89`)

4. **Nginx로 도메인 → 3000번 포트 연결 + https**
   ```nginx
   # /etc/nginx/sites-available/cafe-pos
   server {
     listen 80;
     server_name cafe.yourdomain.com;
     location / {
       proxy_pass http://localhost:3000;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
     }
   }
   ```
   ```bash
   sudo ln -s /etc/nginx/sites-available/cafe-pos /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo apt-get install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d cafe.yourdomain.com   # 무료 https 인증서 자동 발급/갱신
   ```

이제 `https://cafe.yourdomain.com/pos.html` 로 패드에서 바로 접속해 쓰시면 됩니다.
패드 브라우저에서 "홈 화면에 추가"로 바로가기를 만들면 앱처럼 아이콘으로 열려요.

## 데이터는 어디 저장되나요

`cafe-pos/data/` 폴더 안에 `menu.json`, `orders.json`, `expenses.json` 세 개로
저장됩니다. 이 폴더만 주기적으로 백업해두면 데이터가 안전합니다. 나중에 거래량이
많이 늘어나면 SQLite나 Postgres로 옮기는 것도 어렵지 않은 구조로 짜여 있습니다
(`db.js` 파일 하나만 바꾸면 됩니다).

## 참고

- 엑셀로 내보내고 싶으면: 관리자 페이지에 "CSV 다운로드" 버튼을 추가해달라고
  요청해주시면 바로 추가해드릴 수 있어요 (지금 버전엔 빠져 있습니다).
- 영수증 프린터 연동, 카드 결제 연동(진짜 결제 승인)은 이 가벼운 버전에는
  없습니다 — 그 부분까지 필요하시면 Loyverse 같은 전문 POS를 계속 쓰시고,
  이 프로그램은 "구매/지출 + 손익 정리" 역할로 같이 쓰시는 걸 추천드려요.
