// 원자적 점수 엔진 — 상점/감점, 별길 전진/후퇴, 황금알 경계 복원, 목표 달성 감지, 이력 되돌리기, 직접조정, 초기화

import { store, uid } from './store.js';

/** 새로 달성된 학급 목표 계산 */
function detectNewlyAchievedGoals(goals, prevEggs, nextEggs) {
  if (nextEggs <= prevEggs) return [];
  return (goals || [])
    .filter((g) => Number(g.targetEggs) > prevEggs && Number(g.targetEggs) <= nextEggs)
    .sort((a, b) => a.targetEggs - b.targetEggs);
}

/** 별길 전진 (+steps) */
function advanceTrail(growth, starsPerEgg, studentContributors) {
  let eggsAdded = 0;
  for (const contrib of studentContributors) {
    growth.pendingTrail.push({
      studentId: contrib.id,
      name: contrib.name,
      avatarId: contrib.avatarId,
    });
    if (growth.pendingTrail.length >= starsPerEgg) {
      const completed = growth.pendingTrail.splice(0, starsPerEgg);
      growth.eggStacks.push(completed);
      if (growth.eggStacks.length > 50) growth.eggStacks.shift();
      growth.eggs += 1;
      eggsAdded += 1;
    }
  }
  return eggsAdded;
}

/** 별길 후퇴 (-steps) — 황금알 경계를 넘으면 0 이하(음수)까지 황금알 -1 및 이전 기여 복원 */
function retreatTrail(growth, starsPerEgg, steps) {
  let eggsRemoved = 0;
  for (let i = 0; i < steps; i++) {
    if (growth.pendingTrail.length > 0) {
      growth.pendingTrail.pop();
    } else {
      growth.eggs -= 1;
      eggsRemoved += 1;
      const restored = growth.eggStacks.pop();
      if (restored && restored.length > 0) {
        growth.pendingTrail = restored.slice(0, starsPerEgg - 1);
      } else {
        growth.pendingTrail = Array.from({ length: starsPerEgg - 1 }, () => ({
          studentId: null,
          name: '우리반',
          avatarId: 1,
          archived: true,
        }));
      }
    }
  }
  return eggsRemoved;
}

/** 최근 사유 목록 갱신 (최대 10개) */
function recordRecentReason(reasons, isPositive, reasonText) {
  const clean = (reasonText || '').trim();
  if (!clean) return;
  const key = isPositive ? 'recentPositive' : 'recentNegative';
  const list = Array.isArray(reasons[key]) ? reasons[key] : [];
  reasons[key] = [clean, ...list.filter((r) => r !== clean)].slice(0, 10);
}

/**
 * 선택 학생 일괄 점수 부여 (상점 또는 감점)
 * 모든 대상에게 동일한 사유와 동일한 변동량 적용
 */
export async function applyStudentScoreBatch({ studentIds, delta, reason }) {
  const numericDelta = Math.trunc(Number(delta));
  if (!numericDelta || !Array.isArray(studentIds) || studentIds.length === 0) {
    return null;
  }
  const cleanReason = (reason || '').trim() || (numericDelta > 0 ? '으쓱 상점' : '머쓱 감점');

  let outcome = null;

  await store.update((state) => {
    const targets = state.students.filter((s) => !s.trashed && studentIds.includes(s.id));
    if (targets.length === 0) return;

    const starsPerEgg = Math.max(5, Number(state.classInfo.starsPerEgg) || 10);
    const prevEggs = state.growth.eggs;
    let eggsDelta = 0;

    if (numericDelta > 0) {
      const contributors = [];
      for (const st of targets) {
        st.positive += numericDelta;
        st.score += numericDelta;
        state.growth.totalPositive += numericDelta;
        for (let k = 0; k < numericDelta; k++) {
          contributors.push(st);
        }
      }
      eggsDelta = advanceTrail(state.growth, starsPerEgg, contributors);
      recordRecentReason(state.reasons, true, cleanReason);
    } else {
      const absDelta = Math.abs(numericDelta);
      let totalRetreat = 0;
      for (const st of targets) {
        st.negative += absDelta;
        st.score -= absDelta;
        state.growth.totalNegative += absDelta;
        totalRetreat += absDelta;
      }
      const removed = retreatTrail(state.growth, starsPerEgg, totalRetreat);
      eggsDelta = -removed;
      recordRecentReason(state.reasons, false, cleanReason);
    }

    const achievedGoals = detectNewlyAchievedGoals(state.growth.goals, prevEggs, state.growth.eggs);

    const entry = {
      id: uid('hist'),
      timestamp: Date.now(),
      kind: 'score',
      delta: numericDelta,
      reason: cleanReason,
      studentIds: targets.map((t) => t.id),
      studentNames: targets.map((t) => t.name),
      reverted: false,
    };
    state.history.unshift(entry);
    if (state.history.length > 500) state.history.length = 500;

    outcome = {
      kind: 'score',
      delta: numericDelta,
      reason: cleanReason,
      targets: targets.map((t) => ({ id: t.id, name: t.name, avatarId: t.avatarId, score: t.score })),
      eggsDelta,
      eggsNow: state.growth.eggs,
      achievedGoals,
      historyId: entry.id,
    };
  });

  // 타 탭 알림을 위해 outcome을 별도 브로드캐스트
  if (outcome && store.channel) {
    store.channel.postMessage({
      tabId: 'remote-fx-trigger',
      type: 'state-updated',
      event: outcome,
    });
  }

  return outcome;
}

/** 학급 황금알 직접 가감 (+ / -, 0 이하 음수 허용) */
export async function adjustSpecialEggs(delta, reason = '선생님 특별 황금알') {
  const numericDelta = Math.trunc(Number(delta));
  if (!numericDelta) return null;

  let outcome = null;
  await store.update((state) => {
    const prevEggs = state.growth.eggs;
    const nextEggs = prevEggs + numericDelta;
    const actualDelta = nextEggs - prevEggs;
    if (actualDelta === 0) return;

    state.growth.eggs = nextEggs;
    state.growth.specialEggs = (state.growth.specialEggs || 0) + actualDelta;

    const achievedGoals = detectNewlyAchievedGoals(state.growth.goals, prevEggs, nextEggs);
    const entry = {
      id: uid('hist'),
      timestamp: Date.now(),
      kind: 'egg',
      delta: actualDelta,
      reason: reason || (actualDelta > 0 ? '특별 황금알 부여' : '특별 황금알 차감'),
      studentIds: [],
      studentNames: ['학급 전체'],
      reverted: false,
    };
    state.history.unshift(entry);

    outcome = {
      kind: 'egg',
      delta: actualDelta,
      reason: entry.reason,
      eggsNow: nextEggs,
      achievedGoals,
      historyId: entry.id,
    };
  });

  return outcome;
}

/** 점수 이력 건별 되돌리기 (Undo) */
export async function undoHistoryEntry(historyId) {
  let result = null;
  await store.update((state) => {
    const entry = state.history.find((h) => h.id === historyId);
    if (!entry || entry.reverted) return;

    const starsPerEgg = Math.max(5, Number(state.classInfo.starsPerEgg) || 10);

    if (entry.kind === 'score') {
      const targets = state.students.filter((s) => entry.studentIds.includes(s.id));
      const d = entry.delta;
      if (d > 0) {
        let totalSteps = 0;
        for (const st of targets) {
          st.positive = Math.max(0, st.positive - d);
          st.score -= d;
          state.growth.totalPositive = Math.max(0, state.growth.totalPositive - d);
          totalSteps += d;
        }
        retreatTrail(state.growth, starsPerEgg, totalSteps);
      } else if (d < 0) {
        const absD = Math.abs(d);
        const contributors = [];
        for (const st of targets) {
          st.negative = Math.max(0, st.negative - absD);
          st.score += absD;
          state.growth.totalNegative = Math.max(0, state.growth.totalNegative - absD);
          for (let k = 0; k < absD; k++) contributors.push(st);
        }
        advanceTrail(state.growth, starsPerEgg, contributors);
      }
      entry.reverted = true;
      result = { ok: true, message: `"${entry.reason}" 이력을 되돌렸습니다.` };
    } else if (entry.kind === 'egg') {
      state.growth.eggs = state.growth.eggs - entry.delta;
      state.growth.specialEggs = (state.growth.specialEggs || 0) - entry.delta;
      entry.reverted = true;
      result = { ok: true, message: `황금알(${entry.delta > 0 ? '+' : ''}${entry.delta}) 변동 이력을 되돌렸습니다.` };
    } else if (entry.kind === 'adjust' && Array.isArray(entry.adjustments)) {
      for (const adj of entry.adjustments) {
        const st = state.students.find((s) => s.id === adj.studentId);
        if (!st) continue;
        st.positive = adj.prevPositive;
        st.negative = adj.prevNegative;
        st.score = adj.prevScore;
      }
      entry.reverted = true;
      result = { ok: true, message: '직접 점수 조정을 되돌렸습니다.' };
    }
  });
  return result;
}

/** 관리자 직접 점수 일괄 조정 */
export async function applyDirectAdjustments(rows, reason = '교사 직접 점수 조정') {
  let changedCount = 0;
  await store.update((state) => {
    const adjustments = [];
    for (const row of rows) {
      const st = state.students.find((s) => s.id === row.studentId);
      if (!st) continue;
      const newPos = Math.max(0, Math.trunc(Number(row.positive) || 0));
      const newNeg = Math.max(0, Math.trunc(Number(row.negative) || 0));
      const newScore = newPos - newNeg;
      if (st.positive === newPos && st.negative === newNeg && st.score === newScore) continue;

      adjustments.push({
        studentId: st.id,
        name: st.name,
        prevPositive: st.positive,
        prevNegative: st.negative,
        prevScore: st.score,
        nextPositive: newPos,
        nextNegative: newNeg,
        nextScore: newScore,
      });

      const posDiff = newPos - st.positive;
      const negDiff = newNeg - st.negative;
      st.positive = newPos;
      st.negative = newNeg;
      st.score = newScore;
      state.growth.totalPositive = Math.max(0, state.growth.totalPositive + posDiff);
      state.growth.totalNegative = Math.max(0, state.growth.totalNegative + negDiff);
    }

    changedCount = adjustments.length;
    if (changedCount > 0) {
      state.history.unshift({
        id: uid('hist'),
        timestamp: Date.now(),
        kind: 'adjust',
        delta: 0,
        reason,
        studentIds: adjustments.map((a) => a.studentId),
        studentNames: adjustments.map((a) => a.name),
        adjustments,
        reverted: false,
      });
    }
  });
  return changedCount;
}

/**
 * 점수 초기화
 * scope: 'selected' | 'all-students' | 'all-with-eggs'
 */
export async function resetScores({ scope = 'all-students', studentIds = [] }) {
  await store.update((state) => {
    const targets = scope === 'selected'
      ? state.students.filter((s) => !s.trashed && studentIds.includes(s.id))
      : state.students.filter((s) => !s.trashed);

    for (const st of targets) {
      st.positive = 0;
      st.negative = 0;
      st.score = 0;
    }

    if (scope === 'all-with-eggs') {
      state.growth.eggs = 0;
      state.growth.specialEggs = 0;
      state.growth.totalPositive = 0;
      state.growth.totalNegative = 0;
      state.growth.pendingTrail = [];
      state.growth.eggStacks = [];
    } else {
      state.growth.totalPositive = state.students.reduce((acc, s) => acc + (s.trashed ? 0 : s.positive), 0);
      state.growth.totalNegative = state.students.reduce((acc, s) => acc + (s.trashed ? 0 : s.negative), 0);
    }

    state.history.unshift({
      id: uid('hist'),
      timestamp: Date.now(),
      kind: 'reset',
      delta: 0,
      reason: scope === 'all-with-eggs'
        ? '개인 점수 및 학급 황금알 전체 초기화'
        : scope === 'selected'
          ? `선택 학생 ${targets.length}명 점수 초기화`
          : '전체 학생 개인 점수 초기화',
      studentIds: targets.map((t) => t.id),
      studentNames: scope === 'selected' ? targets.map((t) => t.name) : ['학급 전체'],
      reverted: false,
    });
  });
}
