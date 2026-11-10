# BUILD SIGNAL

전국 건설현장 영업정보 플랫폼 MVP. Node.js + Express + Neon PostgreSQL 기반이며 PC/모바일 반응형 웹을 제공합니다.

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
