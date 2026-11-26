// 수업도구 뷰 — 뽑기 허브(랜덤 뽑기 1~9명 · 학생 섞기 · 그룹/그룹 내/이름 뽑기 · 우리반 룰렛 · 사다리 타기) + 타이머

import { store, getStillAvatarUrl, uid } from '../store.js';
import { openScoreComposer, showToast, escapeHtml, escapeAttr } from '../effects.js';
import { playSound, playTick, playTimerAlarm } from '../audio.js';

// ================== 1. 뽑기 허브 & 4대 도구 ==================
let pickerSubTool = 'hub'; // 'hub' | 'result' | 'shuffle' | 'group' | 'roulette' | 'ladder'
let genderFilter = 'all';  // 'all' | 'F' | 'M'
let lastPickedStudents = [];
let lastPickCount = 1;
let pickRollingTimer = null;
let pickRollingActive = false;

// 학생 섞기 상태
let shuffleCards = [];     // [{ student, flipped }]
let shuffleShowNumbers = true;
let shuffleShowGender = false;
let shuffleRollTimer = null;
let shuffleRolling = false;

// 그룹 뽑기 / 그룹 내 뽑기 / 이름 뽑기 상태
let lastPickedGroup = null;
let lastPickedGroupMember = null;
let groupPickTimer = null;
let groupMemberPickTimer = null;
let nameSlotOverlayOpen = false;
let nameSlotRolling = false;
let nameSlotTimer = null;
let nameSlotTargetGroupId = null; // null이면 전체 학생, groupId면 해당 모둠 내
let nameSlotWinner = null;

// 룰렛 상태
let wheelAngle = 0;
let wheelSpinning = false;
let wheelResult = '';
let wheelParkOffset = 0;
let wheelAnimRaf = 0;
let rouletteSetFilter = 'all'; // 'all' | 'fav'

// 사다리 상태
let ladderState = null;

// 놀이동산 실루엣 무한 루프 SVG 배경 (성 · 대관람차 · 롤러코스터 · 회전목마 · 천막)
const PARK_SILHOUETTE_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 210" width="960" height="210">` +
  `<rect x="0" y="198" width="960" height="12" fill="#2e293d"/>` +
  `<path d="M0 170 Q60 70 120 155 T250 110 T380 165 T520 88 T670 160 T820 105 T960 170" fill="none" stroke="#241e33" stroke-width="6"/>` +
  `<path d="M0 170 Q60 70 120 155 T250 110 T380 165 T520 88 T670 160 T820 105 T960 170" fill="none" stroke="#39304d" stroke-width="2" stroke-dasharray="6 10"/>` +
  `<g stroke="#2a233b" stroke-width="3" fill="none"><circle cx="290" cy="118" r="64"/><circle cx="290" cy="118" r="46" stroke-width="2"/><line x1="290" y1="54" x2="290" y2="182"/><line x1="226" y1="118" x2="354" y2="118"/><line x1="245" y1="73" x2="335" y2="163"/><line x1="335" y1="73" x2="245" y2="163"/><path d="M262 198 L290 118 L318 198" stroke-width="5"/></g>` +
  `<g><rect x="122" y="128" width="68" height="70" fill="#2b5a5e"/><rect x="110" y="108" width="20" height="90" fill="#3a6b73"/><rect x="182" y="108" width="20" height="90" fill="#3a6b73"/><rect x="142" y="92" width="28" height="106" fill="#417a82"/><polygon points="110,108 120,82 130,108" fill="#8b4d74"/><polygon points="182,108 192,82 202,108" fill="#8b4d74"/><polygon points="142,92 156,56 170,92" fill="#a25a82"/><path d="M146 198 v-26 a10 10 0 0 1 20 0 v26z" fill="#18222e"/></g>` +
  `<g><path d="M510 198 L545 142 L580 198 Z" fill="#6b3e5a"/><path d="M526 198 L545 142 L564 198 Z" fill="#8f5848"/><rect x="520" y="172" width="50" height="26" fill="#3b314d"/><polygon points="620,164 662,134 704,164" fill="#8f4f6d"/><rect x="628" y="164" width="68" height="34" fill="#2c3a4f"/><line x1="644" y1="164" x2="644" y2="198" stroke="#c89e48" stroke-width="2"/><line x1="662" y1="164" x2="662" y2="198" stroke="#c89e48" stroke-width="2"/><line x1="680" y1="164" x2="680" y2="198" stroke="#c89e48" stroke-width="2"/></g>` +
  `<g fill="#23483b"><polygon points="70,198 84,158 98,198"/><polygon points="215,198 228,162 241,198"/><polygon points="445,198 460,154 475,198"/><polygon points="756,198 770,158 784,198"/><polygon points="888,198 902,156 916,198"/></g>` +
  `<g><polygon points="804,168 842,138 880,168" fill="#7c445c"/><rect x="812" y="168" width="60" height="30" fill="#3a2c44"/></g>` +
  `</svg>`
);

function clearPickerTimers() {
  clearTimeout(pickRollingTimer);
  clearInterval(shuffleRollTimer);
  clearInterval(groupPickTimer);
  clearInterval(groupMemberPickTimer);
  clearInterval(nameSlotTimer);
  cancelAnimationFrame(wheelAnimRaf);
  pickRollingActive = false;
  shuffleRolling = false;
  nameSlotRolling = false;
  wheelSpinning = false;
}

function renderCloverSvg(size = 56) {
  return `
    <svg viewBox="0 0 64 64" width="${size}" height="${size}" aria-hidden="true">
      <path d="M30 29 C30 14, 15 8, 12 18 C9 26, 20 30, 30 29 Z" fill="#ffd83b"/>
      <path d="M34 29 C34 14, 49 8, 52 18 C55 26, 44 30, 34 29 Z" fill="#ffd83b"/>
      <path d="M30 35 C20 34, 9 38, 12 46 C15 56, 30 50, 30 35 Z" fill="#ffd83b"/>
      <path d="M34 35 C44 34, 55 38, 52 46 C49 56, 34 50, 34 35 Z" fill="#ffffff"/>
    </svg>
  `;
}

function getGenderLabel(filter) {
  if (filter === 'F') return '여자';
  if (filter === 'M') return '남자';
  return '모두';
}

export function setPickerSubTool(tool) {
  clearPickerTimers();
  pickerSubTool = tool || 'hub';
}

export function renderPickerView(root) {
  const state = store.getState();
  const activeStudents = state.students.filter((s) => !s.trashed && !s.absent);
  const filteredPool = activeStudents.filter((s) => genderFilter === 'all' || s.gender === genderFilter);
  const pickedSet = new Set(state.tools.pickedIds || []);
  const remaining = filteredPool.filter((s) => !pickedSet.has(s.id));

  if (pickerSubTool === 'hub') {
    renderPickerHub(root, filteredPool, remaining);
  } else if (pickerSubTool === 'result') {
    renderPickResult(root, filteredPool, remaining);
  } else if (pickerSubTool === 'shuffle') {
    renderShuffleTool(root, activeStudents);
  } else if (pickerSubTool === 'group') {
    renderGroupPickerTool(root, state);
  } else if (pickerSubTool === 'roulette') {
    renderRouletteTool(root, state, activeStudents);
  } else if (pickerSubTool === 'ladder') {
    renderLadderTool(root, state, activeStudents);
  }
}

function renderPickerHub(root, filteredPool, remaining) {
  root.innerHTML = `
    <div class="tools-dark-stage" style="background:#000000;">
      <div class="picker-header-row">
        <div class="picker-title-group">
          <span style="font-size:32px;">👥⭐</span>
          <h2>학생 랜덤 뽑기</h2>
          <span class="picker-remain-badge">${remaining.length} / ${filteredPool.length}</span>
          <button type="button" class="picker-reset-btn" id="btn-reset-picked">↺ 뽑기 대상 초기화</button>
        </div>
      </div>

      <div class="picker-filter-row">
        <span class="picker-filter-label">뽑기 대상</span>
        <div class="gender-seg">
          <button type="button" class="${genderFilter === 'all' ? 'is-active' : ''}" data-gender="all">모두</button>
          <button type="button" class="${genderFilter === 'F' ? 'is-active' : ''}" data-gender="F">여자</button>
          <button type="button" class="${genderFilter === 'M' ? 'is-active' : ''}" data-gender="M">남자</button>
        </div>
        <button type="button" class="gender-edit-link" id="btn-edit-gender">성별 일괄입력</button>
      </div>

      <div class="pick-count-row">
        ${Array.from({ length: 9 }, (_, i) => {
          const n = i + 1;
          return `<button type="button" class="pick-num-btn" data-pick-n="${n}" ${remaining.length === 0 ? 'disabled' : ''}>${n}명</button>`;
        }).join('')}
        <span style="font-size:16px;color:#b8bfcc;font-weight:700;margin-left:4px;">뽑기</span>
      </div>

      <div class="tool-cards-grid">
        <div class="tool-feature-card">
          <button type="button" class="tool-card-box" data-open-subtool="shuffle">
            <span class="tool-card-emoji">🔀</span>
            <span>학생 섞기</span>
          </button>
          <p class="tool-card-desc">한 장씩 카드를 뒤집어 누군지 확인하세요.<br>급식·발표 순서 정할 때 최고!</p>
        </div>

        <div class="tool-feature-card">
          <button type="button" class="tool-card-box" data-open-subtool="group">
            <span class="tool-card-emoji">🗂</span>
            <span>그룹 뽑기</span>
          </button>
          <p class="tool-card-desc">자리보기가 설정되어 있는 경우,<br>그룹·그룹 내·이름 뽑기를 할 수 있습니다.</p>
        </div>

        <div class="tool-feature-card">
          <button type="button" class="tool-card-box" data-open-subtool="roulette">
            <span class="tool-card-emoji">🎯</span>
            <span>우리반 룰렛</span>
          </button>
          <p class="tool-card-desc">빙빙~ 무엇이 뽑힐까요?<br>학생·모둠·직접입력 항목 지원</p>
        </div>

        <div class="tool-feature-card">
          <button type="button" class="tool-card-box" data-open-subtool="ladder">
            <span class="tool-card-emoji">🪜</span>
            <span>사다리 타기</span>
          </button>
          <p class="tool-card-desc">오르락~ 내리락~<br>1인 1역을 정해볼까요?</p>
        </div>
      </div>
    </div>
  `;

  root.querySelectorAll('[data-gender]').forEach((b) => {
    b.onclick = () => {
      genderFilter = b.dataset.gender;
      renderPickerView(root);
    };
  });

  root.querySelector('#btn-reset-picked').onclick = async () => {
    await store.update((s) => { s.tools.pickedIds = []; });
    playSound('confirm');
    showToast({ title: '뽑기 대상 목록을 초기화했습니다.' });
  };

  root.querySelector('#btn-edit-gender').onclick = () => openGenderBulkModal();

  root.querySelectorAll('[data-pick-n]').forEach((btn) => {
    btn.onclick = () => {
      const requested = Number(btn.dataset.pickN) || 1;
      startRandomStudentPick(root, requested);
    };
  });

  root.querySelectorAll('[data-open-subtool]').forEach((btn) => {
    btn.onclick = () => {
      clearPickerTimers();
      pickerSubTool = btn.dataset.openSubtool;
      if (pickerSubTool === 'shuffle') {
        const list = store.getState().students.filter((s) => !s.trashed && !s.absent);
        shuffleCards = [...list].sort(() => Math.random() - 0.5).map((st) => ({ student: st, flipped: false }));
        renderPickerView(root);
        runShuffleIntroRoll(root, list);
        return;
      }
      if (pickerSubTool === 'group') {
        lastPickedGroup = null;
        lastPickedGroupMember = null;
        nameSlotOverlayOpen = false;
      }
      renderPickerView(root);
    };
  });
}

/** 학생 랜덤 뽑기: 3초 동안 검정 배경에 어두운(dim) 캐릭터·이름이 회전 후 당첨 멈춤 + 네잎클로버 Y축 회전 */
function startRandomStudentPick(root, requestedCount) {
  const state = store.getState();
  const activeStudents = state.students.filter((s) => !s.trashed && !s.absent);
  const filteredPool = activeStudents.filter((s) => genderFilter === 'all' || s.gender === genderFilter);
  const pickedSet = new Set(state.tools.pickedIds || []);
  const remaining = filteredPool.filter((s) => !pickedSet.has(s.id));

  const count = Math.min(requestedCount, remaining.length);
  if (count <= 0) {
    showToast({ title: '남은 뽑기 대상 학생이 없습니다. 초기화 후 다시 시도하세요.', tone: 'minus' });
    return;
  }

  clearPickerTimers();
  lastPickCount = requestedCount;
  pickRollingActive = true;
  pickerSubTool = 'result';

  const shuffled = [...remaining].sort(() => Math.random() - 0.5);
  const chosen = shuffled.slice(0, count);
  lastPickedStudents = chosen;
  const rollPool = filteredPool.length > 0 ? filteredPool : remaining;
  const isMulti = count > 1;

  // 추첨 중(3초) 전용 화면 렌더링 (다른 UI 없이 순수 검정 배경 + 중앙 dim 캐릭터 & 이름)
  root.innerHTML = `
    <div class="tools-dark-stage pick-stage-fullscreen">
      <div class="pick-rolling-center">
        ${Array.from({ length: count }, (_, idx) => {
          const initSt = rollPool[idx % rollPool.length];
          return `
            <div class="pick-rolling-slot ${isMulti ? 'is-multi' : ''}" data-roll-slot="${idx}">
              <img src="${getStillAvatarUrl(initSt.avatarId)}" alt="">
              <span class="pick-rolling-name">${escapeHtml(initSt.name)}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  const slotEls = Array.from(root.querySelectorAll('[data-roll-slot]'));
  const startTime = performance.now();
  const TOTAL_MS = 3000;

  const tickRoll = () => {
    if (!pickRollingActive || !root.isConnected) return;
    const elapsed = performance.now() - startTime;
    if (elapsed >= TOTAL_MS) {
      pickRollingActive = false;
      store.update((s) => {
        s.tools.pickedIds = Array.from(new Set([...(s.tools.pickedIds || []), ...chosen.map((c) => c.id)]));
      }).then(() => {
        playSound('pickResult');
        const stNow = store.getState();
        const actNow = stNow.students.filter((s) => !s.trashed && !s.absent);
        const fPool = actNow.filter((s) => genderFilter === 'all' || s.gender === genderFilter);
        const pSet = new Set(stNow.tools.pickedIds || []);
        const remNow = fPool.filter((s) => !pSet.has(s.id));
        renderPickResult(root, fPool, remNow);
      });
      return;
    }

    const progress = elapsed / TOTAL_MS;
    slotEls.forEach((slotEl) => {
      const randSt = rollPool[Math.floor(Math.random() * rollPool.length)];
      const img = slotEl.querySelector('img');
      const nameEl = slotEl.querySelector('.pick-rolling-name');
      if (img) img.src = getStillAvatarUrl(randSt.avatarId);
      if (nameEl) nameEl.textContent = randSt.name;
    });
    playTick(540 + progress * 260, 0.024);

    // 초반 빠르게(60ms) → 마지막에 점진 감속(210ms)
    const nextDelay = Math.round(60 + Math.pow(progress, 2.2) * 165);
    pickRollingTimer = setTimeout(tickRoll, nextDelay);
  };

  tickRoll();
}

function renderPickResult(root, filteredPool = [], remaining = []) {
  if (pickRollingActive) return;
  const isSingle = lastPickedStudents.length === 1;
  const singleSt = lastPickedStudents[0];

  root.innerHTML = `
    <div class="tools-dark-stage pick-stage-fullscreen">
      <div class="pick-final-stage">
        ${isSingle && singleSt ? `
          <div class="pick-single-hero">
            <div class="pick-single-left">
              <div class="pick-clover-spin">${renderCloverSvg(56)}</div>
              <img src="${getStillAvatarUrl(singleSt.avatarId)}" alt="${escapeAttr(singleSt.name)}">
            </div>
            <div class="pick-single-name">${escapeHtml(singleSt.name)}</div>
          </div>
        ` : `
          <div class="pick-multi-grid">
            ${lastPickedStudents.map((st) => `
              <div class="pick-multi-item">
                <div class="pick-clover-spin is-small">${renderCloverSvg(32)}</div>
                <img src="${getStillAvatarUrl(st.avatarId)}" alt="${escapeAttr(st.name)}">
                <span class="pick-multi-name">${escapeHtml(st.name)}</span>
              </div>
            `).join('')}
          </div>
        `}

        <div class="pick-action-bar">
          <button type="button" class="pick-yellow-btn" id="btn-pick-back">돌아가기</button>
          <button type="button" class="pick-yellow-btn" id="btn-pick-continue" ${remaining.length === 0 ? 'disabled' : ''}>
            계속뽑기
            <span class="pick-btn-tooltip">다른 학생을 새로 뽑습니다.</span>
          </button>
          <button type="button" class="pick-yellow-btn" id="btn-pick-award">쑥쑥카드주기</button>
        </div>

        <div class="pick-bottom-meta">
          <button type="button" class="pick-bottom-reset-link" id="btn-result-reset-picked">뽑기 대상 초기화</button>
          <div>아직 뽑히지 않은 학생 : <strong>${remaining.length}</strong> / ${filteredPool.length} (${getGenderLabel(genderFilter)})</div>
        </div>
      </div>
    </div>
  `;

  root.querySelector('#btn-pick-back').onclick = () => {
    pickerSubTool = 'hub';
    renderPickerView(root);
  };
  root.querySelector('#btn-pick-continue').onclick = () => {
    startRandomStudentPick(root, lastPickCount);
  };
  root.querySelector('#btn-pick-award').onclick = () => {
    if (lastPickedStudents.length === 0) return;
    openScoreComposer({ studentIds: lastPickedStudents.map((s) => s.id), initialType: 'positive' });
  };
  root.querySelector('#btn-result-reset-picked').onclick = async () => {
    await store.update((s) => { s.tools.pickedIds = []; });
    playSound('confirm');
    showToast({ title: '뽑기 대상 목록을 초기화했습니다.' });
  };
}

/** 학생 섞기: 각 자리마다 이름과 캐릭터가 빠르게 바뀌며 섞이다가 Y축 회전하며 뒷면으로 덮이는 연출 */
function runShuffleIntroRoll(root, activeStudents) {
  if (!activeStudents || activeStudents.length === 0) return;
  clearInterval(shuffleRollTimer);
  shuffleRolling = true;

  const wraps = Array.from(root.querySelectorAll('.shuffle-card-wrap'));
  // 1단계: 모든 카드를 앞면으로 열어 각 자리의 이름·캐릭터가 빠르게 섞이는 모습을 보여줌
  wraps.forEach((w) => w.classList.add('is-flipped'));

  let step = 0;
  const totalTicks = 12;
  shuffleRollTimer = setInterval(() => {
    if (!root.isConnected || pickerSubTool !== 'shuffle') {
      clearInterval(shuffleRollTimer);
      shuffleRolling = false;
      return;
    }
    step++;
    if (step < totalTicks) {
      wraps.forEach((w) => {
        const randSt = activeStudents[Math.floor(Math.random() * activeStudents.length)];
        const img = w.querySelector('.shuffle-face-front img');
        const nameEl = w.querySelector('.shuffle-front-name');
        if (img) img.src = getStillAvatarUrl(randSt.avatarId);
        if (nameEl) {
          nameEl.innerHTML = `${shuffleShowNumbers ? `<span class="shuffle-front-num">${randSt.number}</span>` : ''}${escapeHtml(randSt.name)}`;
        }
      });
      playTick(520 + step * 25, 0.02);
    } else {
      clearInterval(shuffleRollTimer);
      // 2단계: 최종 확정된 무작위 학생으로 세팅한 직후 Y축 회전하며 뒷면으로 덮임!
      wraps.forEach((w, idx) => {
        const card = shuffleCards[idx];
        if (!card) return;
        const st = card.student;
        const img = w.querySelector('.shuffle-face-front img');
        const nameEl = w.querySelector('.shuffle-front-name');
        if (img) img.src = getStillAvatarUrl(st.avatarId);
        if (nameEl) {
          nameEl.innerHTML = `${shuffleShowNumbers ? `<span class="shuffle-front-num">${st.number}</span>` : ''}${escapeHtml(st.name)}`;
        }
        card.flipped = false;
        setTimeout(() => {
          if (w.isConnected) w.classList.remove('is-flipped');
        }, Math.min(220, idx * 14));
      });
      playSound('cardFlip');
      shuffleRolling = false;
    }
  }, 85);
}

function renderShuffleTool(root, activeStudents) {
  if (shuffleCards.length === 0) {
    shuffleCards = [...activeStudents].sort(() => Math.random() - 0.5).map((st) => ({ student: st, flipped: false }));
  }

  root.innerHTML = `
    <div class="tools-dark-stage" style="background:#000000;justify-content:flex-start;">
      <div class="subtool-header">
        <div style="display:flex;align-items:center;gap:12px;">
          <button type="button" class="subtool-back-btn" id="btn-sub-back">← 뽑기 허브로</button>
          <h2 style="margin:0;color:#ffe347;font-size:18px;">누구일까요? 학생을 클릭해서 열어보세요!</h2>
        </div>

        <div class="shuffle-top-options">
          ${shuffleShowGender ? `
            <div class="shuffle-legend">
              <span><i class="shuffle-legend-dot is-f"></i>여자</span>
              <span><i class="shuffle-legend-dot is-m"></i>남자</span>
            </div>
          ` : ''}
          <label class="shuffle-check-label">
            <input type="checkbox" id="chk-shuffle-gender" ${shuffleShowGender ? 'checked' : ''}>
            <span>성별 표시</span>
          </label>
          <label class="shuffle-check-label">
            <input type="checkbox" id="chk-shuffle-number" ${shuffleShowNumbers ? 'checked' : ''}>
            <span>번호 표시</span>
          </label>
          <button type="button" class="btn-outline" id="btn-shuffle-all-open" style="background:#262b36;color:#fff;border-color:#3f4656;padding:6px 12px;font-size:12.5px;">모두 열기</button>
          <button type="button" class="btn-outline" id="btn-shuffle-all-close" style="background:#262b36;color:#fff;border-color:#3f4656;padding:6px 12px;font-size:12.5px;">모두 닫기</button>
          <button type="button" class="btn-yellow" id="btn-shuffle-again" style="padding:6px 14px;font-size:12.5px;">다시 섞기</button>
          <button type="button" class="btn-blue" id="btn-shuffle-award" style="padding:6px 12px;font-size:12.5px;">쑥쑥카드 주기</button>
        </div>
      </div>

      <div class="shuffle-grid">
        ${shuffleCards.map((card, idx) => {
          const st = card.student;
          const gDot = shuffleShowGender && (st.gender === 'F' || st.gender === 'M')
            ? `<span class="shuffle-gender-dot ${st.gender === 'F' ? 'is-f' : 'is-m'}" title="${st.gender === 'F' ? '여자' : '남자'}"></span>`
            : '';
          return `
            <button type="button" class="shuffle-card-wrap ${card.flipped ? 'is-flipped' : ''}" data-shuffle-idx="${idx}">
              <div class="shuffle-card-inner">
                <div class="shuffle-face shuffle-face-back">
                  ${gDot}
                  <span class="shuffle-back-num">${idx + 1}</span>
                  <span class="shuffle-back-hint">클릭해서 열기</span>
                </div>
                <div class="shuffle-face shuffle-face-front">
                  <span class="shuffle-card-order">${idx + 1}번째</span>
                  <img src="${getStillAvatarUrl(st.avatarId)}" alt="">
                  <span class="shuffle-front-name">${shuffleShowNumbers ? `<span class="shuffle-front-num">${st.number}</span>` : ''}${escapeHtml(st.name)}</span>
                </div>
              </div>
            </button>
          `;
        }).join('')}
      </div>
    </div>
  `;

  root.querySelector('#btn-sub-back').onclick = () => {
    clearPickerTimers();
    pickerSubTool = 'hub';
    renderPickerView(root);
  };
  root.querySelector('#chk-shuffle-gender').onchange = (e) => {
    shuffleShowGender = e.target.checked;
    renderPickerView(root);
  };
  root.querySelector('#chk-shuffle-number').onchange = (e) => {
    shuffleShowNumbers = e.target.checked;
    renderPickerView(root);
  };
  root.querySelector('#btn-shuffle-again').onclick = () => {
    if (shuffleRolling) return;
    shuffleCards = [...activeStudents].sort(() => Math.random() - 0.5).map((st) => ({ student: st, flipped: false }));
    renderPickerView(root);
    runShuffleIntroRoll(root, activeStudents);
  };
  root.querySelector('#btn-shuffle-all-open').onclick = () => {
    if (shuffleRolling) return;
    shuffleCards.forEach((c) => { c.flipped = true; });
    root.querySelectorAll('.shuffle-card-wrap').forEach((w) => w.classList.add('is-flipped'));
    playSound('cardFlip');
  };
  root.querySelector('#btn-shuffle-all-close').onclick = () => {
    if (shuffleRolling) return;
    shuffleCards.forEach((c) => { c.flipped = false; });
    root.querySelectorAll('.shuffle-card-wrap').forEach((w) => w.classList.remove('is-flipped'));
    playSound('cardFlip');
  };
  root.querySelector('#btn-shuffle-award').onclick = () => {
    const opened = shuffleCards.filter((c) => c.flipped).map((c) => c.student.id);
    if (opened.length === 0) {
      showToast({ title: '먼저 카드를 열어 학생을 선택해주세요.', tone: 'minus' });
      return;
    }
    openScoreComposer({ studentIds: opened, initialType: 'positive' });
  };
  root.querySelectorAll('[data-shuffle-idx]').forEach((wrap) => {
    wrap.onclick = () => {
      if (shuffleRolling) return;
      const card = shuffleCards[Number(wrap.dataset.shuffleIdx)];
      if (!card) return;
      card.flipped = !card.flipped;
      wrap.classList.toggle('is-flipped', card.flipped);
      playTick(card.flipped ? 820 : 560, 0.05);
    };
  });
}

/** 그룹 뽑기 + 그룹 내 뽑기(그룹원 카드 하이라이트) + 이름 뽑기(글자별 섞기) */
function renderGroupPickerTool(root, state) {
  const groups = [...state.groups].sort((a, b) => a.order - b.order);
  const activeStudents = state.students.filter((s) => !s.trashed && !s.absent);
  const pickedMembers = lastPickedGroup
    ? activeStudents.filter((s) => s.groupId === lastPickedGroup.id)
    : [];

  const winnerGroup = nameSlotWinner
    ? state.groups.find((g) => g.id === nameSlotWinner.groupId) || lastPickedGroup
    : lastPickedGroup;

  root.innerHTML = `
    <div class="tools-dark-stage" style="position:relative;justify-content:flex-start;">
      <div class="subtool-header">
        <button type="button" class="subtool-back-btn" id="btn-sub-back">← 뽑기 허브로</button>
        <h2 style="margin:0;">🗂 그룹 뽑기 · 그룹 내 뽑기 · 이름 뽑기</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" class="btn-yellow" id="btn-run-group-pick">🎲 그룹 뽑기</button>
          <button type="button" class="btn-outline" id="btn-run-member-pick" style="background:#262b36;color:#ffe347;border-color:#ffe347;" ${!lastPickedGroup || pickedMembers.length === 0 ? 'disabled' : ''}>✨ 그룹 내 뽑기</button>
          <button type="button" class="btn-outline" id="btn-run-name-slot" style="background:#262b36;color:#fff;border-color:#4b5568;" ${activeStudents.length === 0 ? 'disabled' : ''}>🔤 이름 뽑기</button>
        </div>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;">
        ${groups.map((g) => {
          const isWin = lastPickedGroup && lastPickedGroup.id === g.id;
          const cnt = state.students.filter((s) => !s.trashed && s.groupId === g.id).length;
          return `
            <div data-group-pick-card="${g.id}" style="min-width:148px;padding:16px 18px;border-radius:12px;text-align:center;background:${isWin ? '#ffe347' : '#21252f'};color:${isWin ? '#291f04' : '#e2e6f0'};border:2px solid ${isWin ? '#fff' : '#383e4c'};transform:${isWin ? 'scale(1.07)' : 'none'};transition:all 0.14s;">
              <div style="font-size:19px;font-weight:900;">${escapeHtml(g.name)}</div>
              <div style="font-size:12px;margin-top:4px;opacity:0.8;">${cnt}명</div>
            </div>
          `;
        }).join('')}
      </div>

      ${lastPickedGroup ? `
        <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px;margin-top:6px;">
          <div class="wheel-result-banner">
            🎉 ${escapeHtml(lastPickedGroup.name)} 당첨!
            ${lastPickedGroupMember ? ` → 대표: ${escapeHtml(lastPickedGroupMember.name)}` : ''}
          </div>
          <div class="pick-result-grid">
            ${pickedMembers.map((st) => {
              const isWinMember = lastPickedGroupMember && lastPickedGroupMember.id === st.id;
              return `
                <div class="pick-winner-card ${isWinMember ? 'is-member-win' : ''}" data-group-member-id="${st.id}">
                  <img src="${getStillAvatarUrl(st.avatarId)}" alt="">
                  <span class="pick-winner-name">${escapeHtml(st.name)}</span>
                </div>
              `;
            }).join('')}
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">
            ${lastPickedGroupMember ? `
              <button type="button" class="btn-yellow" id="btn-member-win-award">★ ${escapeHtml(lastPickedGroupMember.name)} 카드주기</button>
            ` : ''}
            <button type="button" class="btn-blue" id="btn-grp-win-plus">★ 모둠원 전원 으쓱 주기</button>
            <button type="button" class="btn-red" id="btn-grp-win-minus">☁ 모둠원 전원 머쓱 주기</button>
          </div>
        </div>
      ` : `<p style="text-align:center;color:#8e96a8;margin-top:20px;">상단의 <strong>그룹 뽑기</strong> 또는 <strong>이름 뽑기</strong> 버튼을 눌러보세요.</p>`}

      ${nameSlotOverlayOpen ? `
        <div class="name-slot-overlay" id="name-slot-overlay">
          <button type="button" class="name-slot-close" id="btn-name-slot-close" aria-label="닫기">&times;</button>
          <div class="name-slot-chars ${nameSlotRolling ? 'is-rolling' : ''}" id="name-slot-chars">
            ${nameSlotWinner ? escapeHtml(nameSlotWinner.name) : '???'}
          </div>
          <div class="name-slot-group" id="name-slot-group">
            ${!nameSlotRolling && winnerGroup ? escapeHtml(winnerGroup.name) : ''}
          </div>
          ${!nameSlotRolling && nameSlotWinner ? `
            <div class="name-slot-actions">
              <button type="button" id="btn-ns-award-student">뽑힌 학생 카드주기</button>
              ${winnerGroup ? `<button type="button" id="btn-ns-award-group">그룹에 카드주기</button>` : ''}
              <button type="button" id="btn-ns-repick">다시 뽑기</button>
            </div>
          ` : ''}
        </div>
      ` : ''}
    </div>
  `;

  root.querySelector('#btn-sub-back').onclick = () => {
    clearPickerTimers();
    nameSlotOverlayOpen = false;
    pickerSubTool = 'hub';
    renderPickerView(root);
  };

  // 1. 그룹 뽑기 (그룹 카드 하이라이트)
  root.querySelector('#btn-run-group-pick').onclick = () => {
    if (groups.length === 0) return;
    clearInterval(groupPickTimer);
    clearInterval(groupMemberPickTimer);
    lastPickedGroupMember = null;
    let step = 0;
    const totalSteps = 14;
    groupPickTimer = setInterval(() => {
      lastPickedGroup = groups[Math.floor(Math.random() * groups.length)];
      playTick(500 + step * 35, 0.03);
      renderPickerView(root);
      step++;
      if (step >= totalSteps) {
        clearInterval(groupPickTimer);
        playSound('slotDone');
      }
    }, 85);
  };

  // 2. 그룹 내 뽑기 (뽑힌 그룹원 카드를 그룹 선택처럼 빠르게 하이라이트하다가 당첨 시 멈춤)
  const memberPickBtn = root.querySelector('#btn-run-member-pick');
  if (memberPickBtn) {
    memberPickBtn.onclick = () => {
      if (!lastPickedGroup || pickedMembers.length === 0) return;
      clearInterval(groupMemberPickTimer);
      lastPickedGroupMember = null;
      const cards = Array.from(root.querySelectorAll('[data-group-member-id]'));
      if (cards.length === 0) return;

      let step = 0;
      const totalSteps = Math.max(14, cards.length * 4);
      let prevIdx = -1;
      groupMemberPickTimer = setInterval(() => {
        let idx = Math.floor(Math.random() * pickedMembers.length);
        if (pickedMembers.length > 1 && idx === prevIdx) idx = (idx + 1) % pickedMembers.length;
        prevIdx = idx;

        cards.forEach((c, i) => {
          c.classList.toggle('is-member-hl', i === idx);
          c.classList.remove('is-member-win');
        });
        playTick(560 + step * 26, 0.028);
        step++;
        if (step >= totalSteps) {
          clearInterval(groupMemberPickTimer);
          lastPickedGroupMember = pickedMembers[idx];
          playSound('slotDone');
          renderPickerView(root);
        }
      }, 85);
    };
  }

  // 3. 이름 뽑기 (이름 각 글자를 한 글자씩 섞어서 빠르게 변하다가 최종 당첨자 이름으로 멈춤)
  const runNameSlot = (scopeGroupId) => {
    const pool = scopeGroupId
      ? activeStudents.filter((s) => s.groupId === scopeGroupId)
      : activeStudents;
    if (pool.length === 0) return;

    clearInterval(nameSlotTimer);
    nameSlotTargetGroupId = scopeGroupId;
    nameSlotOverlayOpen = true;
    nameSlotRolling = true;
    nameSlotWinner = pool[Math.floor(Math.random() * pool.length)];
    renderPickerView(root);

    // 풀에 있는 학생 이름 글자들을 모아 각 자리 글자별로 무작위 셔플
    const allChars = pool.flatMap((s) => Array.from(s.name || '')).filter(Boolean);
    const targetChars = Array.from(nameSlotWinner.name || '학생');
    const charsEl = root.querySelector('#name-slot-chars');
    let tick = 0;
    const totalTicks = 24; // ~1.9초 동안 글자별 섞기

    nameSlotTimer = setInterval(() => {
      if (!root.isConnected || !nameSlotOverlayOpen) {
        clearInterval(nameSlotTimer);
        nameSlotRolling = false;
        return;
      }
      tick++;
      const lockedCount = tick >= totalTicks
        ? targetChars.length
        : Math.max(0, Math.floor((tick - 12) / Math.max(1, Math.floor((totalTicks - 12) / targetChars.length))));

      const displayStr = targetChars.map((ch, idx) => {
        if (idx < lockedCount) return ch;
        return allChars[Math.floor(Math.random() * allChars.length)] || ch;
      }).join('');

      if (charsEl) charsEl.textContent = displayStr;
      playTick(520 + tick * 18, 0.024);

      if (tick >= totalTicks) {
        clearInterval(nameSlotTimer);
        nameSlotRolling = false;
        playSound('slotDone');
        renderPickerView(root);
      }
    }, 78);
  };

  const nameSlotBtn = root.querySelector('#btn-run-name-slot');
  if (nameSlotBtn) {
    nameSlotBtn.onclick = () => runNameSlot(null);
  }

  const memberAwardBtn = root.querySelector('#btn-member-win-award');
  if (memberAwardBtn && lastPickedGroupMember) {
    memberAwardBtn.onclick = () => openScoreComposer({ studentIds: [lastPickedGroupMember.id], initialType: 'positive' });
  }
  const pPlus = root.querySelector('#btn-grp-win-plus');
  if (pPlus) pPlus.onclick = () => openScoreComposer({ studentIds: pickedMembers.map((m) => m.id), initialType: 'positive' });
  const pMinus = root.querySelector('#btn-grp-win-minus');
  if (pMinus) pMinus.onclick = () => openScoreComposer({ studentIds: pickedMembers.map((m) => m.id), initialType: 'negative' });

  const nsClose = root.querySelector('#btn-name-slot-close');
  if (nsClose) {
    nsClose.onclick = () => {
      clearInterval(nameSlotTimer);
      nameSlotOverlayOpen = false;
      nameSlotRolling = false;
      renderPickerView(root);
    };
  }
  const nsAwardStudent = root.querySelector('#btn-ns-award-student');
  if (nsAwardStudent && nameSlotWinner) {
    nsAwardStudent.onclick = () => openScoreComposer({ studentIds: [nameSlotWinner.id], initialType: 'positive' });
  }
  const nsAwardGroup = root.querySelector('#btn-ns-award-group');
  if (nsAwardGroup && winnerGroup) {
    nsAwardGroup.onclick = () => {
      const memIds = activeStudents.filter((s) => s.groupId === winnerGroup.id).map((s) => s.id);
      if (memIds.length > 0) openScoreComposer({ studentIds: memIds, initialType: 'positive' });
    };
  }
  const nsRepick = root.querySelector('#btn-ns-repick');
  if (nsRepick) {
    nsRepick.onclick = () => runNameSlot(nameSlotTargetGroupId);
  }
}

/** 9시 방향(Math.PI) 화살표가 가리키는 룰렛 칸 인덱스 계산 */
function getRouletteIndexAtLeft(angle, count) {
  if (count <= 0) return 0;
  const slice = (Math.PI * 2) / count;
  const rel = ((Math.PI - angle) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  return Math.floor(rel / slice) % count;
}

function renderRouletteTool(root, state, activeStudents) {
  const items = state.tools.rouletteItems && state.tools.rouletteItems.length >= 2
    ? state.tools.rouletteItems
    : ['당번', '비번', '발표하기', '자유선택'];
  const curIdx = getRouletteIndexAtLeft(wheelAngle, items.length);
  const shownText = wheelResult || items[curIdx] || '';

  root.innerHTML = `
    <div class="roulette-stage">
      <div class="roulette-top-bar">
        <div class="roulette-top-left">
          <span style="font-size:24px;">🎯</span>
          <span class="roulette-title-txt">우리반 룰렛</span>
          <button type="button" class="roulette-edit-btn" id="btn-open-roulette-edit">룰렛 내용 편집</button>
        </div>
        <button type="button" class="roulette-close-btn" id="btn-sub-back" aria-label="닫기">&times;</button>
      </div>

      <div class="roulette-park-bg" id="roulette-park-bg" style="background-image:url('data:image/svg+xml;utf8,${PARK_SILHOUETTE_SVG}');background-position:${Math.round(wheelParkOffset)}px bottom;"></div>

      <div class="roulette-main-arena">
        <div class="roulette-readout-wrap">
          <div class="roulette-readout-box" id="roulette-readout-box">${escapeHtml(shownText)}</div>
          <svg class="roulette-pointer-drop" viewBox="0 0 64 44" aria-hidden="true">
            <path d="M22 4 C10 4, 2 12, 2 22 C2 32, 10 40, 22 40 C31 40, 48 30, 62 22 C48 14, 31 4, 22 4 Z" fill="#ffd84a" stroke="#e2a81e" stroke-width="2"/>
            <circle cx="20" cy="22" r="8" fill="#8b4d08"/>
          </svg>
        </div>

        <div class="roulette-wheel-column">
          <div class="roulette-wheel-stand" aria-hidden="true"></div>
          <canvas id="roulette-canvas" class="roulette-wheel-canvas" width="520" height="520" title="클릭하여 룰렛 돌리기"></canvas>
          <button type="button" class="roulette-center-spin-btn" id="btn-spin-wheel" ${wheelSpinning ? 'disabled' : ''} title="룰렛 돌리기">
            <svg viewBox="0 0 40 40" width="38" height="38" aria-hidden="true">
              <rect x="7" y="7" width="26" height="26" rx="7" transform="rotate(45 20 20)" fill="#ffffff"/>
              <circle cx="14" cy="20" r="2.6" fill="#e74c3c"/>
              <circle cx="20" cy="20" r="2.6" fill="#2e86de"/>
              <circle cx="26" cy="20" r="2.6" fill="#27ae60"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `;

  const canvas = root.querySelector('#roulette-canvas');
  const readoutBox = root.querySelector('#roulette-readout-box');
  const parkBg = root.querySelector('#roulette-park-bg');
  drawWheel(canvas, items, wheelAngle);

  root.querySelector('#btn-sub-back').onclick = () => {
    clearPickerTimers();
    pickerSubTool = 'hub';
    renderPickerView(root);
  };
  root.querySelector('#btn-open-roulette-edit').onclick = () => {
    openRouletteEditModal(root, activeStudents);
  };

  const triggerSpin = () => {
    if (wheelSpinning || items.length < 2) return;
    wheelSpinning = true;
    const spinBtn = root.querySelector('#btn-spin-wheel');
    if (spinBtn) spinBtn.disabled = true;
    if (parkBg) parkBg.classList.remove('is-lit');
    if (readoutBox) readoutBox.classList.remove('is-win');

    const startAngle = wheelAngle;
    const extraTurns = (5.5 + Math.random() * 4.5) * Math.PI * 2;
    const duration = 4200;
    const startTime = performance.now();
    let lastSliceIdx = getRouletteIndexAtLeft(wheelAngle, items.length);
    let prevAngle = wheelAngle;

    const animate = (now) => {
      if (!root.isConnected || pickerSubTool !== 'roulette') {
        wheelSpinning = false;
        return;
      }
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 3.6);
      wheelAngle = startAngle + extraTurns * ease;
      const dAngle = wheelAngle - prevAngle;
      prevAngle = wheelAngle;

      // 룰렛 회전 속도에 맞춰 하단 놀이동산 배경이 옆으로 무한 루프 이동
      wheelParkOffset = (wheelParkOffset + dAngle * 72) % 960;
      if (parkBg) parkBg.style.backgroundPosition = `${wheelParkOffset.toFixed(1)}px bottom`;

      drawWheel(canvas, items, wheelAngle);

      const idx = getRouletteIndexAtLeft(wheelAngle, items.length);
      if (idx !== lastSliceIdx) {
        lastSliceIdx = idx;
        if (readoutBox) readoutBox.textContent = items[idx] || '';
        playTick(600 + (1 - t) * 280, 0.025);
      }

      if (t < 1) {
        wheelAnimRaf = requestAnimationFrame(animate);
      } else {
        wheelSpinning = false;
        wheelResult = items[idx] || '';
        if (readoutBox) {
          readoutBox.textContent = wheelResult;
          readoutBox.classList.add('is-win');
        }
        if (parkBg) {
          parkBg.classList.remove('is-lit');
          void parkBg.offsetWidth;
          parkBg.classList.add('is-lit');
        }
        if (spinBtn) spinBtn.disabled = false;
        playSound('rouletteWin');
      }
    };
    wheelAnimRaf = requestAnimationFrame(animate);
  };

  root.querySelector('#btn-spin-wheel').onclick = triggerSpin;
  canvas.onclick = triggerSpin;
}

/** 룰렛 내용 편집 모달: 엔터 구분 통째 입력 + 이전 세트 기억 + 즐겨찾기 + 필터 + 삭제 */
function openRouletteEditModal(root, activeStudents) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  const renderModalContent = () => {
    const state = store.getState();
    const curItems = state.tools.rouletteItems || [];
    const allSets = Array.isArray(state.tools.rouletteSets) ? state.tools.rouletteSets : [];
    const visibleSets = rouletteSetFilter === 'fav'
      ? allSets.filter((x) => x.favorite)
      : allSets;

    const fmtDate = (ts) => {
      const d = new Date(ts || Date.now());
      return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
    };

    backdrop.innerHTML = `
      <div class="roulette-edit-dialog">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <h2 style="margin:0;font-size:17px;font-weight:800;color:#4a4235;">룰렛 내용 편집</h2>
          <button type="button" class="dialog-close">&times;</button>
        </div>

        <div class="roulette-edit-grid">
          <div class="roulette-edit-left">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
              <span style="font-size:12px;color:#7a7162;font-weight:700;">엔터키로 항목 구분</span>
              <div style="display:flex;gap:5px;">
                <button type="button" class="btn-outline" id="btn-rm-load-students" style="padding:3px 8px;font-size:11.5px;">학생 불러오기</button>
                <button type="button" class="btn-outline" id="btn-rm-load-groups" style="padding:3px 8px;font-size:11.5px;">모둠 불러오기</button>
              </div>
            </div>
            <textarea id="rm-items-textarea" class="roulette-edit-textarea">${escapeHtml(curItems.join('\n'))}</textarea>
          </div>

          <div class="roulette-edit-right">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;">
              <button type="button" class="${rouletteSetFilter === 'all' ? 'btn-yellow' : 'btn-outline'}" id="btn-rm-filter-all" style="padding:3px 9px;font-size:11.5px;">전체 (${allSets.length})</button>
              <button type="button" class="${rouletteSetFilter === 'fav' ? 'btn-yellow' : 'btn-outline'}" id="btn-rm-filter-fav" style="padding:3px 9px;font-size:11.5px;">★ 즐겨찾기만</button>
            </div>
            <div class="roulette-set-list">
              ${visibleSets.length > 0 ? visibleSets.map((set) => `
                <div class="roulette-set-item">
                  <button type="button" class="roulette-set-load" data-rm-load="${set.id}" title="클릭해 불러오기">
                    <span class="roulette-set-date">${fmtDate(set.updatedAt)}</span>
                    <strong>${escapeHtml(set.items.slice(0, 3).join(', '))}${set.items.length > 3 ? '…' : ''} (${set.items.length})</strong>
                  </button>
                  <button type="button" class="roulette-set-star ${set.favorite ? 'is-fav' : ''}" data-rm-fav="${set.id}" title="즐겨찾기">${set.favorite ? '★' : '☆'}</button>
                  <button type="button" class="roulette-set-del" data-rm-del="${set.id}" title="삭제">&times;</button>
                </div>
              `).join('') : `<div style="padding:18px;text-align:center;color:#938a7c;font-size:12px;">저장된 세트가 없습니다.</div>`}
            </div>
          </div>
        </div>

        <button type="button" class="roulette-save-full-btn" id="btn-rm-apply">저장</button>
      </div>
    `;

    const textarea = backdrop.querySelector('#rm-items-textarea');
    backdrop.querySelector('.dialog-close').onclick = close;

    backdrop.querySelector('#btn-rm-load-students').onclick = () => {
      const names = activeStudents.map((s) => s.name);
      if (names.length >= 2) textarea.value = names.join('\n');
    };
    backdrop.querySelector('#btn-rm-load-groups').onclick = () => {
      const names = store.getState().groups.map((g) => g.name);
      if (names.length >= 2) textarea.value = names.join('\n');
    };

    backdrop.querySelector('#btn-rm-filter-all').onclick = () => {
      rouletteSetFilter = 'all';
      renderModalContent();
    };
    backdrop.querySelector('#btn-rm-filter-fav').onclick = () => {
      rouletteSetFilter = 'fav';
      renderModalContent();
    };

    backdrop.querySelectorAll('[data-rm-load]').forEach((b) => {
      b.onclick = () => {
        const found = (store.getState().tools.rouletteSets || []).find((x) => x.id === b.dataset.rmLoad);
        if (found) textarea.value = found.items.join('\n');
      };
    });
    backdrop.querySelectorAll('[data-rm-fav]').forEach((b) => {
      b.onclick = async () => {
        const sid = b.dataset.rmFav;
        await store.update((s) => {
          const t = (s.tools.rouletteSets || []).find((x) => x.id === sid);
          if (t) t.favorite = !t.favorite;
        });
        renderModalContent();
      };
    });
    backdrop.querySelectorAll('[data-rm-del]').forEach((b) => {
      b.onclick = async () => {
        const sid = b.dataset.rmDel;
        await store.update((s) => {
          s.tools.rouletteSets = (s.tools.rouletteSets || []).filter((x) => x.id !== sid);
        });
        renderModalContent();
      };
    });

    backdrop.querySelector('#btn-rm-apply').onclick = async () => {
      const lines = textarea.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      if (lines.length < 2) {
        showToast({ title: '최소 2개 이상의 항목을 엔터로 구분해 입력해주세요.', tone: 'minus' });
        return;
      }
      wheelResult = '';
      const keySig = lines.join('\n');
      await store.update((s) => {
        s.tools.rouletteItems = lines;
        if (!Array.isArray(s.tools.rouletteSets)) s.tools.rouletteSets = [];
        const existing = s.tools.rouletteSets.find((x) => (x.items || []).join('\n') === keySig);
        if (existing) {
          existing.updatedAt = Date.now();
        } else {
          s.tools.rouletteSets.unshift({
            id: uid('rset'),
            title: lines.slice(0, 3).join(', ') + (lines.length > 3 ? ` 외 ${lines.length - 3}` : ''),
            items: lines,
            favorite: false,
            updatedAt: Date.now(),
          });
          if (s.tools.rouletteSets.length > 30) {
            const favs = s.tools.rouletteSets.filter((x) => x.favorite);
            const normals = s.tools.rouletteSets.filter((x) => !x.favorite).slice(0, Math.max(10, 30 - favs.length));
            s.tools.rouletteSets = [...favs, ...normals].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
          }
        }
      });
      playSound('confirm');
      close();
      renderPickerView(root);
    };
  };

  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  renderModalContent();
  modalRoot.appendChild(backdrop);
}

function drawWheel(canvas, items, angle) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const outerR = cx - 10;
  const innerR = outerR - 14;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 외곽 노란 테두리
  ctx.beginPath();
  ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd83b';
  ctx.fill();

  const slice = (Math.PI * 2) / items.length;
  items.forEach((label, i) => {
    const start = angle + i * slice;
    const end = start + slice;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, innerR, start, end);
    ctx.closePath();
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#e6e7ea';
    ctx.fill();

    // 방사형 텍스트 (중앙 허브 바깥쪽에 단정하게 배치)
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(start + slice / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#484a50';
    const fontSize = items.length > 18 ? 11 : (items.length > 10 ? 13 : 16);
    ctx.font = `700 ${fontSize}px sans-serif`;
    ctx.fillText(label.slice(0, 9), 54, 0);
    ctx.restore();
  });
}

function initLadder(players, results) {
  const cols = players.length;
  const rows = 9;
  const rungs = []; // { row, col } -> connects col and col+1
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols - 1) {
      if (Math.random() < 0.45) {
        rungs.push({ row: r, col: c });
        c += 2; // 인접 가로선 겹침 방지
      } else {
        c += 1;
      }
    }
  }
  return { players, results, rows, rungs, revealed: {}, activePath: null };
}

function traceLadderPath(ladder, startCol) {
  const { rows, rungs } = ladder;
  const points = [{ col: startCol, row: -0.6 }];
  let col = startCol;
  for (let r = 0; r < rows; r++) {
    points.push({ col, row: r });
    const right = rungs.find((x) => x.row === r && x.col === col);
    const left = rungs.find((x) => x.row === r && x.col === col - 1);
    if (right) {
      col += 1;
      points.push({ col, row: r });
    } else if (left) {
      col -= 1;
      points.push({ col, row: r });
    }
  }
  points.push({ col, row: rows - 0.4 });
  return { endCol: col, points };
}

function renderLadderTool(root, state, activeStudents) {
  if (!ladderState) {
    const defaultPlayers = activeStudents.slice(0, 6).map((s) => s.name);
    const players = defaultPlayers.length >= 2 ? defaultPlayers : ['참가자1', '참가자2', '참가자3', '참가자4'];
    const baseRes = state.tools.ladderResults || ['당첨!', '통과', '통과', '보너스'];
    const results = players.map((_, i) => baseRes[i] || (i === 0 ? '당첨!' : '통과'));
    ladderState = initLadder(players, results);
  }

  root.innerHTML = `
    <div class="tools-dark-stage">
      <div class="subtool-header">
        <button type="button" class="subtool-back-btn" id="btn-sub-back">← 뽑기 허브로</button>
        <h2 style="margin:0;">🪜 사다리 타기</h2>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn-outline" id="btn-ladder-regen" style="background:#262b36;color:#fff;border-color:#3f4656;">사다리 다시 만들기</button>
          <button type="button" class="btn-yellow" id="btn-ladder-all">전체 결과 보기</button>
        </div>
      </div>

      <div class="ladder-layout">
        <div class="canvas-stage-box">
          <div style="display:flex;width:100%;justify-content:space-around;gap:6px;">
            ${ladderState.players.map((p, idx) => `
              <button type="button" class="btn-outline" data-ladder-start="${idx}" style="background:${ladderState.revealed[idx] !== undefined ? '#ffe347' : '#262b36'};color:${ladderState.revealed[idx] !== undefined ? '#251c04' : '#fff'};border-color:#444b5c;font-size:12px;padding:6px 10px;">
                ${escapeHtml(p)}
              </button>
            `).join('')}
          </div>
          <canvas id="ladder-canvas" width="660" height="360" style="max-width:100%;height:auto;"></canvas>
          <div style="display:flex;width:100%;justify-content:space-around;gap:6px;">
            ${ladderState.results.map((r) => `
              <span style="padding:5px 10px;border-radius:6px;background:#262b36;color:#ffe347;font-size:12px;font-weight:800;">${escapeHtml(r)}</span>
            `).join('')}
          </div>
          ${Object.keys(ladderState.revealed).length > 0 ? `
            <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:6px;">
              ${Object.entries(ladderState.revealed).map(([pIdx, rIdx]) => `
                <span style="padding:5px 11px;border-radius:99px;background:#2b3344;font-size:12px;">
                  <strong>${escapeHtml(ladderState.players[pIdx])}</strong> → <span style="color:#ffe347;font-weight:800;">${escapeHtml(ladderState.results[rIdx])}</span>
                </span>
              `).join('')}
            </div>
          ` : ''}
        </div>

        <div class="tool-side-card">
          <h3>참여자 (2~8명, 줄바꿈)</h3>
          <button type="button" class="btn-outline" id="btn-ladder-random-st" style="background:#262b36;color:#fff;border-color:#3f4656;font-size:12px;">학생 중 6명 랜덤 채우기</button>
          <textarea id="ladder-players-area" rows="5">${escapeHtml(ladderState.players.join('\n'))}</textarea>
          <h3>결과 항목 (줄바꿈)</h3>
          <textarea id="ladder-results-area" rows="5">${escapeHtml(ladderState.results.join('\n'))}</textarea>
          <button type="button" class="btn-yellow" id="btn-ladder-apply">새 사다리 생성</button>
        </div>
      </div>
    </div>
  `;

  const canvas = root.querySelector('#ladder-canvas');
  drawLadder(canvas, ladderState, ladderState.activePath);

  root.querySelector('#btn-sub-back').onclick = () => { pickerSubTool = 'hub'; renderPickerView(root); };
  root.querySelector('#btn-ladder-regen').onclick = () => {
    ladderState = initLadder(ladderState.players, ladderState.results);
    playSound('confirm');
    renderPickerView(root);
  };
  root.querySelector('#btn-ladder-all').onclick = () => {
    ladderState.players.forEach((_, idx) => {
      const { endCol } = traceLadderPath(ladderState, idx);
      ladderState.revealed[idx] = endCol;
    });
    playSound('ladderReveal');
    renderPickerView(root);
  };
  root.querySelectorAll('[data-ladder-start]').forEach((b) => {
    b.onclick = () => {
      const idx = Number(b.dataset.ladderStart);
      const traced = traceLadderPath(ladderState, idx);
      ladderState.activePath = { startIdx: idx, points: traced.points, progress: 0 };
      const stepAnim = () => {
        if (!ladderState.activePath) return;
        ladderState.activePath.progress += 0.06;
        drawLadder(canvas, ladderState, ladderState.activePath);
        if (ladderState.activePath.progress < 1) {
          requestAnimationFrame(stepAnim);
        } else {
          ladderState.revealed[idx] = traced.endCol;
          playSound('confirm');
          renderPickerView(root);
        }
      };
      playTick(700, 0.04);
      requestAnimationFrame(stepAnim);
    };
  });
  root.querySelector('#btn-ladder-random-st').onclick = () => {
    const pick = [...activeStudents].sort(() => Math.random() - 0.5).slice(0, 6).map((s) => s.name);
    if (pick.length < 2) return;
    const res = pick.map((_, i) => ladderState.results[i] || (i === 0 ? '당첨!' : '통과'));
    ladderState = initLadder(pick, res);
    renderPickerView(root);
  };
  root.querySelector('#btn-ladder-apply').onclick = () => {
    const players = root.querySelector('#ladder-players-area').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
    const resultsRaw = root.querySelector('#ladder-results-area').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (players.length < 2) {
      showToast({ title: '참여자는 최소 2명 이상 필요합니다.', tone: 'minus' });
      return;
    }
    const results = players.map((_, i) => resultsRaw[i] || '통과');
    ladderState = initLadder(players, results);
    playSound('confirm');
    renderPickerView(root);
  };
}

function drawLadder(canvas, ladder, activePath) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const cols = ladder.players.length;
  const padX = w / (cols * 2);
  const stepX = (w - padX * 2) / Math.max(1, cols - 1);
  const topY = 20;
  const botY = h - 20;
  const stepY = (botY - topY) / ladder.rows;

  const getX = (c) => (cols === 1 ? w / 2 : padX + c * stepX);
  const getY = (r) => topY + (r + 0.5) * stepY;

  // 세로 기둥
  ctx.strokeStyle = '#586278';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  for (let c = 0; c < cols; c++) {
    ctx.beginPath();
    ctx.moveTo(getX(c), topY);
    ctx.lineTo(getX(c), botY);
    ctx.stroke();
  }

  // 가로 발판
  ctx.strokeStyle = '#79859e';
  ctx.lineWidth = 4;
  for (const r of ladder.rungs) {
    ctx.beginPath();
    ctx.moveTo(getX(r.col), getY(r.row));
    ctx.lineTo(getX(r.col + 1), getY(r.row));
    ctx.stroke();
  }

  // 활성 추적 경로
  if (activePath && activePath.points.length > 1) {
    const pts = activePath.points.map((p) => ({
      x: getX(p.col),
      y: p.row < 0 ? topY : p.row >= ladder.rows - 0.5 ? botY : getY(p.row),
    }));
    const maxSeg = Math.max(1, Math.floor((pts.length - 1) * Math.min(1, activePath.progress)));
    ctx.strokeStyle = '#ffe347';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i <= maxSeg; i++) {
      ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
  }
}

/** 성별 일괄입력 모달 */
function openGenderBulkModal() {
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  const renderModal = () => {
    const students = store.getState().students.filter((s) => !s.trashed).sort((a, b) => a.number - b.number);
    backdrop.innerHTML = `
      <div class="dialog-card">
        <div class="dialog-header">
          <h2>성별 일괄 설정 (뽑기 필터용)</h2>
          <button type="button" class="dialog-close">&times;</button>
        </div>
        <div class="dialog-body" style="max-height:58vh;">
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;">
            ${students.map((st) => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-radius:7px;background:#f7f5ee;">
                <span style="font-size:13px;font-weight:700;">${st.number}. ${escapeHtml(st.name)}</span>
                <div style="display:flex;gap:4px;">
                  <button type="button" data-set-g="${st.id}:F" style="padding:3px 9px;border-radius:5px;font-size:12px;font-weight:700;background:${st.gender === 'F' ? '#ff7b9c' : '#e4e0d5'};color:${st.gender === 'F' ? '#fff' : '#666'};">여</button>
                  <button type="button" data-set-g="${st.id}:M" style="padding:3px 9px;border-radius:5px;font-size:12px;font-weight:700;background:${st.gender === 'M' ? '#4a98eb' : '#e4e0d5'};color:${st.gender === 'M' ? '#fff' : '#666'};">남</button>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="dialog-footer">
          <button type="button" class="btn-yellow" data-close>완료</button>
        </div>
      </div>
    `;
    backdrop.querySelector('.dialog-close').onclick = close;
    backdrop.querySelector('[data-close]').onclick = close;
    backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
    backdrop.querySelectorAll('[data-set-g]').forEach((b) => {
      b.onclick = async () => {
        const [id, g] = b.dataset.setG.split(':');
        await store.update((s) => {
          const st = s.students.find((x) => x.id === id);
          if (st) st.gender = g;
        });
        renderModal();
      };
    });
  };
  modalRoot.appendChild(backdrop);
  renderModal();
}

// ================== 2. 타이머 & 스톱워치 ==================
let timerMode = 'countdown'; // 'countdown' | 'stopwatch'
let timerDurationSec = 180;
let timerRemainSec = 180;
let stopwatchSec = 0;
let timerRunning = false;
let timerFinished = false;
let timerIntervalId = null;

function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

export function renderTimerView(root) {
  const isCd = timerMode === 'countdown';
  const displaySec = isCd ? timerRemainSec : stopwatchSec;
  const ratio = isCd ? (timerDurationSec > 0 ? timerRemainSec / timerDurationSec : 0) : ((stopwatchSec % 60) / 60);
  const circumference = 2 * Math.PI * 124;
  const dashOffset = circumference * (1 - ratio);
  const isWarning = isCd && timerRemainSec <= 10 && timerRemainSec > 0 && timerRunning;

  root.innerHTML = `
    <div class="timer-stage ${isWarning ? 'is-warning' : ''} ${timerFinished ? 'is-finished' : ''}">
      <div class="timer-mode-switch">
        <button type="button" class="${isCd ? 'is-active' : ''}" data-tmode="countdown">⏳ 타이머</button>
        <button type="button" class="${!isCd ? 'is-active' : ''}" data-tmode="stopwatch">⏱ 스톱워치</button>
      </div>

      <div class="timer-ring-wrap">
        <svg class="timer-ring-svg" viewBox="0 0 280 280">
          <circle class="timer-ring-bg" cx="140" cy="140" r="124"></circle>
          <circle class="timer-ring-fg" cx="140" cy="140" r="124" stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}"></circle>
        </svg>
        <div class="timer-digits">${formatClock(displaySec)}</div>
      </div>

      ${isCd ? `
        <div class="timer-presets">
          <button type="button" class="timer-preset-btn" data-set-sec="60">1분</button>
          <button type="button" class="timer-preset-btn" data-set-sec="180">3분</button>
          <button type="button" class="timer-preset-btn" data-set-sec="300">5분</button>
          <button type="button" class="timer-preset-btn" data-set-sec="600">10분</button>
          <button type="button" class="timer-preset-btn" data-set-sec="900">15분</button>
          <button type="button" class="timer-preset-btn" data-add-sec="10">+10초</button>
          <button type="button" class="timer-preset-btn" data-add-sec="60">+1분</button>
        </div>
      ` : ''}

      <div class="timer-controls">
        <button type="button" class="btn-yellow" id="btn-timer-toggle" style="min-width:132px;font-size:16px;padding:12px 24px;">
          ${timerRunning ? '⏸ 일시정지' : '▶ 시작'}
        </button>
        <button type="button" class="btn-outline" id="btn-timer-reset" style="background:#273042;color:#fff;border-color:#3c475f;padding:12px 20px;">
          ↺ 초기화
        </button>
      </div>
    </div>
  `;

  root.querySelectorAll('[data-tmode]').forEach((b) => {
    b.onclick = () => {
      stopTimerLoop();
      timerMode = b.dataset.tmode;
      timerFinished = false;
      renderTimerView(root);
    };
  });

  root.querySelectorAll('[data-set-sec]').forEach((b) => {
    b.onclick = () => {
      stopTimerLoop();
      timerDurationSec = Number(b.dataset.setSec);
      timerRemainSec = timerDurationSec;
      timerFinished = false;
      renderTimerView(root);
    };
  });
  root.querySelectorAll('[data-add-sec]').forEach((b) => {
    b.onclick = () => {
      const add = Number(b.dataset.addSec);
      timerRemainSec += add;
      if (timerRemainSec > timerDurationSec) timerDurationSec = timerRemainSec;
      timerFinished = false;
      renderTimerView(root);
    };
  });

  root.querySelector('#btn-timer-toggle').onclick = () => {
    if (timerRunning) {
      stopTimerLoop();
      renderTimerView(root);
    } else {
      if (timerMode === 'countdown' && timerRemainSec <= 0) {
        timerRemainSec = timerDurationSec;
      }
      timerFinished = false;
      timerRunning = true;
      timerIntervalId = setInterval(() => {
        if (timerMode === 'countdown') {
          timerRemainSec -= 1;
          if (timerRemainSec <= 3 && timerRemainSec > 0) playTick(920, 0.05);
          if (timerRemainSec <= 0) {
            timerRemainSec = 0;
            stopTimerLoop();
            timerFinished = true;
            playTimerAlarm();
            showToast({ title: '⏰ 타이머 시간이 종료되었습니다!', tone: 'goal' });
          }
        } else {
          stopwatchSec += 1;
        }
        renderTimerView(root);
      }, 1000);
      renderTimerView(root);
    }
  };

  root.querySelector('#btn-timer-reset').onclick = () => {
    stopTimerLoop();
    timerFinished = false;
    if (timerMode === 'countdown') timerRemainSec = timerDurationSec;
    else stopwatchSec = 0;
    renderTimerView(root);
  };
}

function stopTimerLoop() {
  timerRunning = false;
  if (timerIntervalId) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
}
