// 만능칠판 6.0 이식 뷰 + 칠판 내 빠른 으쓱/머쓱 점수 부여 및 피드백 연동

import { store } from '../store.js';
import { openScoreComposer, escapeHtml } from '../effects.js';

let mounted = false;
let quickSelectedIds = new Set();
let quickPickerMode = null; // null | 'positive' | 'negative'

/** 만능칠판 뷰 마운트 (재방문 시 판서 상태 유지) */
export function renderWhiteboardView(container) {
  if (!container) return;

  if (!mounted) {
    mounted = true;
    container.innerHTML = `
      <div class="wb-host">
        <iframe
          id="cr2-whiteboard-frame"
          class="wb-iframe"
          src="modules/whiteboard/index.html?v=cr2-1"
          title="클래스레볼루션2 만능칠판"
          allow="clipboard-read; clipboard-write"
        ></iframe>

        <!-- 만능칠판 위 빠른 점수 부여 플로팅 바 -->
        <div class="wb-quick-score-bar" id="wb-quick-score-bar">
          <button type="button" class="wb-quick-btn is-plus" id="wb-btn-plus" title="칠판 수업 중 으쓱(상점) 빠른 부여">
            <i class="sp-icon sp-star-blue" style="transform:scale(0.72);" aria-hidden="true"></i>
            <span>으쓱</span>
          </button>
          <button type="button" class="wb-quick-btn is-minus" id="wb-btn-minus" title="칠판 수업 중 머쓱(감점) 빠른 부여">
            <i class="sp-icon sp-cloud-red" style="transform:scale(0.72);" aria-hidden="true"></i>
            <span>머쓱</span>
          </button>
        </div>

        <!-- 대상 학생 빠른 선택 팝오버 -->
        <div class="wb-quick-picker" id="wb-quick-picker" hidden></div>
      </div>
    `;

    const plusBtn = container.querySelector('#wb-btn-plus');
    const minusBtn = container.querySelector('#wb-btn-minus');
    const pickerEl = container.querySelector('#wb-quick-picker');

    const togglePicker = (type) => {
      if (quickPickerMode === type && !pickerEl.hidden) {
        quickPickerMode = null;
        pickerEl.hidden = true;
        return;
      }
      quickPickerMode = type;
      renderQuickPicker(pickerEl);
      pickerEl.hidden = false;
    };

    plusBtn.onclick = () => togglePicker('positive');
    minusBtn.onclick = () => togglePicker('negative');
  } else {
    // 이미 마운트된 상태에서 학생 목록 등이 바뀌었고 팝오버가 열려 있으면 갱신
    const pickerEl = container.querySelector('#wb-quick-picker');
    if (pickerEl && !pickerEl.hidden && quickPickerMode) {
      renderQuickPicker(pickerEl);
    }
  }
}

function renderQuickPicker(pickerEl) {
  const state = store.getState();
  const students = state.students
    .filter((s) => !s.trashed && !s.absent)
    .sort((a, b) => a.number - b.number);
  const groups = [...(state.groups || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  for (const id of Array.from(quickSelectedIds)) {
    if (!students.some((s) => s.id === id)) quickSelectedIds.delete(id);
  }

  const isPos = quickPickerMode !== 'negative';
  const allSelected = students.length > 0 && students.every((s) => quickSelectedIds.has(s.id));

  pickerEl.className = `wb-quick-picker ${isPos ? 'is-plus' : 'is-minus'}`;
  pickerEl.innerHTML = `
    <div class="wb-qp-head">
      <strong>${isPos ? '★ 으쓱(상점)' : '☁ 머쓱(감점)'} 대상 선택</strong>
      <span class="wb-qp-count">${quickSelectedIds.size}명 선택</span>
      <button type="button" class="wb-qp-close" id="wb-qp-close" aria-label="닫기">&times;</button>
    </div>

    <div class="wb-qp-actions">
      <button type="button" class="wb-qp-chip ${allSelected ? 'is-active' : ''}" id="wb-qp-all">전체</button>
      <button type="button" class="wb-qp-chip" id="wb-qp-clear">선택 해제</button>
      ${groups.map((g) => {
        const members = students.filter((s) => s.groupId === g.id);
        if (members.length === 0) return '';
        const gAll = members.every((m) => quickSelectedIds.has(m.id));
        return `<button type="button" class="wb-qp-chip ${gAll ? 'is-active' : ''}" data-wb-group="${escapeHtml(g.id)}">${escapeHtml(g.name)}</button>`;
      }).join('')}
    </div>

    <div class="wb-qp-grid">
      ${students.map((s) => `
        <button type="button" class="wb-qp-student ${quickSelectedIds.has(s.id) ? 'is-selected' : ''}" data-wb-student="${escapeHtml(s.id)}">
          <span class="wb-qp-num">${s.number}</span>
          <span class="wb-qp-name">${escapeHtml(s.name)}</span>
        </button>
      `).join('')}
    </div>

    <div class="wb-qp-foot">
      <button type="button" class="wb-qp-submit ${isPos ? 'is-plus' : 'is-minus'}" id="wb-qp-next" ${quickSelectedIds.size === 0 ? 'disabled' : ''}>
        ${quickSelectedIds.size > 0 ? `${quickSelectedIds.size}명에게 ${isPos ? '으쓱' : '머쓱'} 주기 →` : '학생을 선택하세요'}
      </button>
    </div>
  `;

  pickerEl.querySelector('#wb-qp-close').onclick = () => {
    quickPickerMode = null;
    pickerEl.hidden = true;
  };
  pickerEl.querySelector('#wb-qp-all').onclick = () => {
    if (allSelected) quickSelectedIds.clear();
    else students.forEach((s) => quickSelectedIds.add(s.id));
    renderQuickPicker(pickerEl);
  };
  pickerEl.querySelector('#wb-qp-clear').onclick = () => {
    quickSelectedIds.clear();
    renderQuickPicker(pickerEl);
  };
  pickerEl.querySelectorAll('[data-wb-group]').forEach((btn) => {
    btn.onclick = () => {
      const gid = btn.dataset.wbGroup;
      const members = students.filter((s) => s.groupId === gid);
      const gAll = members.every((m) => quickSelectedIds.has(m.id));
      if (gAll) members.forEach((m) => quickSelectedIds.delete(m.id));
      else members.forEach((m) => quickSelectedIds.add(m.id));
      renderQuickPicker(pickerEl);
    };
  });
  pickerEl.querySelectorAll('[data-wb-student]').forEach((btn) => {
    btn.onclick = () => {
      const sid = btn.dataset.wbStudent;
      if (quickSelectedIds.has(sid)) quickSelectedIds.delete(sid);
      else quickSelectedIds.add(sid);
      renderQuickPicker(pickerEl);
    };
  });
  pickerEl.querySelector('#wb-qp-next').onclick = () => {
    if (quickSelectedIds.size === 0) return;
    const targetIds = Array.from(quickSelectedIds);
    const type = quickPickerMode === 'negative' ? 'negative' : 'positive';
    quickPickerMode = null;
    pickerEl.hidden = true;
    openScoreComposer({
      studentIds: targetIds,
      initialType: type,
      onApplied: () => {
        quickSelectedIds.clear();
      },
    });
  };
}
