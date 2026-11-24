// 만능칠판 6.0 풀스크린 뷰 — 다중 플로팅 패널(학생목록·자리배치·체크표·타이머 동시 열기 & 위치/크기 개별 기억)
// + 학급점수 3단 순환(끄기 → 황금알 나무 → 만능칠판 6.0 원본 점수판) + 학생 과제 이미지 수신 브리지

import { store, todayIso } from '../store.js';
import { playSound } from '../audio.js';
import { adjustSpecialEggs } from '../score-engine.js';
import { openScoreComposer, presentOutcome, showToast, escapeHtml } from '../effects.js';
import {
  renderStudentsView,
  setStudentsSubView,
  refitStudentsView,
  getSelectedStudentIds,
} from './students.js';
import { renderGrowthView } from './growth.js';
import { renderTimerView } from './tools.js';

const PANEL_LAYOUTS_LS_KEY = 'cr2_wb_panel_layouts_v1';
const BOARD6_WIDTH_LS_KEY = 'cr2_wb_board6_width_v1';
const BOARD6_UI_LS_KEY = 'cr2_wb_board6_ui_v1';

let mounted = false;
let wbIframeReady = false;
let pendingImportItems = null;
let navigateFn = null;
let exitHandler = null;
let lastWbContainer = null;
let lastToolbarRect = null;
let lastPopupRects = [];
let lastIframeModalOpen = false;

// 다중 플로팅 패널 상태 (종류별 독립 열기/접기/z-index/위치·크기 기억)
const ALL_PANEL_KINDS = ['students', 'seats', 'selfcheck', 'timer'];
const openPanels = new Set(); // 동시에 여러 패널 열기 가능
const panelCollapsedMap = {}; // { [kind]: boolean }
const panelZMap = {}; // { [kind]: number }
let topPanelZ = 45;
let panelLayouts = loadSavedPanelLayouts();
let activeSelfCheckId = null;

// 학급점수 오버레이 상태 (도구 버튼 순차 클릭: off -> tree -> board6 -> off)
let scoreOverlayMode = 'off';
let board6Width = loadSavedBoard6Width();
let board6Ui = loadSavedBoard6Ui(); // { layoutMode, fixedColumns, cardRatio, scale, full }
let wb6SettingsOpen = false;
const wb6SelectedGroupIds = new Set();
let wb6BatchDelta = 0;
let wb6UndoStack = [];
let wb6PrevColumns = null;
let wb6ResizeObserver = null;

function loadSavedPanelLayouts() {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_LAYOUTS_LS_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function savePanelLayouts() {
  try {
    localStorage.setItem(PANEL_LAYOUTS_LS_KEY, JSON.stringify(panelLayouts));
  } catch {}
}

function loadSavedBoard6Width() {
  try {
    const n = Number(localStorage.getItem(BOARD6_WIDTH_LS_KEY));
    if (Number.isFinite(n) && n >= 220 && n <= 900) return n;
  } catch {}
  return 360;
}

function saveBoard6Width(w) {
  try { localStorage.setItem(BOARD6_WIDTH_LS_KEY, String(Math.round(w))); } catch {}
}

function loadSavedBoard6Ui() {
  try {
    const raw = JSON.parse(localStorage.getItem(BOARD6_UI_LS_KEY) || '{}');
    return {
      layoutMode: raw.layoutMode === 'fixed' ? 'fixed' : 'auto',
      fixedColumns: Math.max(1, Math.min(6, Number(raw.fixedColumns) || 2)),
      cardRatio: raw.cardRatio === '16:9' ? '16:9' : '4:3',
      scale: Math.max(60, Math.min(150, Number(raw.scale) || 100)),
      full: false,
    };
  } catch {
    return { layoutMode: 'auto', fixedColumns: 2, cardRatio: '4:3', scale: 100, full: false };
  }
}

function saveBoard6Ui() {
  try {
    localStorage.setItem(BOARD6_UI_LS_KEY, JSON.stringify({
      layoutMode: board6Ui.layoutMode,
      fixedColumns: board6Ui.fixedColumns,
      cardRatio: board6Ui.cardRatio,
      scale: board6Ui.scale,
    }));
  } catch {}
}

function getPanelLayout(kind) {
  const saved = panelLayouts[kind];
  if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
    return saved;
  }
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  if (kind === 'timer') {
    return { left: Math.max(24, vw - 460), top: 24, width: 420, height: 390 };
  }
  if (kind === 'selfcheck') {
    return { left: 56, top: 48, width: Math.min(640, Math.max(400, vw - 200)), height: Math.min(460, Math.max(320, vh - 160)) };
  }
  if (kind === 'seats') {
    return { left: 48, top: 36, width: Math.min(820, Math.max(500, vw - 220)), height: Math.min(520, Math.max(360, vh - 150)) };
  }
  return { left: 24, top: 20, width: Math.min(820, Math.max(500, vw - 220)), height: Math.min(520, Math.max(360, vh - 150)) };
}

export function setWhiteboardNavigator(fn) {
  navigateFn = fn;
}

export function setWhiteboardExitHandler(fn) {
  exitHandler = fn;
}

function notifyToolbarState() {
  const iframe = document.getElementById('cr2-whiteboard-frame');
  if (!iframe || !iframe.contentWindow) return;
  try {
    iframe.contentWindow.postMessage({
      type: 'cr2-wb-state',
      openPanels: Array.from(openPanels),
      scoreOverlayMode,
    }, '*');
  } catch {
    // 무시
  }
}

function buildEvenOddCutoutPolygon(holes) {
  if (!holes || holes.length === 0) return 'none';
  const subpaths = ['0 0, 100% 0, 100% 100%, 0 100%, 0 0'];
  for (const h of holes) {
    subpaths.push(`${h.left}px ${h.top}px, ${h.right}px ${h.top}px, ${h.right}px ${h.bottom}px, ${h.left}px ${h.bottom}px, ${h.left}px ${h.top}px`);
  }
  return `polygon(evenodd, ${subpaths.join(', ')})`;
}

function applyTreeToolbarCutout() {
  const host = lastWbContainer?.querySelector('#wb-host');
  const overlayEl = lastWbContainer?.querySelector('#wb-tree-overlay');
  const board6El = lastWbContainer?.querySelector('#wb-board6-overlay');
  const splitterEl = lastWbContainer?.querySelector('#wb6-splitter-bar');
  const floatLayer = lastWbContainer?.querySelector('#wb-float-layer');

  // 칠판 내부 모달(저장·불러오기·배경변경·기기연결 등)이 열렸을 때는 부모 오버레이가 가리지 않도록 일시 양보
  if (host) {
    host.classList.toggle('is-iframe-modal-open', Boolean(lastIframeModalOpen));
  }
  if (floatLayer) {
    floatLayer.style.visibility = lastIframeModalOpen ? 'hidden' : '';
  }

  const hasRect = Boolean(
    lastToolbarRect &&
    lastToolbarRect.right > lastToolbarRect.left &&
    lastToolbarRect.bottom > lastToolbarRect.top
  );
  const allGlobalHoles = [
    ...(hasRect ? [lastToolbarRect] : []),
    ...(Array.isArray(lastPopupRects) ? lastPopupRects : []),
  ];

  if (overlayEl) {
    overlayEl.style.visibility = lastIframeModalOpen ? 'hidden' : '';
    overlayEl.style.clipPath = buildEvenOddCutoutPolygon(allGlobalHoles);
  }

  // 만능칠판 6.0 점수판 도킹 시에도 원본과 동일하게 하단바·더보기 팝업이 앞 레이어에 노출되고 일괄 반영 바는 하단바 위로 올라오도록 처리
  if (board6El && splitterEl) {
    board6El.style.visibility = lastIframeModalOpen ? 'hidden' : '';
    splitterEl.style.visibility = lastIframeModalOpen ? 'hidden' : '';
    if (board6Ui.full || scoreOverlayMode !== 'board6') {
      board6El.style.clipPath = 'none';
      board6El.style.setProperty('--toolbar-clearance', '0px');
      splitterEl.style.bottom = '0px';
    } else {
      const hostW = host?.clientWidth || window.innerWidth || 1280;
      const hostH = host?.clientHeight || window.innerHeight || 800;
      const dockW = board6El.offsetWidth || board6Width;
      const dockLeft = hostW - dockW;

      // 하단바 클리어런스(일괄 반영 바 위치)
      if (hasRect) {
        const { left: l, top: t, right: r, bottom: b } = lastToolbarRect;
        const ovL = Math.max(0, l - dockLeft);
        const ovR = Math.min(dockW, r - dockLeft);
        if (ovR > ovL && b > t) {
          board6El.style.setProperty('--toolbar-clearance', `${Math.max(0, hostH - t + 6)}px`);
        } else {
          board6El.style.setProperty('--toolbar-clearance', '0px');
        }
        if (r > dockLeft - 10 && l < dockLeft && b > t) {
          splitterEl.style.bottom = `${Math.max(0, hostH - t)}px`;
        } else {
          splitterEl.style.bottom = '0px';
        }
      } else {
        board6El.style.setProperty('--toolbar-clearance', '0px');
        splitterEl.style.bottom = '0px';
      }

      // 하단바 + 열린 팝업(더 보기·페이지 목록·도구 등) 모두 점수판 앞 레이어로 노출
      const localHoles = [];
      const splitterHoles = [];
      for (const gh of allGlobalHoles) {
        const ovL = Math.max(0, gh.left - dockLeft);
        const ovR = Math.min(dockW, gh.right - dockLeft);
        if (ovR > ovL && gh.bottom > gh.top) {
          localHoles.push({ left: ovL, top: gh.top, right: ovR, bottom: gh.bottom });
        }
        const spLeft = dockLeft - 10;
        const spOvL = Math.max(0, gh.left - spLeft);
        const spOvR = Math.min(10, gh.right - spLeft);
        if (spOvR > spOvL && gh.bottom > gh.top) {
          splitterHoles.push({ left: spOvL, top: gh.top, right: spOvR, bottom: gh.bottom });
        }
      }
      board6El.style.clipPath = buildEvenOddCutoutPolygon(localHoles);
      splitterEl.style.clipPath = buildEvenOddCutoutPolygon(splitterHoles);
    }
  }
}

window.addEventListener('message', (ev) => {
  if (ev.data?.type === 'cr2-wb-ready') {
    wbIframeReady = true;
    flushPendingImports();
    notifyToolbarState();
    return;
  }
  if (ev.data?.type === 'cr2-wb-toolbar-rect' && ev.data.rect) {
    lastToolbarRect = ev.data.rect;
    lastPopupRects = Array.isArray(ev.data.popupRects) ? ev.data.popupRects : [];
    lastIframeModalOpen = Boolean(ev.data.iframeModalOpen);
    applyTreeToolbarCutout();
    return;
  }
  if (ev.data?.type === 'cr2-wb-action') {
    handleToolbarAction(ev.data.action);
  }
});

function handleToolbarAction(action) {
  if (action === 'exit') {
    if (typeof exitHandler === 'function') exitHandler();
    else if (typeof navigateFn === 'function') navigateFn('students');
    return;
  }
  if (action === 'score-plus' || action === 'score-minus') {
    openScoreComposer({
      studentIds: getSelectedStudentIds(),
      initialType: action === 'score-plus' ? 'positive' : 'negative',
      onApplied: () => {
        if (lastWbContainer) {
          if (scoreOverlayMode !== 'off') renderTreeOverlay(lastWbContainer);
          if (openPanels.has('students')) mountSingleFloatingPanel(lastWbContainer, 'students');
          if (openPanels.has('seats')) mountSingleFloatingPanel(lastWbContainer, 'seats');
        }
      },
    });
    return;
  }
  // 도구 황금알 버튼 순차 클릭: 끄기 -> 황금알 나무 -> 6.0 점수판 -> 끄기
  if (action === 'toggle-tree') {
    scoreOverlayMode = scoreOverlayMode === 'off'
      ? 'tree'
      : scoreOverlayMode === 'tree'
        ? 'board6'
        : 'off';
    wb6SettingsOpen = false;
    board6Ui.full = false;
    if (lastWbContainer) renderTreeOverlay(lastWbContainer);
    notifyToolbarState();
    return;
  }
  const panelMap = {
    'panel-students': 'students',
    'panel-seats': 'seats',
    'panel-selfcheck': 'selfcheck',
    'panel-timer': 'timer',
  };
  const nextKind = panelMap[action];
  if (nextKind) {
    if (openPanels.has(nextKind)) {
      savePanelLayouts();
      openPanels.delete(nextKind);
    } else {
      openPanels.add(nextKind);
      panelCollapsedMap[nextKind] = false;
      panelZMap[nextKind] = ++topPanelZ;
    }
    if (lastWbContainer) renderFloatingPanels(lastWbContainer);
    notifyToolbarState();
  }
}

function flushPendingImports() {
  if (!pendingImportItems || pendingImportItems.length === 0) return;
  const iframe = document.getElementById('cr2-whiteboard-frame');
  if (!iframe || !iframe.contentWindow) return;
  iframe.contentWindow.postMessage({
    type: 'cr2-wb-import-images',
    items: pendingImportItems,
  }, '*');
  pendingImportItems = null;
}

/** 과제 모듈에서 개별/다중/전체 학생 과제 이미지를 만능칠판으로 즉시 전송 */
export function sendImagesToWhiteboard(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  pendingImportItems = items;
  if (typeof navigateFn === 'function') {
    navigateFn('whiteboard');
  }
  if (wbIframeReady) {
    setTimeout(flushPendingImports, 80);
  } else {
    setTimeout(flushPendingImports, 900);
  }
}

/** 셀프 체크 변경 시 기존 체크표(checklist) 항목에도 양방향 동기화 */
export async function toggleSelfCheckValue(checkId, studentId) {
  let soundKey = 'tick';
  await store.update((s) => {
    const sc = (s.selfChecks || []).find((x) => x.id === checkId);
    if (!sc) return;
    if (!sc.entries) sc.entries = {};
    if (sc.mode === 'count') {
      const target = Math.max(1, Number(sc.targetCount) || 5);
      const cur = Number(sc.entries[studentId]) || 0;
      const next = cur >= target ? 0 : cur + 1;
      sc.entries[studentId] = next;
      soundKey = next >= target ? 'pickResult' : next === 0 ? 'cardFlip' : 'tick';
    } else {
      const next = !Boolean(sc.entries[studentId]);
      sc.entries[studentId] = next;
      soundKey = next ? 'confirm' : 'cardFlip';
    }

    const linkedId = sc.linkedChecklistItemId || sc.linkedChecklistId;
    if (linkedId) {
      const today = todayIso();
      if (!s.checklist.entriesByDate[today]) s.checklist.entriesByDate[today] = {};
      const key = `${studentId}::${linkedId}`;
      if (sc.mode === 'count') {
        const val = Number(sc.entries[studentId]) || 0;
        s.checklist.entriesByDate[today][key] = val > 0 ? String(val) : '';
      } else {
        s.checklist.entriesByDate[today][key] = Boolean(sc.entries[studentId]);
      }
    }
  });
  playSound(soundKey);
}

/** 만능칠판 뷰 마운트 (재방문 시 판서 상태 유지) */
export function renderWhiteboardView(container) {
  if (!container) return;
  lastWbContainer = container;

  if (!mounted) {
    mounted = true;
    container.innerHTML = `
      <div class="wb-host" id="wb-host">
        <iframe
          id="cr2-whiteboard-frame"
          class="wb-iframe"
          src="modules/whiteboard/index.html?v=cr2-10"
          title="클래스레볼루션2 만능칠판"
          allow="clipboard-read; clipboard-write; fullscreen"
        ></iframe>

        <!-- 만능칠판 우측 투명 학급점수 나무·목표 오버레이 -->
        <div class="wb-tree-overlay" id="wb-tree-overlay" hidden></div>

        <!-- 만능칠판 6.0 원본 점수판 디자인 (우측 도킹 + 좌측 스플리터 + 자동 카드 배치) -->
        <div class="wb6-splitter-bar" id="wb6-splitter-bar" hidden title="드래그하여 점수판 너비 조절">
          <div class="wb6-split-grip"></div>
        </div>
        <aside class="wb-board6-dock" id="wb-board6-overlay" hidden></aside>

        <!-- 다중 자유 이동 · 리사이즈 플로팅 패널 레이어 (여러 개 동시 열기 지원) -->
        <div class="wb-float-layer" id="wb-float-layer"></div>
      </div>
    `;
  }

  renderTreeOverlay(container);
  renderFloatingPanels(container);
  notifyToolbarState();
  // 만능칠판 재진입 시 숨김(display:none) 해제 직후 캔버스 크기·오프셋·하단바 스케일 즉시 동기화
  const iframe = document.getElementById('cr2-whiteboard-frame');
  if (iframe && iframe.contentWindow) {
    try { iframe.contentWindow.postMessage({ type: 'cr2-wb-activated' }, '*'); } catch {}
  }
}

/** 가상 스테이지를 패널 본문 크기에 맞춰 원본 비율 그대로 스케일링 (학생목록·자리배치·타이머 공통) */
function applyPanelStageScale(bodyEl, baseW = 1280, baseH = 740) {
  if (!bodyEl) return;
  const stage = bodyEl.querySelector('.wbf-scaled-stage');
  if (!stage) return;
  const availW = Math.max(120, bodyEl.clientWidth);
  const availH = Math.max(100, bodyEl.clientHeight);
  const scale = Math.min(availW / baseW, availH / baseH);
  const scaledW = baseW * scale;
  const scaledH = baseH * scale;
  const offsetX = Math.max(0, (availW - scaledW) / 2);
  const offsetY = Math.max(0, (availH - scaledH) / 2);
  stage.style.width = `${baseW}px`;
  stage.style.height = `${baseH}px`;
  stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}

// ============================================================
// 만능칠판 우측 학급점수 오버레이 (off -> tree -> board6)
// ============================================================
function renderTreeOverlay(container) {
  const overlayEl = container.querySelector('#wb-tree-overlay');
  const board6El = container.querySelector('#wb-board6-overlay');
  const splitterEl = container.querySelector('#wb6-splitter-bar');
  if (!overlayEl || !board6El || !splitterEl) return;

  if (wb6ResizeObserver) {
    wb6ResizeObserver.disconnect();
    wb6ResizeObserver = null;
  }

  if (scoreOverlayMode === 'off') {
    overlayEl.hidden = true;
    board6El.hidden = true;
    splitterEl.hidden = true;
    return;
  }

  if (scoreOverlayMode === 'board6') {
    overlayEl.hidden = true;
    board6El.hidden = false;
    splitterEl.hidden = board6Ui.full;
    renderBoard6Overlay(board6El, splitterEl, container);
    return;
  }

  // 황금알 나무 원본 크기 + 실제 하단바 영역만 cutout + 나무 호버 시 큰 황금알 부여 버튼
  board6El.hidden = true;
  splitterEl.hidden = true;
  overlayEl.hidden = false;
  renderGrowthView(overlayEl);
  applyTreeToolbarCutout();
}

/** 원본 만능칠판 6.0 team-layout.js 자동 열/카드 크기 계산 알고리즘 그대로 이식 */
function measureTeamLayout({ width, height, count, ratio, gap, fixedColumns, previousColumns, maxAutoColumns = 6, scale = 1 }) {
  const MAX_COLUMNS = 6;
  const MIN_READABLE_WIDTH = 72;
  const MAX_CARD_WIDTH = 220;
  const COLUMN_CHANGE_MARGIN = 0.03;

  const maxWidth = Math.min(width, MAX_CARD_WIDTH, MAX_CARD_WIDTH * scale);
  const widthFor = (columns) => Math.max(0, Math.min(maxWidth, (width - gap * (columns - 1)) / columns));
  const readableWidth = Math.min(MIN_READABLE_WIDTH, maxWidth);

  const maxOccupiedColumns = Math.min(MAX_COLUMNS, Math.max(1, count));
  if (fixedColumns) {
    const columns = Math.min(fixedColumns, maxOccupiedColumns);
    return { columns, cardWidth: Math.max(readableWidth, widthFor(columns)) };
  }

  const candidates = [];
  for (let columns = 1; columns <= Math.min(maxOccupiedColumns, maxAutoColumns); columns++) {
    const rows = Math.max(1, Math.ceil(count / columns));
    const horizontalWidth = widthFor(columns);
    const verticalWidth = Math.max(0, (height - gap * (rows - 1)) * ratio / rows);
    candidates.push({ columns, horizontalWidth, rows, cardWidth: Math.min(horizontalWidth, verticalWidth) });
  }

  const best = candidates.reduce((largest, item) => (item.cardWidth > largest.cardWidth ? item : largest));
  if (best.cardWidth < readableWidth) {
    const fitting = candidates.filter((item) => item.horizontalWidth >= readableWidth);
    const shortest = fitting.length > 0
      ? fitting.reduce((first, item) => (item.rows < first.rows ? item : first))
      : best;
    return { columns: shortest.columns, cardWidth: readableWidth };
  }

  const previous = candidates.find((item) => item.columns === previousColumns);
  const chosen = previous && previous.cardWidth >= readableWidth &&
    previous.cardWidth >= best.cardWidth * (1 - COLUMN_CHANGE_MARGIN) ? previous : best;
  return { columns: chosen.columns, cardWidth: chosen.cardWidth };
}

function updateBoard6TeamLayout(board6El, groupCount) {
  const viewport = board6El.querySelector('#wb6-team-viewport');
  const grid = board6El.querySelector('#wb6-scoreboard');
  const numEl = board6El.querySelector('#wb6-class-number');
  if (!viewport || !grid) return;

  const scaleFactor = (board6Ui.scale || 100) / 100;
  const availW = Math.max(80, viewport.clientWidth - 16);
  const availH = Math.max(80, viewport.clientHeight - 8);
  const ratio = board6Ui.cardRatio === '16:9' ? 16 / 9 : 4 / 3;
  const gap = Math.round(8 * scaleFactor);
  const fixedCols = board6Ui.layoutMode === 'fixed' ? board6Ui.fixedColumns : 0;

  const { columns, cardWidth } = measureTeamLayout({
    width: availW,
    height: availH,
    count: Math.max(1, groupCount),
    ratio,
    gap,
    fixedColumns: fixedCols,
    previousColumns: wb6PrevColumns,
    scale: scaleFactor,
  });
  wb6PrevColumns = columns;

  grid.style.setProperty('--team-columns', String(columns));
  grid.style.setProperty('--team-card-width', `${Math.max(68, Math.floor(cardWidth))}px`);
  grid.style.setProperty('--team-gap', `${gap}px`);
  grid.style.setProperty('--score-card-ratio', board6Ui.cardRatio === '16:9' ? '16 / 9' : '4 / 3');
  grid.style.setProperty('--score-scale', String(scaleFactor));

  // 상단 학급 점수 숫자 크기도 패널 폭에 맞춰 원본처럼 자동 조절
  if (numEl) {
    const panelW = board6El.clientWidth || board6Width;
    const scorePx = Math.round(Math.max(32, Math.min(76, panelW * 0.22 * scaleFactor)));
    board6El.style.setProperty('--class-score-size', `${scorePx}px`);
  }
}

/** 만능칠판 6.0 원본 점수판(학급온도계.html + style.css) 디자인 그대로 이식 */
function renderBoard6Overlay(board6El, splitterEl, container) {
  const state = store.getState();
  const wbCfg = state.wbScoreboard || {};
  const students = (state.students || []).filter((s) => !s.trashed);
  const groups = [...(state.groups || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const baseMode = wbCfg.baseGroupMode === 'avg' ? 'avg' : 'sum';
  const defaultRate = Math.max(1, groups.length || 1);
  const linkRate = Math.max(1, Number(wbCfg.classLinkRate) || defaultRate);
  const carry = Number(wbCfg.specialPendingCarry) || 0;
  const eggs = state.growth?.eggs ?? 0;
  const filledRatio = Math.max(0, Math.min(1, Math.abs(carry) / linkRate));
  const divisionPct = `${(100 / linkRate).toFixed(3)}%`;

  // 유효하지 않은 선택 모둠 정리
  const validIds = new Set(groups.map((g) => g.id));
  for (const id of Array.from(wb6SelectedGroupIds)) {
    if (!validIds.has(id)) wb6SelectedGroupIds.delete(id);
  }

  board6El.classList.toggle('is-full', board6Ui.full);
  if (board6Ui.full) {
    board6El.style.width = '100%';
    splitterEl.hidden = true;
  } else {
    const hostW = container.querySelector('#wb-host')?.clientWidth || window.innerWidth || 1280;
    const clampedW = Math.max(220, Math.min(Math.round(hostW * 0.8), board6Width));
    board6Width = clampedW;
    board6El.style.width = `${clampedW}px`;
    splitterEl.hidden = false;
    splitterEl.style.right = `${clampedW}px`;
  }

  const groupRows = groups.map((g) => {
    const members = students.filter((s) => s.groupId === g.id);
    const sum = members.reduce((acc, m) => acc + (Number(m.score) || 0), 0);
    const baseScore = baseMode === 'avg'
      ? (members.length > 0 ? Math.floor(sum / members.length) : 0)
      : sum;
    const special = Number(wbCfg.specialGroupScores?.[g.id] || 0);
    return {
      group: g,
      memberCount: members.length,
      baseScore,
      special,
      total: baseScore + special,
    };
  });

  const selectedCount = wb6SelectedGroupIds.size;
  const allSelected = groups.length > 0 && selectedCount === groups.length;

  board6El.innerHTML = `
    <div class="wb6-v7-container">
      <div class="wb6-v7-display-area">
        <div class="wb6-v7-top-row">
          <section class="wb6-v7-class-area" aria-label="학급 점수">
            <div class="wb6-v7-main-scoreboard">
              <header class="wb6-v7-class-heading">
                <div class="wb6-v7-class-goal-heading">
                  <h1>학급 점수</h1>
                </div>
                <div class="wb6-v7-header-actions">
                  <button type="button" class="wb6-v7-icon-btn" id="wb6-maximize" title="${board6Ui.full ? '원래 크기로' : '전체 화면'}" aria-pressed="${board6Ui.full ? 'true' : 'false'}">
                    <span class="wb6-v7-screen-icon" aria-hidden="true"></span>
                  </button>
                  <button type="button" class="wb6-v7-icon-btn ${wb6SettingsOpen ? 'is-open' : ''}" id="wb6-settings-toggle" title="점수판 설정" aria-expanded="${wb6SettingsOpen ? 'true' : 'false'}">⚙</button>
                </div>
              </header>

              <div class="wb6-v7-main-controls">
                <button type="button" class="wb6-v7-main-btn" id="wb6-egg-dec" aria-label="학급 점수 1점 차감">−</button>
                <span class="wb6-v7-number" id="wb6-class-number">${eggs}</span>
                <button type="button" class="wb6-v7-main-btn" id="wb6-egg-inc" aria-label="학급 점수 1점 추가">+</button>
              </div>

              <div class="wb6-v7-progress-group">
                <div class="wb6-v7-progress" ${linkRate > 20 ? 'data-continuous="true"' : ''} style="--filled:${filledRatio};--division:${divisionPct};">
                  <div class="wb6-v7-progress-fill"></div>
                </div>
                <div class="wb6-v7-conversion-line">
                  <span>모둠 ${linkRate}점 = 학급 1점</span>
                  <span>${carry >= 0 ? `+${carry}` : carry} / ${linkRate}</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        <section class="wb6-v7-bottom-row" aria-label="모둠 점수">
          <header class="wb6-v7-team-heading">
            <h2>모둠 점수</h2>
            <span class="wb6-v7-selected-count">${selectedCount > 0 ? `${selectedCount}개 모둠 선택` : (baseMode === 'avg' ? '기본: 평균(버림)' : '기본: 모둠원 합')}</span>
          </header>

          <div class="wb6-v7-team-viewport" id="wb6-team-viewport">
            ${groupRows.length === 0
              ? `<div class="wb6-empty">등록된 모둠이 없습니다. 자리배치에서 모둠을 먼저 만들어 주세요.</div>`
              : `<div class="wb6-v7-scoreboard" id="wb6-scoreboard">
                  ${groupRows.map((r) => {
                    const isSel = wb6SelectedGroupIds.has(r.group.id);
                    const isLong = String(r.total).length >= 3;
                    const tip = `기본 ${r.baseScore} (${baseMode === 'avg' ? '평균 버림' : '합계'})${r.special !== 0 ? ` · 교사 특별 ${r.special > 0 ? '+' : ''}${r.special}` : ''}`;
                    return `
                      <div class="wb6-v7-team-card ${isSel ? 'team-selected' : ''}" data-wb6-card="${r.group.id}" title="${escapeHtml(tip)}">
                        <button type="button" class="wb6-v7-team-select-btn" data-wb6-select="${r.group.id}">
                          <div class="wb6-v7-team-name">${escapeHtml(r.group.name)}</div>
                          <div class="wb6-v7-team-controls">
                            <span class="wb6-v7-team-number" ${isLong ? 'data-long-score="true"' : ''}>${r.total}</span>
                          </div>
                        </button>
                        <div class="wb6-v7-team-steps">
                          <button type="button" class="wb6-v7-team-minus" data-wb6-gdelta="${r.group.id}" data-delta="-1" aria-label="${escapeHtml(r.group.name)} 1점 차감">−</button>
                          <button type="button" class="wb6-v7-team-plus" data-wb6-gdelta="${r.group.id}" data-delta="1" aria-label="${escapeHtml(r.group.name)} 1점 추가">+</button>
                        </div>
                      </div>
                    `;
                  }).join('')}
                </div>`
            }
          </div>
        </section>
      </div>

      ${groupRows.length > 0 ? `
        <form class="wb6-v7-batch-score" id="wb6-batch-form">
          <button type="button" id="wb6-select-all">${allSelected ? '전체해제' : '전체선택'}</button>
          <button type="button" id="wb6-undo" ${wb6UndoStack.length === 0 ? 'disabled' : ''}>되돌리기</button>
          <div class="wb6-v7-batch-amount">
            <input id="wb6-batch-delta" type="number" step="1" value="${wb6BatchDelta}" aria-label="일괄 반영할 특별점수">
            <div class="wb6-v7-batch-stepper">
              <button type="button" id="wb6-batch-up">+</button>
              <button type="button" id="wb6-batch-down">−</button>
            </div>
          </div>
          <button type="submit" id="wb6-apply-batch" ${selectedCount === 0 || wb6BatchDelta === 0 ? 'disabled' : ''}>반영</button>
        </form>
      ` : ''}

      <!-- 원본 만능칠판 6.0 설정 팝오버 -->
      <div class="wb6-v7-settings-panel ${wb6SettingsOpen ? 'open' : ''}" id="wb6-settings-panel">
        <header class="wb6-v7-settings-header">
          <h3>점수판 설정</h3>
          <button type="button" class="wb6-v7-settings-close" id="wb6-close-settings" aria-label="닫기">×</button>
        </header>

        <section class="wb6-v7-settings-section">
          <h4>기본 모둠점수 · 연동</h4>
          <label class="wb6-v7-setting-row">
            <span>기본 모둠점수</span>
            <select id="wb6-base-mode">
              <option value="sum" ${baseMode === 'sum' ? 'selected' : ''}>모둠원 합</option>
              <option value="avg" ${baseMode === 'avg' ? 'selected' : ''}>모둠원 평균(버림)</option>
            </select>
          </label>
          <div class="wb6-v7-setting-row">
            <span>황금알 연계율 <small>(기본 ${defaultRate})</small></span>
            <div class="wb6-v7-size-controls">
              <button type="button" id="wb6-rate-dec">−</button>
              <output>${linkRate}점</output>
              <button type="button" id="wb6-rate-inc">+</button>
            </div>
          </div>
        </section>

        <section class="wb6-v7-settings-section">
          <h4>화면 표시</h4>
          <label class="wb6-v7-setting-row">
            <span>모둠카드 배치</span>
            <select id="wb6-layout-mode">
              <option value="auto" ${board6Ui.layoutMode === 'auto' ? 'selected' : ''}>자동 배치</option>
              <option value="fixed" ${board6Ui.layoutMode === 'fixed' ? 'selected' : ''}>열 수 고정</option>
            </select>
          </label>
          ${board6Ui.layoutMode === 'fixed' ? `
            <label class="wb6-v7-setting-row">
              <span>고정 열 수</span>
              <input id="wb6-fixed-cols" type="number" min="1" max="6" step="1" value="${board6Ui.fixedColumns}">
            </label>
          ` : ''}
          <label class="wb6-v7-setting-row">
            <span>모둠 카드 비율</span>
            <select id="wb6-card-ratio">
              <option value="4:3" ${board6Ui.cardRatio === '4:3' ? 'selected' : ''}>4:3</option>
              <option value="16:9" ${board6Ui.cardRatio === '16:9' ? 'selected' : ''}>16:9</option>
            </select>
          </label>
          <div class="wb6-v7-setting-row">
            <span>표시 배율</span>
            <div class="wb6-v7-size-controls">
              <button type="button" id="wb6-scale-down">−</button>
              <output>${board6Ui.scale}%</output>
              <button type="button" id="wb6-scale-up">+</button>
              <button type="button" id="wb6-scale-reset">초기화</button>
            </div>
          </div>
        </section>

        <section class="wb6-v7-settings-section">
          <h4>관리</h4>
          <div class="wb6-v7-settings-actions">
            <button type="button" id="wb6-reset-special">특별 모둠점수 초기화</button>
            <button type="button" id="wb6-close-panel">점수판 닫기</button>
          </div>
        </section>
      </div>
    </div>
  `;

  // 자동 열/카드 크기 계산, 하단바 클리어런스 및 리사이즈 관찰
  applyTreeToolbarCutout();
  requestAnimationFrame(() => updateBoard6TeamLayout(board6El, groupRows.length));
  if (typeof ResizeObserver !== 'undefined') {
    const vp = board6El.querySelector('#wb6-team-viewport');
    if (vp) {
      wb6ResizeObserver = new ResizeObserver(() => updateBoard6TeamLayout(board6El, groupRows.length));
      wb6ResizeObserver.observe(vp);
    }
  }

  // 원본 스플리터 드래그로 너비 조절
  splitterEl.onpointerdown = (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const origW = board6Width;
    const hostW = container.querySelector('#wb-host')?.clientWidth || window.innerWidth || 1280;
    splitterEl.classList.add('dragging');
    splitterEl.setPointerCapture(ev.pointerId);
    const onMove = (me) => {
      board6Width = Math.max(220, Math.min(Math.round(hostW * 0.8), origW + (startX - me.clientX)));
      board6El.style.width = `${board6Width}px`;
      splitterEl.style.right = `${board6Width}px`;
      applyTreeToolbarCutout();
      updateBoard6TeamLayout(board6El, groupRows.length);
    };
    const onUp = () => {
      splitterEl.classList.remove('dragging');
      saveBoard6Width(board6Width);
      splitterEl.removeEventListener('pointermove', onMove);
      splitterEl.removeEventListener('pointerup', onUp);
    };
    splitterEl.addEventListener('pointermove', onMove);
    splitterEl.addEventListener('pointerup', onUp);
  };

  // 헤더 액션
  board6El.querySelector('#wb6-maximize').onclick = () => {
    board6Ui.full = !board6Ui.full;
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  board6El.querySelector('#wb6-settings-toggle').onclick = () => {
    wb6SettingsOpen = !wb6SettingsOpen;
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  board6El.querySelector('#wb6-close-settings').onclick = () => {
    wb6SettingsOpen = false;
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  board6El.querySelector('#wb6-close-panel').onclick = () => {
    scoreOverlayMode = 'off';
    wb6SettingsOpen = false;
    board6Ui.full = false;
    renderTreeOverlay(container);
    notifyToolbarState();
  };

  // 학급 점수(=황금알) 직접 가감
  board6El.querySelector('#wb6-egg-inc').onclick = async () => {
    const out = await adjustSpecialEggs(1, '만능칠판 6.0 점수판 학급점수 +1');
    presentOutcome(out);
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  board6El.querySelector('#wb6-egg-dec').onclick = async () => {
    const out = await adjustSpecialEggs(-1, '만능칠판 6.0 점수판 학급점수 -1');
    presentOutcome(out);
    renderBoard6Overlay(board6El, splitterEl, container);
  };

  // 교사 특별 모둠점수 적용 공통 함수 (연계율 자동 황금알 연동 + 되돌리기 기록)
  const applyGroupSpecialDeltas = async (entries, label) => {
    if (!entries.length) return;
    let eggDelta = 0;
    const prevCarry = Number(store.getState().wbScoreboard?.specialPendingCarry) || 0;
    const prevScores = { ...(store.getState().wbScoreboard?.specialGroupScores || {}) };

    await store.update((s) => {
      if (!s.wbScoreboard.specialGroupScores) s.wbScoreboard.specialGroupScores = {};
      let totalDelta = 0;
      for (const { gid, delta } of entries) {
        s.wbScoreboard.specialGroupScores[gid] = (Number(s.wbScoreboard.specialGroupScores[gid]) || 0) + delta;
        totalDelta += delta;
      }
      const curRate = Math.max(1, Number(s.wbScoreboard.classLinkRate) || Math.max(1, (s.groups || []).length));
      let nextCarry = (Number(s.wbScoreboard.specialPendingCarry) || 0) + totalDelta;
      if (nextCarry >= curRate) {
        eggDelta = Math.floor(nextCarry / curRate);
        nextCarry = nextCarry % curRate;
      } else if (nextCarry <= -curRate) {
        eggDelta = -Math.floor(Math.abs(nextCarry) / curRate);
        nextCarry = -(Math.abs(nextCarry) % curRate);
      }
      s.wbScoreboard.specialPendingCarry = nextCarry;
    });

    wb6UndoStack.push({ prevScores, prevCarry, eggDelta });
    if (wb6UndoStack.length > 20) wb6UndoStack.shift();

    if (eggDelta !== 0) {
      const out = await adjustSpecialEggs(eggDelta, label);
      presentOutcome(out);
    }
    renderBoard6Overlay(board6El, splitterEl, container);
  };

  // 모둠 카드 선택 토글
  board6El.querySelectorAll('[data-wb6-select]').forEach((btn) => {
    btn.onclick = () => {
      const gid = btn.dataset.wb6Select;
      if (wb6SelectedGroupIds.has(gid)) wb6SelectedGroupIds.delete(gid);
      else wb6SelectedGroupIds.add(gid);
      renderBoard6Overlay(board6El, splitterEl, container);
    };
  });

  // 모둠 카드 개별 − / + 버튼
  board6El.querySelectorAll('[data-wb6-gdelta]').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      const gid = btn.dataset.wb6Gdelta;
      const delta = Number(btn.dataset.delta) || 0;
      if (!delta) return;
      const gName = groups.find((x) => x.id === gid)?.name || '모둠';
      await applyGroupSpecialDeltas([{ gid, delta }], `${gName} 특별점수 연계 (${linkRate}점당 1알)`);
    };
  });

  // 하단 일괄 반영 바
  const selAllBtn = board6El.querySelector('#wb6-select-all');
  if (selAllBtn) {
    selAllBtn.onclick = () => {
      if (allSelected) wb6SelectedGroupIds.clear();
      else groups.forEach((g) => wb6SelectedGroupIds.add(g.id));
      renderBoard6Overlay(board6El, splitterEl, container);
    };
  }
  const undoBtn = board6El.querySelector('#wb6-undo');
  if (undoBtn) {
    undoBtn.onclick = async () => {
      const snap = wb6UndoStack.pop();
      if (!snap) return;
      await store.update((s) => {
        s.wbScoreboard.specialGroupScores = snap.prevScores;
        s.wbScoreboard.specialPendingCarry = snap.prevCarry;
      });
      if (snap.eggDelta !== 0) {
        await adjustSpecialEggs(-snap.eggDelta, '만능칠판 점수판 되돌리기');
      }
      renderBoard6Overlay(board6El, splitterEl, container);
    };
  }
  const batchInput = board6El.querySelector('#wb6-batch-delta');
  const applyBtn = board6El.querySelector('#wb6-apply-batch');
  const syncBatchBtn = () => {
    if (applyBtn) applyBtn.disabled = wb6SelectedGroupIds.size === 0 || wb6BatchDelta === 0;
  };
  if (batchInput) {
    batchInput.oninput = () => {
      wb6BatchDelta = parseInt(batchInput.value, 10) || 0;
      syncBatchBtn();
    };
  }
  const batchUp = board6El.querySelector('#wb6-batch-up');
  if (batchUp) {
    batchUp.onclick = () => {
      wb6BatchDelta += 1;
      if (batchInput) batchInput.value = String(wb6BatchDelta);
      syncBatchBtn();
    };
  }
  const batchDown = board6El.querySelector('#wb6-batch-down');
  if (batchDown) {
    batchDown.onclick = () => {
      wb6BatchDelta -= 1;
      if (batchInput) batchInput.value = String(wb6BatchDelta);
      syncBatchBtn();
    };
  }
  const batchForm = board6El.querySelector('#wb6-batch-form');
  if (batchForm) {
    batchForm.onsubmit = async (ev) => {
      ev.preventDefault();
      if (wb6SelectedGroupIds.size === 0 || wb6BatchDelta === 0) return;
      const entries = Array.from(wb6SelectedGroupIds).map((gid) => ({ gid, delta: wb6BatchDelta }));
      const deltaUsed = wb6BatchDelta;
      wb6BatchDelta = 0;
      await applyGroupSpecialDeltas(entries, `선택 모둠 일괄 ${deltaUsed > 0 ? `+${deltaUsed}` : deltaUsed}점 연계`);
    };
  }

  // 설정 팝오버 이벤트
  board6El.querySelector('#wb6-base-mode').onchange = async (ev) => {
    const m = ev.target.value === 'avg' ? 'avg' : 'sum';
    await store.update((s) => { s.wbScoreboard.baseGroupMode = m; });
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  board6El.querySelector('#wb6-rate-dec').onclick = async () => {
    const next = Math.max(1, linkRate - 1);
    await store.update((s) => { s.wbScoreboard.classLinkRate = next; });
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  board6El.querySelector('#wb6-rate-inc').onclick = async () => {
    const next = Math.min(99, linkRate + 1);
    await store.update((s) => { s.wbScoreboard.classLinkRate = next; });
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  board6El.querySelector('#wb6-layout-mode').onchange = (ev) => {
    board6Ui.layoutMode = ev.target.value === 'fixed' ? 'fixed' : 'auto';
    saveBoard6Ui();
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  const fixedColsInput = board6El.querySelector('#wb6-fixed-cols');
  if (fixedColsInput) {
    fixedColsInput.onchange = () => {
      board6Ui.fixedColumns = Math.max(1, Math.min(6, parseInt(fixedColsInput.value, 10) || 2));
      saveBoard6Ui();
      updateBoard6TeamLayout(board6El, groupRows.length);
    };
  }
  board6El.querySelector('#wb6-card-ratio').onchange = (ev) => {
    board6Ui.cardRatio = ev.target.value === '16:9' ? '16:9' : '4:3';
    saveBoard6Ui();
    updateBoard6TeamLayout(board6El, groupRows.length);
  };
  board6El.querySelector('#wb6-scale-down').onclick = () => {
    board6Ui.scale = Math.max(60, board6Ui.scale - 10);
    saveBoard6Ui();
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  board6El.querySelector('#wb6-scale-up').onclick = () => {
    board6Ui.scale = Math.min(150, board6Ui.scale + 10);
    saveBoard6Ui();
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  board6El.querySelector('#wb6-scale-reset').onclick = () => {
    board6Ui.scale = 100;
    saveBoard6Ui();
    renderBoard6Overlay(board6El, splitterEl, container);
  };
  board6El.querySelector('#wb6-reset-special').onclick = async () => {
    if (!confirm('교사 특별 모둠점수만 0으로 초기화할까요? (학급 황금알과 학생 개인점수는 유지됩니다)')) return;
    await store.update((s) => {
      s.wbScoreboard.specialGroupScores = {};
      s.wbScoreboard.specialPendingCarry = 0;
    });
    wb6UndoStack = [];
    showToast({ title: '교사 특별 모둠점수를 초기화했습니다.' });
    renderBoard6Overlay(board6El, splitterEl, container);
  };
}

// ============================================================
// 다중 플로팅 패널 관리 (학생목록 · 자리배치 · 체크표 · 타이머 동시 열기)
// ============================================================
function renderFloatingPanels(container) {
  const layer = container.querySelector('#wb-float-layer');
  if (!layer) return;

  // 닫힌 패널 제거
  layer.querySelectorAll('.wb-float-panel[data-panel-kind]').forEach((el) => {
    if (!openPanels.has(el.dataset.panelKind)) {
      el.remove();
    }
  });

  // 열린 패널 모두 마운트/갱신
  for (const kind of ALL_PANEL_KINDS) {
    if (openPanels.has(kind)) {
      mountSingleFloatingPanel(container, kind);
    }
  }
}

function mountSingleFloatingPanel(container, kind) {
  const layer = container.querySelector('#wb-float-layer');
  const host = container.querySelector('#wb-host');
  if (!layer || !host) return;

  let panelEl = layer.querySelector(`.wb-float-panel[data-panel-kind="${kind}"]`);
  if (!panelEl) {
    panelEl = document.createElement('div');
    panelEl.className = 'wb-float-panel';
    panelEl.dataset.panelKind = kind;
    layer.appendChild(panelEl);
  }

  const maxW = Math.max(240, (host.clientWidth || 1280) - 20);
  const maxH = Math.max(180, (host.clientHeight || 800) - 84);
  const minW = kind === 'timer' ? 220 : 280;
  const minH = kind === 'timer' ? 190 : 210;

  const curLayout = { ...getPanelLayout(kind) };
  curLayout.width = Math.max(minW, Math.min(curLayout.width, maxW));
  curLayout.height = Math.max(minH, Math.min(curLayout.height, maxH));
  curLayout.left = Math.max(6, Math.min(curLayout.left, Math.max(6, (host.clientWidth || 1280) - curLayout.width - 6)));
  curLayout.top = Math.max(6, Math.min(curLayout.top, Math.max(6, (host.clientHeight || 800) - 70)));
  panelLayouts[kind] = curLayout;

  const isCollapsed = Boolean(panelCollapsedMap[kind]);
  if (!panelZMap[kind]) panelZMap[kind] = ++topPanelZ;

  panelEl.style.left = `${curLayout.left}px`;
  panelEl.style.top = `${curLayout.top}px`;
  panelEl.style.width = `${curLayout.width}px`;
  panelEl.style.height = isCollapsed ? 'auto' : `${curLayout.height}px`;
  panelEl.style.zIndex = String(panelZMap[kind]);

  const titleMap = {
    students: '👥 학생목록',
    seats: '🪑 자리배치',
    selfcheck: '☑️ 체크표',
    timer: '⏱ 타이머 · 스톱워치',
  };

  panelEl.innerHTML = `
    <div class="wbf-header" data-wbf-drag>
      <strong class="wbf-title">${titleMap[kind] || '도구'}</strong>
      <div class="wbf-zoom-controls">
        <button type="button" class="wbf-icon-btn" data-wbf-collapse title="접기/펼치기">${isCollapsed ? '▾' : '▴'}</button>
        <button type="button" class="wbf-icon-btn" data-wbf-close title="닫기">&times;</button>
      </div>
    </div>
    ${isCollapsed ? '' : `
      <div class="wbf-body is-native-host" data-wbf-body></div>
      <div class="wbf-resize-handle" data-wbf-resize title="드래그하여 창 크기 조절"></div>
    `}
  `;

  // 패널 클릭 시 최상단 포커스
  panelEl.onpointerdown = () => {
    panelZMap[kind] = ++topPanelZ;
    panelEl.style.zIndex = String(panelZMap[kind]);
  };

  panelEl.querySelector('[data-wbf-close]').onclick = (ev) => {
    ev.stopPropagation();
    savePanelLayouts();
    openPanels.delete(kind);
    panelEl.remove();
    notifyToolbarState();
  };
  panelEl.querySelector('[data-wbf-collapse]').onclick = (ev) => {
    ev.stopPropagation();
    panelCollapsedMap[kind] = !isCollapsed;
    mountSingleFloatingPanel(container, kind);
  };

  // 본문 마운트
  const bodyEl = panelEl.querySelector('[data-wbf-body]');
  if (bodyEl) {
    if (kind === 'students' || kind === 'seats') {
      bodyEl.innerHTML = `<div class="wbf-scaled-stage" style="width:1280px;height:740px;"></div>`;
      const stageEl = bodyEl.querySelector('.wbf-scaled-stage');
      // 패널별 독립 뷰 모드 고정 (학생목록·자리배치 동시 오픈 시 상태 충돌 방지)
      stageEl.dataset.forcedSubView = kind === 'seats' ? 'seats' : 'list';
      renderStudentsView(stageEl);
      applyPanelStageScale(bodyEl, 1280, 740);
      requestAnimationFrame(() => {
        refitStudentsView(stageEl);
        applyPanelStageScale(bodyEl, 1280, 740);
      });
    } else if (kind === 'timer') {
      // 타이머/스톱워치도 가상 스테이지 비율 스케일링 적용 → 패널을 아무리 축소해도 모든 요소가 한눈에 표시
      bodyEl.classList.add('is-timer-host');
      bodyEl.innerHTML = `<div class="wbf-scaled-stage is-timer-stage" style="width:520px;height:460px;"></div>`;
      const stageEl = bodyEl.querySelector('.wbf-scaled-stage');
      renderTimerView(stageEl);
      applyPanelStageScale(bodyEl, 520, 460);
      requestAnimationFrame(() => applyPanelStageScale(bodyEl, 520, 460));
    } else if (kind === 'selfcheck') {
      renderSelfCheckInPanel(bodyEl, container);
    }
  }

  // 드래그 이동 (종류별 위치 자동 기억)
  const dragHandle = panelEl.querySelector('[data-wbf-drag]');
  if (dragHandle) {
    dragHandle.onpointerdown = (ev) => {
      if (ev.target.closest('button')) return;
      ev.preventDefault();
      panelZMap[kind] = ++topPanelZ;
      panelEl.style.zIndex = String(panelZMap[kind]);
      const startX = ev.clientX;
      const startY = ev.clientY;
      const origLeft = panelLayouts[kind].left;
      const origTop = panelLayouts[kind].top;
      dragHandle.setPointerCapture(ev.pointerId);
      const onMove = (me) => {
        panelLayouts[kind].left = Math.max(0, origLeft + (me.clientX - startX));
        panelLayouts[kind].top = Math.max(0, origTop + (me.clientY - startY));
        panelEl.style.left = `${panelLayouts[kind].left}px`;
        panelEl.style.top = `${panelLayouts[kind].top}px`;
      };
      const onUp = () => {
        savePanelLayouts();
        dragHandle.removeEventListener('pointermove', onMove);
        dragHandle.removeEventListener('pointerup', onUp);
      };
      dragHandle.addEventListener('pointermove', onMove);
      dragHandle.addEventListener('pointerup', onUp);
    };
  }

  // 우하단 모서리 드래그 리사이즈 (종류별 크기 자동 기억 + 학생/자리배치/타이머 실시간 비율 스케일링)
  const resizeHandle = panelEl.querySelector('[data-wbf-resize]');
  if (resizeHandle) {
    resizeHandle.onpointerdown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      panelZMap[kind] = ++topPanelZ;
      panelEl.style.zIndex = String(panelZMap[kind]);
      const startX = ev.clientX;
      const startY = ev.clientY;
      const origW = panelLayouts[kind].width;
      const origH = panelLayouts[kind].height;
      resizeHandle.setPointerCapture(ev.pointerId);
      const scaleContent = () => {
        if (!bodyEl) return;
        if (kind === 'students' || kind === 'seats') applyPanelStageScale(bodyEl, 1280, 740);
        else if (kind === 'timer') applyPanelStageScale(bodyEl, 520, 460);
      };
      const onMove = (me) => {
        panelLayouts[kind].width = Math.max(minW, Math.min(maxW, origW + (me.clientX - startX)));
        panelLayouts[kind].height = Math.max(minH, Math.min(maxH, origH + (me.clientY - startY)));
        panelEl.style.width = `${panelLayouts[kind].width}px`;
        panelEl.style.height = `${panelLayouts[kind].height}px`;
        scaleContent();
      };
      const onUp = () => {
        savePanelLayouts();
        resizeHandle.removeEventListener('pointermove', onMove);
        resizeHandle.removeEventListener('pointerup', onUp);
        scaleContent();
      };
      resizeHandle.addEventListener('pointermove', onMove);
      resizeHandle.addEventListener('pointerup', onUp);
    };
  }
}

/** 플로팅 패널용 5열/10열 터치 셀프 체크표 */
function renderSelfCheckInPanel(bodyEl, container) {
  const state = store.getState();
  const students = (state.students || []).filter((s) => !s.trashed).sort((a, b) => a.number - b.number);
  const selfChecks = state.selfChecks || [];
  if (!activeSelfCheckId || !selfChecks.some((x) => x.id === activeSelfCheckId)) {
    activeSelfCheckId = selfChecks[0]?.id || null;
  }
  const curSc = selfChecks.find((x) => x.id === activeSelfCheckId) || null;
  const cols = (curSc?.gridColumns || curSc?.columns) === 10 ? 10 : 5;
  const targetList = curSc && Array.isArray(curSc.targetStudentIds) && curSc.targetStudentIds.length > 0
    ? students.filter((s) => curSc.targetStudentIds.includes(s.id))
    : students;
  const doneCount = curSc ? targetList.filter((s) => {
    const v = curSc.entries?.[s.id];
    return curSc.mode === 'count' ? (Number(v) || 0) >= (Number(curSc.targetCount) || 5) : Boolean(v);
  }).length : 0;

  bodyEl.innerHTML = selfChecks.length === 0 ? `
    <div class="wbf-empty-sc" style="padding:36px 20px;">
      <p>등록된 셀프 체크표가 없습니다.</p>
      <p><strong>[체크표] → [학생 셀프 체크표 · 퀘스트]</strong>에서 먼저 항목을 만들어 주세요.</p>
    </div>
  ` : `
    <div style="padding:10px;display:flex;flex-direction:column;height:100%;gap:8px;background:var(--bg-cream);">
      <div class="wbf-sc-bar" style="margin:0;">
        <select id="wbf-sc-select">
          ${selfChecks.map((sc) => `<option value="${sc.id}" ${sc.id === curSc.id ? 'selected' : ''}>${escapeHtml(sc.title)}</option>`).join('')}
        </select>
        <button type="button" class="wbf-mini-btn ${cols === 5 ? 'is-active' : ''}" data-wbf-cols="5">5열</button>
        <button type="button" class="wbf-mini-btn ${cols === 10 ? 'is-active' : ''}" data-wbf-cols="10">10열</button>
        <span class="wbf-sc-prog">${doneCount}/${targetList.length}</span>
      </div>
      <div class="wbf-sc-grid" style="flex:1;min-height:0;grid-template-columns:repeat(${cols}, minmax(0, 1fr));grid-auto-rows:minmax(0, 1fr);">
        ${targetList.map((s) => {
          const val = curSc.entries?.[s.id];
          const targetCnt = Number(curSc.targetCount) || 5;
          const isDone = curSc.mode === 'count' ? (Number(val) || 0) >= targetCnt : Boolean(val);
          const countTxt = curSc.mode === 'count' ? `${Number(val) || 0}/${targetCnt}` : (isDone ? '✓' : '');
          return `
            <button type="button" class="wbf-sc-btn ${isDone ? 'is-done' : ''}" data-wbf-sc-toggle="${s.id}" style="min-height:0;height:100%;">
              <span class="wbf-sc-num">${s.number}</span>
              <span class="wbf-sc-name">${escapeHtml(s.name)}</span>
              ${countTxt ? `<span class="wbf-sc-mark">${countTxt}</span>` : ''}
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;

  const scSel = bodyEl.querySelector('#wbf-sc-select');
  if (scSel) scSel.onchange = () => { activeSelfCheckId = scSel.value; renderSelfCheckInPanel(bodyEl, container); };
  bodyEl.querySelectorAll('[data-wbf-cols]').forEach((b) => {
    b.onclick = async () => {
      const c = Number(b.dataset.wbfCols);
      await store.update((s) => {
        const sc = (s.selfChecks || []).find((x) => x.id === activeSelfCheckId);
        if (sc) { sc.gridColumns = c; sc.columns = c; }
      });
      renderSelfCheckInPanel(bodyEl, container);
    };
  });
  bodyEl.querySelectorAll('[data-wbf-sc-toggle]').forEach((b) => {
    b.onclick = async () => {
      if (!activeSelfCheckId) return;
      await toggleSelfCheckValue(activeSelfCheckId, b.dataset.wbfScToggle);
      renderSelfCheckInPanel(bodyEl, container);
    };
  });
}
