// 교사용 과제 관리 모듈 (워크시트 배경지·도구제한 · 배경지/답변 분리 실시간 합성 · 문항별 영역 크롭 일괄 채점 · 외부 AI CSV 퀴즈/실시간 퀴즈 · 서버/구글드라이브 연결 설정)

import { store, uid, todayIso } from '../store.js';
import { playSound } from '../audio.js';
import { applyStudentScoreBatch } from '../score-engine.js';
import { presentOutcome, showToast, escapeHtml, escapeAttr } from '../effects.js';
import {
  AI_QUIZ_PROMPT,
  downloadQuizTemplateCsv,
  parseQuizCsv,
} from '../quiz-csv.js';
import {
  BUILTIN_BACKGROUNDS,
  DEFAULT_ALLOWED_TOOLS,
  renderWorksheetComposite,
  renderCroppedRegion,
} from '../worksheet-renderer.js';
import {
  GOOGLE_APPS_SCRIPT_TEMPLATE,
  parseFirebaseConfig,
  buildStudentConnectUrl,
  testDriveBridge,
  uploadFileToDrive,
  compressImageToDataUrl,
  isCloudConnected,
  connectTeacherCloud,
  disconnectCloud,
  syncTeacherStateToCloud,
  pushSubmissionToCloud,
} from '../cloud-sync.js';

let activeAssignmentId = null;
let detailTab = 'overview'; // 'overview' | 'byQuestion' | 'liveQuiz'
let filterStatus = 'all'; // 'all' | 'open' | 'closed'
let filterType = 'all'; // 'all' | 'worksheet' | 'general' | 'quiz'
let selectedStudentId = null;
let activeQuestionId = null;
let selectedGradeStudentIds = new Set();
let anonymousGrading = false;
let onlyUngraded = false;
let editingRegions = false;

/** 교사 상태 변경 시 클라우드 연결되어 있으면 자동 동기화 */
async function syncIfConnected() {
  if (!isCloudConnected()) return;
  try {
    await syncTeacherStateToCloud(store.getState());
  } catch (err) {
    console.warn('[CR2 Assignments] cloud sync failed:', err);
  }
}

/** 학생 제출물 총점 재계산 */
function recalcSubmissionTotal(submission) {
  const grades = submission?.questionGrades || {};
  let total = 0;
  let max = 0;
  let count = 0;
  for (const g of Object.values(grades)) {
    total += Number(g.score) || 0;
    max += Number(g.maxScore) || 0;
    count++;
  }
  return { total, max, count };
}

/** 교사용 과제 뷰 메인 렌더러 */
export function renderAssignmentsView(container) {
  if (!container) return;
  const state = store.getState();
  const assignments = state.assignments || [];

  if (activeAssignmentId && !assignments.some((a) => a.id === activeAssignmentId)) {
    activeAssignmentId = null;
  }

  if (activeAssignmentId) {
    renderAssignmentDetail(container, activeAssignmentId);
  } else {
    renderAssignmentsDashboard(container);
  }
}

// ============================================================
// 1. 과제 대시보드 (목록)
// ============================================================
function renderAssignmentsDashboard(container) {
  const state = store.getState();
  const activeStudents = state.students.filter((s) => !s.trashed);
  const allAssignments = [...(state.assignments || [])].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const submissions = state.submissions || {};

  const filtered = allAssignments.filter((a) => {
    if (filterStatus === 'open' && a.closed) return false;
    if (filterStatus === 'closed' && !a.closed) return false;
    if (filterType !== 'all' && a.kind !== filterType) return false;
    return true;
  });

  const cloudOn = isCloudConnected();
  const driveOn = Boolean(state.cloudConfig?.driveBridgeUrl);

  container.innerHTML = `
    <div class="asg-shell">
      <div class="asg-topbar">
        <div class="asg-title-group">
          <h2>📚 과제 · 워크시트 · AI 퀴즈</h2>
          <span class="asg-status-pill ${cloudOn ? 'is-on' : ''}">${cloudOn ? '☁️ 서버 연결됨' : '로컬 모드'}</span>
          <span class="asg-status-pill ${driveOn ? 'is-on' : ''}">${driveOn ? `📁 드라이브: ${escapeHtml(state.cloudConfig?.driveFolderName || '클래스레볼루션2')}` : '드라이브 미연결'}</span>
        </div>
        <div class="asg-top-actions">
          <button type="button" class="asg-btn is-outline" id="asg-btn-student-link">🔗 학생 접속 링크</button>
          <button type="button" class="asg-btn is-outline" id="asg-btn-server-cfg">⚙️ 서버·드라이브 설정</button>
          <button type="button" class="asg-btn is-primary" id="asg-btn-create">+ 새 과제 만들기</button>
        </div>
      </div>

      <div class="asg-filter-bar">
        <div class="asg-chip-group">
          ${[['all', '전체'], ['open', '진행 중'], ['closed', '마감됨']].map(([k, lbl]) => `
            <button type="button" class="asg-chip ${filterStatus === k ? 'is-active' : ''}" data-filter-status="${k}">${lbl}</button>
          `).join('')}
        </div>
        <div class="asg-chip-group">
          ${[['all', '모든 유형'], ['worksheet', '📝 워크시트'], ['quiz', '⚡ AI 퀴즈'], ['general', '📎 일반과제']].map(([k, lbl]) => `
            <button type="button" class="asg-chip ${filterType === k ? 'is-active' : ''}" data-filter-type="${k}">${lbl}</button>
          `).join('')}
        </div>
      </div>

      <div class="asg-list-scroll">
        ${filtered.length === 0 ? `
          <div class="asg-empty">
            <div class="asg-empty-icon">📝</div>
            <h3>아직 등록된 과제가 없습니다</h3>
            <p>우측 상단 <strong>[+ 새 과제 만들기]</strong>로 배경지 워크시트, 외부 AI CSV 퀴즈, 일반 과제를 출제해 보세요.</p>
          </div>
        ` : `
          <div class="asg-card-grid">
            ${filtered.map((a) => {
              const subMap = submissions[a.id] || {};
              const submittedCnt = activeStudents.filter((s) => Boolean(subMap[s.id])).length;
              const gradedCnt = activeStudents.filter((s) => subMap[s.id]?.status === 'graded').length;
              const pct = activeStudents.length > 0 ? Math.round((submittedCnt / activeStudents.length) * 100) : 0;
              const kindLabel = a.kind === 'worksheet' ? '📝 워크시트' : a.kind === 'quiz' ? (a.quizMode === 'live' ? '⚡ 실시간 퀴즈' : '⚡ 퀴즈과제') : '📎 일반과제';
              return `
                <article class="asg-card ${a.closed ? 'is-closed' : ''}" data-open-asg="${a.id}">
                  <div class="asg-card-head">
                    <span class="asg-kind-badge is-${a.kind}">${kindLabel}</span>
                    ${a.subject ? `<span class="asg-subj-tag">${escapeHtml(a.subject)}</span>` : ''}
                    ${a.closed ? `<span class="asg-closed-tag">마감</span>` : ''}
                  </div>
                  <h3 class="asg-card-title">${escapeHtml(a.title)}</h3>
                  <p class="asg-card-desc">${escapeHtml(a.description || '안내 설명 없음')}</p>
                  <div class="asg-progress-wrap">
                    <div class="asg-progress-meta">
                      <span>제출 <strong>${submittedCnt}</strong> / ${activeStudents.length}명 (채점 ${gradedCnt}명)</span>
                      <span>${pct}%</span>
                    </div>
                    <div class="asg-progress-track"><div class="asg-progress-fill" style="width:${pct}%"></div></div>
                  </div>
                  <div class="asg-card-foot">
                    <span class="asg-due">${a.dueDate ? `마감: ${escapeHtml(a.dueDate)}` : '마감 없음'}</span>
                    <div class="asg-card-btns">
                      <button type="button" class="asg-mini-btn" data-edit-asg="${a.id}">수정</button>
                      <button type="button" class="asg-mini-btn" data-toggle-close="${a.id}">${a.closed ? '다시열기' : '마감'}</button>
                      <button type="button" class="asg-mini-btn is-danger" data-del-asg="${a.id}">삭제</button>
                    </div>
                  </div>
                </article>
              `;
            }).join('')}
          </div>
        `}
      </div>
    </div>
  `;

  container.querySelector('#asg-btn-create').onclick = () => openAssignmentEditorModal(null, () => renderAssignmentsView(container));
  container.querySelector('#asg-btn-server-cfg').onclick = () => openCloudDriveSettingsModal(() => renderAssignmentsView(container));
  container.querySelector('#asg-btn-student-link').onclick = () => openStudentLinkModal();

  container.querySelectorAll('[data-filter-status]').forEach((b) => {
    b.onclick = () => { filterStatus = b.dataset.filterStatus; renderAssignmentsDashboard(container); };
  });
  container.querySelectorAll('[data-filter-type]').forEach((b) => {
    b.onclick = () => { filterType = b.dataset.filterType; renderAssignmentsDashboard(container); };
  });

  container.querySelectorAll('[data-open-asg]').forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest('button')) return;
      activeAssignmentId = card.dataset.openAsg;
      detailTab = 'overview';
      selectedStudentId = null;
      activeQuestionId = null;
      selectedGradeStudentIds.clear();
      renderAssignmentsView(container);
    };
  });
  container.querySelectorAll('[data-edit-asg]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const target = allAssignments.find((x) => x.id === btn.dataset.editAsg);
      if (target) openAssignmentEditorModal(target, () => renderAssignmentsView(container));
    };
  });
  container.querySelectorAll('[data-toggle-close]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      await store.update((s) => {
        const target = (s.assignments || []).find((x) => x.id === btn.dataset.toggleClose);
        if (target) target.closed = !target.closed;
      });
      await syncIfConnected();
      renderAssignmentsDashboard(container);
    };
  });
  container.querySelectorAll('[data-del-asg]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      if (!confirm('이 과제와 제출 기록을 삭제할까요?')) return;
      await store.update((s) => {
        s.assignments = (s.assignments || []).filter((x) => x.id !== btn.dataset.delAsg);
        if (s.submissions) delete s.submissions[btn.dataset.delAsg];
      });
      await syncIfConnected();
      renderAssignmentsDashboard(container);
    };
  });
}

// ============================================================
// 2. 과제 출제 / 수정 모달 (워크시트 · 일반 · AI CSV 퀴즈)
// ============================================================
function openAssignmentEditorModal(existing, onSaved) {
  const state = store.getState();
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  let kind = existing?.kind || 'worksheet';
  let bgPreset = existing?.template?.preset || 'blank';
  let bgImageUrl = existing?.template?.imageUrl || '';
  let bgFileName = existing?.template?.fileName || '';
  let allowedTools = { ...DEFAULT_ALLOWED_TOOLS, ...(existing?.allowedTools || {}) };
  let quizQuestions = Array.isArray(existing?.quiz?.questions) ? structuredClone(existing.quiz.questions) : [];
  let quizMode = existing?.quizMode || 'self'; // 'self' | 'live'
  let showExplainImmediately = existing?.quiz?.showExplainImmediately !== false;

  const renderModal = () => {
    backdrop.innerHTML = `
      <form class="dialog-card is-wide asg-editor-dialog">
        <div class="dialog-header">
          <h2>${existing ? '과제 수정' : '새 과제 만들기'}</h2>
          <button type="button" class="dialog-close">&times;</button>
        </div>
        <div class="dialog-body asg-editor-body">
          <div class="asg-kind-tabs">
            <button type="button" class="asg-kind-tab ${kind === 'worksheet' ? 'is-active' : ''}" data-kind="worksheet">📝 워크시트 (배경지 + 도구제한)</button>
            <button type="button" class="asg-kind-tab ${kind === 'quiz' ? 'is-active' : ''}" data-kind="quiz">⚡ 상호작용 AI 퀴즈 (CSV)</button>
            <button type="button" class="asg-kind-tab ${kind === 'general' ? 'is-active' : ''}" data-kind="general">📎 일반 과제 (글·사진·링크)</button>
          </div>

          <div class="field-row">
            <label class="field-label" style="flex:2;">
              <span>과제 제목</span>
              <input type="text" name="title" maxlength="60" value="${escapeAttr(existing?.title || '')}" placeholder="예: 3단원 분수의 덧셈 학습지" required>
            </label>
            <label class="field-label" style="flex:1;">
              <span>과목 / 분류</span>
              <input type="text" name="subject" maxlength="20" value="${escapeAttr(existing?.subject || '')}" placeholder="예: 수학, 국어">
            </label>
          </div>

          <label class="field-label">
            <span>과제 안내 설명</span>
            <textarea name="description" rows="2" placeholder="학생에게 보여줄 수행 안내를 입력하세요.">${escapeHtml(existing?.description || '')}</textarea>
          </label>

          <div class="field-row">
            <label class="field-label">
              <span>마감일 (선택)</span>
              <input type="date" name="dueDate" value="${escapeAttr(existing?.dueDate || '')}">
            </label>
            <label class="field-label">
              <span>완료 보상 으쓱 점수</span>
              <input type="number" name="rewardPoints" min="0" max="20" value="${Number(existing?.rewardPoints ?? 1)}">
            </label>
            <label class="field-label">
              <span>공개 범위</span>
              <select name="visibility">
                <option value="private" ${existing?.visibility !== 'shared' ? 'selected' : ''}>교사만 보기 (비공개)</option>
                <option value="shared" ${existing?.visibility === 'shared' ? 'selected' : ''}>우리 반 공유 (친구 작품 보기)</option>
              </select>
            </label>
          </div>

          ${kind === 'worksheet' ? `
            <div class="asg-subpanel">
              <h4>📄 템플릿(배경지) 설정 <small>— 과제당 1회만 저장, 학생 제출 시 답변 레이어만 전송</small></h4>
              <div class="asg-bg-presets">
                ${BUILTIN_BACKGROUNDS.map((bg) => `
                  <button type="button" class="asg-chip ${!bgImageUrl && bgPreset === bg.id ? 'is-active' : ''}" data-bg-preset="${bg.id}">${bg.label}</button>
                `).join('')}
                <label class="asg-chip is-upload">
                  🖼️ 배경지 이미지 올리기
                  <input type="file" id="asg-bg-upload" accept="image/*" hidden>
                </label>
                ${bgImageUrl ? `<button type="button" class="asg-chip is-danger" id="asg-bg-clear">이미지 제거 (${escapeHtml(bgFileName || '업로드됨')})</button>` : ''}
              </div>
              ${bgImageUrl ? `<div class="asg-bg-thumb"><img src="${escapeAttr(bgImageUrl)}" alt="배경지 미리보기"></div>` : ''}

              <h4 style="margin-top:12px;">🔒 학생 허용 도구 제한 (체크한 도구만 학생 화면에 표시)</h4>
              <div class="asg-tool-checks">
                <label><input type="checkbox" data-allow-tool="pen" ${allowedTools.pen ? 'checked' : ''}> ✏️ 펜</label>
                <label><input type="checkbox" data-allow-tool="highlighter" ${allowedTools.highlighter ? 'checked' : ''}> 🖍️ 형광펜</label>
                <label><input type="checkbox" data-allow-tool="text" ${allowedTools.text ? 'checked' : ''}> 🔤 텍스트</label>
                <label><input type="checkbox" data-allow-tool="eraser" ${allowedTools.eraser ? 'checked' : ''}> 🧽 지우개</label>
                <label><input type="checkbox" data-allow-tool="photo" ${allowedTools.photo ? 'checked' : ''}> 📷 추가 사진 첨부</label>
              </div>
            </div>
          ` : ''}

          ${kind === 'quiz' ? `
            <div class="asg-subpanel">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                <h4>⚡ 외부 AI 연동 CSV 퀴즈 (객관식 · OX · 단답형)</h4>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button type="button" class="asg-btn is-outline is-sm" id="btn-dl-quiz-csv">📥 AI 양식 CSV 다운로드</button>
                  <button type="button" class="asg-btn is-outline is-sm" id="btn-copy-ai-prompt">📋 AI 작업 지침 프롬프트 복사</button>
                </div>
              </div>
              <p class="asg-hint">수업 참고자료와 함께 위 양식 CSV + 지침 프롬프트를 외부 AI(ChatGPT/Gemini 등)에 전달한 뒤, 생성된 CSV를 아래에 올리거나 붙여넣으세요.</p>

              <div class="field-row" style="margin-bottom:8px;">
                <label class="field-label">
                  <span>진행 방식</span>
                  <select id="asg-quiz-mode">
                    <option value="self" ${quizMode === 'self' ? 'selected' : ''}>개인과제형 (학생이 자기 속도로 풀이)</option>
                    <option value="live" ${quizMode === 'live' ? 'selected' : ''}>실시간 퀴즈형 (교사가 문항씩 실시간 진행)</option>
                  </select>
                </label>
                <label style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:700;padding-top:18px;">
                  <input type="checkbox" id="asg-quiz-explain" ${showExplainImmediately ? 'checked' : ''}>
                  <span>제출 후 정답·해설 즉시 공개</span>
                </label>
              </div>

              <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
                <label class="asg-btn is-outline is-sm" style="cursor:pointer;">
                  📂 CSV 파일 불러오기
                  <input type="file" id="asg-quiz-csv-file" accept=".csv,text/csv,text/plain" hidden>
                </label>
                <button type="button" class="asg-btn is-primary is-sm" id="btn-parse-quiz-csv">아래 텍스트 CSV 적용</button>
                <span class="asg-hint" style="margin:0;">현재 문항: <strong>${quizQuestions.length}문항</strong></span>
              </div>
              <textarea id="asg-quiz-csv-text" rows="4" placeholder="외부 AI가 생성한 CSV 텍스트를 여기에 그대로 붙여넣고 [아래 텍스트 CSV 적용]을 누르세요."></textarea>

              ${quizQuestions.length > 0 ? `
                <div class="asg-quiz-preview">
                  ${quizQuestions.map((q, idx) => `
                    <div class="asg-quiz-item">
                      <span class="asg-q-badge">${idx + 1}번 · ${q.type === 'choice' ? '객관식' : q.type === 'ox' ? 'OX' : '단답형'} (${q.points}점)</span>
                      <strong>${escapeHtml(q.prompt)}</strong>
                      <span class="asg-q-ans">정답: ${escapeHtml(q.answer)}</span>
                      <button type="button" class="asg-mini-btn is-danger" data-del-q="${idx}">삭제</button>
                    </div>
                  `).join('')}
                </div>
              ` : ''}
            </div>
          ` : ''}

          ${kind === 'general' ? `
            <div class="asg-subpanel">
              <h4>📎 일반 과제 제출 안내</h4>
              <p class="asg-hint">학생이 텍스트, 사진/파일(구글 드라이브 <strong>${escapeHtml(state.cloudConfig?.driveFolderName || '클래스레볼루션2')}</strong> 폴더 자동 저장), 링크를 제출할 수 있습니다.</p>
            </div>
          ` : ''}
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn-ghost" data-cancel>취소</button>
          <button type="submit" class="btn-yellow">${existing ? '과제 수정 저장' : '과제 출제하기'}</button>
        </div>
      </form>
    `;

    backdrop.querySelector('.dialog-close').onclick = close;
    backdrop.querySelector('[data-cancel]').onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

    const keepFormValues = () => {
      const f = backdrop.querySelector('form');
      if (!f) return;
      existing = {
        ...(existing || {}),
        title: f.elements.title?.value || '',
        subject: f.elements.subject?.value || '',
        description: f.elements.description?.value || '',
        dueDate: f.elements.dueDate?.value || '',
        rewardPoints: Number(f.elements.rewardPoints?.value ?? 1),
        visibility: f.elements.visibility?.value || 'private',
      };
    };

    backdrop.querySelectorAll('[data-kind]').forEach((b) => {
      b.onclick = () => { keepFormValues(); kind = b.dataset.kind; renderModal(); };
    });

    if (kind === 'worksheet') {
      backdrop.querySelectorAll('[data-bg-preset]').forEach((b) => {
        b.onclick = () => { keepFormValues(); bgPreset = b.dataset.bgPreset; bgImageUrl = ''; bgFileName = ''; renderModal(); };
      });
      const bgClear = backdrop.querySelector('#asg-bg-clear');
      if (bgClear) bgClear.onclick = () => { keepFormValues(); bgImageUrl = ''; bgFileName = ''; renderModal(); };

      const bgInput = backdrop.querySelector('#asg-bg-upload');
      if (bgInput) {
        bgInput.onchange = async () => {
          const file = bgInput.files?.[0];
          if (!file) return;
          keepFormValues();
          try {
            showToast({ title: '배경지 이미지를 처리하는 중...' });
            const cfg = store.getState().cloudConfig || {};
            if (cfg.driveBridgeUrl) {
              const up = await uploadFileToDrive({
                bridgeUrl: cfg.driveBridgeUrl,
                folderName: cfg.driveFolderName || '클래스레볼루션2',
                assignmentTitle: existing?.title || '배경지_템플릿',
                studentLabel: 'TEMPLATE',
                file,
              });
              bgImageUrl = up.thumbnailUrl || up.viewUrl;
            } else {
              bgImageUrl = await compressImageToDataUrl(file, 1400, 0.82);
            }
            bgFileName = file.name;
            showToast({ title: '배경지 이미지가 설정되었습니다!', tone: 'plus' });
            renderModal();
          } catch (err) {
            showToast({ title: '배경지 업로드 실패', detail: err.message, tone: 'minus' });
          }
        };
      }

      backdrop.querySelectorAll('[data-allow-tool]').forEach((chk) => {
        chk.onchange = () => { allowedTools[chk.dataset.allowTool] = chk.checked; };
      });
    }

    if (kind === 'quiz') {
      backdrop.querySelector('#btn-dl-quiz-csv').onclick = () => {
        downloadQuizTemplateCsv();
        showToast({ title: 'AI 퀴즈 양식 CSV를 다운로드했습니다!', tone: 'plus' });
      };
      backdrop.querySelector('#btn-copy-ai-prompt').onclick = async () => {
        try {
          await navigator.clipboard.writeText(AI_QUIZ_PROMPT);
          showToast({ title: 'AI 작업 지침 프롬프트를 복사했습니다!', tone: 'plus' });
        } catch {
          prompt('아래 지침 프롬프트를 복사하세요:', AI_QUIZ_PROMPT);
        }
      };
      backdrop.querySelector('#asg-quiz-mode').onchange = (e) => { quizMode = e.target.value; };
      backdrop.querySelector('#asg-quiz-explain').onchange = (e) => { showExplainImmediately = e.target.checked; };

      const applyCsv = (txt) => {
        const res = parseQuizCsv(txt);
        if (res.questions.length === 0) {
          showToast({ title: 'CSV 파싱 실패', detail: res.errors.join(' '), tone: 'minus' });
          return;
        }
        keepFormValues();
        quizQuestions = res.questions;
        showToast({ title: `${quizQuestions.length}개 문항을 불러왔습니다!`, tone: 'plus' });
        renderModal();
      };

      backdrop.querySelector('#btn-parse-quiz-csv').onclick = () => {
        applyCsv(backdrop.querySelector('#asg-quiz-csv-text').value);
      };
      backdrop.querySelector('#asg-quiz-csv-file').onchange = async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const txt = await f.text();
        applyCsv(txt);
      };
      backdrop.querySelectorAll('[data-del-q]').forEach((b) => {
        b.onclick = () => {
          keepFormValues();
          quizQuestions.splice(Number(b.dataset.delQ), 1);
          quizQuestions.forEach((q, i) => { q.number = i + 1; q.id = `q-${i + 1}`; });
          renderModal();
        };
      });
    }

    backdrop.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const title = String(fd.get('title') || '').trim();
      if (!title) return;
      if (kind === 'quiz' && quizQuestions.length === 0) {
        showToast({ title: '퀴즈 문항이 없습니다. CSV를 먼저 불러와 주세요.', tone: 'minus' });
        return;
      }

      const payload = {
        id: existing?.id || uid('asg'),
        kind,
        title,
        subject: String(fd.get('subject') || '').trim(),
        description: String(fd.get('description') || '').trim(),
        dueDate: String(fd.get('dueDate') || '').trim(),
        rewardPoints: Math.max(0, Math.min(20, Math.trunc(Number(fd.get('rewardPoints') || 0)))),
        visibility: String(fd.get('visibility') || 'private'),
        closed: Boolean(existing?.closed),
        createdAt: existing?.createdAt || Date.now(),
        template: kind === 'worksheet' ? { preset: bgPreset, imageUrl: bgImageUrl, fileName: bgFileName, width: 1200, height: 850 } : null,
        allowedTools: kind === 'worksheet' ? { ...allowedTools } : null,
        regions: Array.isArray(existing?.regions) ? existing.regions : [],
        quizMode: kind === 'quiz' ? quizMode : null,
        quiz: kind === 'quiz' ? { questions: quizQuestions, showExplainImmediately } : null,
        liveQuiz: kind === 'quiz' ? (existing?.liveQuiz || { active: false, currentIndex: 0, revealAnswer: false }) : null,
      };

      await store.update((s) => {
        if (!Array.isArray(s.assignments)) s.assignments = [];
        const idx = s.assignments.findIndex((x) => x.id === payload.id);
        if (idx >= 0) s.assignments[idx] = payload;
        else s.assignments.unshift(payload);
      });
      await syncIfConnected();
      playSound('confirm');
      showToast({ title: existing?.id ? '과제가 수정되었습니다!' : '새 과제가 출제되었습니다!', tone: 'plus' });
      close();
      if (typeof onSaved === 'function') onSaved();
    };
  };

  modalRoot.appendChild(backdrop);
  renderModal();
}

// ============================================================
// 3. 과제 상세 · 학생별 채점 · 문항별 영역 크롭 채점 · 실시간 퀴즈
// ============================================================
function renderAssignmentDetail(container, assignmentId) {
  const state = store.getState();
  const asg = (state.assignments || []).find((a) => a.id === assignmentId);
  if (!asg) {
    activeAssignmentId = null;
    renderAssignmentsDashboard(container);
    return;
  }

  const students = state.students.filter((s) => !s.trashed).sort((a, b) => a.number - b.number);
  const subMap = (state.submissions && state.submissions[asg.id]) || {};
  const submittedStudents = students.filter((s) => Boolean(subMap[s.id]));

  container.innerHTML = `
    <div class="asg-shell">
      <div class="asg-detail-header">
        <button type="button" class="asg-btn is-outline" id="asg-btn-back">← 과제 목록</button>
        <div class="asg-detail-title">
          <h2>${escapeHtml(asg.title)}</h2>
          <span class="asg-detail-meta">제출 ${submittedStudents.length} / ${students.length}명${asg.dueDate ? ` · 마감 ${escapeHtml(asg.dueDate)}` : ''}</span>
        </div>
        <div class="asg-detail-tabs">
          <button type="button" class="asg-tab ${detailTab === 'overview' ? 'is-active' : ''}" data-dtab="overview">학생별 채점</button>
          ${asg.kind === 'worksheet' || asg.kind === 'quiz' ? `
            <button type="button" class="asg-tab ${detailTab === 'byQuestion' ? 'is-active' : ''}" data-dtab="byQuestion">✂️ 문항별 채점</button>
          ` : ''}
          ${asg.kind === 'quiz' ? `
            <button type="button" class="asg-tab ${detailTab === 'liveQuiz' ? 'is-active' : ''}" data-dtab="liveQuiz">⚡ 실시간 퀴즈</button>
          ` : ''}
        </div>
        <div class="asg-top-actions">
          <button type="button" class="asg-btn is-outline is-sm" id="asg-btn-export-chk">체크표 반영</button>
          <button type="button" class="asg-btn is-primary is-sm" id="asg-btn-bulk-reward">★ 제출자 일괄 으쓱</button>
        </div>
      </div>

      <div class="asg-detail-body" id="asg-detail-body"></div>
    </div>
  `;

  container.querySelector('#asg-btn-back').onclick = () => {
    activeAssignmentId = null;
    renderAssignmentsDashboard(container);
  };
  container.querySelectorAll('[data-dtab]').forEach((b) => {
    b.onclick = () => {
      detailTab = b.dataset.dtab;
      selectedGradeStudentIds.clear();
      renderAssignmentDetail(container, asg.id);
    };
  });

  // 체크표로 제출 현황 원클릭 반영
  container.querySelector('#asg-btn-export-chk').onclick = async () => {
    const today = todayIso();
    await store.update((s) => {
      const chkId = `chk-asg-${asg.id}`;
      if (!s.checklist.items.some((it) => it.id === chkId)) {
        s.checklist.items.push({
          id: chkId,
          title: `[과제] ${asg.title.slice(0, 14)}`,
          type: 'check',
          color: '#2b8be0',
          memo: '과제 모듈 자동 연동',
          archived: false,
          order: s.checklist.items.length,
        });
      }
      if (!s.checklist.entriesByDate[today]) s.checklist.entriesByDate[today] = {};
      for (const st of submittedStudents) {
        s.checklist.entriesByDate[today][`${st.id}::${chkId}`] = true;
      }
    });
    playSound('confirm');
    showToast({ title: `체크표(${today})에 제출자 ${submittedStudents.length}명을 반영했습니다!`, tone: 'plus' });
  };

  // 제출자 일괄 으쓱 부여 (미지급자만)
  container.querySelector('#asg-btn-bulk-reward').onclick = async () => {
    const pts = Math.max(1, Number(asg.rewardPoints) || 1);
    const targets = submittedStudents.filter((st) => !subMap[st.id]?.rewardGiven);
    if (targets.length === 0) {
      showToast({ title: '보상 점수를 줄 미지급 제출자가 없습니다.' });
      return;
    }
    if (!confirm(`제출 완료 학생 ${targets.length}명에게 으쓱 +${pts}점을 일괄 부여할까요?`)) return;
    const outcome = await applyStudentScoreBatch({
      studentIds: targets.map((t) => t.id),
      delta: pts,
      reason: `과제 완료: ${asg.title}`,
    });
    await store.update((s) => {
      if (!s.submissions[asg.id]) s.submissions[asg.id] = {};
      for (const t of targets) {
        if (s.submissions[asg.id][t.id]) s.submissions[asg.id][t.id].rewardGiven = true;
      }
    });
    for (const t of targets) {
      await pushSubmissionToCloud(asg.id, t.id, store.getState().submissions[asg.id][t.id]);
    }
    await syncIfConnected();
    presentOutcome(outcome);
    renderAssignmentDetail(container, asg.id);
  };

  const bodyEl = container.querySelector('#asg-detail-body');
  if (detailTab === 'overview') {
    renderStudentOverviewTab(bodyEl, asg, students, subMap, () => renderAssignmentDetail(container, asg.id));
  } else if (detailTab === 'byQuestion') {
    renderByQuestionGradingTab(bodyEl, asg, students, subMap, () => renderAssignmentDetail(container, asg.id));
  } else if (detailTab === 'liveQuiz') {
    renderLiveQuizTab(bodyEl, asg, students, subMap, () => renderAssignmentDetail(container, asg.id));
  }
}

/** 탭 1: 학생별 제출 현황 및 상세 채점 (배경지+답변 실시간 합성 + 구글 드라이브 사진 열람/다운로드) */
function renderStudentOverviewTab(bodyEl, asg, students, subMap, rerender) {
  if (!selectedStudentId) {
    selectedStudentId = students.find((s) => Boolean(subMap[s.id]))?.id || students[0]?.id || null;
  }
  const curStudent = students.find((s) => s.id === selectedStudentId) || null;
  const curSub = curStudent ? subMap[curStudent.id] || null : null;

  bodyEl.innerHTML = `
    <div class="asg-split-layout">
      <aside class="asg-student-list">
        <div class="asg-sl-head">
          <span>학생 명단 (${students.length}명)</span>
          <button type="button" class="asg-mini-btn" id="btn-copy-unsub">미제출자 복사</button>
        </div>
        <div class="asg-sl-items">
          ${students.map((st) => {
            const sub = subMap[st.id];
            const stCls = !sub ? 'is-none' : sub.status === 'graded' ? 'is-graded' : sub.status === 'redo' ? 'is-redo' : 'is-sub';
            const stTxt = !sub ? '미제출' : sub.status === 'graded' ? '채점완료' : sub.status === 'redo' ? '다시제출' : '제출됨';
            const tot = sub ? recalcSubmissionTotal(sub) : null;
            return `
              <button type="button" class="asg-sl-item ${selectedStudentId === st.id ? 'is-active' : ''}" data-pick-st="${st.id}">
                <span class="asg-sl-num">${st.number}</span>
                <span class="asg-sl-name">${escapeHtml(st.name)}</span>
                ${tot && tot.count > 0 ? `<span class="asg-sl-score">${tot.total}/${tot.max}</span>` : ''}
                <span class="asg-sl-badge ${stCls}">${stTxt}</span>
              </button>
            `;
          }).join('')}
        </div>
      </aside>

      <section class="asg-viewer-pane">
        ${!curStudent ? `<div class="asg-empty"><p>학생을 선택하세요.</p></div>` : !curSub ? `
          <div class="asg-empty">
            <h3>${curStudent.number}번 ${escapeHtml(curStudent.name)}</h3>
            <p>아직 과제를 제출하지 않았습니다.</p>
          </div>
        ` : `
          <div class="asg-viewer-head">
            <div>
              <h3>${curStudent.number}번 ${escapeHtml(curStudent.name)}</h3>
              <span class="asg-hint">제출 시각: ${new Date(curSub.submittedAt || Date.now()).toLocaleString('ko-KR')}</span>
            </div>
            <div style="display:flex;gap:8px;align-items:center;">
              ${asg.kind === 'worksheet' ? `<button type="button" class="asg-btn is-outline is-sm" id="btn-dl-composite">💾 합성 이미지 다운로드</button>` : ''}
              <button type="button" class="asg-btn is-primary is-sm" id="btn-give-one-reward" ${curSub.rewardGiven ? 'disabled' : ''}>
                ${curSub.rewardGiven ? '✓ 으쓱 지급완료' : `★ 으쓱 +${Math.max(1, Number(asg.rewardPoints) || 1)}점 주기`}
              </button>
            </div>
          </div>

          <div class="asg-viewer-content">
            ${asg.kind === 'worksheet' ? `
              <div class="asg-composite-box">
                <canvas id="asg-composite-canvas" class="asg-composite-canvas"></canvas>
              </div>
            ` : ''}

            ${curSub.text ? `
              <div class="asg-text-box">
                <h4>작성 내용</h4>
                <p>${escapeHtml(curSub.text).replace(/\n/g, '<br>')}</p>
              </div>
            ` : ''}

            ${curSub.link ? `
              <div class="asg-text-box">
                <h4>제출 링크</h4>
                <a href="${escapeAttr(curSub.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(curSub.link)}</a>
              </div>
            ` : ''}

            ${Array.isArray(curSub.files) && curSub.files.length > 0 ? `
              <div class="asg-files-box">
                <h4>첨부 사진 · 파일 (${curSub.files.length}개)</h4>
                <div class="asg-files-grid">
                  ${curSub.files.map((f) => `
                    <div class="asg-file-card">
                      ${f.mimeType?.startsWith('image/') ? `<img src="${escapeAttr(f.thumbnailUrl || f.viewUrl)}" alt="${escapeAttr(f.name)}">` : `<div class="asg-file-icon">📄</div>`}
                      <span class="asg-file-name" title="${escapeAttr(f.name)}">${escapeHtml(f.name)}</span>
                      <div class="asg-file-links">
                        <a href="${escapeAttr(f.viewUrl)}" target="_blank" rel="noopener noreferrer">열람</a>
                        <a href="${escapeAttr(f.downloadUrl || f.viewUrl)}" download="${escapeAttr(f.name)}" target="_blank" rel="noopener noreferrer">다운로드</a>
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}

            ${asg.kind === 'quiz' && Array.isArray(asg.quiz?.questions) ? `
              <div class="asg-quiz-review-list">
                <h4>퀴즈 답안 (총 ${recalcSubmissionTotal(curSub).total} / ${recalcSubmissionTotal(curSub).max}점)</h4>
                ${asg.quiz.questions.map((q, i) => {
                  const ans = curSub.quizAnswers?.[q.id] ?? '(미응답)';
                  const gr = curSub.questionGrades?.[q.id];
                  const cls = gr?.status === 'correct' ? 'is-ok' : gr?.status === 'partial' ? 'is-part' : 'is-bad';
                  return `
                    <div class="asg-qr-row ${cls}">
                      <span class="asg-qr-num">${i + 1}번</span>
                      <div class="asg-qr-body">
                        <strong>${escapeHtml(q.prompt)}</strong>
                        <div>학생 답: <em>${escapeHtml(String(ans))}</em> · 정답: <b>${escapeHtml(q.answer)}</b></div>
                      </div>
                      <span class="asg-qr-score">${gr?.score ?? 0}/${q.points}점</span>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : ''}
          </div>

          <div class="asg-feedback-bar">
            <input type="text" id="asg-st-feedback" value="${escapeAttr(curSub.feedback || '')}" placeholder="이 학생에게 남길 피드백 코멘트를 입력하세요...">
            <select id="asg-st-status">
              <option value="graded" ${curSub.status === 'graded' ? 'selected' : ''}>채점완료</option>
              <option value="submitted" ${curSub.status === 'submitted' ? 'selected' : ''}>제출됨</option>
              <option value="redo" ${curSub.status === 'redo' ? 'selected' : ''}>다시제출 요청</option>
            </select>
            <button type="button" class="asg-btn is-primary is-sm" id="btn-save-st-fb">피드백 저장</button>
          </div>
        `}
      </section>
    </div>
  `;

  bodyEl.querySelector('#btn-copy-unsub').onclick = async () => {
    const unsub = students.filter((s) => !subMap[s.id]).map((s) => `${s.number}번 ${s.name}`);
    const text = unsub.length === 0 ? '모든 학생이 제출했습니다!' : `[${asg.title} 미제출자 (${unsub.length}명)]\n${unsub.join(', ')}`;
    try {
      await navigator.clipboard.writeText(text);
      showToast({ title: `미제출자 ${unsub.length}명 명단을 복사했습니다.`, tone: 'plus' });
    } catch {
      prompt('미제출자 명단:', text);
    }
  };

  bodyEl.querySelectorAll('[data-pick-st]').forEach((b) => {
    b.onclick = () => { selectedStudentId = b.dataset.pickSt; renderStudentOverviewTab(bodyEl, asg, students, subMap, rerender); };
  });

  if (curStudent && curSub) {
    if (asg.kind === 'worksheet') {
      const cvs = bodyEl.querySelector('#asg-composite-canvas');
      if (cvs) renderWorksheetComposite(cvs, asg.template, curSub.worksheetData);
      const dlBtn = bodyEl.querySelector('#btn-dl-composite');
      if (dlBtn && cvs) {
        dlBtn.onclick = () => {
          const a = document.createElement('a');
          a.href = cvs.toDataURL('image/png');
          a.download = `${asg.title}_${curStudent.number}_${curStudent.name}.png`;
          a.click();
        };
      }
    }

    const saveFb = bodyEl.querySelector('#btn-save-st-fb');
    if (saveFb) {
      saveFb.onclick = async () => {
        const fb = bodyEl.querySelector('#asg-st-feedback').value.trim();
        const st = bodyEl.querySelector('#asg-st-status').value;
        await store.update((s) => {
          if (s.submissions[asg.id]?.[curStudent.id]) {
            s.submissions[asg.id][curStudent.id].feedback = fb;
            s.submissions[asg.id][curStudent.id].status = st;
          }
        });
        await pushSubmissionToCloud(asg.id, curStudent.id, store.getState().submissions[asg.id][curStudent.id]);
        playSound('confirm');
        showToast({ title: `${curStudent.name} 학생 피드백을 저장했습니다.`, tone: 'plus' });
        rerender();
      };
    }

    const rewardBtn = bodyEl.querySelector('#btn-give-one-reward');
    if (rewardBtn) {
      rewardBtn.onclick = async () => {
        const pts = Math.max(1, Number(asg.rewardPoints) || 1);
        const outcome = await applyStudentScoreBatch({
          studentIds: [curStudent.id],
          delta: pts,
          reason: `과제 완료: ${asg.title}`,
        });
        await store.update((s) => {
          if (s.submissions[asg.id]?.[curStudent.id]) s.submissions[asg.id][curStudent.id].rewardGiven = true;
        });
        await pushSubmissionToCloud(asg.id, curStudent.id, store.getState().submissions[asg.id][curStudent.id]);
        await syncIfConnected();
        presentOutcome(outcome);
        rerender();
      };
    }
  }
}

/**
 * 탭 2: 문항별 영역 크롭 일괄 채점 (워크시트 박스 크롭 / 퀴즈 문항별 일괄 채점)
 */
function renderByQuestionGradingTab(bodyEl, asg, students, subMap, rerender) {
  const isWorksheet = asg.kind === 'worksheet';
  const items = isWorksheet
    ? (Array.isArray(asg.regions) ? asg.regions : [])
    : (Array.isArray(asg.quiz?.questions) ? asg.quiz.questions.map((q) => ({ id: q.id, label: `${q.number}번`, maxScore: q.points, prompt: q.prompt, answer: q.answer })) : []);

  if (isWorksheet && items.length === 0) {
    editingRegions = true;
  }
  if (!activeQuestionId || !items.some((it) => it.id === activeQuestionId)) {
    activeQuestionId = items[0]?.id || null;
  }

  const submittedStudents = students.filter((s) => Boolean(subMap[s.id]));
  const visibleStudents = submittedStudents.filter((s) => {
    if (!onlyUngraded || !activeQuestionId) return true;
    return !subMap[s.id]?.questionGrades?.[activeQuestionId];
  });
  const activeItem = items.find((it) => it.id === activeQuestionId) || null;

  bodyEl.innerHTML = `
    <div class="asg-qgrade-wrap">
      <div class="asg-qgrade-top">
        <div class="asg-q-pills">
          ${items.map((it) => `
            <button type="button" class="asg-chip ${activeQuestionId === it.id && !editingRegions ? 'is-active' : ''}" data-q-pick="${it.id}">
              ${escapeHtml(it.label)} (${it.maxScore}점)
            </button>
          `).join('')}
          ${isWorksheet ? `
            <button type="button" class="asg-btn is-outline is-sm" id="btn-toggle-region-edit">
              ${editingRegions ? '✓ 영역 지정 완료 (채점하기)' : '✂️ 문항 영역 박스 지정'}
            </button>
          ` : ''}
        </div>
        ${!editingRegions && activeItem ? `
          <div class="asg-q-toggles">
            <label><input type="checkbox" id="chk-anon-grade" ${anonymousGrading ? 'checked' : ''}> 익명 채점</label>
            <label><input type="checkbox" id="chk-only-ungraded" ${onlyUngraded ? 'checked' : ''}> 미채점만</label>
          </div>
        ` : ''}
      </div>

      ${editingRegions && isWorksheet ? `
        <div class="asg-region-editor">
          <div class="asg-region-bar">
            <span>배경지 위에서 마우스로 드래그해 채점할 문항 영역 박스를 그리세요.</span>
            <label>배점: <input type="number" id="reg-max-score" min="1" max="100" value="10" style="width:64px;"></label>
          </div>
          <div class="asg-region-stage" id="asg-region-stage">
            <canvas id="asg-region-canvas"></canvas>
            <div class="asg-region-overlay" id="asg-region-overlay">
              ${items.map((r, i) => `
                <div class="asg-region-box" style="left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;">
                  <span>${escapeHtml(r.label)} (${r.maxScore}점)</span>
                  <button type="button" data-del-reg="${i}" title="영역 삭제">&times;</button>
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      ` : !activeItem ? `
        <div class="asg-empty"><p>채점할 문항이 없습니다.</p></div>
      ` : `
        <div class="asg-batch-bar">
          <div class="asg-batch-left">
            <button type="button" class="asg-mini-btn" id="btn-sel-all-q">전체 선택</button>
            <button type="button" class="asg-mini-btn" id="btn-sel-none-q">선택 해제</button>
            <span class="asg-batch-cnt"><strong>${selectedGradeStudentIds.size}명</strong> 선택됨</span>
          </div>
          <div class="asg-batch-actions">
            <button type="button" class="asg-grade-btn is-correct" id="btn-mark-correct">○ 정답 (${activeItem.maxScore}점)</button>
            <button type="button" class="asg-grade-btn is-wrong" id="btn-mark-wrong">× 오답 (0점)</button>
            <div class="asg-partial-group">
              <input type="number" id="inp-partial-score" min="0" max="${activeItem.maxScore}" step="0.5" value="${Math.round(activeItem.maxScore / 2)}" aria-label="부분점수">
              <button type="button" class="asg-grade-btn is-partial" id="btn-mark-partial">△ 부분점수</button>
            </div>
            <input type="text" id="inp-batch-fb" class="asg-batch-fb" placeholder="선택 학생 문항 피드백 입력...">
            <button type="button" class="asg-btn is-primary is-sm" id="btn-apply-batch-fb">피드백 적용</button>
          </div>
        </div>

        <div class="asg-crop-grid">
          ${visibleStudents.length === 0 ? `<div class="asg-empty"><p>표시할 제출 답안이 없습니다.</p></div>` : visibleStudents.map((st) => {
            const sub = subMap[st.id];
            const gr = sub?.questionGrades?.[activeItem.id];
            const isSel = selectedGradeStudentIds.has(st.id);
            const badgeCls = !gr ? '' : gr.status === 'correct' ? 'is-ok' : gr.status === 'partial' ? 'is-part' : 'is-bad';
            const badgeTxt = !gr ? '미채점' : gr.status === 'correct' ? `○ ${gr.score}점` : gr.status === 'partial' ? `△ ${gr.score}점` : '× 0점';
            return `
              <div class="asg-crop-card ${isSel ? 'is-selected' : ''}" data-grade-card="${st.id}">
                <div class="asg-crop-head">
                  <input type="checkbox" ${isSel ? 'checked' : ''} tabindex="-1">
                  <strong>${anonymousGrading ? `익명 #${st.number}` : `${st.number}번 ${escapeHtml(st.name)}`}</strong>
                  <span class="asg-crop-badge ${badgeCls}">${badgeTxt}</span>
                </div>
                ${isWorksheet ? `
                  <div class="asg-crop-canvas-wrap">
                    <canvas class="asg-crop-canvas" data-crop-st="${st.id}"></canvas>
                  </div>
                ` : `
                  <div class="asg-crop-quiz-ans">
                    ${escapeHtml(String(sub?.quizAnswers?.[activeItem.id] ?? '(미응답)'))}
                  </div>
                `}
                <div class="asg-crop-fb-row">
                  <input type="text" class="asg-indiv-fb" data-indiv-fb="${st.id}" value="${escapeAttr(gr?.feedback || '')}" placeholder="개별 피드백 입력 후 Enter...">
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `}
    </div>
  `;

  bodyEl.querySelectorAll('[data-q-pick]').forEach((b) => {
    b.onclick = () => {
      editingRegions = false;
      activeQuestionId = b.dataset.qPick;
      selectedGradeStudentIds.clear();
      renderByQuestionGradingTab(bodyEl, asg, students, subMap, rerender);
    };
  });

  const regToggle = bodyEl.querySelector('#btn-toggle-region-edit');
  if (regToggle) {
    regToggle.onclick = () => {
      editingRegions = !editingRegions;
      renderByQuestionGradingTab(bodyEl, asg, students, subMap, rerender);
    };
  }

  // 영역 박스 드래그 지정 에디터
  if (editingRegions && isWorksheet) {
    const cvs = bodyEl.querySelector('#asg-region-canvas');
    renderWorksheetComposite(cvs, asg.template, null);
    const overlay = bodyEl.querySelector('#asg-region-overlay');

    overlay.querySelectorAll('[data-del-reg]').forEach((b) => {
      b.onclick = async (ev) => {
        ev.stopPropagation();
        await store.update((s) => {
          const target = s.assignments.find((x) => x.id === asg.id);
          if (target?.regions) target.regions.splice(Number(b.dataset.delReg), 1);
        });
        await syncIfConnected();
        rerender();
      };
    });

    let dragStart = null;
    let draftEl = null;

    overlay.onpointerdown = (ev) => {
      if (ev.target.closest('button')) return;
      const rect = overlay.getBoundingClientRect();
      dragStart = {
        x: Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)),
      };
      draftEl = document.createElement('div');
      draftEl.className = 'asg-region-box is-draft';
      overlay.appendChild(draftEl);
      overlay.setPointerCapture(ev.pointerId);
    };

    overlay.onpointermove = (ev) => {
      if (!dragStart || !draftEl) return;
      const rect = overlay.getBoundingClientRect();
      const cx = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const cy = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      const x = Math.min(dragStart.x, cx);
      const y = Math.min(dragStart.y, cy);
      const w = Math.abs(cx - dragStart.x);
      const h = Math.abs(cy - dragStart.y);
      draftEl.style.left = `${x * 100}%`;
      draftEl.style.top = `${y * 100}%`;
      draftEl.style.width = `${w * 100}%`;
      draftEl.style.height = `${h * 100}%`;
    };

    overlay.onpointerup = async (ev) => {
      if (!dragStart) return;
      const rect = overlay.getBoundingClientRect();
      const cx = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const cy = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      const x = Math.min(dragStart.x, cx);
      const y = Math.min(dragStart.y, cy);
      const w = Math.abs(cx - dragStart.x);
      const h = Math.abs(cy - dragStart.y);
      dragStart = null;
      if (draftEl) draftEl.remove();
      draftEl = null;

      if (w < 0.03 || h < 0.03) return;
      const maxScore = Math.max(1, Number(bodyEl.querySelector('#reg-max-score')?.value) || 10);
      await store.update((s) => {
        const target = s.assignments.find((x) => x.id === asg.id);
        if (!target) return;
        if (!Array.isArray(target.regions)) target.regions = [];
        const num = target.regions.length + 1;
        target.regions.push({
          id: uid('reg'),
          label: `${num}번 문항`,
          maxScore,
          x: Number(x.toFixed(4)),
          y: Number(y.toFixed(4)),
          w: Number(w.toFixed(4)),
          h: Number(h.toFixed(4)),
        });
      });
      await syncIfConnected();
      playSound('confirm');
      rerender();
    };
    return;
  }

  if (!activeItem) return;

  // 각 학생의 크롭 영역 비동기 렌더링 (배경지 + 학생 답변 합성 후 박스 크롭)
  if (isWorksheet) {
    bodyEl.querySelectorAll('[data-crop-st]').forEach((cvs) => {
      const sid = cvs.dataset.cropSt;
      renderCroppedRegion(cvs, asg.template, subMap[sid]?.worksheetData, activeItem);
    });
  }

  const anonChk = bodyEl.querySelector('#chk-anon-grade');
  if (anonChk) anonChk.onchange = () => { anonymousGrading = anonChk.checked; renderByQuestionGradingTab(bodyEl, asg, students, subMap, rerender); };
  const ungrChk = bodyEl.querySelector('#chk-only-ungraded');
  if (ungrChk) ungrChk.onchange = () => { onlyUngraded = ungrChk.checked; renderByQuestionGradingTab(bodyEl, asg, students, subMap, rerender); };

  bodyEl.querySelector('#btn-sel-all-q').onclick = () => {
    visibleStudents.forEach((s) => selectedGradeStudentIds.add(s.id));
    renderByQuestionGradingTab(bodyEl, asg, students, subMap, rerender);
  };
  bodyEl.querySelector('#btn-sel-none-q').onclick = () => {
    selectedGradeStudentIds.clear();
    renderByQuestionGradingTab(bodyEl, asg, students, subMap, rerender);
  };

  bodyEl.querySelectorAll('[data-grade-card]').forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest('input[type="text"]')) return;
      const sid = card.dataset.gradeCard;
      if (selectedGradeStudentIds.has(sid)) selectedGradeStudentIds.delete(sid);
      else selectedGradeStudentIds.add(sid);
      renderByQuestionGradingTab(bodyEl, asg, students, subMap, rerender);
    };
  });

  const applyBatchGrade = async (status, scoreVal, feedbackText = null) => {
    const ids = Array.from(selectedGradeStudentIds);
    if (ids.length === 0) {
      showToast({ title: '채점할 학생 답안을 먼저 선택해 주세요.', tone: 'minus' });
      return;
    }
    await store.update((s) => {
      for (const sid of ids) {
        const sub = s.submissions[asg.id]?.[sid];
        if (!sub) continue;
        if (!sub.questionGrades) sub.questionGrades = {};
        const prev = sub.questionGrades[activeItem.id] || {};
        sub.questionGrades[activeItem.id] = {
          status: status || prev.status || 'graded',
          score: scoreVal !== null ? scoreVal : (prev.score ?? 0),
          maxScore: activeItem.maxScore,
          feedback: feedbackText !== null ? feedbackText : (prev.feedback || ''),
        };
        sub.status = 'graded';
      }
    });
    for (const sid of ids) {
      const sub = store.getState().submissions[asg.id]?.[sid];
      if (sub) await pushSubmissionToCloud(asg.id, sid, sub);
    }
    playSound('confirm');
    showToast({ title: `${ids.length}명 문항 채점이 반영되었습니다!`, tone: 'plus' });
    selectedGradeStudentIds.clear();
    rerender();
  };

  bodyEl.querySelector('#btn-mark-correct').onclick = () => applyBatchGrade('correct', activeItem.maxScore);
  bodyEl.querySelector('#btn-mark-wrong').onclick = () => applyBatchGrade('wrong', 0);
  bodyEl.querySelector('#btn-mark-partial').onclick = () => {
    const val = Math.max(0, Math.min(activeItem.maxScore, Number(bodyEl.querySelector('#inp-partial-score').value) || 0));
    applyBatchGrade('partial', val);
  };
  bodyEl.querySelector('#btn-apply-batch-fb').onclick = () => {
    const txt = bodyEl.querySelector('#inp-batch-fb').value.trim();
    applyBatchGrade(null, null, txt);
  };

  // 개별 학생 문항 피드백 Enter 저장
  bodyEl.querySelectorAll('[data-indiv-fb]').forEach((inp) => {
    inp.onkeydown = async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const sid = inp.dataset.indivFb;
      const txt = inp.value.trim();
      await store.update((s) => {
        const sub = s.submissions[asg.id]?.[sid];
        if (!sub) return;
        if (!sub.questionGrades) sub.questionGrades = {};
        const prev = sub.questionGrades[activeItem.id] || { status: 'graded', score: 0, maxScore: activeItem.maxScore };
        sub.questionGrades[activeItem.id] = { ...prev, feedback: txt };
      });
      const sub = store.getState().submissions[asg.id]?.[sid];
      if (sub) await pushSubmissionToCloud(asg.id, sid, sub);
      playSound('confirm');
      showToast({ title: '개별 문항 피드백을 저장했습니다.', tone: 'plus' });
    };
  });
}

/** 탭 3: 실시간 퀴즈 진행 화면 */
function renderLiveQuizTab(bodyEl, asg, students, subMap, rerender) {
  const questions = asg.quiz?.questions || [];
  const live = asg.liveQuiz || { active: false, currentIndex: 0, revealAnswer: false };
  const q = questions[live.currentIndex] || questions[0];

  if (!q) {
    bodyEl.innerHTML = `<div class="asg-empty"><p>퀴즈 문항이 없습니다.</p></div>`;
    return;
  }

  const answeredList = students.filter((st) => subMap[st.id]?.quizAnswers?.[q.id] !== undefined && subMap[st.id]?.quizAnswers?.[q.id] !== '');
  const correctList = answeredList.filter((st) => subMap[st.id]?.questionGrades?.[q.id]?.status === 'correct');

  const updateLive = async (patch) => {
    await store.update((s) => {
      const target = s.assignments.find((x) => x.id === asg.id);
      if (!target) return;
      target.liveQuiz = { ...(target.liveQuiz || { active: false, currentIndex: 0, revealAnswer: false }), ...patch };
    });
    await syncIfConnected();
    rerender();
  };

  bodyEl.innerHTML = `
    <div class="asg-live-quiz">
      <div class="asg-live-controls">
        <span class="asg-status-pill ${live.active ? 'is-on' : ''}">${live.active ? '🔴 실시간 진행 중' : '대기 중'}</span>
        <strong>${live.currentIndex + 1} / ${questions.length}번 문항</strong>
        <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;">
          ${!live.active
            ? `<button type="button" class="asg-btn is-primary" id="btn-live-start">▶ 실시간 퀴즈 시작</button>`
            : `
              <button type="button" class="asg-btn is-outline" id="btn-live-prev" ${live.currentIndex <= 0 ? 'disabled' : ''}>← 이전</button>
              <button type="button" class="asg-btn is-outline" id="btn-live-reveal">${live.revealAnswer ? '정답 숨기기' : '💡 정답·해설 공개'}</button>
              <button type="button" class="asg-btn is-primary" id="btn-live-next" ${live.currentIndex >= questions.length - 1 ? 'disabled' : ''}>다음 문항 →</button>
              <button type="button" class="asg-btn is-danger-solid" id="btn-live-stop">종료</button>
            `}
        </div>
      </div>

      <div class="asg-live-question-card">
        <span class="asg-kind-badge is-quiz">${q.type === 'choice' ? '객관식' : q.type === 'ox' ? 'OX 퀴즈' : '단답형'} · ${q.points}점</span>
        <h3>${escapeHtml(q.prompt)}</h3>
        ${q.choices && q.choices.length > 0 ? `
          <div class="asg-live-choices">
            ${q.choices.map((ch, idx) => {
              const key = q.type === 'ox' ? ch : String(idx + 1);
              const pickCnt = answeredList.filter((st) => String(subMap[st.id]?.quizAnswers?.[q.id] || '').toUpperCase() === key.toUpperCase()).length;
              const isAns = live.revealAnswer && key.toUpperCase() === String(q.answer).toUpperCase();
              return `
                <div class="asg-live-choice ${isAns ? 'is-answer' : ''}">
                  <span><strong>${q.type === 'ox' ? ch : `${idx + 1}.`}</strong> ${q.type === 'ox' ? '' : escapeHtml(ch)}</span>
                  <span class="asg-live-bar-cnt">${pickCnt}명</span>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
        ${live.revealAnswer ? `
          <div class="asg-live-explain">
            <strong>정답: ${escapeHtml(q.answer)}</strong>
            ${q.explanation ? `<p>${escapeHtml(q.explanation)}</p>` : ''}
          </div>
        ` : ''}
      </div>

      <div class="asg-live-stats">
        <span>실시간 응답: <strong>${answeredList.length} / ${students.length}명</strong></span>
        ${live.revealAnswer ? `
          <span>정답자: <strong>${correctList.length}명</strong></span>
          <button type="button" class="asg-btn is-primary is-sm" id="btn-live-reward-correct" ${correctList.length === 0 ? 'disabled' : ''}>★ 이 문항 정답자 으쓱 +1점</button>
        ` : ''}
      </div>
    </div>
  `;

  const startBtn = bodyEl.querySelector('#btn-live-start');
  if (startBtn) startBtn.onclick = () => updateLive({ active: true, currentIndex: 0, revealAnswer: false });
  const prevBtn = bodyEl.querySelector('#btn-live-prev');
  if (prevBtn) prevBtn.onclick = () => updateLive({ currentIndex: Math.max(0, live.currentIndex - 1), revealAnswer: false });
  const nextBtn = bodyEl.querySelector('#btn-live-next');
  if (nextBtn) nextBtn.onclick = () => updateLive({ currentIndex: Math.min(questions.length - 1, live.currentIndex + 1), revealAnswer: false });
  const revBtn = bodyEl.querySelector('#btn-live-reveal');
  if (revBtn) revBtn.onclick = () => updateLive({ revealAnswer: !live.revealAnswer });
  const stopBtn = bodyEl.querySelector('#btn-live-stop');
  if (stopBtn) stopBtn.onclick = () => updateLive({ active: false });

  const rewBtn = bodyEl.querySelector('#btn-live-reward-correct');
  if (rewBtn) {
    rewBtn.onclick = async () => {
      if (correctList.length === 0) return;
      const outcome = await applyStudentScoreBatch({
        studentIds: correctList.map((s) => s.id),
        delta: 1,
        reason: `퀴즈 ${q.number}번 정답`,
      });
      presentOutcome(outcome);
    };
  }
}

// ============================================================
// 4. 관리페이지 전용: 서버(Firebase) · 구글 드라이브 연결 설정 모달
// ============================================================
export function openCloudDriveSettingsModal(onUpdated) {
  const state = store.getState();
  const cfg = state.cloudConfig || {};
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  backdrop.innerHTML = `
    <div class="dialog-card is-wide">
      <div class="dialog-header">
        <h2>☁️ 서버(Firebase) · 📁 구글 드라이브 연결 설정</h2>
        <button type="button" class="dialog-close">&times;</button>
      </div>
      <div class="dialog-body" style="max-height:76vh;overflow-y:auto;">
        <div class="asg-subpanel">
          <h4>1. 서버(Firebase) 연결 — 관리페이지에서만 설정하면 학생페이지 자동 접속</h4>
          <p class="asg-hint">기존 만능칠판과 데이터는 100% 분리(<code>cr2Classes</code> 컬렉션)됩니다. 연결 후 생성되는 <strong>학생 접속 링크</strong>를 배포하면 학생은 서버 설정 없이 바로 로그인합니다.</p>
          <textarea id="cfg-fb-json" rows="4" placeholder='Firebase 웹 앱 설정(firebaseConfig)을 붙여넣으세요. 예: {"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}'>${cfg.firebaseConfig ? escapeHtml(JSON.stringify(cfg.firebaseConfig, null, 2)) : ''}</textarea>
          <div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap;">
            <button type="button" class="asg-btn is-primary is-sm" id="btn-fb-connect">${isCloudConnected() ? '서버 설정 변경/재연결' : '서버 연결하기'}</button>
            ${isCloudConnected() ? `<button type="button" class="asg-btn is-danger-solid is-sm" id="btn-fb-disconnect">연결 해제</button>` : ''}
            <span class="asg-hint" style="margin:0;">상태: <strong>${isCloudConnected() ? `연결됨 (학급ID: ${escapeHtml(cfg.classId)})` : '로컬 모드'}</strong></span>
          </div>
        </div>

        <div class="asg-subpanel" style="margin-top:12px;">
          <h4>2. 구글 드라이브 연결 — 대용량 사진/파일 자동 저장 (언제든 변경 가능)</h4>
          <p class="asg-hint">
            1) 아래 <strong>[Apps Script 코드 복사]</strong> → <a href="https://script.google.com" target="_blank" rel="noopener noreferrer">script.google.com</a> 새 프로젝트에 붙여넣기 → <strong>[배포 → 새 배포 → 웹 앱 (액세스: 모든 사용자)]</strong><br>
            2) 발급된 웹 앱 URL을 아래에 붙여넣고 저장하면 학생 페이지에도 자동 적용됩니다.
          </p>
          <div style="margin-bottom:8px;">
            <button type="button" class="asg-btn is-outline is-sm" id="btn-copy-gas">📋 Google Apps Script 코드 복사</button>
          </div>
          <div class="field-row">
            <label class="field-label" style="flex:2;">
              <span>구글 드라이브 웹 앱 URL</span>
              <input type="url" id="cfg-drive-url" value="${escapeAttr(cfg.driveBridgeUrl || '')}" placeholder="https://script.google.com/macros/s/.../exec">
            </label>
            <label class="field-label" style="flex:1;">
              <span>저장 폴더명</span>
              <input type="text" id="cfg-drive-folder" value="${escapeAttr(cfg.driveFolderName || '클래스레볼루션2')}" placeholder="클래스레볼루션2">
            </label>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button type="button" class="asg-btn is-outline is-sm" id="btn-drive-test">🔍 연결 테스트</button>
            <button type="button" class="asg-btn is-primary is-sm" id="btn-drive-save">드라이브 설정 저장</button>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn-ghost" data-close>닫기</button>
      </div>
    </div>
  `;

  modalRoot.appendChild(backdrop);
  backdrop.querySelector('.dialog-close').onclick = close;
  backdrop.querySelector('[data-close]').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  backdrop.querySelector('#btn-fb-connect').onclick = async () => {
    try {
      const parsed = parseFirebaseConfig(backdrop.querySelector('#cfg-fb-json').value);
      const classId = await connectTeacherCloud(parsed, cfg.classId || '', {
        onRemoteSubmissions: (grouped) => mergeRemoteSubmissions(grouped),
      });
      await store.update((s) => {
        s.cloudConfig.firebaseConfig = parsed;
        s.cloudConfig.classId = classId;
      });
      await syncTeacherStateToCloud(store.getState());
      playSound('confirm');
      showToast({ title: '서버(Firebase)에 연결되었습니다!', tone: 'plus' });
      close();
      if (typeof onUpdated === 'function') onUpdated();
    } catch (err) {
      showToast({ title: '서버 연결 실패', detail: err.message, tone: 'minus' });
    }
  };

  const discBtn = backdrop.querySelector('#btn-fb-disconnect');
  if (discBtn) {
    discBtn.onclick = async () => {
      if (!confirm('서버 연결을 해제하고 로컬 모드로 전환할까요?')) return;
      disconnectCloud();
      await store.update((s) => {
        s.cloudConfig.firebaseConfig = null;
      });
      showToast({ title: '서버 연결이 해제되었습니다.' });
      close();
      if (typeof onUpdated === 'function') onUpdated();
    };
  }

  backdrop.querySelector('#btn-copy-gas').onclick = async () => {
    try {
      await navigator.clipboard.writeText(GOOGLE_APPS_SCRIPT_TEMPLATE);
      showToast({ title: 'Google Apps Script 코드를 복사했습니다!', tone: 'plus' });
    } catch {
      prompt('아래 코드를 복사해 script.google.com에 붙여넣으세요:', GOOGLE_APPS_SCRIPT_TEMPLATE);
    }
  };

  backdrop.querySelector('#btn-drive-test').onclick = async () => {
    const url = backdrop.querySelector('#cfg-drive-url').value.trim();
    const folder = backdrop.querySelector('#cfg-drive-folder').value.trim() || '클래스레볼루션2';
    try {
      showToast({ title: '구글 드라이브 연결 테스트 중...' });
      const res = await testDriveBridge(url, folder);
      playSound('confirm');
      showToast({ title: `구글 드라이브 '${res.folderName}' 폴더 연결 성공!`, tone: 'plus' });
    } catch (err) {
      showToast({ title: '드라이브 연결 실패', detail: err.message, tone: 'minus' });
    }
  };

  backdrop.querySelector('#btn-drive-save').onclick = async () => {
    const url = backdrop.querySelector('#cfg-drive-url').value.trim();
    const folder = backdrop.querySelector('#cfg-drive-folder').value.trim() || '클래스레볼루션2';
    await store.update((s) => {
      s.cloudConfig.driveBridgeUrl = url;
      s.cloudConfig.driveFolderName = folder;
    });
    await syncIfConnected();
    playSound('confirm');
    showToast({ title: '구글 드라이브 설정이 저장되었습니다!', tone: 'plus' });
    if (typeof onUpdated === 'function') onUpdated();
  };
}

/** 학생 전용 접속 링크 안내 모달 */
function openStudentLinkModal() {
  const state = store.getState();
  const cfg = state.cloudConfig || {};
  const studentUrl = buildStudentConnectUrl(cfg.firebaseConfig, cfg.classId, location.href);
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  backdrop.innerHTML = `
    <div class="dialog-card">
      <div class="dialog-header">
        <h2>🔗 학생 전용 과제 접속 주소</h2>
        <button type="button" class="dialog-close">&times;</button>
      </div>
      <div class="dialog-body">
        <p class="asg-hint">
          ${cfg.firebaseConfig
            ? '이 링크로 접속한 학생 기기는 <strong>관리페이지 서버에 자동 연결</strong>되며, 아이디와 비밀번호만 입력해 로그인합니다.'
            : '현재 <strong>로컬 모드</strong>입니다. 같은 컴퓨터 브라우저 테스트용으로 바로 열어볼 수 있으며, 다른 기기 학생 접속을 위해 [서버·드라이브 설정]에서 Firebase를 연결해 주세요.'}
        </p>
        <textarea id="asg-student-url-box" rows="3" readonly style="font-size:12px;">${escapeHtml(studentUrl)}</textarea>
        <div style="display:flex;gap:8px;margin-top:10px;">
          <button type="button" class="asg-btn is-primary" id="btn-copy-st-url">📋 접속 링크 복사</button>
          <a class="asg-btn is-outline" href="${escapeAttr(studentUrl)}" target="_blank" rel="noopener noreferrer">새 탭으로 미리보기</a>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn-ghost" data-close>닫기</button>
      </div>
    </div>
  `;

  modalRoot.appendChild(backdrop);
  backdrop.querySelector('.dialog-close').onclick = close;
  backdrop.querySelector('[data-close]').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  backdrop.querySelector('#btn-copy-st-url').onclick = async () => {
    try {
      await navigator.clipboard.writeText(studentUrl);
      playSound('confirm');
      showToast({ title: '학생 접속 링크를 복사했습니다!', tone: 'plus' });
    } catch {
      backdrop.querySelector('#asg-student-url-box').select();
    }
  };
}

/** 원격 Firestore 제출물을 로컬 스토어에 안전 병합 */
export async function mergeRemoteSubmissions(grouped) {
  if (!grouped || typeof grouped !== 'object') return;
  await store.update((s) => {
    if (!s.submissions) s.submissions = {};
    for (const [asgId, stMap] of Object.entries(grouped)) {
      if (!s.submissions[asgId]) s.submissions[asgId] = {};
      for (const [stId, remoteSub] of Object.entries(stMap)) {
        const local = s.submissions[asgId][stId];
        if (!local || (remoteSub.updatedAt || 0) >= (local.updatedAt || 0)) {
          s.submissions[asgId][stId] = remoteSub;
        }
      }
    }
  });
}

/** 앱 시작 시 저장된 Firebase 연결이 있으면 자동 복원 */
export async function initTeacherCloudAutoConnect() {
  const cfg = store.getState().cloudConfig;
  if (!cfg?.firebaseConfig || !cfg?.classId) return;
  try {
    await connectTeacherCloud(cfg.firebaseConfig, cfg.classId, {
      onRemoteSubmissions: (grouped) => mergeRemoteSubmissions(grouped),
    });
    await syncTeacherStateToCloud(store.getState());
  } catch (err) {
    console.warn('[CR2 Cloud] auto-connect skipped:', err);
  }
}
