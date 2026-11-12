# BUILD SIGNAL

전국 건설현장 영업정보 플랫폼 MVP. Node.js + Express + Neon PostgreSQL 기반이며 PC/모바일 반응형 웹을 제공합니다.

## 회원 시스템 (v1.1)
- 이메일 회원가입 및 비밀번호 해시 저장(bcrypt)
- 로그인/로그아웃 및 PostgreSQL 기반 서버 세션
- 신규 가입은 관리자 승인 후 이용 가능
- 관리자 회원 목록, 승인 및 삭제
- 관심 현장과 영업 메모는 회원별 분리 저장
- 관리자 계정은 Render의 `ADMIN_EMAIL`, `ADMIN_PASSWORD` 환경변수로 최초 생성/갱신

## 현재 포함된 기능
- 대시보드 통계 및 신규 리드 요약
- 전국 현장 검색(지역, 공사단계, 건물용도, 키워드)
- 현장 상세 및 발주처/건축주/설계사/감리사/시공사 표시
- 관심현장 및 영업 파이프라인 관리
- 업종별 AI 영업 적합도 규칙 기반 점수(초기 MVP)
- CSV/엑셀 호환 다운로드
- 관리자용 데모 데이터 생성 및 API 데이터 적재 엔드포인트
- Neon PostgreSQL 자동 테이블 생성
- Render 배포 설정

## 중요: 데이터에 관한 안내
초기 배포는 `DATA_SOURCE_MODE=demo`로 동작하며 화면 검증용 샘플 데이터가 표시됩니다. 샘플은 실제 현장이나 실제 기업정보가 아닙니다.
실제 전국 현장 데이터는 건축HUB/세움터 등 제공기관의 이용 승인·API 명세·상업적 이용 및 재배포 조건을 확인한 후 연결해야 합니다. 본 프로젝트에는 출처를 위장하거나 존재하지 않는 공공 API를 호출하는 코드를 넣지 않았습니다.
실제 API 키만 넣으면 전국 현장정보가 자동으로 확보되는 상태는 아닙니다. 기관별 API 응답 스키마에 맞춘 어댑터 구현 및 데이터 품질 검증이 후속 작업입니다.

## 로컬 실행
1. Node.js 20 이상 설치
2. `npm install`
3. `.env.example`을 `.env`로 복사하고 DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD, SESSION_SECRET 입력
4. `npm start`
5. 브라우저에서 `http://localhost:10000`

## 회원가입 및 관리자 승인
1. 배포 후 `/login.html`에서 관리자 이메일/비밀번호로 로그인합니다.
2. 일반 사용자는 회원가입 탭에서 회사명, 담당자, 이메일, 비밀번호를 등록합니다.
3. 신규 가입자는 `pending` 상태로 저장되며 승인 전에는 로그인할 수 없습니다.
4. 관리자는 상단의 `회원관리`에서 가입자를 승인하거나 삭제할 수 있습니다.
5. 관리자 이메일/비밀번호는 Render 환경변수 `ADMIN_EMAIL`, `ADMIN_PASSWORD`와 일치해야 합니다. 서버 시작 시 해당 계정은 관리자 권한으로 보장됩니다.

## Render + Neon 배포
1. ZIP 압축을 풀고 GitHub 저장소에 전체 파일 업로드
2. Neon에서 PostgreSQL 프로젝트 생성 후 connection string 복사
3. Render에서 New > Web Service > GitHub 저장소 선택
4. Build Command: `npm install`
5. Start Command: `npm start`
6. 환경변수 설정:
   - `DATABASE_URL`: Neon connection string (`?sslmode=require` 포함 권장)
   - `ADMIN_EMAIL`: 관리자 이메일
   - `ADMIN_PASSWORD`: 강력한 관리자 비밀번호
   - `SESSION_SECRET`: 길고 임의적인 비밀 문자열
   - `DATA_SOURCE_MODE`: 처음에는 `demo`
7. 배포 후 `/api/health` 확인

## 관리자 및 보안
- MVP 관리자 로그인: `/login`
- 관리자 계정은 Render 환경변수로 설정합니다.
- 로그인은 단일 관리자 계정 기반의 초기 MVP입니다. 공개 서비스 전에는 사용자별 계정, 비밀번호 해시, 세션 저장소, CSRF 보호, 역할별 권한, 감사로그를 추가해야 합니다.
- 현재 API 적재 엔드포인트는 `ADMIN_INGEST_TOKEN` 환경변수 설정 시 `x-ingest-token` 헤더 검증을 수행합니다. 해당 값을 반드시 강력한 값으로 설정하세요.

## 데이터 적재 API
`POST /api/ingest/projects`
Headers:
`Content-Type: application/json`
`x-ingest-token: <ADMIN_INGEST_TOKEN>`

Body:
```json
{
  "source": "기관명/데이터셋명",
  "projects": [
    {
      "externalId": "source-row-id",
      "name": "프로젝트명",
      "address": "도로명 또는 지번 주소",
      "region": "서울특별시",
      "district": "강남구",
      "buildingType": "업무시설",
      "stage": "PERMIT",
      "permitDate": "2026-01-15",
      "startDate": null,
      "completionDate": null,
      "floorsAbove": 15,
      "floorsBelow": 3,
      "areaSqm": 12000,
      "estimatedCost": null,
      "owner": "건축주/발주처",
      "designer": "설계사",
      "supervisor": "감리사",
      "contractor": "시공사",
      "sourceUrl": "https://...",
      "sourceUpdatedAt": "2026-01-15"
    }
  ]
}
```
`stage`: `PERMIT`, `STARTED`, `COMPLETED`, `BID`, `UNKNOWN`
중복 방지는 `source + externalId` 기준입니다. 같은 현장을 여러 출처에서 통합하는 고도화는 주소·허가번호 등 식별자 정규화 작업이 필요합니다.

## 다음 개발 단계
1. 실제 건축HUB API 서비스별 명세 확인 및 API 어댑터 작성
2. 나라장터 입찰/계약 데이터 수집 어댑터 작성
3. KISCON 업체정보 연동 및 현장-업체 관계 근거 확보
4. 기관별 수집주기·호출제한·오류 재처리 작업자 구현
5. 데이터 제공·상업적 이용·개인정보 관련 약관 검토
6. 기업별 회원가입, 구독결제, 조직/직원 권한 추가

## 지원
문제가 생기면 Render Logs, `/api/health`, 환경변수 설정, Neon 연결 문자열을 확인하세요.


## 보안 유의사항
- `SESSION_SECRET`은 충분히 길고 예측 불가능한 값으로 유지하고 외부에 공유하지 마세요.
- `ADMIN_PASSWORD`는 강력한 고유 비밀번호를 사용하세요.
- HTTPS(Render 기본 도메인) 환경에서 세션 쿠키는 Secure 옵션으로 전송됩니다.
- 상용 공개 전에는 CSRF 방어, 비밀번호 재설정/이메일 인증, 로그인 시도 제한, 개인정보 처리방침·이용약관을 추가하세요.
- 이 버전은 유료 결제/구독 기능은 포함하지 않습니다.


## 나라장터 입찰공고 API 연동 (v1.2)

Render 환경변수에 `G2B_SERVICE_KEY`를 등록합니다. 값은 공공데이터포털에서 발급한 일반 인증키(Decoding)를 사용합니다. 인증키를 소스코드나 GitHub에 저장하지 마세요.

관리자 계정으로 로그인한 뒤 회원관리(`/admin.html`) 화면의 **최근 7일 공고 수집** 버튼을 누르면 나라장터 공사 입찰공고를 조회하여 Neon DB에 저장합니다. 수집 결과 및 오류는 `ingest_logs`에 기록되고, 공고 고유번호와 차수로 중복을 갱신합니다.

현재 1회 최대 100건, 최근 최대 7일 조회로 제한했습니다. 나라장터 API의 상세 명세/요청 제한에 따라 실제 응답 확인 후 페이지네이션 및 자동 수집을 확장해야 합니다. 데이터가 수집되지 않으면 관리화면의 오류 메시지와 `ingest_logs`를 확인하세요.
