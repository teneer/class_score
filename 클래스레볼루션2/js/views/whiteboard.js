// 만능칠판 6.0 풀스크린 뷰 — 하단바 통합 도구(끝내기·학생목록·자리배치·학급점수 3단 순환[나무/6.0점수판/끄기]·체크표·타이머) + 패널별 직전 위치/크기 기억 + 학생 과제 이미지 수신 브리지

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

let mounted = false;
let wbIframeReady = false;
let pendingImportItems = null;
let navigateFn = null;
let exitHandler = null;
let lastWbContainer = null;
let lastToolbarRect = null;

// 플로팅 패널 상태 (종류별 직전 크기·위치 개별 기억)
let openPanelKind = null; // null | 'students' | 'seats' | 'selfcheck' | 'timer'
let scoreOverlayMode = 'off'; // 'off' | 'tree' | 'board6' (도구 버튼 순차 클릭 전환)
let wb6SettingsOpen = false;
let board6Width = loadSavedBoard6Width();
let panelLayouts = loadSavedPanelLayouts();
let panelCollapsed = false;
let activeSelfCheckId = null;

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
    if (Number.isFinite(n) && n >= 260 && n <= 540) return n;
  } catch {}
  return 320;
}

function saveBoard6Width(w) {
  try { localStorage.setItem(BOARD6_WIDTH_LS_KEY, String(Math.round(w))); } catch {}
}

function getPanelLayout(kind) {
  const saved = panelLayouts[kind];
  if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
    return saved;
  }
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  if (kind === 'timer') {
    return { left: 28, top: 24, width: Math.min(520, Math.max(380, vw - 60)), height: Math.min(440, Math.max(340, vh - 130)) };
  }
  if (kind === 'selfcheck') {
    return { left: 28, top: 24, width: Math.min(640, Math.max(420, vw - 200)), height: Math.min(480, Math.max(340, vh - 150)) };
  }
  return { left: 28, top: 24, width: Math.min(860, Math.max(520, vw - 220)), height: Math.min(540, Math.max(380, vh - 140)) };
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
      openPanelKind,
      scoreOverlayMode,
    }, '*');
  } catch {
    // 무시
  }
}

function applyTreeToolbarCutout() {
  const overlayEl = lastWbContainer?.querySelector('#wb-tree-overlay');
  if (!overlayEl) return;
  if (!lastToolbarRect || lastToolbarRect.right <= lastToolbarRect.left || lastToolbarRect.bottom <= lastToolbarRect.top) {
    overlayEl.style.clipPath = 'none';
    return;
  }
  const { left: l, top: t, right: r, bottom: b } = lastToolbarRect;
  // 원래 나무 크기(height: 100%)는 그대로 유지하고, 오직 하단바가 차지하는 사각형만 뒤로 들어가게 클리핑
  overlayEl.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${l}px ${t}px, ${r}px ${t}px, ${r}px ${b}px, ${l}px ${b}px, ${l}px ${t}px)`;
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
          if (openPanelKind === 'students' || openPanelKind === 'seats') renderFloatingPanel(lastWbContainer);
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
    openPanelKind = openPanelKind === nextKind ? null : nextKind;
    panelCollapsed = false;
    if (lastWbContainer) renderFloatingPanel(lastWbContainer);
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
          src="modules/whiteboard/index.html?v=cr2-6"
          title="클래스레볼루션2 만능칠판"
          allow="clipboard-read; clipboard-write; fullscreen"
        ></iframe>

        <!-- 만능칠판 우측 투명 학급점수 나무·목표 오버레이 (원래 사이즈 그대로, 하단바 뒤 레이어, 나무 호버 시 큰 황금알 표시) -->
        <div class="wb-tree-overlay" id="wb-tree-overlay" hidden></div>

        <!-- 만능칠판 6.0 원본 디자인 우측 도킹 점수판 (스플리터 폭 조절 가능, 황금알=학급점수 불변) -->
        <aside class="wb-board6-dock" id="wb-board6-overlay" hidden></aside>

        <!-- 자유 이동 · 리사이즈 플로팅 패널 (종류별 직전 크기·위치 기억) -->
        <div class="wb-float-panel" id="wb-float-panel" hidden></div>
      </div>
    `;
  }

  renderTreeOverlay(container);
  renderFloatingPanel(container);
  notifyToolbarState();
}

/** 학생목록·자리배치 플로팅 패널 전체(카드+하단바)를 원본 비율 그대로 패널 크기에 맞춰 스케일링 */
function applyPanelStageScale(bodyEl) {
  if (!bodyEl) return;
  const stage = bodyEl.querySelector('.wbf-scaled-stage');
  if (!stage) return;
  const baseW = 1280;
  const baseH = 740;
  const availW = Math.max(200, bodyEl.clientWidth);
  const availH = Math.max(160, bodyEl.clientHeight);
  const scale = Math.min(availW / baseW, availH / baseH);
  const scaledW = baseW * scale;
  const scaledH = baseH * scale;
  const offsetX = Math.max(0, (availW - scaledW) / 2);
  const offsetY = Math.max(0, (availH - scaledH) / 2);
  stage.style.width = `${baseW}px`;
  stage.style.height = `${baseH}px`;
  stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
}

/** 만능칠판 우측 학급점수 오버레이 (도구 버튼 3단 순환: off -> tree -> board6) */
function renderTreeOverlay(container) {
  const overlayEl = container.querySelector('#wb-tree-overlay');
  const board6El = container.querySelector('#wb-board6-overlay');
  if (!overlayEl || !board6El) return;

  if (scoreOverlayMode === 'off') {
    overlayEl.hidden = true;
    board6El.hidden = true;
    return;
  }

  if (scoreOverlayMode === 'board6') {
    overlayEl.hidden = true;
    board6El.hidden = false;
    renderBoard6Overlay(board6El, container);
    return;
  }

  // 황금알 나무 원본 크기 + 하단바 뒤 레이어 + 나무 호버 시 큰 황금알 부여 버튼
  board6El.hidden = true;
  overlayEl.hidden = false;
  renderGrowthView(overlayEl);
  applyTreeToolbarCutout();
}

const WB6_GROUP_COLORS = ['#2b8be0', '#39b3a2', '#f29038', '#e86f86', '#8dc228', '#9975d6', '#3ea6d8', '#d97706'];

/** 만능칠판 6.0 기존 점수판 디자인 복원 (우측 전체 높이 도킹 + 좌측 스플리터 폭 조절 + 설정 팝오버 + 연계율 연동) */
function renderBoard6Overlay(board6El, container) {
  const state = store.getState();
  const wbCfg = state.wbScoreboard || {};
  const students = (state.students || []).filter((s) => !s.trashed);
  const groups = [...(state.groups || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const baseMode = wbCfg.baseGroupMode === 'avg' ? 'avg' : 'sum';
  const defaultRate = Math.max(1, groups.length || 1);
  const linkRate = Math.max(1, Number(wbCfg.classLinkRate) || defaultRate);
  const carry = Number(wbCfg.specialPendingCarry) || 0;
  const eggs = state.growth?.eggs ?? 0;
  const carryPct = Math.min(100, Math.round((Math.abs(carry) / linkRate) * 100));

  board6El.style.width = `${board6Width}px`;

  const groupRows = groups.map((g, idx) => {
    const members = students.filter((s) => s.groupId === g.id);
    const sum = members.reduce((acc, m) => acc + (Number(m.score) || 0), 0);
    const baseScore = baseMode === 'avg'
      ? (members.length > 0 ? Math.floor(sum / members.length) : 0)
      : sum;
    const special = Number(wbCfg.specialGroupScores?.[g.id] || 0);
    return {
      group: g,
      color: WB6_GROUP_COLORS[idx % WB6_GROUP_COLORS.length],
      memberCount: members.length,
      baseScore,
      special,
      total: baseScore + special,
    };
  });

  board6El.innerHTML = `
    <div class="wb6-splitter" id="wb6-splitter" title="드래그하여 점수판 너비 조절"></div>
    <div class="wb6-dock-inner">
      <header class="wb6-orig-header">
        <div class="wb6-orig-title">
          <span class="wb6-orig-dot"></span>
          <strong>점수판</strong>
          <span class="wb6-orig-mode-tag">${baseMode === 'avg' ? '평균(버림)' : '합계'} · ${linkRate}점/알</span>
        </div>
        <div class="wb6-orig-actions">
          <button type="button" class="wb6-orig-icon-btn ${wb6SettingsOpen ? 'is-active' : ''}" id="wb6-toggle-cfg" title="점수판 설정">⚙️</button>
          <button type="button" class="wb6-orig-icon-btn" id="wb6-close" title="점수판 닫기">&times;</button>
        </div>
      </header>

      ${wb6SettingsOpen ? `
        <div class="wb6-settings-drawer">
          <div class="wb6-cfg-row">
            <span>기본 모둠점수</span>
            <div class="wb6-seg">
              <button type="button" class="${baseMode === 'sum' ? 'is-active' : ''}" data-wb6-basemode="sum">모둠원 합</button>
              <button type="button" class="${baseMode === 'avg' ? 'is-active' : ''}" data-wb6-basemode="avg">평균(버림)</button>
            </div>
          </div>
          <div class="wb6-cfg-row">
            <span>황금알 연계율 <small>(기본 ${defaultRate})</small></span>
            <div class="wb6-rate-ctrl">
              <button type="button" id="wb6-rate-dec">−</button>
              <strong>${linkRate}점당 1알</strong>
              <button type="button" id="wb6-rate-inc">+</button>
            </div>
          </div>
          <button type="button" class="wb6-reset-btn" id="wb6-reset-special">교사 특별 모둠점수만 초기화</button>
        </div>
      ` : ''}

      <!-- 만능칠판 6.0 상단 학급점수(황금알) 카드 -->
      <section class="wb6-orig-class-box">
        <div class="wb6-orig-class-head">
          <span>🏆 학급점수 (황금알)</span>
          <span class="wb6-orig-carry">연계 ${carry >= 0 ? `+${carry}` : carry} / ${linkRate}</span>
        </div>
        <div class="wb6-orig-class-row">
          <button type="button" class="wb6-orig-round-btn is-minus" id="wb6-egg-dec">−</button>
          <strong class="wb6-orig-class-score">${eggs}</strong>
          <button type="button" class="wb6-orig-round-btn is-plus" id="wb6-egg-inc">+</button>
        </div>
        <div class="wb6-orig-progress"><div style="width:${carryPct}%;"></div></div>
      </section>

      <!-- 모둠별 점수 카드 목록 (만능칠판 6.0 스타일) -->
      <div class="wb6-orig-group-list">
        ${groupRows.length === 0 ? `<div class="wb6-empty">등록된 모둠이 없습니다.</div>` : groupRows.map((r) => `
          <div class="wb6-orig-group-card" style="--g-accent:${r.color};">
            <div class="wb6-og-top">
              <span class="wb6-og-badge" style="background:${r.color};"></span>
              <strong class="wb6-og-name">${escapeHtml(r.group.name)}</strong>
              <span class="wb6-og-sub">${r.memberCount}명 · 기본 ${r.baseScore}${r.special !== 0 ? ` ${r.special > 0 ? `+ 특별 ${r.special}` : `− 특별 ${Math.abs(r.special)}`}` : ''}</span>
            </div>
            <div class="wb6-og-ctrl">
              <button type="button" class="wb6-orig-round-btn is-minus is-sm" data-wb6-gdelta="${r.group.id}" data-delta="-1">−</button>
              <strong class="wb6-og-score">${r.total}</strong>
              <button type="button" class="wb6-orig-round-btn is-plus is-sm" data-wb6-gdelta="${r.group.id}" data-delta="1">+</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  // 좌측 경계 스플리터 드래그로 점수판 너비 자유 조절
  const splitter = board6El.querySelector('#wb6-splitter');
  if (splitter) {
    splitter.onpointerdown = (ev) => {
      ev.preventDefault();
      const startX = ev.clientX;
      const origW = board6Width;
      splitter.setPointerCapture(ev.pointerId);
      const onMove = (me) => {
        board6Width = Math.max(260, Math.min(540, origW + (startX - me.clientX)));
        board6El.style.width = `${board6Width}px`;
      };
      const onUp = () => {
        saveBoard6Width(board6Width);
        splitter.removeEventListener('pointermove', onMove);
        splitter.removeEventListener('pointerup', onUp);
      };
      splitter.addEventListener('pointermove', onMove);
      splitter.addEventListener('pointerup', onUp);
    };
  }

  board6El.querySelector('#wb6-toggle-cfg').onclick = () => {
    wb6SettingsOpen = !wb6SettingsOpen;
    renderBoard6Overlay(board6El, container);
  };
  board6El.querySelector('#wb6-close').onclick = () => {
    scoreOverlayMode = 'off';
    wb6SettingsOpen = false;
    renderTreeOverlay(container);
    notifyToolbarState();
  };
  board6El.querySelector('#wb6-egg-inc').onclick = async () => {
    const out = await adjustSpecialEggs(1, '만능칠판 6.0 점수판 학급점수 +1');
    presentOutcome(out);
    renderBoard6Overlay(board6El, container);
  };
  board6El.querySelector('#wb6-egg-dec').onclick = async () => {
    const out = await adjustSpecialEggs(-1, '만능칠판 6.0 점수판 학급점수 -1');
    presentOutcome(out);
    renderBoard6Overlay(board6El, container);
  };

  board6El.querySelectorAll('[data-wb6-basemode]').forEach((b) => {
    b.onclick = async () => {
      const m = b.dataset.wb6Basemode === 'avg' ? 'avg' : 'sum';
      await store.update((s) => { s.wbScoreboard.baseGroupMode = m; });
      renderBoard6Overlay(board6El, container);
    };
  });

  const rateDec = board6El.querySelector('#wb6-rate-dec');
  if (rateDec) {
    rateDec.onclick = async () => {
      const next = Math.max(1, linkRate - 1);
      await store.update((s) => { s.wbScoreboard.classLinkRate = next; });
      renderBoard6Overlay(board6El, container);
    };
  }
  const rateInc = board6El.querySelector('#wb6-rate-inc');
  if (rateInc) {
    rateInc.onclick = async () => {
      const next = Math.min(99, linkRate + 1);
      await store.update((s) => { s.wbScoreboard.classLinkRate = next; });
      renderBoard6Overlay(board6El, container);
    };
  }

  // 교사 특별 모둠점수 가감 + 연계율 도달 시 황금알(학급점수) 자동 연동
  board6El.querySelectorAll('[data-wb6-gdelta]').forEach((b) => {
    b.onclick = async () => {
      const gid = b.dataset.wb6Gdelta;
      const delta = Number(b.dataset.delta) || 0;
      if (!delta) return;
      let eggDelta = 0;

      await store.update((s) => {
        if (!s.wbScoreboard.specialGroupScores) s.wbScoreboard.specialGroupScores = {};
        s.wbScoreboard.specialGroupScores[gid] = (Number(s.wbScoreboard.specialGroupScores[gid]) || 0) + delta;

        const curRate = Math.max(1, Number(s.wbScoreboard.classLinkRate) || Math.max(1, (s.groups || []).length));
        let nextCarry = (Number(s.wbScoreboard.specialPendingCarry) || 0) + delta;
        if (nextCarry >= curRate) {
          eggDelta = Math.floor(nextCarry / curRate);
          nextCarry = nextCarry % curRate;
        } else if (nextCarry <= -curRate) {
          eggDelta = -Math.floor(Math.abs(nextCarry) / curRate);
          nextCarry = -(Math.abs(nextCarry) % curRate);
        }
        s.wbScoreboard.specialPendingCarry = nextCarry;
      });

      if (eggDelta !== 0) {
        const gName = groups.find((x) => x.id === gid)?.name || '모둠';
        const out = await adjustSpecialEggs(eggDelta, `${gName} 특별점수 연계 (${linkRate}점당 1알)`);
        presentOutcome(out);
      }
      renderBoard6Overlay(board6El, container);
    };
  });

  const resetSpecialBtn = board6El.querySelector('#wb6-reset-special');
  if (resetSpecialBtn) {
    resetSpecialBtn.onclick = async () => {
      if (!confirm('교사 특별 모둠점수만 0으로 초기화할까요? (학급 황금알과 학생 개인점수는 유지됩니다)')) return;
      await store.update((s) => {
        s.wbScoreboard.specialGroupScores = {};
        s.wbScoreboard.specialPendingCarry = 0;
      });
      showToast({ title: '교사 특별 모둠점수를 초기화했습니다.' });
      renderBoard6Overlay(board6El, container);
    };
  }
}

function renderFloatingPanel(container) {
  const panelEl = container.querySelector('#wb-float-panel');
  if (!panelEl) return;

  if (!openPanelKind) {
    panelEl.hidden = true;
    return;
  }

  const kind = openPanelKind;
  panelEl.hidden = false;
  const host = container.querySelector('#wb-host');
  const maxW = Math.max(320, (host?.clientWidth || 1280) - 24);
  const maxH = Math.max(240, (host?.clientHeight || 800) - 90);
  const curLayout = { ...getPanelLayout(kind) };
  curLayout.width = Math.max(320, Math.min(curLayout.width, maxW));
  curLayout.height = Math.max(240, Math.min(curLayout.height, maxH));
  curLayout.left = Math.max(8, Math.min(curLayout.left, Math.max(8, (host?.clientWidth || 1280) - curLayout.width - 8)));
  curLayout.top = Math.max(8, Math.min(curLayout.top, Math.max(8, (host?.clientHeight || 800) - 80)));
  panelLayouts[kind] = curLayout;

  panelEl.style.left = `${curLayout.left}px`;
  panelEl.style.top = `${curLayout.top}px`;
  panelEl.style.width = `${curLayout.width}px`;
  panelEl.style.height = panelCollapsed ? 'auto' : `${curLayout.height}px`;

  const titleMap = {
    students: '👥 학생목록 (원본 비율)',
    seats: '🪑 자리배치 (원본 비율)',
    selfcheck: '☑️ 학생 셀프 체크표 (전자칠판 터치)',
    timer: '⏱ 수업 타이머 · 스톱워치',
  };

  panelEl.innerHTML = `
    <div class="wbf-header" id="wbf-drag-handle">
      <strong class="wbf-title">${titleMap[kind] || '도구'}</strong>
      <div class="wbf-zoom-controls">
        <button type="button" class="wbf-icon-btn" id="wbf-collapse" title="접기/펼치기">${panelCollapsed ? '▾' : '▴'}</button>
        <button type="button" class="wbf-icon-btn" id="wbf-close" title="닫기">&times;</button>
      </div>
    </div>
    ${panelCollapsed ? '' : `
      <div class="wbf-body is-native-host" id="wbf-native-body"></div>
      <div class="wbf-resize-handle" id="wbf-resize-handle" title="드래그하여 창 크기 조절"></div>
    `}
  `;

  panelEl.querySelector('#wbf-close').onclick = () => {
    savePanelLayouts();
    openPanelKind = null;
    renderFloatingPanel(container);
    notifyToolbarState();
  };
  panelEl.querySelector('#wbf-collapse').onclick = () => {
    panelCollapsed = !panelCollapsed;
    renderFloatingPanel(container);
  };

  // 본문 마운트
  const bodyEl = panelEl.querySelector('#wbf-native-body');
  if (bodyEl) {
    if (kind === 'students' || kind === 'seats') {
      bodyEl.innerHTML = `<div class="wbf-scaled-stage" style="width:1280px;height:740px;"></div>`;
      const stageEl = bodyEl.querySelector('.wbf-scaled-stage');
      setStudentsSubView(kind === 'seats' ? 'seats' : 'list');
      renderStudentsView(stageEl);
      applyPanelStageScale(bodyEl);
      requestAnimationFrame(() => {
        refitStudentsView(stageEl);
        applyPanelStageScale(bodyEl);
      });
    } else if (kind === 'timer') {
      renderTimerView(bodyEl);
    } else if (kind === 'selfcheck') {
      renderSelfCheckInPanel(bodyEl, container);
    }
  }

  // 드래그 이동 (종류별 위치 자동 기억)
  const dragHandle = panelEl.querySelector('#wbf-drag-handle');
  if (dragHandle) {
    dragHandle.onpointerdown = (ev) => {
      if (ev.target.closest('button')) return;
      ev.preventDefault();
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

  // 우하단 모서리 드래그 리사이즈 (종류별 크기 자동 기억 + 학생/자리배치 실시간 비율 스케일링)
  const resizeHandle = panelEl.querySelector('#wbf-resize-handle');
  if (resizeHandle) {
    resizeHandle.onpointerdown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const origW = panelLayouts[kind].width;
      const origH = panelLayouts[kind].height;
      resizeHandle.setPointerCapture(ev.pointerId);
      const onMove = (me) => {
        panelLayouts[kind].width = Math.max(320, Math.min(maxW, origW + (me.clientX - startX)));
        panelLayouts[kind].height = Math.max(240, Math.min(maxH, origH + (me.clientY - startY)));
        panelEl.style.width = `${panelLayouts[kind].width}px`;
        panelEl.style.height = `${panelLayouts[kind].height}px`;
        if (bodyEl && (kind === 'students' || kind === 'seats')) {
          applyPanelStageScale(bodyEl);
        }
      };
      const onUp = () => {
        savePanelLayouts();
        resizeHandle.removeEventListener('pointermove', onMove);
        resizeHandle.removeEventListener('pointerup', onUp);
        if (bodyEl && (kind === 'students' || kind === 'seats')) {
          applyPanelStageScale(bodyEl);
        }
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
