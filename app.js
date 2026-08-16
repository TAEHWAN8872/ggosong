// ============================================
// 상태
// ============================================
const state = {
  monthly: {},      // { 1: {income, expense, savings, categories:{}}, ... }
  side: null,        // { months:[...], categories:{...} }
  selectedMonth: 8,
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
  const out = { income: 0, expense: 0, savings: 0, categories: {}, savingsCategories: {} };

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
    if (trimStr(row[0]) === "항목" && trimStr(row[1]) === "항목" && row.some((v) => trimStr(v) === "카테고리")) {
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
        }
      }
    }

    // 변동지출: 실제 시트 수식과 동일한 행 범위만 집계 (예: J13:J36)
    let varSum = 0;
    if (ranges.varRows && rightCatCol >= 0 && rightAmtCol >= 0) {
      const [r1, r2] = ranges.varRows;
      for (let sheetRow = r1; sheetRow <= r2; sheetRow++) {
        const rr = grid[sheetRow - 1] || [];
        const cat = trimStr(rr[rightCatCol]);
        const amt = toNum(rr[rightAmtCol]);
        varSum += amt;
        if (cat && amt) {
          out.categories[cat] = (out.categories[cat] || 0) + amt;
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
  const out = { income: 0, expense: 0, savings: 0, categories: {}, savingsCategories: {} };
  if (!ranges) return out;

  const CAT = 1, ITEM = 2, AMT = 4; // 분류, 제목, 금액(실제) — B, C, E열

  // 수입: 구형 포맷(1~5월) 공통으로 F5 셀에 월급 금액이 들어있음
  out.income = toNum(cell(grid, 4, 5)); // 시트상 F5 (0-indexed: row 4, col 5)

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
function renderAll() {
  renderMonthRibbon();
  renderKpis(state.selectedMonth);
  renderTrendChart();
  renderCatChart(state.selectedMonth);
  renderSideChart();
  renderRateChart();
}

function renderMonthRibbon() {
  const wrap = $("#monthRibbon");
  wrap.innerHTML = "";
  const maxVal = Math.max(
    1,
    ...CONFIG.MONTHS.flatMap((m) => [state.monthly[m]?.income || 0, state.monthly[m]?.expense || 0])
  );
  CONFIG.MONTHS.forEach((m) => {
    const d = state.monthly[m] || {};
    const hasData = (d.income || 0) > 0 || (d.expense || 0) > 0;
    const net = (d.income || 0) - (d.expense || 0) - (d.savings || 0);
    const tile = document.createElement("div");
    tile.className = "month-tile" + (m === state.selectedMonth ? " active" : "") + (hasData ? "" : " empty");
    const incH = Math.max(2, ((d.income || 0) / maxVal) * 34);
    const expH = Math.max(2, ((d.expense || 0) / maxVal) * 34);
    tile.innerHTML = `
      <div class="m-label">${m}월</div>
      <div class="m-bar">
        <div style="height:${incH}px;background:var(--income)"></div>
        <div style="height:${expH}px;background:var(--expense)"></div>
      </div>
      <div class="m-net" style="color:${net >= 0 ? "var(--income)" : "var(--expense)"}">${hasData ? fmtShort(net) : "–"}</div>
    `;
    tile.addEventListener("click", () => {
      state.selectedMonth = m;
      renderMonthRibbon();
      renderKpis(m);
      renderCatChart(m);
    });
    wrap.appendChild(tile);
  });
}

function renderKpis(m) {
  const d = state.monthly[m] || {};
  const income = d.income || 0;
  const expense = d.expense || 0;
  const savings = d.savings || 0;
  const balance = income - expense - savings;
  const rate = income ? ((savings / income) * 100).toFixed(1) : "0.0";

  const cards = [
    { label: "총 수입", value: income, color: "var(--income)" },
    { label: "총 지출", value: expense, color: "var(--expense)" },
    { label: "저축/투자", value: savings, color: "var(--savings)", sub: `저축률 ${rate}%` },
    { label: "잔액", value: balance, color: balance >= 0 ? "var(--income)" : "var(--expense)" },
  ];

  $("#kpiGrid").innerHTML = cards
    .map(
      (c) => `
    <div class="kpi-card">
      <div class="label"><span class="dot" style="background:${c.color}"></span>${m}월 ${c.label}</div>
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

function renderTrendChart() {
  destroyChart("trend");
  const labels = CONFIG.MONTHS.map((m) => `${m}월`);
  const income = CONFIG.MONTHS.map((m) => state.monthly[m]?.income || 0);
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
      plugins: {
        legend: { labels: { color: "#6b7280", font: chartDefaults.font, usePointStyle: true } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtWon(ctx.raw)}` } },
      },
      scales: {
        x: { grid: { color: "#e2e5eb" }, ticks: { color: "#6b7280" } },
        y: {
          grid: { color: "#e2e5eb" },
          ticks: { color: "#6b7280", callback: (v) => fmtShort(v) },
        },
      },
    },
  });
}

function renderCatChart(m) {
  destroyChart("cat");
  const cats = state.monthly[m]?.categories || {};
  const entries = Object.entries(cats)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  $("#catTitle").innerHTML = `${m}월 지출 카테고리 <span class="tag">상위 ${entries.length}개</span>`;

  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  $("#catList").innerHTML = entries
    .map(
      ([name, val]) => `
    <div class="cat-row">
      <div class="name">${name}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${(val / total) * 100}%"></div></div>
      <div class="amt">${fmtShort(val)}</div>
    </div>`
    )
    .join("");

  state.charts.cat = new Chart($("#catChart"), {
    type: "doughnut",
    data: {
      labels: entries.map((e) => e[0]),
      datasets: [
        {
          data: entries.map((e) => e[1]),
          backgroundColor: ["#d63653", "#c08a2e", "#4a6cc0", "#2f9d6f", "#c77dff", "#4bc0c0", "#f39c6b", "#6b7280"],
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtWon(ctx.raw)}` } } },
    },
  });
}

function renderSideChart() {
  destroyChart("side");
  const labels = CONFIG.MONTHS.map((m) => `${m}월`);
  const side = state.side || {};
  const mk = (key) => CONFIG.MONTHS.map((m) => (side[key] ? side[key][m] || 0 : 0));

  state.charts.side = new Chart($("#sideChart"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "구매대행", data: mk("구매대행"), backgroundColor: "#4a6cc0", stack: "s" },
        { label: "해외주식", data: mk("해외주식"), backgroundColor: "#2f9d6f", stack: "s" },
        { label: "공모주", data: mk("공모주"), backgroundColor: "#c08a2e", stack: "s" },
        { label: "카테크", data: mk("카테크"), backgroundColor: "#c77dff", stack: "s" },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: "#6b7280", font: chartDefaults.font, usePointStyle: true } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${fmtWon(ctx.raw)}` } },
      },
      scales: {
        x: { stacked: true, grid: { color: "#e2e5eb" }, ticks: { color: "#6b7280" } },
        y: { stacked: true, grid: { color: "#e2e5eb" }, ticks: { color: "#6b7280", callback: (v) => fmtShort(v) } },
      },
    },
  });
}

function renderRateChart() {
  destroyChart("rate");
  const labels = CONFIG.MONTHS.map((m) => `${m}월`);
  const rates = CONFIG.MONTHS.map((m) => {
    const d = state.monthly[m] || {};
    return d.income ? Number(((d.savings / d.income) * 100).toFixed(1)) : 0;
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
}

// ============================================
// 초기화
// ============================================
window.addEventListener("load", initApp);
