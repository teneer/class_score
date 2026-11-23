// 만능칠판 6.0 풀스크린 뷰 — 하단바 통합 도구(끝내기·학생목록·자리배치·학급점수 투명 나무 오버레이·체크표·타이머·으쓱/머쓱) + 학생 과제 이미지 수신 브리지

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

let mounted = false;
let wbIframeReady = false;
let pendingImportItems = null;
let navigateFn = null;
let exitHandler = null;
let lastWbContainer = null;
let lastToolbarRect = null;

// 플로팅 패널 상태 (자유 이동 · 리사이즈 · 접기)
let openPanelKind = null; // null | 'students' | 'seats' | 'selfcheck' | 'timer'
let treeOverlayOpen = false; // 만능칠판 우측 투명 나무·목표 오버레이 ON/OFF
let panelState = {
  left: 28,
  top: 24,
  width: 720,
  height: 480,
  collapsed: false,
};
let activeSelfCheckId = null;

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
      treeOverlayOpen,
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
          if (treeOverlayOpen) renderTreeOverlay(lastWbContainer);
          if (openPanelKind === 'students' || openPanelKind === 'seats') renderFloatingPanel(lastWbContainer);
        }
      },
    });
    return;
  }
  if (action === 'toggle-tree') {
    treeOverlayOpen = !treeOverlayOpen;
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
    panelState.collapsed = false;
    // 패널 종류별 최적 초기 크기
    if (openPanelKind === 'timer') {
      panelState.width = Math.min(520, Math.max(380, window.innerWidth - 60));
      panelState.height = Math.min(440, Math.max(340, window.innerHeight - 130));
    } else if (openPanelKind === 'students' || openPanelKind === 'seats') {
      panelState.width = Math.min(860, Math.max(520, window.innerWidth - 220));
      panelState.height = Math.min(540, Math.max(380, window.innerHeight - 140));
    } else if (openPanelKind === 'selfcheck') {
      panelState.width = Math.min(640, Math.max(420, window.innerWidth - 200));
      panelState.height = Math.min(480, Math.max(340, window.innerHeight - 150));
    }
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
          src="modules/whiteboard/index.html?v=cr2-5"
          title="클래스레볼루션2 만능칠판"
          allow="clipboard-read; clipboard-write; fullscreen"
        ></iframe>

        <!-- 만능칠판 우측 투명 학급점수 나무·목표 오버레이 (원래 사이즈 그대로, 하단바 아래쪽 레이어) -->
        <div class="wb-tree-overlay" id="wb-tree-overlay" hidden></div>

        <!-- 만능칠판 우측 6.0 점수판 오버레이 (황금알 나무와 원클릭 전환, 학급점수=황금알 불변) -->
        <aside class="wb-board6-overlay" id="wb-board6-overlay" hidden></aside>

        <!-- 자유 이동 · 리사이즈 플로팅 패널 (학생목록·자리배치·체크표·타이머) -->
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

/** 만능칠판 우측 학급점수 오버레이 (황금알 나무 ↔ 만능칠판 6.0 점수판 전환, 학급점수=황금알 불변) */
function renderTreeOverlay(container) {
  const overlayEl = container.querySelector('#wb-tree-overlay');
  const board6El = container.querySelector('#wb-board6-overlay');
  if (!overlayEl || !board6El) return;

  if (!treeOverlayOpen) {
    overlayEl.hidden = true;
    board6El.hidden = true;
    return;
  }

  const state = store.getState();
  const wbCfg = state.wbScoreboard || { displayMode: 'tree', baseGroupMode: 'sum', specialGroupScores: {}, classLinkRate: null, specialPendingCarry: 0 };

  if (wbCfg.displayMode === 'board6') {
    overlayEl.hidden = true;
    board6El.hidden = false;
    renderBoard6Overlay(board6El, container);
    return;
  }

  // 기본 모드: 황금알 나무 원본 크기 + 하단바 뒤 레이어
  board6El.hidden = true;
  overlayEl.hidden = false;
  renderGrowthView(overlayEl);
  applyTreeToolbarCutout();

  // 나무 위 우측 상단에 '6.0 점수판 전환' 미니 버튼 부착
  let switchBtn = overlayEl.querySelector('#wb-switch-to-board6');
  if (!switchBtn) {
    switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.id = 'wb-switch-to-board6';
    switchBtn.className = 'wb-mode-switch-pill';
    switchBtn.textContent = '📊 6.0 점수판';
    switchBtn.title = '만능칠판 6.0 점수판으로 전환 (황금알=학급점수 유지)';
    overlayEl.appendChild(switchBtn);
  }
  switchBtn.onclick = async () => {
    await store.update((s) => { s.wbScoreboard.displayMode = 'board6'; });
    renderTreeOverlay(container);
  };
}

/** 만능칠판 6.0 점수판 오버레이 (기본 모둠점수 합/평균(버림) + 교사 특별 모둠점수 + 연계율 가감 + 학급점수=황금알 연동) */
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

  board6El.innerHTML = `
    <div class="wb6-header">
      <strong>📊 만능칠판 6.0 점수판</strong>
      <div class="wb6-head-btns">
        <button type="button" class="wb6-switch-btn" id="wb6-to-tree" title="황금알 나무로 전환 (학급점수 유지)">🥚 나무로</button>
        <button type="button" class="wb6-close-btn" id="wb6-close" title="점수판 닫기">&times;</button>
      </div>
    </div>

    <div class="wb6-class-card">
      <div class="wb6-class-top">
        <span class="wb6-class-label">🥚 학급점수 (황금알)</span>
        <span class="wb6-carry-badge" title="특별 모둠점수 누적 → 연계율 도달 시 황금알 자동 반영">누적 ${carry}/${linkRate}</span>
      </div>
      <div class="wb6-class-main">
        <button type="button" class="wb6-step-btn is-minus" id="wb6-egg-dec">−1</button>
        <strong class="wb6-class-val">${eggs}</strong>
        <button type="button" class="wb6-step-btn is-plus" id="wb6-egg-inc">+1</button>
      </div>
    </div>

    <div class="wb6-config-bar">
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
    </div>

    <div class="wb6-group-list">
      ${groupRows.length === 0 ? `<div class="wb6-empty">등록된 모둠이 없습니다.</div>` : groupRows.map((r) => `
        <div class="wb6-group-card">
          <div class="wb6-g-info">
            <div class="wb6-g-name">${escapeHtml(r.group.name)} <small>(${r.memberCount}명)</small></div>
            <div class="wb6-g-detail">기본 ${r.baseScore} ${r.special >= 0 ? `+ 특별 ${r.special}` : `− 특별 ${Math.abs(r.special)}`}</div>
          </div>
          <div class="wb6-g-ctrl">
            <button type="button" class="wb6-g-btn is-minus" data-wb6-gdelta="${r.group.id}" data-delta="-1">−</button>
            <strong class="wb6-g-total">${r.total}</strong>
            <button type="button" class="wb6-g-btn is-plus" data-wb6-gdelta="${r.group.id}" data-delta="1">+</button>
          </div>
        </div>
      `).join('')}
    </div>

    <div class="wb6-footer">
      <button type="button" class="wb6-reset-btn" id="wb6-reset-special">교사 특별 모둠점수 초기화</button>
    </div>
  `;

  board6El.querySelector('#wb6-to-tree').onclick = async () => {
    await store.update((s) => { s.wbScoreboard.displayMode = 'tree'; });
    renderTreeOverlay(container);
  };
  board6El.querySelector('#wb6-close').onclick = () => {
    treeOverlayOpen = false;
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

  board6El.querySelector('#wb6-rate-dec').onclick = async () => {
    const next = Math.max(1, linkRate - 1);
    await store.update((s) => { s.wbScoreboard.classLinkRate = next; });
    renderBoard6Overlay(board6El, container);
  };
  board6El.querySelector('#wb6-rate-inc').onclick = async () => {
    const next = Math.min(99, linkRate + 1);
    await store.update((s) => { s.wbScoreboard.classLinkRate = next; });
    renderBoard6Overlay(board6El, container);
  };

  // 교사 특별 모둠점수 가감 + 모둠점수 연계율에 따른 황금알(학급점수) 자동 연동
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

  board6El.querySelector('#wb6-reset-special').onclick = async () => {
    if (!confirm('교사 특별 모둠점수만 0으로 초기화할까요? (학급 황금알과 학생 개인점수는 유지됩니다)')) return;
    await store.update((s) => {
      s.wbScoreboard.specialGroupScores = {};
      s.wbScoreboard.specialPendingCarry = 0;
    });
    showToast({ title: '교사 특별 모둠점수를 초기화했습니다.' });
    renderBoard6Overlay(board6El, container);
  };
}

function renderFloatingPanel(container) {
  const panelEl = container.querySelector('#wb-float-panel');
  if (!panelEl) return;

  if (!openPanelKind) {
    panelEl.hidden = true;
    return;
  }

  panelEl.hidden = false;
  const host = container.querySelector('#wb-host');
  const maxW = Math.max(320, (host?.clientWidth || 1280) - 24);
  const maxH = Math.max(240, (host?.clientHeight || 800) - 90);
  panelState.width = Math.max(320, Math.min(panelState.width, maxW));
  panelState.height = Math.max(240, Math.min(panelState.height, maxH));
  panelState.left = Math.max(8, Math.min(panelState.left, Math.max(8, (host?.clientWidth || 1280) - panelState.width - 8)));
  panelState.top = Math.max(8, Math.min(panelState.top, Math.max(8, (host?.clientHeight || 800) - 80)));

  panelEl.style.left = `${panelState.left}px`;
  panelEl.style.top = `${panelState.top}px`;
  panelEl.style.width = `${panelState.width}px`;
  panelEl.style.height = panelState.collapsed ? 'auto' : `${panelState.height}px`;

  const titleMap = {
    students: '👥 학생목록 (원본 비율)',
    seats: '🪑 자리배치 (원본 비율)',
    selfcheck: '☑️ 학생 셀프 체크표 (전자칠판 터치)',
    timer: '⏱ 수업 타이머 · 스톱워치',
  };

  panelEl.innerHTML = `
    <div class="wbf-header" id="wbf-drag-handle">
      <strong class="wbf-title">${titleMap[openPanelKind] || '도구'}</strong>
      <div class="wbf-zoom-controls">
        <button type="button" class="wbf-icon-btn" id="wbf-collapse" title="접기/펼치기">${panelState.collapsed ? '▾' : '▴'}</button>
        <button type="button" class="wbf-icon-btn" id="wbf-close" title="닫기">&times;</button>
      </div>
    </div>
    ${panelState.collapsed ? '' : `
      <div class="wbf-body is-native-host" id="wbf-native-body"></div>
      <div class="wbf-resize-handle" id="wbf-resize-handle" title="드래그하여 창 크기 조절"></div>
    `}
  `;

  panelEl.querySelector('#wbf-close').onclick = () => {
    openPanelKind = null;
    renderFloatingPanel(container);
    notifyToolbarState();
  };
  panelEl.querySelector('#wbf-collapse').onclick = () => {
    panelState.collapsed = !panelState.collapsed;
    renderFloatingPanel(container);
  };

  // 본문 마운트: 학생목록 / 자리배치는 가상 1280x740 스테이지에 담아 카드+하단바 전체를 동일 비율로 축소/확대!
  const bodyEl = panelEl.querySelector('#wbf-native-body');
  if (bodyEl) {
    if (openPanelKind === 'students' || openPanelKind === 'seats') {
      bodyEl.innerHTML = `<div class="wbf-scaled-stage" style="width:1280px;height:740px;"></div>`;
      const stageEl = bodyEl.querySelector('.wbf-scaled-stage');
      setStudentsSubView(openPanelKind === 'seats' ? 'seats' : 'list');
      renderStudentsView(stageEl);
      applyPanelStageScale(bodyEl);
      requestAnimationFrame(() => {
        refitStudentsView(stageEl);
        applyPanelStageScale(bodyEl);
      });
    } else if (openPanelKind === 'timer') {
      renderTimerView(bodyEl);
    } else if (openPanelKind === 'selfcheck') {
      renderSelfCheckInPanel(bodyEl, container);
    }
  }

  // 드래그 이동 (헤더 바)
  const dragHandle = panelEl.querySelector('#wbf-drag-handle');
  if (dragHandle) {
    dragHandle.onpointerdown = (ev) => {
      if (ev.target.closest('button')) return;
      ev.preventDefault();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const origLeft = panelState.left;
      const origTop = panelState.top;
      dragHandle.setPointerCapture(ev.pointerId);
      const onMove = (me) => {
        panelState.left = Math.max(0, origLeft + (me.clientX - startX));
        panelState.top = Math.max(0, origTop + (me.clientY - startY));
        panelEl.style.left = `${panelState.left}px`;
        panelEl.style.top = `${panelState.top}px`;
      };
      const onUp = () => {
        dragHandle.removeEventListener('pointermove', onMove);
        dragHandle.removeEventListener('pointerup', onUp);
      };
      dragHandle.addEventListener('pointermove', onMove);
      dragHandle.addEventListener('pointerup', onUp);
    };
  }

  // 우하단 모서리 드래그 리사이즈 (학생목록·자리배치는 비율 유지 실시간 리핏!)
  const resizeHandle = panelEl.querySelector('#wbf-resize-handle');
  if (resizeHandle) {
    resizeHandle.onpointerdown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const origW = panelState.width;
      const origH = panelState.height;
      resizeHandle.setPointerCapture(ev.pointerId);
      const onMove = (me) => {
        panelState.width = Math.max(320, Math.min(maxW, origW + (me.clientX - startX)));
        panelState.height = Math.max(240, Math.min(maxH, origH + (me.clientY - startY)));
        panelEl.style.width = `${panelState.width}px`;
        panelEl.style.height = `${panelState.height}px`;
        if (bodyEl && (openPanelKind === 'students' || openPanelKind === 'seats')) {
          applyPanelStageScale(bodyEl);
        }
      };
      const onUp = () => {
        resizeHandle.removeEventListener('pointermove', onMove);
        resizeHandle.removeEventListener('pointerup', onUp);
        if (bodyEl && (openPanelKind === 'students' || openPanelKind === 'seats')) {
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
