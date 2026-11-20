// ============================================
// 설정값 — 여기만 수정하면 됨
// ============================================
const CONFIG = {
  // 구글시트 URL의 /d/ 뒤 긴 문자열
  SPREADSHEET_ID: "1xlVqmLgoMFBAOPgwoy5vzwEWcXoVmGQ6zV2Pvw2sHuE",
  // Google Cloud Console > API 및 서비스 > 사용자 인증 정보에서 발급받은 "API 키"
  // (OAuth 클라이언트 ID 아님! 로그인 없이 공개 시트를 읽기 위한 API 키)
  // - "Google Sheets API"만 사용하도록 제한 권장
  // - 가능하면 "HTTP 리퍼러" 제한을 걸어서 내 도메인에서만 쓰이도록 제한 권장
  API_KEY: "AIzaSyBg0rjRqrEMsZoMTZJqQK87i1DPhlrxqw8",

  // 보여줄 연도. null 이면 가계부입력 탭에서 가장 최근 연도를 자동으로 보여줌
  YEAR: null,

  // 시트 탭 이름 (구글시트 하단 탭명과 정확히 일치해야 함)
  SHEET_NAMES: {
    LEDGER: "가계부입력", // 한 줄 = 한 건 (연도/월/구분/카테고리/항목/예산/금액). 부업은 구분=수입, 카테고리=부업
    ASSETS: "자산입력", // 월별 자산 현황 (연도/월/구분/항목/금액/최저매도가/매수가/지분율)
  },

  // 자동 새로고침 간격(분). 이 간격마다, 그리고 브라우저 탭으로 돌아올 때마다 시트를 다시 읽어옴.
  AUTO_REFRESH_MINUTES: 5,

  // 런타임에 채워짐 — 가계부입력 탭에 줄이 있는 달 목록 (12월 줄을 적으면 12월이 자동으로 생김)
  MONTHS: [],
};
