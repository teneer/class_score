// 로컬 IndexedDB 저장소 + 다중 탭 실시간 동기화 + JSON 백업/복원

const DB_NAME = 'Class123RestoredDB';
const DB_VERSION = 1;
const STORE_NAME = 'appState';
const STATE_KEY = 'main';
const FALLBACK_LS_KEY = 'class123_restored_state_v1';
const CHANNEL_NAME = 'class123-restored-sync-v1';

const TAB_ID = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function padAvatarId(num) {
  const n = Math.max(1, Math.min(70, Number(num) || 1));
  return String(n).padStart(3, '0');
}

export function getStillAvatarUrl(avatarId) {
  return `assets/avatars/still/avatar_${padAvatarId(avatarId)}_000.png`;
}

export function getFxAvatarUrl(avatarId) {
  return `assets/avatars/fx/avatar_${padAvatarId(avatarId)}_400.png`;
}

export function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** 초기 샘플 상태 생성 (개인정보 없는 가상 학생 20명 + 5개 모둠) */
export function createDefaultState() {
  const sampleNames = [
    ['김하늘', 'F'], ['이도윤', 'M'], ['박서연', 'F'], ['최시우', 'M'],
    ['정지아', 'F'], ['강민준', 'M'], ['조은서', 'F'], ['윤예준', 'M'],
    ['장하은', 'F'], ['임주원', 'M'], ['한수아', 'F'], ['오건우', 'M'],
    ['서지유', 'F'], ['신현우', 'M'], ['권다은', 'F'], ['황선우', 'M'],
    ['안채원', 'F'], ['송유준', 'M'], ['전소율', 'F'], ['홍지호', 'M'],
  ];

  const groups = [
    { id: 'grp-1', name: '그룹 1', order: 0 },
    { id: 'grp-2', name: '그룹 2', order: 1 },
    { id: 'grp-3', name: '그룹 3', order: 2 },
    { id: 'grp-4', name: '그룹 4', order: 3 },
    { id: 'grp-5', name: '그룹 5', order: 4 },
  ];

  const students = sampleNames.map(([name, gender], idx) => {
    const groupIdx = Math.floor(idx / 4);
    const seatIdx = idx % 4;
    const pos = 12 + ((idx * 5) % 15);
    const neg = idx % 4 === 0 ? 2 : 0;
    return {
      id: `st-${idx + 1}`,
      number: idx + 1,
      name,
      gender,
      avatarId: (idx % 70) + 1,
      groupId: groups[groupIdx].id,
      seatIndex: seatIdx,
      positive: pos,
      negative: neg,
      score: pos - neg,
      absent: false,
      trashed: false,
      loginId: `s${String(idx + 1).padStart(2, '0')}`,
      loginPw: '1234',
      loginEnabled: true,
    };
  });

  const today = todayIso();
  const sampleItems = [
    { id: 'chk-1', title: '공책 정리', type: 'symbol', color: '#f29038', memo: '배움 공책 확인', archived: false, order: 0 },
    { id: 'chk-2', title: '단원 평가', type: 'rating', color: '#6b86e8', memo: '1~5단계 수행 기록', archived: false, order: 1 },
    { id: 'chk-3', title: '과제 제출', type: 'check', color: '#39b3a2', memo: '', archived: false, order: 2 },
  ];

  const sampleEntries = {};
  sampleEntries[today] = {};
  students.slice(0, 8).forEach((s, i) => {
    sampleEntries[today][`${s.id}::chk-1`] = ['◎', '◎', '○', '○', '△', '◎', '○', '×'][i];
    sampleEntries[today][`${s.id}::chk-2`] = String(5 - (i % 4));
    if (i < 5) sampleEntries[today][`${s.id}::chk-3`] = true;
  });

  return {
    schemaVersion: 1,
    classInfo: {
      name: '우리반 5기',
      motto: '우리 반의 한 마디를 작성해주세요!',
      starsPerEgg: 10,
      soundEnabled: true,
    },
    uiPrefs: {
      showNumbers: true,
      showAvatars: true,
      seatShowAvatars: false,
      sortBy: 'number',
      scoreDisplayMode: 'net', // 'net'(쑥쑥점수) | 'pos'(으쓱점수) | 'neg'(머쓱점수) | 'both'(으쓱+머쓱)
      seatingReversed: false,
    },
    students,
    groups,
    growth: {
      eggs: 8,
      specialEggs: 1,
      totalPositive: students.reduce((sum, s) => sum + s.positive, 0),
      totalNegative: students.reduce((sum, s) => sum + s.negative, 0),
      pendingTrail: [
        { studentId: 'st-1', name: '김하늘', avatarId: 1 },
        { studentId: 'st-3', name: '박서연', avatarId: 3 },
        { studentId: 'st-6', name: '강민준', avatarId: 6 },
      ],
      eggStacks: [],
      goals: [
        { id: 'goal-1', targetEggs: 10, reward: '학급 자유시간 20분' },
        { id: 'goal-2', targetEggs: 50, reward: '보드게임 파티' },
        { id: 'goal-3', targetEggs: 100, reward: '학급 영화관 데이' },
      ],
    },
    reasons: {
      positivePresets: [
        '발표를 멋지게 했어요',
        '친구를 따뜻하게 도와줬어요',
        '수업에 집중해서 참여했어요',
        '과제를 성실히 해왔어요',
        '정리정돈을 깔끔하게 했어요',
        '모둠 활동에 적극 협력했어요',
      ],
      negativePresets: [
        '수업 중 떠들었어요',
        '준비물을 챙기지 않았어요',
        '과제를 하지 않았어요',
        '친구와 다투었어요',
        '줄 서기 규칙을 어겼어요',
        '자리 정돈이 필요해요',
      ],
      recentPositive: ['발표를 멋지게 했어요', '수업에 집중해서 참여했어요'],
      recentNegative: ['수업 중 떠들었어요'],
      favoritesPositive: ['발표를 멋지게 했어요', '친구를 따뜻하게 도와줬어요'],
      favoritesNegative: ['수업 중 떠들었어요'],
    },
    history: [
      {
        id: uid('hist'),
        timestamp: Date.now() - 3600 * 1000,
        kind: 'score',
        delta: 2,
        reason: '발표를 멋지게 했어요',
        studentIds: ['st-1', 'st-3'],
        studentNames: ['김하늘', '박서연'],
        reverted: false,
      },
    ],
    checklist: {
      items: sampleItems,
      entriesByDate: sampleEntries,
    },
    tools: {
      pickedIds: [],
      rouletteItems: ['발표하기', '칠판 지우기', '우유 당번', '자유선택', '으쓱 +2점', '노래 한 소절'],
      ladderResults: ['당첨!', '통과', '통과', '보너스 +1', '통과', '발표왕'],
    },
    assignments: [],
    submissions: {}, // { [assignmentId]: { [studentId]: Submission } }
    cloudConfig: {
      firebaseConfig: null,
      classId: '',
      driveBridgeUrl: '',
      driveFolderName: '클래스레볼루션2',
    },
  };
}

class AppStore {
  constructor() {
    this.db = null;
    this.state = null;
    this.listeners = new Set();
    this.syncListeners = new Set();
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null;
    if (this.channel) {
      this.channel.onmessage = (ev) => this._onBroadcast(ev.data);
    }
    window.addEventListener('storage', (ev) => {
      if (ev.key === FALLBACK_LS_KEY && ev.newValue) {
        this._reloadFromStorage();
      }
    });
  }

  async init() {
    this.db = await this._openDB();
    const saved = await this._readDB();
    if (saved && saved.schemaVersion === 1 && Array.isArray(saved.students)) {
      this.state = this._ensureShape(saved);
    } else {
      this.state = createDefaultState();
      await this._writeDB(this.state);
    }
    return this.state;
  }

  _ensureShape(data) {
    const def = createDefaultState();
    const rawStudents = Array.isArray(data.students) ? data.students : def.students;
    const students = rawStudents.map((s, idx) => ({
      ...s,
      loginId: typeof s.loginId === 'string' && s.loginId.trim()
        ? s.loginId.trim()
        : `s${String(Number(s.number) || idx + 1).padStart(2, '0')}`,
      loginPw: typeof s.loginPw === 'string' ? s.loginPw : '1234',
      loginEnabled: s.loginEnabled !== false,
    }));
    return {
      ...def,
      ...data,
      students,
      classInfo: { ...def.classInfo, ...(data.classInfo || {}) },
      uiPrefs: { ...def.uiPrefs, ...(data.uiPrefs || {}) },
      growth: {
        ...def.growth,
        ...(data.growth || {}),
        pendingTrail: Array.isArray(data.growth?.pendingTrail) ? data.growth.pendingTrail : [],
        eggStacks: Array.isArray(data.growth?.eggStacks) ? data.growth.eggStacks : [],
        goals: Array.isArray(data.growth?.goals) ? data.growth.goals : [],
      },
      reasons: { ...def.reasons, ...(data.reasons || {}) },
      checklist: {
        items: Array.isArray(data.checklist?.items) ? data.checklist.items : def.checklist.items,
        entriesByDate: data.checklist?.entriesByDate || {},
      },
      tools: { ...def.tools, ...(data.tools || {}) },
      history: Array.isArray(data.history) ? data.history : [],
      assignments: Array.isArray(data.assignments) ? data.assignments : [],
      submissions: data.submissions && typeof data.submissions === 'object' ? data.submissions : {},
      cloudConfig: {
        ...def.cloudConfig,
        ...(data.cloudConfig || {}),
        driveFolderName: (data.cloudConfig?.driveFolderName || '클래스레볼루션2').trim() || '클래스레볼루션2',
      },
    };
  }

  _openDB() {
    return new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  _readDB() {
    return new Promise((resolve) => {
      if (!this.db) {
        try {
          const raw = localStorage.getItem(FALLBACK_LS_KEY);
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(null);
        }
        return;
      }
      try {
        const tx = this.db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(STATE_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  _writeDB(state) {
    return new Promise((resolve) => {
      try {
        localStorage.setItem(FALLBACK_LS_KEY, JSON.stringify({ updatedAt: Date.now(), tabId: TAB_ID }));
      } catch {
        // 무시
      }
      if (!this.db) {
        try {
          localStorage.setItem(FALLBACK_LS_KEY, JSON.stringify(state));
        } catch {
          // 무시
        }
        resolve();
        return;
      }
      try {
        const tx = this.db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(state, STATE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  getState() {
    return this.state;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onRemoteSync(fn) {
    this.syncListeners.add(fn);
    return () => this.syncListeners.delete(fn);
  }

  /** 상태 변경 및 저장 + 타 탭 브로드캐스트 */
  async update(mutator, broadcastEvent = null) {
    const result = mutator(this.state);
    await this._writeDB(this.state);
    this._emit();
    if (this.channel) {
      this.channel.postMessage({
        tabId: TAB_ID,
        type: 'state-updated',
        event: broadcastEvent,
      });
    }
    return result;
  }

  _emit() {
    for (const fn of this.listeners) {
      try { fn(this.state); } catch (e) { console.error(e); }
    }
  }

  async _onBroadcast(msg) {
    if (!msg || msg.tabId === TAB_ID) return;
    await this._reloadFromStorage();
    if (msg.event) {
      for (const fn of this.syncListeners) {
        try { fn(msg.event); } catch (e) { console.error(e); }
      }
    }
  }

  async _reloadFromStorage() {
    const latest = await this._readDB();
    if (latest && latest.schemaVersion === 1) {
      this.state = this._ensureShape(latest);
      this._emit();
    }
  }

  /** JSON 백업 내보내기 */
  exportBackupJson() {
    return JSON.stringify({
      app: 'Class123-Restored',
      exportedAt: new Date().toISOString(),
      data: this.state,
    }, null, 2);
  }

  /** JSON 백업 복원 */
  async importBackupJson(jsonText) {
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error('올바른 JSON 파일이 아닙니다.');
    }
    const payload = parsed.data && parsed.data.schemaVersion ? parsed.data : parsed;
    if (!payload || !Array.isArray(payload.students) || !payload.classInfo) {
      throw new Error('클래스123 복원 백업 형식과 맞지 않습니다.');
    }
    this.state = this._ensureShape(payload);
    await this._writeDB(this.state);
    this._emit();
    if (this.channel) {
      this.channel.postMessage({ tabId: TAB_ID, type: 'state-updated', event: { kind: 'restored' } });
    }
  }

  async resetToDemo() {
    this.state = createDefaultState();
    await this._writeDB(this.state);
    this._emit();
    if (this.channel) {
      this.channel.postMessage({ tabId: TAB_ID, type: 'state-updated', event: { kind: 'restored' } });
    }
  }
}

export const store = new AppStore();
