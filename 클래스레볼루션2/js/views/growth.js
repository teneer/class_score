// 학급점수 화면 — 원본 비율 복원 + 10점 단위 페이지 통째 스크롤(화면 먼저 바운스 전환 → 황금알 이동 + 눈금 사운드) + 목표 코인 눈금 + 일체형 키보드 입력 팝업

import { store, getStillAvatarUrl, getFxAvatarUrl, uid } from '../store.js';
import { adjustSpecialEggs } from '../score-engine.js';
import { presentOutcome, isFxStagePlaying, escapeHtml, escapeAttr } from '../effects.js';
import { playSound } from '../audio.js';

// bg-class-clouds-way.png(1500x660) 픽셀 실측 9개 별 정중앙 좌표 (우상단 → 좌측 커브 → 우하단 황금알)
const STAR_POSITIONS = [
  { x: 79.46, y: 26.14 }, // 1번째 별 (우상단)
  { x: 61.12, y: 19.37 }, // 2번째
  { x: 42.56, y: 26.04 }, // 3번째
  { x: 24.05, y: 19.37 }, // 4번째
  { x: 7.38,  y: 41.36 }, // 5번째 (좌측 커브)
  { x: 18.97, y: 70.41 }, // 6번째 (하단 좌측)
  { x: 37.52, y: 77.11 }, // 7번째
  { x: 56.04, y: 70.41 }, // 8번째
  { x: 74.59, y: 77.11 }, // 9번째 (황금알 바로 앞)
];

// 10단계(슬롯 0~9): 0=4%, 1=14.1%, ..., 9=94.9% (페이지 전환 직후 인입 위치 -6% ~ 105% 허용)
const stepToPercent = (step) => Math.max(-8, Math.min(108, 4 + step * 10.1));
const getDecade = (eggs) => Math.floor(eggs / 10);
const getStepInDecade = (eggs) => ((eggs % 10) + 10) % 10;

let editingMotto = false;
let eggPopupOpen = false;
let eggPendingDelta = 0;
let goalMenuOpen = false;

// 별길 캐릭터 유한 애니메이션(5회 후 정지 아바타로 복귀)
let prevTrailSignature = '';
let animatingStarIndex = -1;
let starAnimTimer = null;

// 나무 온도계 페이지 스크롤 & 눈금 순차 이동 상태
let displayedEggs = null;
let targetEggsGoal = 0;
let cameraDecade = 0;
let visualStep = 0;
let stepLoopRunning = false;
let stepLoopRunId = 0;
let pendingGoalOutcome = null;
let lastGrowthRoot = null;

/** 학급점수 화면 별길 보드가 원본 여백 비율에 맞게 표시되도록 스케일 계산 */
function applyGrowthFit(root) {
  const skyArea = root?.querySelector('.growth-sky-area');
  const wrap = root?.querySelector('.star-way-wrap');
  if (!skyArea || !wrap) return;
  const availW = Math.max(340, skyArea.clientWidth - 150);
  const availH = Math.max(220, skyArea.clientHeight - 190);
  const scale = Math.max(0.42, Math.min(1.06, availW / 1140, availH / 530));
  wrap.style.setProperty('--star-scale', scale.toFixed(4));
}

window.addEventListener('resize', () => {
  if (lastGrowthRoot && lastGrowthRoot.closest('.mode-view')?.classList.contains('is-active')) {
    applyGrowthFit(lastGrowthRoot);
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** 100점(century) 단위로만 바뀌고 그 안에서는 동일 테마가 루프되는 페이지 정보 계산 */
function getCenturyInfo(decade) {
  if (decade < 0) {
    return {
      underground: true,
      century: 0,
      skyColor: '#5b3a24',
      branchUrl: 'assets/visuals/sp_board_tree_branch1.png',
      skyObjectBg: 'none',
      dark: true,
    };
  }
  const eggsFloor = decade * 10;
  const century = Math.min(4, Math.floor(eggsFloor / 100)); // 0..4 (정확히 100점 단위 5단계)
  const skyColors = ['#38d3f2', '#32c8ee', '#2bb4e0', '#2488ca', '#131c45'];
  const skyObjects = [
    "url('assets/visuals/sp_board_sky_object2.png')",
    "url('assets/visuals/sp_board_sky_object2.png')",
    "url('assets/visuals/sp_board_sky_object3.png')",
    "url('assets/visuals/sp_board_sky_object4.png')",
    "url('assets/visuals/sp_board_sky_object5.png'), url('assets/visuals/sp_board_sky_stars.png')",
  ];

  const inCentury = ((decade % 10) + 10) % 10;
  const slicePosY = ['100%', '50%', '0%'][inCentury % 3]; // 1920x3240 배경 시트: 아래 → 중간 → 위 반복

  return {
    underground: false,
    century,
    skyColor: skyColors[century],
    branchUrl: `assets/visuals/sp_board_tree_branch${century + 1}.png`,
    skyObjectBg: skyObjects[century],
    skyPosY: slicePosY,
    dark: century >= 4,
  };
}

function getGoalTargetSet(state) {
  const goals = state?.growth?.goals || [];
  return new Set(goals.map((g) => Math.trunc(Number(g.targetEggs) || 0)).filter((n) => n > 0));
}

/** 단일 10점 구간 월드 페이지 슬라이드 HTML 생성 (하늘·오브젝트·기둥·나뭇가지·별/목표코인·초록줄기 일체형) */
function renderWorldPageSlideHtml(decade, fillStep, goalSet, roleClass = 'is-curr', attachedEgg = null) {
  const info = getCenturyInfo(decade);
  const fillPct = fillStep < 0 ? 0 : Math.max(0, Math.min(100, stepToPercent(fillStep)));

  const ticksHtml = Array.from({ length: 10 }, (_, k) => {
    const eggNum = decade * 10 + k;
    const pct = stepToPercent(k);
    const covered = fillStep >= k;
    const isGoal = goalSet.has(eggNum);
    if (isGoal) {
      return `<span class="tree-tick-goal-coin ${covered ? 'is-covered' : ''}" data-tick-step="${k}" style="bottom:${pct}%;" aria-hidden="true"></span>`;
    }
    if (k === 0) return '';
    return `<span class="tree-tick-star ${covered ? 'is-covered' : ''}" data-tick-step="${k}" style="bottom:${pct}%;" aria-hidden="true"></span>`;
  }).join('');

  const attachedEggHtml = attachedEgg
    ? `<div class="tree-climber-egg is-instant" style="--egg-bottom:${stepToPercent(attachedEgg.step)}%;"><span class="tree-climber-num">${attachedEgg.num}</span></div>`
    : '';

  return `
    <div class="growth-page-slide ${roleClass}" data-decade="${decade}" data-underground="${info.underground ? 'true' : 'false'}">
      <div class="growth-bg-layer" data-underground="${info.underground ? 'true' : 'false'}" style="--sky-color:${info.skyColor};">
        <div class="growth-sky-sheet" style="background-image:${info.skyObjectBg};background-position:center ${info.skyPosY || '100%'};"></div>
        ${decade === 0 ? `<div class="growth-village-ground"></div>` : ''}
      </div>
      <div class="growth-tree-trunk" aria-hidden="true"></div>
      <div class="tree-branch-overlay" aria-hidden="true">
        <div class="tree-branch-strip" style="background-image:url('${info.branchUrl}');"></div>
      </div>
      <div class="page-tree-groove">
        <div class="page-fill-clip">
          <div class="page-tree-fill" style="--fill-h:${fillPct}%;"></div>
        </div>
        <div class="page-stars-layer">
          ${ticksHtml}
        </div>
        ${attachedEggHtml}
      </div>
    </div>
  `;
}

/** 현재 표시 점수(displayedEggs)에 맞춰 큰 황금알·작은 황금알·나뭇잎 다음목표·초록줄기를 동기화 갱신 */
function syncClimberAndHudInPlace(root, { instantClimber = false } = {}) {
  if (!root) return;
  const world = root.querySelector('.growth-world');
  const climber = root.querySelector('.tree-climber-egg');
  const climberNum = root.querySelector('.tree-climber-num');
  const currSlide = root.querySelector('.growth-page-slide.is-curr');
  if (!world || !climber) return;

  const shownEggs = displayedEggs ?? store.getState().growth.eggs ?? 0;
  const info = getCenturyInfo(cameraDecade);
  world.dataset.darkSky = info.dark ? 'true' : 'false';
  world.style.background = info.skyColor;

  if (instantClimber) {
    climber.classList.add('is-instant');
  }
  climber.style.setProperty('--egg-bottom', `${stepToPercent(visualStep)}%`);
  if (climberNum) climberNum.textContent = String(shownEggs);
  if (instantClimber) {
    void climber.offsetHeight;
    climber.classList.remove('is-instant');
  }

  // 큰 황금알 숫자(학급점수 화면 + 만능칠판 호버 황금알)도 눈금 이동에 따라 실시간 변화
  const isLong = String(shownEggs).length >= 4;
  root.querySelectorAll('.big-egg-num').forEach((el) => {
    el.textContent = String(shownEggs);
    if (isLong) el.dataset.long = 'true';
    else delete el.dataset.long;
  });

  // 현재 페이지 슬라이드 내 초록 줄기 및 별/목표 코인 덮임 상태 갱신
  if (currSlide) {
    const fillEl = currSlide.querySelector('.page-tree-fill');
    if (fillEl) {
      fillEl.style.setProperty('--fill-h', `${stepToPercent(visualStep)}%`);
    }
    currSlide.querySelectorAll('[data-tick-step]').forEach((tickEl) => {
      const k = Number(tickEl.dataset.tickStep);
      tickEl.classList.toggle('is-covered', visualStep >= k);
    });
  }

  // 우상단 나뭇잎 다음목표 표시도 현재 도달한 눈금 기준으로 자연스럽게 갱신
  const leafContent = root.querySelector('#goal-leaf-content');
  if (leafContent) {
    const state = store.getState();
    const sortedGoals = [...(state.growth.goals || [])]
      .filter((g) => Number(g.targetEggs) > 0)
      .sort((a, b) => a.targetEggs - b.targetEggs);
    const nextGoal = sortedGoals.find((g) => g.targetEggs > shownEggs) || null;
    leafContent.innerHTML = nextGoal ? `
      <div class="goal-leaf-sub">
        <span>다음목표 :</span>
        <strong>${nextGoal.targetEggs}</strong>
        <i class="sp-goal-next-egg" aria-hidden="true"></i>
      </div>
      <div class="goal-leaf-reward" title="${escapeAttr(nextGoal.reward || '우리 반 보상')}">${escapeHtml(nextGoal.reward || '우리 반 보상')}</div>
    ` : `
      <div class="goal-leaf-sub">
        <span>다음목표 :</span>
        <strong>?</strong>
        <i class="sp-goal-next-egg" aria-hidden="true"></i>
      </div>
      <div class="goal-leaf-reward">온도계 목표를<br>설정해주세요.</div>
    `;
  }
}

/**
 * 10점 단위 경계에서는 화면(페이지) 전환 바운스(상승: 털썩 내려감 / 하강: 쑥 올라감)가 먼저 실행되고,
 * 그다음 작은 황금알이 목표 눈금으로 따라 올라가거나 내려가며 매 눈금 이동마다 효과음 재생
 */
async function runStepClimberLoop() {
  if (stepLoopRunning) return;
  stepLoopRunning = true;
  const myRunId = ++stepLoopRunId;

  await nextFrame();
  await sleep(40);

  // 상점/벌점 등 전체화면 연출이 떠 있으면 닫힌 직후 눈앞에서 이동 시작
  while (isFxStagePlaying()) {
    if (myRunId !== stepLoopRunId) {
      stepLoopRunning = false;
      return;
    }
    await sleep(100);
  }

  while (displayedEggs !== null && displayedEggs !== targetEggsGoal) {
    if (myRunId !== stepLoopRunId) break;
    const root = lastGrowthRoot;
    if (!root || !root.isConnected || root.hidden || !root.closest('.mode-view')?.classList.contains('is-active')) {
      displayedEggs = targetEggsGoal;
      cameraDecade = getDecade(displayedEggs);
      visualStep = getStepInDecade(displayedEggs);
      break;
    }

    const dir = targetEggsGoal > displayedEggs ? 1 : -1;
    const curDecade = getDecade(displayedEggs);
    const nextEggs = displayedEggs + dir;
    const nextDecade = getDecade(nextEggs);
    const goalSet = getGoalTargetSet(store.getState());
    const trackEl = root.querySelector('#growth-page-track');
    const climberLayerEl = root.querySelector('.tree-climber-layer');

    if (dir > 0 && nextDecade > curDecade) {
      // 1) 화면 전환 먼저: 위쪽 새 페이지가 내려오며 바닥에 '털썩' 내려앉음 (이전 9칸 황금알도 이전 페이지와 함께 아래로 내려감)
      if (climberLayerEl) climberLayerEl.style.visibility = 'hidden';
      if (trackEl) {
        trackEl.classList.remove('is-scrolling-down', 'is-scrolling-up');
        trackEl.innerHTML =
          renderWorldPageSlideHtml(nextDecade, -1, goalSet, 'is-above') +
          renderWorldPageSlideHtml(curDecade, 9, goalSet, 'is-curr', { step: 9, num: displayedEggs });
        void trackEl.offsetHeight;
        trackEl.classList.add('is-scrolling-down');
      }
      await sleep(670);
      if (myRunId !== stepLoopRunId) {
        if (climberLayerEl) climberLayerEl.style.visibility = '';
        break;
      }

      cameraDecade = nextDecade;
      if (trackEl) {
        trackEl.classList.remove('is-scrolling-down');
        trackEl.innerHTML = renderWorldPageSlideHtml(nextDecade, -1, goalSet, 'is-curr');
      }

      // 2) 그다음 황금알이 바닥 아래에서 새 페이지 시작 눈금(0칸)으로 따라서 올라감 + 사운드 + 큰 황금알 숫자 변경
      visualStep = -1;
      syncClimberAndHudInPlace(root, { instantClimber: true });
      if (climberLayerEl) climberLayerEl.style.visibility = '';
      await nextFrame();
      if (myRunId !== stepLoopRunId) break;

      displayedEggs = nextEggs;
      visualStep = 0;
      playSound('eggUp');
      syncClimberAndHudInPlace(root);
      await sleep(300);
    } else if (dir < 0 && nextDecade < curDecade) {
      // 1) 화면 전환 먼저: 아래쪽 이전 페이지가 아래에서 위로 '쑥' 올라옴 (현재 0칸 황금알도 페이지와 함께 위로 올라감)
      if (climberLayerEl) climberLayerEl.style.visibility = 'hidden';
      if (trackEl) {
        trackEl.classList.remove('is-scrolling-down', 'is-scrolling-up');
        trackEl.innerHTML =
          renderWorldPageSlideHtml(curDecade, 0, goalSet, 'is-curr', { step: 0, num: displayedEggs }) +
          renderWorldPageSlideHtml(nextDecade, 9, goalSet, 'is-below');
        void trackEl.offsetHeight;
        trackEl.classList.add('is-scrolling-up');
      }
      await sleep(550);
      if (myRunId !== stepLoopRunId) {
        if (climberLayerEl) climberLayerEl.style.visibility = '';
        break;
      }

      cameraDecade = nextDecade;
      if (trackEl) {
        trackEl.classList.remove('is-scrolling-up');
        trackEl.innerHTML = renderWorldPageSlideHtml(nextDecade, 9, goalSet, 'is-curr');
      }

      // 2) 그다음 황금알이 위에서 이전 페이지 꼭대기 눈금(9칸)으로 따라서 내려옴 + 사운드 + 큰 황금알 숫자 변경
      visualStep = 10;
      syncClimberAndHudInPlace(root, { instantClimber: true });
      if (climberLayerEl) climberLayerEl.style.visibility = '';
      await nextFrame();
      if (myRunId !== stepLoopRunId) break;

      displayedEggs = nextEggs;
      visualStep = 9;
      playSound('eggDown');
      syncClimberAndHudInPlace(root);
      await sleep(300);
    } else {
      // 같은 10점 구간 내: 바운스 없이 매끄럽게 한 눈금 이동 + 사운드 + 큰 황금알 숫자 동시 변경
      cameraDecade = nextDecade;
      displayedEggs = nextEggs;
      visualStep = getStepInDecade(nextEggs);
      playSound(dir > 0 ? 'eggUp' : 'eggDown');
      syncClimberAndHudInPlace(root);
      await sleep(290);
    }
  }

  stepLoopRunning = false;

  // 목표 눈금에 도달 완료한 직후 대기 중이던 목표 달성 연출 실행
  if (pendingGoalOutcome && displayedEggs === targetEggsGoal) {
    const out = pendingGoalOutcome;
    pendingGoalOutcome = null;
    presentOutcome(out);
  }
}

export function renderGrowthView(root) {
  lastGrowthRoot = root;
  const state = store.getState();
  const growth = state.growth;
  const targetEggs = Math.trunc(Number(growth.eggs) || 0);
  targetEggsGoal = targetEggs;

  // 별길 새 도착자 감지 → 유한(5회, ~2.2초) 애니메이션 후 기본 정지 아바타로 복귀
  const trail = growth.pendingTrail || [];
  const nextSig = trail.map((a) => `${a.studentId || 'x'}:${a.name}`).join('|');
  if (prevTrailSignature !== '' && nextSig !== prevTrailSignature && trail.length > 0) {
    const prevLen = prevTrailSignature.split('|').filter(Boolean).length;
    if (trail.length >= prevLen) {
      animatingStarIndex = trail.length - 1;
      clearTimeout(starAnimTimer);
      starAnimTimer = setTimeout(() => {
        animatingStarIndex = -1;
        if (lastGrowthRoot && !stepLoopRunning && lastGrowthRoot.closest('.mode-view')?.classList.contains('is-active')) {
          paintGrowthDom(lastGrowthRoot);
        }
      }, 2200);
    }
  }
  prevTrailSignature = nextSig;

  if (displayedEggs === null) {
    displayedEggs = targetEggs;
    cameraDecade = getDecade(targetEggs);
    visualStep = getStepInDecade(targetEggs);
    paintGrowthDom(root);
    return;
  }

  // 이미 눈금 이동 루프가 돌고 있을 때는 페이지 트랙 애니메이션이 끊기지 않도록 목표값만 갱신
  if (stepLoopRunning && root.querySelector('.growth-world')) {
    return;
  }

  paintGrowthDom(root);
  if (displayedEggs !== targetEggsGoal) {
    runStepClimberLoop();
  }
}

function paintGrowthDom(root) {
  const state = store.getState();
  const growth = state.growth;
  const actualEggs = growth.eggs;
  const shownEggs = displayedEggs ?? actualEggs;
  const info = getCenturyInfo(cameraDecade);
  const goalSet = getGoalTargetSet(state);

  const sortedGoals = [...(growth.goals || [])]
    .filter((g) => Number(g.targetEggs) > 0)
    .sort((a, b) => a.targetEggs - b.targetEggs);
  const nextGoal = sortedGoals.find((g) => g.targetEggs > shownEggs) || null;

  const trail = growth.pendingTrail || [];
  const eggBottomPct = `${stepToPercent(visualStep)}%`;
  const isLongNum = String(shownEggs).length >= 4;

  const deltaClass = eggPendingDelta > 0 ? 'is-pos' : (eggPendingDelta < 0 ? 'is-neg' : '');
  const applyLabel = eggPendingDelta < 0 ? '차감하기' : '부여하기';
  const deltaStr = String(eggPendingDelta);
  const inputChWidth = `${Math.max(1.15, deltaStr.length * 0.98)}ch`;

  root.innerHTML = `
    <div class="growth-world" data-dark-sky="${info.dark ? 'true' : 'false'}" style="background:${info.skyColor};">
      <!-- 1. 통째로 스크롤되어 교체되는 월드 페이지 영역 (하늘·새/열기구·나무기둥·나뭇가지·별/목표코인·초록줄기) -->
      <div class="growth-pages-viewport">
        <div class="growth-page-track" id="growth-page-track">
          ${renderWorldPageSlideHtml(cameraDecade, visualStep, goalSet, 'is-curr')}
        </div>
      </div>

      <!-- 만능칠판 나무 호버용 큰 황금알 부여 버튼 -->
      <div class="wb-tree-hover-dock">
        <button type="button" class="big-egg-btn wb-tree-hover-egg" id="btn-wb-tree-big-egg" title="클릭하여 황금알 직접 부여/차감">
          <span class="big-egg-num" ${isLongNum ? 'data-long="true"' : ''}>${shownEggs}</span>
          <span class="big-egg-plus" aria-hidden="true"></span>
        </button>
      </div>

      <!-- 2. 고정 UI: 좌측 하늘 위 제목 · 별길 · 캐릭터 · 큰 황금알 · 으쓱/머쓱 점수 -->
      <div class="growth-sky-area">
        <div class="motto-bar">
          ${editingMotto ? `
            <input type="text" class="motto-input" id="input-motto" value="${escapeAttr(state.classInfo.motto || '')}" maxlength="80" placeholder="우리 반의 한 마디를 작성해주세요!">
            <button type="button" class="btn-yellow" id="btn-save-motto">✓ 확인</button>
          ` : `
            <button type="button" class="motto-display" id="btn-edit-motto" title="클릭하여 우리 반의 한 마디 수정">
              ${escapeHtml(state.classInfo.motto || '우리 반의 한 마디를 작성해주세요!')}
            </button>
          `}
        </div>

        <div class="star-way-wrap">
          <div class="star-way-board">
            ${trail.slice(0, STAR_POSITIONS.length).map((actor, idx) => {
              const pos = STAR_POSITIONS[idx];
              const isAnimating = idx === animatingStarIndex && !actor.archived;
              return `
                <div class="way-star-actor ${isAnimating ? 'is-arriving' : ''}" style="left:${pos.x}%;top:${pos.y}%;">
                  ${isAnimating
                    ? `<div class="avatar-fx-sprite is-finite" style="background-image:url('${getFxAvatarUrl(actor.avatarId)}')"></div>`
                    : `<img src="${getStillAvatarUrl(actor.avatarId)}" alt="${escapeAttr(actor.name)}">`
                  }
                  <span class="way-actor-name">${escapeHtml(actor.name)}</span>
                </div>
              `;
            }).join('')}

            <!-- 우하단 대형 황금알 (눈금 이동에 따라 숫자 실시간 동기화) -->
            <button type="button" class="big-egg-btn" id="btn-toggle-egg-popup" title="클릭하여 황금알 직접 부여/차감">
              <span class="big-egg-num" ${isLongNum ? 'data-long="true"' : ''}>${shownEggs}</span>
              <span class="big-egg-plus" aria-hidden="true"></span>
            </button>
          </div>

          <div class="growth-totals-row">
            <span class="total-chip" title="누적 으쓱 점수">
              <i class="sp-icon sp-star-blue" aria-hidden="true"></i>
              ${growth.totalPositive}
            </span>
            <span class="total-chip" title="누적 머쓱 점수">
              <i class="sp-icon sp-cloud-red" aria-hidden="true"></i>
              ${growth.totalNegative}
            </span>
          </div>
        </div>
      </div>

      <!-- 3. 고정 UI: 나무 트랙 위를 오르내리는 작은 새싹 황금알 -->
      <div class="tree-climber-layer">
        <div class="tree-climber-egg" style="--egg-bottom:${eggBottomPct};">
          <span class="tree-climber-num">${shownEggs}</span>
        </div>
      </div>

      <!-- 4. 고정 UI: 우상단 초록 나뭇잎 목표 배너 (상단 살짝 크롭된 원본 형태) -->
      <div class="goal-leaf-banner ${goalMenuOpen ? 'is-menu-open' : ''}" id="goal-leaf-banner" role="button" tabindex="0" title="클릭하여 온도계 목표설정 열기">
        <div class="goal-leaf-content" id="goal-leaf-content">
          ${nextGoal ? `
            <div class="goal-leaf-sub">
              <span>다음목표 :</span>
              <strong>${nextGoal.targetEggs}</strong>
              <i class="sp-goal-next-egg" aria-hidden="true"></i>
            </div>
            <div class="goal-leaf-reward" title="${escapeAttr(nextGoal.reward || '우리 반 보상')}">${escapeHtml(nextGoal.reward || '우리 반 보상')}</div>
          ` : `
            <div class="goal-leaf-sub">
              <span>다음목표 :</span>
              <strong>?</strong>
              <i class="sp-goal-next-egg" aria-hidden="true"></i>
            </div>
            <div class="goal-leaf-reward">온도계 목표를<br>설정해주세요.</div>
          `}
        </div>
        <div class="goal-leaf-menu">
          <button type="button" class="goal-leaf-menu-btn" id="btn-open-sidebar-settings">
            <span>우측 사이드바 설정</span>
            <i class="sp-leaf-gear-orig" aria-hidden="true"></i>
          </button>
          <button type="button" class="goal-leaf-menu-btn" id="btn-open-goals">
            <span>온도계 목표설정</span>
            <i class="sp-leaf-pencil-orig" aria-hidden="true"></i>
          </button>
        </div>
      </div>

      <!-- 5. 황금알 직접 부여/차감 팝업 (+ / 숫자 / - 수직 일직선 정렬 + 무테두리 키보드 입력) -->
      ${eggPopupOpen ? `
        <div class="egg-popup-backdrop" id="egg-popup-backdrop">
          <div class="egg-adjust-popup" id="egg-adjust-popup">
            <button type="button" class="egg-popup-close" id="btn-egg-popup-close" aria-label="닫기">&times;</button>
            <button type="button" class="egg-stepper-btn plus" id="btn-egg-inc" title="황금알 +1" aria-label="황금알 1 증가"></button>
            <div class="egg-stepper-val">
              <span class="egg-stepper-label-left">황금알</span>
              <input
                type="text"
                inputmode="numeric"
                id="egg-delta-input"
                class="egg-delta-input ${deltaClass}"
                style="width:${inputChWidth};"
                value="${deltaStr}"
                maxlength="5"
                autocomplete="off"
                aria-label="부여 또는 차감할 황금알 개수"
              >
              <span class="egg-stepper-label-right">개</span>
            </div>
            <button type="button" class="egg-stepper-btn minus" id="btn-egg-dec" title="황금알 -1" aria-label="황금알 1 감소"></button>
            <div class="egg-popup-meta">
              <div>총 황금알: <strong id="egg-meta-total">${actualEggs + eggPendingDelta} 개</strong></div>
              <div>누적 특별 황금알: <strong id="egg-meta-special">${(growth.specialEggs + eggPendingDelta) >= 0 ? `+${growth.specialEggs + eggPendingDelta}` : (growth.specialEggs + eggPendingDelta)} 개</strong></div>
            </div>
            <button type="button" class="egg-apply-btn ${deltaClass}" id="btn-egg-apply" ${eggPendingDelta === 0 ? 'disabled' : ''}>${applyLabel}</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  bindGrowthEvents(root, actualEggs, growth.specialEggs || 0);
  applyGrowthFit(root);
}

/** 팝업 내부 숫자·폭·버튼 상태 부분 갱신 */
function updateEggPopupDom(root, eggs, specialEggs, { syncInputValue = true } = {}) {
  const deltaInp = root.querySelector('#egg-delta-input');
  const totalEl = root.querySelector('#egg-meta-total');
  const specialEl = root.querySelector('#egg-meta-special');
  const applyBtn = root.querySelector('#btn-egg-apply');
  if (!deltaInp || !applyBtn) return;

  const isPos = eggPendingDelta > 0;
  const isNeg = eggPendingDelta < 0;
  if (syncInputValue) {
    deltaInp.value = String(eggPendingDelta);
  }
  const rawLen = Math.max(1, (deltaInp.value || '0').length);
  deltaInp.style.width = `${Math.max(1.15, rawLen * 0.98)}ch`;
  deltaInp.classList.toggle('is-pos', isPos);
  deltaInp.classList.toggle('is-neg', isNeg);

  if (totalEl) totalEl.textContent = `${eggs + eggPendingDelta} 개`;
  if (specialEl) {
    const nextSpecial = specialEggs + eggPendingDelta;
    specialEl.textContent = `${nextSpecial >= 0 ? `+${nextSpecial}` : nextSpecial} 개`;
  }

  applyBtn.textContent = isNeg ? '차감하기' : '부여하기';
  applyBtn.disabled = eggPendingDelta === 0;
  applyBtn.classList.toggle('is-pos', isPos);
  applyBtn.classList.toggle('is-neg', isNeg);
}

function bindGrowthEvents(root, eggs, specialEggs) {
  const editMottoBtn = root.querySelector('#btn-edit-motto');
  if (editMottoBtn) {
    editMottoBtn.onclick = () => {
      editingMotto = true;
      paintGrowthDom(root);
      const inp = root.querySelector('#input-motto');
      if (inp) { inp.focus(); inp.select(); }
    };
  }
  const saveMottoBtn = root.querySelector('#btn-save-motto');
  if (saveMottoBtn) {
    const save = async () => {
      const val = root.querySelector('#input-motto')?.value.trim() || '우리 반의 한 마디를 작성해주세요!';
      editingMotto = false;
      await store.update((s) => { s.classInfo.motto = val; });
      playSound('confirm');
    };
    saveMottoBtn.onclick = save;
    const inp = root.querySelector('#input-motto');
    if (inp) {
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') { editingMotto = false; paintGrowthDom(root); }
      };
    }
  }

  const leafBanner = root.querySelector('#goal-leaf-banner');
  if (leafBanner) {
    leafBanner.onclick = (e) => {
      if (e.target.closest('#btn-open-sidebar-settings')) return;
      goalMenuOpen = false;
      openGoalsModal();
    };
  }
  const sidebarCfgBtn = root.querySelector('#btn-open-sidebar-settings');
  if (sidebarCfgBtn) {
    sidebarCfgBtn.onclick = (e) => {
      e.stopPropagation();
      goalMenuOpen = false;
      window.dispatchEvent(new CustomEvent('class123:open-class-settings'));
    };
  }
  const openGoalsBtn = root.querySelector('#btn-open-goals');
  if (openGoalsBtn) {
    openGoalsBtn.onclick = (e) => {
      e.stopPropagation();
      goalMenuOpen = false;
      openGoalsModal();
    };
  }

  const openEggPopup = () => {
    goalMenuOpen = false;
    eggPopupOpen = true;
    eggPendingDelta = 0;
    paintGrowthDom(root);
    const inp = root.querySelector('#egg-delta-input');
    if (inp) {
      inp.focus();
      inp.select();
    }
  };
  const bigEggBtn = root.querySelector('#btn-toggle-egg-popup');
  if (bigEggBtn) bigEggBtn.onclick = openEggPopup;
  const wbBigEggBtn = root.querySelector('#btn-wb-tree-big-egg');
  if (wbBigEggBtn) wbBigEggBtn.onclick = openEggPopup;

  if (eggPopupOpen) {
    const closePopup = () => {
      eggPopupOpen = false;
      eggPendingDelta = 0;
      paintGrowthDom(root);
    };
    root.querySelector('#egg-popup-backdrop').onclick = (e) => {
      if (e.target.id === 'egg-popup-backdrop') closePopup();
    };
    root.querySelector('#btn-egg-popup-close').onclick = closePopup;

    const submitEggDelta = async () => {
      if (eggPendingDelta === 0) return;
      const delta = eggPendingDelta;
      eggPopupOpen = false;
      eggPendingDelta = 0;
      paintGrowthDom(root);
      const outcome = await adjustSpecialEggs(delta);
      if (Array.isArray(outcome?.achievedGoals) && outcome.achievedGoals.length > 0) {
        // 작은 황금알이 목표 코인 눈금까지 모두 이동한 직후 목표 달성 연출이 뜨도록 예약
        pendingGoalOutcome = outcome;
        if (!stepLoopRunning && displayedEggs !== targetEggsGoal) {
          runStepClimberLoop();
        }
      } else {
        presentOutcome(outcome);
      }
    };

    const addDelta = (n) => {
      eggPendingDelta = Math.max(-500, Math.min(500, eggPendingDelta + n));
      updateEggPopupDom(root, eggs, specialEggs, { syncInputValue: true });
    };
    root.querySelector('#btn-egg-inc').onclick = () => addDelta(1);
    root.querySelector('#btn-egg-dec').onclick = () => addDelta(-1);
    root.querySelector('#btn-egg-apply').onclick = submitEggDelta;

    const deltaInp = root.querySelector('#egg-delta-input');
    if (deltaInp) {
      deltaInp.onclick = () => deltaInp.select();
      deltaInp.oninput = () => {
        const cleaned = deltaInp.value.replace(/[^0-9+-]/g, '');
        // 맨 앞 부호만 허용
        const normalized = cleaned.replace(/(?!^)[+-]/g, '');
        if (deltaInp.value !== normalized) {
          deltaInp.value = normalized;
        }
        if (normalized === '' || normalized === '-' || normalized === '+') {
          eggPendingDelta = 0;
          updateEggPopupDom(root, eggs, specialEggs, { syncInputValue: false });
          return;
        }
        const parsed = Math.max(-500, Math.min(500, Math.trunc(Number(normalized) || 0)));
        eggPendingDelta = parsed;
        deltaInp.value = String(parsed);
        updateEggPopupDom(root, eggs, specialEggs, { syncInputValue: false });
      };
      deltaInp.onblur = () => {
        deltaInp.value = String(eggPendingDelta);
        updateEggPopupDom(root, eggs, specialEggs, { syncInputValue: true });
      };
      deltaInp.onkeydown = (e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          addDelta(1);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          addDelta(-1);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          submitEggDelta();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closePopup();
        }
      };
    }
  }
}

/** 황금알 목표 설정 모달 (원본 다크 그레이 모달 + 인라인 추가/수정 + 목표 추가완료 알림) */
function openGoalsModal() {
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  let editingId = null; // 'NEW' 또는 기존 goal.id
  let draftEggs = '';
  let draftReward = '';
  let savedMessage = '';

  const renderModal = () => {
    const state = store.getState();
    const eggsNow = state.growth.eggs;
    const goalsDesc = [...(state.growth.goals || [])]
      .filter((g) => Number(g.targetEggs) > 0)
      .sort((a, b) => b.targetEggs - a.targetEggs);

    const TOTAL_SLOTS = 8;
    const usedSlots = goalsDesc.length + (editingId === 'NEW' ? 1 : 0) + (goalsDesc.length < TOTAL_SLOTS && editingId !== 'NEW' ? 1 : 0);
    const emptyTopSlots = Math.max(0, TOTAL_SLOTS - usedSlots);

    backdrop.innerHTML = `
      <div class="goals-modal-card">
        <p class="goals-modal-title">학생들이 모은 황금알 수로 학급 목표를 정해보세요.</p>
        <div class="goals-col-heads">
          <span><i class="sp-icon sp-goal-coin" aria-hidden="true"></i> 목표</span>
          <span><i class="sp-icon sp-goal-heart" aria-hidden="true"></i> 보상</span>
          <span></span>
        </div>

        <div class="goals-list">
          ${Array.from({ length: emptyTopSlots }, () => `
            <div class="goal-slot-empty"><i></i><i></i><span></span></div>
          `).join('')}

          ${editingId === 'NEW' ? `
            <div class="goal-row is-editing">
              <input type="number" id="goal-draft-eggs" min="1" max="9999" value="${escapeAttr(draftEggs)}" placeholder="목표">
              <input type="text" id="goal-draft-reward" maxlength="40" value="${escapeAttr(draftReward)}" placeholder="보상 내용 입력">
              <div class="goal-row-actions">
                <button type="button" class="goal-icon-btn is-confirm" id="btn-goal-commit" title="저장">✓</button>
                <button type="button" class="goal-icon-btn is-cancel" id="btn-goal-cancel" title="취소">&times;</button>
              </div>
            </div>
          ` : (goalsDesc.length < TOTAL_SLOTS ? `
            <div class="goal-slot-add">
              <div class="goal-slot-add-pad"></div>
              <button type="button" class="goal-add-row-btn" id="btn-add-goal-row">+ 황금알 목표를 추가해주세요.</button>
              <span></span>
            </div>
          ` : '')}

          ${goalsDesc.map((g) => {
            const achieved = eggsNow >= Number(g.targetEggs);
            if (editingId === g.id) {
              return `
                <div class="goal-row is-editing">
                  <input type="number" id="goal-draft-eggs" min="1" max="9999" value="${escapeAttr(draftEggs)}">
                  <input type="text" id="goal-draft-reward" maxlength="40" value="${escapeAttr(draftReward)}">
                  <div class="goal-row-actions">
                    <button type="button" class="goal-icon-btn is-confirm" id="btn-goal-commit" title="저장">✓</button>
                    <button type="button" class="goal-icon-btn is-cancel" id="btn-goal-cancel" title="취소">&times;</button>
                  </div>
                </div>
              `;
            }
            return `
              <div class="goal-row ${achieved ? 'is-achieved' : ''}">
                <div class="goal-row-cell is-num">${g.targetEggs}</div>
                <div class="goal-row-cell">${escapeHtml(g.reward)}</div>
                <div class="goal-row-actions">
                  <button type="button" class="goal-icon-btn" data-goal-edit="${g.id}" title="수정">✎</button>
                  <button type="button" class="goal-icon-btn" data-goal-del="${g.id}" title="삭제">&times;</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <div class="goals-modal-actions">
          <button type="button" class="btn-yellow" id="btn-close-goals" style="min-width:110px;">닫기</button>
        </div>

        ${savedMessage ? `
          <div class="goal-saved-toast">
            <p>${escapeHtml(savedMessage)}</p>
            <button type="button" id="btn-goal-toast-ok">확인</button>
          </div>
        ` : ''}
      </div>
    `;

    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    backdrop.querySelector('#btn-close-goals').onclick = close;

    const okBtn = backdrop.querySelector('#btn-goal-toast-ok');
    if (okBtn) {
      okBtn.onclick = () => {
        savedMessage = '';
        renderModal();
      };
    }

    const addBtn = backdrop.querySelector('#btn-add-goal-row');
    if (addBtn) {
      addBtn.onclick = () => {
        editingId = 'NEW';
        draftEggs = '';
        draftReward = '';
        renderModal();
        backdrop.querySelector('#goal-draft-eggs')?.focus();
      };
    }

    const eggsInp = backdrop.querySelector('#goal-draft-eggs');
    const rewardInp = backdrop.querySelector('#goal-draft-reward');
    if (eggsInp) eggsInp.oninput = () => { draftEggs = eggsInp.value; };
    if (rewardInp) rewardInp.oninput = () => { draftReward = rewardInp.value; };

    const commitBtn = backdrop.querySelector('#btn-goal-commit');
    if (commitBtn) {
      const commit = async () => {
        const num = Math.trunc(Number(draftEggs) || 0);
        const txt = (draftReward || '').trim();
        if (num <= 0 || !txt) return;
        const targetId = editingId;
        await store.update((s) => {
          const list = Array.isArray(s.growth.goals) ? s.growth.goals : [];
          if (targetId === 'NEW') {
            list.push({ id: uid('goal'), targetEggs: num, reward: txt });
          } else {
            const item = list.find((x) => x.id === targetId);
            if (item) {
              item.targetEggs = num;
              item.reward = txt;
            }
          }
          list.sort((a, b) => a.targetEggs - b.targetEggs);
          s.growth.goals = list.slice(0, 10);
        });
        playSound('confirm');
        editingId = null;
        savedMessage = targetId === 'NEW' ? '목표 추가완료!' : '목표 수정완료!';
        renderModal();
      };
      commitBtn.onclick = commit;
      if (rewardInp) {
        rewardInp.onkeydown = (e) => { if (e.key === 'Enter') commit(); };
      }
    }

    const cancelBtn = backdrop.querySelector('#btn-goal-cancel');
    if (cancelBtn) {
      cancelBtn.onclick = () => {
        editingId = null;
        renderModal();
      };
    }

    backdrop.querySelectorAll('[data-goal-edit]').forEach((btn) => {
      btn.onclick = () => {
        const g = (store.getState().growth.goals || []).find((x) => x.id === btn.dataset.goalEdit);
        if (!g) return;
        editingId = g.id;
        draftEggs = String(g.targetEggs);
        draftReward = g.reward || '';
        renderModal();
        backdrop.querySelector('#goal-draft-eggs')?.focus();
      };
    });

    backdrop.querySelectorAll('[data-goal-del]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.goalDel;
        await store.update((s) => {
          s.growth.goals = (s.growth.goals || []).filter((x) => x.id !== id);
        });
        renderModal();
      };
    });
  };

  modalRoot.appendChild(backdrop);
  renderModal();
}
