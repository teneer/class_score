// 학생용 별도 접속 페이지 (관리페이지 종속 자동 서버 접속 · ID/PW 로그인 · 워크시트 경량 답변 제출 · 구글드라이브 사진 제출/열람/다운로드 · AI 퀴즈 개인/실시간 풀이)

import { store, getStillAvatarUrl, todayIso } from './store.js';
import { gradeQuizSubmission } from './quiz-csv.js';
import { mountWorksheetEditor, renderWorksheetComposite } from './worksheet-renderer.js';
import {
  parseStudentConnectHash,
  connectStudentCloud,
  uploadFileToDrive,
} from './cloud-sync.js';

const SERVER_CACHE_KEY = 'cr2_student_server_v1';
const SESSION_KEY = 'cr2_student_session_v1';

let dataMode = 'local'; // 'cloud' | 'local'
let cloudClient = null;
let classData = {
  className: '우리 반',
  driveBridgeUrl: '',
  driveFolderName: '클래스레볼루션2',
  students: [],
  assignments: [],
  selfChecks: [],
};
let allSubmissions = {}; // { [assignmentId]: { [studentId]: Submission } }
let loggedStudentId = null;
let activeTab = 'todo'; // 'todo' | 'quests' | 'done' | 'gallery'
let activeAssignmentId = null;
let activeWorksheetCtrl = null;
let draftFiles = [];
let draftQuizAnswers = {};
let loginError = '';

const appEl = document.getElementById('student-app');
const toastEl = document.getElementById('st-toast');
let toastTimer = null;

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showStToast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2800);
}

function loadSavedServer() {
  try { return JSON.parse(localStorage.getItem(SERVER_CACHE_KEY) || 'null'); } catch { return null; }
}
function saveServer(info) {
  try { localStorage.setItem(SERVER_CACHE_KEY, JSON.stringify(info)); } catch {}
}
function loadSavedSession() {
  try { return localStorage.getItem(SESSION_KEY) || null; } catch { return null; }
}
function saveSession(studentId) {
  try {
    if (studentId) localStorage.setItem(SESSION_KEY, studentId);
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}

/** 학생 제출물 저장 (클라우드 모드면 Firestore, 로컬 모드면 IndexedDB) */
async function persistSubmission(assignmentId, studentId, submission) {
  if (dataMode === 'cloud' && cloudClient) {
    await cloudClient.saveSubmission(assignmentId, studentId, submission);
  } else {
    await store.update((s) => {
      if (!s.submissions) s.submissions = {};
      if (!s.submissions[assignmentId]) s.submissions[assignmentId] = {};
      s.submissions[assignmentId][studentId] = submission;
    });
    allSubmissions = store.getState().submissions || {};
  }
}

/** 학생 셀프 체크표(퀘스트) 저장 (클라우드/로컬 양쪽 지원 + 체크표 자동 연동) */
async function persistSelfCheck(checkId, studentId, value) {
  if (dataMode === 'cloud' && cloudClient) {
    // UI 즉시 반영
    const target = (classData.selfChecks || []).find((c) => c.id === checkId);
    if (target) {
      if (!target.entries) target.entries = {};
      target.entries[studentId] = value;
    }
    await cloudClient.saveSelfCheckEntry(checkId, studentId, value);
  } else {
    const today = todayIso();
    await store.update((s) => {
      const target = (s.selfChecks || []).find((c) => c.id === checkId);
      if (!target) return;
      if (!target.entries) target.entries = {};
      target.entries[studentId] = value;
      if (target.linkedChecklistItemId) {
        if (!s.checklist.entriesByDate[today]) s.checklist.entriesByDate[today] = {};
        s.checklist.entriesByDate[today][`${studentId}::${target.linkedChecklistItemId}`] =
          target.mode === 'count' ? (Number(value) > 0 ? String(value) : '') : Boolean(value);
      }
    });
  }
}

function getCurrentStudent() {
  return (classData.students || []).find((s) => s.id === loggedStudentId) || null;
}

function render() {
  const me = getCurrentStudent();
  if (!me) {
    renderLogin();
    return;
  }
  if (activeAssignmentId) {
    const asg = (classData.assignments || []).find((a) => a.id === activeAssignmentId);
    if (asg) {
      renderAssignmentWork(me, asg);
      return;
    }
    activeAssignmentId = null;
  }
  renderHome(me);
}

function renderLogin() {
  appEl.innerHTML = `
    <form class="st-login-wrap" id="st-login-form">
      <span class="st-login-badge">${dataMode === 'cloud' ? '☁️ 학급 서버 자동 연결됨' : '💻 로컬 테스트 모드'}</span>
      <h1>${esc(classData.className || '클래스레볼루션2')}</h1>
      <p class="st-login-sub">선생님이 알려주신 아이디와 비밀번호를 입력해 로그인하세요.</p>
      ${loginError ? `<p class="st-error">${esc(loginError)}</p>` : ''}
      <label class="st-field">
        <span>아이디</span>
        <input type="text" name="loginId" autocomplete="username" placeholder="예: s01" required autofocus>
      </label>
      <label class="st-field">
        <span>비밀번호</span>
        <input type="password" name="loginPw" autocomplete="current-password" placeholder="비밀번호 입력" required>
      </label>
      <button type="submit" class="st-btn is-primary">로그인</button>
    </form>
  `;

  appEl.querySelector('#st-login-form').onsubmit = (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const idIn = String(fd.get('loginId') || '').trim().toLowerCase();
    const pwIn = String(fd.get('loginPw') || '').trim();
    const found = (classData.students || []).find(
      (s) => !s.trashed && String(s.loginId || '').trim().toLowerCase() === idIn
    );
    if (!found) {
      loginError = '등록되지 않은 아이디입니다. 선생님께 확인해 주세요.';
      renderLogin();
      return;
    }
    if (found.loginEnabled === false) {
      loginError = '현재 접속이 제한된 계정입니다. 선생님께 문의해 주세요.';
      renderLogin();
      return;
    }
    if (String(found.loginPw ?? '') !== pwIn) {
      loginError = '비밀번호가 일치하지 않습니다.';
      renderLogin();
      return;
    }
    loginError = '';
    loggedStudentId = found.id;
    saveSession(found.id);
    showStToast(`${found.name} 학생, 반가워요!`);
    render();
  };
}

function renderHeader(me) {
  return `
    <header class="st-header">
      <div class="st-profile">
        <img class="st-avatar" src="${getStillAvatarUrl(me.avatarId)}" alt="${esc(me.name)}">
        <div class="st-profile-info">
          <strong>${me.number}번 ${esc(me.name)}</strong>
          <span>${esc(classData.className || '우리 반')}</span>
        </div>
      </div>
      <div class="st-score-pills">
        <span class="st-pill is-net">쑥쑥 ${me.score ?? 0}점</span>
        <span class="st-pill is-pos">으쓱 +${me.positive ?? 0}</span>
        <span class="st-pill is-neg">머쓱 -${me.negative ?? 0}</span>
        <button type="button" class="st-btn is-outline is-sm" id="st-btn-logout">로그아웃</button>
      </div>
    </header>
  `;
}

function renderHome(me) {
  // 본인에게 배정된 과제만 필터링 (targetStudentIds가 없거나 비어있으면 학급 전체 대상)
  const assignments = [...(classData.assignments || [])]
    .filter((a) => !Array.isArray(a.targetStudentIds) || a.targetStudentIds.length === 0 || a.targetStudentIds.includes(me.id))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const todoList = assignments.filter((a) => {
    const sub = allSubmissions[a.id]?.[me.id];
    return !sub || sub.status === 'redo';
  });
  const doneList = assignments.filter((a) => {
    const sub = allSubmissions[a.id]?.[me.id];
    return Boolean(sub) && sub.status !== 'redo';
  });
  const galleryList = assignments.filter((a) => a.visibility === 'shared');

  // 본인에게 배정된 태블릿 퀘스트(셀프 체크표)만 표시 (자기 것만)
  const myQuests = [...(classData.selfChecks || [])]
    .filter((sc) => sc.sendToTablet !== false)
    .filter((sc) => !Array.isArray(sc.targetStudentIds) || sc.targetStudentIds.length === 0 || sc.targetStudentIds.includes(me.id))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const list = activeTab === 'todo' ? todoList : activeTab === 'done' ? doneList : galleryList;

  appEl.innerHTML = `
    ${renderHeader(me)}
    <main class="st-main">
      <div class="st-tabs">
        <button type="button" class="st-tab ${activeTab === 'todo' ? 'is-active' : ''}" data-st-tab="todo">할 과제 (${todoList.length})</button>
        <button type="button" class="st-tab ${activeTab === 'quests' ? 'is-active' : ''}" data-st-tab="quests">🎯 내 퀘스트 (${myQuests.length})</button>
        <button type="button" class="st-tab ${activeTab === 'done' ? 'is-active' : ''}" data-st-tab="done">제출한 과제 (${doneList.length})</button>
        <button type="button" class="st-tab ${activeTab === 'gallery' ? 'is-active' : ''}" data-st-tab="gallery">친구 작품 (${galleryList.length})</button>
      </div>

      ${activeTab === 'quests' ? (
        myQuests.length === 0 ? `
          <div class="st-work-card" style="text-align:center;color:#7d7465;padding:38px 20px;">
            🎯 현재 진행 중인 내 퀘스트가 없습니다.
          </div>
        ` : `
          <div class="st-card-grid">
            ${myQuests.map((sc) => {
              const isCount = sc.mode === 'count';
              const targetCnt = Math.max(1, Number(sc.targetCount) || 1);
              const raw = sc.entries?.[me.id];
              const cnt = Number(raw || 0);
              const done = isCount ? cnt >= targetCnt : Boolean(raw);
              const pct = isCount ? Math.min(100, Math.round((cnt / targetCnt) * 100)) : (done ? 100 : 0);
              return `
                <article class="st-card" style="border-color:${done ? '#2ca978' : '#e0dacb'};background:${done ? '#f0fbf5' : '#fff'};cursor:default;">
                  <div class="st-card-meta">
                    <span>${isCount ? `🎯 목표 ${targetCnt}회 퀘스트` : '☑️ 셀프 체크 퀘스트'}</span>
                    <span class="st-badge ${done ? 'is-graded' : 'is-todo'}">${done ? '✓ 완료!' : isCount ? `${cnt} / ${targetCnt}회` : '미완료'}</span>
                  </div>
                  <h3 style="margin:6px 0 10px;font-size:18px;">${esc(sc.title)}</h3>
                  ${isCount ? `
                    <div style="height:10px;border-radius:999px;background:#e6dfd0;overflow:hidden;margin-bottom:12px;">
                      <div style="width:${pct}%;height:100%;background:${done ? '#2ca978' : '#2b8be0'};transition:width 0.2s;"></div>
                    </div>
                    <div style="display:flex;gap:8px;">
                      <button type="button" class="st-btn is-outline is-sm" data-q-dec="${sc.id}" ${cnt <= 0 ? 'disabled' : ''}>-1</button>
                      <button type="button" class="st-btn is-primary" style="flex:1;" data-q-inc="${sc.id}">
                        ${done ? `🎉 목표 달성 (${cnt}/${targetCnt}회)` : `+1 체크하기 (${cnt}/${targetCnt}회)`}
                      </button>
                    </div>
                  ` : `
                    <button type="button" class="st-btn ${done ? 'is-outline' : 'is-primary'}" style="width:100%;padding:12px;font-size:15px;" data-q-toggle="${sc.id}">
                      ${done ? '✓ 완료됨 (누르면 취소)' : '☑️ 완료 체크하기'}
                    </button>
                  `}
                </article>
              `;
            }).join('')}
          </div>
        `
      ) : list.length === 0 ? `
        <div class="st-work-card" style="text-align:center;color:#7d7465;padding:38px 20px;">
          ${activeTab === 'todo' ? '🎉 밀린 과제가 없습니다!' : activeTab === 'done' ? '아직 제출한 과제가 없습니다.' : '공유된 친구 작품 과제가 없습니다.'}
        </div>
      ` : `
        <div class="st-card-grid">
          ${list.map((a) => {
            const sub = allSubmissions[a.id]?.[me.id];
            const bCls = !sub ? 'is-todo' : sub.status === 'redo' ? 'is-redo' : sub.status === 'graded' ? 'is-graded' : 'is-sub';
            const bTxt = !sub ? '미제출' : sub.status === 'redo' ? '다시제출 요청' : sub.status === 'graded' ? '채점완료' : '제출완료';
            const kindTxt = a.kind === 'worksheet' ? '📝 워크시트' : a.kind === 'quiz' ? (a.liveQuiz?.active ? '🔴 실시간 퀴즈' : '⚡ 퀴즈') : '📎 일반과제';
            return `
              <article class="st-card" data-open-work="${a.id}">
                <div class="st-card-meta">
                  <span>${kindTxt}${a.subject ? ` · ${esc(a.subject)}` : ''}</span>
                  <span class="st-badge ${bCls}">${bTxt}</span>
                </div>
                <h3>${esc(a.title)}</h3>
                <p>${esc(a.description || '과제를 눌러 내용을 확인하세요.')}</p>
                <div class="st-card-meta">
                  <span>${a.dueDate ? `마감: ${esc(a.dueDate)}` : '마감 없음'}</span>
                  ${sub?.feedback ? `<span style="color:#198bd2;">💬 피드백 도착</span>` : ''}
                </div>
              </article>
            `;
          }).join('')}
        </div>
      `}
    </main>
  `;

  appEl.querySelector('#st-btn-logout').onclick = () => {
    loggedStudentId = null;
    activeAssignmentId = null;
    saveSession(null);
    render();
  };
  appEl.querySelectorAll('[data-st-tab]').forEach((b) => {
    b.onclick = () => { activeTab = b.dataset.stTab; renderHome(me); };
  });
  appEl.querySelectorAll('[data-q-toggle]').forEach((b) => {
    b.onclick = async () => {
      const sc = myQuests.find((x) => x.id === b.dataset.qToggle);
      if (!sc) return;
      const next = !Boolean(sc.entries?.[me.id]);
      await persistSelfCheck(sc.id, me.id, next);
      showStToast(next ? `✓ '${sc.title}' 완료 체크!` : `'${sc.title}' 체크를 취소했습니다.`);
      renderHome(me);
    };
  });
  appEl.querySelectorAll('[data-q-inc]').forEach((b) => {
    b.onclick = async () => {
      const sc = myQuests.find((x) => x.id === b.dataset.qInc);
      if (!sc) return;
      const targetCnt = Math.max(1, Number(sc.targetCount) || 1);
      const cur = Number(sc.entries?.[me.id] || 0);
      const next = cur >= targetCnt ? targetCnt : cur + 1;
      await persistSelfCheck(sc.id, me.id, next);
      showStToast(next >= targetCnt ? `🎉 '${sc.title}' 목표 달성!` : `'${sc.title}' ${next}/${targetCnt}회 체크!`);
      renderHome(me);
    };
  });
  appEl.querySelectorAll('[data-q-dec]').forEach((b) => {
    b.onclick = async () => {
      const sc = myQuests.find((x) => x.id === b.dataset.qDec);
      if (!sc) return;
      const cur = Number(sc.entries?.[me.id] || 0);
      const next = Math.max(0, cur - 1);
      await persistSelfCheck(sc.id, me.id, next);
      renderHome(me);
    };
  });
  appEl.querySelectorAll('[data-open-work]').forEach((card) => {
    card.onclick = () => {
      activeAssignmentId = card.dataset.openWork;
      const existingSub = allSubmissions[activeAssignmentId]?.[me.id];
      draftFiles = Array.isArray(existingSub?.files) ? structuredClone(existingSub.files) : [];
      draftQuizAnswers = existingSub?.quizAnswers ? structuredClone(existingSub.quizAnswers) : {};
      render();
    };
  });
}

function renderAssignmentWork(me, asg) {
  const existingSub = allSubmissions[asg.id]?.[me.id] || null;
  const isGalleryView = activeTab === 'gallery' && asg.visibility === 'shared';
  const locked = Boolean(asg.closed) || (existingSub?.status === 'graded');
  const canAttachPhoto = asg.kind === 'general' || Boolean(asg.allowedTools?.photo);

  // 문항별 채점 요약
  const grades = existingSub?.questionGrades ? Object.entries(existingSub.questionGrades) : [];
  const totalScore = grades.reduce((sum, [, g]) => sum + (Number(g.score) || 0), 0);
  const maxScore = grades.reduce((sum, [, g]) => sum + (Number(g.maxScore) || 0), 0);

  appEl.innerHTML = `
    ${renderHeader(me)}
    <main class="st-main">
      <div class="st-work-card">
        <div class="st-work-head">
          <button type="button" class="st-btn is-outline is-sm" id="st-btn-back">← 과제 목록</button>
          <h2>${esc(asg.title)}</h2>
          <span class="st-badge ${!existingSub ? 'is-todo' : existingSub.status === 'redo' ? 'is-redo' : existingSub.status === 'graded' ? 'is-graded' : 'is-sub'}">
            ${!existingSub ? '미제출' : existingSub.status === 'redo' ? '다시제출 요청' : existingSub.status === 'graded' ? '채점완료' : '제출완료'}
          </span>
        </div>

        ${asg.description ? `<p style="margin:0;font-size:14px;line-height:1.55;color:#4f4638;">${esc(asg.description).replace(/\n/g, '<br>')}</p>` : ''}

        ${existingSub && (existingSub.feedback || grades.length > 0) ? `
          <div class="st-teacher-fb">
            ${grades.length > 0 ? `<div><strong>채점 점수: ${totalScore} / ${maxScore}점</strong></div>` : ''}
            ${existingSub.feedback ? `<div>💬 선생님 피드백: ${esc(existingSub.feedback)}</div>` : ''}
            ${grades.filter(([, g]) => g.feedback).map(([qid, g]) => `
              <div style="font-size:12.5px;margin-top:4px;">· 문항(${esc(qid)}): ${esc(g.feedback)} (${g.score}/${g.maxScore}점)</div>
            `).join('')}
          </div>
        ` : ''}

        ${isGalleryView ? renderSharedGalleryHtml(asg) : ''}

        ${!isGalleryView && asg.kind === 'worksheet' ? `
          <div>
            <div style="font-size:12.5px;font-weight:700;color:#6f6658;margin-bottom:6px;">
              배경지 위에 허용된 도구로 직접 작성하세요. 제출 시 배경지 없이 내 답변만 빠르게 전송됩니다.
            </div>
            <div id="st-ws-host"></div>
          </div>
        ` : ''}

        ${!isGalleryView && asg.kind === 'quiz' ? renderQuizWorkHtml(asg, existingSub, locked) : ''}

        ${!isGalleryView && asg.kind === 'general' ? `
          <label class="st-field">
            <span>과제 작성 내용</span>
            <textarea id="st-general-text" rows="5" ${locked ? 'readonly' : ''} placeholder="여기에 과제 내용을 작성하세요.">${esc(existingSub?.text || '')}</textarea>
          </label>
          <label class="st-field">
            <span>링크 제출 (선택)</span>
            <input type="url" id="st-general-link" value="${esc(existingSub?.link || '')}" ${locked ? 'readonly' : ''} placeholder="https://...">
          </label>
        ` : ''}

        ${!isGalleryView && canAttachPhoto ? `
          <div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
              <strong style="font-size:13.5px;">📷 사진 · 파일 첨부 (${draftFiles.length}개)</strong>
              ${!locked ? `
                <label class="st-btn is-outline is-sm" style="cursor:pointer;">
                  + 사진/파일 올리기
                  <input type="file" id="st-file-upload" accept="image/*,.pdf,.doc,.docx,.hwp,.ppt,.pptx" hidden>
                </label>
              ` : ''}
            </div>
            ${draftFiles.length > 0 ? `
              <div class="st-files-grid">
                ${draftFiles.map((f, idx) => `
                  <div class="st-file-card">
                    ${f.mimeType?.startsWith('image/') ? `<img src="${esc(f.thumbnailUrl || f.viewUrl)}" alt="${esc(f.name)}">` : `<div style="height:100px;display:grid;place-items:center;font-size:30px;">📄</div>`}
                    <span title="${esc(f.name)}">${esc(f.name)}</span>
                    <div class="st-file-links">
                      <a href="${esc(f.viewUrl)}" target="_blank" rel="noopener noreferrer">열람</a>
                      <a href="${esc(f.downloadUrl || f.viewUrl)}" download="${esc(f.name)}" target="_blank" rel="noopener noreferrer">다운로드</a>
                      ${!locked ? `<button type="button" data-rm-file="${idx}" style="margin-left:auto;background:none;color:#c92646;font-weight:800;">삭제</button>` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
            ` : `<p style="margin:0;font-size:12.5px;color:#8a8072;">첨부된 파일이 없습니다.</p>`}
          </div>
        ` : ''}

        ${!isGalleryView && !locked ? `
          <div style="display:flex;justify-content:flex-end;gap:10px;padding-top:8px;border-top:1px solid #f0ede3;">
            <button type="button" class="st-btn is-primary" id="st-btn-submit">
              ${existingSub ? '수정하여 다시 제출하기' : '과제 제출하기'}
            </button>
          </div>
        ` : ''}
      </div>
    </main>
  `;

  appEl.querySelector('#st-btn-logout').onclick = () => {
    loggedStudentId = null;
    activeAssignmentId = null;
    saveSession(null);
    render();
  };
  appEl.querySelector('#st-btn-back').onclick = () => {
    activeAssignmentId = null;
    activeWorksheetCtrl = null;
    render();
  };

  if (isGalleryView) {
    appEl.querySelectorAll('[data-gal-canvas]').forEach((cvs) => {
      const sid = cvs.dataset.galCanvas;
      const sub = allSubmissions[asg.id]?.[sid];
      if (sub) renderWorksheetComposite(cvs, asg.template, sub.worksheetData);
    });
    return;
  }

  // 워크시트 에디터 마운트
  if (asg.kind === 'worksheet') {
    const wsHost = appEl.querySelector('#st-ws-host');
    if (wsHost) {
      activeWorksheetCtrl = mountWorksheetEditor(wsHost, {
        template: asg.template,
        allowedTools: asg.allowedTools,
        initialAnswer: existingSub?.worksheetData || null,
        readOnly: locked,
      });
    }
  }

  // 퀴즈 답안 바인딩
  if (asg.kind === 'quiz' && !locked) {
    appEl.querySelectorAll('[data-q-choice]').forEach((btn) => {
      btn.onclick = () => {
        const qid = btn.dataset.qid;
        draftQuizAnswers[qid] = btn.dataset.qChoice;
        renderAssignmentWork(me, asg);
      };
    });
    appEl.querySelectorAll('[data-q-short]').forEach((inp) => {
      inp.oninput = () => { draftQuizAnswers[inp.dataset.qShort] = inp.value; };
    });
  }

  // 사진/파일 업로드 → 교사 구글 드라이브 /클래스레볼루션2/{과제명}/ 자동 저장
  const fileInp = appEl.querySelector('#st-file-upload');
  if (fileInp) {
    fileInp.onchange = async () => {
      const file = fileInp.files?.[0];
      fileInp.value = '';
      if (!file) return;
      try {
        showStToast('구글 드라이브에 파일을 올리는 중...');
        const uploaded = await uploadFileToDrive({
          bridgeUrl: classData.driveBridgeUrl || '',
          folderName: classData.driveFolderName || '클래스레볼루션2',
          assignmentTitle: asg.title,
          studentLabel: `${me.number}_${me.name}`,
          file,
        });
        draftFiles.push(uploaded);
        showStToast('파일이 업로드되었습니다!');
        renderAssignmentWork(me, asg);
      } catch (err) {
        showStToast(`업로드 실패: ${err.message}`);
      }
    };
  }
  appEl.querySelectorAll('[data-rm-file]').forEach((b) => {
    b.onclick = () => {
      draftFiles.splice(Number(b.dataset.rmFile), 1);
      renderAssignmentWork(me, asg);
    };
  });

  // 제출 실행
  const submitBtn = appEl.querySelector('#st-btn-submit');
  if (submitBtn) {
    submitBtn.onclick = async () => {
      submitBtn.disabled = true;
      try {
        let payload = {
          assignmentId: asg.id,
          studentId: me.id,
          status: 'submitted',
          submittedAt: Date.now(),
          files: draftFiles,
          feedback: existingSub?.feedback || '',
          rewardGiven: Boolean(existingSub?.rewardGiven),
          questionGrades: existingSub?.questionGrades || {},
        };

        if (asg.kind === 'worksheet' && activeWorksheetCtrl) {
          // 배경지는 저장하지 않고 학생 답변 레이어(벡터/텍스트 JSON)만 전송!
          payload.worksheetData = activeWorksheetCtrl.getAnswer();
        } else if (asg.kind === 'general') {
          payload.text = appEl.querySelector('#st-general-text')?.value.trim() || '';
          payload.link = appEl.querySelector('#st-general-link')?.value.trim() || '';
        } else if (asg.kind === 'quiz') {
          const questions = asg.quiz?.questions || [];
          const graded = gradeQuizSubmission(questions, draftQuizAnswers);
          payload.quizAnswers = { ...draftQuizAnswers };
          payload.questionGrades = graded.questionGrades;
          payload.status = asg.quizMode === 'live' && asg.liveQuiz?.active ? 'submitted' : 'graded';
        }

        await persistSubmission(asg.id, me.id, payload);
        showStToast('제출 완료! 홈 화면으로 이동합니다.');
        if (!(asg.kind === 'quiz' && asg.quizMode === 'live' && asg.liveQuiz?.active)) {
          activeAssignmentId = null;
          activeWorksheetCtrl = null;
        }
        render();
      } catch (err) {
        showStToast(`제출 실패: ${err.message}`);
        submitBtn.disabled = false;
      }
    };
  }
}

function renderQuizWorkHtml(asg, existingSub, locked) {
  const allQuestions = asg.quiz?.questions || [];
  const isLiveActive = asg.quizMode === 'live' && asg.liveQuiz?.active;
  const visibleQuestions = isLiveActive
    ? [allQuestions[asg.liveQuiz.currentIndex]].filter(Boolean)
    : allQuestions;
  const showExplain = isLiveActive
    ? Boolean(asg.liveQuiz?.revealAnswer)
    : Boolean(existingSub && asg.quiz?.showExplainImmediately);

  return `
    <div class="st-quiz-list">
      ${isLiveActive ? `<div class="st-badge is-redo" style="align-self:flex-start;">🔴 실시간 퀴즈 진행 중 (${asg.liveQuiz.currentIndex + 1} / ${allQuestions.length}번)</div>` : ''}
      ${visibleQuestions.map((q) => {
        const curAns = String(draftQuizAnswers[q.id] ?? '');
        return `
          <div class="st-quiz-q">
            <h4>${q.number}. ${esc(q.prompt)} <small style="color:#7d7465;">(${q.points}점)</small></h4>
            ${q.type === 'choice' || q.type === 'ox' ? `
              <div class="st-quiz-choices">
                ${(q.choices || []).map((ch, idx) => {
                  const val = q.type === 'ox' ? ch : String(idx + 1);
                  const picked = curAns.toUpperCase() === val.toUpperCase();
                  return `
                    <button type="button" class="st-choice-btn ${picked ? 'is-picked' : ''}" data-qid="${q.id}" data-q-choice="${esc(val)}" ${locked ? 'disabled' : ''}>
                      ${q.type === 'ox' ? ch : `${idx + 1}. ${esc(ch)}`}
                    </button>
                  `;
                }).join('')}
              </div>
            ` : `
              <input type="text" data-q-short="${q.id}" value="${esc(curAns)}" ${locked ? 'readonly' : ''} placeholder="정답을 입력하세요" style="height:40px;padding:0 12px;border:1.5px solid #d9d3c3;border-radius:8px;">
            `}
            ${showExplain ? `
              <div class="st-quiz-explain">
                <strong>정답: ${esc(q.answer)}</strong>
                ${q.explanation ? `<div>${esc(q.explanation)}</div>` : ''}
              </div>
            ` : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderSharedGalleryHtml(asg) {
  const subMap = allSubmissions[asg.id] || {};
  const entries = (classData.students || [])
    .filter((s) => Boolean(subMap[s.id]))
    .map((s) => ({ student: s, sub: subMap[s.id] }));

  if (entries.length === 0) {
    return `<p style="color:#7d7465;">아직 공유된 친구 작품이 없습니다.</p>`;
  }

  return `
    <div class="st-card-grid">
      ${entries.map(({ student, sub }) => `
        <div class="st-file-card" style="padding:12px;">
          <strong>${student.number}번 ${esc(student.name)}</strong>
          ${asg.kind === 'worksheet' ? `<canvas data-gal-canvas="${student.id}" style="width:100%;height:auto;border-radius:6px;"></canvas>` : ''}
          ${sub.text ? `<p style="margin:0;font-size:13px;">${esc(sub.text)}</p>` : ''}
          ${(sub.files || []).filter((f) => f.mimeType?.startsWith('image/')).map((f) => `<img src="${esc(f.thumbnailUrl || f.viewUrl)}" alt="">`).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

async function bootstrapStudentApp() {
  // 1) URL 해시(#CR2S.{...})에 관리페이지 서버 정보가 있으면 자동 저장 및 연결
  const hashServer = parseStudentConnectHash(location.hash);
  if (hashServer) {
    saveServer(hashServer);
    history.replaceState(null, '', location.pathname + location.search);
  }
  const serverInfo = hashServer || loadSavedServer();
  loggedStudentId = loadSavedSession();

  if (serverInfo?.config && serverInfo?.classId) {
    try {
      dataMode = 'cloud';
      cloudClient = await connectStudentCloud(serverInfo.config, serverInfo.classId, {
        onClassUpdate: (data) => {
          classData = {
            className: data.className || '우리 반',
            driveBridgeUrl: data.driveBridgeUrl || '',
            driveFolderName: data.driveFolderName || '클래스레볼루션2',
            students: Array.isArray(data.students) ? data.students : [],
            assignments: Array.isArray(data.assignments) ? data.assignments : [],
            selfChecks: Array.isArray(data.selfChecks) ? data.selfChecks : [],
          };
          render();
        },
        onSubmissionsUpdate: (grouped) => {
          allSubmissions = grouped || {};
          render();
        },
      });
      return;
    } catch (err) {
      console.warn('[Student Cloud] fallback to local:', err);
    }
  }

  // 2) 서버 미연결 시 같은 브라우저 로컬 IndexedDB 폴백
  dataMode = 'local';
  await store.init();
  const syncLocal = () => {
    const st = store.getState();
    classData = {
      className: st.classInfo?.name || '우리 반',
      driveBridgeUrl: st.cloudConfig?.driveBridgeUrl || '',
      driveFolderName: st.cloudConfig?.driveFolderName || '클래스레볼루션2',
      students: (st.students || []).filter((s) => !s.trashed),
      assignments: st.assignments || [],
      selfChecks: st.selfChecks || [],
    };
    allSubmissions = st.submissions || {};
    render();
  };
  store.subscribe(syncLocal);
  syncLocal();
}

bootstrapStudentApp();
