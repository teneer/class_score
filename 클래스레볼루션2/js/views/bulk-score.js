// 점수 일괄 관리 · 점수 이력 검색/되돌리기 · 점수 초기화 뷰

import { store, getStillAvatarUrl } from '../store.js';
import { applyDirectAdjustments, undoHistoryEntry, resetScores } from '../score-engine.js';
import { showToast, escapeHtml, escapeAttr } from '../effects.js';
import { playSound } from '../audio.js';

let activeTab = 'adjust'; // 'adjust' | 'history' | 'reset'
let historyFilterKind = 'all';
let historyQuery = '';

export function setBulkScoreTab(tab) {
  if (['adjust', 'history', 'reset'].includes(tab)) activeTab = tab;
}

export function renderBulkScoreView(root) {
  const state = store.getState();
  const students = state.students.filter((s) => !s.trashed).sort((a, b) => a.number - b.number);
  const groupMap = Object.fromEntries(state.groups.map((g) => [g.id, g.name]));

  root.innerHTML = `
    <div class="bulk-shell">
      <div class="bulk-header">
        <h2 style="display:flex;align-items:center;gap:8px;white-space:nowrap;">
          <i class="sp-icon sp-sprout-green" aria-hidden="true"></i> 점수 일괄 관리 및 이력
        </h2>
        <div class="bulk-tabs">
          <button type="button" class="bulk-tab ${activeTab === 'adjust' ? 'is-active' : ''}" data-bulk-tab="adjust">개인점수 직접 조정</button>
          <button type="button" class="bulk-tab ${activeTab === 'history' ? 'is-active' : ''}" data-bulk-tab="history">점수 이력 · 되돌리기 (${state.history.length})</button>
          <button type="button" class="bulk-tab ${activeTab === 'reset' ? 'is-active' : ''}" data-bulk-tab="reset">점수 초기화</button>
        </div>
      </div>

      ${activeTab === 'adjust' ? renderAdjustPanel(students, groupMap) : ''}
      ${activeTab === 'history' ? renderHistoryPanel(state.history) : ''}
      ${activeTab === 'reset' ? renderResetPanel(students, state.growth) : ''}
    </div>
  `;

  bindBulkEvents(root, students);
}

function renderAdjustPanel(students, groupMap) {
  return `
    <div class="bulk-panel">
      <div class="bulk-toolbar">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <strong style="font-size:13px;color:#5a5042;">학생별 상점·감점을 직접 수정한 뒤 저장하세요.</strong>
          <input type="text" id="bulk-adjust-reason" value="교사 직접 점수 조정" placeholder="조정 사유" style="padding:6px 10px;border:1px solid #d5cfc2;border-radius:6px;font-size:13px;">
        </div>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn-outline" id="btn-bulk-all-plus1">전원 상점 +1</button>
          <button type="button" class="btn-yellow" id="btn-bulk-save-adjust">변경사항 일괄 저장</button>
        </div>
      </div>
      <div class="bulk-table-scroll">
        <table class="bulk-table">
          <thead>
            <tr>
              <th style="width:64px;">번호</th>
              <th>학생</th>
              <th>모둠</th>
              <th>누적 상점</th>
              <th>누적 감점</th>
              <th>현재 총점</th>
            </tr>
          </thead>
          <tbody>
            ${students.map((st) => `
              <tr data-adj-row="${st.id}">
                <td><strong>${st.number}</strong></td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <img src="${getStillAvatarUrl(st.avatarId)}" alt="" style="width:28px;height:34px;object-fit:contain;">
                    <strong>${escapeHtml(st.name)}</strong>
                  </div>
                </td>
                <td>${escapeHtml(groupMap[st.groupId] || '-')}</td>
                <td><input type="number" class="bulk-num-input" data-adj-pos="${st.id}" min="0" value="${st.positive}"></td>
                <td><input type="number" class="bulk-num-input" data-adj-neg="${st.id}" min="0" value="${st.negative}"></td>
                <td><strong class="adj-total-cell" style="color:${st.score < 0 ? 'var(--red-penalty)' : 'var(--blue-score)'};font-size:16px;">${st.score}</strong></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderHistoryPanel(history) {
  const q = historyQuery.trim().toLowerCase();
  const filtered = history.filter((h) => {
    if (historyFilterKind === 'plus' && !(h.kind === 'score' && h.delta > 0)) return false;
    if (historyFilterKind === 'minus' && !(h.kind === 'score' && h.delta < 0)) return false;
    if (historyFilterKind === 'egg' && h.kind !== 'egg') return false;
    if (historyFilterKind === 'other' && !['adjust', 'reset'].includes(h.kind)) return false;
    if (q) {
      const hay = `${h.reason || ''} ${(h.studentNames || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return `
    <div class="bulk-panel">
      <div class="bulk-toolbar">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <select id="hist-filter-kind" style="padding:6px 10px;border:1px solid #d5cfc2;border-radius:6px;font-size:13px;">
            <option value="all" ${historyFilterKind === 'all' ? 'selected' : ''}>전체 유형</option>
            <option value="plus" ${historyFilterKind === 'plus' ? 'selected' : ''}>으쓱 (상점)</option>
            <option value="minus" ${historyFilterKind === 'minus' ? 'selected' : ''}>머쓱 (감점)</option>
            <option value="egg" ${historyFilterKind === 'egg' ? 'selected' : ''}>특별 황금알</option>
            <option value="other" ${historyFilterKind === 'other' ? 'selected' : ''}>직접조정 · 초기화</option>
          </select>
          <input type="search" id="hist-search-input" value="${escapeAttr(historyQuery)}" placeholder="학생 이름 또는 사유 검색..." style="padding:6px 12px;border:1px solid #d5cfc2;border-radius:6px;font-size:13px;min-width:220px;">
        </div>
        <span style="font-size:12px;color:#857c6d;">총 ${filtered.length}건 표시 (최근 순)</span>
      </div>
      <div class="bulk-table-scroll">
        <table class="bulk-table">
          <thead>
            <tr>
              <th style="width:155px;">일시</th>
              <th style="width:92px;">유형</th>
              <th>사유</th>
              <th>대상 학생</th>
              <th style="width:86px;">변동</th>
              <th style="width:110px;">되돌리기</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.length === 0 ? `
              <tr><td colspan="6" style="text-align:center;padding:34px;color:#999;">조건에 맞는 점수 이력이 없습니다.</td></tr>
            ` : filtered.map((h) => {
              const dt = new Date(h.timestamp);
              const timeStr = `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
              let badgeCls = 'reset';
              let badgeText = '관리';
              let deltaStr = '-';
              if (h.kind === 'score') {
                badgeCls = h.delta > 0 ? 'plus' : 'minus';
                badgeText = h.delta > 0 ? '으쓱' : '머쓱';
                deltaStr = h.delta > 0 ? `+${h.delta}` : `${h.delta}`;
              } else if (h.kind === 'egg') {
                badgeCls = 'egg';
                badgeText = '황금알';
                deltaStr = h.delta > 0 ? `+${h.delta}알` : `${h.delta}알`;
              } else if (h.kind === 'adjust') {
                badgeText = '직접조정';
                deltaStr = `${(h.studentNames || []).length}명`;
              } else if (h.kind === 'reset') {
                badgeText = '초기화';
              }
              const canUndo = !h.reverted && ['score', 'egg', 'adjust'].includes(h.kind);

              return `
                <tr class="history-row ${h.reverted ? 'is-reverted' : ''}">
                  <td style="color:#857c6d;font-size:12px;">${timeStr}</td>
                  <td><span class="history-badge ${badgeCls}">${badgeText}</span></td>
                  <td><strong>${escapeHtml(h.reason)}</strong></td>
                  <td style="max-width:280px;">${escapeHtml((h.studentNames || []).join(', '))}</td>
                  <td><strong>${deltaStr}</strong></td>
                  <td>
                    ${h.reverted
                      ? `<span style="font-size:11px;color:#999;">취소됨</span>`
                      : canUndo
                        ? `<button type="button" class="btn-outline" data-undo-id="${h.id}" style="padding:4px 10px;font-size:12px;">↺ 되돌리기</button>`
                        : `<span style="font-size:11px;color:#bbb;">-</span>`
                    }
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderResetPanel(students, growth) {
  return `
    <div class="bulk-panel" style="padding:24px;gap:18px;overflow-y:auto;">
      <div>
        <h3 style="margin:0 0 6px;font-size:17px;">현재 학급 점수 요약</h3>
        <p style="margin:0;font-size:13px;color:#776e60;">
          활성 학생 ${students.length}명 · 학급 황금알 <strong>${growth.eggs}개</strong> · 별길 진행 ${growth.pendingTrail.length}칸 · 누적 상점 ${growth.totalPositive} / 감점 ${growth.totalNegative}
        </p>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;">
        <div style="padding:18px;border:1px solid #e2ddd0;border-radius:10px;background:#faf9f4;display:flex;flex-direction:column;gap:10px;">
          <h4 style="margin:0;font-size:15px;">1. 전체 학생 개인 점수만 초기화</h4>
          <p style="margin:0;font-size:12px;color:#7c7467;line-height:1.5;">
            새 달·새 단원을 시작할 때 모든 학생의 개인 점수를 0점으로 돌립니다. 학급 황금알과 목표는 그대로 유지됩니다.
          </p>
          <button type="button" class="btn-outline" id="btn-panel-reset-students" style="margin-top:auto;">개인 점수만 초기화</button>
        </div>

        <div style="padding:18px;border:1px solid #f0c2ca;border-radius:10px;background:#fff7f8;display:flex;flex-direction:column;gap:10px;">
          <h4 style="margin:0;font-size:15px;color:#c12945;">2. 개인 점수 + 학급 황금알 전체 초기화</h4>
          <p style="margin:0;font-size:12px;color:#8c5460;line-height:1.5;">
            모든 학생의 개인 점수, 학급 황금알, 별길 진행도를 모두 0으로 초기화합니다. (학생 명단과 목표 설정은 유지됩니다)
          </p>
          <button type="button" class="btn-red" id="btn-panel-reset-all" style="margin-top:auto;">학급 전체 점수 초기화</button>
        </div>
      </div>
    </div>
  `;
}

function bindBulkEvents(root, students) {
  root.querySelectorAll('[data-bulk-tab]').forEach((btn) => {
    btn.onclick = () => {
      activeTab = btn.dataset.bulkTab;
      renderBulkScoreView(root);
    };
  });

  if (activeTab === 'adjust') {
    root.querySelectorAll('[data-adj-row]').forEach((tr) => {
      const posInp = tr.querySelector('[data-adj-pos]');
      const negInp = tr.querySelector('[data-adj-neg]');
      const totalEl = tr.querySelector('.adj-total-cell');
      const sync = () => {
        const score = (Number(posInp.value) || 0) - (Number(negInp.value) || 0);
        totalEl.textContent = score;
        totalEl.style.color = score < 0 ? 'var(--red-penalty)' : 'var(--blue-score)';
      };
      posInp.oninput = sync;
      negInp.oninput = sync;
    });

    root.querySelector('#btn-bulk-all-plus1').onclick = () => {
      root.querySelectorAll('[data-adj-pos]').forEach((inp) => {
        inp.value = (Number(inp.value) || 0) + 1;
        inp.dispatchEvent(new Event('input'));
      });
    };

    root.querySelector('#btn-bulk-save-adjust').onclick = async () => {
      const reason = root.querySelector('#bulk-adjust-reason')?.value.trim() || '교사 직접 점수 조정';
      const rows = students.map((st) => ({
        studentId: st.id,
        positive: Number(root.querySelector(`[data-adj-pos="${st.id}"]`)?.value) || 0,
        negative: Number(root.querySelector(`[data-adj-neg="${st.id}"]`)?.value) || 0,
      }));
      const changed = await applyDirectAdjustments(rows, reason);
      if (changed > 0) {
        playSound('confirm');
        showToast({ title: `${changed}명 학생의 점수를 직접 조정했습니다.`, tone: 'plus' });
      } else {
        showToast({ title: '변경된 점수가 없습니다.' });
      }
    };
  }

  if (activeTab === 'history') {
    const sel = root.querySelector('#hist-filter-kind');
    if (sel) {
      sel.onchange = () => {
        historyFilterKind = sel.value;
        renderBulkScoreView(root);
      };
    }
    const srch = root.querySelector('#hist-search-input');
    if (srch) {
      srch.oninput = () => {
        historyQuery = srch.value;
        renderBulkScoreView(root);
        const again = root.querySelector('#hist-search-input');
        if (again) {
          again.focus();
          again.setSelectionRange(again.value.length, again.value.length);
        }
      };
    }
    root.querySelectorAll('[data-undo-id]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('이 점수 기록을 되돌릴까요? 학생 점수와 별길/황금알이 함께 복구됩니다.')) return;
        const res = await undoHistoryEntry(btn.dataset.undoId);
        if (res?.ok) {
          playSound('confirm');
          showToast({ title: res.message, tone: 'plus' });
        }
      };
    });
  }

  if (activeTab === 'reset') {
    root.querySelector('#btn-panel-reset-students').onclick = async () => {
      if (!confirm('전체 학생의 개인 점수를 0점으로 초기화할까요?')) return;
      await resetScores({ scope: 'all-students' });
      playSound('confirm');
      showToast({ title: '전체 학생 개인 점수를 초기화했습니다.' });
    };
    root.querySelector('#btn-panel-reset-all').onclick = async () => {
      if (!confirm('정말로 개인 점수와 학급 황금알·별길을 모두 0으로 초기화할까요?')) return;
      await resetScores({ scope: 'all-with-eggs' });
      playSound('confirm');
      showToast({ title: '학급 전체 점수와 황금알을 초기화했습니다.' });
    };
  }
}
