// 수업도구 뷰 — 뽑기 허브(랜덤 뽑기 1~9명 · 학생 섞기 · 그룹 뽑기 · 우리반 룰렛 · 사다리 타기) + 타이머

import { store, getStillAvatarUrl } from '../store.js';
import { openScoreComposer, showToast, escapeHtml, escapeAttr } from '../effects.js';
import { playSound, playTick, playTimerAlarm } from '../audio.js';

// ================== 1. 뽑기 허브 & 4대 도구 ==================
let pickerSubTool = 'hub'; // 'hub' | 'result' | 'shuffle' | 'group' | 'roulette' | 'ladder'
let genderFilter = 'all';  // 'all' | 'F' | 'M'
let lastPickedStudents = [];
let shuffleCards = [];     // [{ student, flipped }]
let lastPickedGroup = null;

// 룰렛 상태
let wheelAngle = 0;
let wheelSpinning = false;
let wheelResult = '';

// 사다리 상태
let ladderState = null;

export function setPickerSubTool(tool) {
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
    renderPickResult(root);
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
    <div class="tools-dark-stage">
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
          <p class="tool-card-desc">자리배치가 설정되어 있는 경우,<br>그룹 중 하나를 뽑을 수 있습니다.</p>
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
    btn.onclick = async () => {
      const count = Math.min(Number(btn.dataset.pickN), remaining.length);
      if (count <= 0) return;
      const shuffled = [...remaining].sort(() => Math.random() - 0.5);
      const chosen = shuffled.slice(0, count);
      lastPickedStudents = chosen;
      await store.update((s) => {
        s.tools.pickedIds = Array.from(new Set([...(s.tools.pickedIds || []), ...chosen.map((c) => c.id)]));
      });
      playSound('pickResult');
      pickerSubTool = 'result';
      renderPickerView(root);
    };
  });

  root.querySelectorAll('[data-open-subtool]').forEach((btn) => {
    btn.onclick = () => {
      pickerSubTool = btn.dataset.openSubtool;
      if (pickerSubTool === 'shuffle') {
        const list = store.getState().students.filter((s) => !s.trashed && !s.absent);
        shuffleCards = [...list].sort(() => Math.random() - 0.5).map((st) => ({ student: st, flipped: false }));
      }
      if (pickerSubTool === 'group') {
        lastPickedGroup = null;
      }
      renderPickerView(root);
    };
  });
}

function renderPickResult(root) {
  root.innerHTML = `
    <div class="tools-dark-stage">
      <div class="subtool-header">
        <button type="button" class="subtool-back-btn" id="btn-sub-back">← 뽑기 허브로</button>
        <h2 style="margin:0;">🎉 뽑힌 학생 (${lastPickedStudents.length}명)</h2>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn-blue" id="btn-picked-plus">★ 으쓱 주기</button>
          <button type="button" class="btn-red" id="btn-picked-minus">☁ 머쓱 주기</button>
        </div>
      </div>
      <div class="pick-result-grid">
        ${lastPickedStudents.map((st) => `
          <div class="pick-winner-card">
            <span class="pick-winner-num">${st.number}번</span>
            <img src="${getStillAvatarUrl(st.avatarId)}" alt="${escapeAttr(st.name)}">
            <span class="pick-winner-name">${escapeHtml(st.name)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  root.querySelector('#btn-sub-back').onclick = () => { pickerSubTool = 'hub'; renderPickerView(root); };
  root.querySelector('#btn-picked-plus').onclick = () => openScoreComposer({ studentIds: lastPickedStudents.map((s) => s.id), initialType: 'positive' });
  root.querySelector('#btn-picked-minus').onclick = () => openScoreComposer({ studentIds: lastPickedStudents.map((s) => s.id), initialType: 'negative' });
}

function renderShuffleTool(root, activeStudents) {
  if (shuffleCards.length === 0) {
    shuffleCards = [...activeStudents].sort(() => Math.random() - 0.5).map((st) => ({ student: st, flipped: false }));
  }

  root.innerHTML = `
    <div class="tools-dark-stage">
      <div class="subtool-header">
        <button type="button" class="subtool-back-btn" id="btn-sub-back">← 뽑기 허브로</button>
        <h2 style="margin:0;">🔀 학생 섞기 (카드를 클릭해 순서대로 뒤집어보세요)</h2>
        <div style="display:flex;gap:8px;">
          <button type="button" class="btn-outline" id="btn-shuffle-all-open" style="background:#262b36;color:#fff;border-color:#3f4656;">모두 뒤집기</button>
          <button type="button" class="btn-yellow" id="btn-shuffle-again">다시 섞기</button>
        </div>
      </div>
      <div class="shuffle-grid">
        ${shuffleCards.map((card, idx) => `
          <button type="button" class="shuffle-card ${card.flipped ? 'is-flipped' : ''}" data-shuffle-idx="${idx}">
            ${card.flipped ? `
              <span class="shuffle-card-order">${idx + 1}번째</span>
              <img src="${getStillAvatarUrl(card.student.avatarId)}" alt="">
              <strong style="font-size:15px;">${escapeHtml(card.student.name)}</strong>
            ` : `
              <span>${idx + 1}</span>
              <span style="font-size:12px;color:#8e96a8;font-weight:600;">클릭해서 확인</span>
            `}
          </button>
        `).join('')}
      </div>
    </div>
  `;

  root.querySelector('#btn-sub-back').onclick = () => { pickerSubTool = 'hub'; renderPickerView(root); };
  root.querySelector('#btn-shuffle-again').onclick = () => {
    shuffleCards = [...activeStudents].sort(() => Math.random() - 0.5).map((st) => ({ student: st, flipped: false }));
    playSound('confirm');
    renderPickerView(root);
  };
  root.querySelector('#btn-shuffle-all-open').onclick = () => {
    shuffleCards.forEach((c) => { c.flipped = true; });
    playSound('cardFlip');
    renderPickerView(root);
  };
  root.querySelectorAll('[data-shuffle-idx]').forEach((b) => {
    b.onclick = () => {
      const card = shuffleCards[Number(b.dataset.shuffleIdx)];
      if (!card.flipped) {
        card.flipped = true;
        playTick(820, 0.05);
        renderPickerView(root);
      }
    };
  });
}

function renderGroupPickerTool(root, state) {
  const groups = [...state.groups].sort((a, b) => a.order - b.order);
  const pickedMembers = lastPickedGroup
    ? state.students.filter((s) => !s.trashed && !s.absent && s.groupId === lastPickedGroup.id)
    : [];

  root.innerHTML = `
    <div class="tools-dark-stage">
      <div class="subtool-header">
        <button type="button" class="subtool-back-btn" id="btn-sub-back">← 뽑기 허브로</button>
        <h2 style="margin:0;">🗂 그룹 뽑기</h2>
        <button type="button" class="btn-yellow" id="btn-run-group-pick">🎲 랜덤 그룹 뽑기!</button>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;">
        ${groups.map((g) => {
          const isWin = lastPickedGroup && lastPickedGroup.id === g.id;
          const cnt = state.students.filter((s) => !s.trashed && s.groupId === g.id).length;
          return `
            <div style="min-width:150px;padding:18px 20px;border-radius:12px;text-align:center;background:${isWin ? '#ffe347' : '#21252f'};color:${isWin ? '#291f04' : '#e2e6f0'};border:2px solid ${isWin ? '#fff' : '#383e4c'};transform:${isWin ? 'scale(1.08)' : 'none'};transition:all 0.2s;">
              <div style="font-size:20px;font-weight:900;">${escapeHtml(g.name)}</div>
              <div style="font-size:12px;margin-top:4px;opacity:0.8;">${cnt}명</div>
            </div>
          `;
        }).join('')}
      </div>

      ${lastPickedGroup ? `
        <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px;">
          <div class="wheel-result-banner">🎉 ${escapeHtml(lastPickedGroup.name)} 당첨!</div>
          <div class="pick-result-grid">
            ${pickedMembers.map((st) => `
              <div class="pick-winner-card" style="width:140px;">
                <img src="${getStillAvatarUrl(st.avatarId)}" alt="" style="width:82px;height:96px;">
                <span class="pick-winner-name" style="font-size:15px;">${escapeHtml(st.name)}</span>
              </div>
            `).join('')}
          </div>
          <div style="display:flex;gap:10px;">
            <button type="button" class="btn-blue" id="btn-grp-win-plus">★ 모둠원 전원 으쓱 주기</button>
            <button type="button" class="btn-red" id="btn-grp-win-minus">☁ 모둠원 전원 머쓱 주기</button>
          </div>
        </div>
      ` : `<p style="text-align:center;color:#8e96a8;">상단의 '랜덤 그룹 뽑기!' 버튼을 눌러보세요.</p>`}
    </div>
  `;

  root.querySelector('#btn-sub-back').onclick = () => { pickerSubTool = 'hub'; renderPickerView(root); };
  root.querySelector('#btn-run-group-pick').onclick = () => {
    if (groups.length === 0) return;
    let step = 0;
    const totalSteps = 14;
    const timer = setInterval(() => {
      lastPickedGroup = groups[Math.floor(Math.random() * groups.length)];
      playTick(500 + step * 35, 0.03);
      renderPickerView(root);
      step++;
      if (step >= totalSteps) {
        clearInterval(timer);
        playSound('slotDone');
      }
    }, 85);
  };

  const pPlus = root.querySelector('#btn-grp-win-plus');
  if (pPlus) pPlus.onclick = () => openScoreComposer({ studentIds: pickedMembers.map((m) => m.id), initialType: 'positive' });
  const pMinus = root.querySelector('#btn-grp-win-minus');
  if (pMinus) pMinus.onclick = () => openScoreComposer({ studentIds: pickedMembers.map((m) => m.id), initialType: 'negative' });
}

function renderRouletteTool(root, state, activeStudents) {
  const items = state.tools.rouletteItems && state.tools.rouletteItems.length >= 2
    ? state.tools.rouletteItems
    : ['항목 1', '항목 2', '항목 3', '항목 4'];

  root.innerHTML = `
    <div class="tools-dark-stage">
      <div class="subtool-header">
        <button type="button" class="subtool-back-btn" id="btn-sub-back">← 뽑기 허브로</button>
        <h2 style="margin:0;">🎯 우리반 룰렛</h2>
        <button type="button" class="btn-yellow" id="btn-spin-wheel" ${wheelSpinning ? 'disabled' : ''}>🎡 룰렛 돌리기!</button>
      </div>

      <div class="wheel-layout">
        <div class="canvas-stage-box">
          <div class="wheel-pointer"></div>
          <canvas id="roulette-canvas" width="420" height="420" style="max-width:100%;height:auto;"></canvas>
          ${wheelResult ? `<div class="wheel-result-banner">🎉 결과: ${escapeHtml(wheelResult)}</div>` : ''}
        </div>

        <div class="tool-side-card">
          <h3>룰렛 항목 설정 (줄바꿈 구분)</h3>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button type="button" class="btn-outline" id="btn-wheel-load-students" style="background:#262b36;color:#fff;border-color:#3f4656;font-size:12px;">학생 불러오기</button>
            <button type="button" class="btn-outline" id="btn-wheel-load-groups" style="background:#262b36;color:#fff;border-color:#3f4656;font-size:12px;">모둠 불러오기</button>
          </div>
          <textarea id="wheel-items-area" rows="10">${escapeHtml(items.join('\n'))}</textarea>
          <button type="button" class="btn-yellow" id="btn-wheel-apply-items">항목 반영</button>
        </div>
      </div>
    </div>
  `;

  const canvas = root.querySelector('#roulette-canvas');
  drawWheel(canvas, items, wheelAngle);

  root.querySelector('#btn-sub-back').onclick = () => { pickerSubTool = 'hub'; renderPickerView(root); };

  root.querySelector('#btn-wheel-load-students').onclick = async () => {
    const names = activeStudents.map((s) => s.name);
    if (names.length < 2) return;
    wheelResult = '';
    await store.update((s) => { s.tools.rouletteItems = names; });
  };
  root.querySelector('#btn-wheel-load-groups').onclick = async () => {
    const names = state.groups.map((g) => g.name);
    if (names.length < 2) return;
    wheelResult = '';
    await store.update((s) => { s.tools.rouletteItems = names; });
  };
  root.querySelector('#btn-wheel-apply-items').onclick = async () => {
    const lines = root.querySelector('#wheel-items-area').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) {
      showToast({ title: '최소 2개 이상의 항목을 입력해주세요.', tone: 'minus' });
      return;
    }
    wheelResult = '';
    await store.update((s) => { s.tools.rouletteItems = lines; });
  };

  root.querySelector('#btn-spin-wheel').onclick = () => {
    if (wheelSpinning || items.length < 2) return;
    wheelSpinning = true;
    wheelResult = '';
    const startAngle = wheelAngle;
    const extraTurns = (5 + Math.random() * 4) * Math.PI * 2;
    const duration = 4200;
    const startTime = performance.now();
    let lastSliceIdx = -1;

    const animate = (now) => {
      const t = Math.min(1, (now - startTime) / duration);
      const ease = 1 - Math.pow(1 - t, 3.6);
      wheelAngle = startAngle + extraTurns * ease;
      drawWheel(canvas, items, wheelAngle);

      const sliceAngle = (Math.PI * 2) / items.length;
      const pointerPos = (Math.PI * 1.5 - (wheelAngle % (Math.PI * 2)) + Math.PI * 4) % (Math.PI * 2);
      const curIdx = Math.floor(pointerPos / sliceAngle) % items.length;
      if (curIdx !== lastSliceIdx) {
        lastSliceIdx = curIdx;
        playTick(600 + (1 - t) * 280, 0.025);
      }

      if (t < 1) {
        requestAnimationFrame(animate);
      } else {
        wheelSpinning = false;
        wheelResult = items[curIdx];
        playSound('rouletteWin');
        renderPickerView(root);
      }
    };
    requestAnimationFrame(animate);
  };
}

function drawWheel(canvas, items, angle) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = cx - 12;
  const palette = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#c77dff', '#ff9f43', '#2ec4b6', '#ff7597'];

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const slice = (Math.PI * 2) / items.length;

  items.forEach((label, i) => {
    const start = angle + i * slice;
    const end = start + slice;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, end);
    ctx.closePath();
    ctx.fillStyle = palette[i % palette.length];
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#171a21';
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(start + slice / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#1b1d22';
    ctx.font = `bold ${items.length > 14 ? 11 : 15}px sans-serif`;
    ctx.fillText(label.slice(0, 10), radius - 18, 5);
    ctx.restore();
  });

  // 중앙 허브
  ctx.beginPath();
  ctx.arc(cx, cy, 26, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = '#ffe347';
  ctx.stroke();
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
