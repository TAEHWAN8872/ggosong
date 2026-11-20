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

  // 대시보드 기준 연도 — 해가 바뀌면 이 숫자와 아래 ANNUAL/SIDE_BUSINESS 탭 이름만 바꾸면 됨
  YEAR: 2026,

  // 시트 탭 이름 (구글시트 하단 탭명과 정확히 일치해야 함)
  SHEET_NAMES: {
    ANNUAL: "2026년 연간 요약",
    SIDE_BUSINESS: "26년 부업",
  },

  // 자동 새로고침 간격(분). 시트 값이 바뀌면 이 간격마다, 그리고 브라우저 탭으로 돌아올 때마다 다시 읽어옴.
  AUTO_REFRESH_MINUTES: 5,

  // ※ 월 목록은 더 이상 손으로 적지 않음.
  //   시트 탭 목록을 읽어서 "2026-10" 같은 신형 탭, "26년 3월" 같은 구형 탭을 자동으로 찾아 채움.
  //   → 시트에서 "2026-12" 탭이 생기면 대시보드에 12월이 자동으로 나타남.
  MONTHS: [], // 런타임에 discoverMonths()가 채움
  _monthSheets: {}, // { 10: { format: "new", sheetName: "2026-10" }, ... } — 런타임에 채움

  monthMeta(m) {
    return this._monthSheets[m] || { format: "new", sheetName: `${this.YEAR}-${String(m).padStart(2, "0")}` };
  },

  // 구형 포맷(1~5월, 수동 작성) 시트만 행 범위를 직접 지정.
  // 신형 포맷(스크립트 생성, 6월~)은 "합 계" / "저축 / 투자" / "자산 현황" 라벨을 찾아 범위를 자동 계산하므로 적을 필요 없음.
  // expenseRows = 지출 SUM 범위(들), excludeRows = 범위 내 제외할 행(5월 -E42 등), savingsRows = 저축 SUM에 쓰인 두 행
  RANGES: {
    1: { expenseRows: [[11, 86]], savingsRows: [39, 41] },
    2: { expenseRows: [[11, 87]], savingsRows: [40, 42] },
    3: { expenseRows: [[11, 87]], savingsRows: [40, 42] },
    4: { expenseRows: [[11, 75]], savingsRows: [41, 43] },
    5: { expenseRows: [[11, 45], [54, 75]], excludeRows: [42], savingsRows: [41, 43] },
  },
};
