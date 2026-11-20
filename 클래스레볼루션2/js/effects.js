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
    playSound(Math.abs(item.delta) >= 3 || item.targets.length >= 4 ? 'plusBig' : 'plus');
    const cheers = ['참 잘했어요', '열심히 한 보람이 있어요', '정말 멋져요'];
    const cheerText = cheers[item.targets.length % cheers.length];
    stage.innerHTML = `
      <div class="fx-heading">
        <div class="fx-medal-wrap">
          <div class="fx-wings-pair"></div>
          <div class="fx-medal-disc">
            <div class="fx-medal-star"></div>
          </div>
        </div>
        <h2 class="fx-reason-title">${escapeHtml(item.reason)}</h2>
      </div>
      <div class="fx-actors-row">
        ${item.targets.slice(0, 10).map((t) => `
          <div class="fx-actor-card">
            <div class="avatar-fx-sprite" style="background-image:url('${getFxAvatarUrl(t.avatarId)}')"></div>
            <span class="fx-actor-name">${escapeHtml(t.name)}</span>
          </div>
        `).join('')}
      </div>
      <div class="fx-bottom-cheer">
        <div class="fx-cheer-pill">" ${cheerText} "</div>
        <div class="fx-mascot" aria-hidden="true"></div>
      </div>
    `;
  } else if (item.type === 'negative') {
    // 감점 시 먹구름 스프라이트 + 번개 + 빗줄기 + 정지 아바타(still)
    stage.classList.add('fx-negative');
    playSound(Math.abs(item.delta) >= 3 ? 'minusBig' : 'minus');
    const boltSvg = `<svg viewBox="0 0 66 190" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M40 0L8 84H31L14 190L62 72H37L54 0H40Z" fill="#FFF275" stroke="#FFD026" stroke-width="3"/></svg>`;
    stage.innerHTML = `
      <div class="fx-storm-rain" aria-hidden="true"></div>
      <div class="fx-lightning-flash" aria-hidden="true"></div>
      <div class="fx-storm-clouds" aria-hidden="true">
        <div class="fx-storm-cloud-sprite c-left"></div>
        <div class="fx-storm-cloud-sprite c-right"></div>
        <div class="fx-storm-cloud-sprite c-center"></div>
      </div>
      <div class="fx-lightning-bolt is-left" aria-hidden="true">${boltSvg}</div>
      <div class="fx-lightning-bolt is-right" aria-hidden="true">${boltSvg}</div>
      <div class="fx-heading">
        <div class="fx-storm-badge"><i class="sp-icon sp-cloud-red" aria-hidden="true"></i></div>
        <h2 class="fx-reason-title">${escapeHtml(item.reason)}</h2>
      </div>
      <div class="fx-actors-row">
        ${item.targets.slice(0, 10).map((t) => `
          <div class="fx-actor-card">
            <img class="fx-still-img" src="${getStillAvatarUrl(t.avatarId)}" alt="${escapeHtml(t.name)}">
            <span class="fx-actor-name">${escapeHtml(t.name)}</span>
          </div>
        `).join('')}
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

/**
 * 공통 점수 부여 풀페이지 모달 열기 (으쓱 파랑 / 머쓱 분홍, 한 장 주기 / 여러 장 주기)
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

  let modeType = initialType === 'negative' ? 'negative' : 'positive';
  let giveMode = 'single'; // 'single' (한 장 주기 → 카드 클릭 즉시 풀스크린) | 'multi' (여러 장 주기 → 카운터 + 하단 검정 토스트)
  let customReason = '';
  let multiCounts = {}; // { [reason]: number }

  const close = () => {
    overlay.hidden = true;
    overlay.innerHTML = '';
  };

  const applySingleCard = async (reason) => {
    if (selectedSet.size === 0) return;
    const finalDelta = modeType === 'positive' ? 1 : -1;
    const outcome = await applyStudentScoreBatch({
      studentIds: Array.from(selectedSet),
      delta: finalDelta,
      reason,
    });
    close();
    presentOutcome(outcome, { forceToast: false });
    if (typeof onApplied === 'function') onApplied(outcome);
  };

  const applyMultiCards = async () => {
    if (selectedSet.size === 0) return;
    const entries = Object.entries(multiCounts).filter(([, c]) => c > 0);
    if (entries.length === 0) return;
    const totalPerStudent = entries.reduce((sum, [, c]) => sum + c, 0);
    const reasonSummary = entries.length === 1
      ? entries[0][0]
      : `${entries[0][0]} 외 ${entries.length - 1}건`;
    const finalDelta = modeType === 'positive' ? totalPerStudent : -totalPerStudent;
    const outcome = await applyStudentScoreBatch({
      studentIds: Array.from(selectedSet),
      delta: finalDelta,
      reason: reasonSummary,
    });
    close();
    // 원본 영상(1학생화면.mp4 01:30, 01:40 / 3수업도구.mp4 01:05): 여러 장 주기는 하단 검정 카운터 토스트
    presentOutcome(outcome, { forceToast: true });
    if (typeof onApplied === 'function') onApplied(outcome);
  };

  const render = () => {
    const st = store.getState();
    const isPos = modeType === 'positive';
    const presets = isPos ? st.reasons.positivePresets : st.reasons.negativePresets;
    const recent = isPos ? st.reasons.recentPositive : st.reasons.recentNegative;
    const favs = new Set(isPos ? st.reasons.favoritesPositive : st.reasons.favoritesNegative);

    const orderedReasons = [
      ...Array.from(favs),
      ...recent.filter((r) => !favs.has(r)),
      ...presets.filter((r) => !favs.has(r) && !recent.includes(r)),
    ];

    const listStudents = st.students.filter((s) => !s.trashed).sort((a, b) => a.number - b.number);
    const multiTotal = Object.values(multiCounts).reduce((a, b) => a + b, 0);

    overlay.innerHTML = `
      <div class="composer-grid">
        <div class="composer-sidebar">
          <button type="button" class="composer-back" id="comp-back">← 학급화면</button>
          <div class="composer-give-modes">
            <button type="button" class="composer-give-mode-btn ${giveMode === 'single' ? 'is-active' : ''}" data-give-mode="single">한 장 주기</button>
            <button type="button" class="composer-give-mode-btn ${giveMode === 'multi' ? 'is-active' : ''}" data-give-mode="multi">여러 장 주기</button>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
            <strong style="font-size:13px;">대상 학생 (${selectedSet.size}명)</strong>
            <div style="display:flex;gap:6px;">
              <button type="button" class="btn-ghost" id="comp-sel-all" style="padding:3px 7px;font-size:11px;">전체</button>
              <button type="button" class="btn-ghost" id="comp-sel-none" style="padding:3px 7px;font-size:11px;">해제</button>
            </div>
          </div>
          <div class="composer-targets">
            ${listStudents.map((s) => `
              <label class="composer-target-item">
                <input type="checkbox" data-target-id="${s.id}" ${selectedSet.has(s.id) ? 'checked' : ''}>
                <img src="${getStillAvatarUrl(s.avatarId)}" alt="">
                <span>${s.number}. ${escapeHtml(s.name)}</span>
                <span style="margin-left:auto;color:var(--blue-score);font-size:12px;">${s.score}</span>
              </label>
            `).join('')}
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
            <button type="button" class="composer-close" id="comp-close" aria-label="닫기">&times;</button>
          </div>

          <div>
            <div class="reason-section-label">
              ${giveMode === 'single'
                ? '카드를 클릭하면 선택한 학생에게 즉시 1장이 부여됩니다.'
                : '여러 카드를 원하는 횟수만큼 조절한 뒤 아래 [부여하기]를 눌러주세요.'}
            </div>

            ${giveMode === 'single' ? `
              <div class="reason-grid">
                ${orderedReasons.map((r) => `
                  <button type="button" class="reason-card-btn" data-single-reason="${escapeAttr(r)}">
                    <span class="reason-badge-icon">${isPos ? '★' : '☁'}</span>
                    <span>${escapeHtml(r)}</span>
                    <span class="reason-fav-star ${favs.has(r) ? 'is-fav' : ''}" data-fav-toggle="${escapeAttr(r)}" title="즐겨찾기 토글">★</span>
                  </button>
                `).join('')}
              </div>
            ` : `
              <div class="reason-grid">
                ${orderedReasons.map((r) => {
                  const cnt = multiCounts[r] || 0;
                  return `
                    <div class="multi-reason-card ${cnt > 0 ? 'has-count' : ''}">
                      <span class="multi-count-badge">${cnt}</span>
                      <span class="multi-reason-title">${escapeHtml(r)}</span>
                      <div class="multi-step-controls">
                        <button type="button" class="multi-step-btn" data-multi-dec="${escapeAttr(r)}">−</button>
                        <button type="button" class="multi-step-btn" data-multi-inc="${escapeAttr(r)}">+</button>
                      </div>
                    </div>
                  `;
                }).join('')}
              </div>
            `}
          </div>

          ${giveMode === 'single' ? `
            <div class="composer-input-row">
              <label class="field-label" style="color:inherit;">
                <span>직접 사유 입력 후 부여</span>
                <input type="text" id="comp-reason-input" value="${escapeAttr(customReason)}" placeholder="${isPos ? '예: 수업 발표를 멋지게 했어요' : '예: 수업 시간에 집중이 필요해요'}" maxlength="50">
              </label>
              <button type="button" class="composer-submit-btn" id="comp-custom-submit" ${selectedSet.size === 0 ? 'disabled' : ''}>
                <i class="sp-icon ${isPos ? 'sp-star-blue' : 'sp-cloud-red'}" style="transform:scale(0.85);" aria-hidden="true"></i>
                부여하기
              </button>
            </div>
          ` : `
            <div class="composer-footer-row" style="margin-top:auto;">
              <button type="button" class="composer-submit-btn" id="comp-multi-submit" ${selectedSet.size === 0 || multiTotal === 0 ? 'disabled' : ''}>
                <i class="sp-icon ${isPos ? 'sp-star-blue' : 'sp-cloud-red'}" style="transform:scale(0.85);" aria-hidden="true"></i>
                부여하기 (${multiTotal}장 × ${selectedSet.size}명)
              </button>
            </div>
          `}
        </div>
      </div>
    `;

    overlay.querySelector('#comp-back').onclick = close;
    overlay.querySelector('#comp-close').onclick = close;

    overlay.querySelectorAll('[data-give-mode]').forEach((btn) => {
      btn.onclick = () => {
        giveMode = btn.dataset.giveMode;
        render();
      };
    });

    overlay.querySelector('#comp-sel-all').onclick = () => {
      listStudents.forEach((s) => selectedSet.add(s.id));
      render();
    };
    overlay.querySelector('#comp-sel-none').onclick = () => {
      selectedSet.clear();
      render();
    };

    overlay.querySelectorAll('[data-target-id]').forEach((cb) => {
      cb.onchange = () => {
        const id = cb.dataset.targetId;
        if (cb.checked) selectedSet.add(id);
        else selectedSet.delete(id);
        render();
      };
    });

    overlay.querySelectorAll('[data-switch-type]').forEach((btn) => {
      btn.onclick = () => {
        modeType = btn.dataset.switchType;
        multiCounts = {};
        customReason = '';
        render();
      };
    });

    if (giveMode === 'single') {
      overlay.querySelectorAll('[data-single-reason]').forEach((btn) => {
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
          applySingleCard(btn.dataset.singleReason);
        };
      });

      const reasonInput = overlay.querySelector('#comp-reason-input');
      if (reasonInput) {
        reasonInput.oninput = () => { customReason = reasonInput.value; };
        reasonInput.onkeydown = (e) => {
          if (e.key === 'Enter') applySingleCard(customReason);
        };
      }
      const customBtn = overlay.querySelector('#comp-custom-submit');
      if (customBtn) customBtn.onclick = () => applySingleCard(customReason);
    } else {
      overlay.querySelectorAll('[data-multi-inc]').forEach((btn) => {
        btn.onclick = () => {
          const r = btn.dataset.multiInc;
          multiCounts[r] = Math.min(20, (multiCounts[r] || 0) + 1);
          render();
        };
      });
      overlay.querySelectorAll('[data-multi-dec]').forEach((btn) => {
        btn.onclick = () => {
          const r = btn.dataset.multiDec;
          multiCounts[r] = Math.max(0, (multiCounts[r] || 0) - 1);
          render();
        };
      });
      const multiBtn = overlay.querySelector('#comp-multi-submit');
      if (multiBtn) multiBtn.onclick = applyMultiCards;
    }
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
