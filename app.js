// ============================================
// 상태
// ============================================
const state = {
  monthly: {},      // { 1: {income, expense, savings, categories:{}}, ... }
  side: null,        // { months:[...], categories:{...} }
  selectedMonth: "total", // "total" = 종합(1~8월 합계), 또는 1~8 숫자(해당 월)
  expandedCats: new Set(), // 지출 카테고리 목록에서 펼쳐진 항목들
  charts: {},
};

const $ = (sel) => document.querySelector(sel);
const fmtWon = (n) => (n < 0 ? "-" : "") + "₩" + Math.abs(Math.round(n)).toLocaleString("ko-KR");
const fmtShort = (n) => {
  const abs = Math.abs(n);
  if (abs >= 100000000) return (n / 100000000).toFixed(1) + "억";
  if (abs >= 10000) return Math.round(n / 10000) + "만";
  return n.toLocaleString("ko-KR");
};

// 막대가 0에서 자라나는 기본 애니메이션을 끔 — 매번 최종 상태로 즉시 그려지도록 하여
// 렌더링 직후(탭 전환/캡처 등) 막대가 짧거나 안 보이는 문제를 방지
if (typeof Chart !== "undefined") {
  try {
    Chart.defaults.animation = false;
    if (Chart.defaults.transitions?.active?.animation) {
      Chart.defaults.transitions.active.animation.duration = 0;
    }
  } catch (e) {
    console.warn("Chart.js 애니메이션 설정 실패", e);
  }
}

// ============================================
// 초기 진입 (로그인 없이 바로 로드)
// ============================================
function initApp() {
  $("#gate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#refreshBtn").classList.remove("hidden");
  $("#refreshBtn").addEventListener("click", () => loadAll(true));

  if (typeof Chart === "undefined") {
    setSyncStatus("차트 라이브러리 로드 실패 (Chart.js CDN 확인 필요)");
  }

  loadAll(false).catch((err) => {
    console.error(err);
    setSyncStatus("데이터 로드 실패: " + err.message);
  });
}

function setSyncStatus(text) {
  $("#syncStatus").textContent = text;
}

// ============================================
// Sheets API (공개 시트 + API 키, 로그인 불필요)
// ============================================
async function fetchGrids(sheetNames) {
  const ranges = sheetNames.map((n) => `'${n}'!A1:AF400`).join("&ranges=");
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SPREADSHEET_ID}/values:batchGet` +
    `?ranges=${ranges}&valueRenderOption=UNFORMATTED_VALUE&key=${CONFIG.API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const out = {};
  data.valueRanges.forEach((vr, i) => {
    out[sheetNames[i]] = vr.values || [];
  });
  return out;
}

// ============================================
// 그리드 유틸
// ============================================
const cell = (grid, r, c) => (grid[r] && grid[r][c] !== undefined ? grid[r][c] : "");
const trimStr = (v) => (typeof v === "string" ? v.trim() : v);
const isNum = (v) => typeof v === "number";
const toNum = (v) => (isNum(v) ? v : 0);

// grid 전체에서 matcher(문자열 또는 함수)와 일치하는 첫 셀 위치 찾기
function findCell(grid, matcher, opts = {}) {
  const test = typeof matcher === "function" ? matcher : (v) => trimStr(v) === matcher;
  const startRow = opts.startRow || 0;
  for (let r = startRow; r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (test(row[c])) return { r, c };
    }
  }
  return null;
}

// row 배열에서 matcher 위치(컬럼 인덱스) 찾기
function findColInRow(row, matcher) {
  const test = typeof matcher === "function" ? matcher : (v) => trimStr(v) === matcher;
  for (let c = 0; c < row.length; c++) if (test(row[c])) return c;
  return -1;
}

function rowIsBlank(row, cols) {
  return cols.every((c) => {
    const v = row[c];
    return v === undefined || v === "" || v === null;
  });
}

// ============================================
// 파서 1: 연간 요약 시트
// ============================================
function parseAnnualSummary(grid) {
  const header = findCell(grid, "항목");
  if (!header) return null;
  const headerRow = grid[header.r];
  const monthCol = (m) => findColInRow(headerRow, `${m}월`);

  const rows = { income: null, expense: null, savings: null };
  for (let r = header.r + 1; r < header.r + 6; r++) {
    const label = trimStr(cell(grid, r, header.c));
    if (label === "총 수입") rows.income = r;
    else if (label === "총 지출") rows.expense = r;
    else if (label === "저축/투자" || label === "저축 / 투자") rows.savings = r;
  }
  const result = {};
  for (const m of CONFIG.MONTHS) {
    const c = monthCol(m);
    result[m] = {
      income: rows.income != null && c >= 0 ? toNum(cell(grid, rows.income, c)) : null,
      expense: rows.expense != null && c >= 0 ? toNum(cell(grid, rows.expense, c)) : null,
      savings: rows.savings != null && c >= 0 ? toNum(cell(grid, rows.savings, c)) : null,
    };
  }
  return result;
}

// ============================================
// 파서 2: 부업 시트 (26년 요약 블록만 사용)
// ============================================
function parseSideBusiness(grid) {
  const yearCell = findCell(grid, "26년");
  const categories = { 해외주식: Array(13).fill(0), 공모주: Array(13).fill(0), 구매대행: Array(13).fill(0), 카테크: Array(13).fill(0) };
  if (!yearCell) return categories;

  const labelCol = yearCell.c;
  const valStart = labelCol + 1; // 1월부터

  for (let r = yearCell.r + 1; r < yearCell.r + 8; r++) {
    const label = trimStr(cell(grid, r, labelCol));
    let key = null;
    if (label === "해외주식") key = "해외주식";
    else if (label === "공모주") key = "공모주";
    else if (label && label.startsWith("구매대행")) key = "구매대행";
    else if (label === "카테크") key = "카테크";
    if (!key) continue;
    for (let m = 1; m <= 12; m++) {
      categories[key][m] = toNum(cell(grid, r, valStart + m - 1));
    }
  }
  return categories;
}

// ============================================
// 파서 3: 신형 포맷 월 시트 (2026-06 ~ 08)
// ============================================
function parseNewFormatMonth(grid, ranges) {
  const out = { income: 0, expense: 0, savings: 0, categories: {}, categoryDetails: {}, savingsCategories: {} };

  // 상단 요약 블록: 총 수입 / 총 지출 / 저축 / 투자 / 잔 액
  const sumHeader = findCell(grid, "총 수입");
  if (sumHeader) {
    const hRow = grid[sumHeader.r];
    const cIncome = sumHeader.c;
    const cExpense = findColInRow(hRow, "총 지출");
    const cSavings = findColInRow(hRow, (v) => trimStr(v) === "저축 / 투자" || trimStr(v) === "저축/투자");
    const valRow = sumHeader.r + 1;
    out.income = toNum(cell(grid, valRow, cIncome));
    if (cExpense >= 0) out.expense = toNum(cell(grid, valRow, cExpense));
    if (cSavings >= 0) out.savings = toNum(cell(grid, valRow, cSavings));
  }

  // 고정지출 + 변동지출 헤더 위치에서 열(컬럼) 위치만 동적으로 찾음: 항목/항목/설정금액/실제금액/차이 .. 카테고리/항목/항목/금액
  let hRowIdx = -1;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    // "항목" 헤더 셀이 A:B로 병합되어 있어 B열은 비어있음 — A열만 확인
    if (trimStr(row[0]) === "항목" && row.some((v) => trimStr(v) === "카테고리")) {
      hRowIdx = r;
      break;
    }
  }
  if (hRowIdx >= 0 && ranges) {
    const row = grid[hRowIdx];
    const leftCatCol = 0;
    const leftItemCol = 1;
    const leftActualCol = findColInRow(row, "실제 금액");
    const rightCatCol = findColInRow(row, "카테고리");
    let rightAmtCol = -1;
    for (let c = rightCatCol; c < row.length; c++) {
      if (trimStr(row[c]) === "금액") { rightAmtCol = c; break; }
    }
    let rightItemCol = -1;
    if (rightCatCol >= 0 && rightAmtCol >= 0) {
      for (let c = rightCatCol + 1; c < rightAmtCol; c++) {
        if (trimStr(row[c]) === "항목") { rightItemCol = c; break; }
      }
    }

    // 고정지출: 실제 시트 수식과 동일한 행 범위만 집계 (예: D13:D31)
    let fixedSum = 0;
    if (ranges.fixedRows) {
      const [r1, r2] = ranges.fixedRows;
      let lastCat = null;
      for (let sheetRow = r1; sheetRow <= r2; sheetRow++) {
        const rr = grid[sheetRow - 1] || [];
        const rawCat = trimStr(rr[leftCatCol]);
        if (rawCat) lastCat = rawCat;
        const cat = rawCat || lastCat;
        const item = trimStr(rr[leftItemCol]);
        const amt = toNum(rr[leftActualCol]);
        fixedSum += amt;
        if (cat && item && amt) {
          out.categories[cat] = (out.categories[cat] || 0) + amt;
          if (!out.categoryDetails[cat]) out.categoryDetails[cat] = {};
          out.categoryDetails[cat][item] = (out.categoryDetails[cat][item] || 0) + amt;
        }
      }
    }

    // 변동지출: 실제 시트 수식과 동일한 행 범위만 집계 (예: J13:J36)
    // 카테고리(G열)는 병합 셀이라 첫 행에만 값이 있고 아래 행은 비어있음 → 바로 위 값으로 이어받음
    let varSum = 0;
    if (ranges.varRows && rightCatCol >= 0 && rightAmtCol >= 0) {
      const [r1, r2] = ranges.varRows;
      let lastVarCat = null;
      for (let sheetRow = r1; sheetRow <= r2; sheetRow++) {
        const rr = grid[sheetRow - 1] || [];
        const rawCat = trimStr(rr[rightCatCol]);
        if (rawCat) lastVarCat = rawCat;
        const cat = rawCat || lastVarCat;
        const amt = toNum(rr[rightAmtCol]);
        varSum += amt;
        if (cat && amt) {
          out.categories[cat] = (out.categories[cat] || 0) + amt;
          const item = (rightItemCol >= 0 ? trimStr(rr[rightItemCol]) : "") || cat;
          if (!out.categoryDetails[cat]) out.categoryDetails[cat] = {};
          out.categoryDetails[cat][item] = (out.categoryDetails[cat][item] || 0) + amt;
        }
      }
    }

    // 총 지출: 헤더 텍스트 인식에 기대지 않고, 실제 시트 수식(D+J열 범위 합)과 동일하게 직접 계산
    if (ranges.fixedRows || ranges.varRows) {
      out.expense = fixedSum + varSum;
    }

    // 저축: 별도 분류열 없이 B열(항목명)에 바로 D열(실제 금액)이 붙는 구조
    if (ranges.savingsRows) {
      const [r1, r2] = ranges.savingsRows;
      let sum = 0;
      for (let sheetRow = r1; sheetRow <= r2; sheetRow++) {
        const rr = grid[sheetRow - 1] || [];
        const item = trimStr(rr[leftItemCol]);
        const amt = toNum(rr[leftActualCol]);
        sum += amt;
        if (item && amt) {
          out.savingsCategories[item] = (out.savingsCategories[item] || 0) + amt;
        }
      }
      if (!out.savings) out.savings = sum;
    }
  }
  return out;
}

// ============================================
// 파서 4: 구형 포맷 월 시트 (26년 1~5월)
// ============================================
function parseOldFormatMonth(grid, ranges) {
  const out = { income: 0, expense: 0, savings: 0, categories: {}, categoryDetails: {}, savingsCategories: {} };
  if (!ranges) return out;

  const CAT = 1, ITEM = 2, AMT = 4; // 분류, 제목, 금액(실제) — B, C, E열

  // 수입: 구형 포맷(1~5월) 공통으로 K4 셀에 월급 금액이 들어있음
  out.income = toNum(cell(grid, 3, 10)); // 시트상 K4 (0-indexed: row 3, col 10)

  // 혹시 F5가 비어있는 달이 있을 경우를 대비해 "월급" 라벨 행도 폴백으로 훑음
  if (!out.income) {
    for (let r = 0; r < grid.length; r++) {
      const row = grid[r] || [];
      if (trimStr(row[CAT]) === "월급") {
        out.income += toNum(row[AMT]);
      }
    }
  }

  // 지출: 실제 시트 수식과 동일한 행 범위(들)만 집계, excludeRows는 제외
  const excludeSet = new Set(ranges.excludeRows || []);
  let lastCat = null;
  (ranges.expenseRows || []).forEach(([r1, r2]) => {
    for (let sheetRow = r1; sheetRow <= r2; sheetRow++) {
      if (excludeSet.has(sheetRow)) continue;
      const row = grid[sheetRow - 1] || [];
      const rawCat = trimStr(row[CAT]);
      if (rawCat) lastCat = rawCat;
      const cat = rawCat || lastCat;
      const item = trimStr(row[ITEM]);
      const amt = toNum(row[AMT]);
      if (!cat || !amt || cat === "월급") continue;
      out.expense += amt;
      out.categories[cat] = (out.categories[cat] || 0) + amt;
      const key = item || "기타";
      if (!out.categoryDetails[cat]) out.categoryDetails[cat] = {};
      out.categoryDetails[cat][key] = (out.categoryDetails[cat][key] || 0) + amt;
    }
  });

  // 저축: J~N열(9~13), 각 행마다 바로 위 행이 그 행만의 항목명 헤더 (두 그룹이 서로 다른 헤더를 가짐)
  if (ranges.savingsRows) {
    const SAV_COLS = [9, 10, 11, 12, 13]; // J,K,L,M,N
    let sum = 0;
    ranges.savingsRows.forEach((sheetRow) => {
      const row = grid[sheetRow - 1] || [];
      const headerRow = grid[sheetRow - 2] || []; // 바로 위 행 = 이 행만의 헤더
      SAV_COLS.forEach((c) => {
        const amt = toNum(row[c]);
        sum += amt;
        if (amt) {
          const label = trimStr(headerRow[c]) || `항목${c}`;
          out.savingsCategories[label] = (out.savingsCategories[label] || 0) + amt;
        }
      });
    });
    out.savings = sum;
  }

  return out;
}

// ============================================
// 파서 5: 자산 현황 스냅샷 (현금 · 자산 · 부동산)
// 사용자가 지정한 셀 참조(예: "K18", "K17+N19+O19+P19")를 그대로 읽어옴.
// 월마다 셀 위치가 다를 수 있어 월별로 설정을 따로 둠. 아직 정의 안 된 달은 null 처리.
// ============================================
function colToIdx(letter) {
  let idx = 0;
  for (let i = 0; i < letter.length; i++) idx = idx * 26 + (letter.charCodeAt(i) - 64);
  return idx - 1; // 0-indexed
}

function getCellValue(grid, ref) {
  return ref
    .split("+")
    .map((s) => s.trim())
    .reduce((sum, part) => {
      const m = part.match(/^([A-Z]+)(\d+)$/);
      if (!m) return sum;
      const col = colToIdx(m[1]);
      const row = parseInt(m[2], 10) - 1;
      return sum + toNum(cell(grid, row, col));
    }, 0);
}

const ASSET_SNAPSHOT_CONFIG = {
  1: {
    cash: [
      { name: "개인주식", ref: "O21" },
      { name: "케이뱅크", ref: "K18" },
      { name: "해외주식", ref: "K19" },
      { name: "증권사 예수금", ref: "K17+N19+O19+P19" },
    ],
    assets: [
      { name: "주택원금", ref: "K20" },
      { name: "꼬 주택청약", ref: "K21" },
      { name: "송 주택청약", ref: "K22" },
      { name: "연금저축", ref: "K23" },
      { name: "꼬 퇴직금", ref: "K24" },
    ],
    realEstate: [
      { name: "라포리엘", ref: "L27" },
      { name: "반도빌리지", ref: "L28" },
    ],
  },
  2: {
    cash: [
      { name: "개인주식", ref: "O21" },
      { name: "케이뱅크", ref: "K18" },
      { name: "해외주식", ref: "K19" },
      { name: "증권사 예수금", ref: "K17+N19+O19+P19" },
    ],
    assets: [
      { name: "주택원금", ref: "K20" },
      { name: "꼬 주택청약", ref: "K21" },
      { name: "송 주택청약", ref: "K22" },
      { name: "연금저축", ref: "K23" },
      { name: "꼬 퇴직금", ref: "K24" },
    ],
    realEstate: [
      { name: "라포리엘", ref: "L27" },
      { name: "반도빌리지", ref: "L28" },
    ],
  },
  // 3~12월 셀 참조는 확인되는 대로 여기에 추가
};

// ============================================
// 파서 6: 부동산 상세 (최저 매도값 / 매수가격 / 수익 / 투자수익률)
// 저축 카테고리 대신 보여줄 부동산별 상세 정보. 월별로 설정을 따로 둠.
// ============================================
const REAL_ESTATE_DETAIL_CONFIG = {
  1: [
    { name: "라포리엘", investRef: "L27", sellRef: "M27", buyRef: "N27", profitDivisor: 2 },
    { name: "반도빌리지", investRef: "L28", sellRef: "M28", buyRef: "N28" },
  ],
  2: [
    { name: "라포리엘", investRef: "L27", sellRef: "M27", buyRef: "N27", profitDivisor: 2 },
    { name: "반도빌리지", investRef: "L28", sellRef: "M28", buyRef: "N28" },
  ],
  // 3~12월 셀 참조는 확인되는 대로 여기에 추가
};

function parseRealEstateDetail(grid, refConfig) {
  if (!grid || !refConfig) return null;
  return refConfig.map((c) => {
    const invest = getCellValue(grid, c.investRef);
    const sell = getCellValue(grid, c.sellRef);
    const buy = getCellValue(grid, c.buyRef);
    const divisor = c.profitDivisor || 1;
    const profit = (sell - buy) / divisor;
    const roi = invest ? (profit / invest) * 100 : null;
    return { name: c.name, invest, sell, buy, profit, roi };
  });
}

function parseAssetSnapshot(grid, refConfig) {
  if (!grid || !refConfig) return null;
  const mapItems = (items) => (items || []).map((it) => ({ name: it.name, value: getCellValue(grid, it.ref) }));
  const cash = mapItems(refConfig.cash);
  const assets = mapItems(refConfig.assets);
  const realEstate = mapItems(refConfig.realEstate);
  const financial = [...cash, ...assets].reduce((s, i) => s + i.value, 0);
  const realEstateTotal = realEstate.reduce((s, i) => s + i.value, 0);
  return { cash, assets, realEstate, financial, realEstateTotal, netWorth: financial + realEstateTotal };
}

// ============================================
// 데이터 로드 + 집계
// ============================================
async function loadAll(forceRefresh) {
  setSyncStatus("불러오는 중…");

  const cacheKey = "gsheet_cache_v1";
  if (!forceRefresh) {
    const cached = sessionStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      state.monthly = parsed.monthly;
      state.side = parsed.side;
      renderAll();
      setSyncStatus("캐시됨 · " + new Date(parsed.ts).toLocaleTimeString("ko-KR"));
      return;
    }
  }

  const sheetNames = [
    CONFIG.SHEET_NAMES.ANNUAL,
    CONFIG.SHEET_NAMES.SIDE_BUSINESS,
    ...CONFIG.MONTHS.map((m) => CONFIG.monthMeta(m).sheetName),
  ];
  const grids = await fetchGrids(sheetNames);

  const annual = parseAnnualSummary(grids[CONFIG.SHEET_NAMES.ANNUAL]);
  const side = parseSideBusiness(grids[CONFIG.SHEET_NAMES.SIDE_BUSINESS]);

  const monthly = {};
  for (const m of CONFIG.MONTHS) {
    const meta = CONFIG.monthMeta(m);
    const grid = grids[meta.sheetName] || [];
    const ranges = CONFIG.RANGES[m];
    const parsed = meta.format === "new" ? parseNewFormatMonth(grid, ranges) : parseOldFormatMonth(grid, ranges);

    // 연간요약 시트에 값이 있으면 그걸 우선 사용 (더 신뢰도 높음), 없으면 월 시트에서 계산한 값 사용
    const a = annual ? annual[m] : null;
    monthly[m] = {
      income: a && a.income ? a.income : parsed.income,
      expense: a && a.expense ? a.expense : parsed.expense,
      savings: a && a.savings ? a.savings : parsed.savings,
      categories: parsed.categories,
      categoryDetails: parsed.categoryDetails,
      savingsCategories: parsed.savingsCategories,
      assetSnapshot: parseAssetSnapshot(grid, ASSET_SNAPSHOT_CONFIG[m]),
      realEstateDetail: parseRealEstateDetail(grid, REAL_ESTATE_DETAIL_CONFIG[m]),
    };
  }

  state.monthly = monthly;
  state.side = side;
  sessionStorage.setItem(cacheKey, JSON.stringify({ monthly, side, ts: Date.now() }));

  renderAll();
  setSyncStatus("방금 동기화됨 · " + new Date().toLocaleTimeString("ko-KR"));
}

// ============================================
// 렌더링
// ============================================
// ============================================
// 종합(전체 합계) 집계
// ============================================
function aggregateTotal() {
  const agg = { income: 0, expense: 0, savings: 0, categories: {}, categoryDetails: {} };
  CONFIG.MONTHS.forEach((m) => {
    const d = state.monthly[m];
    if (!d) return;
    agg.income += d.income || 0;
    agg.expense += d.expense || 0;
    agg.savings += d.savings || 0;
    Object.entries(d.categories || {}).forEach(([k, v]) => {
      agg.categories[k] = (agg.categories[k] || 0) + v;
    });
    Object.entries(d.categoryDetails || {}).forEach(([cat, items]) => {
      if (!agg.categoryDetails[cat]) agg.categoryDetails[cat] = {};
      Object.entries(items).forEach(([item, amt]) => {
        agg.categoryDetails[cat][item] = (agg.categoryDetails[cat][item] || 0) + amt;
      });
    });
  });
  return agg;
}

// 선택한 범위(전체 or 특정 월)의 부업 수익 합계
function getSideIncome(sel) {
  const side = state.side || {};
  const months = sel === "total" ? CONFIG.MONTHS : [sel];
  let sum = 0;
  Object.keys(side).forEach((key) => {
    months.forEach((m) => {
      sum += side[key]?.[m] || 0;
    });
  });
  return sum;
}

// selectedMonth가 "total"이면 전체 합계, 숫자면 해당 월 데이터를 반환
function getSelectedData(sel) {
  return sel === "total" ? aggregateTotal() : state.monthly[sel] || {};
}

function renderAll() {
  renderMonthRibbon();
  renderKpis(state.selectedMonth);
  renderTrendChart(state.selectedMonth);
  renderCatChart(state.selectedMonth);
  renderSideChart(state.selectedMonth);
  renderRateChart(state.selectedMonth);
  renderAssetPanel(state.selectedMonth);
}

function renderMonthRibbon() {
  const wrap = $("#monthRibbon");
  wrap.innerHTML = "";

  const selectMonth = (sel) => {
    state.selectedMonth = sel;
    renderMonthRibbon();
    renderKpis(sel);
    renderCatChart(sel);
    renderTrendChart(sel);
    renderSideChart(sel);
    renderRateChart(sel);
    renderAssetPanel(sel);
  };

  // 종합 타일 (1~8월 전체 합계) — 맨 앞에 고정
  const totalTile = document.createElement("div");
  totalTile.className = "month-tile" + (state.selectedMonth === "total" ? " active" : "");
  totalTile.innerHTML = `<div class="m-label">종합</div>`;
  totalTile.addEventListener("click", () => selectMonth("total"));
  wrap.appendChild(totalTile);

  CONFIG.MONTHS.forEach((m) => {
    const d = state.monthly[m] || {};
    const hasData = (d.income || 0) > 0 || (d.expense || 0) > 0;
    const tile = document.createElement("div");
    tile.className = "month-tile" + (m === state.selectedMonth ? " active" : "") + (hasData ? "" : " empty");
    tile.innerHTML = `<div class="m-label">${m}월</div>`;
    tile.addEventListener("click", () => selectMonth(m));
    wrap.appendChild(tile);
  });
}

function renderKpis(sel) {
  const d = getSelectedData(sel);
  const label = sel === "total" ? "종합" : `${sel}월`;
  const sideIncome = getSideIncome(sel);
  const income = (d.income || 0) + sideIncome;
  const expense = d.expense || 0;
  const savings = d.savings || 0;
  const rate = income ? ((savings / income) * 100).toFixed(1) : "0.0";

  const cards = [
    { label: "총 수입", value: income, color: "var(--income)", sub: `월급 ${fmtWon(d.income || 0)} + 부업 ${fmtWon(sideIncome)}` },
    { label: "총 지출", value: expense, color: "var(--expense)" },
    { label: "저축/투자", value: savings, color: "var(--savings)", sub: `저축률 ${rate}%` },
    { label: "부업 수익", value: sideIncome, color: "var(--accent)" },
  ];

  $("#kpiGrid").innerHTML = cards
    .map(
      (c) => `
    <div class="kpi-card">
      <div class="label"><span class="dot" style="background:${c.color}"></span>${label} ${c.label}</div>
      <div class="value">${fmtWon(c.value)}</div>
      <div class="delta">${c.sub || ""}</div>
    </div>`
    )
    .join("");
}

function destroyChart(key) {
  if (state.charts[key]) {
    state.charts[key].destroy();
    delete state.charts[key];
  }
}

const chartDefaults = {
  color: "#6b7280",
  font: { family: "-apple-system, sans-serif", size: 11 },
};

// 전월 대비 증감률(%)을 막대 위에 숫자로 그려주는 커스텀 플러그인
const pctLabelPlugin = {
  id: "pctLabels",
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins && chart.options.plugins.pctLabels;
    if (!opt || !opt.values) return;
    try {
      const meta = chart.getDatasetMeta(opt.datasetIndex);
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = "700 11px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      meta.data.forEach((bar, i) => {
        if (!bar) return;
        const v = opt.values[i];
        if (v === null || v === undefined || !isFinite(v)) return;
        const text = (v > 0 ? "+" : "") + v.toFixed(1) + "%";
        ctx.fillStyle = v >= 0 ? "#2f9d6f" : "#d63653";
        ctx.fillText(text, bar.x, bar.y - 22);
      });
      ctx.restore();
    } catch (e) {
      console.warn("pctLabels 플러그인 렌더링 오류", e);
    }
  },
};
Chart.register(pctLabelPlugin);

// 막대(세로) 위 / 막대(가로) 옆에 항상 금액을 숫자로 그려주는 플러그인 — 마우스를 올리지 않아도 값이 보이도록 함
const amountLabelPlugin = {
  id: "amountLabels",
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins && chart.options.plugins.amountLabels;
    if (!opt || !opt.enabled) return;
    try {
      const ctx = chart.ctx;
      const isHorizontal = chart.options.indexAxis === "y";
      // opt.formatter는 함수가 아니라 문자열 플래그("won")로 받음 — Chart.js는 옵션 트리에
      // 함수가 들어있으면 "스크립터블 옵션"으로 간주해 자기 내부 컨텍스트를 인자로 넣어
      // 먼저 호출해버리는데, 그러면 우리가 원하는 시점/인자로 호출할 수 없어 값이 깨짐
      const formatter = opt.formatter === "won" ? fmtWon : fmtShort;
      const datasetIndexes = opt.datasets || chart.data.datasets.map((_, i) => i);
      ctx.save();
      ctx.font = "700 10.5px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = opt.color || "#1a1d24";
      datasetIndexes.forEach((dsIndex) => {
        const ds = chart.data.datasets[dsIndex];
        if (!ds || ds.type === "line") return; // 선 그래프(저축/투자 추이 등)는 제외
        const meta = chart.getDatasetMeta(dsIndex);
        if (!meta || meta.hidden) return;
        // 값은 chart.data.datasets[].data 를 다시 읽지 않고, 차트를 만들 때 넘겨준
        // 순수 숫자 배열(opt.values)에서 가져옴 — Chart.js가 내부적으로 data 배열에
        // 반응형 래퍼를 씌우는 경우가 있어, 그걸 직접 읽으면 숫자로 변환되지 않는
        // 값이 나와 렌더링이 중간에 죽는 문제가 있었음
        const valuesSrc = Array.isArray(opt.values) ? opt.values : opt.values && opt.values[dsIndex];
        meta.data.forEach((el, i) => {
          if (!el) return;
          const raw = valuesSrc ? valuesSrc[i] : ds.data[i];
          const val = typeof raw === "number" ? raw : Number(raw);
          if (val === null || val === undefined || val === 0 || Number.isNaN(val) || !isFinite(val)) return;
          const text = formatter(val);
          if (isHorizontal) {
            ctx.textAlign = el.x >= 0 ? "left" : "right";
            ctx.textBaseline = "middle";
            ctx.fillText(text, el.x + (el.x >= 0 ? 6 : -6), el.y);
          } else {
            ctx.textAlign = "center";
            ctx.textBaseline = "alphabetic";
            ctx.fillText(text, el.x, el.y - 8);
          }
        });
      });
      ctx.restore();
    } catch (e) {
      console.warn("amountLabels 플러그인 렌더링 오류", e);
    }
  },
};
Chart.register(amountLabelPlugin);

// 누적 막대그래프(부업 수익 추이) 맨 위에 그 달의 합계를 숫자로 그려주는 플러그인
const stackTotalLabelPlugin = {
  id: "stackTotalLabels",
  afterDatasetsDraw(chart) {
    const opt = chart.options.plugins && chart.options.plugins.stackTotalLabels;
    if (!opt || !opt.enabled) return;
    try {
      const datasets = chart.data.datasets;
      const ctx = chart.ctx;
      ctx.save();
      ctx.font = "700 11px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#1a1d24";
      chart.data.labels.forEach((_, i) => {
        let total = 0;
        let topY = null;
        let x = null;
        datasets.forEach((ds, dsIndex) => {
          const val = ds.data[i] || 0;
          total += val;
          const meta = chart.getDatasetMeta(dsIndex);
          if (!meta || meta.hidden) return;
          const bar = meta.data[i];
          if (bar && val) {
            if (topY === null || bar.y < topY) topY = bar.y;
            x = bar.x;
          }
        });
        if (x === null || !total) return;
        ctx.fillText(fmtShort(total), x, topY - 8);
      });
      ctx.restore();
    } catch (e) {
      console.warn("stackTotalLabels 플러그인 렌더링 오류", e);
    }
  },
};
Chart.register(stackTotalLabelPlugin);


function renderTrendChart(sel) {
  destroyChart("trend");
  const titleEl = $("#trendTitleText");
  const tagEl = $("#trendTag");

  if (sel === "total") {
    titleEl.textContent = "월별 수입 · 지출 · 저축 추이";
    tagEl.textContent = "2026년 1~8월";
    const labels = CONFIG.MONTHS.map((m) => `${m}월`);
    const income = CONFIG.MONTHS.map((m) => (state.monthly[m]?.income || 0) + getSideIncome(m));
    const expense = CONFIG.MONTHS.map((m) => state.monthly[m]?.expense || 0);
    const savings = CONFIG.MONTHS.map((m) => state.monthly[m]?.savings || 0);

    state.charts.trend = new Chart($("#trendChart"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "수입", data: income, backgroundColor: "#2f9d6f", borderRadius: 4, order: 2 },
          { label: "지출", data: expense, backgroundColor: "#d63653", borderRadius: 4, order: 2 },
          {
            label: "저축/투자",
            data: savings,
            type: "line",
            borderColor: "#c08a2e",
            backgroundColor: "#c08a2e",
            tension: 0.35,
            order: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 20 } },
        plugins: {
          legend: { labels: { color: "#6b7280", font: chartDefaults.font, usePointStyle: true } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtWon(ctx.raw)}` } },
          amountLabels: { enabled: true, datasets: [0, 1], values: { 0: income, 1: expense } },
        },
        scales: {
          x: { grid: { color: "#e2e5eb" }, ticks: { color: "#6b7280" } },
          y: {
            grid: { color: "#e2e5eb" },
            suggestedMax: Math.max(...income, ...expense, 1) * 1.15,
            ticks: { color: "#6b7280", callback: (v) => fmtShort(v) },
          },
        },
      },
    });
    return;
  }

  // 특정 월: 전월 대비 수입/지출/저축 비교
  const cur = state.monthly[sel] || {};
  const prevM = sel - 1;
  const prev = prevM >= 1 ? state.monthly[prevM] : null;
  const curIncome = (cur.income || 0) + getSideIncome(sel);
  const prevIncome = prev ? (prev.income || 0) + getSideIncome(prevM) : null;

  titleEl.textContent = `${sel}월 수입 · 지출 · 저축`;
  tagEl.textContent = prev ? `${prevM}월 대비` : "전월 데이터 없음";

  const labels = ["수입", "지출", "저축/투자"];
  const curData = [curIncome, cur.expense || 0, cur.savings || 0];
  const datasets = [
    {
      label: `${sel}월`,
      data: curData,
      backgroundColor: ["#2f9d6f", "#d63653", "#c08a2e"],
      borderRadius: 4,
    },
  ];

  let pctValues = null;
  let curDatasetIndex = 0;
  let amountValuesByDs = { 0: curData };

  if (prev) {
    const prevData = [prevIncome, prev.expense || 0, prev.savings || 0];
    datasets.unshift({
      label: `${prevM}월`,
      data: prevData,
      backgroundColor: "#c9ced9",
      borderRadius: 4,
    });
    curDatasetIndex = 1;
    amountValuesByDs = { 0: prevData, 1: curData };
    pctValues = curData.map((v, i) => (prevData[i] ? ((v - prevData[i]) / Math.abs(prevData[i])) * 100 : null));
  }

  const maxVal = Math.max(...curData, ...(prev ? [prevIncome, prev.expense || 0, prev.savings || 0] : [0]), 1);

  state.charts.trend = new Chart($("#trendChart"), {
    type: "bar",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 36 } },
      plugins: {
        legend: { labels: { color: "#6b7280", font: chartDefaults.font, usePointStyle: true } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtWon(ctx.raw)}` } },
        pctLabels: { values: pctValues, datasetIndex: curDatasetIndex },
        amountLabels: { enabled: true, values: amountValuesByDs },
      },
      scales: {
        x: { grid: { color: "#e2e5eb" }, ticks: { color: "#6b7280" } },
        y: {
          grid: { color: "#e2e5eb" },
          suggestedMax: maxVal * 1.18,
          ticks: { color: "#6b7280", callback: (v) => fmtShort(v) },
        },
      },
    },
  });
}

function renderCatChart(sel) {
  const label = sel === "total" ? "종합" : `${sel}월`;
  const data = getSelectedData(sel);
  const cats = data.categories || {};
  const details = data.categoryDetails || {};
  const entries = Object.entries(cats)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]); // 전체 카테고리 (개수 제한 없음)

  $("#catTitle").innerHTML = `${label} 지출 카테고리 <span class="tag">총 ${entries.length}개</span>`;

  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  $("#catList").innerHTML = entries
    .map(([name, val]) => {
      const isOpen = state.expandedCats.has(name);
      const items = Object.entries(details[name] || {}).sort((a, b) => b[1] - a[1]);
      const itemsHtml = items.length
        ? items
            .map(
              ([item, amt]) => `
        <div class="cat-item-row"><span>${item}</span><span class="cat-item-amt">${fmtWon(amt)}</span></div>`
            )
            .join("")
        : `<div class="cat-item-empty">세부 내역 없음</div>`;
      return `
      <div class="cat-row-wrap">
        <div class="cat-row" data-cat="${name}">
          <div class="name">${name}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(val / total) * 100}%"></div></div>
          <div class="amt">${fmtWon(val)}</div>
          <div class="expand-icon">${isOpen ? "▲" : "▼"}</div>
        </div>
        <div class="cat-detail ${isOpen ? "" : "hidden"}">${itemsHtml}</div>
      </div>`;
    })
    .join("");

  $("#catList")
    .querySelectorAll(".cat-row")
    .forEach((row) => {
      row.addEventListener("click", () => {
        const name = row.dataset.cat;
        if (state.expandedCats.has(name)) state.expandedCats.delete(name);
        else state.expandedCats.add(name);
        renderCatChart(sel);
      });
    });

  // 항목 9개까지만 보이도록 실제 렌더링된 행 높이를 측정해 컨테이너 높이를 고정,
  // 나머지는 스크롤로 확인 (수입/지출/저축 카드·차트 라인과 높이를 맞추기 위함)
  const VISIBLE_ROWS = 9;
  const rowWraps = $("#catList").querySelectorAll(".cat-row-wrap");
  if (rowWraps.length > VISIBLE_ROWS) {
    const gap = 6;
    let h = 0;
    for (let i = 0; i < VISIBLE_ROWS; i++) h += rowWraps[i].offsetHeight;
    h += gap * (VISIBLE_ROWS - 1);
    $("#catList").style.maxHeight = h + "px";
  } else {
    $("#catList").style.maxHeight = "none";
  }
}

function renderSideChart(sel) {
  destroyChart("side");
  const titleEl = $("#sideTitleText");
  const tagEl = $("#sideTag");
  const side = state.side || {};

  if (sel === "total") {
    titleEl.textContent = "부업 수익 추이";
    tagEl.textContent = "구매대행 · 해외주식 · 공모주";
    const labels = CONFIG.MONTHS.map((m) => `${m}월`);
    const mk = (key) => CONFIG.MONTHS.map((m) => (side[key] ? side[key][m] || 0 : 0));

    const dPurchase = mk("구매대행");
    const dStock = mk("해외주식");
    const dIpo = mk("공모주");
    const dCard = mk("카테크");
    const totals = CONFIG.MONTHS.map((_, i) => dPurchase[i] + dStock[i] + dIpo[i] + dCard[i]);
    const maxTotal = Math.max(...totals, 1);

    state.charts.side = new Chart($("#sideChart"), {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "구매대행", data: dPurchase, backgroundColor: "#4a6cc0", stack: "s" },
          { label: "해외주식", data: dStock, backgroundColor: "#2f9d6f", stack: "s" },
          { label: "공모주", data: dIpo, backgroundColor: "#c08a2e", stack: "s" },
          { label: "카테크", data: dCard, backgroundColor: "#c77dff", stack: "s" },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 22 } },
        plugins: {
          legend: { labels: { color: "#6b7280", font: chartDefaults.font, usePointStyle: true } },
          tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtWon(ctx.raw)}` } },
          stackTotalLabels: { enabled: true },
        },
        scales: {
          x: { stacked: true, grid: { color: "#e2e5eb" }, ticks: { color: "#6b7280" } },
          y: {
            stacked: true,
            suggestedMax: maxTotal * 1.18,
            grid: { color: "#e2e5eb" },
            ticks: { color: "#6b7280", callback: (v) => fmtShort(v) },
          },
        },
      },
    });
    return;
  }

  // 특정 월: 그 달의 부업 수익 카테고리별 breakdown
  titleEl.textContent = `${sel}월 부업 수익`;
  const cats = [
    { key: "구매대행", color: "#4a6cc0" },
    { key: "해외주식", color: "#2f9d6f" },
    { key: "공모주", color: "#c08a2e" },
    { key: "카테크", color: "#c77dff" },
  ];
  const values = cats.map((c) => (side[c.key] ? side[c.key][sel] || 0 : 0));
  tagEl.textContent = `총 ${fmtShort(values.reduce((a, b) => a + b, 0))}`;

  state.charts.side = new Chart($("#sideChart"), {
    type: "bar",
    data: {
      labels: cats.map((c) => c.key),
      datasets: [{ data: values, backgroundColor: cats.map((c) => c.color), borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 20 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmtWon(ctx.raw) } },
        amountLabels: { enabled: true, values },
      },
      scales: {
        x: { grid: { color: "#e2e5eb" }, ticks: { color: "#6b7280" } },
        y: {
          grid: { color: "#e2e5eb" },
          suggestedMax: Math.max(...values, 1) * 1.15,
          ticks: { color: "#6b7280", callback: (v) => fmtShort(v) },
        },
      },
    },
  });
}

function renderRateChart(sel) {
  destroyChart("rate");
  const titleEl = $("#rateTitleText");
  const tagEl = $("#rateTag");
  const chartWrap = $("#rateChart").closest(".chart-wrap");
  const listEl = $("#realEstateList");

  // 기본: 차트를 보여주고 부동산 리스트는 숨김 (부동산 상세가 있는 달이면 아래에서 뒤집음)
  chartWrap.classList.remove("hidden");
  listEl.classList.add("hidden");
  listEl.innerHTML = "";

  if (sel === "total") {
    titleEl.textContent = "저축률";
    tagEl.textContent = "저축÷수입";
    const labels = CONFIG.MONTHS.map((m) => `${m}월`);
    const rates = CONFIG.MONTHS.map((m) => {
      const d = state.monthly[m] || {};
      const income = (d.income || 0) + getSideIncome(m);
      return income ? Number(((d.savings / income) * 100).toFixed(1)) : 0;
    });

    state.charts.rate = new Chart($("#rateChart"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "저축률(%)",
            data: rates,
            borderColor: "#c08a2e",
            backgroundColor: "rgba(192,138,46,0.12)",
            fill: true,
            tension: 0.35,
            pointBackgroundColor: "#c08a2e",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `저축률: ${ctx.raw}%` } } },
        scales: {
          x: { grid: { color: "#e2e5eb" }, ticks: { color: "#6b7280" } },
          y: { grid: { color: "#e2e5eb" }, ticks: { color: "#6b7280", callback: (v) => v + "%" } },
        },
      },
    });
    return;
  }

  // 특정 월: 저축 대신 부동산 상세 정보가 설정돼 있으면 그걸 우선 표시
  const monthData = state.monthly[sel] || {};
  const reDetail = monthData.realEstateDetail;
  if (reDetail && reDetail.length) {
    chartWrap.classList.add("hidden");
    listEl.classList.remove("hidden");

    titleEl.textContent = `${sel}월 부동산 현황`;
    tagEl.textContent = `총 ${reDetail.length}건`;

    const totalProfit = reDetail.reduce((s, p) => s + p.profit, 0);
    const totalColor = totalProfit >= 0 ? "var(--income)" : "var(--expense)";
    const totalCardHtml = `
      <div class="re-card re-total">
        <div class="re-name">최종 부동산 수익 합계</div>
        <div class="re-total-val" style="color:${totalColor}">${fmtWon(totalProfit)}</div>
      </div>`;

    listEl.innerHTML =
      totalCardHtml +
      reDetail
        .map((p) => {
        const roiText = p.roi === null || p.roi === undefined || !isFinite(p.roi) ? "-" : `${p.roi >= 0 ? "+" : ""}${p.roi.toFixed(1)}%`;
        const roiColor = p.roi === null || p.roi === undefined || !isFinite(p.roi) ? "var(--muted)" : p.roi >= 0 ? "var(--income)" : "var(--expense)";
        const profitColor = p.profit >= 0 ? "var(--income)" : "var(--expense)";
        return `
        <div class="re-card">
          <div class="re-name">${p.name}</div>
          <div class="re-grid">
            <div class="re-item"><span class="re-label">최저 매도값</span><span class="re-val">${fmtWon(p.sell)}</span></div>
            <div class="re-item"><span class="re-label">매수가격</span><span class="re-val">${fmtWon(p.buy)}</span></div>
            <div class="re-item"><span class="re-label">수익</span><span class="re-val" style="color:${profitColor}">${fmtWon(p.profit)}</span></div>
            <div class="re-item"><span class="re-label">투자수익률</span><span class="re-val" style="color:${roiColor}">${roiText}</span></div>
          </div>
        </div>`;
      })
      .join("");
    return;
  }

  // 특정 월: 그 달의 저축 카테고리별 breakdown
  const d = state.monthly[sel] || {};
  const entries = Object.entries(d.savingsCategories || {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  titleEl.textContent = `${sel}월 저축 카테고리`;
  tagEl.textContent = `총 ${entries.length}개`;
  const savingsValues = entries.map(([, v]) => v);
  const maxSavingsVal = Math.max(...savingsValues, 1);

  state.charts.rate = new Chart($("#rateChart"), {
    type: "bar",
    data: {
      labels: entries.map(([name]) => name),
      datasets: [{ data: savingsValues, backgroundColor: "#c08a2e", borderRadius: 4 }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmtWon(ctx.raw) } },
        amountLabels: { enabled: true, formatter: "won", values: savingsValues },
      },
      scales: {
        x: { grid: { color: "#e2e5eb" }, suggestedMax: maxSavingsVal * 1.25, ticks: { color: "#6b7280", callback: (v) => fmtShort(v) } },
        y: { grid: { display: false }, ticks: { color: "#6b7280" } },
      },
    },
  });
}

function renderAssetPanel(sel) {
  destroyChart("asset");
  const titleEl = $("#assetTitleText");
  const tagEl = $("#assetTag");
  const summaryEl = $("#assetSummary");

  // 종합 선택 시엔 순자산은 합산 개념이 아니므로, 데이터가 있는 가장 최근 달을 보여줌
  let targetMonth = sel;
  if (sel === "total") {
    const withData = CONFIG.MONTHS.filter((m) => state.monthly[m]?.assetSnapshot);
    targetMonth = withData.length ? withData[withData.length - 1] : null;
  }

  const snap = targetMonth ? state.monthly[targetMonth]?.assetSnapshot : null;

  if (!snap) {
    titleEl.textContent = "자산 현황";
    tagEl.textContent = "데이터 준비 중";
    summaryEl.innerHTML = `<div class="kpi-card"><div class="label">자산 데이터</div><div class="value" style="font-size:13px; color:var(--muted); font-weight:600;">아직 입력된 달이 없어요</div></div>`;
    return;
  }

  titleEl.textContent = `${targetMonth}월 자산 현황`;
  tagEl.textContent = sel === "total" ? `최신 데이터(${targetMonth}월) 기준` : "현금 · 자산 · 부동산 스냅샷";

  const reDetail = targetMonth ? state.monthly[targetMonth]?.realEstateDetail : null;
  const reProfitTotal = reDetail && reDetail.length ? reDetail.reduce((s, p) => s + p.profit, 0) : null;

  const cards = [
    { label: "금융자산", value: snap.financial, color: "var(--accent)" },
    { label: "부동산", value: snap.realEstateTotal, color: "var(--savings)" },
    { label: "총 자산(순자산)", value: snap.netWorth, color: "var(--income)" },
  ];
  if (reProfitTotal !== null) {
    cards.push({
      label: "예상 자산(부동산 수익)",
      value: snap.netWorth + reProfitTotal,
      color: "var(--forecast)",
      sub: `총자산 + 부동산 수익 ${fmtWon(reProfitTotal)}`,
    });
  }
  summaryEl.innerHTML = cards
    .map(
      (c) => `
    <div class="kpi-card">
      <div class="label"><span class="dot" style="background:${c.color}"></span>${c.label}</div>
      <div class="value">${fmtWon(c.value)}</div>
      ${c.sub ? `<div class="delta">${c.sub}</div>` : ""}
    </div>`
    )
    .join("");

  const items = [
    ...snap.cash.map((i) => ({ ...i, color: "#4a6cc0" })),
    ...snap.assets.map((i) => ({ ...i, color: "#2f9d6f" })),
    ...snap.realEstate.map((i) => ({ ...i, color: "#c08a2e" })),
  ].filter((i) => i.value);
  const assetValues = items.map((i) => i.value);
  const maxAssetVal = Math.max(...assetValues, 1);

  state.charts.asset = new Chart($("#assetChart"), {
    type: "bar",
    data: {
      labels: items.map((i) => i.name),
      datasets: [{ data: assetValues, backgroundColor: items.map((i) => i.color), borderRadius: 4 }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { right: 56 } },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmtWon(ctx.raw) } },
        amountLabels: { enabled: true, formatter: "won", values: assetValues },
      },
      scales: {
        x: { grid: { color: "#e2e5eb" }, suggestedMax: maxAssetVal * 1.35, ticks: { color: "#6b7280", callback: (v) => fmtShort(v) } },
        y: { grid: { display: false }, ticks: { color: "#6b7280" } },
      },
    },
  });
}

// ============================================
// 초기화
// ============================================
window.addEventListener("load", initApp);
