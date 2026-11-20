// 공통 점수 부여 모달(한 장 주기 / 여러 장 주기, 으쓱 파랑 / 머쓱 분홍) + 원본 영상 충실 연출 + 하단 검정 토스트

import { store, getStillAvatarUrl, getFxAvatarUrl } from './store.js';
import { applyStudentScoreBatch } from './score-engine.js';
import { playSound } from './audio.js';

let getActiveModeFn = () => 'students';
export function setActiveModeProvider(fn) {
  getActiveModeFn = fn;
}

const fxQueue = [];
let fxPlaying = false;
let fxTimer = null;

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
  const useToast = forceToast || (mode !== 'students' && mode !== 'seats' && mode !== 'growth');

  if (outcome.kind === 'score') {
    const isPos = outcome.delta > 0;
    const totalPoints = Math.abs(outcome.delta) * (outcome.targets?.length || 1);

    if (useToast) {
      playSound(isPos ? 'plus' : 'minus');
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
      if (useToast) {
        playSound('eggUp');
      } else {
        fxQueue.push({
          type: 'egg',
          delta: outcome.eggsDelta,
          eggsNow: outcome.eggsNow,
        });
      }
    } else if (outcome.eggsDelta < 0) {
      playSound('eggDown');
    }

    if (Array.isArray(outcome.achievedGoals)) {
      for (const goal of outcome.achievedGoals) {
        fxQueue.push({ type: 'goal', goal, eggsNow: outcome.eggsNow });
      }
    }
  } else if (outcome.kind === 'egg') {
    // 황금알 직접 부여/차감 (1학생화면.mp4 00:00~00:35)
    // 목표 달성 시 바로 회전 갈색 원 목표 달성 연출, 미달성 시 효과음만 깔끔하게 재생
    if (Array.isArray(outcome.achievedGoals) && outcome.achievedGoals.length > 0) {
      for (const goal of outcome.achievedGoals) {
        fxQueue.push({ type: 'goal', goal, eggsNow: outcome.eggsNow });
      }
    } else {
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
  stage.hidden = false;
  stage.className = 'fx-stage';

  let duration = 2600;

  if (item.type === 'positive') {
    stage.classList.add('fx-positive');
    duration = 3500;
    const perStudent = Math.abs(Math.trunc(Number(item.delta) || 1));
    const count = item.targets.length;
    const totalScore = perStudent * count;
    playSound(perStudent >= 3 || count >= 4 ? 'plusBig' : 'plus');
    const cheers = ['참 잘했어요', '열심히 한 보람이 있어요', '정말 멋져요'];
    const cheerText = cheers[count % cheers.length];
    const isCompact = count >= 6;
    stage.innerHTML = `
      <div class="fx-intro-mascot" aria-hidden="true"></div>
      <div class="fx-heading">
        <div class="fx-medal-wrap">
          <div class="fx-wing-l" aria-hidden="true"></div>
          <div class="fx-wing-r" aria-hidden="true"></div>
          <div class="fx-medal-disc">
            <div class="fx-medal-star"></div>
          </div>
        </div>
        <div class="fx-score-banner">
          <span class="fx-score-formula">+${perStudent}점 &times; ${count}명</span>
          <strong class="fx-score-total">+${totalScore}점</strong>
        </div>
        <h2 class="fx-reason-title">${escapeHtml(item.reason)}</h2>
      </div>
      <div class="fx-actors-row ${isCompact ? 'is-compact' : ''}">
        ${item.targets.slice(0, 10).map((t, idx) => `
          <div class="fx-actor-card" style="--pop-delay:${(0.88 + idx * 0.08).toFixed(2)}s;">
            <div class="fx-actor-puff" aria-hidden="true"></div>
            <div class="avatar-fx-sprite" style="background-image:url('${getFxAvatarUrl(t.avatarId)}')"></div>
            <span class="fx-actor-name">${escapeHtml(t.name)}</span>
          </div>
        `).join('')}
        ${count > 10 ? `<span class="fx-more-pill">외 ${count - 10}명</span>` : ''}
      </div>
      <div class="fx-bottom-cheer">
        <div class="fx-cheer-pill">" ${cheerText} "</div>
      </div>
    `;
  } else if (item.type === 'negative') {
    // 감점 시 원본 먹구름 스프라이트 + 빗줄기 + 노란 톱니·빨간 먹구름 배지 + 정지 아바타(still) + 하단 마스코트
    stage.classList.add('fx-negative');
    duration = 3600;
    const perStudent = Math.abs(Math.trunc(Number(item.delta) || 1));
    const count = item.targets.length;
    const totalScore = perStudent * count;
    playSound(perStudent >= 3 ? 'minusBig' : 'minus');
    const isCompact = count >= 6;
    stage.innerHTML = `
      <div class="fx-storm-rain" aria-hidden="true"></div>
      <div class="fx-storm-clouds" aria-hidden="true">
        <div class="fx-storm-cloud-sprite c-left"></div>
        <div class="fx-storm-cloud-sprite c-right"></div>
        <div class="fx-storm-cloud-sprite c-center"></div>
      </div>
      <div class="fx-heading">
        <div class="fx-storm-badge-wrap">
          <div class="fx-storm-sunburst" aria-hidden="true"></div>
          <div class="fx-storm-core" aria-hidden="true"></div>
        </div>
        <div class="fx-score-banner">
          <span class="fx-score-formula">-${perStudent}점 &times; ${count}명</span>
          <strong class="fx-score-total">-${totalScore}점</strong>
        </div>
        <h2 class="fx-reason-title">${escapeHtml(item.reason)}</h2>
      </div>
      <div class="fx-actors-row ${isCompact ? 'is-compact' : ''}">
        ${item.targets.slice(0, 10).map((t, idx) => `
          <div class="fx-actor-card" style="--pop-delay:${(0.98 + idx * 0.08).toFixed(2)}s;">
            <img class="fx-still-img" src="${getStillAvatarUrl(t.avatarId)}" alt="${escapeAttr(t.name)}">
            <span class="fx-actor-name">${escapeHtml(t.name)}</span>
          </div>
        `).join('')}
        ${count > 10 ? `<span class="fx-more-pill">외 ${count - 10}명</span>` : ''}
      </div>
      <div class="fx-bottom-cheer">
        <div class="fx-cheer-pill">" 고쳐주세요 "</div>
        <div class="fx-mascot" aria-hidden="true"></div>
      </div>
    `;
  } else if (item.type === 'egg') {
    // 3수업도구.mp4 00:31~00:33 — 검정 배경 + 흰 날개 달린 황금알 획득 연출
    stage.classList.add('fx-egg');
    playSound('successSmall');
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
    stage.onclick = null;
    stage.hidden = true;
    fxPlaying = false;
    if (item.type === 'positive' && Array.isArray(item.targets) && item.targets.length > 0) {
      window.dispatchEvent(new CustomEvent('class123:award-finished', {
        detail: {
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
    const prevHistoryScroll = overlay.querySelector('.composer-history-list')?.scrollTop || 0;
    const prevReasonScroll = overlay.querySelector('.composer-reasons-scroll')?.scrollTop || 0;

    const st = store.getState();
    const isPos = modeType === 'positive';
    const sign = isPos ? '+' : '-';
    const presets = isPos ? st.reasons.positivePresets : st.reasons.negativePresets;
    const recentReasons = isPos ? st.reasons.recentPositive : st.reasons.recentNegative;
    const favList = (isPos ? st.reasons.favoritesPositive : st.reasons.favoritesNegative) || [];
    const favSet = new Set(favList);

    // 즐겨찾기와 중복되지 않는 최근 사유 + 기본 프리셋 목록
    const regularReasons = [
      ...recentReasons.filter((r) => !favSet.has(r)),
      ...presets.filter((r) => !favSet.has(r) && !recentReasons.includes(r)),
    ];

    const historyItems = (st.history || [])
      .filter((h) => h.kind === 'score' && !h.reverted && Number(h.delta) !== 0)
      .slice(0, 25);

    const totalPts = pointsPerStudent * targetStudents.length;

    const renderReasonCard = (r) => `
      <button type="button" class="reason-card-btn ${selectedReason === r ? 'is-selected' : ''}" data-select-reason="${escapeAttr(r)}">
        <span class="reason-badge-icon">${isPos ? '★' : '☁'}</span>
        <span class="reason-card-text" title="${escapeAttr(r)}">${escapeHtml(r)}</span>
        <span class="reason-fav-star ${favSet.has(r) ? 'is-fav' : ''}" data-fav-toggle="${escapeAttr(r)}" title="즐겨찾기 토글">★</span>
      </button>
    `;

    overlay.innerHTML = `
      <div class="composer-grid">
        <div class="composer-sidebar">
          <button type="button" class="composer-back" id="comp-back">← 학급화면</button>
          <div class="composer-history-head">
            <h3>최근 부여 기록</h3>
            <span class="composer-history-count">${historyItems.length}건</span>
          </div>
          <p class="composer-history-hint">기록을 클릭하면 사유와 점수가 아래에 적용됩니다.</p>

          <div class="composer-history-list">
            ${historyItems.length === 0 ? `
              <div class="composer-history-empty">아직 부여한 점수 기록이 없습니다.<br>점수를 부여하면 여기에 최근 내역이 쌓입니다.</div>
            ` : historyItems.map((h) => {
              const hPos = h.delta > 0;
              const absD = Math.abs(h.delta);
              const names = Array.isArray(h.studentNames) ? h.studentNames : [];
              const whoText = names.length === 0
                ? '대상 없음'
                : names.length === 1
                  ? names[0]
                  : `${names[0]} 외 ${names.length - 1}명`;
              const histTotal = h.delta * Math.max(1, (h.studentIds || []).length);
              return `
                <button type="button" class="composer-history-item ${activeHistoryId === h.id ? 'is-active' : ''}" data-history-id="${escapeAttr(h.id)}">
                  <div class="composer-history-top">
                    <span class="composer-history-badge ${hPos ? 'is-pos' : 'is-neg'}">${hPos ? '으쓱' : '머쓱'} ${hPos ? '+' : '-'}${absD}점</span>
                    <span class="composer-history-time">${formatShortTime(h.timestamp)}</span>
                  </div>
                  <span class="composer-history-reason">${escapeHtml(h.reason)}</span>
                  <span class="composer-history-meta">${escapeHtml(whoText)} &middot; 총 ${histTotal > 0 ? `+${histTotal}` : histTotal}점</span>
                </button>
              `;
            }).join('')}
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
            <button type="button" class="composer-close" id="comp-close" aria-label="닫기">&times;</button>
          </div>

          <div class="composer-reasons-scroll">
            <div class="reason-section-label">
              즐겨찾기·사유를 클릭해 선택한 뒤 아래에서 점수를 조절하고 [확인]을 눌러주세요.
            </div>

            ${favList.length > 0 ? `
              <div>
                <div class="reason-group-title">★ 즐겨찾기</div>
                <div class="reason-grid">
                  ${favList.map(renderReasonCard).join('')}
                </div>
              </div>
            ` : ''}

            <div>
              ${favList.length > 0 ? '<div class="reason-group-title">사유 목록</div>' : ''}
              <div class="reason-grid">
                ${regularReasons.map(renderReasonCard).join('')}
              </div>
            </div>
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

    const histScrollEl = overlay.querySelector('.composer-history-list');
    if (histScrollEl) histScrollEl.scrollTop = prevHistoryScroll;
    const reasonScrollEl = overlay.querySelector('.composer-reasons-scroll');
    if (reasonScrollEl) reasonScrollEl.scrollTop = prevReasonScroll;

    overlay.querySelector('#comp-back').onclick = close;
    overlay.querySelector('#comp-close').onclick = close;

    // 좌측 최근 부여 기록 클릭 → 폼 상태만 채움 (즉시 부여 X)
    overlay.querySelectorAll('[data-history-id]').forEach((btn) => {
      btn.onclick = () => {
        const entry = historyItems.find((h) => h.id === btn.dataset.historyId);
        if (!entry) return;
        modeType = entry.delta > 0 ? 'positive' : 'negative';
        pointsPerStudent = Math.max(1, Math.min(99, Math.abs(Math.trunc(Number(entry.delta) || 1))));
        selectedReason = entry.reason || '';
        activeHistoryId = entry.id;
        render();
      };
    });

    // 으쓱 / 머쓱 전환
    overlay.querySelectorAll('[data-switch-type]').forEach((btn) => {
      btn.onclick = () => {
        const nextType = btn.dataset.switchType === 'negative' ? 'negative' : 'positive';
        if (nextType === modeType) return;
        const prevList = modeType === 'positive'
          ? [...(st.reasons.positivePresets || []), ...(st.reasons.recentPositive || [])]
          : [...(st.reasons.negativePresets || []), ...(st.reasons.recentNegative || [])];
        if (prevList.includes(selectedReason)) {
          selectedReason = '';
        }
        modeType = nextType;
        activeHistoryId = null;
        render();
      };
    });

    // 즐겨찾기·사유 카드 클릭 → 입력란·선택 하이라이트만 반영 (즉시 부여 X)
    overlay.querySelectorAll('[data-select-reason]').forEach((btn) => {
      btn.onclick = (e) => {
        const favTarget = e.target.closest('[data-fav-toggle]');
        if (favTarget) {
          e.stopPropagation();
          const r = favTarget.dataset.favToggle;
          store.update((draft) => {
            const key = isPos ? 'favoritesPositive' : 'favoritesNegative';
            const arr = draft.reasons[key] || [];
            draft.reasons[key] = arr.includes(r) ? arr.filter((x) => x !== r) : [r, ...arr].slice(0, 10);
          }).then(render);
          return;
        }
        selectedReason = btn.dataset.selectReason || '';
        activeHistoryId = null;
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
