// 학급점수 화면 — 16:9 고정 스테이지 + 나무/가지 밀착 + 원본 10칸(별 9개) 등간격 + 1단위 순차 이동/안착 바운스 + 무깜빡임 팝업

import { store, getStillAvatarUrl, getFxAvatarUrl, uid } from '../store.js';
import { adjustSpecialEggs } from '../score-engine.js';
import { presentOutcome, escapeHtml, escapeAttr } from '../effects.js';
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

// 원본 실측(나무.png 643px / 65px 등간격): 10단계(슬롯 0~9), 정확히 10% 등간격 (0=5%, 1=15%, ..., 9=95%, 10=105%, -1=-5%)
const stepToPercent = (step) => Math.max(-6, Math.min(106, 5 + step * 10));
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

// 나무 온도계 1단위 순차 이동 + 도착 안착 바운스 상태
let displayedEggs = null;
let targetEggsGoal = 0;
let cameraDecade = 0;
let visualStep = 0;
let isCameraPanning = false;
let stepLoopRunning = false;
let stepLoopRunId = 0;
let lastGrowthRoot = null;

/** 학급점수 화면 별길 보드가 뷰포트 크기에 맞춰 잘리지 않도록 비율 스케일 계산 */
function applyGrowthFit(root) {
  const skyArea = root?.querySelector('.growth-sky-area');
  const wrap = root?.querySelector('.star-way-wrap');
  if (!skyArea || !wrap) return;
  const availW = Math.max(360, skyArea.clientWidth - 110);
  const availH = Math.max(240, skyArea.clientHeight - 150);
  const scale = Math.max(0.45, Math.min(1.25, availW / 1120, availH / 520));
  wrap.style.setProperty('--star-scale', scale.toFixed(4));
}

window.addEventListener('resize', () => {
  if (lastGrowthRoot && lastGrowthRoot.closest('.mode-view')?.classList.contains('is-active')) {
    applyGrowthFit(lastGrowthRoot);
    if (!isCameraPanning) applyClimberDomInPlace(lastGrowthRoot, { bounce: false, ticksShiftVal: '0%' });
  }
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

/** 고도(10점 단위 decade)별 하늘 색상 · 하늘 오브젝트 · 나뭇가지 · 땅속 정보 계산 */
function getCenturyInfo(decade) {
  if (decade < 0) {
    return {
      underground: true,
      darkSpace: false,
      skyColor: '#5b3a24',
      branchUrl: 'assets/visuals/sp_board_tree_branch1.png',
      skyObjectBg: 'none',
      dark: true,
    };
  }
  const branchIdx = decade <= 1 ? 1 : decade <= 4 ? 2 : decade <= 7 ? 3 : decade <= 11 ? 4 : 5;
  let skyColor = '#44d6ed';
  let skyObjectBg = "url('assets/visuals/sp_board_sky_object2.png')";
  let dark = false;
  let darkSpace = false;

  if (decade === 0) {
    skyColor = '#44d6ed';
    skyObjectBg = "url('assets/visuals/sp_board_sky_object2.png')";
  } else if (decade <= 3) {
    skyColor = '#3ad0ee';
    skyObjectBg = "url('assets/visuals/sp_board_sky_object2.png')";
  } else if (decade <= 6) {
    skyColor = '#30bee5';
    skyObjectBg = "url('assets/visuals/sp_board_sky_object3.png')";
  } else if (decade <= 9) {
    skyColor = '#2698d4';
    skyObjectBg = "url('assets/visuals/sp_board_sky_object4.png')";
  } else if (decade <= 13) {
    skyColor = '#1e6bb8';
    skyObjectBg = "url('assets/visuals/sp_board_sky_object5.png')";
  } else {
    skyColor = '#131c45';
    skyObjectBg = "url('assets/visuals/sp_board_sky_object5.png'), url('assets/visuals/sp_board_sky_stars.png')";
    dark = true;
    darkSpace = true;
  }

  return {
    underground: false,
    darkSpace,
    skyColor,
    branchUrl: `assets/visuals/sp_board_tree_branch${branchIdx}.png`,
    skyObjectBg,
    dark,
  };
}

/** 실제 트랙 높이를 기준으로 나무(가지·기둥·줄기 1:1 일치) 및 배경·구름 다층 패럴랙스 연속 스크롤 오프셋 계산 */
function computeLayerScrollVars(root, decade, step) {
  const trackEl = root?.querySelector('.tree-track-viewport');
  const trackH = trackEl?.clientHeight || Math.max(480, (root?.clientHeight || 742) - 158);
  const treeScrollPx = Math.round(decade * trackH);
  const villageShiftPx = decade === 0
    ? 0
    : (decade > 0 ? Math.max(260, Math.round(decade * trackH)) : -Math.max(260, Math.round(Math.abs(decade) * trackH)));
  const cloudNearPx = Math.round((decade * 0.86 + step * 0.016) * trackH);
  const skyScrollPx = Math.round((decade * 0.68 + step * 0.012) * trackH);
  const skyBandPx = Math.round((decade * 0.56 + step * 0.010) * trackH);
  const cloudFarPx = Math.round((decade * 0.45 + step * 0.008) * trackH);
  const undergroundPx = Math.round(decade * trackH * 0.82);

  return {
    treeScrollPx,
    villageShiftPx,
    cloudNearPx,
    skyScrollPx,
    skyBandPx,
    cloudFarPx,
    undergroundPx,
  };
}

/** DOM 전체를 갈아엎지 않고 새싹 황금알·초록 줄기·별 눈금·나무(가지/기둥)·구름·하늘 배경을 동기화 갱신 */
function applyClimberDomInPlace(root, { bounce = false, ticksShiftVal = '0%' } = {}) {
  if (!root) return;
  const world = root.querySelector('.growth-world');
  const fillBar = root.querySelector('.tree-fill-bar');
  const climber = root.querySelector('.tree-climber-egg');
  const climberNum = root.querySelector('.tree-climber-num');
  const bgLayer = root.querySelector('.growth-bg-layer');
  const skyBand = root.querySelector('.growth-sky-band');
  const skySheet = root.querySelector('.growth-sky-sheet');
  const cloudFar = root.querySelector('.growth-cloud-sheet.is-far');
  const cloudNear = root.querySelector('.growth-cloud-sheet.is-near');
  const village = root.querySelector('.growth-village-ground');
  const trunk = root.querySelector('.growth-tree-trunk');
  const branchStrip = root.querySelector('.tree-branch-strip');
  const ticksStrip = root.querySelector('.tree-ticks-strip');
  if (!world || !fillBar || !climber) return;

  const info = getCenturyInfo(cameraDecade);
  const vars = computeLayerScrollVars(root, cameraDecade, visualStep);
  const pct = `${stepToPercent(visualStep)}%`;
  const fillPct = `${Math.max(0, stepToPercent(visualStep))}%`;

  world.classList.toggle('is-camera-panning', isCameraPanning);
  world.dataset.darkSky = info.dark ? 'true' : 'false';
  world.dataset.underground = info.underground ? 'true' : 'false';
  fillBar.style.setProperty('--egg-bottom', fillPct);
  climber.style.setProperty('--egg-bottom', pct);
  if (climberNum) climberNum.textContent = String(displayedEggs ?? 0);

  if (bgLayer) {
    bgLayer.dataset.underground = info.underground ? 'true' : 'false';
    bgLayer.dataset.darkSpace = info.darkSpace ? 'true' : 'false';
    bgLayer.style.setProperty('--sky-color', info.skyColor);
    bgLayer.style.setProperty('--underground-y', `${vars.undergroundPx}px`);
  }
  if (skyBand) skyBand.style.setProperty('--sky-band-y', `${vars.skyBandPx}px`);
  if (skySheet) {
    skySheet.style.backgroundImage = info.skyObjectBg;
    skySheet.style.setProperty('--sky-scroll-y', `${vars.skyScrollPx}px`);
  }
  if (cloudFar) cloudFar.style.setProperty('--cloud-far-y', `${vars.cloudFarPx}px`);
  if (cloudNear) cloudNear.style.setProperty('--cloud-near-y', `${vars.cloudNearPx}px`);
  if (village) {
    village.classList.toggle('is-below-view', cameraDecade !== 0);
    village.style.setProperty('--village-shift', `${vars.villageShiftPx}px`);
  }
  if (trunk) {
    trunk.style.setProperty('--tree-scroll-y', `${vars.treeScrollPx}px`);
  }
  if (branchStrip) {
    branchStrip.style.backgroundImage = `url('${info.branchUrl}')`;
    branchStrip.style.setProperty('--tree-scroll-y', `${vars.treeScrollPx}px`);
  }
  if (ticksStrip) {
    ticksStrip.style.setProperty('--ticks-shift', ticksShiftVal);
  }

  if (bounce) {
    climber.classList.remove('is-landing');
    void climber.offsetWidth;
    climber.classList.add('is-landing');
  }
}

/** 점수를 한꺼번에 부여/차감해도 원래 별에서 다음 별까지 부드럽게 이동(10칸 경계에서 전 배경·구름·가지·줄기·새 별 동반 스크롤) */
async function runStepClimberLoop() {
  if (stepLoopRunning) return;
  stepLoopRunning = true;
  const myRunId = ++stepLoopRunId;

  await nextFrame();
  await sleep(60);

  while (displayedEggs !== null && displayedEggs !== targetEggsGoal) {
    if (myRunId !== stepLoopRunId) break;
    const root = lastGrowthRoot;
    if (!root || !root.isConnected || root.hidden || !root.closest('.mode-view')?.classList.contains('is-active')) {
      displayedEggs = targetEggsGoal;
      cameraDecade = getDecade(displayedEggs);
      visualStep = getStepInDecade(displayedEggs);
      isCameraPanning = false;
      break;
    }

    const climberEl = root.querySelector('.tree-climber-egg');
    if (climberEl) void climberEl.offsetHeight;

    const dir = targetEggsGoal > displayedEggs ? 1 : -1;
    const curDecade = getDecade(displayedEggs);
    const nextEggs = displayedEggs + dir;
    const nextDecade = getDecade(nextEggs);

    if (dir > 0 && nextDecade > curDecade) {
      // 10점 경계 상승 돌파(예: 9→10): 10번째 자리(105%) 도달 → 카메라 1구간 상승(배경·구름·가지·줄기·위쪽 새 별 100% 동반 하강) → 0칸(5%) 바운스 안착
      isCameraPanning = false;
      visualStep = 10;
      displayedEggs = nextEggs;
      applyClimberDomInPlace(root, { bounce: false, ticksShiftVal: '0%' });
      await sleep(420);
      if (myRunId !== stepLoopRunId) break;

      const ticksEl = root.querySelector('.tree-ticks-strip');
      if (ticksEl) void ticksEl.offsetHeight;

      isCameraPanning = true;
      cameraDecade = nextDecade;
      visualStep = 0;
      applyClimberDomInPlace(root, { bounce: false, ticksShiftVal: '100%' });
      await sleep(710);
      if (myRunId !== stepLoopRunId) break;

      isCameraPanning = false;
      applyClimberDomInPlace(root, { bounce: true, ticksShiftVal: '0%' });
      await sleep(260);
    } else if (dir < 0 && nextDecade < curDecade) {
      // 10점 경계 하강 돌파(예: 10→9, 0→-1): 바닥 아래(-5%) 하강 → 카메라 1구간 하강(아래 구간 배경·가지·줄기·별 100% 동반 상승) → 9칸(95%) 안착
      isCameraPanning = false;
      visualStep = -1;
      displayedEggs = nextEggs;
      applyClimberDomInPlace(root, { bounce: false, ticksShiftVal: '0%' });
      await sleep(420);
      if (myRunId !== stepLoopRunId) break;

      const ticksEl = root.querySelector('.tree-ticks-strip');
      if (ticksEl) void ticksEl.offsetHeight;

      isCameraPanning = true;
      cameraDecade = nextDecade;
      visualStep = 9;
      applyClimberDomInPlace(root, { bounce: false, ticksShiftVal: '-100%' });
      await sleep(710);
      if (myRunId !== stepLoopRunId) break;

      isCameraPanning = false;
      applyClimberDomInPlace(root, { bounce: true, ticksShiftVal: '0%' });
      await sleep(260);
    } else {
      // 같은 10점 구간 내: 원래 별에서 다음 별까지 부드럽게 이동 (구름·하늘 미세 패럴랙스 동반)
      isCameraPanning = false;
      cameraDecade = nextDecade;
      displayedEggs = nextEggs;
      visualStep = getStepInDecade(nextEggs);
      applyClimberDomInPlace(root, { bounce: false, ticksShiftVal: '0%' });
      await sleep(420);
      if (myRunId !== stepLoopRunId) break;

      applyClimberDomInPlace(root, { bounce: true, ticksShiftVal: '0%' });
      await sleep(260);
    }
  }

  stepLoopRunning = false;
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
        if (lastGrowthRoot && lastGrowthRoot.closest('.mode-view')?.classList.contains('is-active')) {
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
    isCameraPanning = false;
    paintGrowthDom(root);
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
  const eggs = growth.eggs;
  const info = getCenturyInfo(cameraDecade);
  const vars = computeLayerScrollVars(root, cameraDecade, visualStep);

  const sortedGoals = [...(growth.goals || [])]
    .filter((g) => Number(g.targetEggs) > 0)
    .sort((a, b) => a.targetEggs - b.targetEggs);
  const nextGoal = sortedGoals.find((g) => g.targetEggs > eggs) || null;

  const trail = growth.pendingTrail || [];
  const eggBottomPct = `${stepToPercent(visualStep)}%`;
  const fillBottomPct = `${Math.max(0, stepToPercent(visualStep))}%`;
  const tickBandOffsets = [-100, 0, 100];

  const deltaClass = eggPendingDelta > 0 ? 'is-pos' : (eggPendingDelta < 0 ? 'is-neg' : '');
  const applyLabel = eggPendingDelta < 0 ? '차감하기' : '부여하기';

  root.innerHTML = `
    <div class="growth-world ${isCameraPanning ? 'is-camera-panning' : ''}" data-dark-sky="${info.dark ? 'true' : 'false'}" data-underground="${info.underground ? 'true' : 'false'}">
      <!-- 1. 다층 패럴랙스 하늘 배경 · 연속 구름 · 하늘 오브젝트 · 0~9점 전용 마을 땅 (z-index: 0) -->
      <div class="growth-bg-layer"
           data-underground="${info.underground ? 'true' : 'false'}"
           data-dark-space="${info.darkSpace ? 'true' : 'false'}"
           style="--sky-color:${info.skyColor};--underground-y:${vars.undergroundPx}px;">
        <div class="growth-sky-band" style="--sky-band-y:${vars.skyBandPx}px;"></div>
        <div class="growth-cloud-drift is-far">
          <div class="growth-cloud-sheet is-far" style="--cloud-far-y:${vars.cloudFarPx}px;"></div>
        </div>
        <div class="growth-sky-sheet" style="background-image:${info.skyObjectBg};--sky-scroll-y:${vars.skyScrollPx}px;"></div>
        <div class="growth-cloud-drift is-near">
          <div class="growth-cloud-sheet is-near" style="--cloud-near-y:${vars.cloudNearPx}px;"></div>
        </div>
        <div class="growth-village-ground ${cameraDecade !== 0 ? 'is-below-view' : ''}" style="--village-shift:${vars.villageShiftPx}px;"></div>
      </div>

      <!-- 2. 우측 나무 기둥 배경 (수직 나무결 동반 하강, z-index: 3) + 만능칠판 나무 호버용 큰 황금알 부여 버튼 -->
      <div class="growth-tree-trunk" style="--tree-scroll-y:${vars.treeScrollPx}px;" aria-hidden="true"></div>
      <div class="wb-tree-hover-dock">
        <button type="button" class="big-egg-btn wb-tree-hover-egg" id="btn-wb-tree-big-egg" title="클릭하여 황금알 직접 부여/차감">
          <span class="big-egg-num">${eggs}</span>
          <span class="big-egg-plus" aria-hidden="true"></span>
        </button>
      </div>

      <!-- 3. 원본 370x1080 나뭇가지 오버레이 (줄기·황금알과 1:1 동일 픽셀 하강 + 무한 반복, z-index: 4) -->
      <div class="tree-branch-overlay" aria-hidden="true">
        <div class="tree-branch-strip" style="background-image:url('${info.branchUrl}');--tree-scroll-y:${vars.treeScrollPx}px;"></div>
      </div>

      <!-- 4. 좌측 메인 하늘/별길 영역 (z-index: 5) -->
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

            <!-- 우하단 대형 황금알 (원본 주황 '+' 스프라이트 버튼) -->
            <button type="button" class="big-egg-btn" id="btn-toggle-egg-popup" title="클릭하여 황금알 직접 부여/차감">
              <span class="big-egg-num">${eggs}</span>
              <span class="big-egg-plus" aria-hidden="true"></span>
            </button>
          </div>

          <div class="growth-totals-row">
            <span class="total-chip" title="누적 상점">
              <i class="sp-icon sp-star-blue" aria-hidden="true"></i>
              ${growth.totalPositive}
            </span>
            <span class="total-chip" title="누적 감점">
              <i class="sp-icon sp-cloud-red" aria-hidden="true"></i>
              ${growth.totalNegative}
            </span>
          </div>
        </div>
      </div>

      <!-- 5. 나무 안 진한 갈색 막대 + 3구간 연속 별 스프라이트(상승 시 위에서 새 9개 별이 함께 내려옴, z-index: 6) -->
      <div class="tree-track-viewport">
        <div class="tree-ticks-scroll-clip">
          <div class="tree-ticks-strip" style="--ticks-shift:0%;">
            ${tickBandOffsets.map((bandOffset) =>
              Array.from({ length: 9 }, (_, i) => {
                const tickBottom = bandOffset + stepToPercent(i + 1);
                return `<span class="tree-tick-star" style="bottom:${tickBottom}%;" aria-hidden="true"></span>`;
              }).join('')
            ).join('')}
          </div>
          <div class="tree-fill-bar" style="--egg-bottom:${fillBottomPct};"></div>
        </div>
        <div class="tree-climber-egg" style="--egg-bottom:${eggBottomPct};">
          <span class="tree-climber-num">${displayedEggs ?? eggs}</span>
        </div>
      </div>

      <!-- 6. 우측 상단 초록 잎사귀 목표 배너 (위쪽 마진 축소 + 우측 정렬 + 첫 줄 원본 황금알 스프라이트 + 호버 2줄 메뉴, z-index: 8) -->
      <div class="goal-leaf-banner ${goalMenuOpen ? 'is-menu-open' : ''}" id="goal-leaf-banner" role="button" tabindex="0" title="클릭하여 온도계 목표설정 열기">
        <div class="goal-leaf-content">
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

      <!-- 황금알 직접 부여/차감 팝업 (부분 DOM 갱신으로 + / - 클릭 시 깜빡임 완전 제거) -->
      ${eggPopupOpen ? `
        <div class="egg-popup-backdrop" id="egg-popup-backdrop">
          <div class="egg-adjust-popup" id="egg-adjust-popup">
            <button type="button" class="egg-popup-close" id="btn-egg-popup-close" aria-label="닫기">&times;</button>
            <button type="button" class="egg-stepper-btn plus" id="btn-egg-inc" title="황금알 +1" aria-label="황금알 1 증가"></button>
            <div class="egg-stepper-val">
              <span>황금알</span>
              <strong id="egg-delta-val" class="${deltaClass}">${eggPendingDelta}</strong>
              <span>개</span>
            </div>
            <button type="button" class="egg-stepper-btn minus" id="btn-egg-dec" title="황금알 -1" aria-label="황금알 1 감소"></button>
            <div class="egg-popup-meta">
              <div>총 황금알: <strong id="egg-meta-total">${eggs + eggPendingDelta} 개</strong></div>
              <div>누적 특별 황금알: <strong id="egg-meta-special">${(growth.specialEggs + eggPendingDelta) >= 0 ? `+${growth.specialEggs + eggPendingDelta}` : (growth.specialEggs + eggPendingDelta)} 개</strong></div>
            </div>
            <button type="button" class="egg-apply-btn ${deltaClass}" id="btn-egg-apply" ${eggPendingDelta === 0 ? 'disabled' : ''}>${applyLabel}</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;

  bindGrowthEvents(root, eggs, growth.specialEggs || 0);
  applyGrowthFit(root);
  if (!isCameraPanning) {
    applyClimberDomInPlace(root, { bounce: false, ticksShiftVal: '0%' });
  }
}

/** 팝업 내부 숫자·버튼 상태만 부분 갱신 (전체 리렌더링 및 깜빡임 방지) */
function updateEggPopupDom(root, eggs, specialEggs) {
  const deltaEl = root.querySelector('#egg-delta-val');
  const totalEl = root.querySelector('#egg-meta-total');
  const specialEl = root.querySelector('#egg-meta-special');
  const applyBtn = root.querySelector('#btn-egg-apply');
  if (!deltaEl || !applyBtn) return;

  const isPos = eggPendingDelta > 0;
  const isNeg = eggPendingDelta < 0;
  deltaEl.textContent = String(eggPendingDelta);
  deltaEl.classList.toggle('is-pos', isPos);
  deltaEl.classList.toggle('is-neg', isNeg);

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
    leafBanner.onclick = () => {
      goalMenuOpen = false;
      openGoalsModal();
    };
  }

  const openEggPopup = () => {
    goalMenuOpen = false;
    eggPopupOpen = true;
    eggPendingDelta = 0;
    paintGrowthDom(root);
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

    const addDelta = (n) => {
      eggPendingDelta = Math.max(-500, Math.min(500, eggPendingDelta + n));
      updateEggPopupDom(root, eggs, specialEggs);
    };
    root.querySelector('#btn-egg-inc').onclick = () => addDelta(1);
    root.querySelector('#btn-egg-dec').onclick = () => addDelta(-1);
    root.querySelector('#btn-egg-apply').onclick = async () => {
      if (eggPendingDelta === 0) return;
      const delta = eggPendingDelta;
      eggPopupOpen = false;
      eggPendingDelta = 0;
      const outcome = await adjustSpecialEggs(delta);
      presentOutcome(outcome);
    };
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
