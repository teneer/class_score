// 교사용 사이버지식정보방 관리 뷰 — 사이트 등록(URL 비공개·열림테스트·단일페이지고정) · 학급/모둠/개별/체크표연동 접속 통제 · 코인 지갑 & 으쓱 환전

import { store, uid, todayIso, isStudentCyberAllowed, getStudentCyberCoins } from '../store.js';
import { playSound } from '../audio.js';
import { showToast, escapeHtml, escapeAttr } from '../effects.js';
import { isCloudConnected, syncTeacherStateToCloud } from '../cloud-sync.js';

let selectedStudentIds = new Set();

async function syncCyberToCloud() {
  if (!isCloudConnected()) return;
  try {
    await syncTeacherStateToCloud(store.getState());
  } catch (err) {
    console.warn('[CR2 Cyber] cloud sync failed:', err);
  }
}

/** 유튜브 일반 주소를 앱 내부 임베드 주소로 자동 변환 */
function convertYoutubeToEmbed(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    if (u.hostname.includes('youtu.be')) {
      const id = u.pathname.replace(/^\//, '').split('/')[0];
      if (id) return `https://www.youtube.com/embed/${id}?rel=0`;
    }
    if (u.hostname.includes('youtube.com')) {
      if (u.pathname.startsWith('/embed/')) return rawUrl.trim();
      const v = u.searchParams.get('v');
      if (v) return `https://www.youtube.com/embed/${v}?rel=0`;
      if (u.pathname.startsWith('/shorts/')) {
        const id = u.pathname.split('/')[2];
        if (id) return `https://www.youtube.com/embed/${id}?rel=0`;
      }
    }
  } catch {
    // 무시
  }
  return rawUrl.trim();
}

/** 체크표 등 외부 모듈에서도 선택 학생에게 사이버방 통제/코인을 일괄 적용할 수 있도록 export */
export async function applyCyberActionToStudents(studentIds, action, amount = 0) {
  if (!Array.isArray(studentIds) || studentIds.length === 0) return;
  await store.update((s) => {
    const cr = s.cyberRoom;
    if (!cr) return;
    for (const sid of studentIds) {
      if (action === 'allow' || action === 'block') {
        cr.studentAccess[sid] = action;
      } else if (action === 'inherit') {
        delete cr.studentAccess[sid];
      } else if (action === 'addCoin') {
        const cur = getStudentCyberCoins(cr, sid);
        cr.coins[sid] = Math.max(0, cur + Math.trunc(Number(amount) || 0));
      } else if (action === 'setCoin') {
        cr.coins[sid] = Math.max(0, Math.trunc(Number(amount) || 0));
      }
    }
  });
  await syncCyberToCloud();
}

export function renderCyberView(container) {
  if (!container) return;
  const state = store.getState();
  const cr = state.cyberRoom || {};
  const students = (state.students || []).filter((s) => !s.trashed).sort((a, b) => a.number - b.number);
  const groups = [...(state.groups || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const sites = Array.isArray(cr.sites) ? cr.sites : [];
  const activeSessions = cr.activeSessions || {};
  const today = todayIso();
  const todayEntries = state.checklist?.entriesByDate?.[today] || {};
  const checklistItems = (state.checklist?.items || []).filter((it) => !it.archived);

  // 삭제된 학생 ID 정리
  for (const id of Array.from(selectedStudentIds)) {
    if (!students.some((s) => s.id === id)) selectedStudentIds.delete(id);
  }

  const allowedCount = students.filter((st) => isStudentCyberAllowed(cr, st)).length;
  const activeUserCount = Object.keys(activeSessions).length;

  container.innerHTML = `
    <div class="cyber-shell">
      <!-- 상단 요약 및 전체 통제 바 -->
      <div class="cyber-topbar">
        <div class="cyber-title-wrap">
          <img src="assets/visuals/icon-cyber.svg" alt="" width="28" height="28">
          <div>
            <h2>사이버지식정보방 관리</h2>
            <span class="cyber-sub-meta">허용 ${allowedCount}/${students.length}명 · 현재 이용 중 ${activeUserCount}명 · 등록 사이트 ${sites.length}개</span>
          </div>
        </div>

        <div class="cyber-top-controls">
          <button type="button" class="cyber-master-btn ${cr.globalAllowed ? 'is-open' : 'is-closed'}" id="btn-cyber-global-toggle">
            ${cr.globalAllowed ? '🟢 학급 전체 접속 허용 중 (클릭해 잠금)' : '🔴 학급 전체 잠금 중 (클릭해 허용)'}
          </button>
          <button type="button" class="btn-outline" id="btn-cyber-bulk-policy">⚙️ 사이트 요금·시간 일괄설정</button>
          <button type="button" class="btn-yellow" id="btn-cyber-add-site">+ 새 사이트 등록</button>
        </div>
      </div>

      <!-- 본문 2단 분할: 좌측 사이트 목록 / 우측 학생·모둠·체크표 접속 통제 & 코인 지갑 -->
      <div class="cyber-body">
        <!-- 좌측: 등록 사이트 관리 -->
        <section class="cyber-panel cyber-sites-panel">
          <div class="cyber-panel-head">
            <h3>🌐 등록 사이트 (${sites.length})</h3>
            <span class="cyber-hint-tag">학생에게 URL 비공개</span>
          </div>
          <div class="cyber-panel-scroll">
            ${sites.length === 0 ? `
              <div class="cyber-empty-box">
                <img src="assets/visuals/icon-cyber.svg" alt="" width="44" height="44">
                <p>등록된 사이트가 없습니다.<br><strong>[+ 새 사이트 등록]</strong>으로 학습·활동 사이트를 추가해 보세요.</p>
              </div>
            ` : `
              <div class="cyber-site-list">
                ${sites.map((site) => `
                  <article class="cyber-site-card ${site.enabled === false ? 'is-off' : ''}">
                    <div class="cyber-site-head">
                      <div>
                        <span class="cyber-cat-tag">${escapeHtml(site.category || '학습')}</span>
                        <strong>${escapeHtml(site.title)}</strong>
                      </div>
                      <label class="cyber-mini-switch" title="사이트 활성화">
                        <input type="checkbox" data-toggle-site="${site.id}" ${site.enabled !== false ? 'checked' : ''}>
                        <span>${site.enabled !== false ? '노출' : '숨김'}</span>
                      </label>
                    </div>
                    <div class="cyber-site-badges">
                      <span class="cyber-rule-pill">${site.openMode === 'popup' ? '🪟 제어 팝업' : '🖼️ 앱 내부'}</span>
                      <span class="cyber-rule-pill">입장 ${Number(site.entryCost) || 0}코인</span>
                      <span class="cyber-rule-pill is-coin">분당 ${Number(site.coinPerMin) ?? 1}코인</span>
                      <span class="cyber-rule-pill">${Number(site.timeLimitMin) > 0 ? `⏱ 최대 ${site.timeLimitMin}분` : '⏱ 시간무제한'}</span>
                      ${site.openMode !== 'popup' && site.strictSinglePage ? `<span class="cyber-rule-pill is-strict">🔒 단일페이지 고정</span>` : ''}
                    </div>
                    <div class="cyber-site-foot">
                      <span class="cyber-url-preview" title="${escapeAttr(site.url)}">${escapeHtml(site.url)}</span>
                      <div class="cyber-site-btns">
                        <button type="button" class="cyber-mini-btn" data-edit-site="${site.id}">수정</button>
                        <button type="button" class="cyber-mini-btn is-danger" data-del-site="${site.id}">삭제</button>
                      </div>
                    </div>
                  </article>
                `).join('')}
              </div>
            `}
          </div>
        </section>

        <!-- 우측: 학생·모둠·체크표 접속 통제 및 코인 지갑 -->
        <section class="cyber-panel cyber-students-panel">
          <div class="cyber-panel-head">
            <h3>👥 학생 · 모둠 접속 통제 & 코인 지갑</h3>
            <span class="cyber-sel-badge">${selectedStudentIds.size}명 선택됨</span>
          </div>

          <!-- 빠른 선택 바 (전체 / 모둠 / 체크표 연동) -->
          <div class="cyber-select-toolbar">
            <div class="cyber-sel-row">
              <button type="button" class="cyber-mini-btn" id="btn-cy-sel-all">전체 선택</button>
              <button type="button" class="cyber-mini-btn" id="btn-cy-sel-none">해제</button>
              ${groups.map((g) => {
                const gRule = cr.groupAccess?.[g.id] || 'inherit';
                const gMark = gRule === 'allow' ? '🟢' : gRule === 'block' ? '🔴' : '';
                return `
                  <span class="cyber-grp-chip-wrap">
                    <button type="button" class="cyber-mini-btn" data-cy-sel-grp="${g.id}" title="모둠원 선택">${gMark}${escapeHtml(g.name)}</button>
                    <button type="button" class="cyber-grp-lock-btn" data-cy-toggle-grp="${g.id}" title="이 모둠 허용/차단 전환">
                      ${gRule === 'allow' ? '허용' : gRule === 'block' ? '차단' : '기본'}
                    </button>
                  </span>
                `;
              }).join('')}
            </div>

            <div class="cyber-sel-row">
              <label class="cyber-chk-picker">
                <span>📋 체크표 선택:</span>
                <select id="cy-checklist-item">
                  <option value="">오늘 체크표 항목 선택...</option>
                  ${checklistItems.map((it) => `<option value="${it.id}">${escapeHtml(it.title)}</option>`).join('')}
                </select>
                <button type="button" class="cyber-mini-btn" id="btn-cy-pick-chk-done">완료자 선택</button>
                <button type="button" class="cyber-mini-btn" id="btn-cy-pick-chk-undone">미완료 선택</button>
              </label>
            </div>
          </div>

          <!-- 선택 학생 일괄 설정 바 -->
          <div class="cyber-action-bar">
            <button type="button" class="cyber-act-btn is-allow" id="btn-cy-allow">✅ 접속 허용</button>
            <button type="button" class="cyber-act-btn is-block" id="btn-cy-block">⛔ 접속 차단</button>
            <button type="button" class="cyber-act-btn" id="btn-cy-inherit">↩ 기본값</button>
            <span class="cyber-sep"></span>
            <input type="number" id="cy-coin-amount" value="5" min="1" max="999" class="cyber-coin-input" title="코인 수량">
            <button type="button" class="cyber-act-btn is-coin" id="btn-cy-coin-add">🪙 +지급</button>
            <button type="button" class="cyber-act-btn" id="btn-cy-coin-sub">−차감</button>
            <button type="button" class="cyber-act-btn" id="btn-cy-coin-set">직접설정</button>
            <button type="button" class="cyber-act-btn is-exchange" id="btn-cy-exchange" title="선택 학생의 으쓱 점수를 사이버 코인으로 환전">🔄 으쓱→코인</button>
          </div>

          <!-- 학생 그리드 -->
          <div class="cyber-student-grid">
            ${students.map((st) => {
              const allowed = isStudentCyberAllowed(cr, st);
              const customRule = cr.studentAccess?.[st.id];
              const coins = getStudentCyberCoins(cr, st.id);
              const sess = activeSessions[st.id];
              const isSel = selectedStudentIds.has(st.id);
              return `
                <div class="cyber-st-card ${isSel ? 'is-selected' : ''} ${allowed ? 'is-allowed' : 'is-blocked'}" data-cy-st="${st.id}">
                  <div class="cyber-st-top">
                    <span class="cyber-st-num">${st.number}</span>
                    <strong class="cyber-st-name">${escapeHtml(st.name)}</strong>
                    <button type="button" class="cyber-st-quick-toggle ${allowed ? 'is-on' : 'is-off'}" data-cy-quick="${st.id}" title="클릭하여 즉시 허용/차단 전환">
                      ${allowed ? '허용' : '차단'}${customRule ? '*' : ''}
                    </button>
                  </div>
                  <div class="cyber-st-bottom">
                    <span class="cyber-st-coin">🪙 ${coins}</span>
                    ${sess ? `<span class="cyber-st-live" title="${escapeAttr(sess.siteTitle)}">💻 이용중</span>` : `<span class="cyber-st-pts">으쓱 ${st.positive ?? 0}</span>`}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </section>
      </div>
    </div>
  `;

  // --- 이벤트 바인딩 ---
  container.querySelector('#btn-cyber-global-toggle').onclick = async () => {
    const next = !cr.globalAllowed;
    await store.update((s) => { s.cyberRoom.globalAllowed = next; });
    await syncCyberToCloud();
    playSound(next ? 'confirm' : 'cardFlip');
    showToast({ title: next ? '학급 전체 사이버지식정보방 접속을 허용했습니다!' : '학급 전체 사이버지식정보방을 잠갔습니다.', tone: next ? 'plus' : 'minus' });
  };

  container.querySelector('#btn-cyber-add-site').onclick = () => {
    openSiteEditorModal(null, () => renderCyberView(container));
  };
  container.querySelector('#btn-cyber-bulk-policy').onclick = () => {
    openBulkPolicyModal(() => renderCyberView(container));
  };

  container.querySelectorAll('[data-toggle-site]').forEach((chk) => {
    chk.onchange = async () => {
      const sid = chk.dataset.toggleSite;
      await store.update((s) => {
        const target = (s.cyberRoom.sites || []).find((x) => x.id === sid);
        if (target) target.enabled = chk.checked;
      });
      await syncCyberToCloud();
      playSound('cardFlip');
    };
  });
  container.querySelectorAll('[data-edit-site]').forEach((b) => {
    b.onclick = () => {
      const target = sites.find((x) => x.id === b.dataset.editSite);
      if (target) openSiteEditorModal(target, () => renderCyberView(container));
    };
  });
  container.querySelectorAll('[data-del-site]').forEach((b) => {
    b.onclick = async () => {
      const target = sites.find((x) => x.id === b.dataset.delSite);
      if (!target || !confirm(`'${target.title}' 사이트를 삭제할까요?`)) return;
      await store.update((s) => {
        s.cyberRoom.sites = (s.cyberRoom.sites || []).filter((x) => x.id !== target.id);
      });
      await syncCyberToCloud();
      playSound('cardFlip');
      showToast({ title: '사이트를 삭제했습니다.' });
    };
  });

  // 학생/모둠/체크표 선택
  container.querySelector('#btn-cy-sel-all').onclick = () => {
    students.forEach((s) => selectedStudentIds.add(s.id));
    renderCyberView(container);
  };
  container.querySelector('#btn-cy-sel-none').onclick = () => {
    selectedStudentIds.clear();
    renderCyberView(container);
  };
  container.querySelectorAll('[data-cy-sel-grp]').forEach((b) => {
    b.onclick = () => {
      const members = students.filter((s) => s.groupId === b.dataset.cySelGrp);
      const allIn = members.length > 0 && members.every((m) => selectedStudentIds.has(m.id));
      if (allIn) members.forEach((m) => selectedStudentIds.delete(m.id));
      else members.forEach((m) => selectedStudentIds.add(m.id));
      renderCyberView(container);
    };
  });
  container.querySelectorAll('[data-cy-toggle-grp]').forEach((b) => {
    b.onclick = async () => {
      const gid = b.dataset.cyToggleGrp;
      const cur = cr.groupAccess?.[gid] || 'inherit';
      const next = cur === 'inherit' ? 'allow' : cur === 'allow' ? 'block' : 'inherit';
      await store.update((s) => {
        if (next === 'inherit') delete s.cyberRoom.groupAccess[gid];
        else s.cyberRoom.groupAccess[gid] = next;
      });
      await syncCyberToCloud();
      playSound('cardFlip');
      showToast({ title: `모둠 접속 설정을 '${next === 'allow' ? '허용' : next === 'block' ? '차단' : '학급 기본값'}'(으)로 변경했습니다.` });
    };
  });

  const pickByChecklist = (wantDone) => {
    const itemId = container.querySelector('#cy-checklist-item')?.value;
    if (!itemId) {
      showToast({ title: '먼저 체크표 항목을 선택해 주세요.', tone: 'minus' });
      return;
    }
    selectedStudentIds.clear();
    for (const st of students) {
      const v = todayEntries[`${st.id}::${itemId}`];
      const isFilled = v !== '' && v !== false && v !== null && v !== undefined;
      if ((wantDone && isFilled) || (!wantDone && !isFilled)) {
        selectedStudentIds.add(st.id);
      }
    }
    playSound('tick');
    showToast({ title: `체크표 ${wantDone ? '완료자' : '미완료자'} ${selectedStudentIds.size}명을 선택했습니다.`, tone: 'plus' });
    renderCyberView(container);
  };
  container.querySelector('#btn-cy-pick-chk-done').onclick = () => pickByChecklist(true);
  container.querySelector('#btn-cy-pick-chk-undone').onclick = () => pickByChecklist(false);

  container.querySelectorAll('[data-cy-st]').forEach((card) => {
    card.onclick = (e) => {
      if (e.target.closest('[data-cy-quick]')) return;
      const sid = card.dataset.cySt;
      if (selectedStudentIds.has(sid)) selectedStudentIds.delete(sid);
      else selectedStudentIds.add(sid);
      renderCyberView(container);
    };
  });
  container.querySelectorAll('[data-cy-quick]').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const sid = btn.dataset.cyQuick;
      const st = students.find((x) => x.id === sid);
      if (!st) return;
      const next = isStudentCyberAllowed(cr, st) ? 'block' : 'allow';
      await applyCyberActionToStudents([sid], next);
      playSound(next === 'allow' ? 'confirm' : 'cardFlip');
    };
  });

  const getTargets = () => {
    const ids = Array.from(selectedStudentIds);
    if (ids.length === 0) {
      showToast({ title: '먼저 대상 학생을 1명 이상 선택해 주세요.', tone: 'minus' });
      return null;
    }
    return ids;
  };
  const getAmt = () => Math.max(0, Math.trunc(Number(container.querySelector('#cy-coin-amount')?.value) || 0));

  container.querySelector('#btn-cy-allow').onclick = async () => {
    const ids = getTargets(); if (!ids) return;
    await applyCyberActionToStudents(ids, 'allow');
    playSound('confirm');
    showToast({ title: `${ids.length}명의 사이버지식정보방 접속을 허용했습니다!`, tone: 'plus' });
  };
  container.querySelector('#btn-cy-block').onclick = async () => {
    const ids = getTargets(); if (!ids) return;
    await applyCyberActionToStudents(ids, 'block');
    playSound('cardFlip');
    showToast({ title: `${ids.length}명의 사이버지식정보방 접속을 차단했습니다.`, tone: 'minus' });
  };
  container.querySelector('#btn-cy-inherit').onclick = async () => {
    const ids = getTargets(); if (!ids) return;
    await applyCyberActionToStudents(ids, 'inherit');
    playSound('cardFlip');
    showToast({ title: `${ids.length}명을 학급/모둠 기본 설정으로 되돌렸습니다.` });
  };
  container.querySelector('#btn-cy-coin-add').onclick = async () => {
    const ids = getTargets(); if (!ids) return;
    const amt = Math.max(1, getAmt());
    await applyCyberActionToStudents(ids, 'addCoin', amt);
    playSound('plus');
    showToast({ title: `${ids.length}명에게 🪙 +${amt}코인을 지급했습니다!`, tone: 'plus' });
  };
  container.querySelector('#btn-cy-coin-sub').onclick = async () => {
    const ids = getTargets(); if (!ids) return;
    const amt = Math.max(1, getAmt());
    await applyCyberActionToStudents(ids, 'addCoin', -amt);
    playSound('minus');
    showToast({ title: `${ids.length}명의 코인을 -${amt} 차감했습니다.`, tone: 'minus' });
  };
  container.querySelector('#btn-cy-coin-set').onclick = async () => {
    const ids = getTargets(); if (!ids) return;
    const amt = getAmt();
    await applyCyberActionToStudents(ids, 'setCoin', amt);
    playSound('confirm');
    showToast({ title: `${ids.length}명의 보유 코인을 🪙 ${amt}코인으로 설정했습니다.`, tone: 'plus' });
  };
  container.querySelector('#btn-cy-exchange').onclick = () => {
    const ids = getTargets(); if (!ids) return;
    openExchangeModal(ids, () => renderCyberView(container));
  };
}

/** 사이트 등록 / 수정 모달 (유튜브 임베드 변환 + 앱 내부 열림 테스트) */
function openSiteEditorModal(existing, onSaved) {
  const cr = store.getState().cyberRoom || {};
  const def = cr.defaultPolicy || { entryCost: 0, coinPerMin: 1, timeLimitMin: 0 };
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  backdrop.innerHTML = `
    <form class="dialog-card is-wide">
      <div class="dialog-header">
        <h2>${existing ? '🌐 사이트 수정' : '🌐 새 사이버지식정보방 사이트 등록'}</h2>
        <button type="button" class="dialog-close">&times;</button>
      </div>
      <div class="dialog-body" style="max-height:76vh;overflow-y:auto;">
        <div class="field-row">
          <label class="field-label" style="flex:2;">
            <span>사이트 이름 (학생에게 표시됨)</span>
            <input type="text" name="title" maxlength="40" value="${escapeAttr(existing?.title || '')}" placeholder="예: 수학 워드월 게임, 타자연습, 과학 영상" required>
          </label>
          <label class="field-label" style="flex:1;">
            <span>분류</span>
            <input type="text" name="category" maxlength="16" value="${escapeAttr(existing?.category || '학습')}" placeholder="학습, 영상, 게임">
          </label>
        </div>

        <label class="field-label" style="margin-top:8px;">
          <span>실제 URL (학생 화면에는 절대 공개되지 않습니다)</span>
          <div style="display:flex;gap:6px;">
            <input type="url" name="url" id="cy-site-url" value="${escapeAttr(existing?.url || '')}" placeholder="https://..." required style="flex:1;">
            <button type="button" class="btn-outline" id="btn-cy-yt-conv" style="padding:6px 10px;font-size:12px;">유튜브 변환</button>
            <button type="button" class="btn-outline" id="btn-cy-test-iframe" style="padding:6px 10px;font-size:12px;">🔍 열림 테스트</button>
          </div>
        </label>

        <div id="cy-iframe-test-wrap" hidden style="margin-top:8px;border:1.5px solid #dedad0;border-radius:10px;overflow:hidden;background:#f5f3ea;">
          <div style="padding:6px 10px;background:#fffbe0;font-size:12px;font-weight:700;color:#4b3808;display:flex;justify-content:space-between;">
            <span>🔍 앱 내부 열림 미리보기 (연결 거부가 뜨면 아래 실행 방식을 <b>🪟 제어 팝업 창</b>으로 선택하세요)</span>
            <button type="button" id="btn-cy-close-test" style="font-weight:900;">닫기</button>
          </div>
          <iframe id="cy-test-frame" style="width:100%;height:200px;border:0;background:#fff;" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
        </div>

        <div class="field-row" style="margin-top:12px;">
          <label class="field-label" style="flex:1;">
            <span>실행 방식</span>
            <select name="openMode" id="cy-open-mode">
              <option value="iframe" ${existing?.openMode !== 'popup' ? 'selected' : ''}>🖼️ 앱 내부 열기 (URL 비공개 · 이탈 시 종료)</option>
              <option value="popup" ${existing?.openMode === 'popup' ? 'selected' : ''}>🪟 제어 팝업 창 (연결 거부 사이트용 · 만료/차단 시 자동 닫기)</option>
            </select>
          </label>
        </div>

        <div class="field-row" style="margin-top:10px;">
          <label class="field-label">
            <span>입장 코인 (0 가능)</span>
            <input type="number" name="entryCost" min="0" max="999" value="${Number(existing?.entryCost ?? def.entryCost ?? 0)}">
          </label>
          <label class="field-label">
            <span>분당 차감 코인 (0 가능)</span>
            <input type="number" name="coinPerMin" min="0" max="99" value="${Number(existing?.coinPerMin ?? def.coinPerMin ?? 1)}">
          </label>
          <label class="field-label">
            <span>이용 시간 제한 (분 · 0=무제한)</span>
            <input type="number" name="timeLimitMin" min="0" max="180" value="${Number(existing?.timeLimitMin ?? def.timeLimitMin ?? 0)}">
          </label>
        </div>

        <label style="display:flex;align-items:center;gap:8px;margin-top:12px;padding:10px 12px;border-radius:10px;background:#faf8f2;border:1px solid #e6dfd0;font-size:13px;font-weight:700;cursor:pointer;">
          <input type="checkbox" name="strictSinglePage" ${existing?.strictSinglePage !== false ? 'checked' : ''} style="accent-color:#f0be2a;width:16px;height:16px;">
          <span>🔒 단일 페이지 고정 (최초 화면을 벗어나 다른 페이지로 이동하면 즉시 "접속종료" 처리)</span>
        </label>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn-ghost" data-cancel>취소</button>
        <button type="submit" class="btn-yellow">${existing ? '사이트 수정 저장' : '사이트 등록하기'}</button>
      </div>
    </form>
  `;

  modalRoot.appendChild(backdrop);
  backdrop.querySelector('.dialog-close').onclick = close;
  backdrop.querySelector('[data-cancel]').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  backdrop.querySelector('#btn-cy-yt-conv').onclick = () => {
    const inp = backdrop.querySelector('#cy-site-url');
    const converted = convertYoutubeToEmbed(inp.value);
    inp.value = converted;
    showToast({ title: '유튜브 임베드 주소로 변환했습니다!', tone: 'plus' });
  };
  backdrop.querySelector('#btn-cy-test-iframe').onclick = () => {
    const url = backdrop.querySelector('#cy-site-url').value.trim();
    if (!url) return;
    const mode = backdrop.querySelector('#cy-open-mode')?.value || 'iframe';
    if (mode === 'popup') {
      const w = window.open(url, 'cr2_cyber_test_popup', 'width=1020,height=700,menubar=no,toolbar=no,location=no,resizable=yes,scrollbars=yes');
      if (!w) {
        showToast({ title: '팝업이 차단되었습니다. 브라우저에서 팝업을 허용해 주세요.', tone: 'minus' });
      } else {
        showToast({ title: '🪟 제어 팝업 창으로 정상 열렸습니다!', tone: 'plus' });
      }
      return;
    }
    const wrap = backdrop.querySelector('#cy-iframe-test-wrap');
    const frame = backdrop.querySelector('#cy-test-frame');
    wrap.hidden = false;
    frame.src = url;
  };
  backdrop.querySelector('#btn-cy-close-test').onclick = () => {
    backdrop.querySelector('#cy-iframe-test-wrap').hidden = true;
    backdrop.querySelector('#cy-test-frame').src = 'about:blank';
  };

  backdrop.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const title = String(fd.get('title') || '').trim();
    const url = convertYoutubeToEmbed(String(fd.get('url') || '').trim());
    if (!title || !url) return;

    const payload = {
      id: existing?.id || uid('site'),
      title,
      category: String(fd.get('category') || '학습').trim() || '학습',
      url,
      entryCost: Math.max(0, Math.trunc(Number(fd.get('entryCost') || 0))),
      coinPerMin: Math.max(0, Math.trunc(Number(fd.get('coinPerMin') || 0))),
      timeLimitMin: Math.max(0, Math.trunc(Number(fd.get('timeLimitMin') || 0))),
      openMode: String(fd.get('openMode') || 'iframe') === 'popup' ? 'popup' : 'iframe',
      strictSinglePage: fd.get('strictSinglePage') === 'on',
      enabled: existing?.enabled !== false,
      createdAt: existing?.createdAt || Date.now(),
    };

    await store.update((s) => {
      if (!Array.isArray(s.cyberRoom.sites)) s.cyberRoom.sites = [];
      const idx = s.cyberRoom.sites.findIndex((x) => x.id === payload.id);
      if (idx >= 0) s.cyberRoom.sites[idx] = payload;
      else s.cyberRoom.sites.unshift(payload);
    });
    await syncCyberToCloud();
    playSound('confirm');
    showToast({ title: existing ? '사이트 정보를 수정했습니다!' : '새 사이트를 등록했습니다!', tone: 'plus' });
    close();
    if (typeof onSaved === 'function') onSaved();
  };
}

/** 전체 사이트 요금·시간 일괄 설정 모달 */
function openBulkPolicyModal(onSaved) {
  const def = store.getState().cyberRoom?.defaultPolicy || { entryCost: 0, coinPerMin: 1, timeLimitMin: 0 };
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  backdrop.innerHTML = `
    <form class="dialog-card">
      <div class="dialog-header">
        <h2>⚙️ 전체 사이트 요금 · 시간 일괄 설정</h2>
        <button type="button" class="dialog-close">&times;</button>
      </div>
      <div class="dialog-body">
        <p style="margin:0 0 12px;font-size:13px;color:#6f675a;">등록된 모든 사이트와 앞으로 등록할 사이트의 기본 요금 및 시간 제한을 한 번에 적용합니다.</p>
        <div class="field-row">
          <label class="field-label">
            <span>입장 코인</span>
            <input type="number" name="entryCost" min="0" max="999" value="${Number(def.entryCost) || 0}">
          </label>
          <label class="field-label">
            <span>분당 코인 (0 가능)</span>
            <input type="number" name="coinPerMin" min="0" max="99" value="${Number(def.coinPerMin) ?? 1}">
          </label>
          <label class="field-label">
            <span>시간 제한 (분 · 0=무제한)</span>
            <input type="number" name="timeLimitMin" min="0" max="180" value="${Number(def.timeLimitMin) || 0}">
          </label>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn-ghost" data-cancel>취소</button>
        <button type="submit" class="btn-yellow">전체 사이트 일괄 적용</button>
      </div>
    </form>
  `;

  modalRoot.appendChild(backdrop);
  backdrop.querySelector('.dialog-close').onclick = close;
  backdrop.querySelector('[data-cancel]').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  backdrop.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const entryCost = Math.max(0, Math.trunc(Number(fd.get('entryCost') || 0)));
    const coinPerMin = Math.max(0, Math.trunc(Number(fd.get('coinPerMin') || 0)));
    const timeLimitMin = Math.max(0, Math.trunc(Number(fd.get('timeLimitMin') || 0)));

    await store.update((s) => {
      s.cyberRoom.defaultPolicy = { entryCost, coinPerMin, timeLimitMin };
      for (const site of s.cyberRoom.sites || []) {
        site.entryCost = entryCost;
        site.coinPerMin = coinPerMin;
        site.timeLimitMin = timeLimitMin;
      }
    });
    await syncCyberToCloud();
    playSound('confirm');
    showToast({ title: `전체 사이트 요금(입장 ${entryCost} / 분당 ${coinPerMin} / ${timeLimitMin > 0 ? `${timeLimitMin}분` : '무제한'})을 일괄 적용했습니다!`, tone: 'plus' });
    close();
    if (typeof onSaved === 'function') onSaved();
  };
}

/** 으쓱 점수 → 사이버 코인 환전 모달 */
function openExchangeModal(studentIds, onSaved) {
  const modalRoot = document.getElementById('modal-root');
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const close = () => backdrop.remove();

  backdrop.innerHTML = `
    <form class="dialog-card">
      <div class="dialog-header">
        <h2>🔄 으쓱 점수 → 사이버 코인 환전 (${studentIds.length}명)</h2>
        <button type="button" class="dialog-close">&times;</button>
      </div>
      <div class="dialog-body">
        <p style="margin:0 0 12px;font-size:13px;color:#6f675a;">선택한 학생들의 보유 <strong>으쓱 점수</strong>를 차감하지 않고 복사 지급하거나, 으쓱 점수를 차감하며 코인으로 환전할 수 있습니다.</p>
        <div class="field-row">
          <label class="field-label">
            <span>환전할 으쓱 점수 (학생당)</span>
            <input type="number" name="points" min="1" max="100" value="5">
          </label>
          <label class="field-label">
            <span>으쓱 1점당 코인 비율</span>
            <input type="number" name="rate" min="1" max="20" value="${Number(store.getState().cyberRoom?.exchangeRate) || 1}">
          </label>
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;font-weight:700;cursor:pointer;">
          <input type="checkbox" name="deductScore" checked style="accent-color:#f0be2a;width:16px;height:16px;">
          <span>환전 시 학생의 으쓱 점수도 함께 차감 (보유 점수 범위 내에서만 환전)</span>
        </label>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn-ghost" data-cancel>취소</button>
        <button type="submit" class="btn-yellow">환전 실행</button>
      </div>
    </form>
  `;

  modalRoot.appendChild(backdrop);
  backdrop.querySelector('.dialog-close').onclick = close;
  backdrop.querySelector('[data-cancel]').onclick = close;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

  backdrop.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const pts = Math.max(1, Math.trunc(Number(fd.get('points') || 1)));
    const rate = Math.max(1, Math.trunc(Number(fd.get('rate') || 1)));
    const deduct = fd.get('deductScore') === 'on';
    let convertedCnt = 0;

    await store.update((s) => {
      s.cyberRoom.exchangeRate = rate;
      for (const sid of studentIds) {
        const st = s.students.find((x) => x.id === sid);
        if (!st) continue;
        const usable = deduct ? Math.min(pts, Math.max(0, Number(st.positive) || 0)) : pts;
        if (usable <= 0) continue;
        if (deduct) {
          st.positive = Math.max(0, (st.positive || 0) - usable);
          st.score = (st.positive || 0) - (st.negative || 0);
        }
        const curCoins = getStudentCyberCoins(s.cyberRoom, sid);
        s.cyberRoom.coins[sid] = curCoins + usable * rate;
        convertedCnt++;
      }
    });
    await syncCyberToCloud();
    playSound('pickResult');
    showToast({ title: `${convertedCnt}명의 으쓱 점수를 사이버 코인으로 환전했습니다!`, tone: 'plus' });
    close();
    if (typeof onSaved === 'function') onSaved();
  };
}
