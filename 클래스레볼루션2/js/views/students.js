// 학생 목록 & 자유형 자리배치 뷰 (1:1 분할 카드 / 4종 점수 표시 / 16:9 자리카드 / 유연 틈새삽입·자석격자·점선 추가카드)

import { store, getStillAvatarUrl, getFxAvatarUrl, uid } from '../store.js';
import { openScoreComposer, showToast, escapeHtml, escapeAttr } from '../effects.js';
import { resetScores } from '../score-engine.js';
import { playSound } from '../audio.js';

// 자리배치 기하 상수 (16:9 학생카드 152x85.5 → 1500x726 공간에 가로 2열 모둠 4개, 세로 2행 모둠 3개 여유 배치)
const SEAT_W = 152;
const SEAT_H = 85.5;
const SEAT_GAP = 6;
const GROUP_PAD_X = 18; // border 6 + padding 12
const GROUP_PAD_Y = 18; // border 6 + padding 12
const FOOTER_H = 30;
const GROUP_GAP_X = 22;
const GROUP_GAP_Y = 18;
const CANVAS_PAD = 8;
const SNAP_THRESHOLD = 14;
const GHOST_W = SEAT_W + GROUP_PAD_X; // 170 (1명 크기 모둠)
const GHOST_H = SEAT_H + GROUP_PAD_Y + FOOTER_H; // 133.5

let subView = 'list'; // 'list' | 'seats'
let selectedIds = new Set();
let lastSelectedIds = [];
let attendanceMode = false;
let seatEditMode = false;
let seatingFlipping = false;
let seatingFlipTargetRoot = null;
let seatingPickRunning = false; // 자리배치 내 그룹 뽑기 / 개인 뽑기 하이라이트 진행 중 플래그
let ghostAddPos = null; // 편집 모드 중 이동 가능한 1명 크기 점선 '+' 새 모둠 카드 좌표 { x, y }
let swapSourceStudentId = null; // 편집 모드에서 학생 카드 2개 클릭 자리 교환용 첫 번째 선택 학생 ID
let navigateCallback = null;

// 상점/벌점 연출 복귀 시 노란 선택 하이라이트 유지 + 1초 좌우 4세트 틸트 (상점은 포즈 동반, 벌점은 포즈 없음) 후 선택 해제
let celebratingIds = new Set();
let celebratingType = null; // 'positive' | 'negative' | null
let celebrateTimer = null;
let lastStudentsRoot = null;
const mountedStudentRoots = new Set();
let studentsResizeRaf = 0;

// 학생목록·자리배치 카드 영역 전용 배율 (Ctrl+휠 / 핀치투줌, 기본 1.0 = 화면맞춤)
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const pendingZoom = { list: null, seats: null };
const zoomSaveTimers = { list: null, seats: null };

function clampZoom(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 1;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(n * 100) / 100));
}

function getUserZoom(viewKind, state = store.getState()) {
  if (pendingZoom[viewKind] !== null) return pendingZoom[viewKind];
  const key = viewKind === 'seats' ? 'seatZoom' : 'listZoom';
  return clampZoom(state?.uiPrefs?.[key] ?? 1);
}

function updateZoomResetButton(root, viewKind, zoom) {
  const btn = root?.querySelector('[data-zoom-reset]');
  if (!btn) return;
  const isDefault = Math.abs(zoom - 1) < 0.005;
  btn.hidden = isDefault;
  if (!isDefault) {
    btn.textContent = `${Math.round(zoom * 100)}% · 원래대로`;
  }
}

function persistUserZoom(viewKind, zoom) {
  const key = viewKind === 'seats' ? 'seatZoom' : 'listZoom';
  store.update((s) => {
    if (!s.uiPrefs) s.uiPrefs = {};
    s.uiPrefs[key] = zoom;
  }).then(() => {
    if (pendingZoom[viewKind] === zoom) {
      pendingZoom[viewKind] = null;
    }
  });
}

function applyUserZoomLive(root, viewKind, rawZoom, opts = {}) {
  let next = clampZoom(rawZoom);
  // 100% 근처에서는 자연스럽게 기본 배율(1.0)에 자석 스냅
  if (!opts.noSnap && Math.abs(next - 1) < 0.03) next = 1;
  pendingZoom[viewKind] = next;

  if (viewKind === 'seats') applySeatingFit(root);
  else applyListFit(root);
  updateZoomResetButton(root, viewKind, next);

  clearTimeout(zoomSaveTimers[viewKind]);
  if (opts.immediateSave) {
    persistUserZoom(viewKind, next);
  } else {
    zoomSaveTimers[viewKind] = setTimeout(() => persistUserZoom(viewKind, next), 180);
  }
}

function bindZoomInteractions(root, viewKind) {
  const scrollEl = root.querySelector(viewKind === 'seats' ? '#seating-canvas-scroll' : '#student-grid-scroll');
  if (!scrollEl) return;

  // Ctrl + 휠 (및 트랙패드 핀치 제스처) → 버튼 제외 카드 영역만 확대·축소
  scrollEl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const cur = getUserZoom(viewKind);
    const step = e.deltaY < 0 ? 0.1 : -0.1;
    const next = Math.round((cur + step) * 10) / 10;
    applyUserZoomLive(root, viewKind, next);
  }, { passive: false });

  // 터치스크린 2손가락 핀치투줌
  let pinchStartDist = 0;
  let pinchStartZoom = 1;
  scrollEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const [t1, t2] = e.touches;
      pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      pinchStartZoom = getUserZoom(viewKind);
    }
  }, { passive: true });

  scrollEl.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStartDist > 10) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const next = pinchStartZoom * (dist / pinchStartDist);
      applyUserZoomLive(root, viewKind, next, { noSnap: true });
    }
  }, { passive: false });

  scrollEl.addEventListener('touchend', (e) => {
    if (pinchStartDist > 0 && e.touches.length < 2) {
      pinchStartDist = 0;
      const cur = getUserZoom(viewKind);
      applyUserZoomLive(root, viewKind, cur, { immediateSave: true });
    }
  }, { passive: true });
}

function getEffectiveSubView(root) {
  const forced = root?.dataset?.forcedSubView;
  if (forced === 'list' || forced === 'seats') return forced;
  return subView;
}

function rerenderActiveStudentRoots(primaryRoot) {
  for (const r of Array.from(mountedStudentRoots)) {
    if (!r || !r.isConnected) {
      mountedStudentRoots.delete(r);
      continue;
    }
    const modeView = r.closest('.mode-view');
    if (modeView && !modeView.classList.contains('is-active')) continue;
    renderStudentsView(r);
  }
  if (primaryRoot && primaryRoot.isConnected && !mountedStudentRoots.has(primaryRoot)) {
    renderStudentsView(primaryRoot);
  }
}

/** 화면 크기/비율 변경 시 하단바 및 내부영역 UI 버튼들의 가로세로 비율을 유지한 채 비례 확대·축소 */
function applyStudentsUiScale(root) {
  const shellEl = root?.querySelector('.students-shell');
  if (!shellEl) return;
  const w = shellEl.clientWidth || window.innerWidth || 1280;
  const h = shellEl.clientHeight || window.innerHeight || 720;
  const scale = Math.max(0.45, Math.min(1.18, Math.min(w / 1280, h / 720)));
  shellEl.style.setProperty('--ui-scale', scale.toFixed(4));
}

window.addEventListener('resize', () => {
  cancelAnimationFrame(studentsResizeRaf);
  studentsResizeRaf = requestAnimationFrame(() => {
    for (const r of Array.from(mountedStudentRoots)) {
      if (!r || !r.isConnected) {
        mountedStudentRoots.delete(r);
        continue;
      }
      if (!r.closest('.mode-view')?.classList.contains('is-active')) continue;
      applyStudentsUiScale(r);
      if (getEffectiveSubView(r) === 'seats') applySeatingFit(r);
      else applyListFit(r);
    }
  });
});

window.addEventListener('class123:award-finished', (ev) => {
  const ids = ev.detail?.studentIds || [];
  if (ids.length === 0) return;
  celebratingIds = new Set(ids);
  celebratingType = ev.detail?.type === 'negative' ? 'negative' : 'positive';
  selectedIds = new Set(ids);
  clearTimeout(celebrateTimer);
  rerenderActiveStudentRoots(lastStudentsRoot);
  celebrateTimer = setTimeout(() => {
    celebratingIds.clear();
    celebratingType = null;
    selectedIds.clear();
    rerenderActiveStudentRoots(lastStudentsRoot);
  }, 1020);
});

export function setStudentsNavigator(fn) {
  navigateCallback = fn;
}

export function setStudentsSubView(view) {
  const next = view === 'seats' ? 'seats' : 'list';
  if (subView !== next) {
    subView = next;
    seatEditMode = false;
    ghostAddPos = null;
    swapSourceStudentId = null;
  }
}

export function getSelectedStudentIds() {
  return Array.from(selectedIds);
}

export function clearSelectedStudents() {
  selectedIds.clear();
}

/** 플로팅 패널 리사이즈 시 원본 학생목록/자리배치 비율 피팅 재계산 */
export function refitStudentsView(root) {
  if (!root) return;
  if (getEffectiveSubView(root) === 'seats') applySeatingFit(root);
  else applyListFit(root);
}

/** 풀-뷰포트 스테이지 스케일 반환 (CSS scale 제거로 1:1 좌표 사용) */
function getStageScale() {
  return 1;
}

/** 자리배치 캔버스 실제 화면 스케일 계산 (16:9 스테이지 스케일 x 자리배치 자동 축소 fitScale 통합) */
function getSeatingCanvasScale(canvasEl) {
  if (canvasEl) {
    const rect = canvasEl.getBoundingClientRect();
    const lw = canvasEl.offsetWidth;
    if (lw > 0 && rect.width > 0) {
      return rect.width / lw;
    }
  }
  return getStageScale();
}

/** 특정 사각형이 기존 모둠 박스들과 겹치는지 검사 */
function isBoxOverlapping(rect, boxes, pad = 10) {
  return boxes.some(
    (b) =>
      rect.x < b.x + b.w + pad &&
      rect.x + rect.w + pad > b.x &&
      rect.y < b.y + b.h + pad &&
      rect.y + rect.h + pad > b.y
  );
}

/** 4종 점수 표시 HTML (쑥쑥점수 / 으쓱점수 / 머쓱점수 / 으쓱+머쓱 2층) */
function renderScoreHtml(student, scoreMode) {
  const mode = scoreMode || 'net';
  if (mode === 'pos') {
    return `<span class="score-val is-pos">${student.positive}</span>`;
  }
  if (mode === 'neg') {
    return `<span class="score-val is-neg">${student.negative}</span>`;
  }
  if (mode === 'both') {
    return `
      <span class="score-dual">
        <span class="score-dual-pos">+${student.positive}</span>
        <span class="score-dual-neg">-${student.negative}</span>
      </span>
    `;
  }
  return `<span class="score-val is-net ${student.score < 0 ? 'is-neg' : ''}">${student.score}</span>`;
}

/** 모둠 합계 텍스트 (선택된 점수 표시 방식 연동) */
function renderGroupTotalHtml(members, scoreMode) {
  const mode = scoreMode || 'net';
  const sumPos = members.reduce((a, m) => a + m.positive, 0);
  const sumNeg = members.reduce((a, m) => a + m.negative, 0);
  const sumNet = members.reduce((a, m) => a + m.score, 0);
  if (mode === 'pos') return `<span style="color:#a9f57e;">${sumPos}</span>`;
  if (mode === 'neg') return `<span style="color:#ff9aa8;">${sumNeg}</span>`;
  if (mode === 'both') return `<span style="color:#a9f57e;">+${sumPos}</span> <span style="color:#ff9aa8;">-${sumNeg}</span>`;
  return `${sumNet}`;
}

/** 모둠 내 학생들의 seatIndex 맵 생성 (자동 정렬·압축 금지 — 중간 빈칸 그대로 유지) */
function buildGroupSeatMap(members) {
  const map = new Map();
  const sorted = [...members].sort((a, b) => (Number(a.seatIndex) || 0) - (Number(b.seatIndex) || 0));
  for (const st of sorted) {
    let idx = Math.max(0, Math.trunc(Number(st.seatIndex) || 0));
    while (map.has(idx)) idx++;
    map.set(idx, st);
  }
  return map;
}

/** 모둠 박스 실제 픽셀 크기 계산 (모둠 안 +버튼 없음, 보이지 않는 그리드 셀 기준 독립 크기) */
function measureGroupBox(group, members) {
  const seatMap = buildGroupSeatMap(members);
  const cols = Math.max(1, Number(group.cols) || (members.length <= 1 ? 1 : 2));
  const maxSeatIdx = seatMap.size > 0 ? Math.max(...seatMap.keys()) : 0;
  const minRows = Math.max(1, Math.ceil((maxSeatIdx + 1) / cols));
  const savedRows = Math.trunc(Number(group.rows) || 0);
  const rows = Math.max(minRows, savedRows || minRows);
  const totalSlots = rows * cols;
  const w = cols * SEAT_W + (cols - 1) * SEAT_GAP + GROUP_PAD_X;
  const h = rows * SEAT_H + (rows - 1) * SEAT_GAP + GROUP_PAD_Y + FOOTER_H;
  return { cols, rows, totalSlots, seatMap, w, h };
}

/** 모둠 좌표가 비어있으면 내부공간 기준 가운데 정렬 기본 배치 계산 */
function ensureGroupLayout(groups, activeStudents, stageWidth = 1496) {
  const sorted = [...groups].sort((a, b) => a.order - b.order);
  // 좌표가 비어있거나 2개 이상의 모둠이 동일 좌표로 포개진 비정상 상태면 자동 격자 복구
  let hasCollapsedOverlap = false;
  for (let i = 0; i < sorted.length && !hasCollapsedOverlap; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (Math.abs((sorted[i].x ?? 0) - (sorted[j].x ?? 0)) < 12 && Math.abs((sorted[i].y ?? 0) - (sorted[j].y ?? 0)) < 12) {
        hasCollapsedOverlap = true;
        break;
      }
    }
  }
  const needsInit = sorted.some((g) => !Number.isFinite(g.x) || !Number.isFinite(g.y)) || hasCollapsedOverlap;
  const boxes = [];

  if (needsInit) {
    const gridCols = sorted.length > 6 ? 4 : Math.min(3, Math.max(1, sorted.length));
    const colWidths = Array(gridCols).fill(0);
    const measured = sorted.map((g) => {
      const members = activeStudents.filter((s) => s.groupId === g.id);
      return { g, ...measureGroupBox(g, members) };
    });
    measured.forEach((m, idx) => {
      const c = idx % gridCols;
      colWidths[c] = Math.max(colWidths[c], m.w);
    });
    const totalRowW = colWidths.reduce((a, b) => a + b, 0) + (gridCols - 1) * GROUP_GAP_X;
    const startX = Math.max(CANVAS_PAD, Math.round((stageWidth - totalRowW) / 2));

    const colY = Array(gridCols).fill(CANVAS_PAD + 14);
    measured.forEach((m, idx) => {
      const c = idx % gridCols;
      let x = startX;
      for (let k = 0; k < c; k++) x += colWidths[k] + GROUP_GAP_X;
      const y = colY[c];
      colY[c] = y + m.h + GROUP_GAP_Y;
      boxes.push({ id: m.g.id, group: m.g, x, y, w: m.w, h: m.h, cols: m.cols, rows: m.rows, totalSlots: m.totalSlots, seatMap: m.seatMap });
    });
  } else {
    sorted.forEach((g) => {
      const members = activeStudents.filter((s) => s.groupId === g.id);
      const m = measureGroupBox(g, members);
      boxes.push({ id: g.id, group: g, x: Math.round(g.x), y: Math.round(g.y), ...m });
    });
  }

  return boxes;
}

/**
 * 독립 충돌 해소 (틈새 삽입 시 옆/아래 겹치는 모둠만 부드럽게 밀고, 비충돌 열/행 모둠은 그대로 유지)
 * axisHint: 'auto' | 'x' | 'y'
 */
function resolveBoxCollisions(boxes, anchorId, axisHint = 'auto') {
  const result = boxes.map((b) => ({ ...b }));
  const queue = [anchorId];
  const mx = GROUP_GAP_X;
  const my = GROUP_GAP_Y;

  for (let pass = 0; pass < 24 && queue.length > 0; pass++) {
    const curId = queue.shift();
    const a = result.find((b) => b.id === curId);
    if (!a) continue;

    for (const b of result) {
      if (b.id === a.id) continue;
      const overlapX = a.x < b.x + b.w + mx && a.x + a.w + mx > b.x;
      const overlapY = a.y < b.y + b.h + my && a.y + a.h + my > b.y;
      if (!overlapX || !overlapY) continue;

      const pushRight = (a.x + a.w + mx) - b.x;
      const pushLeft = (b.x + b.w + mx) - a.x;
      const pushDown = (a.y + a.h + my) - b.y;
      const pushUp = (b.y + b.h + my) - a.y;

      const acx = a.x + a.w / 2;
      const bcx = b.x + b.w / 2;
      const acy = a.y + a.h / 2;
      const bcy = b.y + b.h / 2;

      if (axisHint === 'y') {
        if (bcy >= acy || b.y - pushUp < CANVAS_PAD) b.y += pushDown;
        else b.y -= pushUp;
      } else if (axisHint === 'x') {
        if (bcx >= acx || b.x - pushLeft < CANVAS_PAD) b.x += pushRight;
        else b.x -= pushLeft;
      } else {
        // 틈새 삽입 방향 자동 판별: 가로로 끼어들었으면 가로 밀림, 세로로 겹쳤으면 세로 밀림
        const minX = bcx >= acx ? pushRight : (b.x - pushLeft >= CANVAS_PAD ? pushLeft : pushRight);
        const minY = bcy >= acy ? pushDown : (b.y - pushUp >= CANVAS_PAD ? pushUp : pushDown);
        if (minX <= minY * 1.15) {
          if (bcx >= acx || b.x - pushLeft < CANVAS_PAD) b.x += pushRight;
          else b.x -= pushLeft;
        } else {
          if (bcy >= acy || b.y - pushUp < CANVAS_PAD) b.y += pushDown;
          else b.y -= pushUp;
        }
      }

      b.x = Math.max(CANVAS_PAD, Math.round(b.x));
      b.y = Math.max(CANVAS_PAD, Math.round(b.y));
      if (!queue.includes(b.id)) queue.push(b.id);
    }
  }

  return result;
}

/** 모든 기존 모둠과 겹치지 않는 1명 크기 점선 '+' 새 모둠 카드 기본 좌표 계산 */
function computeDefaultGhostPos(boxes, stageWidth = 1506, stageHeight = 658) {
  if (boxes.length === 0) {
    return { x: Math.round((stageWidth - GHOST_W) / 2), y: CANVAS_PAD + 14 };
  }

  const candidates = [];
  const last = boxes[boxes.length - 1];
  // 1순위: 마지막 모둠의 우측 / 좌측
  candidates.push({ x: last.x + last.w + GROUP_GAP_X, y: last.y });
  candidates.push({ x: last.x - GHOST_W - GROUP_GAP_X, y: last.y });

  // 2순위: 각 모둠의 우측 / 좌측 / 하단 / 상단 인접 빈 슬롯
  for (const b of boxes) {
    candidates.push({ x: b.x + b.w + GROUP_GAP_X, y: b.y });
    candidates.push({ x: b.x - GHOST_W - GROUP_GAP_X, y: b.y });
    candidates.push({ x: b.x, y: b.y + b.h + GROUP_GAP_Y });
    candidates.push({ x: b.x, y: b.y - GHOST_H - GROUP_GAP_Y });
  }

  // 3순위: 화면 내부 격자 스캔
  const minX = Math.max(CANVAS_PAD, Math.min(...boxes.map((b) => b.x)));
  const minY = Math.max(CANVAS_PAD, Math.min(...boxes.map((b) => b.y)));
  for (let y = minY; y <= stageHeight - GHOST_H - CANVAS_PAD; y += 60) {
    for (let x = minX; x <= stageWidth - GHOST_W - CANVAS_PAD; x += 80) {
      candidates.push({ x, y });
    }
  }
  for (let y = CANVAS_PAD; y <= stageHeight - GHOST_H - CANVAS_PAD; y += 60) {
    for (let x = CANVAS_PAD; x <= stageWidth - GHOST_W - CANVAS_PAD; x += 80) {
      candidates.push({ x, y });
    }
  }

  // 가시 영역 안에 들어가면서 어떤 모둠과도 겹치지 않는 첫 후보 선택
  for (const c of candidates) {
    const rx = Math.round(c.x);
    const ry = Math.round(c.y);
    if (
      rx >= CANVAS_PAD &&
      rx + GHOST_W <= stageWidth - CANVAS_PAD &&
      ry >= CANVAS_PAD &&
      ry + GHOST_H <= stageHeight - CANVAS_PAD &&
      !isBoxOverlapping({ x: rx, y: ry, w: GHOST_W, h: GHOST_H }, boxes, 10)
    ) {
      return { x: rx, y: ry };
    }
  }

  // 화면이 모둠으로 가득 찼을 경우: 비충돌 확장 위치 반환 (자동 비율 축소로 화면 내에 표시됨)
  for (const c of candidates) {
    const rx = Math.round(c.x);
    const ry = Math.round(c.y);
    if (
      rx >= CANVAS_PAD &&
      ry >= CANVAS_PAD &&
      !isBoxOverlapping({ x: rx, y: ry, w: GHOST_W, h: GHOST_H }, boxes, 10)
    ) {
      return { x: rx, y: ry };
    }
  }

  const maxBottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: minX, y: Math.round(maxBottom + GROUP_GAP_Y) };
}

/** 내부영역(scrollEl) 위에 떠 있는 모든 UI 버튼들의 상대 좌표 사각형 수집 */
function collectUiObstacleRects(root, scrollEl, pad = 6) {
  const sr = scrollEl.getBoundingClientRect();
  if (!sr.width || !sr.height) return [];
  const selectors = [
    '.st-top-class-btn',
    '.st-top-options',
    '.seat-edit-left-group',
    '.seat-flip-pill',
    '.seat-pick-btn-group',
  ];
  const rects = [];
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (!el || el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    rects.push({
      x1: r.left - sr.left - pad,
      y1: r.top - sr.top - pad,
      x2: r.right - sr.left + pad,
      y2: r.bottom - sr.top + pad,
    });
  }
  return rects;
}

function rectsOverlap(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

/** 고정 원점(0,0) 기준 + UI 버튼과 겹칠 때만 화면 중앙 기준으로 자동 축소 (안 겹치는 빈공간은 그대로 유지) */
function applySeatingFit(root) {
  const scrollEl = root?.querySelector('#seating-canvas-scroll');
  const fitEl = root?.querySelector('#seating-canvas-fit');
  const canvasEl = root?.querySelector('#seating-canvas');
  if (!scrollEl || !fitEl || !canvasEl) return;

  const viewW = scrollEl.clientWidth || 1506;
  const viewH = scrollEl.clientHeight || 740;

  // 모둠 박스만 기준으로 캔버스 크기와 축소 배율을 계산해 일반·편집 모드 간 위치/크기를 100% 동일하게 유지
  const groupItems = Array.from(canvasEl.querySelectorAll('[data-group-box]'));
  const allItems = Array.from(canvasEl.querySelectorAll('[data-group-box], #group-ghost-add'));
  const measureItems = groupItems.length > 0 ? groupItems : allItems;

  if (measureItems.length === 0) {
    canvasEl.style.width = `${viewW}px`;
    canvasEl.style.height = `${viewH}px`;
    fitEl.style.width = `${viewW}px`;
    fitEl.style.height = `${viewH}px`;
    fitEl.style.left = '0px';
    fitEl.style.top = '0px';
    fitEl.style.transform = 'none';
    return;
  }

  let maxRight = 0;
  let maxBottom = 0;
  const itemBoxes = measureItems.map((el) => {
    const x = el.offsetLeft;
    const y = el.offsetTop;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (x + w > maxRight) maxRight = x + w;
    if (y + h > maxBottom) maxBottom = y + h;
    return { x, y, w, h };
  });

  // 1) 고정 원점(0,0) 기준 기본 배율 (화면 밖 초과 시에만 축소)
  const contentW = Math.max(viewW, Math.ceil(maxRight + CANVAS_PAD));
  const contentH = Math.max(viewH, Math.ceil(maxBottom + CANVAS_PAD));
  const rawFitScale = Math.min(1, viewW / contentW, viewH / contentH);

  // 2) 내부영역에 떠 있는 UI 버튼들과 겹치는지 검사
  //    - 안 겹치면 그대로 (safeK=1, ox=0, oy=0)
  //    - 겹치면 먼저 원점(0,0) 고정 축소를 시도해 상단/좌측 빈 공간(버튼 같은 줄)에 데드존이 생기지 않게 함
  //    - 좌상단 버튼과 직접 겹쳐 원점 축소만으로 해소되지 않을 때만 화면 중앙 기준 축소 사용
  const uiRects = collectUiObstacleRects(root, scrollEl, 4);
  const cx = viewW / 2;
  const cy = viewH / 2;
  const overlapsUiAt = (k, centerPivot) => {
    const s = rawFitScale * k;
    const ox = centerPivot ? cx * (1 - k) : 0;
    const oy = centerPivot ? cy * (1 - k) : 0;
    for (const m of itemBoxes) {
      const boxRect = {
        x1: ox + m.x * s,
        y1: oy + m.y * s,
        x2: ox + (m.x + m.w) * s,
        y2: oy + (m.y + m.h) * s,
      };
      for (const ui of uiRects) {
        if (rectsOverlap(boxRect, ui)) return true;
      }
    }
    return false;
  };

  let safeK = 1;
  let useCenterPivot = false;
  if (uiRects.length > 0 && overlapsUiAt(1, false)) {
    // 1순위: 원점(0,0) 고정 축소로 해결 가능한지 검사 (상단·좌측 데드존 0px!)
    if (!overlapsUiAt(0.25, false)) {
      let lo = 0.25;
      let hi = 1;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (overlapsUiAt(mid, false)) hi = mid;
        else lo = mid;
      }
      safeK = lo;
      useCenterPivot = false;
    } else {
      // 2순위: 좌상단 버튼과 직접 겹쳐 원점 축소로 해소 불가 시에만 중앙 기준 축소
      let lo = 0.25;
      let hi = 1;
      for (let i = 0; i < 16; i++) {
        const mid = (lo + hi) / 2;
        if (overlapsUiAt(mid, true)) hi = mid;
        else lo = mid;
      }
      safeK = lo;
      useCenterPivot = true;
    }
  }

  const baseFitScale = rawFitScale * safeK;
  const baseOx = useCenterPivot ? Math.round(cx * (1 - safeK)) : 0;
  const baseOy = useCenterPivot ? Math.round(cy * (1 - safeK)) : 0;

  const userZoom = getUserZoom('seats');
  const fitScale = baseFitScale * userZoom;

  let canvasMaxR = contentW;
  let canvasMaxB = contentH;
  allItems.forEach((el) => {
    canvasMaxR = Math.max(canvasMaxR, Math.ceil(el.offsetLeft + el.offsetWidth + CANVAS_PAD));
    canvasMaxB = Math.max(canvasMaxB, Math.ceil(el.offsetTop + el.offsetHeight + CANVAS_PAD));
  });
  const virtualW = Math.max(canvasMaxR, Math.round(viewW / rawFitScale));
  const virtualH = Math.max(canvasMaxB, Math.round(viewH / rawFitScale));

  canvasEl.style.width = `${virtualW}px`;
  canvasEl.style.height = `${virtualH}px`;
  fitEl.style.width = `${virtualW}px`;
  fitEl.style.height = `${virtualH}px`;

  const isUserZoomed = Math.abs(userZoom - 1) > 0.005;
  const offsetX = isUserZoomed ? 0 : baseOx;
  const offsetY = isUserZoomed ? 0 : baseOy;
  const scaledW = virtualW * fitScale;
  const scaledH = virtualH * fitScale;
  const needsScroll = isUserZoomed && (scaledW > viewW + 1 || scaledH > viewH + 1);
  scrollEl.classList.toggle('is-zoomed', needsScroll);

  fitEl.style.left = `${offsetX}px`;
  fitEl.style.top = `${offsetY}px`;
  fitEl.style.transform = Math.abs(fitScale - 1) > 0.001 ? `scale(${fitScale.toFixed(5)})` : 'none';
  fitEl.style.marginRight = needsScroll ? `${Math.max(0, Math.ceil(scaledW - virtualW))}px` : '0px';
  fitEl.style.marginBottom = needsScroll ? `${Math.max(0, Math.ceil(scaledH - virtualH))}px` : '0px';

  // 전체 내부영역 정중앙을 회전축으로 설정
  const rotatorEl = root?.querySelector('#seating-rotator');
  if (rotatorEl) {
    rotatorEl.style.transformOrigin = '50% 50%';
  }
}

export function renderStudentsView(root) {
  if (!root) return;
  if (!root.dataset?.forcedSubView) {
    lastStudentsRoot = root;
  }
  mountedStudentRoots.add(root);
  const viewKind = getEffectiveSubView(root);
  const state = store.getState();
  const activeStudents = state.students.filter((s) => !s.trashed);
  const prefs = state.uiPrefs;
  const scoreMode = prefs.scoreDisplayMode || 'net';

  for (const id of Array.from(selectedIds)) {
    if (!activeStudents.some((s) => s.id === id)) selectedIds.delete(id);
  }

  const sortedStudents = [...activeStudents].sort((a, b) => {
    if (prefs.sortBy === 'name') return a.name.localeCompare(b.name, 'ko');
    if (prefs.sortBy === 'score-desc') return b.score - a.score || a.number - b.number;
    if (prefs.sortBy === 'score-asc') return a.score - b.score || a.number - b.number;
    return a.number - b.number;
  });

  const starsPerEgg = Math.max(5, Number(state.classInfo.starsPerEgg) || 10);
  const filledStars = state.growth.pendingTrail.length;

  const hideAvatarsClass = viewKind === 'list' ? (prefs.showAvatars ? '' : 'hide-avatars') : '';
  const hasSelection = selectedIds.size > 0;
  const selectableStudents = activeStudents.filter((s) => !s.absent);
  const allSelected = selectableStudents.length > 0 && selectableStudents.every((s) => selectedIds.has(s.id));
  const selectedNames = sortedStudents.filter((s) => selectedIds.has(s.id)).map((s) => s.name);
  const selectedNamesSummary = selectedNames.length > 4
    ? `${selectedNames.slice(0, 4).join(', ')} 외 ${selectedNames.length - 4}명`
    : selectedNames.join(', ');

  const isAvatarShown = viewKind === 'seats' ? Boolean(prefs.seatShowAvatars) : prefs.showAvatars !== false;
  const curZoom = getUserZoom(viewKind, state);
  const isDefaultZoom = Math.abs(curZoom - 1) < 0.005;

  // 최상단 바 없이 내부영역 좌상단·우상단에 띄우는 플로팅 패널 HTML
  const topFloatingHtml = `
    <div class="students-floating-top">
      <button type="button" class="st-top-class-btn" data-open-class-cfg title="학급 설정 열기">
        <span class="st-top-class-dot"></span>
        <span>${escapeHtml(state.classInfo.name || '우리 반')}</span>
      </button>
      <div class="st-top-options">
        <button type="button" class="st-zoom-reset-btn" data-zoom-reset="${viewKind}" title="기본 배율(100%)로 되돌리기" ${isDefaultZoom ? 'hidden' : ''}>
          ${Math.round(curZoom * 100)}% · 원래대로
        </button>
        <label class="st-top-check">
          <input type="checkbox" data-top-opt="numbers" ${prefs.showNumbers !== false ? 'checked' : ''}>
          <span>번호 표시</span>
        </label>
        <label class="st-top-check">
          <input type="checkbox" data-top-opt="avatars" ${isAvatarShown ? 'checked' : ''}>
          <span>아바타 표시</span>
        </label>
        <select class="st-top-select" data-top-opt="scoreMode" title="점수 표시 방식">
          <option value="net" ${scoreMode === 'net' ? 'selected' : ''}>쑥쑥점수</option>
          <option value="pos" ${scoreMode === 'pos' ? 'selected' : ''}>으쓱점수</option>
          <option value="neg" ${scoreMode === 'neg' ? 'selected' : ''}>머쓱점수</option>
          <option value="both" ${scoreMode === 'both' ? 'selected' : ''}>으쓱+머쓱</option>
        </select>
        ${viewKind === 'list' ? `
          <select class="st-top-select" data-top-opt="sortBy" title="학생 정렬">
            <option value="number" ${(prefs.sortBy || 'number') === 'number' ? 'selected' : ''}>번호순</option>
            <option value="name" ${prefs.sortBy === 'name' ? 'selected' : ''}>이름순</option>
            <option value="score-desc" ${prefs.sortBy === 'score-desc' ? 'selected' : ''}>점수 높은순</option>
            <option value="score-asc" ${prefs.sortBy === 'score-asc' ? 'selected' : ''}>점수 낮은순</option>
          </select>
        ` : ''}
      </div>
    </div>
  `;

  root.innerHTML = `
    <div class="students-shell ${prefs.showNumbers ? '' : 'hide-numbers'} ${hideAvatarsClass}">
      ${attendanceMode ? `
        <div class="seat-edit-banner" style="margin-top:8px;border-radius:6px;">
          <span>📋 <strong>출석체크 모드</strong> — 학생을 클릭하면 출석/결석 상태가 전환됩니다. (결석 학생은 뽑기·전체선택에서 제외)</span>
          <button type="button" class="btn-yellow" id="btn-end-attend" style="padding:4px 12px;font-size:12px;">출석체크 완료</button>
        </div>
      ` : ''}

      ${viewKind === 'list'
        ? renderListBody(sortedStudents, scoreMode, topFloatingHtml)
        : renderSeatingBody(state, activeStudents, scoreMode, root, topFloatingHtml)}

      <div class="students-bottombar ${hasSelection ? 'is-selecting' : ''}">
        <div class="students-bottombar-inner">
          <div class="bottom-left-slot">
          <button type="button" class="mini-egg-progress" id="btn-goto-growth" title="학급점수 화면으로 이동">
            <div class="mini-egg-top">
              <i class="sp-icon sp-egg-bottom" aria-hidden="true"></i>
              <span class="mini-egg-count">${state.growth.eggs}</span>
            </div>
            <div class="mini-stars-row">
              ${Array.from({ length: starsPerEgg }, (_, i) => `<i class="sp-mini-star ${i < filledStars ? 'is-filled' : ''}" aria-hidden="true"></i>`).join('')}
              <span class="mini-star-ratio">${filledStars}/${starsPerEgg}</span>
            </div>
          </button>
        </div>

        <div class="bottom-center-tools">
          ${hasSelection ? `
            <button type="button" class="text-action-btn is-cancel-slot" id="btn-select-clear">
              <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="#8b4a00" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M2.2 2.2 9.8 9.8M9.8 2.2 2.2 9.8"/></svg> 선택취소
            </button>
            <button type="button" class="text-action-btn is-invert-slot" id="btn-select-invert">
              <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h11l-3-3"/><path d="M16 13H5l3 3"/></svg>
              <span>선택 반전</span>
            </button>
            <span class="selected-pill">${selectedIds.size}명 선택됨</span>
            <span class="selected-names-summary" title="${escapeAttr(selectedNames.join(', '))}">${escapeHtml(selectedNamesSummary)}</span>
          ` : `
            <button type="button" class="text-action-btn" id="btn-select-all">
              <i class="sp-icon sp-all-select" aria-hidden="true"></i> 전체선택
            </button>
            <button type="button" class="text-action-btn" id="btn-select-recent" ${lastSelectedIds.length === 0 ? 'disabled' : ''}>
              <i class="sp-icon sp-recent-dots" aria-hidden="true"></i> 최근 선택한 학생
            </button>
          `}
        </div>

        <div class="bottom-right-slot">
          ${hasSelection ? `
            <div class="award-btn-group">
              <button type="button" class="btn-award-pill" id="btn-award-plus">
                <i class="sp-icon sp-star-blue" style="transform:scale(0.84);" aria-hidden="true"></i> 으쓱
              </button>
              <button type="button" class="btn-penalty-pill" id="btn-award-minus">
                <i class="sp-icon sp-cloud-red" style="transform:scale(0.84);" aria-hidden="true"></i> 머쓱
              </button>
            </div>
          ` : `
            <div class="bottom-right-tools">
              <button type="button" class="text-action-btn" id="btn-open-history">
                <i class="sp-icon sp-history-list" aria-hidden="true"></i> 이력관리
              </button>
              <button type="button" class="attend-btn ${attendanceMode ? 'is-active' : ''}" id="btn-toggle-attend">
                <i class="sp-icon sp-attend-badge" aria-hidden="true"></i>
                <span>출석체크</span>
              </button>
              <div class="bottom-mini-stack">
                <button type="button" class="bottom-mini-link" id="btn-reset-scores">
                  <i class="sp-icon sp-reset-arrow" aria-hidden="true"></i> 점수초기화
                </button>
                <button type="button" class="bottom-mini-link" id="btn-manage-students">
                  <i class="sp-icon sp-gear-mini" aria-hidden="true"></i> 학생설정
                </button>
              </div>
            </div>
          `}
        </div>
        </div>
      </div>
    </div>
  `;

  bindStudentsEvents(root, state, activeStudents);
  applyStudentsUiScale(root);
  if (viewKind === 'seats') {
    applySeatingFit(root);
  } else {
    applyListFit(root);
  }
}

/** 학생목록 화면: 공간이 남으면 화면에 꽉 차 보이도록 확대하고, 공간을 넘어가면 비율을 유지해 축소 */
function applyListFit(root) {
  const scrollEl = root?.querySelector('#student-grid-scroll');
  const fitEl = root?.querySelector('#student-grid-fit');
  const gridEl = root?.querySelector('#student-card-grid');
  if (!scrollEl || !fitEl || !gridEl) return;

  const viewW = scrollEl.clientWidth || Math.max(800, window.innerWidth - 96);
  const viewH = scrollEl.clientHeight || Math.max(460, window.innerHeight - 130);
  const padX = 16;
  const padY = 14;
  const availW = Math.max(320, viewW - padX * 2);
  const availH = Math.max(220, viewH - padY * 2);

  const cards = gridEl.children.length || 1;
  const cardW = 168;
  const cardH = 126;
  const gapX = 14;
  const gapY = 18;
  const maxScale = 1.55;

  // 공간이 남을 때는 카드가 가장 크게(화면이 꽉 차 보이게) 되는 열 수(4~8열, 33명 이상 최대 10열)를 선택하고, 초과 시 비율 유지 축소
  let bestCols = 8;
  let bestScale = 0;
  const minCols = cards <= 6 ? Math.max(2, cards) : 4;
  const maxCols = cards > 32 ? 10 : 8;
  for (let c = minCols; c <= maxCols; c++) {
    const rows = Math.ceil(cards / c);
    const w = c * cardW + (c - 1) * gapX;
    const h = rows * cardH + (rows - 1) * gapY;
    const scale = Math.min(maxScale, availW / w, availH / h);
    if (scale >= bestScale) {
      bestScale = scale;
      bestCols = c;
    }
  }

  gridEl.style.gridTemplateColumns = `repeat(${bestCols}, ${cardW}px)`;
  gridEl.style.gap = `${gapY}px ${gapX}px`;

  const gridW = gridEl.offsetWidth || (bestCols * cardW + (bestCols - 1) * gapX);
  const gridH = gridEl.offsetHeight || (Math.ceil(cards / bestCols) * cardH + (Math.ceil(cards / bestCols) - 1) * gapY);
  let baseFitScale = Math.min(maxScale, availW / gridW, availH / gridH);

  // 상단 플로팅 패널(우리반/옵션)과 학생 카드가 겹치면 안 겹치는 최대 배율로 자동 축소
  const uiRects = collectUiObstacleRects(root, scrollEl, 6);
  const cardBoxes = Array.from(gridEl.children).map((el) => ({
    x: el.offsetLeft,
    y: el.offsetTop,
    w: el.offsetWidth,
    h: el.offsetHeight,
  }));
  const listOverlapsUi = (scale) => {
    const ox = Math.round((viewW - gridW * scale) / 2);
    const oy = Math.round((viewH - gridH * scale) / 2);
    for (const c of cardBoxes) {
      const r = {
        x1: ox + c.x * scale,
        y1: oy + c.y * scale,
        x2: ox + (c.x + c.w) * scale,
        y2: oy + (c.y + c.h) * scale,
      };
      for (const ui of uiRects) {
        if (rectsOverlap(r, ui)) return true;
      }
    }
    return false;
  };
  if (uiRects.length > 0 && listOverlapsUi(baseFitScale)) {
    let lo = 0.25;
    let hi = baseFitScale;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (listOverlapsUi(mid)) hi = mid;
      else lo = mid;
    }
    baseFitScale = lo;
  }

  const userZoom = getUserZoom('list');
  const fitScale = baseFitScale * userZoom;

  fitEl.style.width = `${gridW}px`;
  fitEl.style.height = `${gridH}px`;

  const scaledW = gridW * fitScale;
  const scaledH = gridH * fitScale;
  const isUserZoomed = Math.abs(userZoom - 1) > 0.005;
  const needsScroll = isUserZoomed && (scaledW > viewW - padX || scaledH > viewH - padY);
  scrollEl.classList.toggle('is-zoomed', needsScroll);

  const offsetX = needsScroll && scaledW > viewW - padX * 2 ? padX : Math.round((viewW - scaledW) / 2);
  const offsetY = needsScroll && scaledH > viewH - padY * 2 ? padY : Math.round((viewH - scaledH) / 2);

  fitEl.style.left = `${offsetX}px`;
  fitEl.style.top = `${offsetY}px`;
  fitEl.style.transform = Math.abs(fitScale - 1) > 0.001 ? `scale(${fitScale.toFixed(5)})` : 'none';
  fitEl.style.marginRight = needsScroll ? `${Math.max(0, Math.ceil(scaledW - gridW + padX))}px` : '0px';
  fitEl.style.marginBottom = needsScroll ? `${Math.max(0, Math.ceil(scaledH - gridH + padY))}px` : '0px';
}

/** 학생목록: 4:3 비율 둥근 카드 (좌측 아바타 / 우상단 3자리 고정우측정렬 점수 / 우하단 선명한 출석번호+이름) */
function renderListBody(sortedStudents, scoreMode, topFloatingHtml = '') {
  return `
    <div class="student-grid-stage">
      <div class="student-grid-scroll" id="student-grid-scroll">
        <div class="student-grid-fit" id="student-grid-fit">
          <div class="student-card-grid" id="student-card-grid">
            ${sortedStudents.map((s) => {
              const isCeleb = celebratingIds.has(s.id);
              const showPose = isCeleb && celebratingType === 'positive';
              return `
                <div class="student-card ${selectedIds.has(s.id) ? 'is-selected' : ''} ${s.absent ? 'is-absent' : ''} ${isCeleb ? 'is-celebrating' : ''}" data-student-card="${s.id}" role="button" tabindex="0">
                  <div class="card-avatar-wrap">
                    ${showPose
                      ? `<div class="avatar-fx-sprite is-finite" style="background-image:url('${getFxAvatarUrl(s.avatarId)}')"></div>`
                      : `<img src="${getStillAvatarUrl(s.avatarId)}" alt="${escapeAttr(s.name)}" loading="lazy">`
                    }
                  </div>
                  <div class="card-score-cell">
                    ${renderScoreHtml(s, scoreMode)}
                  </div>
                  <div class="card-name-row">
                    <span class="card-num">${s.number}</span><span class="card-name-txt">${escapeHtml(s.name)}</span>
                  </div>
                </div>
              `;
            }).join('')}
            <button type="button" class="student-add-card" id="btn-add-student-card">
              <span class="student-add-plus">+</span>
              <span>학생추가</span>
            </button>
          </div>
        </div>
      </div>
      ${topFloatingHtml}
    </div>
  `;
}

/** 자유형 자리배치 본문 (원본 내부공간 + 편집모드 어두운 배경 + 16:9 학생카드 + 180도 일체형 상하반전 + 자동 비율축소) */
function renderSeatingBody(state, activeStudents, scoreMode, root, topFloatingHtml = '') {
  const showAvatars = Boolean(state.uiPrefs.seatShowAvatars);
  const isReversed = Boolean(state.uiPrefs.seatingReversed);
  const isRotatingNow = seatingFlipping && seatingFlipTargetRoot === root;
  const curScroll = root?.querySelector('#seating-canvas-scroll') || lastStudentsRoot?.querySelector('#seating-canvas-scroll');
  const stageW = curScroll?.clientWidth || root?.querySelector('.students-shell')?.clientWidth || Math.max(800, window.innerWidth - 100);
  const stageH = curScroll?.clientHeight || Math.max(460, window.innerHeight - 200);
  const displayBoxes = ensureGroupLayout(state.groups, activeStudents, stageW);

  if (
    seatEditMode &&
    (!ghostAddPos || isBoxOverlapping({ x: ghostAddPos.x, y: ghostAddPos.y, w: GHOST_W, h: GHOST_H }, displayBoxes, 6))
  ) {
    ghostAddPos = computeDefaultGhostPos(displayBoxes, stageW, stageH);
  }
  const unassigned = activeStudents.filter((s) => !s.groupId || !state.groups.some((g) => g.id === s.groupId));
  const contentMaxX = Math.max(
    0,
    ...displayBoxes.map((b) => b.x + b.w),
    seatEditMode && ghostAddPos ? ghostAddPos.x + GHOST_W : 0
  );
  const contentMaxY = Math.max(
    0,
    ...displayBoxes.map((b) => b.y + b.h),
    seatEditMode && ghostAddPos ? ghostAddPos.y + GHOST_H : 0
  );
  const canvasW = Math.ceil(contentMaxX + CANVAS_PAD);
  const canvasH = Math.ceil(contentMaxY + CANVAS_PAD);

  return `
    <div class="seating-stage ${seatEditMode ? 'is-editing' : ''}">
      <div class="seating-viewport-body" id="seating-viewport-body">
        ${topFloatingHtml}
        <div class="seating-rotator ${isRotatingNow ? 'is-rotating-board' : ''}" id="seating-rotator">
          <div class="seating-canvas-scroll" id="seating-canvas-scroll">
            <div class="seating-canvas-fit" id="seating-canvas-fit">
              <div class="seating-canvas" id="seating-canvas" style="width:${canvasW}px;height:${canvasH}px;">
                ${displayBoxes.map((box) => {
                  const g = box.group;
                  const members = activeStudents.filter((s) => s.groupId === g.id);
                  const selectableMembers = members.filter((m) => !m.absent);
                  const orderedSlots = Array.from({ length: box.totalSlots }, (_, i) => i);
                  const allInGroupSelected = selectableMembers.length > 0 && selectableMembers.every((m) => selectedIds.has(m.id));

                  return `
                    <div class="group-box ${allInGroupSelected ? 'is-group-selected' : ''} ${seatEditMode ? 'is-editable' : ''}"
                         data-group-box="${g.id}"
                         style="left:${box.x}px;top:${box.y}px;width:${box.w}px;">
                      <div class="group-seats" style="grid-template-columns:repeat(${box.cols}, ${SEAT_W}px);">
                        ${orderedSlots.map((slotIdx) => {
                          const st = box.seatMap.get(slotIdx);
                          if (!st) {
                            return `<div class="seat-cell-empty ${seatEditMode && swapSourceStudentId ? 'is-swap-ready' : ''}" data-empty-seat-group="${g.id}" data-empty-seat-index="${slotIdx}"></div>`;
                          }
                          const isCeleb = celebratingIds.has(st.id);
                          const showPose = isCeleb && celebratingType === 'positive';
                          const hasAv = showAvatars || showPose;
                          const isSwapSrc = seatEditMode && swapSourceStudentId === st.id;
                          return `
                            <div class="seat-slot ${selectedIds.has(st.id) ? 'is-selected' : ''} ${st.absent ? 'is-absent' : ''} ${isCeleb ? 'is-celebrating' : ''} ${hasAv ? 'has-avatar' : ''} ${seatEditMode ? 'is-edit-draggable' : ''} ${isSwapSrc ? 'is-swap-source' : ''}"
                                 data-seat-student="${st.id}"
                                 data-seat-group="${g.id}"
                                 data-seat-index="${slotIdx}">
                              <div class="seat-num-bar">${st.number}</div>
                              ${isSwapSrc ? `<span class="seat-swap-badge">교환 선택</span>` : ''}
                              ${showPose
                                ? `<div class="seat-avatar-wrap"><div class="avatar-fx-sprite is-finite seat-avatar-fx" style="background-image:url('${getFxAvatarUrl(st.avatarId)}')"></div></div>`
                                : (showAvatars ? `<div class="seat-avatar-wrap"><img class="seat-avatar" src="${getStillAvatarUrl(st.avatarId)}" alt=""></div>` : '')
                              }
                              <div class="seat-info">
                                <span class="seat-name">${escapeHtml(st.name)}</span>
                                <span class="seat-score">${renderScoreHtml(st, scoreMode)}</span>
                              </div>
                              ${seatEditMode ? `<button type="button" class="seat-unassign-btn" data-unassign-student="${st.id}" title="미배치로 빼기">&times;</button>` : ''}
                            </div>
                          `;
                        }).join('')}
                      </div>

                      <div class="group-footer" data-group-drag-handle="${g.id}">
                        ${seatEditMode ? `
                          <input type="text" class="group-name-inline-input" data-inline-rename-group="${g.id}" value="${escapeAttr(g.name)}" maxlength="24" title="클릭하여 모둠 이름 바로 수정" aria-label="모둠 이름">
                          <div class="group-edit-actions">
                            <button type="button" class="group-mini-btn" data-delete-group="${g.id}">삭제</button>
                          </div>
                        ` : `
                          <button type="button" class="group-name-btn" data-select-group="${g.id}" title="클릭하면 모둠원 전체 선택">${escapeHtml(g.name)}</button>
                          <span class="group-total">
                            ${renderGroupTotalHtml(members, scoreMode)}
                            <i class="sp-icon sp-sprout-mini" aria-hidden="true"></i>
                          </span>
                        `}
                      </div>
                      ${seatEditMode ? `
                        <div class="group-resize-handle" data-resize-group="${g.id}" data-resize-dir="e" title="오른쪽 테두리 드래그 (가로 1칸 단위)"></div>
                        <div class="group-resize-handle" data-resize-group="${g.id}" data-resize-dir="w" title="왼쪽 테두리 드래그 (가로 1칸 단위)"></div>
                        <div class="group-resize-handle" data-resize-group="${g.id}" data-resize-dir="s" title="아래쪽 테두리 드래그 (세로 1칸 단위)"></div>
                        <div class="group-resize-handle" data-resize-group="${g.id}" data-resize-dir="n" title="위쪽 테두리 드래그 (세로 1칸 단위)"></div>
                        <div class="group-resize-handle" data-resize-group="${g.id}" data-resize-dir="se" title="모서리 드래그 (가로·세로 1칸 단위)"></div>
                        <div class="group-resize-handle" data-resize-group="${g.id}" data-resize-dir="sw" title="모서리 드래그 (가로·세로 1칸 단위)"></div>
                        <div class="group-resize-handle" data-resize-group="${g.id}" data-resize-dir="ne" title="모서리 드래그 (가로·세로 1칸 단위)"></div>
                        <div class="group-resize-handle" data-resize-group="${g.id}" data-resize-dir="nw" title="모서리 드래그 (가로·세로 1칸 단위)"></div>
                      ` : ''}
                    </div>
                  `;
                }).join('')}

                <!-- 편집 모드 전용: 1명 크기 반투명 점선 '+' 새 모둠(학생 추가) 카드 (드래그 이동 가능, 편집완료 시 숨김) -->
                ${seatEditMode && ghostAddPos ? `
                  <div class="group-ghost-add" id="group-ghost-add"
                       style="left:${ghostAddPos.x}px;top:${ghostAddPos.y}px;"
                       title="클릭하여 새 모둠·학생 추가 · 드래그하여 위치 이동 · 학생을 여기로 끌어다 새 모둠 생성">
                    <span class="group-ghost-plus">+</span>
                    <span class="group-ghost-label">${unassigned.length > 0 ? `새 모둠 / 미배치(${unassigned.length})` : '새 모둠 추가'}</span>
                  </div>
                ` : ''}
              </div>
            </div>
          </div>

          <button type="button"
                  class="seat-flip-pill ${isReversed ? 'is-pos-top' : 'is-pos-bottom'}"
                  id="btn-flip-seating"
                  title="${isReversed ? '교실 뒤쪽 시점 — 클릭하면 교사 시점(아래)으로 상하반전' : '교실 앞쪽(교사) 시점 — 클릭하면 교실 뒤쪽 시점(위)으로 상하반전'}">
            <i class="sp-icon sp-seat-flip-icon" aria-hidden="true"></i>
            <span>상하반전(교탁)</span>
          </button>
        </div>

        <!-- 좌·우 고정 하단 도구 배치 (자리배치수정 · 그룹 뽑기 · 개인 뽑기, 일반·편집 모드 동일 위치) -->
        <div class="seating-floating-bar">
          <div class="seat-edit-left-group">
            <button type="button" class="seat-edit-origin-btn ${seatEditMode ? 'is-active' : ''}" id="btn-toggle-seat-edit">
              <span class="seat-edit-circle">
                <i class="sp-icon sp-grid" aria-hidden="true"></i>
              </span>
              <span>${seatEditMode ? '편집 완료' : '자리편집'}</span>
            </button>
            ${seatEditMode ? `
              <button type="button" class="seat-edit-sub-btn" id="btn-seat-add-group">+ 새 모둠${unassigned.length > 0 ? ` (${unassigned.length})` : ''}</button>
              <button type="button" class="seat-edit-sub-btn" id="btn-seat-recenter">가운데 정렬</button>
            ` : ''}
          </div>
          <div class="seat-pick-btn-group">
            <button type="button" class="seat-group-pick-card" id="btn-quick-group-pick" ${seatEditMode ? 'disabled' : ''}>
              <i class="sp-icon sp-clover-brown" aria-hidden="true"></i> 그룹 뽑기
            </button>
            <button type="button" class="seat-group-pick-card" id="btn-quick-student-pick" ${seatEditMode ? 'disabled' : ''}>
              <i class="sp-icon sp-clover-green-mini" aria-hidden="true"></i> 개인 뽑기
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bindStudentsEvents(root, state, activeStudents) {
  const viewKind = getEffectiveSubView(root);

  // 상단 소형 표시 옵션 바 이벤트
  const classCfgBtn = root.querySelector('[data-open-class-cfg]');
  if (classCfgBtn) {
    classCfgBtn.onclick = () => window.dispatchEvent(new CustomEvent('class123:open-class-settings'));
  }
  const optNum = root.querySelector('[data-top-opt="numbers"]');
  if (optNum) {
    optNum.onchange = () => store.update((s) => { s.uiPrefs.showNumbers = optNum.checked; });
  }
  const optAva = root.querySelector('[data-top-opt="avatars"]');
  if (optAva) {
    optAva.onchange = () => store.update((s) => {
      if (viewKind === 'seats') s.uiPrefs.seatShowAvatars = optAva.checked;
      else s.uiPrefs.showAvatars = optAva.checked;
    });
  }
  const optScore = root.querySelector('[data-top-opt="scoreMode"]');
  if (optScore) {
    optScore.onchange = () => store.update((s) => { s.uiPrefs.scoreDisplayMode = optScore.value; });
  }
  const optSort = root.querySelector('[data-top-opt="sortBy"]');
  if (optSort) {
    optSort.onchange = () => store.update((s) => { s.uiPrefs.sortBy = optSort.value; });
  }
  const zoomResetBtn = root.querySelector('[data-zoom-reset]');
  if (zoomResetBtn) {
    zoomResetBtn.onclick = () => {
      applyUserZoomLive(root, viewKind, 1, { immediateSave: true });
      playSound('confirm');
    };
  }
  bindZoomInteractions(root, viewKind);

  // 목록보기 카드 클릭
  root.querySelectorAll('[data-student-card]').forEach((card) => {
    card.onclick = () => {
      const id = card.dataset.studentCard;
      if (attendanceMode) {
        store.update((s) => {
          const st = s.students.find((x) => x.id === id);
          if (st) st.absent = !st.absent;
        });
        playSound('confirm');
        return;
      }
      if (selectedIds.has(id)) selectedIds.delete(id);
      else selectedIds.add(id);
      rerenderActiveStudentRoots(root);
    };
  });

  const addCard = root.querySelector('#btn-add-student-card');
  if (addCard) addCard.onclick = () => openStudentEditModal(null);

  // 자리배치 일반 모드 & 편집 모드 이벤트
  if (getEffectiveSubView(root) === 'seats') {
    bindSeatingEvents(root, state, activeStudents);
  }

  // 하단 공통 액션바 (조건부 렌더링 요소 모두 null-safe 바인딩)
  const gotoGrowthBtn = root.querySelector('#btn-goto-growth');
  if (gotoGrowthBtn) gotoGrowthBtn.onclick = () => navigateCallback?.('growth');

  const selectAllBtn = root.querySelector('#btn-select-all');
  if (selectAllBtn) {
    selectAllBtn.onclick = () => {
      const selectable = activeStudents.filter((s) => !s.absent);
      const allSel = selectable.length > 0 && selectable.every((s) => selectedIds.has(s.id));
      if (allSel) selectedIds.clear();
      else selectable.forEach((s) => selectedIds.add(s.id));
      rerenderActiveStudentRoots(root);
    };
  }

  const selectRecentBtn = root.querySelector('#btn-select-recent');
  if (selectRecentBtn) {
    selectRecentBtn.onclick = () => {
      selectedIds = new Set(lastSelectedIds.filter((id) => activeStudents.some((s) => s.id === id)));
      rerenderActiveStudentRoots(root);
    };
  }

  const clearBtn = root.querySelector('#btn-select-clear');
  if (clearBtn) {
    clearBtn.onclick = () => {
      selectedIds.clear();
      rerenderActiveStudentRoots(root);
    };
  }

  const invertBtn = root.querySelector('#btn-select-invert');
  if (invertBtn) {
    invertBtn.onclick = () => {
      const selectable = activeStudents.filter((s) => !s.absent);
      const nextSet = new Set();
      for (const s of selectable) {
        if (!selectedIds.has(s.id)) nextSet.add(s.id);
      }
      selectedIds = nextSet;
      rerenderActiveStudentRoots(root);
    };
  }

  const triggerCompose = (type) => {
    if (selectedIds.size === 0) return;
    lastSelectedIds = Array.from(selectedIds);
    openScoreComposer({
      studentIds: lastSelectedIds,
      initialType: type,
      onApplied: () => {
        // 연출 종료 후 1초 좌우 4세트 틸트가 끝날 때까지 노란 선택 하이라이트를 유지하고, 완료 시 자동 선택 해제
        rerenderActiveStudentRoots(root);
      },
    });
  };
  const awardPlusBtn = root.querySelector('#btn-award-plus');
  if (awardPlusBtn) awardPlusBtn.onclick = () => triggerCompose('positive');
  const awardMinusBtn = root.querySelector('#btn-award-minus');
  if (awardMinusBtn) awardMinusBtn.onclick = () => triggerCompose('negative');

  const openHistoryBtn = root.querySelector('#btn-open-history');
  if (openHistoryBtn) openHistoryBtn.onclick = () => navigateCallback?.('bulk', { tab: 'history' });

  const toggleAttendBtn = root.querySelector('#btn-toggle-attend');
  if (toggleAttendBtn) {
    toggleAttendBtn.onclick = () => {
      attendanceMode = !attendanceMode;
      if (attendanceMode) selectedIds.clear();
      rerenderActiveStudentRoots(root);
    };
  }

  const endAttend = root.querySelector('#btn-end-attend');
  if (endAttend) {
    endAttend.onclick = () => {
      attendanceMode = false;
      rerenderActiveStudentRoots(root);
    };
  }

  const resetScoresBtn = root.querySelector('#btn-reset-scores');
  if (resetScoresBtn) resetScoresBtn.onclick = () => openResetScoreModal();
  const manageStudentsBtn = root.querySelector('#btn-manage-students');
  if (manageStudentsBtn) manageStudentsBtn.onclick = () => openRosterManagerModal();
}

/** 자유형 자리배치 전용 인터랙션 (모둠 통째 드래그·틈새삽입·자석격자 / 학생 2명 클릭 자리교환 / 점선 '+' 새 모둠) */
function bindSeatingEvents(root, state, activeStudents) {
  const canvas = root.querySelector('#seating-canvas');
  const scrollEl = root.querySelector('#seating-canvas-scroll');
  const viewW = scrollEl.clientWidth || Math.max(800, window.innerWidth - 100);
  const viewH = scrollEl.clientHeight || Math.max(460, window.innerHeight - 200);
  const baseBoxes = ensureGroupLayout(state.groups, activeStudents, viewW);

  // 편집 모드에서 빈 배경 클릭 시 학생 교환 선택 해제 (배경 드래그 좌석 이동은 비활성화하여 기본 위치 유지)
  if (scrollEl) {
    scrollEl.onpointerdown = (ev) => {
      if (ev.button !== 0 || seatingFlipping) return;
      if (ev.target.closest('[data-group-box], #group-ghost-add, button, .seat-slot')) return;
      if (seatEditMode && swapSourceStudentId) {
        swapSourceStudentId = null;
        renderStudentsView(root);
      }
    };
  }

  // 모둠(그룹 박스 여백 · 하단 푸터 · 그룹 이름) 클릭 → 일반 모드: 그룹과 소속 학생 모두 선택/해제
  const toggleGroupSelection = (gid) => {
    const members = activeStudents.filter((s) => s.groupId === gid && !s.absent);
    if (members.length === 0) return;
    const allSel = members.every((m) => selectedIds.has(m.id));
    if (allSel) members.forEach((m) => selectedIds.delete(m.id));
    else members.forEach((m) => selectedIds.add(m.id));
    rerenderActiveStudentRoots(root);
  };

  root.querySelectorAll('[data-select-group]').forEach((btn) => {
    btn.onclick = (e) => {
      if (seatEditMode) return;
      e.stopPropagation();
      toggleGroupSelection(btn.dataset.selectGroup);
    };
  });

  // 자리 클릭 (일반 모드: 학생 개별 선택 / 그룹 영역 클릭 시 그룹+학생 전체 선택)
  if (!seatEditMode) {
    root.querySelectorAll('[data-group-box]').forEach((boxEl) => {
      boxEl.onclick = (e) => {
        if (e.target.closest('.seat-slot[data-seat-student]')) return;
        if (e.target.closest('[data-select-group]')) return;
        e.stopPropagation();
        toggleGroupSelection(boxEl.dataset.groupBox);
      };
    });

    root.querySelectorAll('.seat-slot[data-seat-student]').forEach((slot) => {
      slot.onclick = () => {
        const stId = slot.dataset.seatStudent;
        if (!stId) return;
        if (attendanceMode) {
          store.update((s) => {
            const st = s.students.find((x) => x.id === stId);
            if (st) st.absent = !st.absent;
          });
          playSound('confirm');
          return;
        }
        if (selectedIds.has(stId)) selectedIds.delete(stId);
        else selectedIds.add(stId);
        rerenderActiveStudentRoots(root);
      };
    });
  } else {
    // ===== 편집 모드 전용 인터랙션 =====
    // 1. 학생 빼기(미배치) 버튼 — 기존 모둠의 남은 학생 자리는 자동정렬하지 않고 그대로 유지!
    root.querySelectorAll('[data-unassign-student]').forEach((btn) => {
      btn.onpointerdown = (e) => e.stopPropagation();
      btn.onclick = async (e) => {
        e.stopPropagation();
        const stId = btn.dataset.unassignStudent;
        if (swapSourceStudentId === stId) swapSourceStudentId = null;
        await store.update((s) => {
          const st = s.students.find((x) => x.id === stId);
          if (st) {
            st.groupId = null;
            st.seatIndex = 0;
          }
        });
        playSound('confirm');
      };
    });

    // 2. 모둠 이름 인라인 편집 / 삭제 및 테두리 1칸 단위 리사이즈
    root.querySelectorAll('[data-inline-rename-group]').forEach((inp) => {
      const gid = inp.dataset.inlineRenameGroup;
      const g = state.groups.find((x) => x.id === gid);
      const origName = g ? g.name : inp.value;
      let cancelled = false;

      inp.onpointerdown = (e) => e.stopPropagation();
      inp.onclick = (e) => e.stopPropagation();
      inp.onfocus = () => {
        cancelled = false;
        inp.select();
      };
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          inp.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelled = true;
          inp.value = origName;
          inp.blur();
        }
      };
      inp.onblur = () => {
        if (cancelled) return;
        const next = inp.value.trim();
        if (!next) {
          inp.value = origName;
          return;
        }
        if (next === origName) return;
        store.update((s) => {
          const target = s.groups.find((x) => x.id === gid);
          if (target) target.name = next;
        });
      };
    });
    root.querySelectorAll('[data-delete-group]').forEach((b) => {
      b.onpointerdown = (e) => e.stopPropagation();
      b.onclick = (e) => {
        e.stopPropagation();
        const gid = b.dataset.deleteGroup;
        if (!confirm('이 모둠을 삭제할까요? 소속 학생들은 미배치 상태가 되어 점선 + 새 모둠 카드에서 다시 추가할 수 있습니다.')) return;
        swapSourceStudentId = null;
        store.update((s) => {
          s.groups = s.groups.filter((x) => x.id !== gid);
          s.students.forEach((st) => {
            if (st.groupId === gid) {
              st.groupId = null;
              st.seatIndex = 0;
            }
          });
        });
      };
    });
    root.querySelectorAll('[data-resize-group]').forEach((handleEl) => {
      handleEl.onpointerdown = (ev) => {
        if (ev.button !== 0) return;
        ev.stopPropagation();
        ev.preventDefault();
        startGroupResize(ev, handleEl.dataset.resizeGroup, handleEl.dataset.resizeDir, handleEl, canvas, baseBoxes);
      };
    });

    // 3. 모둠 카드 통째 드래그 (푸터 및 모둠 내부 여백 어디든 드래그 가능, 자석 격자 스냅 + 실시간 틈새 밀림)
    root.querySelectorAll('[data-group-box]').forEach((boxEl) => {
      boxEl.onpointerdown = (ev) => {
        if (ev.button !== 0) return;
        if (ev.target.closest('.seat-slot, .group-mini-btn, .seat-unassign-btn, .group-resize-handle, .group-name-inline-input')) return;
        if (swapSourceStudentId && ev.target.closest('.seat-cell-empty')) return;
        ev.preventDefault();
        startGroupDrag(ev, boxEl.dataset.groupBox, canvas, baseBoxes);
      };
    });

    // 3-B. 교환 선택된 학생이 있을 때 빈 자리 셀 클릭 시 해당 빈 칸으로 즉시 자리 이동
    root.querySelectorAll('.seat-cell-empty').forEach((emptyEl) => {
      emptyEl.onclick = async (ev) => {
        if (!swapSourceStudentId) return;
        ev.stopPropagation();
        const targetGid = emptyEl.dataset.emptySeatGroup;
        const targetIdx = Number(emptyEl.dataset.emptySeatIndex) || 0;
        const srcId = swapSourceStudentId;
        swapSourceStudentId = null;
        await placeOrInsertStudentAtSlot(srcId, targetGid, targetIdx, true);
        playSound('confirm');
      };
    });

    // 4. 1명 크기 반투명 점선 '+' 새 모둠 카드 드래그 이동 및 클릭 생성
    const ghostEl = root.querySelector('#group-ghost-add');
    if (ghostEl) {
      ghostEl.onpointerdown = (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        startGhostAddDrag(ev, ghostEl, canvas, baseBoxes);
      };
    }

    // 5. 학생 카드 클릭(2개 누르면 자리 교환) & 드래그(빈 셀 직접 배치 + 카드 틈새 삽입 + 점선 '+' 새 모둠 드롭)
    root.querySelectorAll('.seat-slot[data-seat-student]').forEach((slot) => {
      slot.onpointerdown = (ev) => {
        if (ev.button !== 0 || ev.target.closest('.seat-unassign-btn')) return;
        ev.preventDefault();
        startStudentSeatDrag(ev, slot, canvas, baseBoxes);
      };
    });

    // 6. 상단 배너 '+ 새 모둠 추가' 버튼
    const addGrpBtn = root.querySelector('#btn-seat-add-group');
    if (addGrpBtn) {
      addGrpBtn.onclick = () => {
        const pos = ghostAddPos ? { ...ghostAddPos } : computeDefaultGhostPos(baseBoxes, viewW, viewH);
        openPlaceStudentModal(null, pos);
      };
    }

    // 7. 가운데 정렬 버튼 (모둠 순서나 상대 배치는 초기화하지 않고 가로·세로 기준 정중앙으로 위치만 이동)
    const recenterBtn = root.querySelector('#btn-seat-recenter');
    if (recenterBtn) {
      recenterBtn.onclick = async () => {
        const curStageW = canvas?.offsetWidth || scrollEl?.clientWidth || viewW;
        const curStageH = canvas?.offsetHeight || scrollEl?.clientHeight || viewH;

        await store.update((s) => {
          const active = s.students.filter((x) => !x.trashed);
          const boxes = ensureGroupLayout(s.groups, active, curStageW);
          if (boxes.length === 0) return;

          const minX = Math.min(...boxes.map((b) => b.x));
          const maxX = Math.max(...boxes.map((b) => b.x + b.w));
          const minY = Math.min(...boxes.map((b) => b.y));
          const maxY = Math.max(...boxes.map((b) => b.y + b.h));
          const spanW = maxX - minX;
          const spanH = maxY - minY;

          const arenaW = Math.max(curStageW, spanW + CANVAS_PAD * 2);
          const arenaH = Math.max(curStageH, spanH + CANVAS_PAD * 2);
          const targetMinX = Math.max(CANVAS_PAD, Math.round((arenaW - spanW) / 2));
          const targetMinY = Math.max(CANVAS_PAD, Math.round((arenaH - spanH) / 2));
          const dx = targetMinX - minX;
          const dy = targetMinY - minY;

          boxes.forEach((b) => {
            const g = s.groups.find((x) => x.id === b.id);
            if (g) {
              g.x = Math.max(CANVAS_PAD, Math.round(b.x + dx));
              g.y = Math.max(CANVAS_PAD, Math.round(b.y + dy));
            }
          });

          if (ghostAddPos) {
            const shiftedGhost = {
              x: Math.max(CANVAS_PAD, Math.round(ghostAddPos.x + dx)),
              y: Math.max(CANVAS_PAD, Math.round(ghostAddPos.y + dy)),
            };
            const shiftedBoxes = boxes.map((b) => ({
              ...b,
              x: Math.max(CANVAS_PAD, Math.round(b.x + dx)),
              y: Math.max(CANVAS_PAD, Math.round(b.y + dy)),
            }));
            if (!isBoxOverlapping({ ...shiftedGhost, w: GHOST_W, h: GHOST_H }, shiftedBoxes, 6)) {
              ghostAddPos = shiftedGhost;
            } else {
              ghostAddPos = computeDefaultGhostPos(shiftedBoxes, arenaW, arenaH);
            }
          }
        });
        playSound('confirm');
      };
    }
  }

  // 하단 3대 버튼
  const toggleEdit = async () => {
    swapSourceStudentId = null;
    if (!seatEditMode) {
      const editViewW = scrollEl?.clientWidth || Math.max(800, window.innerWidth - 100);
      const editViewH = scrollEl?.clientHeight || Math.max(460, window.innerHeight - 200);
      const initialBoxes = ensureGroupLayout(state.groups, activeStudents, editViewW);
      ghostAddPos = computeDefaultGhostPos(initialBoxes, editViewW, editViewH);
      seatEditMode = true;
      await store.update((s) => {
        initialBoxes.forEach((b) => {
          const g = s.groups.find((x) => x.id === b.id);
          if (g && (!Number.isFinite(g.x) || !Number.isFinite(g.y))) {
            g.x = b.x;
            g.y = b.y;
          }
        });
      });
    } else {
      seatEditMode = false;
      ghostAddPos = null;
      renderStudentsView(root);
    }
  };
  const btnSeatEdit = root.querySelector('#btn-toggle-seat-edit');
  if (btnSeatEdit) btnSeatEdit.onclick = toggleEdit;
  const btnSeatEditDone = root.querySelector('#btn-seat-edit-done');
  if (btnSeatEditDone) btnSeatEditDone.onclick = toggleEdit;

  const btnFlip = root.querySelector('#btn-flip-seating');
  if (btnFlip) {
    btnFlip.onclick = async () => {
      if (seatingFlipping) return;
      seatingFlipping = true;
      seatingFlipTargetRoot = root;
      swapSourceStudentId = null;
      playSound('confirm');

      const canvasEl = root.querySelector('#seating-canvas');
      const stageW = canvasEl ? canvasEl.offsetWidth : 1506;
      const stageH = canvasEl ? canvasEl.offsetHeight : 696;

      // 회전 시작 직전 각 모둠·추가카드의 실제 DOM 좌표/크기를 기록해 180도 점대칭 위치로 즉시 배치
      const domGroupRects = new Map();
      if (canvasEl) {
        canvasEl.querySelectorAll('[data-group-box]').forEach((el) => {
          domGroupRects.set(el.dataset.groupBox, {
            x: el.offsetLeft,
            y: el.offsetTop,
            w: el.offsetWidth,
            h: el.offsetHeight,
          });
        });
      }
      const ghostEl = canvasEl ? canvasEl.querySelector('#group-ghost-add') : null;
      const domGhostRect = ghostEl
        ? { x: ghostEl.offsetLeft, y: ghostEl.offsetTop, w: ghostEl.offsetWidth, h: ghostEl.offsetHeight }
        : null;

      // 내부 요소 개별 회전 애니메이션 없이, 먼저 좌석·짝·교탁 위치를 도착 상태(정방향)로 전환한 뒤
      // 단일 회전 판(#seating-rotator)을 -180deg(내부가 돌아간 상태)에서 0deg로 통째로 회전
      await store.update((s) => {
        const active = s.students.filter((x) => !x.trashed);
        const boxes = ensureGroupLayout(s.groups, active);
        if (boxes.length > 0) {
          boxes.forEach((b) => {
            const g = s.groups.find((x) => x.id === b.id);
            const rect = domGroupRects.get(b.id) || { x: b.x, y: b.y, w: b.w, h: b.h };
            if (g) {
              g.x = Math.max(CANVAS_PAD, Math.round(stageW - (rect.x + rect.w)));
              g.y = Math.max(CANVAS_PAD, Math.round(stageH - (rect.y + rect.h)));
            }
            const members = active.filter((m) => m.groupId === b.id);
            const cols = b.cols;
            const rows = b.rows;
            for (const m of members) {
              const idx = Math.max(0, Math.trunc(Number(m.seatIndex) || 0));
              const r = Math.floor(idx / cols);
              const c = idx % cols;
              const flippedRow = Math.max(0, rows - 1 - r);
              const flippedCol = Math.max(0, cols - 1 - c);
              m.seatIndex = flippedRow * cols + flippedCol;
            }
          });
          if (seatEditMode && ghostAddPos) {
            const gr = domGhostRect || { x: ghostAddPos.x, y: ghostAddPos.y, w: GHOST_W, h: GHOST_H };
            ghostAddPos = {
              x: Math.max(CANVAS_PAD, Math.round(stageW - (gr.x + gr.w))),
              y: Math.max(CANVAS_PAD, Math.round(stageH - (gr.y + gr.h))),
            };
          }
        }
        s.uiPrefs.seatingReversed = !s.uiPrefs.seatingReversed;
      });

      const newRotator = root.querySelector('#seating-rotator');
      let finished = false;
      const finishFlip = () => {
        if (finished) return;
        finished = true;
        clearTimeout(fallbackTimer);
        if (newRotator) {
          newRotator.removeEventListener('animationend', onAnimEnd);
          newRotator.classList.remove('is-rotating-board');
        }
        seatingFlipping = false;
        seatingFlipTargetRoot = null;
      };

      const onAnimEnd = (e) => {
        if (e.target === newRotator && e.animationName === 'seating-board-rotate-180') {
          finishFlip();
        }
      };
      if (newRotator) newRotator.addEventListener('animationend', onAnimEnd);
      const fallbackTimer = setTimeout(finishFlip, 740);
    };
  }
  const btnQuickGroupPick = root.querySelector('#btn-quick-group-pick');
  if (btnQuickGroupPick) {
    btnQuickGroupPick.onclick = () => {
      if (seatEditMode) return;
      runSeatingGroupPick(root);
    };
  }
  const btnQuickStudentPick = root.querySelector('#btn-quick-student-pick');
  if (btnQuickStudentPick) {
    btnQuickStudentPick.onclick = () => {
      if (seatEditMode) return;
      runSeatingStudentPick(root);
    };
  }
}

/**
 * 모든 후보(0..count-1)가 편중 없이 균등한 횟수로 하이라이트되도록 라운드 셔플 시퀀스 생성
 * - 인접한 스텝에서 같은 항목이 연속으로 선택되지 않도록 보장
 */
function buildBalancedPickSequence(count, totalSteps) {
  if (count <= 1) return [0];
  const seq = [];
  while (seq.length < totalSteps) {
    const bag = Array.from({ length: count }, (_, i) => i);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    if (seq.length > 0 && bag[0] === seq[seq.length - 1]) {
      const swapIdx = 1 + Math.floor(Math.random() * (bag.length - 1));
      [bag[0], bag[swapIdx]] = [bag[swapIdx], bag[0]];
    }
    for (const idx of bag) {
      if (seq.length < totalSteps) seq.push(idx);
    }
  }
  return seq;
}

/**
 * 자리배치 내 그룹 뽑기 (화면 전환 없이 모든 모둠을 균등한 횟수·일정한 속도로 하이라이트 후 당첨 모둠원 팝업 오픈)
 */
function runSeatingGroupPick(root) {
  if (seatingPickRunning || seatingFlipping) return;
  const state = store.getState();
  const active = state.students.filter((s) => !s.trashed);

  // 학생이 1명 이상 소속된 모둠 박스만 추첨 대상
  const candidateEls = Array.from(root.querySelectorAll('[data-group-box]')).filter((el) => {
    const gid = el.dataset.groupBox;
    const members = active.filter((s) => s.groupId === gid && !s.absent);
    const allMembers = active.filter((s) => s.groupId === gid);
    return members.length > 0 || allMembers.length > 0;
  });

  if (candidateEls.length === 0) {
    showToast('뽑을 수 있는 모둠이 없습니다.');
    return;
  }

  seatingPickRunning = true;
  const btnGrp = root.querySelector('#btn-quick-group-pick');
  if (btnGrp) btnGrp.classList.add('is-running');

  const clearGroupHighlights = () => {
    root.querySelectorAll('[data-group-box]').forEach((el) => {
      el.classList.remove('is-pick-roulette', 'is-pick-winner');
    });
  };
  clearGroupHighlights();

  const totalSteps = candidateEls.length === 1 ? 1 : candidateEls.length * 3 + 1;
  const sequence = buildBalancedPickSequence(candidateEls.length, totalSteps);
  const STEP_INTERVAL_MS = 105; // 감속 없이 일정한 속도 유지
  let step = 0;

  const tickStep = () => {
    clearGroupHighlights();
    const pickIdx = sequence[step];
    const targetEl = candidateEls[pickIdx];

    if (step < totalSteps - 1) {
      targetEl.classList.add('is-pick-roulette');
      playSound('tick');
      step++;
      setTimeout(tickStep, STEP_INTERVAL_MS);
    } else {
      // 최종 모둠 당첨!
      targetEl.classList.add('is-pick-winner');
      playSound('fanfare');
      const winnerGroupId = targetEl.dataset.groupBox;
      setTimeout(() => {
        seatingPickRunning = false;
        if (btnGrp) btnGrp.classList.remove('is-running');
        clearGroupHighlights();
        openSeatingGroupWinnerModal(root, winnerGroupId);
      }, 480);
    }
  };

  tickStep();
}

/**
 * 당첨 모둠 팝업 (그룹원 아바타·이름 표시 + '그룹 내 뽑기' 버튼으로 아바타가 커지며 무작위 선택 후 최종 아바타 크게 표시)
 */
function openSeatingGroupWinnerModal(root, groupId) {
  const state = store.getState();
  const group = state.groups.find((g) => g.id === groupId);
  if (!group) return;

  const active = state.students.filter((s) => !s.trashed && s.groupId === groupId);
  const presentMembers = active.filter((s) => !s.absent).sort((a, b) => a.number - b.number);
  const members = (presentMembers.length > 0 ? presentMembers : active).sort((a, b) => a.number - b.number);

  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  let innerRolling = false;
  let innerWinnerStudent = null;
  const close = () => {
    if (innerRolling) return;
    backdrop.remove();
  };

  backdrop.innerHTML = `
    <div class="seat-pick-dialog" role="dialog" aria-modal="true">
      <div class="seat-pick-header">
        <div class="seat-pick-title-wrap">
          <i class="sp-icon sp-clover-brown" style="filter:brightness(1.35);" aria-hidden="true"></i>
          <h2>${escapeHtml(group.name)} 당첨!</h2>
          <span class="seat-pick-subbadge">모둠원 ${members.length}명</span>
        </div>
        <button type="button" class="seat-pick-close" data-close aria-label="닫기">&times;</button>
      </div>

      <div class="seat-pick-body">
        <!-- 그룹 내 뽑기 최종 선택 시 크게 나타나는 당첨 학생 쇼케이스 -->
        <div id="group-inner-winner-stage" style="display:none;width:100%;"></div>

        <!-- 당첨 모둠 소속 학생들의 아바타·이름 카드 목록 -->
        <div class="seat-group-pick-members" id="seat-group-pick-members">
          ${members.map((st) => `
            <div class="seat-group-member-card" data-group-member-card="${st.id}">
              <span class="seat-group-member-num">${st.number}</span>
              <img class="seat-group-member-avatar" src="${getStillAvatarUrl(st.avatarId)}" alt="${escapeAttr(st.name)}">
              <span class="seat-group-member-name">${escapeHtml(st.name)}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="seat-pick-footer">
        <div class="seat-pick-footer-left">
          <button type="button" class="btn-yellow" id="btn-pick-in-group" ${members.length === 0 ? 'disabled' : ''}>
            <i class="sp-icon sp-clover-brown" aria-hidden="true"></i>
            <span>그룹 내 뽑기</span>
          </button>
          <button type="button" class="btn-outline" id="btn-repick-group">다시 그룹 뽑기</button>
        </div>
        <div class="seat-pick-footer-right">
          <button type="button" class="btn-blue" id="btn-award-picked-group-plus">
            <i class="sp-icon sp-star-blue" style="transform:scale(0.8);" aria-hidden="true"></i> 으쓱
          </button>
          <button type="button" class="btn-red" id="btn-award-picked-group-minus">
            <i class="sp-icon sp-cloud-red" style="transform:scale(0.8);" aria-hidden="true"></i> 머쓱
          </button>
          <button type="button" class="btn-ghost" data-close>닫기</button>
        </div>
      </div>
    </div>
  `;

  modalRoot.appendChild(backdrop);
  backdrop.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  const winnerStage = backdrop.querySelector('#group-inner-winner-stage');
  const memberCards = Array.from(backdrop.querySelectorAll('[data-group-member-card]'));
  const btnPickInGroup = backdrop.querySelector('#btn-pick-in-group');

  // '그룹 내 뽑기' 클릭 → 아바타가 커지면서 무작위로 순회하다가 최종 선택되면 해당 아바타가 크게 표시됨
  if (btnPickInGroup) {
    btnPickInGroup.onclick = () => {
      if (innerRolling || members.length === 0) return;
      innerRolling = true;
      innerWinnerStudent = null;
      winnerStage.style.display = 'none';
      winnerStage.innerHTML = '';

      const clearCardStates = () => {
        memberCards.forEach((c) => {
          c.classList.remove('is-roulette-active', 'is-roulette-dim', 'is-roulette-winner');
        });
      };
      clearCardStates();

      const totalSteps = memberCards.length === 1 ? 1 : memberCards.length * 3 + 1;
      const sequence = buildBalancedPickSequence(memberCards.length, totalSteps);
      const STEP_INTERVAL_MS = 105; // 감속 없이 일정한 속도 유지
      let step = 0;

      const stepMember = () => {
        const pickIdx = sequence[step];

        memberCards.forEach((c, idx) => {
          c.classList.toggle('is-roulette-active', idx === pickIdx);
          c.classList.toggle('is-roulette-dim', idx !== pickIdx);
          c.classList.remove('is-roulette-winner');
        });

        if (step < totalSteps - 1) {
          playSound('tick');
          step++;
          setTimeout(stepMember, STEP_INTERVAL_MS);
        } else {
          // 그룹 내 최종 당첨!
          clearCardStates();
          const winCard = memberCards[pickIdx];
          winCard.classList.add('is-roulette-winner');
          const winSt = members[pickIdx];
          innerWinnerStudent = winSt;
          playSound('fanfare');

          // 최종 선택된 학생의 아바타를 크게 표시
          winnerStage.style.display = 'block';
          winnerStage.innerHTML = `
            <div class="seat-pick-winner-showcase">
              <div class="seat-winner-halo">
                <div class="seat-winner-stars">
                  <i class="sp-icon sp-star-yellow s-l" aria-hidden="true"></i>
                  <i class="sp-icon sp-star-yellow s-r" aria-hidden="true"></i>
                  <i class="sp-icon sp-star-yellow s-b" aria-hidden="true"></i>
                </div>
                <div class="avatar-fx-sprite seat-winner-avatar-fx" style="background-image:url('${getFxAvatarUrl(winSt.avatarId)}')"></div>
              </div>
              <div class="seat-winner-label-group">
                <span class="seat-winner-group-tag">${escapeHtml(group.name)} 대표 당첨</span>
                <div class="seat-winner-name-big">
                  <span class="seat-winner-num-pill">${winSt.number}번</span>
                  <span>${escapeHtml(winSt.name)}</span>
                </div>
              </div>
            </div>
          `;
          btnPickInGroup.querySelector('span').textContent = '그룹 내 다시 뽑기';
          innerRolling = false;
        }
      };

      stepMember();
    };
  }

  backdrop.querySelector('#btn-repick-group').onclick = () => {
    if (innerRolling) return;
    backdrop.remove();
    runSeatingGroupPick(root);
  };

  const awardTarget = (type) => {
    if (innerRolling) return;
    const targetIds = innerWinnerStudent ? [innerWinnerStudent.id] : members.map((m) => m.id);
    if (targetIds.length === 0) return;
    backdrop.remove();
    openScoreComposer({
      studentIds: targetIds,
      initialType: type,
    });
  };
  backdrop.querySelector('#btn-award-picked-group-plus').onclick = () => awardTarget('positive');
  backdrop.querySelector('#btn-award-picked-group-minus').onclick = () => awardTarget('negative');
}

/**
 * 자리배치 내 개인 뽑기 (무작위로 학생 카드가 하이라이트되다가 최종 선택되면 아바타가 큰 팝업으로 등장)
 */
function runSeatingStudentPick(root) {
  if (seatingPickRunning || seatingFlipping) return;
  const state = store.getState();
  const active = state.students.filter((s) => !s.trashed);

  const allSlots = Array.from(root.querySelectorAll('.seat-slot[data-seat-student]'));
  const presentSlots = allSlots.filter((el) => {
    const st = active.find((s) => s.id === el.dataset.seatStudent);
    return st && !st.absent;
  });
  const candidateSlots = presentSlots.length > 0 ? presentSlots : allSlots;

  if (candidateSlots.length === 0) {
    showToast('뽑을 수 있는 학생 카드가 없습니다.');
    return;
  }

  seatingPickRunning = true;
  const btnSt = root.querySelector('#btn-quick-student-pick');
  if (btnSt) btnSt.classList.add('is-running');

  const clearSlotHighlights = () => {
    root.querySelectorAll('.seat-slot[data-seat-student]').forEach((el) => {
      el.classList.remove('is-pick-roulette', 'is-pick-winner');
    });
  };
  clearSlotHighlights();

  const totalSteps = candidateSlots.length === 1 ? 1 : candidateSlots.length * 2 + 1;
  const sequence = buildBalancedPickSequence(candidateSlots.length, totalSteps);
  const STEP_INTERVAL_MS = 68; // 감속 없이 일정한 속도로 모든 학생을 골고루 하이라이트
  let step = 0;

  const tickSlot = () => {
    clearSlotHighlights();
    const pickIdx = sequence[step];
    const targetSlot = candidateSlots[pickIdx];

    if (step < totalSteps - 1) {
      targetSlot.classList.add('is-pick-roulette');
      playSound('tick');
      step++;
      setTimeout(tickSlot, STEP_INTERVAL_MS);
    } else {
      // 최종 학생 카드 당첨!
      targetSlot.classList.add('is-pick-winner');
      playSound('fanfare');
      const winnerStudentId = targetSlot.dataset.seatStudent;
      setTimeout(() => {
        seatingPickRunning = false;
        if (btnSt) btnSt.classList.remove('is-running');
        clearSlotHighlights();
        openSeatingStudentWinnerModal(root, winnerStudentId);
      }, 480);
    }
  };

  tickSlot();
}

/**
 * 개인 뽑기 최종 당첨 학생 아바타 대형 팝업
 */
function openSeatingStudentWinnerModal(root, studentId) {
  const state = store.getState();
  const student = state.students.find((s) => s.id === studentId);
  if (!student) return;
  const group = state.groups.find((g) => g.id === student.groupId);

  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  backdrop.innerHTML = `
    <div class="seat-pick-dialog is-single" role="dialog" aria-modal="true">
      <div class="seat-pick-header">
        <div class="seat-pick-title-wrap">
          <i class="sp-icon sp-clover-green-mini" aria-hidden="true"></i>
          <h2>개인 뽑기 당첨!</h2>
          ${group ? `<span class="seat-pick-subbadge">${escapeHtml(group.name)}</span>` : ''}
        </div>
        <button type="button" class="seat-pick-close" data-close aria-label="닫기">&times;</button>
      </div>

      <div class="seat-pick-body">
        <div class="seat-pick-winner-showcase">
          <div class="seat-winner-halo">
            <div class="seat-winner-stars">
              <i class="sp-icon sp-star-yellow s-l" aria-hidden="true"></i>
              <i class="sp-icon sp-star-yellow s-r" aria-hidden="true"></i>
              <i class="sp-icon sp-star-yellow s-b" aria-hidden="true"></i>
            </div>
            <div class="avatar-fx-sprite seat-winner-avatar-fx" style="background-image:url('${getFxAvatarUrl(student.avatarId)}')"></div>
          </div>
          <div class="seat-winner-label-group">
            ${group ? `<span class="seat-winner-group-tag">${escapeHtml(group.name)}</span>` : ''}
            <div class="seat-winner-name-big">
              <span class="seat-winner-num-pill">${student.number}번</span>
              <span>${escapeHtml(student.name)}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="seat-pick-footer">
        <div class="seat-pick-footer-left">
          <button type="button" class="btn-yellow" id="btn-repick-student">
            <i class="sp-icon sp-clover-green-mini" aria-hidden="true"></i>
            <span>다시 뽑기</span>
          </button>
        </div>
        <div class="seat-pick-footer-right">
          <button type="button" class="btn-blue" id="btn-award-picked-st-plus">
            <i class="sp-icon sp-star-blue" style="transform:scale(0.8);" aria-hidden="true"></i> 으쓱
          </button>
          <button type="button" class="btn-red" id="btn-award-picked-st-minus">
            <i class="sp-icon sp-cloud-red" style="transform:scale(0.8);" aria-hidden="true"></i> 머쓱
          </button>
          <button type="button" class="btn-ghost" data-close>닫기</button>
        </div>
      </div>
    </div>
  `;

  modalRoot.appendChild(backdrop);
  backdrop.querySelectorAll('[data-close]').forEach((b) => { b.onclick = close; });
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  backdrop.querySelector('#btn-repick-student').onclick = () => {
    backdrop.remove();
    runSeatingStudentPick(root);
  };
  backdrop.querySelector('#btn-award-picked-st-plus').onclick = () => {
    backdrop.remove();
    openScoreComposer({ studentIds: [student.id], initialType: 'positive' });
  };
  backdrop.querySelector('#btn-award-picked-st-minus').onclick = () => {
    backdrop.remove();
    openScoreComposer({ studentIds: [student.id], initialType: 'negative' });
  };
}

/** 자석 격자 스냅 계산 + 가이드선 렌더링 */
function computeMagneticSnap(dragX, dragY, dragW, dragH, otherBoxes) {
  let snappedX = dragX;
  let snappedY = dragY;
  let bestDx = SNAP_THRESHOLD + 1;
  let bestDy = SNAP_THRESHOLD + 1;
  let guideX = null;
  let guideY = null;

  for (const o of otherBoxes) {
    const xTargets = [
      { val: o.x, line: o.x },
      { val: o.x + o.w - dragW, line: o.x + o.w },
      { val: o.x + o.w + GROUP_GAP_X, line: o.x + o.w + GROUP_GAP_X },
      { val: o.x - dragW - GROUP_GAP_X, line: o.x - GROUP_GAP_X },
      { val: o.x + (o.w - dragW) / 2, line: o.x + o.w / 2 },
    ];
    for (const t of xTargets) {
      const d = Math.abs(dragX - t.val);
      if (d < bestDx) {
        bestDx = d;
        snappedX = Math.round(t.val);
        guideX = Math.round(t.line);
      }
    }

    const yTargets = [
      { val: o.y, line: o.y },
      { val: o.y + o.h - dragH, line: o.y + o.h },
      { val: o.y + o.h + GROUP_GAP_Y, line: o.y + o.h + GROUP_GAP_Y },
      { val: o.y - dragH - GROUP_GAP_Y, line: o.y - GROUP_GAP_Y },
      { val: o.y + (o.h - dragH) / 2, line: o.y + o.h / 2 },
    ];
    for (const t of yTargets) {
      const d = Math.abs(dragY - t.val);
      if (d < bestDy) {
        bestDy = d;
        snappedY = Math.round(t.val);
        guideY = Math.round(t.line);
      }
    }
  }

  return {
    x: Math.max(CANVAS_PAD, snappedX),
    y: Math.max(CANVAS_PAD, snappedY),
    guideX: bestDx <= SNAP_THRESHOLD ? guideX : null,
    guideY: bestDy <= SNAP_THRESHOLD ? guideY : null,
  };
}

function renderSnapGuides(canvas, guideX, guideY) {
  canvas.querySelectorAll('.snap-guide-x, .snap-guide-y').forEach((el) => el.remove());
  if (guideX !== null) {
    const lx = document.createElement('div');
    lx.className = 'snap-guide-x';
    lx.style.left = `${guideX}px`;
    canvas.appendChild(lx);
  }
  if (guideY !== null) {
    const ly = document.createElement('div');
    ly.className = 'snap-guide-y';
    ly.style.top = `${guideY}px`;
    canvas.appendChild(ly);
  }
}

/** 모둠 카드 통째 드래그: 자석 격자 + 틈새 삽입 실시간 부드러운 밀림 + 영역 초과 시 자동 비율 축소 */
function startGroupDrag(ev, groupId, canvas, baseBoxes) {
  const scale = getSeatingCanvasScale(canvas);
  const boxEl = canvas.querySelector(`[data-group-box="${groupId}"]`);
  const orig = baseBoxes.find((b) => b.id === groupId);
  if (!boxEl || !orig) return;

  const startClientX = ev.clientX;
  const startClientY = ev.clientY;
  const others = baseBoxes.filter((b) => b.id !== groupId);
  let latestBoxes = baseBoxes.map((b) => ({ ...b }));
  let moved = false;

  boxEl.classList.add('is-dragging');

  const onMove = (e) => {
    const dx = (e.clientX - startClientX) / scale;
    const dy = (e.clientY - startClientY) / scale;
    if (Math.hypot(dx, dy) > 3) moved = true;

    const rawX = Math.max(CANVAS_PAD, orig.x + dx);
    const rawY = Math.max(CANVAS_PAD, orig.y + dy);
    const snap = computeMagneticSnap(rawX, rawY, orig.w, orig.h, others);
    renderSnapGuides(canvas, snap.guideX, snap.guideY);

    // 틈새 삽입 실시간 충돌 밀림 계산 (다른 모둠들이 부드럽게 옆/아래로 밀림)
    const candidate = baseBoxes.map((b) => (b.id === groupId ? { ...b, x: snap.x, y: snap.y } : { ...b }));
    latestBoxes = resolveBoxCollisions(candidate, groupId, 'auto');

    for (const b of latestBoxes) {
      const el = canvas.querySelector(`[data-group-box="${b.id}"]`);
      if (el) {
        el.style.left = `${b.x}px`;
        el.style.top = `${b.y}px`;
      }
    }
    if (lastStudentsRoot) applySeatingFit(lastStudentsRoot);
  };

  const onUp = async () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    boxEl.classList.remove('is-dragging');
    renderSnapGuides(canvas, null, null);
    if (!moved) return;

    await store.update((s) => {
      latestBoxes.forEach((b) => {
        const g = s.groups.find((x) => x.id === b.id);
        if (g) {
          g.x = b.x;
          g.y = b.y;
        }
      });
    });
    playSound('confirm');
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** 1명 크기 점선 '+' 새 모둠 카드 드래그 이동 & 클릭 시 새 모둠 생성 */
function startGhostAddDrag(ev, ghostEl, canvas, baseBoxes) {
  const scale = getSeatingCanvasScale(canvas);
  const startClientX = ev.clientX;
  const startClientY = ev.clientY;
  const origX = ghostAddPos.x;
  const origY = ghostAddPos.y;
  let moved = false;

  ghostEl.classList.add('is-dragging');

  const onMove = (e) => {
    const dx = (e.clientX - startClientX) / scale;
    const dy = (e.clientY - startClientY) / scale;
    if (Math.hypot(dx, dy) > 5) moved = true;
    const snap = computeMagneticSnap(Math.max(CANVAS_PAD, origX + dx), Math.max(CANVAS_PAD, origY + dy), GHOST_W, GHOST_H, baseBoxes);
    renderSnapGuides(canvas, snap.guideX, snap.guideY);
    ghostAddPos = { x: snap.x, y: snap.y };
    ghostEl.style.left = `${snap.x}px`;
    ghostEl.style.top = `${snap.y}px`;
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    ghostEl.classList.remove('is-dragging');
    renderSnapGuides(canvas, null, null);
    if (!moved) {
      openPlaceStudentModal(null, { ...ghostAddPos });
    } else if (lastStudentsRoot) {
      applySeatingFit(lastStudentsRoot);
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** 학생 카드 드래그: 보이지 않는 그리드 빈 셀 직접 배치 + 카드 틈새 삽입 + 모둠 자동 확장 + 점선 '+' 새 모둠 드롭 */
function startStudentSeatDrag(ev, slotEl, canvas, baseBoxes) {
  const studentId = slotEl.dataset.seatStudent;
  const startClientX = ev.clientX;
  const startClientY = ev.clientY;
  let dragging = false;
  let ghost = null;
  let hoveredGroupId = null;
  let hoveredExactSlot = -1; // 빈 셀 직접 드롭 또는 틈새 삽입 슬롯 번호
  let hoveredIsEmptyCell = false;
  let hoveredGhostAdd = false;

  const clearHighlights = () => {
    canvas.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    canvas.querySelectorAll('.is-drop-cell').forEach((el) => el.classList.remove('is-drop-cell'));
    canvas.querySelectorAll('.is-insert-before, .is-insert-after').forEach((el) => {
      el.classList.remove('is-insert-before', 'is-insert-after');
    });
  };

  const onMove = (e) => {
    if (!dragging && Math.hypot(e.clientX - startClientX, e.clientY - startClientY) < 6) return;
    if (!dragging) {
      dragging = true;
      ghost = slotEl.cloneNode(true);
      ghost.classList.add('seat-drag-ghost');
      ghost.style.width = `${slotEl.getBoundingClientRect().width}px`;
      ghost.style.height = `${slotEl.getBoundingClientRect().height}px`;
      document.body.appendChild(ghost);
      slotEl.style.opacity = '0.35';
    }

    ghost.style.left = `${e.clientX - ghost.offsetWidth / 2}px`;
    ghost.style.top = `${e.clientY - ghost.offsetHeight / 2}px`;

    clearHighlights();
    hoveredGroupId = null;
    hoveredExactSlot = -1;
    hoveredIsEmptyCell = false;
    hoveredGhostAdd = false;

    // 1. 점선 '+' 새 모둠 카드 위인지 확인
    const ghostAddEl = canvas.querySelector('#group-ghost-add');
    if (ghostAddEl) {
      const gr = ghostAddEl.getBoundingClientRect();
      if (e.clientX >= gr.left && e.clientX <= gr.right && e.clientY >= gr.top && e.clientY <= gr.bottom) {
        hoveredGhostAdd = true;
        ghostAddEl.classList.add('is-drop-target');
        return;
      }
    }

    // 2. 어느 모둠 카드 위인지 판별 → 빈 그리드 셀 직접 지정 / 카드 틈새 삽입 / 하단 새 행 추가
    const groupEls = Array.from(canvas.querySelectorAll('[data-group-box]'));
    for (const gEl of groupEls) {
      const r = gEl.getBoundingClientRect();
      if (e.clientX >= r.left - 10 && e.clientX <= r.right + 10 && e.clientY >= r.top - 10 && e.clientY <= r.bottom + 14) {
        hoveredGroupId = gEl.dataset.groupBox;
        gEl.classList.add('is-drop-target');

        // 2-A. 보이지 않는 빈 그리드 셀 위에 직접 올린 경우 (중간 빈칸에 그대로 안착!)
        const emptyCells = Array.from(gEl.querySelectorAll('.seat-cell-empty'));
        for (const ec of emptyCells) {
          const er = ec.getBoundingClientRect();
          if (e.clientX >= er.left && e.clientX <= er.right && e.clientY >= er.top && e.clientY <= er.bottom) {
            ec.classList.add('is-drop-cell');
            hoveredExactSlot = Number(ec.dataset.emptySeatIndex);
            hoveredIsEmptyCell = true;
            return;
          }
        }

        // 2-B. 모둠 하단 푸터 근처에 올리면 새 행의 첫 칸으로 확장 배치
        const seatsWrap = gEl.querySelector('.group-seats');
        const srWrap = seatsWrap?.getBoundingClientRect();
        if (srWrap && e.clientY > srWrap.bottom - 4) {
          const box = baseBoxes.find((b) => b.id === hoveredGroupId);
          hoveredExactSlot = box ? box.totalSlots : 0;
          hoveredIsEmptyCell = true;
          return;
        }

        // 2-C. 기존 학생 카드 위 → 좌/우 틈새 삽입 위치 계산
        const slots = Array.from(gEl.querySelectorAll('.seat-slot[data-seat-student]')).filter((s) => s.dataset.seatStudent !== studentId);
        if (slots.length === 0) {
          hoveredExactSlot = 0;
          hoveredIsEmptyCell = true;
          return;
        }
        let closestSlot = slots[0];
        let closestDist = Infinity;
        let insertAfter = false;
        slots.forEach((s) => {
          const sr = s.getBoundingClientRect();
          const cx = (sr.left + sr.right) / 2;
          const cy = (sr.top + sr.bottom) / 2;
          const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
          if (dist < closestDist) {
            closestDist = dist;
            closestSlot = s;
            insertAfter = e.clientX > cx;
          }
        });
        if (closestSlot) {
          closestSlot.classList.add(insertAfter ? 'is-insert-after' : 'is-insert-before');
          const baseIdx = Number(closestSlot.dataset.seatIndex) || 0;
          hoveredExactSlot = insertAfter ? baseIdx + 1 : baseIdx;
          hoveredIsEmptyCell = false;
        }
        return;
      }
    }
  };

  const onUp = async () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    clearHighlights();
    slotEl.style.opacity = '';
    if (ghost) ghost.remove();

    // 드래그하지 않고 클릭만 한 경우 → 학생 카드 2개를 누르면 서로 자리 교환
    if (!dragging) {
      if (!swapSourceStudentId) {
        swapSourceStudentId = studentId;
        playSound('tick');
        if (lastStudentsRoot) renderStudentsView(lastStudentsRoot);
      } else if (swapSourceStudentId === studentId) {
        swapSourceStudentId = null;
        if (lastStudentsRoot) renderStudentsView(lastStudentsRoot);
      } else {
        const firstId = swapSourceStudentId;
        swapSourceStudentId = null;
        await swapTwoStudentSeats(firstId, studentId);
        playSound('confirm');
      }
      return;
    }

    swapSourceStudentId = null;

    if (hoveredGhostAdd && ghostAddPos) {
      const spawnPos = { ...ghostAddPos };
      ghostAddPos = null;
      await store.update((s) => {
        const newId = uid('grp');
        s.groups.push({
          id: newId,
          name: `그룹 ${s.groups.length + 1}`,
          order: s.groups.length,
          x: spawnPos.x,
          y: spawnPos.y,
          cols: 1,
        });
        const st = s.students.find((x) => x.id === studentId);
        if (st) {
          st.groupId = newId;
          st.seatIndex = 0;
        }
      });
      playSound('confirm');
      return;
    }

    if (hoveredGroupId && hoveredExactSlot >= 0) {
      await placeOrInsertStudentAtSlot(studentId, hoveredGroupId, hoveredExactSlot, hoveredIsEmptyCell);
      playSound('confirm');
    }
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** 학생 카드 2개 클릭 시 두 학생의 모둠(groupId)과 자리(seatIndex)를 1:1로 맞교환 (중간 빈칸 및 다른 학생 자리 유지) */
async function swapTwoStudentSeats(studentIdA, studentIdB) {
  await store.update((s) => {
    const active = s.students.filter((x) => !x.trashed);
    const boxes = ensureGroupLayout(s.groups, active);
    for (const b of boxes) {
      for (const [slotIdx, member] of b.seatMap.entries()) {
        member.seatIndex = slotIdx;
      }
    }
    const stA = s.students.find((x) => x.id === studentIdA);
    const stB = s.students.find((x) => x.id === studentIdB);
    if (!stA || !stB) return;

    const tmpGroup = stA.groupId;
    const tmpSeat = stA.seatIndex;
    stA.groupId = stB.groupId;
    stA.seatIndex = stB.seatIndex;
    stB.groupId = tmpGroup;
    stB.seatIndex = tmpSeat;
  });
}

/**
 * 학생을 모둠의 정확한 그리드 셀(seatIndex)에 배치하거나 틈새 삽입
 * - 모둠 내 자동 정렬/앞당김 금지! 기존 모둠의 빈칸 및 대상 모둠의 다른 빈칸 그대로 유지
 * - 틈새 삽입 시 충돌하는 연속 점유 셀만 한 칸씩 뒤로 밀림
 * - 인원/행 증가로 모둠이 커지면 바로 아래 충돌 모둠만 독립 밀림
 */
async function placeOrInsertStudentAtSlot(studentId, targetGroupId, targetSlotIdx, isEmptyCell) {
  await store.update((s) => {
    const st = s.students.find((x) => x.id === studentId);
    if (!st) return;

    const targetOthers = s.students.filter((x) => !x.trashed && x.groupId === targetGroupId && x.id !== studentId);
    const occupiedMap = new Map();
    for (const m of targetOthers) {
      let idx = Math.max(0, Math.trunc(Number(m.seatIndex) || 0));
      while (occupiedMap.has(idx)) idx++;
      m.seatIndex = idx;
      occupiedMap.set(idx, m);
    }

    if (isEmptyCell || !occupiedMap.has(targetSlotIdx)) {
      // 빈 셀 직접 배치: 다른 학생들 좌표 일절 건드리지 않음 (중간 빈칸 유지!)
      st.groupId = targetGroupId;
      st.seatIndex = Math.max(0, targetSlotIdx);
    } else {
      // 점유된 셀 틈새 삽입: targetSlotIdx부터 연속으로 겹치는 학생들만 +1 밀어 자리 확보
      let cursor = targetSlotIdx;
      const toShift = [];
      while (occupiedMap.has(cursor)) {
        toShift.push(occupiedMap.get(cursor));
        cursor++;
      }
      for (const shifted of toShift) {
        shifted.seatIndex = (Number(shifted.seatIndex) || 0) + 1;
      }
      st.groupId = targetGroupId;
      st.seatIndex = targetSlotIdx;
    }

    // 1명짜리 모둠에 2명 이상 들어오면 기본 2열로 자연 확장(이미 열 수 지정된 경우 유지)
    const tg = s.groups.find((g) => g.id === targetGroupId);
    const countNow = s.students.filter((x) => !x.trashed && x.groupId === targetGroupId).length;
    if (tg && !tg.cols && countNow >= 2) {
      tg.cols = 2;
    }

    // 커진 모둠과 겹치는 바로 아래 모둠만 독립적으로 아래로 밀기 (옆 열 모둠은 안 움직임)
    const active = s.students.filter((x) => !x.trashed);
    const updatedBoxes = ensureGroupLayout(s.groups, active);
    const resolved = resolveBoxCollisions(updatedBoxes, targetGroupId, 'y');
    resolved.forEach((b) => {
      const g = s.groups.find((x) => x.id === b.id);
      if (g) {
        g.x = b.x;
        g.y = b.y;
      }
    });
  });
}

/** 모둠 테두리 드래그 리사이즈 (가로·세로 모두 학생카드 1칸 단위로 증감) */
function startGroupResize(ev, groupId, dir, handleEl, canvas, baseBoxes) {
  const boxEl = canvas.querySelector(`[data-group-box="${groupId}"]`);
  const orig = baseBoxes.find((b) => b.id === groupId);
  if (!boxEl || !orig) return;

  const scale = getSeatingCanvasScale(canvas);
  const STEP_X = SEAT_W + SEAT_GAP;
  const STEP_Y = SEAT_H + SEAT_GAP;
  const memberCount = orig.seatMap ? orig.seatMap.size : 0;

  const hasE = dir.includes('e');
  const hasW = dir.includes('w');
  const hasS = dir.includes('s');
  const hasN = dir.includes('n');

  const startClientX = ev.clientX;
  const startClientY = ev.clientY;

  let curCols = orig.cols;
  let curRows = orig.rows;
  let curX = orig.x;
  let curY = orig.y;

  boxEl.classList.add('is-resizing');
  handleEl.classList.add('is-active');

  // 실시간 열×행 크기 배지
  const badge = document.createElement('div');
  badge.className = 'group-resize-badge';
  badge.textContent = `${curCols}열 × ${curRows}행`;
  boxEl.appendChild(badge);

  const calcBoxW = (c) => c * SEAT_W + (c - 1) * SEAT_GAP + GROUP_PAD_X;
  const calcBoxH = (r) => r * SEAT_H + (r - 1) * SEAT_GAP + GROUP_PAD_Y + FOOTER_H;

  boxEl.style.width = `${calcBoxW(curCols)}px`;
  boxEl.style.height = `${calcBoxH(curRows)}px`;

  const onMove = (e) => {
    const dx = (e.clientX - startClientX) / scale;
    const dy = (e.clientY - startClientY) / scale;

    const rawDeltaCols = hasE ? Math.round(dx / STEP_X) : hasW ? Math.round(-dx / STEP_X) : 0;
    const rawDeltaRows = hasS ? Math.round(dy / STEP_Y) : hasN ? Math.round(-dy / STEP_Y) : 0;

    let nextCols = Math.max(1, orig.cols + rawDeltaCols);
    // 왼쪽 테두리로 늘릴 때 캔버스 좌측 여백을 넘지 않도록 보정
    if (hasW && nextCols > orig.cols) {
      const maxLeftExpand = Math.max(0, Math.floor((orig.x - CANVAS_PAD) / STEP_X));
      nextCols = Math.min(nextCols, orig.cols + maxLeftExpand);
    }

    const minRowsForMembers = Math.max(1, Math.ceil(memberCount / nextCols));
    let nextRows = Math.max(minRowsForMembers, orig.rows + rawDeltaRows);
    // 위쪽 테두리로 늘릴 때 캔버스 상단 여백을 넘지 않도록 보정
    if (hasN && nextRows > orig.rows) {
      const maxTopExpand = Math.max(0, Math.floor((orig.y - CANVAS_PAD) / STEP_Y));
      nextRows = Math.min(nextRows, orig.rows + maxTopExpand);
    }

    const deltaCols = nextCols - orig.cols;
    const deltaRows = nextRows - orig.rows;
    const nextX = hasW ? Math.max(CANVAS_PAD, orig.x - deltaCols * STEP_X) : orig.x;
    const nextY = hasN ? Math.max(CANVAS_PAD, orig.y - deltaRows * STEP_Y) : orig.y;

    if (nextCols !== curCols || nextRows !== curRows || nextX !== curX || nextY !== curY) {
      curCols = nextCols;
      curRows = nextRows;
      curX = nextX;
      curY = nextY;

      boxEl.style.left = `${curX}px`;
      boxEl.style.top = `${curY}px`;
      boxEl.style.width = `${calcBoxW(curCols)}px`;
      boxEl.style.height = `${calcBoxH(curRows)}px`;
      badge.textContent = `${curCols}열 × ${curRows}행`;
      if (lastStudentsRoot) applySeatingFit(lastStudentsRoot);
    }
  };

  const onUp = async () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    boxEl.classList.remove('is-resizing');
    handleEl.classList.remove('is-active');
    badge.remove();

    if (curCols === orig.cols && curRows === orig.rows && curX === orig.x && curY === orig.y) {
      boxEl.style.height = '';
      return;
    }

    const shiftCol = hasW ? curCols - orig.cols : 0;
    const shiftRow = hasN ? curRows - orig.rows : 0;
    await applyGroupGridResize(groupId, curCols, curRows, {
      shiftCol,
      shiftRow,
      nextX: curX,
      nextY: curY,
      preferAxis: (hasE || hasW) && !(hasS || hasN) ? 'x' : (hasS || hasN) && !(hasE || hasW) ? 'y' : 'auto',
    });
    playSound('confirm');
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/** 모둠 가로·세로 칸 수 적용 (학생 유실 없이 기존 좌표 유지 + 범위 밖 학생 빈칸 재배치 + 충돌 밀림) */
async function applyGroupGridResize(groupId, newCols, newRows, opts = {}) {
  const { shiftCol = 0, shiftRow = 0, nextX, nextY, preferAxis = 'auto' } = opts;
  await store.update((s) => {
    const g = s.groups.find((x) => x.id === groupId);
    if (!g) return;
    const members = s.students.filter((x) => !x.trashed && x.groupId === groupId);
    const oldCols = Math.max(1, Number(g.cols) || (members.length <= 1 ? 1 : 2));
    const finalCols = Math.max(1, Math.trunc(Number(newCols) || oldCols));
    const minRowsForMembers = Math.max(1, Math.ceil(members.length / finalCols));
    const finalRows = Math.max(minRowsForMembers, Math.trunc(Number(newRows) || 1));

    const used = new Set();
    const sorted = [...members].sort((a, b) => (Number(a.seatIndex) || 0) - (Number(b.seatIndex) || 0));
    const overflow = [];

    for (const m of sorted) {
      const oldIdx = Math.max(0, Math.trunc(Number(m.seatIndex) || 0));
      const r = Math.floor(oldIdx / oldCols) + shiftRow;
      const c = (oldIdx % oldCols) + shiftCol;
      if (r >= 0 && r < finalRows && c >= 0 && c < finalCols) {
        const nextIdx = r * finalCols + c;
        if (!used.has(nextIdx)) {
          m.seatIndex = nextIdx;
          used.add(nextIdx);
          continue;
        }
      }
      overflow.push(m);
    }

    for (const m of overflow) {
      let idx = 0;
      while (used.has(idx)) idx++;
      m.seatIndex = idx;
      used.add(idx);
    }

    g.cols = finalCols;
    g.rows = finalRows;
    if (Number.isFinite(nextX)) g.x = Math.max(CANVAS_PAD, Math.round(nextX));
    if (Number.isFinite(nextY)) g.y = Math.max(CANVAS_PAD, Math.round(nextY));

    const active = s.students.filter((x) => !x.trashed);
    const updatedBoxes = ensureGroupLayout(s.groups, active);
    const resolved = resolveBoxCollisions(updatedBoxes, groupId, preferAxis);
    resolved.forEach((b) => {
      const grp = s.groups.find((x) => x.id === b.id);
      if (grp) {
        grp.x = b.x;
        grp.y = b.y;
      }
    });
  });
}

/** 점선 '+' 카드 클릭 시: 미배치 학생 배치 또는 새 모둠/학생 생성 팝오버 */
function openPlaceStudentModal(targetGroupId, newGroupCoords) {
  const state = store.getState();
  const active = state.students.filter((s) => !s.trashed);
  const unassigned = active.filter((s) => !s.groupId || !state.groups.some((g) => g.id === s.groupId));
  const isNewGroup = !targetGroupId;

  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  backdrop.innerHTML = `
    <div class="dialog-card" style="width:430px;">
      <div class="dialog-header">
        <h2>${isNewGroup ? '새 모둠 추가 및 학생 배치' : '이 모둠에 학생 배치'}</h2>
        <button type="button" class="dialog-close">&times;</button>
      </div>
      <div class="dialog-body">
        ${isNewGroup ? `
          <label class="field-label">
            <span>새 모둠 이름</span>
            <input type="text" id="new-grp-name" value="그룹 ${state.groups.length + 1}" maxlength="20">
          </label>
          <button type="button" class="btn-yellow" id="btn-create-empty-grp">빈 모둠만 먼저 만들기</button>
          <div class="settings-divider"></div>
        ` : ''}

        <div>
          <strong style="display:block;font-size:13px;color:#5b5040;margin-bottom:8px;">
            미배치 학생 선택 (${unassigned.length}명)
          </strong>
          ${unassigned.length === 0 ? `
            <p style="margin:0 0 10px;font-size:12px;color:#8c8476;">
              미배치 학생이 없습니다. 기존 학생 카드의 × 버튼으로 학생을 뺀 뒤 여기에 배치하거나 새 학생을 추가할 수 있습니다.
            </p>
          ` : `
            <div class="unassigned-popover-list">
              ${unassigned.map((s) => `
                <button type="button" class="unassigned-pick-item" data-pick-unassigned="${s.id}">
                  <img src="${getStillAvatarUrl(s.avatarId)}" alt="">
                  <span>${s.number}번 ${escapeHtml(s.name)}</span>
                  <span style="margin-left:auto;color:var(--blue-score);font-size:13px;">${s.score}점</span>
                </button>
              `).join('')}
            </div>
          `}
        </div>
      </div>
      <div class="dialog-footer" style="justify-content:space-between;">
        <button type="button" class="btn-outline" id="btn-open-new-student">+ 새 학생 등록</button>
        <button type="button" class="btn-ghost" data-close>닫기</button>
      </div>
    </div>
  `;

  modalRoot.appendChild(backdrop);
  backdrop.querySelector('.dialog-close').onclick = close;
  backdrop.querySelector('[data-close]').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  const createGroupAndMaybePlace = async (studentId) => {
    const nameInput = backdrop.querySelector('#new-grp-name');
    const name = (nameInput?.value || '').trim() || `그룹 ${store.getState().groups.length + 1}`;
    const pos = newGroupCoords || { x: 40, y: 40 };
    ghostAddPos = null;
    await store.update((s) => {
      const gid = uid('grp');
      s.groups.push({ id: gid, name, order: s.groups.length, x: pos.x, y: pos.y, cols: 1 });
      if (studentId) {
        const st = s.students.find((x) => x.id === studentId);
        if (st) {
          st.groupId = gid;
          st.seatIndex = 0;
        }
      }
    });
    playSound('confirm');
    close();
  };

  const emptyBtn = backdrop.querySelector('#btn-create-empty-grp');
  if (emptyBtn) emptyBtn.onclick = () => createGroupAndMaybePlace(null);

  backdrop.querySelectorAll('[data-pick-unassigned]').forEach((b) => {
    b.onclick = async () => {
      const stId = b.dataset.pickUnassigned;
      if (isNewGroup) {
        await createGroupAndMaybePlace(stId);
      } else {
        await placeOrInsertStudentAtSlot(stId, targetGroupId, 0, false);
        playSound('confirm');
        close();
      }
    };
  });

  backdrop.querySelector('#btn-open-new-student').onclick = () => {
    close();
    openStudentEditModal(null, targetGroupId);
  };
}

/** 학생 추가 / 수정 모달 (70종 아바타 선택 + 휴지통 이동) */
export function openStudentEditModal(studentId = null, defaultGroupId = null, onSaved = null) {
  const state = store.getState();
  const existing = studentId ? state.students.find((s) => s.id === studentId) : null;
  const active = state.students.filter((s) => !s.trashed);
  const nextNumber = existing ? existing.number : (Math.max(0, ...active.map((s) => s.number)) + 1);

  let pickedAvatar = existing ? existing.avatarId : ((active.length % 70) + 1);

  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';

  const close = () => backdrop.remove();
  const preselectedGroup = existing?.groupId || defaultGroupId || state.groups[0]?.id || '';

  backdrop.innerHTML = `
    <form class="dialog-card">
      <div class="dialog-header">
        <h2>${existing ? '학생 정보 수정' : '새 학생 추가'}</h2>
        <button type="button" class="dialog-close">&times;</button>
      </div>
      <div class="dialog-body">
        <div class="field-row">
          <label class="field-label">
            <span>번호</span>
            <input type="number" name="number" min="1" max="999" value="${nextNumber}" required>
          </label>
          <label class="field-label">
            <span>이름</span>
            <input type="text" name="name" maxlength="20" value="${escapeAttr(existing?.name || '')}" placeholder="학생 이름" required autofocus>
          </label>
        </div>
        <div class="field-row">
          <label class="field-label">
            <span>모둠</span>
            <select name="groupId">
              <option value="">미배치</option>
              ${state.groups.map((g) => `<option value="${g.id}" ${preselectedGroup === g.id ? 'selected' : ''}>${escapeHtml(g.name)}</option>`).join('')}
            </select>
          </label>
          <label class="field-label">
            <span>성별 (뽑기 필터용)</span>
            <select name="gender">
              <option value="F" ${existing?.gender === 'F' ? 'selected' : ''}>여자</option>
              <option value="M" ${existing?.gender === 'M' ? 'selected' : ''}>남자</option>
            </select>
          </label>
        </div>
        <div class="field-row">
          <label class="field-label">
            <span>학생 접속 아이디</span>
            <input type="text" name="loginId" maxlength="24" value="${escapeAttr(existing?.loginId || `s${String(nextNumber).padStart(2, '0')}`)}" placeholder="예: s01" required>
          </label>
          <label class="field-label">
            <span>접속 비밀번호</span>
            <input type="text" name="loginPw" maxlength="24" value="${escapeAttr(existing?.loginPw ?? '1234')}" placeholder="예: 1234" required>
          </label>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:#4f4638;cursor:pointer;">
          <input type="checkbox" name="loginEnabled" ${existing?.loginEnabled !== false ? 'checked' : ''}>
          <span>학생용 과제 페이지 로그인 허용</span>
        </label>
        <div class="field-label">
          <span>아바타 선택 (70종)</span>
          <div class="avatar-picker-grid">
            ${Array.from({ length: 70 }, (_, i) => {
              const id = i + 1;
              return `
                <button type="button" class="avatar-pick-btn ${pickedAvatar === id ? 'is-selected' : ''}" data-av-id="${id}">
                  <img src="${getStillAvatarUrl(id)}" alt="아바타 ${id}" loading="lazy">
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>
      <div class="dialog-footer" style="justify-content:space-between;">
        <div>
          ${existing ? `<button type="button" class="btn-danger-outline" id="btn-trash-student">휴지통으로 이동</button>` : ''}
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn-ghost" data-cancel>취소</button>
          <button type="submit" class="btn-yellow">${existing ? '수정 저장' : '학생 추가'}</button>
        </div>
      </div>
    </form>
  `;

  modalRoot.appendChild(backdrop);

  backdrop.querySelector('.dialog-close').onclick = close;
  backdrop.querySelector('[data-cancel]').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  backdrop.querySelectorAll('[data-av-id]').forEach((btn) => {
    btn.onclick = () => {
      pickedAvatar = Number(btn.dataset.avId);
      backdrop.querySelectorAll('[data-av-id]').forEach((x) => x.classList.remove('is-selected'));
      btn.classList.add('is-selected');
    };
  });

  const trashBtn = backdrop.querySelector('#btn-trash-student');
  if (trashBtn && existing) {
    trashBtn.onclick = async () => {
      if (!confirm(`${existing.name} 학생을 휴지통으로 이동할까요? (나중에 복원할 수 있습니다)`)) return;
      await store.update((s) => {
        const st = s.students.find((x) => x.id === existing.id);
        if (st) st.trashed = true;
      });
      selectedIds.delete(existing.id);
      showToast({ title: `${existing.name} 학생을 휴지통으로 옮겼습니다.` });
      close();
      onSaved?.();
    };
  }

  backdrop.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const num = Math.max(1, Number(fd.get('number')) || 1);
    const name = String(fd.get('name') || '').trim();
    const groupId = String(fd.get('groupId') || '') || null;
    const gender = String(fd.get('gender') || 'F');
    const loginId = String(fd.get('loginId') || '').trim() || `s${String(num).padStart(2, '0')}`;
    const loginPw = String(fd.get('loginPw') || '').trim() || '1234';
    const loginEnabled = fd.get('loginEnabled') === 'on';
    if (!name) return;

    const dup = store.getState().students.find((x) => !x.trashed && x.id !== existing?.id && (x.loginId || '').toLowerCase() === loginId.toLowerCase());
    if (dup) {
      showToast({ title: `아이디 '${loginId}'는 ${dup.number}번 ${dup.name} 학생이 이미 사용 중입니다.`, tone: 'minus' });
      return;
    }

    await store.update((s) => {
      if (existing) {
        const st = s.students.find((x) => x.id === existing.id);
        if (st) {
          st.number = num;
          st.name = name;
          st.gender = gender;
          st.avatarId = pickedAvatar;
          st.loginId = loginId;
          st.loginPw = loginPw;
          st.loginEnabled = loginEnabled;
          if (st.groupId !== groupId) {
            st.groupId = groupId;
            if (groupId) {
              const used = s.students.filter((x) => !x.trashed && x.groupId === groupId && x.id !== st.id).map((x) => x.seatIndex);
              let idx = 0;
              while (used.includes(idx)) idx++;
              st.seatIndex = idx;
            } else {
              st.seatIndex = 0;
            }
          }
        }
      } else {
        let idx = 0;
        if (groupId) {
          const used = s.students.filter((x) => !x.trashed && x.groupId === groupId).map((x) => x.seatIndex);
          while (used.includes(idx)) idx++;
        }
        s.students.push({
          id: uid('st'),
          number: num,
          name,
          gender,
          avatarId: pickedAvatar,
          groupId,
          seatIndex: idx,
          positive: 0,
          negative: 0,
          score: 0,
          absent: false,
          trashed: false,
          loginId,
          loginPw,
          loginEnabled,
        });
      }
    });
    playSound('confirm');
    close();
    onSaved?.();
  };
}

/** 학생 설정 모달 (개별 학생 정보·아바타 편집 + 접속 계정 ID/PW + 명단 일괄 붙여넣기 + 휴지통 복원) */
export function openRosterManagerModal() {
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  const renderModal = () => {
    const state = store.getState();
    const activeStudents = state.students.filter((s) => !s.trashed).sort((a, b) => a.number - b.number);
    const trashed = state.students.filter((s) => s.trashed);
    const groupNameById = new Map((state.groups || []).map((g) => [g.id, g.name]));

    backdrop.innerHTML = `
      <div class="dialog-card is-wide">
        <div class="dialog-header">
          <h2>학생 설정 · 개별 편집(아바타/모둠) · 접속 계정 · 명단 · 휴지통</h2>
          <button type="button" class="dialog-close">&times;</button>
        </div>
        <div class="dialog-body" style="max-height:76vh;overflow-y:auto;">
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
              <h3 style="margin:0;font-size:14px;color:#3f3629;">👥 학생 정보 · 아바타 · 접속 계정 관리 (${activeStudents.length}명)</h3>
              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <button type="button" class="btn-outline" id="btn-roster-add-student" style="padding:4px 10px;font-size:12px;font-weight:800;">+ 새 학생 추가</button>
                <button type="button" class="btn-outline" id="btn-acc-auto-num" style="padding:4px 9px;font-size:12px;">번호별 일괄생성(s01/1234)</button>
                <button type="button" class="btn-outline" id="btn-acc-rand-pw" style="padding:4px 9px;font-size:12px;">4자리 랜덤비번</button>
                <button type="button" class="btn-outline" id="btn-acc-copy" style="padding:4px 9px;font-size:12px;">안내표 복사</button>
                <button type="button" class="btn-yellow" id="btn-acc-save" style="padding:4px 12px;font-size:12px;">계정 저장</button>
              </div>
            </div>
            <div style="max-height:260px;overflow-y:auto;border:1px solid #e4dfd0;border-radius:8px;background:#fff;">
              <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
                <thead>
                  <tr style="background:#f7f5ee;color:#5d5242;text-align:left;position:sticky;top:0;z-index:1;">
                    <th style="padding:6px 8px;width:48px;">번호</th>
                    <th style="padding:6px 8px;width:136px;">학생 / 모둠</th>
                    <th style="padding:6px 8px;">접속 아이디</th>
                    <th style="padding:6px 8px;">비밀번호</th>
                    <th style="padding:6px 8px;width:46px;text-align:center;">허용</th>
                    <th style="padding:6px 8px;width:82px;text-align:center;">학생편집</th>
                  </tr>
                </thead>
                <tbody>
                  ${activeStudents.map((st) => `
                    <tr style="border-top:1px solid #f0ede3;" data-acc-row="${st.id}">
                      <td style="padding:5px 8px;font-weight:700;color:#7a7162;">${st.number}</td>
                      <td style="padding:4px 8px;">
                        <div style="display:flex;align-items:center;gap:6px;">
                          <img src="${getStillAvatarUrl(st.avatarId)}" alt="" style="width:28px;height:32px;object-fit:contain;flex-shrink:0;">
                          <div style="min-width:0;">
                            <div style="font-weight:800;color:#3d352a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(st.name)}</div>
                            <div style="font-size:11px;color:#887f70;">${escapeHtml(groupNameById.get(st.groupId) || '미배치')}</div>
                          </div>
                        </div>
                      </td>
                      <td style="padding:4px 6px;"><input type="text" data-acc-id="${st.id}" value="${escapeAttr(st.loginId || '')}" maxlength="24" style="width:100%;height:28px;padding:0 8px;border:1px solid #d9d3c3;border-radius:6px;font-size:12.5px;"></td>
                      <td style="padding:4px 6px;"><input type="text" data-acc-pw="${st.id}" value="${escapeAttr(st.loginPw ?? '1234')}" maxlength="24" style="width:100%;height:28px;padding:0 8px;border:1px solid #d9d3c3;border-radius:6px;font-size:12.5px;"></td>
                      <td style="padding:4px 6px;text-align:center;"><input type="checkbox" data-acc-en="${st.id}" ${st.loginEnabled !== false ? 'checked' : ''}></td>
                      <td style="padding:4px 6px;text-align:center;">
                        <button type="button" class="btn-outline" data-edit-roster-st="${st.id}" style="padding:4px 8px;font-size:11.5px;white-space:nowrap;">✏️ 편집</button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          </div>

          <div class="settings-divider"></div>

          <div class="field-label">
            <span>명단 일괄 붙여넣기 (엑셀/한글에서 복사해 붙여넣으세요)</span>
            <p style="margin:0;font-size:12px;color:#887f70;font-weight:400;">
              형식: <code>이름</code> 또는 <code>번호[탭/쉼표]이름[탭/쉼표]성별(남/여)[탭/쉼표]모둠명</code> (한 줄에 한 명)
            </p>
            <textarea id="paste-roster-area" rows="6" placeholder="예:&#10;1&#9;김민수&#9;남&#9;그룹 1&#10;2&#9;이서현&#9;여&#9;그룹 1&#10;박지훈"></textarea>
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button type="button" class="btn-outline" id="btn-paste-append">기존 명단에 추가</button>
            <button type="button" class="btn-yellow" id="btn-paste-replace">기존 명단 교체 등록</button>
          </div>

          <div class="settings-divider"></div>

          <div>
            <h3 style="margin:0 0 8px;font-size:14px;color:#5d5242;">🗑 학생 휴지통 (${trashed.length}명)</h3>
            ${trashed.length === 0 ? `<p style="margin:0;font-size:12px;color:#999;">휴지통에 있는 학생이 없습니다.</p>` : `
              <div style="display:flex;flex-direction:column;gap:6px;max-height:180px;overflow-y:auto;">
                ${trashed.map((t) => `
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:#f7f5ee;border-radius:7px;">
                    <span><strong>${t.number}번 ${escapeHtml(t.name)}</strong> (점수 ${t.score}점)</span>
                    <div style="display:flex;gap:6px;">
                      <button type="button" class="btn-outline" data-restore-st="${t.id}" style="padding:4px 10px;font-size:12px;">복원</button>
                      <button type="button" class="btn-danger-outline" data-purge-st="${t.id}" style="padding:4px 10px;font-size:12px;">영구삭제</button>
                    </div>
                  </div>
                `).join('')}
              </div>
            `}
          </div>
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn-ghost" data-close>닫기</button>
        </div>
      </div>
    `;

    backdrop.querySelector('.dialog-close').onclick = close;
    backdrop.querySelector('[data-close]').onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

    // 개별 학생 편집(번호·이름·모둠·성별·70종 아바타·휴지통 이동) 및 새 학생 추가
    const rosterAddBtn = backdrop.querySelector('#btn-roster-add-student');
    if (rosterAddBtn) {
      rosterAddBtn.onclick = () => openStudentEditModal(null, null, renderModal);
    }
    backdrop.querySelectorAll('[data-edit-roster-st]').forEach((btn) => {
      btn.onclick = () => openStudentEditModal(btn.dataset.editRosterSt, null, renderModal);
    });

    // 학생 접속 계정(ID/PW) 일괄 관리 핸들러
    backdrop.querySelector('#btn-acc-auto-num').onclick = async () => {
      if (!confirm('모든 학생의 접속 아이디를 s01, s02... 형태로, 비밀번호를 1234로 일괄 설정할까요?')) return;
      await store.update((s) => {
        s.students.filter((x) => !x.trashed).forEach((st) => {
          st.loginId = `s${String(st.number).padStart(2, '0')}`;
          st.loginPw = '1234';
          st.loginEnabled = true;
        });
      });
      playSound('confirm');
      showToast({ title: '번호별 접속 계정을 일괄 생성했습니다.', tone: 'plus' });
      renderModal();
    };

    backdrop.querySelector('#btn-acc-rand-pw').onclick = async () => {
      if (!confirm('모든 학생의 비밀번호를 4자리 무작위 숫자로 새로 생성할까요?')) return;
      await store.update((s) => {
        s.students.filter((x) => !x.trashed).forEach((st) => {
          st.loginPw = String(1000 + Math.floor(Math.random() * 9000));
        });
      });
      playSound('confirm');
      showToast({ title: '4자리 랜덤 비밀번호를 생성했습니다.', tone: 'plus' });
      renderModal();
    };

    backdrop.querySelector('#btn-acc-copy').onclick = async () => {
      const rows = activeStudents.map((st) => `${st.number}번\t${st.name}\t아이디: ${st.loginId}\t비번: ${st.loginPw}`);
      const text = `[${state.classInfo?.name || '우리 반'} 학생 접속 계정 안내]\n` + rows.join('\n');
      try {
        await navigator.clipboard.writeText(text);
        showToast({ title: '학생 계정 안내표를 클립보드에 복사했습니다!', tone: 'plus' });
      } catch {
        prompt('아래 계정 안내표를 복사하세요:', text);
      }
    };

    backdrop.querySelector('#btn-acc-save').onclick = async () => {
      const updates = [];
      const seen = new Set();
      for (const st of activeStudents) {
        const idVal = String(backdrop.querySelector(`[data-acc-id="${st.id}"]`)?.value || '').trim();
        const pwVal = String(backdrop.querySelector(`[data-acc-pw="${st.id}"]`)?.value || '').trim();
        const enVal = Boolean(backdrop.querySelector(`[data-acc-en="${st.id}"]`)?.checked);
        if (!idVal) {
          showToast({ title: `${st.number}번 ${st.name}의 아이디를 입력해 주세요.`, tone: 'minus' });
          return;
        }
        const key = idVal.toLowerCase();
        if (seen.has(key)) {
          showToast({ title: `중복된 아이디가 있습니다: ${idVal}`, tone: 'minus' });
          return;
        }
        seen.add(key);
        updates.push({ id: st.id, loginId: idVal, loginPw: pwVal || '1234', loginEnabled: enVal });
      }
      await store.update((s) => {
        for (const u of updates) {
          const target = s.students.find((x) => x.id === u.id);
          if (target) {
            target.loginId = u.loginId;
            target.loginPw = u.loginPw;
            target.loginEnabled = u.loginEnabled;
          }
        }
      });
      playSound('confirm');
      showToast({ title: '학생 접속 계정이 저장되었습니다!', tone: 'plus' });
      renderModal();
    };

    const handlePaste = async (replaceAll) => {
      const text = backdrop.querySelector('#paste-roster-area').value;
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (lines.length === 0) {
        showToast({ title: '붙여넣을 명단을 입력해주세요.', tone: 'minus' });
        return;
      }
      if (replaceAll && !confirm(`기존 학생 명단을 모두 교체하고 ${lines.length}명을 등록할까요?`)) return;

      await store.update((s) => {
        if (replaceAll) s.students = [];
        let autoNum = Math.max(0, ...s.students.filter((x) => !x.trashed).map((x) => x.number)) + 1;
        let idxOffset = s.students.length;

        for (const line of lines) {
          const cols = line.split(/[\t,]+/).map((c) => c.trim()).filter(Boolean);
          if (cols.length === 0) continue;
          if (/^(번호|no|이름|성명)$/i.test(cols[0])) continue;

          let num = autoNum;
          let name = cols[0];
          let gender = 'F';
          let groupName = '';

          if (/^\d+$/.test(cols[0]) && cols[1]) {
            num = Number(cols[0]);
            name = cols[1];
            if (cols[2]) {
              if (/남|m/i.test(cols[2])) gender = 'M';
              else if (/여|f/i.test(cols[2])) gender = 'F';
              else groupName = cols[2];
            }
            if (cols[3]) groupName = cols[3];
          } else {
            if (cols[1] && /남|m/i.test(cols[1])) gender = 'M';
            else if (cols[1] && !/여|f/i.test(cols[1])) groupName = cols[1];
          }
          autoNum = Math.max(autoNum + 1, num + 1);

          let group = groupName ? s.groups.find((g) => g.name === groupName) : null;
          if (groupName && !group) {
            group = { id: uid('grp'), name: groupName, order: s.groups.length };
            s.groups.push(group);
          }
          if (!group) {
            const gIdx = Math.floor(idxOffset / 4) % Math.max(1, s.groups.length);
            group = s.groups[gIdx];
          }

          const usedSeats = s.students.filter((x) => !x.trashed && x.groupId === group.id).map((x) => x.seatIndex);
          let seatIndex = 0;
          while (usedSeats.includes(seatIndex)) seatIndex++;

          s.students.push({
            id: uid('st'),
            number: num,
            name,
            gender,
            avatarId: (idxOffset % 70) + 1,
            groupId: group.id,
            seatIndex,
            positive: 0,
            negative: 0,
            score: 0,
            absent: false,
            trashed: false,
          });
          idxOffset++;
        }
      });

      playSound('confirm');
      showToast({ title: '명단 등록이 완료되었습니다!', tone: 'plus' });
      close();
    };

    backdrop.querySelector('#btn-paste-append').onclick = () => handlePaste(false);
    backdrop.querySelector('#btn-paste-replace').onclick = () => handlePaste(true);

    backdrop.querySelectorAll('[data-restore-st]').forEach((b) => {
      b.onclick = async () => {
        await store.update((s) => {
          const st = s.students.find((x) => x.id === b.dataset.restoreSt);
          if (!st) return;
          st.trashed = false;
          if (st.groupId) {
            const used = s.students.filter((x) => !x.trashed && x.id !== st.id && x.groupId === st.groupId).map((x) => x.seatIndex);
            if (used.includes(st.seatIndex)) {
              let i = 0;
              while (used.includes(i)) i++;
              st.seatIndex = i;
            }
          }
        });
        playSound('confirm');
        renderModal();
      };
    });

    backdrop.querySelectorAll('[data-purge-st]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('이 학생을 완전히 삭제할까요? 되돌릴 수 없습니다.')) return;
        await store.update((s) => {
          s.students = s.students.filter((x) => x.id !== b.dataset.purgeSt);
        });
        renderModal();
      };
    });
  };

  modalRoot.appendChild(backdrop);
  renderModal();
}

/** 점수 초기화 선택 모달 */
function openResetScoreModal() {
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  const selCount = selectedIds.size;

  backdrop.innerHTML = `
    <div class="dialog-card">
      <div class="dialog-header">
        <h2>↺ 점수 초기화</h2>
        <button type="button" class="dialog-close">&times;</button>
      </div>
      <div class="dialog-body">
        <p style="margin:0;font-size:13px;color:#6d6456;line-height:1.5;">
          초기화할 범위를 선택하세요. 초기화 내역은 점수 이력에 기록됩니다.
        </p>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <button type="button" class="btn-outline" id="rst-selected" ${selCount === 0 ? 'disabled' : ''} style="justify-content:space-between;padding:12px 16px;">
            <span>선택한 학생(${selCount}명) 개인 점수만 0점으로 초기화</span>
            <span>→</span>
          </button>
          <button type="button" class="btn-outline" id="rst-all-students" style="justify-content:space-between;padding:12px 16px;">
            <span>전체 학생 개인 점수 초기화 (학급 황금알 유지)</span>
            <span>→</span>
          </button>
          <button type="button" class="btn-danger-outline" id="rst-all-with-eggs" style="justify-content:space-between;padding:12px 16px;">
            <span>개인 점수 + 학급 황금알·별길 모두 0으로 초기화</span>
            <span>⚠</span>
          </button>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn-ghost" data-close>취소</button>
      </div>
    </div>
  `;

  modalRoot.appendChild(backdrop);
  backdrop.querySelector('.dialog-close').onclick = close;
  backdrop.querySelector('[data-close]').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  backdrop.querySelector('#rst-selected').onclick = async () => {
    if (!confirm(`선택한 ${selCount}명의 개인 점수를 0으로 초기화할까요?`)) return;
    await resetScores({ scope: 'selected', studentIds: Array.from(selectedIds) });
    selectedIds.clear();
    playSound('confirm');
    showToast({ title: '선택 학생 점수를 초기화했습니다.' });
    close();
  };

  backdrop.querySelector('#rst-all-students').onclick = async () => {
    if (!confirm('전체 학생의 개인 점수를 모두 0으로 초기화할까요? (황금알은 유지됩니다)')) return;
    await resetScores({ scope: 'all-students' });
    playSound('confirm');
    showToast({ title: '전체 학생 개인 점수를 초기화했습니다.' });
    close();
  };

  backdrop.querySelector('#rst-all-with-eggs').onclick = async () => {
    if (!confirm('정말로 개인 점수와 학급 황금알·별길을 모두 초기화할까요?')) return;
    await resetScores({ scope: 'all-with-eggs' });
    playSound('confirm');
    showToast({ title: '학급 전체 점수와 황금알을 초기화했습니다.' });
    close();
  };
}
