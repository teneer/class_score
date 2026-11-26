// 공통 점수 부여 모달(한 장 주기 / 여러 장 주기, 으쓱 파랑 / 머쓱 분홍) + 원본 영상 충실 연출 + 하단 검정 토스트

import { store, getStillAvatarUrl, getFxAvatarUrl, uid } from './store.js';
import { applyStudentScoreBatch } from './score-engine.js';
import { playSound } from './audio.js';

let getActiveModeFn = () => 'students';
export function setActiveModeProvider(fn) {
  getActiveModeFn = fn;
}

const fxQueue = [];
let fxPlaying = false;
let fxTimer = null;
let fxStepTimers = [];

export function isFxStagePlaying() {
  const stage = document.getElementById('fx-stage');
  return Boolean(fxPlaying || (stage && !stage.hidden));
}

/** 연출 내부 단계 타이머 일괄 정리 */
function clearFxStepTimers() {
  for (const id of fxStepTimers) clearTimeout(id);
  fxStepTimers = [];
}

/** 연출 내부 단계 타이머 등록 */
function scheduleFxStep(fn, delay) {
  const id = setTimeout(fn, delay);
  fxStepTimers.push(id);
  return id;
}

/** 하단 토스트 표시 (일반 알림용) */
export function showToast({ title, detail = '', tone = 'info', duration = 3200 }) {
  const dock = document.getElementById('toast-dock');
  if (!dock) return;
  const card = document.createElement('div');
  card.className = `toast-card is-${tone}`;
  card.innerHTML = `
    <div class="toast-body">
      <strong>${escapeHtml(title)}</strong>
      ${detail ? `<span>${escapeHtml(detail)}</span>` : ''}
    </div>
  `;
  dock.appendChild(card);
  setTimeout(() => {
    card.style.opacity = '0';
    card.style.transition = 'opacity 0.25s';
    setTimeout(() => card.remove(), 260);
  }, duration);
}

/** 원본 여러 장 주기 중앙 검정 카운터 토스트 (1학생화면.mp4 01:30, 01:40 / 3수업도구.mp4 01:05) */
export function showCounterToast({ positive = true, totalCount = 1, duration = 2600 }) {
  const dock = document.getElementById('toast-dock');
  if (!dock) return;
  const card = document.createElement('div');
  card.className = 'toast-card is-counter';
  card.innerHTML = `
    <i class="sp-icon ${positive ? 'sp-star-blue' : 'sp-cloud-red'}" style="transform:scale(1.25);" aria-hidden="true"></i>
    <span class="toast-counter-num">${totalCount}</span>
    <button type="button" class="toast-counter-close" aria-label="닫기">&times;</button>
  `;
  const removeNow = () => card.remove();
  card.querySelector('.toast-counter-close').onclick = removeNow;
  dock.appendChild(card);
  setTimeout(() => {
    card.style.opacity = '0';
    card.style.transition = 'opacity 0.25s';
    setTimeout(removeNow, 260);
  }, duration);
}

/** 점수/황금알/목표 결과에 맞는 원본 연출 큐 등록 */
export function presentOutcome(outcome, { forceToast = false } = {}) {
  if (!outcome) return;
  const mode = getActiveModeFn();
  const useToast = forceToast || (mode !== 'students' && mode !== 'seats' && mode !== 'growth' && mode !== 'whiteboard');

  if (outcome.kind === 'score') {
    const isPos = outcome.delta > 0;
    const totalPoints = Math.abs(outcome.delta) * (outcome.targets?.length || 1);

    if (useToast) {
      playSound(isPos ? 'plusBig' : 'minusBig');
      showCounterToast({ positive: isPos, totalCount: totalPoints });
    } else {
      fxQueue.push({
        type: isPos ? 'positive' : 'negative',
        delta: outcome.delta,
        reason: outcome.reason,
        targets: outcome.targets,
      });
    }

    if (outcome.eggsDelta > 0) {
      if (!useToast) {
        fxQueue.push({
          type: 'egg',
          delta: outcome.eggsDelta,
          eggsNow: outcome.eggsNow,
        });
      }
      // 개인점수 누적 황금알 상승 사운드는 추후 전용 사운드 추가 전까지 재생하지 않음
    } else if (outcome.eggsDelta < 0) {
      playSound('eggDown');
    }

    if (Array.isArray(outcome.achievedGoals)) {
      for (const goal of outcome.achievedGoals) {
        fxQueue.push({ type: 'goal', goal, eggsNow: outcome.eggsNow });
      }
    }
  } else if (outcome.kind === 'egg') {
    // 황금알 직접 부여/차감: 목표 달성 시 회전 갈색 원 목표 달성 연출, 눈금 이동 사운드는 growth 뷰 루프에서 매 눈금마다 재생
    if (Array.isArray(outcome.achievedGoals) && outcome.achievedGoals.length > 0) {
      for (const goal of outcome.achievedGoals) {
        fxQueue.push({ type: 'goal', goal, eggsNow: outcome.eggsNow });
      }
    } else if (mode !== 'growth' && mode !== 'whiteboard') {
      playSound(outcome.delta > 0 ? 'eggUp' : 'eggDown');
    }
  }

  runNextFx();
}

/** 목표 달성 축하 연출 단독 미리보기 */
export function playGoalCelebration(goal, eggsNow) {
  fxQueue.push({ type: 'goal', goal, eggsNow });
  runNextFx();
}

function runNextFx() {
  if (fxPlaying || fxQueue.length === 0) return;
  const item = fxQueue.shift();
  const stage = document.getElementById('fx-stage');
  if (!stage) return;

  fxPlaying = true;
  clearTimeout(fxTimer);
  clearFxStepTimers();
  stage.hidden = false;
  stage.className = 'fx-stage';

  let duration = 2600;

  if (item.type === 'positive') {
    // 으쓱(상점) 4.5초 타임라인: 10명 초과 시 '외 n명' 없이 한 번에 최대 10명 폭으로 왼쪽→오른쪽 끝까지 가로 스크롤
    stage.classList.add('fx-positive');
    const perStudent = Math.abs(Math.trunc(Number(item.delta) || 1));
    const count = item.targets.length;
    const totalScore = perStudent * count;
    const allTargets = item.targets;
    const N = Math.max(1, allTargets.length);
    const needsScroll = count > 10;
    const initialVisible = Math.min(10, N);
    const appearStep = initialVisible > 1 ? Math.min(0.10, 0.45 / (initialVisible - 1)) : 0;
    playSound('plusBig');
    const cheers = ['열심히 한 보람이 있네요', '참 잘했어요', '정말 멋져요'];
    const cheerText = cheers[count % cheers.length];
    const isCompact = count >= 6;
    stage.innerHTML = `
      <div class="fx-heading">
        <div class="fx-medal-wrap">
          <div class="fx-wing-l" aria-hidden="true"></div>
          <div class="fx-wing-r" aria-hidden="true"></div>
          <div class="fx-medal-disc">
            <div class="fx-medal-star"></div>
          </div>
          <div class="fx-medal-spark s1" aria-hidden="true"></div>
          <div class="fx-medal-spark s2" aria-hidden="true"></div>
        </div>
        <div class="fx-score-banner">
          <strong class="fx-score-total">+${perStudent}점</strong>
        </div>
        <h2 class="fx-reason-title">${escapeHtml(item.reason)}</h2>
      </div>
      <div class="fx-actors-viewport ${needsScroll ? 'is-scrolling' : ''}">
        <div class="fx-actors-row ${isCompact ? 'is-compact' : ''} ${needsScroll ? 'is-marquee-track' : ''}">
          ${allTargets.map((t, idx) => `
            <div class="fx-actor-card" data-actor-idx="${idx}" style="--flip-delay:${(2.10 + Math.min(idx, 9) * appearStep).toFixed(3)}s;">
              <div class="avatar-fx-sprite fx-actor-anim" style="background-image:url('${getFxAvatarUrl(t.avatarId)}')"></div>
              <span class="fx-actor-name">${escapeHtml(t.name)}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="fx-bottom-cheer">
        <div class="fx-cheer-pill">" ${cheerText} "</div>
        <div class="fx-mascot fx-positive-mascot" aria-hidden="true"></div>
      </div>
    `;

    const cards = [...stage.querySelectorAll('.fx-actor-card')];
    duration = 4500;

    if (needsScroll) {
      const viewportEl = stage.querySelector('.fx-actors-viewport');
      const trackEl = stage.querySelector('.fx-actors-row');
      // 2.65s ~ 4.25s: 왼쪽 1번 학생부터 오른쪽 끝 학생까지 효과 시간 내 가로 스크롤
      scheduleFxStep(() => {
        if (!viewportEl || !trackEl) return;
        const dist = Math.max(0, trackEl.scrollWidth - viewportEl.clientWidth);
        if (dist > 0) {
          trackEl.style.transition = 'transform 1.60s cubic-bezier(0.25, 0.08, 0.25, 1)';
          trackEl.style.transform = `translate3d(-${dist}px, 0, 0)`;
        }
      }, 2650);

      // 스크롤 진행에 맞춰 1번~끝 학생 순차 하이라이트
      const hiStep = N > 1 ? 1500 / (N - 1) : 0;
      cards.forEach((card, idx) => {
        const startAt = Math.round(2700 + idx * hiStep);
        scheduleFxStep(() => card.classList.add('is-white-flash'), startAt);
        scheduleFxStep(() => card.classList.remove('is-white-flash'), startAt + 140);
      });
    } else {
      const hi1Step = N > 1 ? Math.min(110, 380 / (N - 1)) : 0;
      const hi2Step = N > 1 ? Math.min(100, 340 / (N - 1)) : 0;
      cards.forEach((card, idx) => {
        const startAt = Math.round(3000 + idx * hi1Step);
        scheduleFxStep(() => card.classList.add('is-white-flash'), startAt);
        scheduleFxStep(() => card.classList.remove('is-white-flash'), startAt + 140);
      });
      cards.forEach((card, idx) => {
        const startAt = Math.round(3850 + idx * hi2Step);
        scheduleFxStep(() => card.classList.add('is-white-flash'), startAt);
        scheduleFxStep(() => card.classList.remove('is-white-flash'), startAt + 140);
      });
    }
  } else if (item.type === 'negative') {
    // 머쓱(감점) 4.0초 타임라인: 10명 초과 시 '외 n명' 없이 한 번에 최대 10명 폭으로 왼쪽→오른쪽 끝까지 가로 스크롤
    stage.classList.add('fx-negative');
    const perStudent = Math.abs(Math.trunc(Number(item.delta) || 1));
    const count = item.targets.length;
    const totalScore = perStudent * count;
    const allTargets = item.targets;
    const N = Math.max(1, allTargets.length);
    const needsScroll = count > 10;
    const initialVisible = Math.min(10, N);
    const appearStep = initialVisible > 1 ? Math.min(0.10, 0.45 / (initialVisible - 1)) : 0;
    playSound('minusBig');
    const warns = ['고쳐주세요', '다음엔 잘 해봐요'];
    const warnText = warns[count % warns.length];
    const isCompact = count >= 6;
    stage.innerHTML = `
      <div class="fx-storm-rain" aria-hidden="true">
        <div class="fx-storm-rain-sprite r1"></div>
        <div class="fx-storm-rain-sprite r2"></div>
        <div class="fx-storm-rain-sprite r3"></div>
      </div>
      <div class="fx-storm-clouds" aria-hidden="true">
        <div class="fx-storm-cloud-main"></div>
      </div>
      <div class="fx-heading">
        <div class="fx-storm-badge-wrap" aria-hidden="true"></div>
        <div class="fx-score-banner">
          <strong class="fx-score-total">-${perStudent}점</strong>
        </div>
        <h2 class="fx-reason-title">${escapeHtml(item.reason)}</h2>
      </div>
      <div class="fx-actors-viewport ${needsScroll ? 'is-scrolling' : ''}">
        <div class="fx-actors-row ${isCompact ? 'is-compact' : ''} ${needsScroll ? 'is-marquee-track' : ''}">
          ${allTargets.map((t, idx) => `
            <div class="fx-actor-card" data-actor-idx="${idx}" style="--flip-delay:${(1.12 + Math.min(idx, 9) * appearStep).toFixed(3)}s;">
              <img class="fx-still-img fx-actor-still" src="${getStillAvatarUrl(t.avatarId)}" alt="${escapeAttr(t.name)}">
              <span class="fx-actor-name">${escapeHtml(t.name)}</span>
            </div>
          `).join('')}
        </div>
      </div>
      <div class="fx-bottom-cheer">
        <div class="fx-cheer-pill">" ${warnText} "</div>
        <div class="fx-mascot fx-negative-mascot" aria-hidden="true"></div>
      </div>
    `;

    const cards = [...stage.querySelectorAll('.fx-actor-card')];
    duration = 4000;

    if (needsScroll) {
      const viewportEl = stage.querySelector('.fx-actors-viewport');
      const trackEl = stage.querySelector('.fx-actors-row');
      // 1.70s ~ 3.70s: 왼쪽 1번 학생부터 오른쪽 끝 학생까지 효과 시간 내 가로 스크롤
      scheduleFxStep(() => {
        if (!viewportEl || !trackEl) return;
        const dist = Math.max(0, trackEl.scrollWidth - viewportEl.clientWidth);
        if (dist > 0) {
          trackEl.style.transition = 'transform 2.00s cubic-bezier(0.25, 0.08, 0.25, 1)';
          trackEl.style.transform = `translate3d(-${dist}px, 0, 0)`;
        }
      }, 1700);

      const hiStep = N > 1 ? 1850 / (N - 1) : 0;
      cards.forEach((card, idx) => {
        const startAt = Math.round(1750 + idx * hiStep);
        scheduleFxStep(() => card.classList.add('is-white-flash'), startAt);
        scheduleFxStep(() => card.classList.remove('is-white-flash'), startAt + 160);
      });
    } else {
      const hiStep = N > 1 ? Math.min(150, 620 / (N - 1)) : 0;
      cards.forEach((card, idx) => {
        const startAt = Math.round(2050 + idx * hiStep);
        scheduleFxStep(() => card.classList.add('is-white-flash'), startAt);
        scheduleFxStep(() => card.classList.remove('is-white-flash'), startAt + 175);
      });
      cards.forEach((card, idx) => {
        const startAt = Math.round(3000 + idx * hiStep);
        scheduleFxStep(() => card.classList.add('is-white-flash'), startAt);
        scheduleFxStep(() => card.classList.remove('is-white-flash'), startAt + 175);
      });
    }
  } else if (item.type === 'egg') {
    // 3수업도구.mp4 00:31~00:33 — 검정 배경 + 흰 날개 달린 황금알 획득 연출 (추후 전용 사운드 추가 전까지 무음)
    stage.classList.add('fx-egg');
    duration = 2500;
    stage.innerHTML = `
      <div class="fx-winged-egg-wrap">
        <div class="fx-egg-wing is-left" aria-hidden="true"></div>
        <div class="fx-egg-wing is-right" aria-hidden="true"></div>
        <div class="fx-egg-body">
          <span>${item.eggsNow}</span>
        </div>
      </div>
      <div class="fx-egg-caption">황금알 ${item.delta}개를<br>획득했습니다!</div>
    `;
  } else if (item.type === 'goal') {
    // 1학생화면.mp4 00:16~00:20 — 회전 등장하는 큰 갈색 원 + 별코인 + 황금알
    stage.classList.add('fx-goal');
    playSound('successBig');
    duration = 5200;
    stage.innerHTML = `
      <div class="fx-goal-circle-wrap">
        <button type="button" class="fx-goal-close-btn" id="btn-fx-goal-close" aria-label="닫기">&times;</button>
        <div class="fx-goal-circle">
          <div class="fx-goal-coin-wrap">
            <div class="fx-goal-spark s1" aria-hidden="true"></div>
            <div class="fx-goal-spark s2" aria-hidden="true"></div>
            <div class="fx-goal-spark s3" aria-hidden="true"></div>
            <div class="fx-goal-big-coin" aria-hidden="true"></div>
          </div>
          <div class="fx-goal-label">황금알 목표 달성!!!</div>
          <div class="fx-goal-reward-name">${escapeHtml(item.goal.reward || '우리 반 보상')}</div>
          <div class="fx-goal-big-egg">
            <span>${item.goal.targetEggs}</span>
          </div>
        </div>
      </div>
    `;
  }

  const finish = () => {
    clearTimeout(fxTimer);
    clearFxStepTimers();
    stage.onclick = null;
    stage.hidden = true;
    fxPlaying = false;
    if ((item.type === 'positive' || item.type === 'negative') && Array.isArray(item.targets) && item.targets.length > 0) {
      window.dispatchEvent(new CustomEvent('class123:award-finished', {
        detail: {
          type: item.type,
          studentIds: item.targets.map((t) => t.id),
          delta: item.delta,
        },
      }));
    }
    runNextFx();
  };

  stage.onclick = finish;
  fxTimer = setTimeout(finish, duration);
}

/** 즐겨찾기(황금 북마크 리본) vs 최근 사용(시계 히스토리) 전용 구분 SVG 아이콘 */
const SVG_BOOKMARK_FILLED = `<svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M5 2.5A1.5 1.5 0 0 1 6.5 1h7A1.5 1.5 0 0 1 15 2.5v15.05a.75.75 0 0 1-1.16.63L10 15.66l-3.84 2.52A.75.75 0 0 1 5 17.55V2.5Z"/></svg>`;
const SVG_BOOKMARK_OUTLINE = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 2.75A1.25 1.25 0 0 1 6.75 1.5h6.5a1.25 1.25 0 0 1 1.25 1.25v14.5L10 14.3l-4.5 2.95V2.75Z"/></svg>`;
const SVG_CLOCK_RECENT = `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.2 6.5A7.3 7.3 0 1 1 2.8 10"/><path d="M3 3.2v3.5h3.5"/><path d="M10 6.2v4.1l2.7 1.7"/></svg>`;
const SVG_SPARK_PRESET = `<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M7 8h6M7 12h4"/></svg>`;

function isSameSet(a, b) {
  return (
    a.type === b.type &&
    Math.abs(Math.trunc(Number(a.points) || 1)) === Math.abs(Math.trunc(Number(b.points) || 1)) &&
    String(a.reason || '').trim() === String(b.reason || '').trim()
  );
}

/**
 * 설정창 및 점수 부여창에서 호출하는 으쓱·머쓱 즐겨찾기 카드 & 세트 미리 등록/관리 모달
 */
export function openScoreCardManagerModal(initialTab = 'pos', onChanged = null) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  let activeTab = initialTab === 'neg' ? 'neg' : initialTab === 'sets' ? 'sets' : 'pos';
  let draftSetType = 'positive';
  let draftSetPoints = 2;

  const close = () => {
    backdrop.remove();
    if (typeof onChanged === 'function') onChanged();
  };

  const renderModal = () => {
    const st = store.getState();
    const favPos = st.reasons.favoritesPositive || [];
    const favNeg = st.reasons.favoritesNegative || [];
    const favSets = st.reasons.favoriteSets || [];
    const isCardTab = activeTab === 'pos' || activeTab === 'neg';
    const isPosTab = activeTab === 'pos';
    const curCards = isPosTab ? favPos : favNeg;
    const curPresets = (isPosTab ? st.reasons.positivePresets : st.reasons.negativePresets) || [];
    const unaddedPresets = curPresets.filter((p) => !curCards.includes(p));

    backdrop.innerHTML = `
      <div class="dialog-card is-wide card-mgr-dialog">
        <div class="dialog-header">
          <h2>으쓱·머쓱 즐겨찾기 카드 및 세트 등록</h2>
          <button type="button" class="dialog-close" aria-label="닫기">&times;</button>
        </div>
        <div class="dialog-body card-mgr-body">
          <div class="card-mgr-tabs">
            <button type="button" class="card-mgr-tab is-pos ${activeTab === 'pos' ? 'is-active' : ''}" data-mgr-tab="pos">
              <i class="sp-icon sp-star-blue" style="transform:scale(0.75);" aria-hidden="true"></i>
              <span>으쓱 카드 (${favPos.length})</span>
            </button>
            <button type="button" class="card-mgr-tab is-neg ${activeTab === 'neg' ? 'is-active' : ''}" data-mgr-tab="neg">
              <i class="sp-icon sp-cloud-red" style="transform:scale(0.75);" aria-hidden="true"></i>
              <span>머쓱 카드 (${favNeg.length})</span>
            </button>
            <button type="button" class="card-mgr-tab is-sets ${activeTab === 'sets' ? 'is-active' : ''}" data-mgr-tab="sets">
              <span class="mgr-tab-bm">${SVG_BOOKMARK_FILLED}</span>
              <span>즐겨찾기 세트 (${favSets.length})</span>
            </button>
          </div>

          ${isCardTab ? `
            <p class="card-mgr-desc">
              여기서 등록한 <strong>${isPosTab ? '으쓱(상점)' : '머쓱(감점)'} 카드</strong>는 점수 부여 창의 <strong>즐겨찾기 카드</strong> 영역에 항상 나타납니다.
            </p>
            <form class="card-mgr-add-row" id="form-mgr-add-card">
              <input type="text" id="mgr-new-card-text" maxlength="50" placeholder="${isPosTab ? '새 으쓱 카드 문구 입력 (예: 발표를 멋지게 했어요)' : '새 머쓱 카드 문구 입력 (예: 수업 시간에 집중이 필요해요)'}" required>
              <button type="submit" class="btn-yellow">+ 즐겨찾기에 등록</button>
            </form>

            <div class="card-mgr-list">
              ${curCards.length === 0 ? `
                <div class="card-mgr-empty">아직 등록된 ${isPosTab ? '으쓱' : '머쓱'} 즐겨찾기 카드가 없습니다. 위 입력창에서 카드를 등록해보세요.</div>
              ` : curCards.map((text, idx) => `
                <div class="card-mgr-item">
                  <span class="card-mgr-bm-icon">${SVG_BOOKMARK_FILLED}</span>
                  <input type="text" class="card-mgr-edit-input" data-mgr-edit-idx="${idx}" value="${escapeAttr(text)}" maxlength="50">
                  <div class="card-mgr-actions">
                    <button type="button" class="btn-outline card-mgr-mini" data-mgr-save-idx="${idx}">수정저장</button>
                    <button type="button" class="btn-outline card-mgr-mini" data-mgr-up="${idx}" ${idx === 0 ? 'disabled' : ''} title="위로">▲</button>
                    <button type="button" class="btn-outline card-mgr-mini" data-mgr-down="${idx}" ${idx === curCards.length - 1 ? 'disabled' : ''} title="아래로">▼</button>
                    <button type="button" class="btn-danger-outline card-mgr-mini" data-mgr-del="${idx}">삭제</button>
                  </div>
                </div>
              `).join('')}
            </div>

            ${unaddedPresets.length > 0 ? `
              <div class="card-mgr-presets-box">
                <span class="card-mgr-presets-label">추천 문구 빠른 등록:</span>
                <div class="card-mgr-preset-chips">
                  ${unaddedPresets.map((p) => `
                    <button type="button" class="card-mgr-chip" data-mgr-quick-add="${escapeAttr(p)}">+ ${escapeHtml(p)}</button>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          ` : `
            <p class="card-mgr-desc">
              자주 쓰는 <strong>종류(으쓱/머쓱) + 점수 + 사유</strong> 조합을 <strong>즐겨찾기 세트</strong>로 등록하면 점수 부여 창 좌측 상단 전용 공간에 고정됩니다.
            </p>
            <form class="card-mgr-set-form" id="form-mgr-add-set">
              <select id="mgr-set-type">
                <option value="positive" ${draftSetType === 'positive' ? 'selected' : ''}>으쓱 (+상점)</option>
                <option value="negative" ${draftSetType === 'negative' ? 'selected' : ''}>머쓱 (-감점)</option>
              </select>
              <input type="number" id="mgr-set-pts" min="1" max="99" value="${draftSetPoints}" title="1인당 점수">
              <input type="text" id="mgr-set-reason" maxlength="50" placeholder="세트 사유 입력 (예: 모둠 활동 적극 협력)" required>
              <button type="submit" class="btn-yellow">+ 세트 등록</button>
            </form>

            <div class="card-mgr-list">
              ${favSets.length === 0 ? `
                <div class="card-mgr-empty">등록된 즐겨찾기 세트가 없습니다. 위에서 등록하거나 최근 사용 세트의 북마크 아이콘을 눌러 추가하세요.</div>
              ` : favSets.map((sItem, idx) => {
                const sPos = sItem.type !== 'negative';
                const pts = Math.max(1, Math.trunc(Number(sItem.points) || 1));
                return `
                  <div class="card-mgr-item">
                    <span class="card-mgr-bm-icon">${SVG_BOOKMARK_FILLED}</span>
                    <span class="composer-history-badge ${sPos ? 'is-pos' : 'is-neg'}">${sPos ? '으쓱' : '머쓱'} ${sPos ? '+' : '-'}${pts}점</span>
                    <span class="card-mgr-set-reason">${escapeHtml(sItem.reason)}</span>
                    <div class="card-mgr-actions">
                      <button type="button" class="btn-outline card-mgr-mini" data-set-up="${idx}" ${idx === 0 ? 'disabled' : ''} title="위로">▲</button>
                      <button type="button" class="btn-outline card-mgr-mini" data-set-down="${idx}" ${idx === favSets.length - 1 ? 'disabled' : ''} title="아래로">▼</button>
                      <button type="button" class="btn-danger-outline card-mgr-mini" data-set-del="${idx}">삭제</button>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>
          `}
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn-yellow" data-mgr-close>완료</button>
        </div>
      </div>
    `;

    backdrop.querySelector('.dialog-close').onclick = close;
    backdrop.querySelector('[data-mgr-close]').onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

    backdrop.querySelectorAll('[data-mgr-tab]').forEach((b) => {
      b.onclick = () => {
        activeTab = b.dataset.mgrTab;
        renderModal();
      };
    });

    if (isCardTab) {
      const key = isPosTab ? 'favoritesPositive' : 'favoritesNegative';
      const presetKey = isPosTab ? 'positivePresets' : 'negativePresets';

      backdrop.querySelector('#form-mgr-add-card').onsubmit = async (e) => {
        e.preventDefault();
        const val = String(backdrop.querySelector('#mgr-new-card-text').value || '').trim();
        if (!val) return;
        await store.update((draft) => {
          const arr = draft.reasons[key] || [];
          if (!arr.includes(val)) {
            draft.reasons[key] = [val, ...arr];
          }
          const pArr = draft.reasons[presetKey] || [];
          if (!pArr.includes(val)) {
            draft.reasons[presetKey] = [...pArr, val];
          }
        });
        showToast({ title: `'${val}' 카드를 즐겨찾기에 등록했습니다.`, tone: 'plus' });
        renderModal();
      };

      backdrop.querySelectorAll('[data-mgr-quick-add]').forEach((b) => {
        b.onclick = async () => {
          const val = b.dataset.mgrQuickAdd;
          if (!val) return;
          await store.update((draft) => {
            const arr = draft.reasons[key] || [];
            if (!arr.includes(val)) draft.reasons[key] = [...arr, val];
          });
          renderModal();
        };
      });

      backdrop.querySelectorAll('[data-mgr-save-idx]').forEach((b) => {
        b.onclick = async () => {
          const idx = Number(b.dataset.mgrSaveIdx);
          const inp = backdrop.querySelector(`[data-mgr-edit-idx="${idx}"]`);
          const nextVal = String(inp?.value || '').trim();
          if (!nextVal) return;
          await store.update((draft) => {
            const arr = [...(draft.reasons[key] || [])];
            if (idx >= 0 && idx < arr.length) {
              arr[idx] = nextVal;
              draft.reasons[key] = Array.from(new Set(arr));
            }
          });
          showToast({ title: '카드 문구를 수정했습니다.', tone: 'plus' });
          renderModal();
        };
      });

      backdrop.querySelectorAll('[data-mgr-up]').forEach((b) => {
        b.onclick = async () => {
          const idx = Number(b.dataset.mgrUp);
          if (idx <= 0) return;
          await store.update((draft) => {
            const arr = [...(draft.reasons[key] || [])];
            [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
            draft.reasons[key] = arr;
          });
          renderModal();
        };
      });

      backdrop.querySelectorAll('[data-mgr-down]').forEach((b) => {
        b.onclick = async () => {
          const idx = Number(b.dataset.mgrDown);
          await store.update((draft) => {
            const arr = [...(draft.reasons[key] || [])];
            if (idx >= 0 && idx < arr.length - 1) {
              [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
              draft.reasons[key] = arr;
            }
          });
          renderModal();
        };
      });

      backdrop.querySelectorAll('[data-mgr-del]').forEach((b) => {
        b.onclick = async () => {
          const idx = Number(b.dataset.mgrDel);
          await store.update((draft) => {
            const arr = [...(draft.reasons[key] || [])];
            arr.splice(idx, 1);
            draft.reasons[key] = arr;
          });
          renderModal();
        };
      });
    } else {
      const typeSel = backdrop.querySelector('#mgr-set-type');
      const ptsInp = backdrop.querySelector('#mgr-set-pts');
      if (typeSel) typeSel.onchange = () => { draftSetType = typeSel.value; };
      if (ptsInp) ptsInp.onchange = () => { draftSetPoints = Math.max(1, Math.min(99, Math.trunc(Number(ptsInp.value) || 1))); };

      backdrop.querySelector('#form-mgr-add-set').onsubmit = async (e) => {
        e.preventDefault();
        const sType = backdrop.querySelector('#mgr-set-type').value === 'negative' ? 'negative' : 'positive';
        const sPts = Math.max(1, Math.min(99, Math.trunc(Number(backdrop.querySelector('#mgr-set-pts').value) || 1)));
        const sReason = String(backdrop.querySelector('#mgr-set-reason').value || '').trim();
        if (!sReason) return;
        draftSetType = sType;
        draftSetPoints = sPts;
        await store.update((draft) => {
          const list = Array.isArray(draft.reasons.favoriteSets) ? draft.reasons.favoriteSets : [];
          const candidate = { id: uid('fset'), type: sType, points: sPts, reason: sReason };
          if (!list.some((x) => isSameSet(x, candidate))) {
            draft.reasons.favoriteSets = [candidate, ...list];
          }
        });
        showToast({ title: '즐겨찾기 세트를 등록했습니다.', tone: 'plus' });
        renderModal();
      };

      backdrop.querySelectorAll('[data-set-up]').forEach((b) => {
        b.onclick = async () => {
          const idx = Number(b.dataset.setUp);
          if (idx <= 0) return;
          await store.update((draft) => {
            const arr = [...(draft.reasons.favoriteSets || [])];
            [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
            draft.reasons.favoriteSets = arr;
          });
          renderModal();
        };
      });

      backdrop.querySelectorAll('[data-set-down]').forEach((b) => {
        b.onclick = async () => {
          const idx = Number(b.dataset.setDown);
          await store.update((draft) => {
            const arr = [...(draft.reasons.favoriteSets || [])];
            if (idx >= 0 && idx < arr.length - 1) {
              [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
              draft.reasons.favoriteSets = arr;
            }
          });
          renderModal();
        };
      });

      backdrop.querySelectorAll('[data-set-del]').forEach((b) => {
        b.onclick = async () => {
          const idx = Number(b.dataset.setDel);
          await store.update((draft) => {
            const arr = [...(draft.reasons.favoriteSets || [])];
            arr.splice(idx, 1);
            draft.reasons.favoriteSets = arr;
          });
          renderModal();
        };
      });
    }
  };

  modalRoot.appendChild(backdrop);
  renderModal();
}

/** 최근 기록 타임스탬프를 간결한 시각 문자열로 변환 */
function formatShortTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/**
 * 공통 점수 부여 풀페이지 모달 열기 (1회 점수 조절 · 좌측 최근 기록 · 확인 버튼으로만 실행)
 */
export function openScoreComposer({ studentIds = [], initialType = 'positive', onApplied = null } = {}) {
  const overlay = document.getElementById('score-composer-overlay');
  if (!overlay) return;

  const state = store.getState();
  const activeStudents = state.students.filter((s) => !s.trashed);
  const selectedSet = new Set(
    studentIds.length > 0
      ? studentIds.filter((id) => activeStudents.some((s) => s.id === id))
      : activeStudents.map((s) => s.id)
  );
  const targetStudents = activeStudents
    .filter((s) => selectedSet.has(s.id))
    .sort((a, b) => a.number - b.number);

  let modeType = initialType === 'negative' ? 'negative' : 'positive';
  let pointsPerStudent = 1; // 1 ~ 99 정수
  let selectedReason = '';
  let activeHistoryId = null;
  let activeFavSetId = null;

  const targetFullNames = targetStudents.map((s) => `${s.number}번 ${s.name}`).join(', ');
  const targetSummaryText =
    targetStudents.length === 0
      ? '대상 학생 없음'
      : targetStudents.length <= 3
        ? `${targetStudents.map((s) => s.name).join(', ')} (${targetStudents.length}명)`
        : `${targetStudents[0].name}, ${targetStudents[1].name} 외 ${targetStudents.length - 2}명 (총 ${targetStudents.length}명)`;

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = '';
  };

  /** 오직 하단 확인 버튼 클릭 시에만 실제 점수 적용 및 연출 실행 */
  const commitScore = async () => {
    if (targetStudents.length === 0) return;
    const pts = Math.max(1, Math.min(99, Math.trunc(Number(pointsPerStudent) || 1)));
    const finalDelta = modeType === 'positive' ? pts : -pts;
    const outcome = await applyStudentScoreBatch({
      studentIds: targetStudents.map((s) => s.id),
      delta: finalDelta,
      reason: selectedReason,
    });
    close();
    presentOutcome(outcome, { forceToast: false });
    if (typeof onApplied === 'function') onApplied(outcome);
  };

  /** 점수 숫자 변경 시 입력 포커스를 유지하면서 미리보기·확인 버튼·빠른 선택 상태만 부분 갱신 */
  const updatePointsPreviewDom = (previewPts) => {
    const isPos = modeType === 'positive';
    const sign = isPos ? '+' : '-';
    const count = targetStudents.length;
    const validPts = Number.isFinite(previewPts) && previewPts >= 1 && previewPts <= 99 ? previewPts : 0;
    const totalPts = validPts * count;

    const previewEl = overlay.querySelector('#comp-calc-preview');
    if (previewEl) {
      previewEl.innerHTML = validPts > 0
        ? `<strong>${sign}${validPts}점 &times; ${count}명</strong> = <em class="calc-total">총 ${sign}${totalPts}점</em>`
        : `<strong>점수를 1~99 사이로 입력하세요</strong>`;
    }
    const submitBtn = overlay.querySelector('#comp-confirm-submit');
    if (submitBtn) {
      submitBtn.disabled = count === 0 || validPts <= 0;
      const span = submitBtn.querySelector('span');
      if (span) {
        span.textContent = validPts > 0
          ? `확인 (${sign}${totalPts}점 부여)`
          : '확인 (점수 입력 필요)';
      }
    }
    overlay.querySelectorAll('[data-quick-pts]').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.quickPts) === validPts);
    });
  };

  const render = () => {
    const prevFavSetScroll = overlay.querySelector('.composer-favset-list')?.scrollTop || 0;
    const prevHistoryScroll = overlay.querySelector('.composer-history-list')?.scrollTop || 0;
    const prevReasonScroll = overlay.querySelector('.composer-reasons-scroll')?.scrollTop || 0;

    const st = store.getState();
    const isPos = modeType === 'positive';
    const sign = isPos ? '+' : '-';
    const presets = (isPos ? st.reasons.positivePresets : st.reasons.negativePresets) || [];
    const recentReasons = (isPos ? st.reasons.recentPositive : st.reasons.recentNegative) || [];
    const favList = (isPos ? st.reasons.favoritesPositive : st.reasons.favoritesNegative) || [];
    const favSet = new Set(favList);
    const favoriteSets = Array.isArray(st.reasons.favoriteSets) ? st.reasons.favoriteSets : [];

    // 즐겨찾기와 확실히 구분되는 '최근 사용 카드' 및 미사용 '기본 추천 카드'
    const recentOnlyList = recentReasons.filter((r) => !favSet.has(r));
    const presetOnlyList = presets.filter((r) => !favSet.has(r) && !recentReasons.includes(r));

    const historyItems = (st.history || [])
      .filter((h) => h.kind === 'score' && !h.reverted && Number(h.delta) !== 0)
      .slice(0, 25);

    const totalPts = pointsPerStudent * targetStudents.length;

    const renderReasonCard = (r, kind) => {
      const isFav = favSet.has(r);
      const badgeHtml = kind === 'fav'
        ? `<span class="reason-badge-icon is-fav-badge" title="즐겨찾기 등록 카드">${SVG_BOOKMARK_FILLED}</span>`
        : kind === 'recent'
          ? `<span class="reason-badge-icon is-recent-badge" title="최근 사용 카드">${SVG_CLOCK_RECENT}</span>`
          : `<span class="reason-badge-icon is-preset-badge" title="기본 추천 카드">${SVG_SPARK_PRESET}</span>`;
      return `
        <button type="button" class="reason-card-btn ${kind === 'fav' ? 'is-fav-card' : ''} ${selectedReason === r ? 'is-selected' : ''}" data-select-reason="${escapeAttr(r)}">
          ${badgeHtml}
          <span class="reason-card-text" title="${escapeAttr(r)}">${escapeHtml(r)}</span>
          <span class="reason-fav-toggle ${isFav ? 'is-fav' : ''}" data-fav-toggle="${escapeAttr(r)}" title="${isFav ? '즐겨찾기 해제' : '즐겨찾기에 등록'}">
            ${isFav ? SVG_BOOKMARK_FILLED : SVG_BOOKMARK_OUTLINE}
          </span>
        </button>
      `;
    };

    overlay.innerHTML = `
      <div class="composer-grid">
        <div class="composer-sidebar">
          <div class="composer-sidebar-top">
            <button type="button" class="composer-back" id="comp-back">← 학급화면</button>
          </div>

          <!-- 상단 분리 공간: 즐겨찾기 세트 -->
          <div class="composer-set-box is-fav-box">
            <div class="composer-history-head">
              <h3 class="set-head-title is-fav">
                <span class="sec-icon is-fav">${SVG_BOOKMARK_FILLED}</span>
                <span>즐겨찾기 세트</span>
              </h3>
              <span class="composer-history-count is-fav">${favoriteSets.length}개</span>
            </div>
            <div class="composer-favset-list">
              ${favoriteSets.length === 0 ? `
                <div class="composer-set-empty-mini">자주 쓰는 세트의 북마크 아이콘을 누르거나 [카드·세트 등록]에서 추가하세요.</div>
              ` : favoriteSets.map((fs) => {
                const fsPos = fs.type !== 'negative';
                const fsPts = Math.max(1, Math.trunc(Number(fs.points) || 1));
                return `
                  <div class="composer-history-item is-favset-item ${activeFavSetId === fs.id ? 'is-active' : ''}" data-favset-id="${escapeAttr(fs.id)}" role="button" tabindex="0">
                    <div class="composer-history-top">
                      <span class="composer-history-badge ${fsPos ? 'is-pos' : 'is-neg'}">${fsPos ? '으쓱' : '머쓱'} ${fsPos ? '+' : '-'}${fsPts}점</span>
                      <button type="button" class="set-fav-btn is-fav" data-remove-favset="${escapeAttr(fs.id)}" title="즐겨찾기 세트 해제">${SVG_BOOKMARK_FILLED}</button>
                    </div>
                    <span class="composer-history-reason">${escapeHtml(fs.reason)}</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>

          <!-- 하단 분리 공간: 최근 사용 세트 -->
          <div class="composer-set-box is-recent-box">
            <div class="composer-history-head">
              <h3 class="set-head-title is-recent">
                <span class="sec-icon is-recent">${SVG_CLOCK_RECENT}</span>
                <span>최근 사용 세트</span>
              </h3>
              <span class="composer-history-count">${historyItems.length}건</span>
            </div>

            <div class="composer-history-list">
              ${historyItems.length === 0 ? `
                <div class="composer-history-empty">아직 부여한 점수 기록이 없습니다.<br>점수를 부여하면 여기에 최근 세트가 쌓입니다.</div>
              ` : historyItems.map((h) => {
                const hPos = h.delta > 0;
                const absD = Math.abs(h.delta);
                const hType = hPos ? 'positive' : 'negative';
                const matchedFavSet = favoriteSets.find((fs) => isSameSet(fs, { type: hType, points: absD, reason: h.reason }));
                const names = Array.isArray(h.studentNames) ? h.studentNames : [];
                const whoText = names.length === 0
                  ? '대상 없음'
                  : names.length === 1
                    ? names[0]
                    : `${names[0]} 외 ${names.length - 1}명`;
                const histTotal = h.delta * Math.max(1, (h.studentIds || []).length);
                return `
                  <div class="composer-history-item ${activeHistoryId === h.id ? 'is-active' : ''}" data-history-id="${escapeAttr(h.id)}" role="button" tabindex="0">
                    <div class="composer-history-top">
                      <span class="composer-history-badge ${hPos ? 'is-pos' : 'is-neg'}">${hPos ? '으쓱' : '머쓱'} ${hPos ? '+' : '-'}${absD}점</span>
                      <div class="composer-history-right">
                        <span class="composer-history-time">${formatShortTime(h.timestamp)}</span>
                        <button type="button" class="set-fav-btn ${matchedFavSet ? 'is-fav' : ''}" data-toggle-hist-favset="${escapeAttr(h.id)}" title="${matchedFavSet ? '즐겨찾기 세트 해제' : '즐겨찾기 세트로 등록'}">
                          ${matchedFavSet ? SVG_BOOKMARK_FILLED : SVG_BOOKMARK_OUTLINE}
                        </button>
                      </div>
                    </div>
                    <span class="composer-history-reason">${escapeHtml(h.reason)}</span>
                    <span class="composer-history-meta">${escapeHtml(whoText)} &middot; 총 ${histTotal > 0 ? `+${histTotal}` : histTotal}점</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>

        <div class="composer-main ${isPos ? '' : 'is-penalty'}">
          <div class="composer-mode-bar">
            <div class="composer-type-tabs">
              <button type="button" class="composer-type-btn plus ${isPos ? 'is-active' : ''}" data-switch-type="positive">
                <i class="sp-icon sp-star-blue" style="transform:scale(0.8);" aria-hidden="true"></i> 으쓱 (상점)
              </button>
              <button type="button" class="composer-type-btn minus ${!isPos ? 'is-active' : ''}" data-switch-type="negative">
                <i class="sp-icon sp-cloud-red" style="transform:scale(0.8);" aria-hidden="true"></i> 머쓱 (감점)
              </button>
            </div>
            <span class="composer-target-summary ${targetStudents.length === 0 ? 'is-empty' : ''}" title="${escapeAttr(targetFullNames || '대상 학생 없음')}">
              대상: ${escapeHtml(targetSummaryText)}
            </span>
            <button type="button" class="composer-manage-btn" id="comp-open-card-mgr" title="으쓱·머쓱 즐겨찾기 카드 및 세트 등록">
              ${SVG_BOOKMARK_FILLED}
              <span>카드·세트 등록</span>
            </button>
            <button type="button" class="composer-close" id="comp-close" aria-label="닫기">&times;</button>
          </div>

          <div class="composer-reasons-scroll">
            <!-- 1. 즐겨찾기(등록) 카드 섹션 -->
            <div class="reason-section-block is-fav-section">
              <div class="reason-group-header">
                <span class="reason-group-pill is-fav">
                  ${SVG_BOOKMARK_FILLED}
                  <span>즐겨찾기 카드 (등록됨 · ${favList.length})</span>
                </span>
              </div>
              ${favList.length > 0 ? `
                <div class="reason-grid">
                  ${favList.map((r) => renderReasonCard(r, 'fav')).join('')}
                </div>
              ` : `
                <div class="reason-empty-guide">등록된 즐겨찾기 카드가 없습니다. 우측 상단 <strong>[카드·세트 등록]</strong> 또는 설정에서 카드를 등록해보세요.</div>
              `}
            </div>

            <!-- 2. 최근 사용 카드 섹션 -->
            ${recentOnlyList.length > 0 ? `
              <div class="reason-section-block is-recent-section">
                <div class="reason-group-header">
                  <span class="reason-group-pill is-recent">
                    ${SVG_CLOCK_RECENT}
                    <span>최근 사용 카드 (${recentOnlyList.length})</span>
                  </span>
                </div>
                <div class="reason-grid">
                  ${recentOnlyList.map((r) => renderReasonCard(r, 'recent')).join('')}
                </div>
              </div>
            ` : ''}

            <!-- 3. 기본 추천 카드 섹션 -->
            ${presetOnlyList.length > 0 ? `
              <div class="reason-section-block">
                <div class="reason-group-header">
                  <span class="reason-group-pill is-preset">
                    ${SVG_SPARK_PRESET}
                    <span>기본 추천 카드</span>
                  </span>
                </div>
                <div class="reason-grid">
                  ${presetOnlyList.map((r) => renderReasonCard(r, 'preset')).join('')}
                </div>
              </div>
            ` : ''}
          </div>

          <div class="composer-bottom-panel">
            <div class="composer-points-row">
              <div class="composer-points-controls">
                <span class="composer-points-label">1인당 점수</span>
                <div class="composer-quick-pts">
                  ${[1, 2, 3, 5, 10].map((n) => `
                    <button type="button" class="quick-pt-btn ${pointsPerStudent === n ? 'is-active' : ''}" data-quick-pts="${n}">${sign}${n}</button>
                  `).join('')}
                </div>
                <div class="composer-stepper">
                  <button type="button" class="pts-step-btn" id="comp-pts-dec" aria-label="점수 1 감소">−</button>
                  <input type="number" class="composer-pts-input" id="comp-pts-input" min="1" max="99" value="${pointsPerStudent}" aria-label="1인당 점수 입력">
                  <button type="button" class="pts-step-btn" id="comp-pts-inc" aria-label="점수 1 증가">+</button>
                </div>
              </div>
              <div class="composer-calc-preview" id="comp-calc-preview">
                <strong>${sign}${pointsPerStudent}점 &times; ${targetStudents.length}명</strong> = <em class="calc-total">총 ${sign}${totalPts}점</em>
              </div>
            </div>

            <div class="composer-confirm-row">
              <input type="text" id="comp-reason-input" value="${escapeAttr(selectedReason)}" placeholder="${isPos ? '사유를 선택하거나 직접 입력하세요 (예: 수업 발표를 멋지게 했어요)' : '사유를 선택하거나 직접 입력하세요 (예: 수업 시간에 집중이 필요해요)'}" maxlength="50">
              <button type="button" class="composer-submit-btn" id="comp-confirm-submit" ${targetStudents.length === 0 ? 'disabled' : ''}>
                <i class="sp-icon ${isPos ? 'sp-star-blue' : 'sp-cloud-red'}" style="transform:scale(0.85);" aria-hidden="true"></i>
                <span>확인 (${sign}${totalPts}점 부여)</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    const favSetScrollEl = overlay.querySelector('.composer-favset-list');
    if (favSetScrollEl) favSetScrollEl.scrollTop = prevFavSetScroll;
    const histScrollEl = overlay.querySelector('.composer-history-list');
    if (histScrollEl) histScrollEl.scrollTop = prevHistoryScroll;
    const reasonScrollEl = overlay.querySelector('.composer-reasons-scroll');
    if (reasonScrollEl) reasonScrollEl.scrollTop = prevReasonScroll;

    overlay.querySelector('#comp-back').onclick = close;
    overlay.querySelector('#comp-close').onclick = close;
    const mgrBtn = overlay.querySelector('#comp-open-card-mgr');
    if (mgrBtn) {
      mgrBtn.onclick = () => openScoreCardManagerModal(isPos ? 'pos' : 'neg', render);
    }

    // 상단 즐겨찾기 세트 클릭 및 해제
    overlay.querySelectorAll('[data-favset-id]').forEach((itemEl) => {
      itemEl.onclick = (e) => {
        const rmBtn = e.target.closest('[data-remove-favset]');
        if (rmBtn) {
          e.stopPropagation();
          const rmId = rmBtn.dataset.removeFavset;
          store.update((draft) => {
            draft.reasons.favoriteSets = (draft.reasons.favoriteSets || []).filter((x) => x.id !== rmId);
          }).then(() => {
            if (activeFavSetId === rmId) activeFavSetId = null;
            render();
          });
          return;
        }
        const fs = favoriteSets.find((x) => x.id === itemEl.dataset.favsetId);
        if (!fs) return;
        modeType = fs.type === 'negative' ? 'negative' : 'positive';
        pointsPerStudent = Math.max(1, Math.min(99, Math.abs(Math.trunc(Number(fs.points) || 1))));
        selectedReason = fs.reason || '';
        activeFavSetId = fs.id;
        activeHistoryId = null;
        render();
      };
    });

    // 하단 최근 사용 세트 클릭 및 즐겨찾기 세트 등록/해제 토글
    overlay.querySelectorAll('[data-history-id]').forEach((btn) => {
      btn.onclick = (e) => {
        const favToggleBtn = e.target.closest('[data-toggle-hist-favset]');
        const entry = historyItems.find((h) => h.id === btn.dataset.historyId);
        if (!entry) return;
        if (favToggleBtn) {
          e.stopPropagation();
          const hType = entry.delta > 0 ? 'positive' : 'negative';
          const absPts = Math.max(1, Math.min(99, Math.abs(Math.trunc(Number(entry.delta) || 1))));
          const candidate = { id: uid('fset'), type: hType, points: absPts, reason: entry.reason || '' };
          store.update((draft) => {
            const list = Array.isArray(draft.reasons.favoriteSets) ? draft.reasons.favoriteSets : [];
            const exists = list.find((x) => isSameSet(x, candidate));
            if (exists) {
              draft.reasons.favoriteSets = list.filter((x) => x.id !== exists.id);
            } else {
              draft.reasons.favoriteSets = [candidate, ...list];
            }
          }).then(render);
          return;
        }
        modeType = entry.delta > 0 ? 'positive' : 'negative';
        pointsPerStudent = Math.max(1, Math.min(99, Math.abs(Math.trunc(Number(entry.delta) || 1))));
        selectedReason = entry.reason || '';
        activeHistoryId = entry.id;
        activeFavSetId = null;
        render();
      };
    });

    // 으쓱 / 머쓱 전환
    overlay.querySelectorAll('[data-switch-type]').forEach((btn) => {
      btn.onclick = () => {
        const nextType = btn.dataset.switchType === 'negative' ? 'negative' : 'positive';
        if (nextType === modeType) return;
        const prevList = modeType === 'positive'
          ? [...(st.reasons.positivePresets || []), ...(st.reasons.recentPositive || []), ...(st.reasons.favoritesPositive || [])]
          : [...(st.reasons.negativePresets || []), ...(st.reasons.recentNegative || []), ...(st.reasons.favoritesNegative || [])];
        if (prevList.includes(selectedReason)) {
          selectedReason = '';
        }
        modeType = nextType;
        activeHistoryId = null;
        activeFavSetId = null;
        render();
      };
    });

    // 즐겨찾기·최근사용 사유 카드 클릭 → 입력란·선택 하이라이트만 반영
    overlay.querySelectorAll('[data-select-reason]').forEach((btn) => {
      btn.onclick = (e) => {
        const favTarget = e.target.closest('[data-fav-toggle]');
        if (favTarget) {
          e.stopPropagation();
          const r = favTarget.dataset.favToggle;
          store.update((draft) => {
            const key = isPos ? 'favoritesPositive' : 'favoritesNegative';
            const arr = draft.reasons[key] || [];
            draft.reasons[key] = arr.includes(r) ? arr.filter((x) => x !== r) : [r, ...arr];
          }).then(render);
          return;
        }
        selectedReason = btn.dataset.selectReason || '';
        activeHistoryId = null;
        activeFavSetId = null;
        render();
      };
    });

    // 점수 조절: 빠른 선택 · -/+ 스테퍼 · 직접 입력
    const ptsInput = overlay.querySelector('#comp-pts-input');
    const setPoints = (val) => {
      pointsPerStudent = Math.max(1, Math.min(99, Math.trunc(Number(val) || 1)));
      if (ptsInput) ptsInput.value = String(pointsPerStudent);
      updatePointsPreviewDom(pointsPerStudent);
    };

    overlay.querySelectorAll('[data-quick-pts]').forEach((btn) => {
      btn.onclick = () => setPoints(btn.dataset.quickPts);
    });
    const decBtn = overlay.querySelector('#comp-pts-dec');
    if (decBtn) decBtn.onclick = () => setPoints(pointsPerStudent - 1);
    const incBtn = overlay.querySelector('#comp-pts-inc');
    if (incBtn) incBtn.onclick = () => setPoints(pointsPerStudent + 1);

    if (ptsInput) {
      ptsInput.oninput = () => {
        const raw = ptsInput.value.trim();
        if (raw === '') {
          updatePointsPreviewDom(0);
          return;
        }
        const parsed = Math.trunc(Number(raw));
        if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 99) {
          pointsPerStudent = parsed;
          updatePointsPreviewDom(parsed);
        } else {
          updatePointsPreviewDom(0);
        }
      };
      ptsInput.onblur = () => {
        setPoints(ptsInput.value || pointsPerStudent);
      };
    }

    // 사유 직접 입력 (포커스 유지, Enter 키 자동 부여 방지)
    const reasonInput = overlay.querySelector('#comp-reason-input');
    if (reasonInput) {
      reasonInput.oninput = () => {
        selectedReason = reasonInput.value;
        activeHistoryId = null;
      };
      reasonInput.onkeydown = (e) => {
        if (e.key === 'Enter') e.preventDefault();
      };
    }

    // 오직 하단 확인 버튼 클릭으로만 점수 부여 실행
    const confirmBtn = overlay.querySelector('#comp-confirm-submit');
    if (confirmBtn) confirmBtn.onclick = commitScore;
  };

  overlay.hidden = false;
  render();
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(str) {
  return escapeHtml(str);
}
