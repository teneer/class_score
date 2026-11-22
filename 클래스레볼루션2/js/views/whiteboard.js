// 만능칠판 6.0 이식 뷰 + 자유 이동/리사이즈/확대·축소 플로팅 패널(학생목록·자리배치·학급점수·셀프체크) + 학생 과제 이미지 수신 브리지

import { store, getStillAvatarUrl, todayIso } from '../store.js';
import { playSound } from '../audio.js';
import { adjustSpecialEggs } from '../score-engine.js';
import { openScoreComposer, presentOutcome, showToast, escapeHtml } from '../effects.js';

let mounted = false;
let wbIframeReady = false;
let pendingImportItems = null;
let navigateFn = null;

// 플로팅 패널 상태 (자유 이동 · 리사이즈 · 확대/축소 · 최소화)
let openPanelKind = null; // null | 'students' | 'seats' | 'growth' | 'selfcheck'
let panelState = {
  left: 24,
  top: 62,
  width: 480,
  height: 440,
  zoom: 1,
  collapsed: false,
};
let panelSelectedIds = new Set();
let activeSelfCheckId = null;

export function setWhiteboardNavigator(fn) {
  navigateFn = fn;
}

window.addEventListener('message', (ev) => {
  if (ev.data?.type === 'cr2-wb-ready') {
    wbIframeReady = true;
    flushPendingImports();
  }
});

function flushPendingImports() {
  if (!pendingImportItems || pendingImportItems.length === 0) return;
  const iframe = document.getElementById('cr2-whiteboard-frame');
  if (!iframe || !iframe.contentWindow) return;
  iframe.contentWindow.postMessage({ type: 'cr2-wb-import-images', items: pendingImportItems }, '*');
  pendingImportItems = null;
}

/** 과제관리에서 1명 또는 여러 학생의 과제 이미지를 만능칠판으로 원클릭 전송 */
export function sendImagesToWhiteboard(items) {
  if (!Array.isArray(items) || items.length === 0) return;
  pendingImportItems = items;
  if (typeof navigateFn === 'function') {
    navigateFn('whiteboard');
  }
  if (wbIframeReady) {
    setTimeout(flushPendingImports, 80);
  } else {
    // iframe 로드 완료 전이면 ready 이벤트 또는 fallback 타이머로 전달
    setTimeout(flushPendingImports, 900);
  }
}

/** 셀프 체크 변경 시 기존 체크표(checklist) 항목에도 양방향 동기화 */
export async function toggleSelfCheckValue(checkId, studentId) {
  let completedNow = false;
  await store.update((s) => {
    const sc = (s.selfChecks || []).find((x) => x.id === checkId);
    if (!sc) return;
    if (!sc.entries) sc.entries = {};
    if (sc.mode === 'count') {
      const target = Math.max(1, Number(sc.targetCount) || 5);
      const cur = Number(sc.entries[studentId]) || 0;
      const next = cur >= target ? 0 : cur + 1;
      sc.entries[studentId] = next;
      completedNow = next >= target;
    } else {
      const next = !Boolean(sc.entries[studentId]);
      sc.entries[studentId] = next;
      completedNow = next;
    }

    // 기존 체크표 모듈과 실시간 동기화
    if (sc.linkedChecklistId) {
      const today = todayIso();
      if (!s.checklist.entriesByDate[today]) s.checklist.entriesByDate[today] = {};
      const key = `${studentId}::${sc.linkedChecklistId}`;
      if (sc.mode === 'count') {
        const val = Number(sc.entries[studentId]) || 0;
        s.checklist.entriesByDate[today][key] = val > 0 ? `${val}/${sc.targetCount || 5}` : '';
      } else {
        s.checklist.entriesByDate[today][key] = Boolean(sc.entries[studentId]);
      }
    }
  });
  playSound(completedNow ? 'confirm' : 'tick');
}

/** 만능칠판 뷰 마운트 (재방문 시 판서 상태 유지) */
export function renderWhiteboardView(container) {
  if (!container) return;

  if (!mounted) {
    mounted = true;
    container.innerHTML = `
      <div class="wb-host" id="wb-host">
        <iframe
          id="cr2-whiteboard-frame"
          class="wb-iframe"
          src="modules/whiteboard/index.html?v=cr2-2"
          title="클래스레볼루션2 만능칠판"
          allow="clipboard-read; clipboard-write"
        ></iframe>

        <!-- 만능칠판 우측 상단 플로팅 도구 바 (패널 4종 + 빠른 으쓱/머쓱) -->
        <div class="wb-quick-score-bar" id="wb-quick-score-bar">
          <button type="button" class="wb-panel-toggle" data-wb-panel="students" title="학생목록 플로팅 패널 열기/닫기">👥 학생목록</button>
          <button type="button" class="wb-panel-toggle" data-wb-panel="seats" title="자리배치 플로팅 패널 열기/닫기">🪑 자리배치</button>
          <button type="button" class="wb-panel-toggle" data-wb-panel="growth" title="학급점수(황금알) 플로팅 패널 열기/닫기">🥚 학급점수</button>
          <button type="button" class="wb-panel-toggle" data-wb-panel="selfcheck" title="전자칠판 터치용 5열/10열 셀프 체크표 패널">☑️ 셀프체크</button>
          <span class="wb-bar-sep" aria-hidden="true"></span>
          <button type="button" class="wb-quick-btn is-plus" id="wb-btn-plus" title="으쓱(상점) 빠른 부여">
            <i class="sp-icon sp-star-blue" style="transform:scale(0.7);" aria-hidden="true"></i>
            <span>으쓱</span>
          </button>
          <button type="button" class="wb-quick-btn is-minus" id="wb-btn-minus" title="머쓱(감점) 빠른 부여">
            <i class="sp-icon sp-cloud-red" style="transform:scale(0.7);" aria-hidden="true"></i>
            <span>머쓱</span>
          </button>
        </div>

        <!-- 자유 이동 · 리사이즈 · 확대/축소 가능 플로팅 패널 -->
        <section class="wb-float-panel" id="wb-float-panel" hidden aria-label="만능칠판 보조 패널"></section>
      </div>
    `;

    container.querySelectorAll('[data-wb-panel]').forEach((btn) => {
      btn.onclick = () => {
        const kind = btn.dataset.wbPanel;
        if (openPanelKind === kind) {
          openPanelKind = null;
        } else {
          openPanelKind = kind;
          panelState.collapsed = false;
        }
        renderFloatingPanel(container);
      };
    });

    container.querySelector('#wb-btn-plus').onclick = () => {
      if (panelSelectedIds.size > 0) {
        const ids = Array.from(panelSelectedIds);
        openScoreComposer({
          studentIds: ids,
          initialType: 'positive',
          onApplied: () => { panelSelectedIds.clear(); renderFloatingPanel(container); },
        });
      } else {
        openPanelKind = 'students';
        panelState.collapsed = false;
        renderFloatingPanel(container);
        showToast({ title: '패널에서 학생을 선택한 뒤 [으쓱]을 눌러주세요.' });
      }
    };

    container.querySelector('#wb-btn-minus').onclick = () => {
      if (panelSelectedIds.size > 0) {
        const ids = Array.from(panelSelectedIds);
        openScoreComposer({
          studentIds: ids,
          initialType: 'negative',
          onApplied: () => { panelSelectedIds.clear(); renderFloatingPanel(container); },
        });
      } else {
        openPanelKind = 'students';
        panelState.collapsed = false;
        renderFloatingPanel(container);
        showToast({ title: '패널에서 학생을 선택한 뒤 [머쓱]을 눌러주세요.' });
      }
    };
  }

  renderFloatingPanel(container);
}

function renderFloatingPanel(container) {
  const panelEl = container.querySelector('#wb-float-panel');
  if (!panelEl) return;

  container.querySelectorAll('[data-wb-panel]').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.wbPanel === openPanelKind);
  });

  if (!openPanelKind) {
    panelEl.hidden = true;
    return;
  }

  const state = store.getState();
  const students = state.students.filter((s) => !s.trashed).sort((a, b) => a.number - b.number);
  const groups = [...(state.groups || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const titleMap = {
    students: '👥 학생목록',
    seats: '🪑 자리배치',
    growth: '🥚 학급점수 (황금알)',
    selfcheck: '☑️ 학생 셀프 체크표 (터치형)',
  };

  panelEl.hidden = false;
  panelEl.style.left = `${panelState.left}px`;
  panelEl.style.top = `${panelState.top}px`;
  panelEl.style.width = `${panelState.width}px`;
  panelEl.style.height = panelState.collapsed ? 'auto' : `${panelState.height}px`;
  panelEl.classList.toggle('is-collapsed', panelState.collapsed);

  let bodyHtml = '';
  let footHtml = '';

  if (openPanelKind === 'students') {
    bodyHtml = `
      <div class="wbf-student-grid">
        ${students.map((s) => `
          <button type="button" class="wbf-st-card ${panelSelectedIds.has(s.id) ? 'is-selected' : ''} ${s.absent ? 'is-absent' : ''}" data-wbf-st="${s.id}">
            <img src="${getStillAvatarUrl(s.avatarId)}" alt="" loading="lazy">
            <span class="wbf-st-num">${s.number}</span>
            <span class="wbf-st-name">${escapeHtml(s.name)}</span>
            <span class="wbf-st-score">${s.score}</span>
          </button>
        `).join('')}
      </div>
    `;
    footHtml = `
      <div class="wbf-foot">
        <button type="button" class="wbf-mini-btn" id="wbf-sel-all">전체선택</button>
        <button type="button" class="wbf-mini-btn" id="wbf-sel-none">해제</button>
        <span class="wbf-sel-cnt">${panelSelectedIds.size}명 선택</span>
        <button type="button" class="wbf-act-btn is-plus" id="wbf-give-plus" ${panelSelectedIds.size === 0 ? 'disabled' : ''}>★ 으쓱</button>
        <button type="button" class="wbf-act-btn is-minus" id="wbf-give-minus" ${panelSelectedIds.size === 0 ? 'disabled' : ''}>☁ 머쓱</button>
      </div>
    `;
  } else if (openPanelKind === 'seats') {
    bodyHtml = `
      <div class="wbf-seat-groups">
        ${groups.map((g) => {
          const members = students.filter((s) => s.groupId === g.id).sort((a, b) => (a.seatIndex ?? 0) - (b.seatIndex ?? 0));
          const allG = members.length > 0 && members.every((m) => panelSelectedIds.has(m.id));
          return `
            <div class="wbf-group-box">
              <button type="button" class="wbf-group-head ${allG ? 'is-selected' : ''}" data-wbf-grp="${g.id}">
                <span>${escapeHtml(g.name)}</span>
                <small>${members.reduce((sum, m) => sum + (m.score || 0), 0)}점</small>
              </button>
              <div class="wbf-group-members">
                ${members.map((m) => `
                  <button type="button" class="wbf-seat-pill ${panelSelectedIds.has(m.id) ? 'is-selected' : ''}" data-wbf-st="${m.id}">
                    <span>${m.number} ${escapeHtml(m.name)}</span>
                    <strong>${m.score}</strong>
                  </button>
                `).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
    footHtml = `
      <div class="wbf-foot">
        <button type="button" class="wbf-mini-btn" id="wbf-sel-all">전체선택</button>
        <button type="button" class="wbf-mini-btn" id="wbf-sel-none">해제</button>
        <span class="wbf-sel-cnt">${panelSelectedIds.size}명 선택</span>
        <button type="button" class="wbf-act-btn is-plus" id="wbf-give-plus" ${panelSelectedIds.size === 0 ? 'disabled' : ''}>★ 으쓱</button>
        <button type="button" class="wbf-act-btn is-minus" id="wbf-give-minus" ${panelSelectedIds.size === 0 ? 'disabled' : ''}>☁ 머쓱</button>
      </div>
    `;
  } else if (openPanelKind === 'growth') {
    const gr = state.growth || {};
    const eggs = Number(gr.eggs) || 0;
    const starsPerEgg = Number(state.classInfo?.starsPerEgg) || 10;
    const trailCnt = (gr.pendingTrail || []).length;
    const nextGoal = [...(gr.goals || [])].sort((a, b) => a.targetEggs - b.targetEggs).find((g) => g.targetEggs > eggs);
    bodyHtml = `
      <div class="wbf-growth-card">
        <div class="wbf-egg-hero">
          <div class="wbf-egg-num">🥚 ${eggs}개</div>
          <div class="wbf-egg-sub">별길 진행: ${trailCnt} / ${starsPerEgg}별</div>
          ${nextGoal ? `<div class="wbf-goal-pill">다음 목표: ${nextGoal.targetEggs}개 · ${escapeHtml(nextGoal.reward)}</div>` : `<div class="wbf-goal-pill">모든 목표 달성!</div>`}
        </div>
        <div class="wbf-egg-btns">
          <button type="button" class="wbf-act-btn is-minus" id="wbf-egg-dec">황금알 −1</button>
          <button type="button" class="wbf-act-btn is-plus" id="wbf-egg-inc">황금알 +1</button>
        </div>
      </div>
    `;
  } else if (openPanelKind === 'selfcheck') {
    const selfChecks = state.selfChecks || [];
    if (!activeSelfCheckId || !selfChecks.some((x) => x.id === activeSelfCheckId)) {
      activeSelfCheckId = selfChecks[0]?.id || null;
    }
    const curSc = selfChecks.find((x) => x.id === activeSelfCheckId) || null;
    const cols = (curSc?.gridColumns || curSc?.columns) === 10 ? 10 : 5;
    const targetList = curSc && Array.isArray(curSc.targetStudentIds)
      ? students.filter((s) => curSc.targetStudentIds.includes(s.id))
      : students;
    const doneCount = curSc ? targetList.filter((s) => {
      const v = curSc.entries?.[s.id];
      return curSc.mode === 'count' ? (Number(v) || 0) >= (Number(curSc.targetCount) || 5) : Boolean(v);
    }).length : 0;

    bodyHtml = selfChecks.length === 0 ? `
      <div class="wbf-empty-sc">
        <p>등록된 셀프 체크표가 없습니다.</p>
        <p>좌측 <strong>[체크표] → [셀프 체크표]</strong>에서 항목을 만들어 주세요.</p>
      </div>
    ` : `
      <div class="wbf-sc-bar">
        <select id="wbf-sc-select">
          ${selfChecks.map((sc) => `<option value="${sc.id}" ${sc.id === curSc.id ? 'selected' : ''}>${escapeHtml(sc.title)}</option>`).join('')}
        </select>
        <button type="button" class="wbf-mini-btn ${cols === 5 ? 'is-active' : ''}" data-wbf-cols="5">5열</button>
        <button type="button" class="wbf-mini-btn ${cols === 10 ? 'is-active' : ''}" data-wbf-cols="10">10열</button>
        <span class="wbf-sc-prog">${doneCount}/${targetList.length}</span>
      </div>
      <div class="wbf-sc-grid" style="grid-template-columns:repeat(${cols}, minmax(0, 1fr));">
        ${targetList.map((s) => {
          const val = curSc.entries?.[s.id];
          const targetCnt = Number(curSc.targetCount) || 5;
          const isDone = curSc.mode === 'count' ? (Number(val) || 0) >= targetCnt : Boolean(val);
          const countTxt = curSc.mode === 'count' ? `${Number(val) || 0}/${targetCnt}` : (isDone ? '✓' : '');
          return `
            <button type="button" class="wbf-sc-btn ${isDone ? 'is-done' : ''}" data-wbf-sc-toggle="${s.id}">
              <span class="wbf-sc-num">${s.number}</span>
              <span class="wbf-sc-name">${escapeHtml(s.name)}</span>
              ${countTxt ? `<span class="wbf-sc-mark">${countTxt}</span>` : ''}
            </button>
          `;
        }).join('')}
      </div>
    `;
  }

  panelEl.innerHTML = `
    <div class="wbf-header" id="wbf-drag-handle">
      <strong class="wbf-title">${titleMap[openPanelKind] || '패널'}</strong>
      <div class="wbf-zoom-controls">
        <button type="button" class="wbf-icon-btn" id="wbf-zoom-out" title="내용 축소">−</button>
        <span class="wbf-zoom-label">${Math.round(panelState.zoom * 100)}%</span>
        <button type="button" class="wbf-icon-btn" id="wbf-zoom-in" title="내용 확대">+</button>
        <button type="button" class="wbf-icon-btn" id="wbf-collapse" title="접기/펼치기">${panelState.collapsed ? '▾' : '▴'}</button>
        <button type="button" class="wbf-icon-btn" id="wbf-close" title="닫기">&times;</button>
      </div>
    </div>
    ${panelState.collapsed ? '' : `
      <div class="wbf-body">
        <div class="wbf-zoom-inner" style="zoom:${panelState.zoom};">
          ${bodyHtml}
        </div>
      </div>
      ${footHtml}
      <div class="wbf-resize-handle" id="wbf-resize-handle" title="드래그하여 창 크기 조절"></div>
    `}
  `;

  // 창 닫기 / 접기 / 확대·축소
  panelEl.querySelector('#wbf-close').onclick = () => { openPanelKind = null; renderFloatingPanel(container); };
  panelEl.querySelector('#wbf-collapse').onclick = () => { panelState.collapsed = !panelState.collapsed; renderFloatingPanel(container); };
  panelEl.querySelector('#wbf-zoom-out').onclick = () => {
    panelState.zoom = Math.max(0.65, Number((panelState.zoom - 0.1).toFixed(2)));
    renderFloatingPanel(container);
  };
  panelEl.querySelector('#wbf-zoom-in').onclick = () => {
    panelState.zoom = Math.min(1.45, Number((panelState.zoom + 0.1).toFixed(2)));
    renderFloatingPanel(container);
  };

  // 헤더 드래그로 자유 이동 (iframe 위에서도 끊기지 않도록 host에 포인터 캡처)
  const dragHandle = panelEl.querySelector('#wbf-drag-handle');
  dragHandle.onpointerdown = (ev) => {
    if (ev.target.closest('button')) return;
    ev.preventDefault();
    const hostRect = container.querySelector('#wb-host').getBoundingClientRect();
    const startX = ev.clientX;
    const startY = ev.clientY;
    const origL = panelState.left;
    const origT = panelState.top;
    dragHandle.setPointerCapture(ev.pointerId);
    const onMove = (m) => {
      panelState.left = Math.max(0, Math.min(hostRect.width - 140, origL + (m.clientX - startX)));
      panelState.top = Math.max(0, Math.min(hostRect.height - 44, origT + (m.clientY - startY)));
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

  // 우하단 핸들 드래그로 창 크기 조절
  const resizeHandle = panelEl.querySelector('#wbf-resize-handle');
  if (resizeHandle) {
    resizeHandle.onpointerdown = (ev) => {
      ev.preventDefault();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const origW = panelState.width;
      const origH = panelState.height;
      resizeHandle.setPointerCapture(ev.pointerId);
      const onMove = (m) => {
        panelState.width = Math.max(300, Math.min(1100, origW + (m.clientX - startX)));
        panelState.height = Math.max(220, Math.min(820, origH + (m.clientY - startY)));
        panelEl.style.width = `${panelState.width}px`;
        panelEl.style.height = `${panelState.height}px`;
      };
      const onUp = () => {
        resizeHandle.removeEventListener('pointermove', onMove);
        resizeHandle.removeEventListener('pointerup', onUp);
      };
      resizeHandle.addEventListener('pointermove', onMove);
      resizeHandle.addEventListener('pointerup', onUp);
    };
  }

  // 학생/모둠 선택 및 점수 부여
  panelEl.querySelectorAll('[data-wbf-st]').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.wbfSt;
      if (panelSelectedIds.has(id)) panelSelectedIds.delete(id);
      else panelSelectedIds.add(id);
      renderFloatingPanel(container);
    };
  });
  panelEl.querySelectorAll('[data-wbf-grp]').forEach((b) => {
    b.onclick = () => {
      const gid = b.dataset.wbfGrp;
      const members = students.filter((s) => s.groupId === gid);
      const allG = members.every((m) => panelSelectedIds.has(m.id));
      if (allG) members.forEach((m) => panelSelectedIds.delete(m.id));
      else members.forEach((m) => panelSelectedIds.add(m.id));
      renderFloatingPanel(container);
    };
  });
  const selAll = panelEl.querySelector('#wbf-sel-all');
  if (selAll) selAll.onclick = () => { students.filter((s) => !s.absent).forEach((s) => panelSelectedIds.add(s.id)); renderFloatingPanel(container); };
  const selNone = panelEl.querySelector('#wbf-sel-none');
  if (selNone) selNone.onclick = () => { panelSelectedIds.clear(); renderFloatingPanel(container); };
  const giveP = panelEl.querySelector('#wbf-give-plus');
  if (giveP) giveP.onclick = () => {
    openScoreComposer({
      studentIds: Array.from(panelSelectedIds),
      initialType: 'positive',
      onApplied: () => { panelSelectedIds.clear(); renderFloatingPanel(container); },
    });
  };
  const giveM = panelEl.querySelector('#wbf-give-minus');
  if (giveM) giveM.onclick = () => {
    openScoreComposer({
      studentIds: Array.from(panelSelectedIds),
      initialType: 'negative',
      onApplied: () => { panelSelectedIds.clear(); renderFloatingPanel(container); },
    });
  };

  // 학급점수(황금알) 조정
  const eggInc = panelEl.querySelector('#wbf-egg-inc');
  if (eggInc) eggInc.onclick = async () => { const out = await adjustSpecialEggs(1); presentOutcome(out); renderFloatingPanel(container); };
  const eggDec = panelEl.querySelector('#wbf-egg-dec');
  if (eggDec) eggDec.onclick = async () => { const out = await adjustSpecialEggs(-1); presentOutcome(out); renderFloatingPanel(container); };

  // 셀프 체크표 터치
  const scSel = panelEl.querySelector('#wbf-sc-select');
  if (scSel) scSel.onchange = () => { activeSelfCheckId = scSel.value; renderFloatingPanel(container); };
  panelEl.querySelectorAll('[data-wbf-cols]').forEach((b) => {
    b.onclick = async () => {
      const c = Number(b.dataset.wbfCols);
      await store.update((s) => {
        const sc = (s.selfChecks || []).find((x) => x.id === activeSelfCheckId);
        if (sc) {
          sc.gridColumns = c;
          sc.columns = c;
        }
      });
      renderFloatingPanel(container);
    };
  });
  panelEl.querySelectorAll('[data-wbf-sc-toggle]').forEach((b) => {
    b.onclick = async () => {
      if (!activeSelfCheckId) return;
      await toggleSelfCheckValue(activeSelfCheckId, b.dataset.wbfScToggle);
      renderFloatingPanel(container);
    };
  });
}
