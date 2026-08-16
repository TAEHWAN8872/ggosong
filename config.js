// ============================================
// 설정값 — 여기만 수정하면 됨
// ============================================
const CONFIG = {
  // 구글시트 URL의 /d/ 뒤 긴 문자열
  SPREADSHEET_ID: "1xlVqmLgoMFBAOPgwoy5vzwEWcXoVmGQ6zV2Pvw2sHuE",

  // Google Cloud Console > API 및 서비스 > 사용자 인증 정보에서 발급받은 OAuth 클라이언트 ID
  // (아래 채팅 답변에 발급 방법 정리해뒀어요)
  CLIENT_ID: "YOUR_CLIENT_ID.apps.googleusercontent.com",

  // 읽기 전용 스코프
  SCOPES: "https://www.googleapis.com/auth/spreadsheets.readonly",

  // 시트 탭 이름 (구글시트 하단 탭명과 정확히 일치해야 함)
  SHEET_NAMES: {
    ANNUAL: "2026년 연간 요약",
    SIDE_BUSINESS: "26년 부업",
    // 신형 포맷 (스크립트 생성, 6~8월)
    NEW_FORMAT: ["2026-06", "2026-07", "2026-08"],
    // 구형 포맷 (수동 작성, 1~5월)
    OLD_FORMAT: ["26년 1월", "26년 2월", "26년 3월", "26년 4월", "26년 5월"],
  },

  // 대시보드에서 다룰 월 범위
  MONTHS: [1, 2, 3, 4, 5, 6, 7, 8],

  // 각 월이 신형/구형 중 어떤 포맷인지 + 실제 시트명
  monthMeta(m) {
    if (m >= 6) {
      return { format: "new", sheetName: `2026-${String(m).padStart(2, "0")}` };
    }
    return { format: "old", sheetName: `26년 ${m}월` };
  },
};
