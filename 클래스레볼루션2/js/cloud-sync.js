// 클래스레볼루션2 독립 Firebase Firestore 동기화(cr2Classes) + 관리페이지 종속 학생 자동접속 URL + 구글 드라이브 Apps Script 브리지

const FIREBASE_SDK = 'https://www.gstatic.com/firebasejs/11.10.0';
const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];
const STUDENT_HASH_PREFIX = 'CR2S.';

/** 교사가 script.google.com에 붙여넣어 웹 앱으로 배포할 구글 드라이브 연동 스크립트 */
export const GOOGLE_APPS_SCRIPT_TEMPLATE = `// 클래스레볼루션2 - 구글 드라이브 과제 파일 저장 브리지 (Google Apps Script)
// [배포 방법]
// 1. https://script.google.com 접속 → 새 프로젝트 → 아래 코드 전체 붙여넣기 → 저장
// 2. 우측 상단 [배포] → [새 배포] → 유형: [웹 앱]
// 3. 실행 사용자: [나], 액세스 권한: [모든 사용자] → [배포] 후 생성된 웹 앱 URL을 관리페이지에 입력

function getOrCreateFolder_(parent, name) {
  var safeName = String(name || '클래스레볼루션2').replace(/[\\\\/:*?"<>|]/g, '_').trim() || '클래스레볼루션2';
  var it = parent.getFoldersByName(safeName);
  return it.hasNext() ? it.next() : parent.createFolder(safeName);
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: 'ClassRevolution2-DriveBridge' }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    if (payload.action === 'ping') {
      var root = getOrCreateFolder_(DriveApp.getRootFolder(), payload.folderName || '클래스레볼루션2');
      return ContentService
        .createTextOutput(JSON.stringify({ ok: true, folderId: root.getId(), folderUrl: root.getUrl(), folderName: root.getName() }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var rootFolder = getOrCreateFolder_(DriveApp.getRootFolder(), payload.folderName || '클래스레볼루션2');
    var subFolder = payload.subFolder ? getOrCreateFolder_(rootFolder, payload.subFolder) : rootFolder;

    var bytes = Utilities.base64Decode(payload.base64);
    var mimeType = payload.mimeType || 'application/octet-stream';
    var fileName = String(payload.fileName || ('file_' + Date.now())).replace(/[\\\\/:*?"<>|]/g, '_');
    var blob = Utilities.newBlob(bytes, mimeType, fileName);
    var file = subFolder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    var id = file.getId();
    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        fileId: id,
        name: file.getName(),
        mimeType: mimeType,
        size: bytes.length,
        viewUrl: 'https://drive.google.com/file/d/' + id + '/view',
        downloadUrl: 'https://drive.google.com/uc?export=download&id=' + id,
        thumbnailUrl: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1200'
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}`;

/** Firebase 설정 텍스트/객체 파싱 */
export function parseFirebaseConfig(source) {
  let input;
  if (typeof source === 'object' && source) {
    input = source;
  } else {
    const raw = String(source || '').trim();
    try {
      input = JSON.parse(raw);
    } catch {
      input = {};
      for (const key of REQUIRED_KEYS) {
        const m = new RegExp(`(?:^|[,{\\s])["']?${key}["']?\\s*:\\s*["']([^"'\\s]+)["']`).exec(raw);
        if (m) input[key] = m[1];
      }
    }
  }
  if (!REQUIRED_KEYS.every((k) => typeof input?.[k] === 'string' && /^[a-z0-9_.:-]{1,180}$/i.test(input[k]))) {
    throw new Error('Firebase 설정에서 apiKey, authDomain, projectId, appId를 확인해 주세요.');
  }
  return Object.fromEntries(REQUIRED_KEYS.map((k) => [k, input[k]]));
}

/** 관리페이지 종속 학생 접속 URL 생성 (student.html#CR2S.{...}) */
export function buildStudentConnectUrl(firebaseConfig, classId, currentHref = location.href) {
  const url = new URL('student.html', currentHref);
  if (firebaseConfig && classId) {
    const json = JSON.stringify({ config: parseFirebaseConfig(firebaseConfig), classId });
    const b64 = btoa(unescape(encodeURIComponent(json)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    url.hash = STUDENT_HASH_PREFIX + b64;
  } else {
    url.hash = '';
  }
  return url.href;
}

/** 학생페이지 URL 해시에서 서버 연결 정보 복원 */
export function parseStudentConnectHash(hashStr = location.hash) {
  const raw = String(hashStr || '').replace(/^#/, '').trim();
  if (!raw.startsWith(STUDENT_HASH_PREFIX)) return null;
  try {
    const b64 = raw.slice(STUDENT_HASH_PREFIX.length).replaceAll('-', '+').replaceAll('_', '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const parsed = JSON.parse(json);
    if (!parsed?.classId || !parsed?.config) return null;
    return {
      config: parseFirebaseConfig(parsed.config),
      classId: String(parsed.classId),
    };
  } catch {
    return null;
  }
}

/** 이미지 파일을 경량 DataURL로 압축 (구글 드라이브 미연결 폴백 및 배경지 최적화) */
export function compressImageToDataUrl(file, maxWidth = 1280, quality = 0.78) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(String(reader.result || ''));
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일 변환에 실패했습니다.'));
    reader.onload = () => {
      const res = String(reader.result || '');
      const idx = res.indexOf(',');
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.readAsDataURL(file);
  });
}

/** 구글 드라이브 Apps Script 웹앱 연결 테스트 */
export async function testDriveBridge(bridgeUrl, folderName = '클래스레볼루션2') {
  const url = String(bridgeUrl || '').trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/i.test(url)) {
    throw new Error('올바른 Google Apps Script 웹 앱 URL(https://script.google.com/macros/s/.../exec)을 입력해 주세요.');
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'ping', folderName }),
  });
  const data = await resp.json();
  if (!data?.ok) throw new Error(data?.error || '구글 드라이브 연결 테스트에 실패했습니다.');
  return data;
}

/**
 * 과제 사진/파일을 교사 구글 드라이브 내 {folderName}/{assignmentTitle}/ 폴더로 업로드
 * 구글 드라이브 미연결 상태이고 이미지 파일이면 자동 압축 DataURL로 폴백 반환
 */
export async function uploadFileToDrive({ bridgeUrl, folderName = '클래스레볼루션2', assignmentTitle = '공통', studentLabel = '', file }) {
  if (!file) throw new Error('업로드할 파일이 없습니다.');
  const cleanUrl = String(bridgeUrl || '').trim();
  const safePrefix = studentLabel ? `${studentLabel}_` : '';
  const finalName = `${safePrefix}${file.name || `photo_${Date.now()}.jpg`}`;

  if (cleanUrl && /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/i.test(cleanUrl)) {
    if (file.size > 20 * 1024 * 1024) {
      throw new Error('파일 크기는 최대 20MB까지 업로드할 수 있습니다.');
    }
    const base64 = await fileToBase64(file);
    const resp = await fetch(cleanUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'upload',
        folderName: folderName || '클래스레볼루션2',
        subFolder: assignmentTitle || '과제',
        fileName: finalName,
        mimeType: file.type || 'application/octet-stream',
        base64,
      }),
    });
    const data = await resp.json();
    if (!data?.ok) throw new Error(data?.error || '구글 드라이브 업로드에 실패했습니다.');
    return {
      storage: 'gdrive',
      fileId: data.fileId,
      name: data.name || finalName,
      mimeType: data.mimeType || file.type || 'application/octet-stream',
      size: data.size || file.size,
      viewUrl: data.viewUrl,
      downloadUrl: data.downloadUrl,
      thumbnailUrl: data.thumbnailUrl || data.viewUrl,
    };
  }

  // 구글 드라이브 미연결 시: 이미지는 경량 압축 DataURL 폴백
  if (file.type && file.type.startsWith('image/')) {
    const dataUrl = await compressImageToDataUrl(file, 1100, 0.72);
    return {
      storage: 'inline',
      fileId: '',
      name: finalName,
      mimeType: 'image/jpeg',
      size: Math.round(dataUrl.length * 0.75),
      viewUrl: dataUrl,
      downloadUrl: dataUrl,
      thumbnailUrl: dataUrl,
    };
  }

  throw new Error('일반 파일(PDF·문서 등)을 올리려면 관리페이지에서 구글 드라이브를 연결해 주세요.');
}

// ---------- Firebase Firestore 런타임 연결 관리자 ----------

let fbRuntime = null; // { fs, db, config, classId, unsubs: [] }

async function loadFirebaseRuntime(config, appSuffix = 'teacher') {
  const parsed = parseFirebaseConfig(config);
  const [appMod, authMod, fsMod] = await Promise.all([
    import(`${FIREBASE_SDK}/firebase-app.js`),
    import(`${FIREBASE_SDK}/firebase-auth.js`),
    import(`${FIREBASE_SDK}/firebase-firestore.js`),
  ]);
  const appName = `cr2-${appSuffix}-${parsed.projectId}-${parsed.appId}`;
  const app = appMod.getApps().find((a) => a.name === appName) || appMod.initializeApp(parsed, appName);
  const auth = authMod.getAuth(app);
  await auth.authStateReady();
  if (!auth.currentUser) {
    await authMod.signInAnonymously(auth).catch(() => {});
  }
  const db = fsMod.getFirestore(app);
  return { fs: fsMod, db, config: parsed };
}

export function isCloudConnected() {
  return Boolean(fbRuntime && fbRuntime.db && fbRuntime.classId);
}

export function getCloudInfo() {
  return fbRuntime ? { classId: fbRuntime.classId, projectId: fbRuntime.config.projectId } : null;
}

export function disconnectCloud() {
  if (fbRuntime?.unsubs) {
    for (const u of fbRuntime.unsubs) {
      try { u(); } catch {}
    }
  }
  fbRuntime = null;
}

/** 교사용 앱 Firebase 연결 및 실시간 제출물 구독 시작 */
export async function connectTeacherCloud(firebaseConfig, classId, { onRemoteSubmissions = null } = {}) {
  disconnectCloud();
  const rt = await loadFirebaseRuntime(firebaseConfig, 'teacher');
  const cid = String(classId || '').trim() || `cls_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  fbRuntime = { ...rt, classId: cid, unsubs: [] };

  if (typeof onRemoteSubmissions === 'function') {
    const subCol = rt.fs.collection(rt.db, 'cr2Classes', cid, 'submissions');
    const unsub = rt.fs.onSnapshot(subCol, (snap) => {
      const grouped = {};
      snap.forEach((docSnap) => {
        const d = docSnap.data();
        if (!d?.assignmentId || !d?.studentId) return;
        if (!grouped[d.assignmentId]) grouped[d.assignmentId] = {};
        grouped[d.assignmentId][d.studentId] = d;
      });
      onRemoteSubmissions(grouped);
    }, (err) => {
      console.warn('[CR2 Cloud] submissions listener error:', err);
    });
    fbRuntime.unsubs.push(unsub);
  }
  const scCol = rt.fs.collection(rt.db, 'cr2Classes', cid, 'selfCheckEntries');
  const unsubSc = rt.fs.onSnapshot(scCol, (snap) => {
    const entries = {};
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      if (!d?.checkId || !d?.studentId) return;
      if (!entries[d.checkId]) entries[d.checkId] = {};
      entries[d.checkId][d.studentId] = d.value;
    });
    window.dispatchEvent(new CustomEvent('class123:remote-selfchecks', { detail: entries }));
  }, () => {});
  fbRuntime.unsubs.push(unsubSc);

  const cyberCol = rt.fs.collection(rt.db, 'cr2Classes', cid, 'cyberSessions');
  const unsubCyber = rt.fs.onSnapshot(cyberCol, (snap) => {
    const sessions = {};
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      if (!d?.studentId) return;
      sessions[d.studentId] = d;
    });
    window.dispatchEvent(new CustomEvent('class123:remote-cyber', { detail: sessions }));
  }, () => {});
  fbRuntime.unsubs.push(unsubCyber);
  return cid;
}

/** 교사 학급 기본정보·학생 계정·과제·구글드라이브 설정을 Firestore에 동기화 */
export async function syncTeacherStateToCloud(state) {
  if (!isCloudConnected() || !state) return;
  const { fs, db, classId } = fbRuntime;
  const classRef = fs.doc(db, 'cr2Classes', classId);
  const publicStudents = (state.students || [])
    .filter((s) => !s.trashed)
    .map((s) => ({
      id: s.id,
      number: s.number,
      name: s.name,
      avatarId: s.avatarId,
      groupId: s.groupId,
      positive: s.positive,
      negative: s.negative,
      score: s.score,
      absent: Boolean(s.absent),
      loginId: s.loginId || '',
      loginPw: s.loginPw || '',
      loginEnabled: s.loginEnabled !== false,
    }));

  await fs.setDoc(classRef, {
    className: state.classInfo?.name || '우리 반',
    motto: state.classInfo?.motto || '',
    starsPerEgg: Math.max(5, Number(state.classInfo?.starsPerEgg) || 10),
    driveBridgeUrl: state.cloudConfig?.driveBridgeUrl || '',
    driveFolderName: state.cloudConfig?.driveFolderName || '클래스레볼루션2',
    students: publicStudents,
    groups: Array.isArray(state.groups)
      ? state.groups.map((g) => ({ id: g.id, name: g.name, order: g.order ?? 0 }))
      : [],
    growth: state.growth
      ? {
          eggs: Number(state.growth.eggs) || 0,
          pendingTrailCount: Array.isArray(state.growth.pendingTrail) ? state.growth.pendingTrail.length : 0,
          goals: Array.isArray(state.growth.goals) ? state.growth.goals : [],
        }
      : { eggs: 0, pendingTrailCount: 0, goals: [] },
    wbScoreboard: state.wbScoreboard
      ? {
          baseGroupMode: state.wbScoreboard.baseGroupMode === 'avg' ? 'avg' : 'sum',
          specialGroupScores: state.wbScoreboard.specialGroupScores || {},
        }
      : { baseGroupMode: 'sum', specialGroupScores: {} },
    assignments: Array.isArray(state.assignments) ? state.assignments : [],
    selfChecks: Array.isArray(state.selfChecks) ? state.selfChecks : [],
    cyberRoom: state.cyberRoom || null,
    updatedAt: Date.now(),
  }, { merge: true });
}

/** 단일 제출물(학생 제출 또는 교사 채점/피드백)을 Firestore에 저장 */
export async function pushSubmissionToCloud(assignmentId, studentId, submission) {
  if (!isCloudConnected()) return;
  const { fs, db, classId } = fbRuntime;
  const docId = `${assignmentId}__${studentId}`;
  const ref = fs.doc(db, 'cr2Classes', classId, 'submissions', docId);
  await fs.setDoc(ref, {
    ...submission,
    assignmentId,
    studentId,
    updatedAt: Date.now(),
  }, { merge: true });
}

/** 학생페이지 전용: 전달받은 Firebase 설정·학급코드로 자동 연결 및 실시간 구독 */
export async function connectStudentCloud(firebaseConfig, classId, { onClassUpdate, onSubmissionsUpdate }) {
  const rt = await loadFirebaseRuntime(firebaseConfig, 'student');
  const unsubs = [];

  const classRef = rt.fs.doc(rt.db, 'cr2Classes', classId);
  unsubs.push(rt.fs.onSnapshot(classRef, (snap) => {
    if (snap.exists() && typeof onClassUpdate === 'function') {
      onClassUpdate(snap.data());
    }
  }));

  const subCol = rt.fs.collection(rt.db, 'cr2Classes', classId, 'submissions');
  unsubs.push(rt.fs.onSnapshot(subCol, (snap) => {
    const grouped = {};
    snap.forEach((docSnap) => {
      const d = docSnap.data();
      if (!d?.assignmentId || !d?.studentId) return;
      if (!grouped[d.assignmentId]) grouped[d.assignmentId] = {};
      grouped[d.assignmentId][d.studentId] = d;
    });
    if (typeof onSubmissionsUpdate === 'function') onSubmissionsUpdate(grouped);
  }));

  return {
    saveSubmission: async (assignmentId, studentId, submission) => {
      const docId = `${assignmentId}__${studentId}`;
      const ref = rt.fs.doc(rt.db, 'cr2Classes', classId, 'submissions', docId);
      await rt.fs.setDoc(ref, {
        ...submission,
        assignmentId,
        studentId,
        updatedAt: Date.now(),
      }, { merge: true });
    },
    saveSelfCheckEntry: async (checkId, studentId, value) => {
      const docId = `${checkId}__${studentId}`;
      const ref = rt.fs.doc(rt.db, 'cr2Classes', classId, 'selfCheckEntries', docId);
      await rt.fs.setDoc(ref, {
        checkId,
        studentId,
        value,
        updatedAt: Date.now(),
      }, { merge: true });
    },
    saveCyberSession: async (studentId, payload) => {
      const ref = rt.fs.doc(rt.db, 'cr2Classes', classId, 'cyberSessions', studentId);
      await rt.fs.setDoc(ref, {
        studentId,
        ...payload,
        updatedAt: Date.now(),
      }, { merge: true });
    },
    disconnect: () => {
      for (const u of unsubs) { try { u(); } catch {} }
    },
  };
}
