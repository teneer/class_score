// 체크표 (명렬 기록 화면) — 주간 날짜 바 · 4가지 입력(체크/◎○△×/5~1/Score) · 열 통계 · 우측 학생 프리뷰 · 선별 수동 지급

import { store, todayIso, uid } from '../store.js';
import { openScoreComposer, showToast, escapeHtml, escapeAttr } from '../effects.js';
import { playSound } from '../audio.js';
import { toggleSelfCheckValue } from './whiteboard.js';
import { isCloudConnected, syncTeacherStateToCloud } from '../cloud-sync.js';

let currentDate = todayIso();
let pickedStudentIds = new Set();
let checklistTab = 'matrix'; // 'matrix' | 'selfCheck'
let activeSelfCheckId = null;

async function syncSelfChecksToCloud() {
  if (!isCloudConnected()) return;
  try {
    await syncTeacherStateToCloud(store.getState());
  } catch (err) {
    console.warn('[CR2 SelfCheck] cloud sync failed:', err);
  }
}

const ITEM_COLORS = ['#f29038', '#6b86e8', '#39b3a2', '#e86f86', '#8dc228', '#9975d6', '#3ea6d8'];
const SYMBOLS = [
  { val: '◎', cls: 'is-on-double', barColor: '#36a9a6' },
  { val: '○', cls: 'is-on-circle', barColor: '#8dc228' },
  { val: '△', cls: 'is-on-tri', barColor: '#f7c331' },
  { val: '×', cls: 'is-on-x', barColor: '#f2757b' },
];
const RATINGS = ['5', '4', '3', '2', '1'];

function parseIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function formatIso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function getWeekDates(anchorIso) {
  const base = parseIso(anchorIso);
  const dow = base.getDay(); // 0=일
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(base);
  monday.setDate(base.getDate() + diffToMon);
  const dayNames = ['월', '화', '수', '목', '금', '토', '일'];
  return Array.from({ length: 7 }, (_, i) => {
    const dt = new Date(monday);
    dt.setDate(monday.getDate() + i);
    return {
      iso: formatIso(dt),
      dow: dayNames[i],
      label: `${dt.getMonth() + 1}월 ${dt.getDate()}일`,
    };
  });
}

function countDayEntries(state, iso) {
  const map = state.checklist.entriesByDate[iso];
  if (!map) return 0;
  const touchedItems = new Set();
  for (const [k, v] of Object.entries(map)) {
    if (v !== '' && v !== false && v !== null && v !== undefined) {
      const itemId = k.split('::')[1];
      if (itemId) touchedItems.add(itemId);
    }
  }
  return touchedItems.size;
}

export function renderChecklistView(root) {
  if (checklistTab === 'selfCheck') {
    renderSelfCheckTab(root);
    return;
  }

  const state = store.getState();
  const students = state.students.filter((s) => !s.trashed).sort((a, b) => a.number - b.number);
  const activeItems = state.checklist.items.filter((it) => !it.archived).sort((a, b) => a.order - b.order);
  const entries = state.checklist.entriesByDate[currentDate] || {};
  const week = getWeekDates(currentDate);

  for (const id of Array.from(pickedStudentIds)) {
    if (!students.some((s) => s.id === id)) pickedStudentIds.delete(id);
  }

  root.innerHTML = `
    <div class="checklist-shell ${state.uiPrefs.showNumbers ? '' : 'hide-numbers'}">
      <div class="checklist-mode-bar">
        <button type="button" class="cl-mode-tab is-active" data-cl-mode="matrix">📋 교사 체크표</button>
        <button type="button" class="cl-mode-tab" data-cl-mode="selfCheck">☑️ 학생 셀프 체크표 · 퀘스트 (${(state.selfChecks || []).length})</button>
      </div>
      <div class="checklist-topbar">
        <div class="week-nav">
          <button type="button" class="week-arrow-btn" id="cl-prev-week" title="이전 주">‹</button>
          ${week.map((day) => {
            const cnt = countDayEntries(state, day.iso);
            return `
              <button type="button" class="week-day-btn ${day.iso === currentDate ? 'is-active' : ''}" data-cl-date="${day.iso}">
                ${cnt > 0 ? `<span class="week-day-badge">${cnt}</span>` : ''}
                <strong>${day.dow}</strong>
                <span>${day.label}</span>
              </button>
            `;
          }).join('')}
          <button type="button" class="week-arrow-btn" id="cl-next-week" title="다음 주">›</button>
          <button type="button" class="btn-outline" id="cl-today" style="margin-left:6px;padding:5px 10px;font-size:12px;">오늘</button>
        </div>

        <div class="checklist-top-actions">
          ${pickedStudentIds.size > 0 ? `
            <span class="selected-pill">${pickedStudentIds.size}명 선택</span>
            <button type="button" class="btn-blue" id="cl-manual-plus" style="padding:6px 12px;font-size:12px;">으쓱 지급</button>
            <button type="button" class="btn-red" id="cl-manual-minus" style="padding:6px 12px;font-size:12px;">머쓱 지급</button>
            <button type="button" class="btn-ghost" id="cl-clear-picked" style="padding:6px 8px;font-size:12px;">해제</button>
          ` : ''}
          <button type="button" class="btn-outline" id="cl-download-csv">리포트 다운로드</button>
          <button type="button" class="btn-outline" id="cl-manage-items">'할 일' 리스트 수정</button>
        </div>
      </div>

      <div class="checklist-body">
        <div class="checklist-matrix-scroll">
          <div class="checklist-matrix">
            <!-- 좌측 학생목록 열 -->
            <div class="cl-student-col">
              <div class="cl-student-head">
                <h3>학생목록</h3>
                <label>
                  <input type="checkbox" id="cl-show-num" ${state.uiPrefs.showNumbers ? 'checked' : ''} style="accent-color:#f0be2a;">
                  번호 표시
                </label>
              </div>
              ${students.map((st) => `
                <div class="cl-student-row ${pickedStudentIds.has(st.id) ? 'is-picked' : ''}"
                     data-cl-student="${st.id}" title="클릭하면 수동 점수 지급 대상으로 선택됩니다">
                  <span class="cl-st-num">${st.number}</span>
                  <span>${escapeHtml(st.name)}</span>
                  <span class="cl-st-score">${st.score}</span>
                </div>
              `).join('')}
            </div>

            <!-- 각 할 일 기록 열 -->
            ${activeItems.map((item) => renderItemColumn(item, students, entries)).join('')}

            <!-- 새 할 일 추가 버튼 열 -->
            <button type="button" class="cl-add-col" id="cl-add-item-col">
              <span class="cl-add-col-plus">+</span>
              <span>'할 일'을<br>추가해주세요.</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;

  bindChecklistEvents(root, students, activeItems, entries);
}

function renderItemColumn(item, students, entries) {
  const filledCount = students.filter((st) => {
    const v = entries[`${st.id}::${item.id}`];
    return v !== '' && v !== false && v !== null && v !== undefined;
  }).length;

  let filterRowHtml = '';
  let statsHtml = '';

  if (item.type === 'check') {
    filterRowHtml = `
      <div class="cl-filter-strip">
        <button type="button" class="cl-filter-btn" data-filter-item="${item.id}" data-filter-val="true" title="체크된 학생 모두 선택">✓ 선택</button>
        <button type="button" class="cl-filter-btn" data-filter-item="${item.id}" data-filter-val="__empty__" title="미체크 학생 모두 선택">미체크</button>
      </div>
    `;
    statsHtml = `
      <div class="cl-stat-bars">
        <div class="cl-stat-pill" style="color:#37b4a6;border-color:#37b4a6;">완료 ${filledCount}명</div>
      </div>
      <div class="cl-stat-summary">${filledCount} / ${students.length}</div>
    `;
  } else if (item.type === 'symbol') {
    filterRowHtml = `
      <div class="cl-filter-strip">
        ${SYMBOLS.map((sym) => `
          <button type="button" class="cl-filter-btn" data-filter-item="${item.id}" data-filter-val="${sym.val}" title="${sym.val} 학생 선택">${sym.val}</button>
        `).join('')}
      </div>
    `;
    const counts = SYMBOLS.map((sym) => students.filter((st) => entries[`${st.id}::${item.id}`] === sym.val).length);
    statsHtml = `
      <div class="cl-stat-bars">
        ${SYMBOLS.map((sym, i) => `<div class="cl-stat-pill" style="color:${sym.barColor};border-color:${sym.barColor};">${counts[i]}</div>`).join('')}
      </div>
      <div class="cl-stat-summary">${filledCount} / ${students.length}</div>
    `;
  } else if (item.type === 'rating') {
    filterRowHtml = `
      <div class="cl-filter-strip">
        ${RATINGS.map((r) => `
          <button type="button" class="cl-filter-btn" data-filter-item="${item.id}" data-filter-val="${r}" title="${r}점 학생 선택">${r}</button>
        `).join('')}
      </div>
    `;
    const counts = RATINGS.map((r) => students.filter((st) => String(entries[`${st.id}::${item.id}`] ?? '') === r).length);
    statsHtml = `
      <div class="cl-stat-bars">
        ${RATINGS.map((r, i) => `<div class="cl-stat-pill" style="color:#6484f2;border-color:#6484f2;">${counts[i]}</div>`).join('')}
      </div>
      <div class="cl-stat-summary">${filledCount} / ${students.length}</div>
    `;
  } else if (item.type === 'score') {
    const nums = students
      .map((st) => entries[`${st.id}::${item.id}`])
      .filter((raw) => raw !== '' && raw !== undefined && raw !== null)
      .map((raw) => Number(raw))
      .filter((n) => !Number.isNaN(n));
    const sum = nums.reduce((a, b) => a + b, 0);
    const avg = nums.length > 0 ? (sum / nums.length).toFixed(1) : '0';
    filterRowHtml = `
      <div class="cl-filter-strip">
        <button type="button" class="cl-filter-btn" data-filter-score="${item.id}" title="특정 점수 이상 학생 선택">조건 선택</button>
      </div>
    `;
    statsHtml = `
      <div class="cl-stat-bars">
        <div class="cl-stat-pill" style="color:#5c6bc0;border-color:#5c6bc0;">합 ${sum} · 평균 ${avg}</div>
      </div>
      <div class="cl-stat-summary">${nums.length} / ${students.length}</div>
    `;
  }

  return `
    <div class="cl-item-col type-${item.type}">
      <div class="cl-item-head">
        <div class="cl-item-banner" style="background:${item.color || '#f29038'};" data-edit-item="${item.id}" title="클릭하여 항목 편집">
          <span>${escapeHtml(item.title)}</span>
          <span style="font-size:11px;opacity:0.9;">#${filledCount}/${students.length}</span>
        </div>
        <input type="text" class="cl-item-memo" data-item-memo="${item.id}" value="${escapeAttr(item.memo || '')}" placeholder="✎ 메모 추가도 가능해요.">
        ${filterRowHtml}
      </div>

      ${students.map((st) => {
        const val = entries[`${st.id}::${item.id}`];
        if (item.type === 'check') {
          const on = val === true;
          return `
            <div class="cl-cell-row" data-hover-st="${st.id}">
              <button type="button" class="cl-choice-btn ${on ? 'is-on-check' : ''}" data-set-entry="${st.id}::${item.id}" data-entry-val="${on ? '' : 'true'}">
                ${on ? '✓' : ''}
              </button>
            </div>
          `;
        }
        if (item.type === 'symbol') {
          return `
            <div class="cl-cell-row" data-hover-st="${st.id}">
              ${SYMBOLS.map((sym) => {
                const on = val === sym.val;
                return `<button type="button" class="cl-choice-btn ${on ? sym.cls : ''}" data-set-entry="${st.id}::${item.id}" data-entry-val="${on ? '' : sym.val}">${sym.val}</button>`;
              }).join('')}
            </div>
          `;
        }
        if (item.type === 'rating') {
          return `
            <div class="cl-cell-row" data-hover-st="${st.id}">
              ${RATINGS.map((r) => {
                const on = String(val ?? '') === r;
                return `<button type="button" class="cl-choice-btn ${on ? 'is-on-rating' : ''}" data-set-entry="${st.id}::${item.id}" data-entry-val="${on ? '' : r}">${r}</button>`;
              }).join('')}
            </div>
          `;
        }
        return `
          <div class="cl-cell-row" data-hover-st="${st.id}">
            <input type="number" class="cl-score-input" data-score-entry="${st.id}::${item.id}" value="${val !== undefined && val !== '' ? escapeAttr(val) : ''}" placeholder="점수">
          </div>
        `;
      }).join('')}

      <div class="cl-col-stats">${statsHtml}</div>
    </div>
  `;
}

function bindChecklistEvents(root, students, activeItems, entries) {
  root.querySelectorAll('[data-cl-mode]').forEach((b) => {
    b.onclick = () => {
      checklistTab = b.dataset.clMode;
      renderChecklistView(root);
    };
  });
  root.querySelector('#cl-prev-week').onclick = () => {
    const d = parseIso(currentDate);
    d.setDate(d.getDate() - 7);
    currentDate = formatIso(d);
    renderChecklistView(root);
  };
  root.querySelector('#cl-next-week').onclick = () => {
    const d = parseIso(currentDate);
    d.setDate(d.getDate() + 7);
    currentDate = formatIso(d);
    renderChecklistView(root);
  };
  root.querySelector('#cl-today').onclick = () => {
    currentDate = todayIso();
    renderChecklistView(root);
  };
  root.querySelectorAll('[data-cl-date]').forEach((btn) => {
    btn.onclick = () => {
      currentDate = btn.dataset.clDate;
      renderChecklistView(root);
    };
  });

  root.querySelector('#cl-show-num').onchange = (e) => {
    store.update((s) => { s.uiPrefs.showNumbers = e.target.checked; });
  };

  // 학생 행 클릭 (수동 점수 지급 대상 선택 토글)
  root.querySelectorAll('[data-cl-student]').forEach((row) => {
    const id = row.dataset.clStudent;
    row.onclick = () => {
      if (pickedStudentIds.has(id)) pickedStudentIds.delete(id);
      else pickedStudentIds.add(id);
      renderChecklistView(root);
    };
  });

  // 체크 / 기호 / 5~1 기록 클릭 (개인점수 자동 지급 절대 없음!)
  root.querySelectorAll('[data-set-entry]').forEach((btn) => {
    btn.onclick = async () => {
      const key = btn.dataset.setEntry;
      const raw = btn.dataset.entryVal;
      const value = raw === 'true' ? true : raw === '' ? '' : raw;
      await store.update((s) => {
        if (!s.checklist.entriesByDate[currentDate]) s.checklist.entriesByDate[currentDate] = {};
        if (value === '') delete s.checklist.entriesByDate[currentDate][key];
        else s.checklist.entriesByDate[currentDate][key] = value;
      });
    };
  });

  // Score 숫자 입력 (기록값은 개인점수와 완전 분리)
  root.querySelectorAll('[data-score-entry]').forEach((inp) => {
    inp.onchange = async () => {
      const key = inp.dataset.scoreEntry;
      const val = inp.value.trim();
      await store.update((s) => {
        if (!s.checklist.entriesByDate[currentDate]) s.checklist.entriesByDate[currentDate] = {};
        if (val === '') delete s.checklist.entriesByDate[currentDate][key];
        else s.checklist.entriesByDate[currentDate][key] = val;
      });
    };
  });

  // 메모 변경
  root.querySelectorAll('[data-item-memo]').forEach((inp) => {
    inp.onchange = () => {
      const id = inp.dataset.itemMemo;
      store.update((s) => {
        const it = s.checklist.items.find((x) => x.id === id);
        if (it) it.memo = inp.value.trim();
      });
    };
  });

  // 열 필터 (해당 값/체크 학생 일괄 선택)
  root.querySelectorAll('[data-filter-item]').forEach((btn) => {
    btn.onclick = () => {
      const itemId = btn.dataset.filterItem;
      const targetVal = btn.dataset.filterVal;
      pickedStudentIds.clear();
      for (const st of students) {
        const v = entries[`${st.id}::${itemId}`];
        if (targetVal === '__empty__') {
          if (!v) pickedStudentIds.add(st.id);
        } else if (targetVal === 'true') {
          if (v === true) pickedStudentIds.add(st.id);
        } else if (String(v ?? '') === targetVal) {
          pickedStudentIds.add(st.id);
        }
      }
      showToast({ title: `${pickedStudentIds.size}명의 학생을 선택했습니다. 우측에서 수동 지급하세요.` });
      renderChecklistView(root);
    };
  });

  root.querySelectorAll('[data-filter-score]').forEach((btn) => {
    btn.onclick = () => {
      const itemId = btn.dataset.filterScore;
      const minStr = prompt('몇 점 이상인 학생을 선택할까요? (숫자 입력)', '80');
      if (minStr === null) return;
      const minVal = Number(minStr);
      if (Number.isNaN(minVal)) return;
      pickedStudentIds.clear();
      for (const st of students) {
        const v = entries[`${st.id}::${itemId}`];
        if (v !== undefined && v !== '' && Number(v) >= minVal) {
          pickedStudentIds.add(st.id);
        }
      }
      showToast({ title: `${minVal}점 이상 학생 ${pickedStudentIds.size}명을 선택했습니다.` });
      renderChecklistView(root);
    };
  });

  // 수동 개인점수 지급 (상단 툴바에 선택 시 표시)
  const clearPicked = root.querySelector('#cl-clear-picked');
  if (clearPicked) {
    clearPicked.onclick = () => {
      pickedStudentIds.clear();
      renderChecklistView(root);
    };
  }
  const manualPlus = root.querySelector('#cl-manual-plus');
  if (manualPlus) {
    manualPlus.onclick = () => {
      if (pickedStudentIds.size === 0) return;
      openScoreComposer({ studentIds: Array.from(pickedStudentIds), initialType: 'positive' });
    };
  }
  const manualMinus = root.querySelector('#cl-manual-minus');
  if (manualMinus) {
    manualMinus.onclick = () => {
      if (pickedStudentIds.size === 0) return;
      openScoreComposer({ studentIds: Array.from(pickedStudentIds), initialType: 'negative' });
    };
  }

  // 항목 추가 / 편집 / 리스트 관리
  root.querySelector('#cl-add-item-col').onclick = () => openChecklistItemModal(null);
  root.querySelectorAll('[data-edit-item]').forEach((b) => {
    b.onclick = () => openChecklistItemModal(b.dataset.editItem);
  });
  root.querySelector('#cl-manage-items').onclick = () => openChecklistManagerModal();
  root.querySelector('#cl-download-csv').onclick = () => downloadChecklistCsv(students, activeItems, entries);
}

function updateSidePreview(root, students) {
  const st = students.find((s) => s.id === hoveredStudentId);
  if (!st) return;
  const img = root.querySelector('.cl-preview-avatar img');
  const nameEl = root.querySelector('.cl-preview-name');
  const subEl = root.querySelector('.cl-preview-sub');
  if (img) img.src = getStillAvatarUrl(st.avatarId);
  if (nameEl) nameEl.textContent = st.name;
  if (subEl) subEl.textContent = `${st.number}번 · 현재 개인점수 ${st.score}점`;
}

/** 할 일 항목 추가/편집 모달 */
function openChecklistItemModal(itemId = null) {
  const state = store.getState();
  const existing = itemId ? state.checklist.items.find((x) => x.id === itemId) : null;
  let pickedColor = existing?.color || ITEM_COLORS[state.checklist.items.length % ITEM_COLORS.length];

  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  backdrop.innerHTML = `
    <form class="dialog-card">
      <div class="dialog-header">
        <h2>${existing ? `'할 일' 항목 수정` : `새 '할 일' 항목 추가`}</h2>
        <button type="button" class="dialog-close">&times;</button>
      </div>
      <div class="dialog-body">
        <label class="field-label">
          <span>항목 이름</span>
          <input type="text" name="title" maxlength="30" value="${escapeAttr(existing?.title || '')}" placeholder="예: 공책 정리, 숙제 검사, 받아쓰기" required autofocus>
        </label>
        <label class="field-label">
          <span>기록 방식</span>
          <select name="type">
            <option value="check" ${existing?.type === 'check' ? 'selected' : ''}>체크 (✓)</option>
            <option value="symbol" ${(!existing || existing.type === 'symbol') ? 'selected' : ''}>기호 (◎ ○ △ ×)</option>
            <option value="rating" ${existing?.type === 'rating' ? 'selected' : ''}>5단계 (5 · 4 · 3 · 2 · 1)</option>
            <option value="score" ${existing?.type === 'score' ? 'selected' : ''}>Score (숫자 점수 입력)</option>
          </select>
        </label>
        <label class="field-label">
          <span>메모 (선택)</span>
          <input type="text" name="memo" maxlength="60" value="${escapeAttr(existing?.memo || '')}" placeholder="항목에 대한 간단한 메모">
        </label>
        <div class="field-label">
          <span>헤더 색상</span>
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            ${ITEM_COLORS.map((c) => `
              <button type="button" data-pick-color="${c}" style="width:32px;height:32px;border-radius:50%;background:${c};border:3px solid ${pickedColor === c ? '#333' : 'transparent'};"></button>
            `).join('')}
          </div>
        </div>
      </div>
      <div class="dialog-footer" style="justify-content:space-between;">
        <div>
          ${existing ? `<button type="button" class="btn-danger-outline" id="btn-archive-item">보관함으로 숨기기</button>` : ''}
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn-ghost" data-cancel>취소</button>
          <button type="submit" class="btn-yellow">${existing ? '수정 저장' : '추가하기'}</button>
        </div>
      </div>
    </form>
  `;

  modalRoot.appendChild(backdrop);
  backdrop.querySelector('.dialog-close').onclick = close;
  backdrop.querySelector('[data-cancel]').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  backdrop.querySelectorAll('[data-pick-color]').forEach((b) => {
    b.onclick = () => {
      pickedColor = b.dataset.pickColor;
      backdrop.querySelectorAll('[data-pick-color]').forEach((x) => { x.style.borderColor = 'transparent'; });
      b.style.borderColor = '#333';
    };
  });

  const archBtn = backdrop.querySelector('#btn-archive-item');
  if (archBtn && existing) {
    archBtn.onclick = async () => {
      await store.update((s) => {
        const it = s.checklist.items.find((x) => x.id === existing.id);
        if (it) it.archived = true;
      });
      showToast({ title: `'${existing.title}' 항목을 보관했습니다.` });
      close();
    };
  }

  backdrop.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const title = String(fd.get('title') || '').trim();
    const type = String(fd.get('type') || 'symbol');
    const memo = String(fd.get('memo') || '').trim();
    if (!title) return;

    await store.update((s) => {
      if (existing) {
        const it = s.checklist.items.find((x) => x.id === existing.id);
        if (it) {
          it.title = title;
          it.type = type;
          it.memo = memo;
          it.color = pickedColor;
        }
      } else {
        s.checklist.items.push({
          id: uid('chk'),
          title,
          type,
          color: pickedColor,
          memo,
          archived: false,
          order: s.checklist.items.length,
        });
      }
    });
    playSound('confirm');
    close();
  };
}

/** '할 일' 리스트 순서 변경 및 보관함 복원 모달 */
function openChecklistManagerModal() {
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  const renderModal = () => {
    const items = [...store.getState().checklist.items].sort((a, b) => a.order - b.order);
    const active = items.filter((i) => !i.archived);
    const archived = items.filter((i) => i.archived);

    backdrop.innerHTML = `
      <div class="dialog-card">
        <div class="dialog-header">
          <h2>'할 일' 리스트 수정</h2>
          <button type="button" class="dialog-close">&times;</button>
        </div>
        <div class="dialog-body">
          <div style="display:flex;flex-direction:column;gap:7px;">
            ${active.map((it, idx) => `
              <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:7px;background:#f7f5ee;">
                <span style="width:12px;height:12px;border-radius:50%;background:${it.color};flex:none;"></span>
                <strong style="flex:1;font-size:13px;">${escapeHtml(it.title)}</strong>
                <span style="font-size:11px;color:#888;">${it.type}</span>
                <button type="button" class="btn-outline" data-move-up="${it.id}" ${idx === 0 ? 'disabled' : ''} style="padding:3px 7px;font-size:11px;">▲</button>
                <button type="button" class="btn-outline" data-move-dn="${it.id}" ${idx === active.length - 1 ? 'disabled' : ''} style="padding:3px 7px;font-size:11px;">▼</button>
                <button type="button" class="btn-danger-outline" data-arch-id="${it.id}" style="padding:3px 7px;font-size:11px;">보관</button>
              </div>
            `).join('')}
          </div>

          ${archived.length > 0 ? `
            <div class="settings-divider"></div>
            <h3 style="margin:0;font-size:13px;color:#776e60;">보관된 항목 (${archived.length})</h3>
            <div style="display:flex;flex-direction:column;gap:6px;">
              ${archived.map((it) => `
                <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:7px;background:#f1efe8;">
                  <span style="font-size:13px;color:#777;">${escapeHtml(it.title)}</span>
                  <div style="display:flex;gap:6px;">
                    <button type="button" class="btn-outline" data-unarch-id="${it.id}" style="padding:3px 8px;font-size:11px;">복원</button>
                    <button type="button" class="btn-danger-outline" data-del-id="${it.id}" style="padding:3px 8px;font-size:11px;">삭제</button>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn-yellow" id="mgr-add-new">+ 새 항목 추가</button>
          <button type="button" class="btn-ghost" data-close>닫기</button>
        </div>
      </div>
    `;

    backdrop.querySelector('.dialog-close').onclick = close;
    backdrop.querySelector('[data-close]').onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    backdrop.querySelector('#mgr-add-new').onclick = () => { close(); openChecklistItemModal(null); };

    const reorder = async (id, dir) => {
      await store.update((s) => {
        const list = s.checklist.items.filter((x) => !x.archived).sort((a, b) => a.order - b.order);
        const i = list.findIndex((x) => x.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return;
        const tmp = list[i].order;
        list[i].order = list[j].order;
        list[j].order = tmp;
      });
      renderModal();
    };
    backdrop.querySelectorAll('[data-move-up]').forEach((b) => { b.onclick = () => reorder(b.dataset.moveUp, -1); });
    backdrop.querySelectorAll('[data-move-dn]').forEach((b) => { b.onclick = () => reorder(b.dataset.moveDn, 1); });
    backdrop.querySelectorAll('[data-arch-id]').forEach((b) => {
      b.onclick = async () => {
        await store.update((s) => { const it = s.checklist.items.find((x) => x.id === b.dataset.archId); if (it) it.archived = true; });
        renderModal();
      };
    });
    backdrop.querySelectorAll('[data-unarch-id]').forEach((b) => {
      b.onclick = async () => {
        await store.update((s) => { const it = s.checklist.items.find((x) => x.id === b.dataset.unarchId); if (it) it.archived = false; });
        renderModal();
      };
    });
    backdrop.querySelectorAll('[data-del-id]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('이 항목을 영구 삭제할까요?')) return;
        await store.update((s) => { s.checklist.items = s.checklist.items.filter((x) => x.id !== b.dataset.delId); });
        renderModal();
      };
    });
  };

  modalRoot.appendChild(backdrop);
  renderModal();
}

function downloadChecklistCsv(students, items, entries) {
  const header = ['번호', '이름', ...items.map((i) => i.title)];
  const rows = students.map((st) => [
    st.number,
    st.name,
    ...items.map((it) => {
      const v = entries[`${st.id}::${it.id}`];
      if (v === true) return 'O';
      return v ?? '';
    }),
  ]);
  const csv = '\uFEFF' + [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `체크표_${currentDate}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast({ title: `${currentDate} 체크표 CSV를 다운로드했습니다.`, tone: 'plus' });
}

// ============================================================
// 학생 셀프 체크표 / 퀘스트 (전자칠판 5열·10열 터치 버튼형 + 태블릿 전송 + 체크표 자동 연동)
// ============================================================
function renderSelfCheckTab(root) {
  const state = store.getState();
  const selfChecks = state.selfChecks || [];
  const allStudents = state.students.filter((s) => !s.trashed).sort((a, b) => a.number - b.number);

  if (!activeSelfCheckId || !selfChecks.some((c) => c.id === activeSelfCheckId)) {
    activeSelfCheckId = selfChecks[0]?.id || null;
  }
  const active = selfChecks.find((c) => c.id === activeSelfCheckId) || null;
  const targetStudents = active && Array.isArray(active.targetStudentIds) && active.targetStudentIds.length > 0
    ? allStudents.filter((s) => active.targetStudentIds.includes(s.id))
    : allStudents;

  const isCount = active?.mode === 'count';
  const targetCnt = Math.max(1, Number(active?.targetCount) || 1);
  const entries = active?.entries || {};
  const doneCount = active ? targetStudents.filter((st) => {
    const v = entries[st.id];
    return isCount ? Number(v || 0) >= targetCnt : Boolean(v);
  }).length : 0;
  const cols = active?.gridColumns === 10 ? 10 : 5;

  root.innerHTML = `
    <div class="checklist-shell">
      <div class="checklist-mode-bar">
        <button type="button" class="cl-mode-tab" data-cl-mode="matrix">📋 교사 체크표</button>
        <button type="button" class="cl-mode-tab is-active" data-cl-mode="selfCheck">☑️ 학생 셀프 체크표 · 퀘스트 (${selfChecks.length})</button>
      </div>

      <div class="sc-topbar">
        <div class="sc-quest-pills">
          ${selfChecks.map((sc) => `
            <button type="button" class="sc-quest-pill ${sc.id === activeSelfCheckId ? 'is-active' : ''}" data-sc-pick="${sc.id}">
              <span>${sc.mode === 'count' ? '🎯' : '☑️'} ${escapeHtml(sc.title)}</span>
              ${sc.sendToTablet !== false ? `<small>태블릿</small>` : ''}
            </button>
          `).join('')}
        </div>
        <div class="sc-top-actions">
          <button type="button" class="btn-yellow" id="sc-btn-create" style="padding:7px 14px;font-size:13px;">+ 새 셀프 체크표 / 퀘스트</button>
        </div>
      </div>

      <div class="sc-body">
        ${!active ? `
          <div class="sc-empty">
            <div style="font-size:44px;margin-bottom:8px;">☑️</div>
            <h3>학생 셀프 체크표 / 퀘스트를 만들어 보세요</h3>
            <p>전자칠판에서 학생이 자기 번호 버튼을 직접 터치하거나, 학생 태블릿(<code>student.html</code>)으로 퀘스트를 보내 자기 것만 체크하게 할 수 있습니다.<br>
            (예: 휴대폰 끄기, 발표 5번, 사물함 청소)</p>
            <button type="button" class="btn-yellow" id="sc-btn-create-empty" style="margin-top:12px;">+ 첫 퀘스트 만들기</button>
          </div>
        ` : `
          <div class="sc-board-head">
            <div>
              <h3>${escapeHtml(active.title)}</h3>
              <span class="sc-board-meta">
                완료 <strong>${doneCount} / ${targetStudents.length}명</strong>
                ${isCount ? ` · 목표 ${targetCnt}회` : ' · 단일 체크'}
                ${Array.isArray(active.targetStudentIds) && active.targetStudentIds.length > 0 ? ` · 일부 ${targetStudents.length}명 배정` : ' · 학급 전체'}
                ${active.sendToTablet !== false ? ' · 📱 태블릿 전송 ON' : ' · 전자칠판 전용'}
                ${active.linkedChecklistItemId ? ' · 📋 체크표 연동됨' : ''}
              </span>
            </div>
            <div class="sc-board-controls">
              <div class="sc-col-toggle">
                <button type="button" class="${cols === 5 ? 'is-active' : ''}" data-sc-cols="5">5열 보기</button>
                <button type="button" class="${cols === 10 ? 'is-active' : ''}" data-sc-cols="10">10열 보기</button>
              </div>
              <button type="button" class="btn-outline" id="sc-btn-reset" style="padding:5px 10px;font-size:12px;">초기화</button>
              <button type="button" class="btn-outline" id="sc-btn-edit" style="padding:5px 10px;font-size:12px;">수정</button>
              <button type="button" class="btn-ghost" id="sc-btn-del" style="padding:5px 10px;font-size:12px;color:#d63957;">삭제</button>
            </div>
          </div>

          <div class="sc-touch-grid cols-${cols}">
            ${targetStudents.map((st) => {
              const raw = entries[st.id];
              const cnt = Number(raw || 0);
              const done = isCount ? cnt >= targetCnt : Boolean(raw);
              return `
                <button type="button" class="sc-touch-card ${done ? 'is-done' : cnt > 0 ? 'is-progress' : ''}" data-sc-toggle="${st.id}">
                  <span class="sc-card-num">${st.number}</span>
                  <span class="sc-card-name">${escapeHtml(st.name)}</span>
                  <span class="sc-card-state">
                    ${isCount ? `${cnt} / ${targetCnt}회` : (done ? '✓ 완료' : '미완료')}
                  </span>
                </button>
              `;
            }).join('')}
          </div>
        `}
      </div>
    </div>
  `;

  root.querySelectorAll('[data-cl-mode]').forEach((b) => {
    b.onclick = () => {
      checklistTab = b.dataset.clMode;
      renderChecklistView(root);
    };
  });

  const openNew = () => openSelfCheckModal(null, () => renderSelfCheckTab(root));
  root.querySelector('#sc-btn-create').onclick = openNew;
  const emptyBtn = root.querySelector('#sc-btn-create-empty');
  if (emptyBtn) emptyBtn.onclick = openNew;

  root.querySelectorAll('[data-sc-pick]').forEach((b) => {
    b.onclick = () => {
      activeSelfCheckId = b.dataset.scPick;
      renderSelfCheckTab(root);
    };
  });

  if (!active) return;

  root.querySelectorAll('[data-sc-cols]').forEach((b) => {
    b.onclick = async () => {
      const nextCols = Number(b.dataset.scCols) === 10 ? 10 : 5;
      await store.update((s) => {
        const sc = (s.selfChecks || []).find((x) => x.id === active.id);
        if (sc) sc.gridColumns = nextCols;
      });
      renderSelfCheckTab(root);
    };
  });

  root.querySelectorAll('[data-sc-toggle]').forEach((b) => {
    b.onclick = async () => {
      await toggleSelfCheckValue(active.id, b.dataset.scToggle);
      await syncSelfChecksToCloud();
      renderSelfCheckTab(root);
    };
  });

  root.querySelector('#sc-btn-reset').onclick = async () => {
    if (!confirm(`'${active.title}' 체크 기록을 모두 초기화할까요?`)) return;
    await store.update((s) => {
      const sc = (s.selfChecks || []).find((x) => x.id === active.id);
      if (sc) sc.entries = {};
    });
    await syncSelfChecksToCloud();
    showToast({ title: '체크 기록을 초기화했습니다.' });
    renderSelfCheckTab(root);
  };

  root.querySelector('#sc-btn-edit').onclick = () => {
    openSelfCheckModal(active, () => renderSelfCheckTab(root));
  };

  root.querySelector('#sc-btn-del').onclick = async () => {
    if (!confirm(`'${active.title}' 셀프 체크표(퀘스트)를 삭제할까요?`)) return;
    await store.update((s) => {
      s.selfChecks = (s.selfChecks || []).filter((x) => x.id !== active.id);
    });
    await syncSelfChecksToCloud();
    activeSelfCheckId = null;
    showToast({ title: '셀프 체크표를 삭제했습니다.' });
    renderSelfCheckTab(root);
  };
}

/** 셀프 체크표 / 퀘스트 생성·수정 모달 */
function openSelfCheckModal(existing, onSaved) {
  const state = store.getState();
  const allStudents = state.students.filter((s) => !s.trashed).sort((a, b) => a.number - b.number);
  const allGroups = [...(state.groups || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  let title = existing?.title || '';
  let mode = existing?.mode === 'count' ? 'count' : 'toggle';
  let targetCount = Number(existing?.targetCount || 5);
  let gridColumns = existing?.gridColumns === 10 ? 10 : 5;
  let sendToTablet = existing?.sendToTablet !== false;
  let linkToChecklist = existing ? Boolean(existing.linkedChecklistItemId) : true;
  let targetMode = Array.isArray(existing?.targetStudentIds) && existing.targetStudentIds.length > 0 ? 'partial' : 'all';
  let targetSelected = new Set(Array.isArray(existing?.targetStudentIds) ? existing.targetStudentIds : []);

  const renderModal = () => {
    backdrop.innerHTML = `
      <form class="dialog-card is-wide">
        <div class="dialog-header">
          <h2>${existing ? '셀프 체크표 · 퀘스트 수정' : '새 셀프 체크표 · 퀘스트 만들기'}</h2>
          <button type="button" class="dialog-close">&times;</button>
        </div>
        <div class="dialog-body" style="max-height:76vh;overflow-y:auto;">
          <label class="field-label">
            <span>체크표 / 퀘스트 이름</span>
            <input type="text" id="sc-f-title" maxlength="40" value="${escapeAttr(title)}" placeholder="예: 휴대폰 끄기, 발표 5번, 사물함 청소" required>
          </label>

          <div class="field-row" style="margin-top:10px;">
            <label class="field-label">
              <span>체크 방식</span>
              <select id="sc-f-mode">
                <option value="toggle" ${mode === 'toggle' ? 'selected' : ''}>☑️ 단일 체크 (완료 / 미완료)</option>
                <option value="count" ${mode === 'count' ? 'selected' : ''}>🎯 횟수 누적 퀘스트 (예: 발표 5번)</option>
              </select>
            </label>
            ${mode === 'count' ? `
              <label class="field-label">
                <span>목표 횟수</span>
                <input type="number" id="sc-f-target" min="1" max="99" value="${targetCount}">
              </label>
            ` : ''}
            <label class="field-label">
              <span>전자칠판 배치 열 수</span>
              <select id="sc-f-cols">
                <option value="5" ${gridColumns === 5 ? 'selected' : ''}>5열 버튼형 (큰 버튼)</option>
                <option value="10" ${gridColumns === 10 ? 'selected' : ''}>10열 버튼형 (한눈에 보기)</option>
              </select>
            </label>
          </div>

          <div style="display:flex;gap:16px;flex-wrap:wrap;margin:12px 0;padding:10px 12px;background:#faf8f2;border-radius:10px;border:1px solid #e6dfd0;">
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;cursor:pointer;">
              <input type="checkbox" id="sc-f-tablet" ${sendToTablet ? 'checked' : ''} style="accent-color:#2b8be0;">
              <span>📱 학생 태블릿(student.html)으로 전송 (자기 것만 표시)</span>
            </label>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;cursor:pointer;">
              <input type="checkbox" id="sc-f-link" ${linkToChecklist ? 'checked' : ''} style="accent-color:#2b8be0;">
              <span>📋 교사 체크표 항목과 자동 연동</span>
            </label>
          </div>

          <div style="padding:10px 12px;background:#faf8f2;border-radius:10px;border:1px solid #e6dfd0;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
              <strong style="font-size:13px;">🎯 배포 대상 학생</strong>
              <div style="display:flex;gap:6px;">
                <button type="button" class="btn-outline" data-sc-tmode="all" style="padding:4px 10px;font-size:12px;${targetMode === 'all' ? 'background:#2b8be0;color:#fff;border-color:#2b8be0;' : ''}">학급 전체 (${allStudents.length}명)</button>
                <button type="button" class="btn-outline" data-sc-tmode="partial" style="padding:4px 10px;font-size:12px;${targetMode === 'partial' ? 'background:#2b8be0;color:#fff;border-color:#2b8be0;' : ''}">일부 학생 선택 (${targetSelected.size}명)</button>
              </div>
            </div>
            ${targetMode === 'partial' ? `
              <div style="display:flex;gap:5px;flex-wrap:wrap;margin:8px 0 6px;">
                ${allGroups.map((g) => `<button type="button" class="btn-outline" data-sc-grp="${g.id}" style="padding:2px 8px;font-size:11px;">${escapeHtml(g.name)}</button>`).join('')}
              </div>
              <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:5px;max-height:120px;overflow-y:auto;">
                ${allStudents.map((st) => `
                  <label style="display:flex;align-items:center;gap:4px;font-size:12px;font-weight:700;padding:4px 6px;border-radius:6px;background:${targetSelected.has(st.id) ? '#fff3b0' : '#fff'};border:1px solid #e0dacb;cursor:pointer;">
                    <input type="checkbox" data-sc-st="${st.id}" ${targetSelected.has(st.id) ? 'checked' : ''}>
                    <span>${st.number} ${escapeHtml(st.name)}</span>
                  </label>
                `).join('')}
              </div>
            ` : ''}
          </div>
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn-ghost" data-cancel>취소</button>
          <button type="submit" class="btn-yellow">${existing ? '수정 저장' : '퀘스트 만들기'}</button>
        </div>
      </form>
    `;

    backdrop.querySelector('.dialog-close').onclick = close;
    backdrop.querySelector('[data-cancel]').onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

    const syncLocal = () => {
      title = backdrop.querySelector('#sc-f-title')?.value || '';
      mode = backdrop.querySelector('#sc-f-mode')?.value || 'toggle';
      const tInp = backdrop.querySelector('#sc-f-target');
      if (tInp) targetCount = Math.max(1, Number(tInp.value) || 5);
      gridColumns = Number(backdrop.querySelector('#sc-f-cols')?.value) === 10 ? 10 : 5;
      sendToTablet = Boolean(backdrop.querySelector('#sc-f-tablet')?.checked);
      linkToChecklist = Boolean(backdrop.querySelector('#sc-f-link')?.checked);
    };

    backdrop.querySelector('#sc-f-mode').onchange = () => { syncLocal(); renderModal(); };
    backdrop.querySelectorAll('[data-sc-tmode]').forEach((b) => {
      b.onclick = () => { syncLocal(); targetMode = b.dataset.scTmode; renderModal(); };
    });
    backdrop.querySelectorAll('[data-sc-grp]').forEach((b) => {
      b.onclick = () => {
        syncLocal();
        const members = allStudents.filter((s) => s.groupId === b.dataset.scGrp);
        const allIn = members.every((m) => targetSelected.has(m.id));
        if (allIn) members.forEach((m) => targetSelected.delete(m.id));
        else members.forEach((m) => targetSelected.add(m.id));
        renderModal();
      };
    });
    backdrop.querySelectorAll('[data-sc-st]').forEach((chk) => {
      chk.onchange = () => {
        if (chk.checked) targetSelected.add(chk.dataset.scSt);
        else targetSelected.delete(chk.dataset.scSt);
      };
    });

    backdrop.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      syncLocal();
      const cleanTitle = title.trim();
      if (!cleanTitle) return;
      if (targetMode === 'partial' && targetSelected.size === 0) {
        showToast({ title: '일부 배포 대상 학생을 1명 이상 선택해 주세요.', tone: 'minus' });
        return;
      }

      const id = existing?.id || uid('sc');
      let linkedItemId = existing?.linkedChecklistItemId || null;

      await store.update((s) => {
        if (!Array.isArray(s.selfChecks)) s.selfChecks = [];
        if (linkToChecklist) {
          if (!linkedItemId) linkedItemId = `chk-sc-${id}`;
          let chkItem = s.checklist.items.find((it) => it.id === linkedItemId);
          if (!chkItem) {
            s.checklist.items.push({
              id: linkedItemId,
              title: `[퀘스트] ${cleanTitle.slice(0, 12)}`,
              type: mode === 'count' ? 'score' : 'check',
              color: '#39b3a2',
              memo: '셀프 체크표 자동 연동',
              archived: false,
              order: s.checklist.items.length,
            });
          } else {
            chkItem.title = `[퀘스트] ${cleanTitle.slice(0, 12)}`;
            chkItem.type = mode === 'count' ? 'score' : 'check';
          }
        } else {
          linkedItemId = null;
        }

        const payload = {
          id,
          title: cleanTitle,
          mode,
          targetCount: mode === 'count' ? targetCount : 1,
          gridColumns,
          sendToTablet,
          targetStudentIds: targetMode === 'partial' ? Array.from(targetSelected) : null,
          linkedChecklistItemId: linkedItemId,
          entries: existing?.entries ? { ...existing.entries } : {},
          createdAt: existing?.createdAt || Date.now(),
        };

        const idx = s.selfChecks.findIndex((x) => x.id === id);
        if (idx >= 0) s.selfChecks[idx] = payload;
        else s.selfChecks.unshift(payload);
      });

      activeSelfCheckId = id;
      await syncSelfChecksToCloud();
      playSound('confirm');
      showToast({ title: existing ? '셀프 체크표를 수정했습니다!' : '새 셀프 체크표를 만들었습니다!', tone: 'plus' });
      close();
      if (typeof onSaved === 'function') onSaved();
    };
  };

  modalRoot.appendChild(backdrop);
  renderModal();
}
