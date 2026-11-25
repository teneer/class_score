// 학생용 터치 친화형 카드 대시보드 (관리페이지 종속 자동 서버 접속 · ID/PW 로그인 · 황금알/모둠점수/쑥쑥점수/코인 요약 · 벤토 카드 허브 · 과제/퀘스트/사이버방)

import { store, getStillAvatarUrl, todayIso, isStudentCyberAllowed, getStudentCyberCoins } from './store.js';
import { playSound } from './audio.js';
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
  motto: '',
  starsPerEgg: 10,
  driveBridgeUrl: '',
  driveFolderName: '클래스레볼루션2',
  students: [],
  groups: [],
  growth: {
    eggs: 0,
    pendingTrailCount: 0,
    goals: [],
  },
  wbScoreboard: {
    baseGroupMode: 'sum',
    specialGroupScores: {},
  },
  assignments: [],
  selfChecks: [],
  cyberRoom: {
    globalAllowed: false,
    studentAccess: {},
    groupAccess: {},
    coins: {},
    sites: [],
    activeSessions: {},
  },
};
let allSubmissions = {}; // { [assignmentId]: { [studentId]: Submission } }
let loggedStudentId = null;
let activeView = 'dashboard'; // 'dashboard' | 'todo' | 'quests' | 'cyber' | 'done' | 'gallery' | 'growth'
let activeAssignmentId = null;
let assignmentOriginView = 'todo'; // 과제 닫기 시 복귀할 화면
let activeWorksheetCtrl = null;
let draftFiles = [];
let draftQuizAnswers = {};
let loginError = '';

// 사이버지식정보방 활성 세션 상태
let activeCyberSession = null;
let cyberTerminateMsg = '';

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

/** 사이버지식정보방 세션 및 코인 변동 저장 (클라우드/로컬 양쪽) */
async function persistCyberState(studentId, { active, siteId = '', siteTitle = '', coinsAfter = null }) {
  if (classData.cyberRoom) {
    if (!classData.cyberRoom.coins) classData.cyberRoom.coins = {};
    if (typeof coinsAfter === 'number') classData.cyberRoom.coins[studentId] = Math.max(0, Math.floor(coinsAfter));
  }
  if (dataMode === 'cloud' && cloudClient) {
    await cloudClient.saveCyberSession(studentId, {
      active: Boolean(active),
      siteId,
      siteTitle,
      startedAt: activeCyberSession?.startedAt || Date.now(),
      coinsAfter: typeof coinsAfter === 'number' ? Math.max(0, Math.floor(coinsAfter)) : null,
    });
  } else {
    await store.update((s) => {
      if (!s.cyberRoom) return;
      if (typeof coinsAfter === 'number') {
        s.cyberRoom.coins[studentId] = Math.max(0, Math.floor(coinsAfter));
      }
      if (active) {
        s.cyberRoom.activeSessions[studentId] = {
          siteId,
          siteTitle,
          startedAt: activeCyberSession?.startedAt || Date.now(),
          lastPingAt: Date.now(),
        };
      } else {
        delete s.cyberRoom.activeSessions[studentId];
      }
    });
  }
}

/** 사이버지식정보방 즉시 접속 종료 (팝업 자동 닫기 + 워커/타이머 정리 + 사유 메시지 출력) */
async function terminateCyberSession(reasonMessage = '', silent = false) {
  const prev = activeCyberSession;
  if (!prev) return;
  if (prev.timerId) clearInterval(prev.timerId);
  if (prev.worker) {
    try { prev.worker.terminate(); } catch {}
  }
  activeCyberSession = null;

  if (prev.popupWin && !prev.popupWin.closed) {
    try { prev.popupWin.close(); } catch {}
  }

  const frame = document.getElementById('st-cyber-frame');
  if (frame) {
    try { frame.src = 'about:blank'; } catch {}
  }

  const me = getCurrentStudent();
  if (me) {
    await persistCyberState(me.id, { active: false, coinsAfter: prev.coins }).catch(() => {});
  }

  if (reasonMessage) {
    cyberTerminateMsg = reasonMessage;
    if (!silent) playSound('timerAlarm');
  } else if (!silent) {
    playSound('cardFlip');
  }
  render();
}

function formatMmSs(totalSec) {
  const s = Math.max(0, Math.floor(totalSec));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function getCurrentStudent() {
  return (classData.students || []).find((s) => s.id === loggedStudentId) || null;
}

/** 모둠별 합산/평균 + 교사 특별 모둠점수 계산 */
function computeGroupSummaries() {
  const groups = [...(classData.groups || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const students = (classData.students || []).filter((s) => !s.trashed);
  const baseMode = classData.wbScoreboard?.baseGroupMode === 'avg' ? 'avg' : 'sum';
  const specialMap = classData.wbScoreboard?.specialGroupScores || {};

  return groups.map((g) => {
    const members = students.filter((s) => s.groupId === g.id);
    const sum = members.reduce((acc, m) => acc + (Number(m.score) || 0), 0);
    const baseScore = baseMode === 'avg'
      ? (members.length > 0 ? Math.floor(sum / members.length) : 0)
      : sum;
    const special = Number(specialMap[g.id] || 0);
    return {
      group: g,
      memberCount: members.length,
      baseScore,
      special,
      total: baseScore + special,
    };
  });
}

/** 학생 개인 기준 대시보드 요약 데이터 생성 */
function buildStudentDashboardModel(me) {
  const assignments = [...(classData.assignments || [])]
    .filter((a) => !Array.isArray(a.targetStudentIds) || a.targetStudentIds.length === 0 || a.targetStudentIds.includes(me.id))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const todoList = assignments.filter((a) => {
    const sub = allSubmissions[a.id]?.[me.id];
    return !sub || sub.status === 'redo';
  });
  const redoList = todoList.filter((a) => allSubmissions[a.id]?.[me.id]?.status === 'redo');
  const liveQuizzes = assignments.filter((a) => a.kind === 'quiz' && a.quizMode === 'live' && a.liveQuiz?.active && !a.closed);

  const doneList = assignments.filter((a) => {
    const sub = allSubmissions[a.id]?.[me.id];
    return Boolean(sub) && sub.status !== 'redo';
  });
  const gradedCount = doneList.filter((a) => allSubmissions[a.id]?.[me.id]?.status === 'graded').length;
  const feedbackItems = assignments
    .map((a) => ({ asg: a, sub: allSubmissions[a.id]?.[me.id] }))
    .filter((x) => Boolean(x.sub?.feedback))
    .sort((a, b) => (b.sub.updatedAt || b.sub.submittedAt || 0) - (a.sub.updatedAt || a.sub.submittedAt || 0));

  const galleryList = assignments.filter((a) => a.visibility === 'shared');

  const myQuests = [...(classData.selfChecks || [])]
    .filter((sc) => sc.sendToTablet !== false)
    .filter((sc) => !Array.isArray(sc.targetStudentIds) || sc.targetStudentIds.length === 0 || sc.targetStudentIds.includes(me.id))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const completedQuestCount = myQuests.filter((sc) => {
    const raw = sc.entries?.[me.id];
    if (sc.mode === 'count') {
      const targetCnt = Math.max(1, Number(sc.targetCount) || 1);
      return Number(raw || 0) >= targetCnt;
    }
    return Boolean(raw);
  }).length;

  const cr = classData.cyberRoom || {};
  const cyberAllowed = isStudentCyberAllowed(cr, me);
  const cyberSites = (cr.sites || []).filter((s) => s.enabled !== false);
  const myCoins = getStudentCyberCoins(cr, me.id);

  const groupSummaries = computeGroupSummaries();
  const myGroupSummary = groupSummaries.find((gs) => gs.group.id === me.groupId) || null;

  const eggs = Number(classData.growth?.eggs) || 0;
  const starsPerEgg = Math.max(5, Number(classData.starsPerEgg) || 10);
  const filledStars = Math.min(starsPerEgg, Math.max(0, Number(classData.growth?.pendingTrailCount) || 0));
  const goals = [...(classData.growth?.goals || [])].sort((a, b) => (Number(a.targetEggs) || 0) - (Number(b.targetEggs) || 0));
  const nextGoal = goals.find((g) => (Number(g.targetEggs) || 0) > eggs) || goals[goals.length - 1] || null;

  return {
    assignments,
    todoList,
    redoList,
    liveQuizzes,
    doneList,
    gradedCount,
    feedbackItems,
    galleryList,
    myQuests,
    completedQuestCount,
    cyberAllowed,
    cyberSites,
    myCoins,
    groupSummaries,
    myGroupSummary,
    eggs,
    starsPerEgg,
    filledStars,
    goals,
    nextGoal,
  };
}

function openAssignment(me, asgId, originView = activeView) {
  activeAssignmentId = asgId;
  assignmentOriginView = originView || 'dashboard';
  const existingSub = allSubmissions[activeAssignmentId]?.[me.id];
  draftFiles = Array.isArray(existingSub?.files) ? structuredClone(existingSub.files) : [];
  draftQuizAnswers = existingSub?.quizAnswers ? structuredClone(existingSub.quizAnswers) : {};
  render();
}

function render() {
  const me = getCurrentStudent();
  if (!me) {
    if (activeCyberSession) terminateCyberSession('', true);
    renderLogin();
    return;
  }

  // 사이버지식정보방 이용 중이라면 교사 원격 차단 여부만 확인하고 iframe 리로드를 방지
  if (activeCyberSession) {
    const cr = classData.cyberRoom || {};
    const stillAllowed = isStudentCyberAllowed(cr, me);
    const liveSite = (cr.sites || []).find((x) => x.id === activeCyberSession.site.id && x.enabled !== false);
    if (!stillAllowed || !liveSite) {
      terminateCyberSession('선생님이 사이버지식정보방 접속을 종료했습니다.');
      return;
    }
    const latestCoins = getStudentCyberCoins(cr, me.id);
    if (latestCoins > activeCyberSession.coins) {
      activeCyberSession.coins = latestCoins;
      const coinEl = document.getElementById('st-cyber-coin-live');
      if (coinEl) coinEl.textContent = `🪙 ${activeCyberSession.coins}코인`;
    }
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

  if (activeView === 'dashboard') {
    renderDashboard(me);
  } else {
    renderSectionView(me);
  }
}

/** 1. 아이디 · 비밀번호 로그인 화면 (터치 친화형) */
function renderLogin() {
  appEl.innerHTML = `
    <div class="st-login-screen">
      <form class="st-login-wrap" id="st-login-form">
        <div class="st-login-topbar">
          <span>🌱 클래스레볼루션2 · 학생 대시보드</span>
        </div>
        <div class="st-login-body">
          <span class="st-login-badge">${dataMode === 'cloud' ? '☁️ 학급 서버 연결됨' : '💻 로컬 학급 연결됨'}</span>
          <h1>${esc(classData.className || '클래스레볼루션2')}</h1>
          <p class="st-login-sub">선생님이 알려주신 아이디와 비밀번호를 입력해 내 대시보드로 들어가세요.</p>
          ${loginError ? `<p class="st-error" role="alert">${esc(loginError)}</p>` : ''}
          <label class="st-field">
            <span>아이디</span>
            <input type="text" name="loginId" autocomplete="username" autocapitalize="none" placeholder="예: s01" required autofocus>
          </label>
          <label class="st-field">
            <span>비밀번호</span>
            <div class="st-pw-wrap">
              <input type="password" name="loginPw" id="st-login-pw" autocomplete="current-password" placeholder="비밀번호 입력" required>
              <button type="button" class="st-pw-toggle" id="st-toggle-pw" aria-label="비밀번호 표시 전환">보기</button>
            </div>
          </label>
          <button type="submit" class="st-btn is-primary" style="margin-top:6px;width:100%;font-size:16px;">내 대시보드 입장하기</button>
        </div>
      </form>
    </div>
  `;

  const pwInput = appEl.querySelector('#st-login-pw');
  const pwToggle = appEl.querySelector('#st-toggle-pw');
  if (pwInput && pwToggle) {
    pwToggle.onclick = () => {
      const nextShow = pwInput.type === 'password';
      pwInput.type = nextShow ? 'text' : 'password';
      pwToggle.textContent = nextShow ? '숨김' : '보기';
    };
  }

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
    activeView = 'dashboard';
    activeAssignmentId = null;
    saveSession(found.id);
    playSound('restoreDone');
    showStToast(`${found.name} 학생, 반가워요!`);
    render();
  };
}

/** 공통 상단 헤더 (쑥쑥점수 + 코인 + 모둠 배지 + 홈 복귀 버튼) */
function renderHeader(me, model, showHomeBtn = false) {
  const myGroupName = model.myGroupSummary?.group?.name || '';
  const myGroupScore = model.myGroupSummary?.total ?? null;
  return `
    <header class="st-header">
      <div class="st-header-left">
        ${showHomeBtn ? `
          <button type="button" class="st-home-btn" id="st-btn-go-home">
            <span>🏠</span>
            <span>대시보드</span>
          </button>
        ` : ''}
        <div class="st-profile">
          <img class="st-avatar" src="${getStillAvatarUrl(me.avatarId)}" alt="${esc(me.name)}">
          <div class="st-profile-info">
            <div class="st-profile-name-row">
              <strong>${me.number}번 ${esc(me.name)}</strong>
              ${myGroupName ? `<span class="st-group-chip">${esc(myGroupName)}</span>` : ''}
            </div>
            <span>${esc(classData.className || '우리 반')}${classData.motto ? ` · ${esc(classData.motto)}` : ''}</span>
          </div>
        </div>
      </div>
      <div class="st-score-pills">
        <span class="st-pill is-egg" title="우리 반 황금알">🥚 황금알 ${model.eggs}알</span>
        ${myGroupName && myGroupScore !== null ? `<span class="st-pill is-group" title="${esc(myGroupName)} 점수">🏆 ${esc(myGroupName)} ${myGroupScore}점</span>` : ''}
        <span class="st-pill is-net" title="내 쑥쑥점수">🌱 쑥쑥 ${me.score ?? 0}점</span>
        <span class="st-pill is-coin" title="보유 사이버 코인">🪙 ${model.myCoins}코인</span>
        <button type="button" class="st-btn is-outline is-sm" id="st-btn-logout">로그아웃</button>
      </div>
    </header>
  `;
}

function bindHeaderEvents() {
  const logoutBtn = appEl.querySelector('#st-btn-logout');
  if (logoutBtn) {
    logoutBtn.onclick = () => {
      loggedStudentId = null;
      activeAssignmentId = null;
      activeView = 'dashboard';
      saveSession(null);
      render();
    };
  }
  const homeBtn = appEl.querySelector('#st-btn-go-home');
  if (homeBtn) {
    homeBtn.onclick = () => {
      activeAssignmentId = null;
      activeWorksheetCtrl = null;
      activeView = 'dashboard';
      render();
    };
  }
}

/** 2. 학생 홈 대시보드 (4대 점수 요약 타일 + 벤토 카드 허브) */
function renderDashboard(me) {
  const m = buildStudentDashboardModel(me);
  const starPct = Math.min(100, Math.round((m.filledStars / m.starsPerEgg) * 100));
  const myGroupName = m.myGroupSummary ? m.myGroupSummary.group.name : '미배정';
  const myGroupScore = m.myGroupSummary ? m.myGroupSummary.total : 0;

  const urgentTodoPreview = m.todoList.slice(0, 2);
  const questPreview = [...m.myQuests]
    .sort((a, b) => {
      const doneA = a.mode === 'count' ? Number(a.entries?.[me.id] || 0) >= Math.max(1, Number(a.targetCount) || 1) : Boolean(a.entries?.[me.id]);
      const doneB = b.mode === 'count' ? Number(b.entries?.[me.id] || 0) >= Math.max(1, Number(b.targetCount) || 1) : Boolean(b.entries?.[me.id]);
      return Number(doneA) - Number(doneB);
    })
    .slice(0, 2);

  const latestFb = m.feedbackItems[0] || null;

  appEl.innerHTML = `
    ${renderHeader(me, m, false)}
    <main class="st-main">
      ${cyberTerminateMsg ? `
        <div class="st-cyber-alert" role="alert">
          <div>
            <strong>⛔ 사이버지식정보방 접속이 종료되었습니다</strong>
            <p>${esc(cyberTerminateMsg)}</p>
          </div>
          <button type="button" class="st-btn is-outline is-sm" id="btn-dismiss-cy-alert">확인</button>
        </div>
      ` : ''}

      ${(m.liveQuizzes.length > 0 || m.redoList.length > 0) ? `
        <section class="st-urgent-stack" aria-label="바로 확인 알림">
          ${m.liveQuizzes.map((qz) => `
            <button type="button" class="st-urgent-card is-live" data-quick-work="${qz.id}" data-origin="todo">
              <div class="st-urgent-left">
                <span class="st-live-dot" aria-hidden="true"></span>
                <div>
                  <strong>🔴 지금 실시간 퀴즈가 진행 중이에요! · ${esc(qz.title)}</strong>
                  <span>현재 ${(qz.liveQuiz?.currentIndex ?? 0) + 1}번 문항 진행 중 — 카드를 터치해 바로 참여하세요</span>
                </div>
              </div>
              <span class="st-urgent-cta">바로 참여하기 ›</span>
            </button>
          `).join('')}
          ${m.redoList.map((rd) => `
            <button type="button" class="st-urgent-card is-redo" data-quick-work="${rd.id}" data-origin="todo">
              <div class="st-urgent-left">
                <span style="font-size:24px;">🔄</span>
                <div>
                  <strong>선생님이 다시 제출을 요청한 과제가 있어요 · ${esc(rd.title)}</strong>
                  <span>${rd.dueDate ? `마감: ${esc(rd.dueDate)} · ` : ''}피드백을 확인하고 수정해서 제출해 보세요</span>
                </div>
              </div>
              <span class="st-urgent-cta">과제 열기 ›</span>
            </button>
          `).join('')}
        </section>
      ` : ''}

      <!-- 상단 점수 요약 히어로 카드: 황금알 · 모둠점수 · 개인 쑥쑥점수 · 코인 -->
      <section class="st-status-hero" aria-label="우리 반 및 내 점수 현황">
        <div class="st-status-hero-top">
          <div class="st-hero-greeting">
            <div class="st-hero-avatar-box">
              <img src="${getStillAvatarUrl(me.avatarId)}" alt="${esc(me.name)}">
            </div>
            <div>
              <h2>${esc(me.name)} 학생, 오늘도 쑥쑥 자라볼까요?</h2>
              <p>${m.todoList.length > 0 ? `오늘 남은 할 과제가 ${m.todoList.length}건 있어요. 아래 카드를 터치해 시작해 보세요!` : '오늘 할 과제를 모두 마쳤어요! 퀘스트나 친구 작품도 둘러보세요.'}</p>
            </div>
          </div>
          ${m.nextGoal ? `
            <button type="button" class="st-hero-goal-pill" data-goto-view="growth" title="우리 반 황금알 목표 보기">
              <span>🎯 다음 학급 목표: <strong>${m.nextGoal.targetEggs}알</strong> · ${esc(m.nextGoal.reward)}</span>
              <span>›</span>
            </button>
          ` : ''}
        </div>

        <div class="st-stat-tiles">
          <button type="button" class="st-stat-tile is-egg-tile is-clickable" data-goto-view="growth">
            <div class="st-stat-icon" aria-hidden="true">🥚</div>
            <div class="st-stat-info">
              <span class="st-stat-label">우리 반 황금알</span>
              <div class="st-stat-value">${m.eggs}<small>알 · 별길 ${m.filledStars}/${m.starsPerEgg}</small></div>
              <div class="st-stat-subbar"><i style="width:${starPct}%;"></i></div>
            </div>
          </button>

          <button type="button" class="st-stat-tile is-group-tile is-clickable" data-goto-view="growth">
            <div class="st-stat-icon" aria-hidden="true">🏆</div>
            <div class="st-stat-info">
              <span class="st-stat-label">모둠 점수 (${esc(myGroupName)})</span>
              <div class="st-stat-value">${m.myGroupSummary ? `${myGroupScore}<small>점</small>` : `<small>소속 모둠 없음</small>`}</div>
            </div>
          </button>

          <div class="st-stat-tile is-net-tile">
            <div class="st-stat-icon" aria-hidden="true">🌱</div>
            <div class="st-stat-info">
              <span class="st-stat-label">내 쑥쑥점수</span>
              <div class="st-stat-value">${me.score ?? 0}<small>점</small></div>
            </div>
          </div>

          <button type="button" class="st-stat-tile is-coin-tile is-clickable" data-goto-view="cyber">
            <div class="st-stat-icon" aria-hidden="true">🪙</div>
            <div class="st-stat-info">
              <span class="st-stat-label">내 사이버 코인</span>
              <div class="st-stat-value">${m.myCoins}<small>코인</small></div>
            </div>
          </button>
        </div>
      </section>

      <!-- 벤토 카드 대시보드 영역 (터치 진입형) -->
      <section class="st-bento-grid" aria-label="학생 활동 대시보드 메뉴">
        <!-- 카드 1: 오늘 할 과제 (Wide 7칸) -->
        <article class="st-dash-card span-7 theme-todo" role="button" tabindex="0" data-goto-view="todo">
          <div class="st-dash-head">
            <div class="st-dash-title-group">
              <div class="st-dash-icon"><img src="assets/visuals/icon-assignment.svg" alt="" width="28" height="28"></div>
              <div class="st-dash-title-txt">
                <h3>오늘 할 과제</h3>
                <p>워크시트 · 퀴즈 · 사진 제출 과제</p>
              </div>
            </div>
            <div class="st-dash-head-right">
              <span class="st-count-pill ${m.todoList.length > 0 ? 'is-alert' : 'is-ok'}">
                ${m.todoList.length > 0 ? `${m.todoList.length}건 남음` : '모두 완료!'}
              </span>
              <span class="st-dash-arrow" aria-hidden="true">›</span>
            </div>
          </div>

          ${urgentTodoPreview.length > 0 ? `
            <div class="st-dash-preview-list">
              ${urgentTodoPreview.map((a) => {
                const sub = allSubmissions[a.id]?.[me.id];
                const kindIcon = a.kind === 'worksheet' ? '📝' : a.kind === 'quiz' ? '⚡' : '📎';
                return `
                  <button type="button" class="st-mini-item" data-quick-work="${a.id}" data-origin="todo">
                    <span class="st-mini-item-title">${kindIcon} ${esc(a.title)}</span>
                    <span class="st-mini-item-sub">${sub?.status === 'redo' ? '🔄 다시제출' : (a.dueDate ? `~${esc(a.dueDate)}` : '바로 풀기 ›')}</span>
                  </button>
                `;
              }).join('')}
            </div>
          ` : `
            <div class="st-dash-empty-box">
              <span style="font-size:22px;">🎉</span>
              <span>밀린 과제가 하나도 없어요! 참 잘했어요.</span>
            </div>
          `}

          <div class="st-dash-footer">
            <span>배정된 전체 과제 ${m.assignments.length}건</span>
            <span class="st-dash-cta-txt">할 과제 보러가기 ›</span>
          </div>
        </article>

        <!-- 카드 2: 내 퀘스트 (5칸 · 인라인 원터치 체크 지원) -->
        <article class="st-dash-card span-5 theme-quest" role="button" tabindex="0" data-goto-view="quests">
          <div class="st-dash-head">
            <div class="st-dash-title-group">
              <div class="st-dash-icon"><img src="assets/visuals/icon-quest.svg" alt="" width="28" height="28"></div>
              <div class="st-dash-title-txt">
                <h3>내 퀘스트</h3>
                <p>스스로 실천하고 바로 터치 체크</p>
              </div>
            </div>
            <div class="st-dash-head-right">
              <span class="st-count-pill ${m.myQuests.length > 0 && m.completedQuestCount === m.myQuests.length ? 'is-ok' : ''}">
                ${m.completedQuestCount} / ${m.myQuests.length} 완료
              </span>
              <span class="st-dash-arrow" aria-hidden="true">›</span>
            </div>
          </div>

          ${questPreview.length > 0 ? `
            <div class="st-dash-preview-list">
              ${questPreview.map((sc) => {
                const isCount = sc.mode === 'count';
                const targetCnt = Math.max(1, Number(sc.targetCount) || 1);
                const raw = sc.entries?.[me.id];
                const cnt = Number(raw || 0);
                const done = isCount ? cnt >= targetCnt : Boolean(raw);
                return `
                  <div class="st-inline-quest-row ${done ? 'is-done' : ''}" data-stop-card>
                    <span class="st-inline-quest-title">${done ? '✓ ' : '🎯 '}${esc(sc.title)}</span>
                    ${isCount ? `
                      <button type="button" class="st-inline-quest-btn" data-q-inc="${sc.id}">
                        ${done ? `달성 (${cnt}/${targetCnt})` : `+1 (${cnt}/${targetCnt})`}
                      </button>
                    ` : `
                      <button type="button" class="st-inline-quest-btn" data-q-toggle="${sc.id}">
                        ${done ? '완료됨' : '체크'}
                      </button>
                    `}
                  </div>
                `;
              }).join('')}
            </div>
          ` : `
            <div class="st-dash-empty-box">
              <span style="font-size:20px;">🌱</span>
              <span>현재 진행 중인 내 퀘스트가 없습니다.</span>
            </div>
          `}

          <div class="st-dash-footer">
            <span>오늘의 자기관리 미션</span>
            <span class="st-dash-cta-txt">퀘스트 전체보기 ›</span>
          </div>
        </article>

        <!-- 카드 3: 사이버지식정보방 (4칸) -->
        <article class="st-dash-card span-4 theme-cyber" role="button" tabindex="0" data-goto-view="cyber">
          <div class="st-dash-head">
            <div class="st-dash-title-group">
              <div class="st-dash-icon"><img src="assets/visuals/icon-cyber.svg" alt="" width="28" height="28"></div>
              <div class="st-dash-title-txt">
                <h3>사이버지식정보방</h3>
                <p>코인으로 학습·활동 사이트 입장</p>
              </div>
            </div>
            <div class="st-dash-head-right">
              <span class="st-count-pill ${m.cyberAllowed ? 'is-ok' : 'is-locked'}">
                ${m.cyberAllowed ? '🟢 입장 가능' : '🔒 대기 중'}
              </span>
              <span class="st-dash-arrow" aria-hidden="true">›</span>
            </div>
          </div>

          <div class="st-dash-empty-box" style="border-style:solid;background:${m.cyberAllowed ? '#f2faeb' : '#f7f6f1'};">
            <span style="font-size:22px;">${m.cyberAllowed ? '🚀' : '⏳'}</span>
            <span>
              ${m.cyberAllowed
                ? `이용 가능 사이트 <strong>${m.cyberSites.length}곳</strong> · 내 코인 <strong>${m.myCoins}개</strong>`
                : '선생님이 이용 시간을 열면 바로 입장할 수 있어요.'}
            </span>
          </div>

          <div class="st-dash-footer">
            <span>🪙 보유 ${m.myCoins}코인</span>
            <span class="st-dash-cta-txt">사이버방 들어가기 ›</span>
          </div>
        </article>

        <!-- 카드 4: 제출함 & 선생님 피드백 (4칸) -->
        <article class="st-dash-card span-4 theme-done" role="button" tabindex="0" data-goto-view="done">
          <div class="st-dash-head">
            <div class="st-dash-title-group">
              <div class="st-dash-icon">📬</div>
              <div class="st-dash-title-txt">
                <h3>제출한 과제 · 피드백</h3>
                <p>채점 결과와 선생님 코멘트 확인</p>
              </div>
            </div>
            <div class="st-dash-head-right">
              <span class="st-count-pill">${m.doneList.length}건 완료</span>
              <span class="st-dash-arrow" aria-hidden="true">›</span>
            </div>
          </div>

          ${latestFb ? `
            <div class="st-fb-preview">
              💬 <strong>${esc(latestFb.asg.title)}</strong>: "${esc(latestFb.sub.feedback)}"
            </div>
          ` : `
            <div class="st-dash-empty-box">
              <span style="font-size:20px;">✨</span>
              <span>채점 완료 ${m.gradedCount}건 · 제출한 내 과제를 다시 볼 수 있어요.</span>
            </div>
          `}

          <div class="st-dash-footer">
            <span>피드백 도착 ${m.feedbackItems.length}건</span>
            <span class="st-dash-cta-txt">제출함 열기 ›</span>
          </div>
        </article>

        <!-- 카드 5: 친구 작품 갤러리 (4칸) -->
        <article class="st-dash-card span-4 theme-gallery" role="button" tabindex="0" data-goto-view="gallery">
          <div class="st-dash-head">
            <div class="st-dash-title-group">
              <div class="st-dash-icon">🖼️</div>
              <div class="st-dash-title-txt">
                <h3>친구 작품 갤러리</h3>
                <p>우리 반 친구들의 멋진 과제 감상</p>
              </div>
            </div>
            <div class="st-dash-head-right">
              <span class="st-count-pill">${m.galleryList.length}개 공개</span>
              <span class="st-dash-arrow" aria-hidden="true">›</span>
            </div>
          </div>

          <div class="st-dash-empty-box">
            <span style="font-size:20px;">🎨</span>
            <span>${m.galleryList.length > 0 ? `공유된 과제 ${m.galleryList.length}개의 친구 작품을 구경해 보세요!` : '선생님이 공개한 공유 과제가 여기에 모입니다.'}</span>
          </div>

          <div class="st-dash-footer">
            <span>우리 반 공유 전시관</span>
            <span class="st-dash-cta-txt">작품 보러가기 ›</span>
          </div>
        </article>
      </section>
    </main>
  `;

  bindHeaderEvents();

  const dismissBtn = appEl.querySelector('#btn-dismiss-cy-alert');
  if (dismissBtn) {
    dismissBtn.onclick = () => {
      cyberTerminateMsg = '';
      renderDashboard(me);
    };
  }

  // 인라인 영역 이벤트 버블링 차단
  appEl.querySelectorAll('[data-stop-card]').forEach((el) => {
    el.onclick = (e) => e.stopPropagation();
  });

  // 과제 원터치 바로 열기 (긴급 카드 · 미리보기 칩)
  appEl.querySelectorAll('[data-quick-work]').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      openAssignment(me, btn.dataset.quickWork, btn.dataset.origin || 'dashboard');
    };
  });

  // 대시보드 내 퀘스트 원터치 체크
  bindQuestActions(me, m.myQuests);

  // 대시보드 카드 터치·키보드로 세부 섹션 진입
  appEl.querySelectorAll('[data-goto-view]').forEach((el) => {
    const go = () => {
      activeView = el.dataset.gotoView;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      render();
    };
    el.onclick = go;
    el.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        go();
      }
    };
  });
}

function bindQuestActions(me, myQuests) {
  appEl.querySelectorAll('[data-q-toggle]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const sc = myQuests.find((x) => x.id === b.dataset.qToggle);
      if (!sc) return;
      const next = !Boolean(sc.entries?.[me.id]);
      await persistSelfCheck(sc.id, me.id, next);
      playSound(next ? 'pickResult' : 'cardFlip');
      showStToast(next ? `✓ '${sc.title}' 완료 체크!` : `'${sc.title}' 체크를 취소했습니다.`);
      render();
    };
  });

  appEl.querySelectorAll('[data-q-inc]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const sc = myQuests.find((x) => x.id === b.dataset.qInc);
      if (!sc) return;
      const targetCnt = Math.max(1, Number(sc.targetCount) || 1);
      const cur = Number(sc.entries?.[me.id] || 0);
      const next = cur >= targetCnt ? targetCnt : cur + 1;
      await persistSelfCheck(sc.id, me.id, next);
      playSound(next >= targetCnt ? 'fanfare' : 'tick');
      showStToast(next >= targetCnt ? `🎉 '${sc.title}' 목표 달성!` : `'${sc.title}' ${next}/${targetCnt}회 체크!`);
      render();
    };
  });

  appEl.querySelectorAll('[data-q-dec]').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const sc = myQuests.find((x) => x.id === b.dataset.qDec);
      if (!sc) return;
      const cur = Number(sc.entries?.[me.id] || 0);
      const next = Math.max(0, cur - 1);
      await persistSelfCheck(sc.id, me.id, next);
      playSound('cardFlip');
      render();
    };
  });
}

/** 3. 세부 섹션 화면 (할 과제 / 내 퀘스트 / 사이버방 / 제출함 / 친구 작품 / 황금알·모둠점수) */
function renderSectionView(me) {
  const m = buildStudentDashboardModel(me);
  const list = activeView === 'todo' ? m.todoList : activeView === 'done' ? m.doneList : m.galleryList;
  const starPct = Math.min(100, Math.round((m.filledStars / m.starsPerEgg) * 100));

  appEl.innerHTML = `
    ${renderHeader(me, m, true)}
    <main class="st-main">
      ${cyberTerminateMsg ? `
        <div class="st-cyber-alert" role="alert">
          <div>
            <strong>⛔ 접속이 종료되었습니다</strong>
            <p>${esc(cyberTerminateMsg)}</p>
          </div>
          <button type="button" class="st-btn is-outline is-sm" id="btn-dismiss-cy-alert">확인</button>
        </div>
      ` : ''}

      <nav class="st-subnav-bar" aria-label="영역 빠른 이동">
        <div class="st-subnav-pills">
          <button type="button" class="st-subnav-pill" data-st-nav="dashboard">🏠 홈 대시보드</button>
          <button type="button" class="st-subnav-pill ${activeView === 'todo' ? 'is-active' : ''}" data-st-nav="todo">📝 할 과제 (${m.todoList.length})</button>
          <button type="button" class="st-subnav-pill ${activeView === 'quests' ? 'is-active' : ''}" data-st-nav="quests">🎯 내 퀘스트 (${m.myQuests.length})</button>
          <button type="button" class="st-subnav-pill ${activeView === 'cyber' ? 'is-active' : ''}" data-st-nav="cyber">💻 사이버방</button>
          <button type="button" class="st-subnav-pill ${activeView === 'done' ? 'is-active' : ''}" data-st-nav="done">📬 제출함 (${m.doneList.length})</button>
          <button type="button" class="st-subnav-pill ${activeView === 'gallery' ? 'is-active' : ''}" data-st-nav="gallery">🖼️ 친구 작품 (${m.galleryList.length})</button>
          <button type="button" class="st-subnav-pill ${activeView === 'growth' ? 'is-active' : ''}" data-st-nav="growth">🥚 황금알·모둠</button>
        </div>
      </nav>

      ${activeView === 'growth' ? `
        <div class="st-growth-grid">
          <section class="st-work-card">
            <div class="st-work-head">
              <h2>🥚 우리 반 황금알 · 목표 현황</h2>
              <span class="st-pill is-egg">현재 ${m.eggs}알</span>
            </div>
            <p style="margin:0;font-size:14px;color:var(--text-sub);">
              별길 진행도: <strong>${m.filledStars} / ${m.starsPerEgg}칸</strong> (별길이 가득 차면 황금알 1개가 늘어나요!)
            </p>
            <div class="st-stat-subbar" style="height:12px;"><i style="width:${starPct}%;"></i></div>
            ${m.goals.length > 0 ? `
              <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px;">
                ${m.goals.map((g) => {
                  const achieved = m.eggs >= (Number(g.targetEggs) || 0);
                  return `
                    <div class="st-goal-item ${achieved ? 'is-achieved' : ''}">
                      <strong style="font-size:14.5px;">${achieved ? '🎉' : '🎯'} ${g.targetEggs}알 목표 · ${esc(g.reward)}</strong>
                      <span class="st-badge ${achieved ? 'is-graded' : 'is-todo'}">${achieved ? '달성 완료!' : `${Math.max(0, Number(g.targetEggs) - m.eggs)}알 남음`}</span>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : `<p style="margin:0;color:var(--text-sub);font-size:13.5px;">등록된 학급 보상 목표가 없습니다.</p>`}
          </section>

          <section class="st-work-card">
            <div class="st-work-head">
              <h2>🏆 우리 반 모둠 점수</h2>
              ${m.myGroupSummary ? `<span class="st-pill is-group">내 모둠: ${esc(m.myGroupSummary.group.name)} (${m.myGroupSummary.total}점)</span>` : ''}
            </div>
            ${m.groupSummaries.length > 0 ? `
              <div class="st-group-rank-list">
                ${m.groupSummaries.map((gs) => {
                  const isMine = gs.group.id === me.groupId;
                  return `
                    <div class="st-group-score-card ${isMine ? 'is-mine' : ''}">
                      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
                        <strong>${esc(gs.group.name)}</strong>
                        ${isMine ? `<span class="st-badge is-todo">내 모둠</span>` : ''}
                      </div>
                      <div class="st-group-score-val">${gs.total}점</div>
                      <span style="font-size:12px;color:var(--text-sub);font-weight:700;">모둠원 ${gs.memberCount}명</span>
                    </div>
                  `;
                }).join('')}
              </div>
            ` : `<p style="margin:0;color:var(--text-sub);font-size:13.5px;">아직 구성된 모둠이 없습니다.</p>`}
          </section>
        </div>
      ` : activeView === 'cyber' ? (
        !m.cyberAllowed ? `
          <div class="st-work-card" style="text-align:center;color:#7d7465;padding:46px 20px;align-items:center;">
            <img src="assets/visuals/icon-cyber.svg" alt="" width="68" height="68" style="opacity:0.6;margin-bottom:6px;">
            <strong style="font-size:18px;color:#4a4235;">🔒 현재 사이버지식정보방 접속이 제한되어 있습니다</strong>
            <p style="margin:4px 0 0;font-size:14px;">선생님이 접속을 허용하면 이용 가능한 사이트 카드가 나타납니다.</p>
          </div>
        ` : m.cyberSites.length === 0 ? `
          <div class="st-work-card" style="text-align:center;color:#7d7465;padding:46px 20px;align-items:center;">
            <img src="assets/visuals/icon-cyber.svg" alt="" width="68" height="68" style="margin-bottom:6px;">
            <strong style="font-size:17px;color:#4a4235;">등록된 사이버지식정보방 사이트가 없습니다.</strong>
          </div>
        ` : `
          <div class="st-cyber-banner">
            <strong>💻 사이버지식정보방 이용 가능</strong>
            <span>현재 보유 코인: <b>🪙 ${m.myCoins}코인</b> · 입장 후 지정된 사이트를 벗어나거나 코인/시간이 만료되면 자동 종료됩니다.</span>
          </div>
          <div class="st-card-grid">
            ${m.cyberSites.map((site) => {
              const entryCost = Math.max(0, Number(site.entryCost) || 0);
              const perMin = Math.max(0, Number(site.coinPerMin) ?? 1);
              const limitMin = Math.max(0, Number(site.timeLimitMin) || 0);
              const canEnter = m.myCoins >= entryCost && (perMin === 0 || m.myCoins > entryCost);
              return `
                <article class="st-card" style="cursor:default;">
                  <div class="st-card-meta">
                    <span style="display:inline-flex;align-items:center;gap:6px;">
                      <img src="assets/visuals/icon-cyber.svg" alt="" width="20" height="20">
                      ${esc(site.category || '학습')}
                    </span>
                    <span class="st-badge ${perMin === 0 && entryCost === 0 ? 'is-graded' : 'is-todo'}">
                      ${entryCost > 0 ? `입장 ${entryCost}코인 · ` : ''}${perMin > 0 ? `분당 ${perMin}코인` : '무료 이용'}
                    </span>
                  </div>
                  <h3>${esc(site.title)}</h3>
                  <div class="st-card-meta">
                    <span>${limitMin > 0 ? `⏱ 최대 ${limitMin}분 이용` : '⏱ 시간 제한 없음'}</span>
                    ${site.openMode === 'popup' ? `<span>🪟 제어 팝업 창</span>` : (site.strictSinglePage ? `<span>🔒 이탈 시 종료</span>` : '')}
                  </div>
                  <button type="button" class="st-btn ${canEnter ? 'is-primary' : 'is-outline'}" data-enter-cyber="${site.id}" ${canEnter ? '' : 'disabled'} style="width:100%;">
                    ${canEnter ? '🚀 터치하여 입장하기' : '🪙 코인이 부족합니다'}
                  </button>
                </article>
              `;
            }).join('')}
          </div>
        `
      ) : activeView === 'quests' ? (
        m.myQuests.length === 0 ? `
          <div class="st-work-card" style="text-align:center;color:#7d7465;padding:42px 20px;align-items:center;">
            <img src="assets/visuals/student-mascot-empty.svg" alt="" width="96" height="76" style="margin-bottom:6px;">
            <strong>현재 진행 중인 내 퀘스트가 없습니다.</strong>
          </div>
        ` : `
          <div class="st-card-grid">
            ${m.myQuests.map((sc) => {
              const isCount = sc.mode === 'count';
              const targetCnt = Math.max(1, Number(sc.targetCount) || 1);
              const raw = sc.entries?.[me.id];
              const cnt = Number(raw || 0);
              const done = isCount ? cnt >= targetCnt : Boolean(raw);
              const pct = isCount ? Math.min(100, Math.round((cnt / targetCnt) * 100)) : (done ? 100 : 0);
              return `
                <article class="st-card" style="border-color:${done ? '#78c832' : '#dedad0'};background:${done ? '#edf9e2' : '#fff'};cursor:default;">
                  <div class="st-card-meta">
                    <span style="display:inline-flex;align-items:center;gap:5px;"><img src="assets/visuals/icon-quest.svg" alt="" width="18" height="18">${isCount ? `목표 ${targetCnt}회 퀘스트` : '셀프 체크 퀘스트'}</span>
                    <span class="st-badge ${done ? 'is-graded' : 'is-todo'}">${done ? '✓ 완료!' : isCount ? `${cnt} / ${targetCnt}회` : '미완료'}</span>
                  </div>
                  <h3>${esc(sc.title)}</h3>
                  ${isCount ? `
                    <div style="height:10px;border-radius:999px;background:#e6dfd0;overflow:hidden;">
                      <div style="width:${pct}%;height:100%;background:${done ? '#599c18' : '#ffd633'};transition:width 0.2s;"></div>
                    </div>
                    <div style="display:flex;gap:8px;">
                      <button type="button" class="st-btn is-outline" data-q-dec="${sc.id}" ${cnt <= 0 ? 'disabled' : ''}>-1</button>
                      <button type="button" class="st-btn is-primary" style="flex:1;" data-q-inc="${sc.id}">
                        ${done ? `🎉 목표 달성 (${cnt}/${targetCnt}회)` : `+1 체크하기 (${cnt}/${targetCnt}회)`}
                      </button>
                    </div>
                  ` : `
                    <button type="button" class="st-btn ${done ? 'is-outline' : 'is-primary'}" style="width:100%;" data-q-toggle="${sc.id}">
                      ${done ? '✓ 완료됨 (누르면 취소)' : '☑️ 완료 체크하기'}
                    </button>
                  `}
                </article>
              `;
            }).join('')}
          </div>
        `
      ) : list.length === 0 ? `
        <div class="st-work-card" style="text-align:center;color:#7d7465;padding:42px 20px;align-items:center;">
          <img src="assets/visuals/student-mascot-empty.svg" alt="" width="96" height="76" style="margin-bottom:6px;">
          <strong>${activeView === 'todo' ? '밀린 과제가 없습니다! 아주 훌륭해요!' : activeView === 'done' ? '아직 제출한 과제가 없습니다.' : '공유된 친구 작품 과제가 없습니다.'}</strong>
        </div>
      ` : `
        <div class="st-card-grid">
          ${list.map((a) => {
            const sub = allSubmissions[a.id]?.[me.id];
            const bCls = !sub ? 'is-todo' : sub.status === 'redo' ? 'is-redo' : sub.status === 'graded' ? 'is-graded' : 'is-sub';
            const bTxt = !sub ? '미제출' : sub.status === 'redo' ? '다시제출 요청' : sub.status === 'graded' ? '채점완료' : '제출완료';
            const kindTxt = a.kind === 'worksheet' ? '📝 워크시트' : a.kind === 'quiz' ? (a.liveQuiz?.active ? '🔴 실시간 퀴즈' : '⚡ 퀴즈') : '📎 일반과제';
            return `
              <article class="st-card" role="button" tabindex="0" data-open-work="${a.id}">
                <div class="st-card-meta">
                  <span>${kindTxt}${a.subject ? ` · ${esc(a.subject)}` : ''}</span>
                  <span class="st-badge ${bCls}">${bTxt}</span>
                </div>
                <h3>${esc(a.title)}</h3>
                <p>${esc(a.description || '카드를 터치해 내용을 확인하세요.')}</p>
                <div class="st-card-meta">
                  <span>${a.dueDate ? `마감: ${esc(a.dueDate)}` : '마감 없음'}</span>
                  ${sub?.feedback ? `<span style="color:#198bd2;">💬 피드백 도착</span>` : `<span style="color:#7c7262;">열기 ›</span>`}
                </div>
              </article>
            `;
          }).join('')}
        </div>
      `}
    </main>
  `;

  bindHeaderEvents();

  const dismissBtn = appEl.querySelector('#btn-dismiss-cy-alert');
  if (dismissBtn) {
    dismissBtn.onclick = () => {
      cyberTerminateMsg = '';
      renderSectionView(me);
    };
  }

  appEl.querySelectorAll('[data-st-nav]').forEach((b) => {
    b.onclick = () => {
      activeView = b.dataset.stNav;
      render();
    };
  });

  bindQuestActions(me, m.myQuests);

  appEl.querySelectorAll('[data-enter-cyber]').forEach((b) => {
    b.onclick = () => {
      const site = m.cyberSites.find((x) => x.id === b.dataset.enterCyber);
      if (site) startCyberSession(me, site);
    };
  });

  appEl.querySelectorAll('[data-open-work]').forEach((card) => {
    const open = () => openAssignment(me, card.dataset.openWork, activeView);
    card.onclick = open;
    card.onkeydown = (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        open();
      }
    };
  });
}

/** 사이버지식정보방 입장 및 실행 (앱 내부 풀스크린 뷰어 또는 제어 팝업 창) */
async function startCyberSession(me, site) {
  const cr = classData.cyberRoom || {};
  if (!isStudentCyberAllowed(cr, me)) {
    showStToast('현재 사이버지식정보방 접속이 제한되어 있습니다.');
    return;
  }
  const entryCost = Math.max(0, Number(site.entryCost) || 0);
  const coinPerMin = Math.max(0, Number(site.coinPerMin) ?? 1);
  const timeLimitSec = Math.max(0, Number(site.timeLimitMin) || 0) * 60;
  const openMode = site.openMode === 'popup' ? 'popup' : 'iframe';
  let coins = getStudentCyberCoins(cr, me.id);

  if (coins < entryCost || (coinPerMin > 0 && coins <= entryCost)) {
    showStToast('보유 코인이 부족하여 입장할 수 없습니다.');
    return;
  }

  let popupWin = null;
  if (openMode === 'popup') {
    const w = window.screen.availWidth || window.innerWidth || 1280;
    const h = window.screen.availHeight || window.innerHeight || 800;
    popupWin = window.open(
      site.url,
      'cr2_cyber_popup',
      `width=${w},height=${h},left=0,top=0,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes`
    );
    if (!popupWin) {
      showStToast('팝업이 차단되었습니다! 주소창 우측에서 팝업을 허용한 뒤 다시 눌러주세요.');
      return;
    }
    try {
      popupWin.moveTo(0, 0);
      popupWin.resizeTo(w, h);
      popupWin.focus();
    } catch {}
  }

  cyberTerminateMsg = '';
  coins = Math.max(0, coins - entryCost);

  activeCyberSession = {
    site: { ...site, openMode, entryCost, coinPerMin, timeLimitSec },
    popupWin,
    startedAt: Date.now(),
    elapsedSec: 0,
    chargedMinutes: 0,
    loadCount: 0,
    coins,
    timerId: null,
    worker: null,
    ticking: false,
  };

  playSound('restoreDone');
  await persistCyberState(me.id, {
    active: true,
    siteId: site.id,
    siteTitle: site.title,
    coinsAfter: coins,
  }).catch(() => {});

  if (openMode === 'popup') {
    renderCyberPopupController(me);
  } else {
    renderCyberViewer(me);
  }

  const onTick = async () => {
    if (!activeCyberSession || activeCyberSession.ticking) return;
    activeCyberSession.ticking = true;
    try {
      if (activeCyberSession.site.openMode === 'popup' && activeCyberSession.popupWin && activeCyberSession.popupWin.closed) {
        await terminateCyberSession('', false);
        showStToast('팝업 창이 닫혀 사이버지식정보방 이용을 종료했습니다.');
        return;
      }

      const elapsed = Math.max(0, Math.floor((Date.now() - activeCyberSession.startedAt) / 1000));
      activeCyberSession.elapsedSec = elapsed;
      const sInfo = activeCyberSession.site;

      const timeEl = document.getElementById('st-cyber-time-live');
      if (timeEl) {
        if (sInfo.timeLimitSec > 0) {
          const remain = Math.max(0, sInfo.timeLimitSec - elapsed);
          timeEl.textContent = `⏱ 남은 시간 ${formatMmSs(remain)}`;
        } else {
          timeEl.textContent = `⏱ 이용 중 ${formatMmSs(elapsed)}`;
        }
      }

      if (sInfo.timeLimitSec > 0 && elapsed >= sInfo.timeLimitSec) {
        await terminateCyberSession('지정된 이용 시간이 모두 종료되어 접속을 종료합니다.');
        return;
      }

      const passedMinutes = Math.floor(elapsed / 60);
      if (sInfo.coinPerMin > 0 && passedMinutes > activeCyberSession.chargedMinutes) {
        const deltaMin = passedMinutes - activeCyberSession.chargedMinutes;
        activeCyberSession.chargedMinutes = passedMinutes;
        const nextCoins = Math.max(0, activeCyberSession.coins - sInfo.coinPerMin * deltaMin);
        activeCyberSession.coins = nextCoins;
        const coinEl = document.getElementById('st-cyber-coin-live');
        if (coinEl) coinEl.textContent = `🪙 ${nextCoins}코인`;

        await persistCyberState(me.id, {
          active: nextCoins > 0,
          siteId: sInfo.id,
          siteTitle: sInfo.title,
          coinsAfter: nextCoins,
        }).catch(() => {});

        if (nextCoins <= 0) {
          await terminateCyberSession('보유 코인이 모두 차감되어 접속을 종료합니다.');
          return;
        }
        if (nextCoins <= sInfo.coinPerMin) {
          playSound('tick');
          showStToast(`⚠️ 남은 코인이 ${nextCoins}코인(약 1분 분량)입니다!`);
        }
      }
    } finally {
      if (activeCyberSession) activeCyberSession.ticking = false;
    }
  };

  try {
    const blob = new Blob(['setInterval(() => postMessage(1), 1000);'], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    const worker = new Worker(workerUrl);
    URL.revokeObjectURL(workerUrl);
    worker.onmessage = () => { onTick(); };
    activeCyberSession.worker = worker;
  } catch {
    activeCyberSession.timerId = setInterval(() => { onTick(); }, 1000);
  }
}

/** 제어 팝업 창 이용 중 학생 앱 상태 대시보드 */
function renderCyberPopupController(me) {
  if (!activeCyberSession) return;
  const { site, coins } = activeCyberSession;
  const m = buildStudentDashboardModel(me);

  appEl.innerHTML = `
    ${renderHeader(me, m, false)}
    <main class="st-main">
      <div class="st-work-card" style="text-align:center;align-items:center;padding:42px 24px;gap:16px;">
        <img src="assets/visuals/icon-cyber.svg" alt="" width="72" height="72">
        <h2 style="margin:0;font-size:22px;">🪟 ${esc(site.title)} 이용 중</h2>
        <p style="margin:0;font-size:14.5px;color:#6f675a;line-height:1.6;">
          별도의 제어 팝업 창에서 사이트가 열려 있습니다.<br>
          코인이나 이용 시간이 종료되거나 선생님이 접속을 차단하면 팝업 창이 자동으로 닫힙니다.
        </p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin:4px 0;">
          <span class="st-pill is-coin" id="st-cyber-coin-live" style="font-size:15px;padding:7px 14px;">🪙 ${coins}코인</span>
          <span class="st-cyber-timer-pill" id="st-cyber-time-live" style="font-size:15px;padding:7px 14px;">${site.timeLimitSec > 0 ? `⏱ 남은 시간 ${formatMmSs(site.timeLimitSec)}` : '⏱ 이용 중 00:00'}</span>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-top:6px;">
          <button type="button" class="st-btn is-primary" id="btn-focus-cyber-popup">🪟 팝업 창 앞으로 가져오기</button>
          <button type="button" class="st-btn is-outline" id="btn-exit-cyber">🚪 이용 종료 및 팝업 닫기</button>
        </div>
      </div>
    </main>
  `;

  document.getElementById('st-btn-logout').onclick = () => {
    terminateCyberSession('', true);
    loggedStudentId = null;
    activeAssignmentId = null;
    activeView = 'dashboard';
    saveSession(null);
    render();
  };
  document.getElementById('btn-focus-cyber-popup').onclick = () => {
    if (activeCyberSession?.popupWin && !activeCyberSession.popupWin.closed) {
      activeCyberSession.popupWin.focus();
    } else {
      terminateCyberSession('', false);
    }
  };
  document.getElementById('btn-exit-cyber').onclick = () => {
    terminateCyberSession('', false);
  };
}

/** 학생용 앱 내부 사이버지식정보방 풀스크린 뷰어 (URL 주소 완전 비공개) */
function renderCyberViewer(me) {
  if (!activeCyberSession) return;
  const { site, coins } = activeCyberSession;

  appEl.innerHTML = `
    <div class="st-cyber-viewer">
      <header class="st-cyber-vbar">
        <div class="st-cyber-vleft">
          <img src="assets/visuals/icon-cyber.svg" alt="" width="24" height="24">
          <strong>${esc(site.title)}</strong>
          <span class="st-cyber-vmeta">${site.coinPerMin > 0 ? `분당 ${site.coinPerMin}코인` : '무료'}${site.strictSinglePage ? ' · 🔒 이탈 시 종료' : ''}</span>
        </div>
        <div class="st-cyber-vright">
          <span class="st-pill is-coin" id="st-cyber-coin-live">🪙 ${coins}코인</span>
          <span class="st-cyber-timer-pill" id="st-cyber-time-live">${site.timeLimitSec > 0 ? `⏱ 남은 시간 ${formatMmSs(site.timeLimitSec)}` : '⏱ 이용 중 00:00'}</span>
          <button type="button" class="st-btn is-outline is-sm" id="btn-exit-cyber">🚪 나가기</button>
        </div>
      </header>
      <div class="st-cyber-frame-wrap">
        <iframe
          id="st-cyber-frame"
          class="st-cyber-frame"
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerpolicy="no-referrer"
          title="${esc(site.title)}"
        ></iframe>
      </div>
    </div>
  `;

  const frame = document.getElementById('st-cyber-frame');
  frame.onload = () => {
    if (!activeCyberSession) return;
    activeCyberSession.loadCount += 1;
    if (activeCyberSession.site.strictSinglePage && activeCyberSession.loadCount >= 2) {
      terminateCyberSession('지정된 사이트 주소를 벗어나 접속을 종료합니다.');
    }
  };
  frame.src = site.url;

  document.getElementById('btn-exit-cyber').onclick = () => {
    terminateCyberSession('', false);
  };
}

/** 4. 과제 수행 · 채점 확인 · 친구 작품 열람 화면 */
function renderAssignmentWork(me, asg) {
  const m = buildStudentDashboardModel(me);
  const existingSub = allSubmissions[asg.id]?.[me.id] || null;
  const isGalleryView = assignmentOriginView === 'gallery' && asg.visibility === 'shared';
  const locked = Boolean(asg.closed) || (existingSub?.status === 'graded');
  const canAttachPhoto = asg.kind === 'general' || Boolean(asg.allowedTools?.photo);

  const grades = existingSub?.questionGrades ? Object.entries(existingSub.questionGrades) : [];
  const totalScore = grades.reduce((sum, [, g]) => sum + (Number(g.score) || 0), 0);
  const maxScore = grades.reduce((sum, [, g]) => sum + (Number(g.maxScore) || 0), 0);

  appEl.innerHTML = `
    ${renderHeader(me, m, true)}
    <main class="st-main">
      <div class="st-work-card">
        <div class="st-work-head">
          <button type="button" class="st-btn is-outline is-sm" id="st-btn-back">
            ← ${assignmentOriginView === 'dashboard' ? '대시보드로' : '목록으로'}
          </button>
          <h2>${esc(asg.title)}</h2>
          <span class="st-badge ${!existingSub ? 'is-todo' : existingSub.status === 'redo' ? 'is-redo' : existingSub.status === 'graded' ? 'is-graded' : 'is-sub'}">
            ${!existingSub ? '미제출' : existingSub.status === 'redo' ? '다시제출 요청' : existingSub.status === 'graded' ? '채점완료' : '제출완료'}
          </span>
        </div>

        ${asg.description ? `<p style="margin:0;font-size:14.5px;line-height:1.55;color:#4f4638;">${esc(asg.description).replace(/\n/g, '<br>')}</p>` : ''}

        ${existingSub && (existingSub.feedback || grades.length > 0) ? `
          <div class="st-teacher-fb">
            ${grades.length > 0 ? `<div><strong>채점 점수: ${totalScore} / ${maxScore}점</strong></div>` : ''}
            ${existingSub.feedback ? `<div>💬 선생님 피드백: ${esc(existingSub.feedback)}</div>` : ''}
            ${grades.filter(([, g]) => g.feedback).map(([qid, g]) => `
              <div style="font-size:13px;margin-top:4px;">· 문항(${esc(qid)}): ${esc(g.feedback)} (${g.score}/${g.maxScore}점)</div>
            `).join('')}
          </div>
        ` : ''}

        ${isGalleryView ? renderSharedGalleryHtml(asg) : ''}

        ${!isGalleryView && asg.kind === 'worksheet' ? `
          <div>
            <div style="font-size:13px;font-weight:700;color:#6f6658;margin-bottom:8px;">
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
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
              <strong style="font-size:14px;">📷 사진 · 파일 첨부 (${draftFiles.length}개)</strong>
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
                    ${f.mimeType?.startsWith('image/') ? `<img src="${esc(f.thumbnailUrl || f.viewUrl)}" alt="${esc(f.name)}">` : `<div style="height:110px;display:grid;place-items:center;font-size:32px;">📄</div>`}
                    <span title="${esc(f.name)}">${esc(f.name)}</span>
                    <div class="st-file-links">
                      <a href="${esc(f.viewUrl)}" target="_blank" rel="noopener noreferrer">열람</a>
                      <a href="${esc(f.downloadUrl || f.viewUrl)}" download="${esc(f.name)}" target="_blank" rel="noopener noreferrer">다운로드</a>
                      ${!locked ? `<button type="button" data-rm-file="${idx}" style="margin-left:auto;background:none;color:#c92646;font-weight:800;">삭제</button>` : ''}
                    </div>
                  </div>
                `).join('')}
              </div>
            ` : `<p style="margin:0;font-size:13px;color:#8a8072;">첨부된 파일이 없습니다.</p>`}
          </div>
        ` : ''}

        ${!isGalleryView && !locked ? `
          <div style="display:flex;justify-content:flex-end;gap:10px;padding-top:10px;border-top:1px solid #f0ede3;">
            <button type="button" class="st-btn is-primary" id="st-btn-submit" style="min-width:200px;">
              ${existingSub ? '수정하여 다시 제출하기' : '과제 제출하기'}
            </button>
          </div>
        ` : ''}
      </div>
    </main>
  `;

  bindHeaderEvents();

  appEl.querySelector('#st-btn-back').onclick = () => {
    activeAssignmentId = null;
    activeWorksheetCtrl = null;
    activeView = assignmentOriginView || 'dashboard';
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

  const submitBtn = appEl.querySelector('#st-btn-submit');
  if (submitBtn) {
    submitBtn.onclick = async () => {
      submitBtn.disabled = true;
      try {
        const payload = {
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
        playSound('slotDone');
        showStToast('제출 완료! 대시보드로 이동합니다.');
        if (!(asg.kind === 'quiz' && asg.quizMode === 'live' && asg.liveQuiz?.active)) {
          activeAssignmentId = null;
          activeWorksheetCtrl = null;
          activeView = 'dashboard';
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
              <input type="text" data-q-short="${q.id}" value="${esc(curAns)}" ${locked ? 'readonly' : ''} placeholder="정답을 입력하세요" style="min-height:48px;padding:0 14px;border:2px solid #d9d3c3;border-radius:10px;font-size:16px;">
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
        <div class="st-file-card" style="padding:14px;">
          <strong>${student.number}번 ${esc(student.name)}</strong>
          ${asg.kind === 'worksheet' ? `<canvas data-gal-canvas="${student.id}" style="width:100%;height:auto;border-radius:8px;"></canvas>` : ''}
          ${sub.text ? `<p style="margin:0;font-size:13.5px;">${esc(sub.text)}</p>` : ''}
          ${(sub.files || []).filter((f) => f.mimeType?.startsWith('image/')).map((f) => `<img src="${esc(f.thumbnailUrl || f.viewUrl)}" alt="">`).join('')}
        </div>
      `).join('')}
    </div>
  `;
}

async function bootstrapStudentApp() {
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
            motto: data.motto || '',
            starsPerEgg: Math.max(5, Number(data.starsPerEgg) || 10),
            driveBridgeUrl: data.driveBridgeUrl || '',
            driveFolderName: data.driveFolderName || '클래스레볼루션2',
            students: Array.isArray(data.students) ? data.students : [],
            groups: Array.isArray(data.groups) ? data.groups : [],
            growth: data.growth || { eggs: 0, pendingTrailCount: 0, goals: [] },
            wbScoreboard: data.wbScoreboard || { baseGroupMode: 'sum', specialGroupScores: {} },
            assignments: Array.isArray(data.assignments) ? data.assignments : [],
            selfChecks: Array.isArray(data.selfChecks) ? data.selfChecks : [],
            cyberRoom: data.cyberRoom || classData.cyberRoom,
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

  // 서버 미연결 시 같은 브라우저 로컬 IndexedDB 폴백
  dataMode = 'local';
  await store.init();
  const syncLocal = () => {
    const st = store.getState();
    classData = {
      className: st.classInfo?.name || '우리 반',
      motto: st.classInfo?.motto || '',
      starsPerEgg: Math.max(5, Number(st.classInfo?.starsPerEgg) || 10),
      driveBridgeUrl: st.cloudConfig?.driveBridgeUrl || '',
      driveFolderName: st.cloudConfig?.driveFolderName || '클래스레볼루션2',
      students: (st.students || []).filter((s) => !s.trashed),
      groups: st.groups || [],
      growth: {
        eggs: Number(st.growth?.eggs) || 0,
        pendingTrailCount: Array.isArray(st.growth?.pendingTrail) ? st.growth.pendingTrail.length : 0,
        goals: Array.isArray(st.growth?.goals) ? st.growth.goals : [],
      },
      wbScoreboard: st.wbScoreboard || { baseGroupMode: 'sum', specialGroupScores: {} },
      assignments: st.assignments || [],
      selfChecks: st.selfChecks || [],
      cyberRoom: st.cyberRoom || classData.cyberRoom,
    };
    allSubmissions = st.submissions || {};
    render();
  };
  store.subscribe(syncLocal);
  syncLocal();
}

bootstrapStudentApp();
