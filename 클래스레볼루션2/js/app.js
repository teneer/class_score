// 앱 엔트리포인트 — 초기화, 모드 전환, 설정/백업/복원, 다중 탭 동기화

import { store } from './store.js';
import { setSoundEnabled, playSound } from './audio.js';
import { setActiveModeProvider, openScoreComposer, presentOutcome, showToast } from './effects.js';
import { renderStudentsView, setStudentsNavigator, setStudentsSubView, getSelectedStudentIds } from './views/students.js';
import { renderGrowthView } from './views/growth.js';
import { renderChecklistView } from './views/checklist.js';
import { renderPickerView, renderTimerView, setPickerSubTool } from './views/tools.js';
import { renderBulkScoreView, setBulkScoreTab } from './views/bulk-score.js';

let currentMode = 'students'; // 'students' | 'seats' | 'growth' | 'checklist' | 'picker' | 'timer' | 'bulk'

const VIEW_CONTAINERS = {
  students: () => document.getElementById('view-students'),
  seats: () => document.getElementById('view-students'),
  growth: () => document.getElementById('view-growth'),
  checklist: () => document.getElementById('view-checklist'),
  picker: () => document.getElementById('view-picker'),
  timer: () => document.getElementById('view-timer'),
  bulk: () => document.getElementById('view-bulk'),
};

function switchMode(mode, options = {}) {
  if (!VIEW_CONTAINERS[mode]) return;
  currentMode = mode;

  if (mode === 'students') {
    setStudentsSubView('list');
  } else if (mode === 'seats') {
    setStudentsSubView('seats');
  }
  if (mode === 'picker' && options.subTool) {
    setPickerSubTool(options.subTool);
  }
  if (mode === 'bulk' && options.tab) {
    setBulkScoreTab(options.tab);
  }

  // 패널 활성화 전환 (전체화면 모드 전환)
  const activeContainerId = VIEW_CONTAINERS[mode]()?.id;
  document.querySelectorAll('.mode-view').forEach((el) => {
    el.classList.toggle('is-active', el.id === activeContainerId);
  });

  // 좌측 사이드바 활성 상태
  document.querySelectorAll('.rail-btn[data-mode]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mode === mode);
  });

  // 상단 탭 활성 상태
  document.querySelectorAll('.header-tab[data-quick-tab]').forEach((tab) => {
    const t = tab.dataset.quickTab;
    const active = t === mode || (t === 'students' && (mode === 'seats' || mode === 'picker' || mode === 'timer'));
    tab.classList.toggle('is-active', active);
  });

  renderChrome();
  renderCurrentView();
}

function renderChrome() {
  const state = store.getState();
  const titleEl = document.getElementById('header-class-name');
  if (titleEl) titleEl.textContent = state.classInfo.name || '우리 반';

  const soundOn = state.classInfo.soundEnabled !== false;
  setSoundEnabled(soundOn);
  const soundBtn = document.getElementById('btn-sound');
  if (soundBtn) soundBtn.setAttribute('aria-pressed', String(soundOn));

  // 최상단 헤더 표시 옵션(번호/아바타/점수표시/정렬) — 학생화면·자리배치에서만 노출
  const viewControls = document.getElementById('header-view-controls');
  const isStudentScreen = currentMode === 'students' || currentMode === 'seats';
  if (viewControls) {
    viewControls.hidden = !isStudentScreen;
    if (isStudentScreen) {
      const prefs = state.uiPrefs;
      const chkNum = document.getElementById('hdr-show-numbers');
      const chkAva = document.getElementById('hdr-show-avatars');
      const selScore = document.getElementById('hdr-score-mode');
      const selSort = document.getElementById('hdr-sort-by');
      if (chkNum) chkNum.checked = prefs.showNumbers !== false;
      if (chkAva) chkAva.checked = currentMode === 'seats' ? Boolean(prefs.seatShowAvatars) : prefs.showAvatars !== false;
      if (selScore) selScore.value = prefs.scoreDisplayMode || 'net';
      if (selSort) {
        selSort.value = prefs.sortBy || 'number';
        selSort.hidden = currentMode !== 'students';
      }
    }
  }
}

function renderCurrentView() {
  const container = VIEW_CONTAINERS[currentMode]?.();
  if (!container) return;

  if (currentMode === 'students' || currentMode === 'seats') renderStudentsView(container);
  else if (currentMode === 'growth') renderGrowthView(container);
  else if (currentMode === 'checklist') renderChecklistView(container);
  else if (currentMode === 'picker') renderPickerView(container);
  else if (currentMode === 'timer') renderTimerView(container);
  else if (currentMode === 'bulk') renderBulkScoreView(container);
}

function triggerBackupDownload() {
  const json = store.exportBackupJson();
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = URL.createObjectURL(blob);
  a.download = `class123-backup-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  playSound('confirm');
  showToast({ title: 'JSON 백업 파일을 다운로드했습니다.', tone: 'plus' });
}

function openSettingsDialog() {
  const dialog = document.getElementById('settings-dialog');
  const form = document.getElementById('settings-form');
  if (!dialog || !form) return;

  const info = store.getState().classInfo;
  form.elements.className.value = info.name || '';
  form.elements.motto.value = info.motto || '';
  form.elements.starsPerEgg.value = info.starsPerEgg || 10;
  form.elements.soundEnabled.value = String(info.soundEnabled !== false);
  dialog.hidden = false;
}

function closeSettingsDialog() {
  const dialog = document.getElementById('settings-dialog');
  if (dialog) dialog.hidden = true;
}

async function bootstrap() {
  await store.init();
  setActiveModeProvider(() => currentMode);
  setStudentsNavigator((mode, opts) => switchMode(mode, opts));

  // 상태 변경 구독
  store.subscribe(() => {
    renderChrome();
    renderCurrentView();
  });

  // 다른 탭에서 온 실시간 동기화 이벤트
  store.onRemoteSync((ev) => {
    if (ev.kind === 'restored') {
      showToast({ title: '다른 탭에서 백업이 복원되어 화면을 동기화했습니다.' });
    } else if (ev.kind === 'score' || ev.kind === 'egg') {
      presentOutcome(ev);
    }
  });

  // 좌측 사이드바 & 상단 탭 바인딩
  document.querySelectorAll('.rail-btn[data-mode]').forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.mode === 'picker') setPickerSubTool('hub');
      switchMode(btn.dataset.mode);
    };
  });
  document.querySelectorAll('.header-tab[data-quick-tab]').forEach((tab) => {
    tab.onclick = () => switchMode(tab.dataset.quickTab);
  });

  document.getElementById('btn-home').onclick = () => switchMode('students');
  document.getElementById('btn-class-title').onclick = openSettingsDialog;
  document.getElementById('btn-header-settings').onclick = openSettingsDialog;
  document.getElementById('btn-rail-settings').onclick = openSettingsDialog;

  // 최상단 헤더 표시 옵션 바인딩 (번호/아바타/점수표시/정렬)
  const hdrNum = document.getElementById('hdr-show-numbers');
  if (hdrNum) {
    hdrNum.onchange = () => store.update((s) => { s.uiPrefs.showNumbers = hdrNum.checked; });
  }
  const hdrAva = document.getElementById('hdr-show-avatars');
  if (hdrAva) {
    hdrAva.onchange = () => store.update((s) => {
      if (currentMode === 'seats') s.uiPrefs.seatShowAvatars = hdrAva.checked;
      else s.uiPrefs.showAvatars = hdrAva.checked;
    });
  }
  const hdrScore = document.getElementById('hdr-score-mode');
  if (hdrScore) {
    hdrScore.onchange = () => store.update((s) => { s.uiPrefs.scoreDisplayMode = hdrScore.value; });
  }
  const hdrSort = document.getElementById('hdr-sort-by');
  if (hdrSort) {
    hdrSort.onchange = () => store.update((s) => { s.uiPrefs.sortBy = hdrSort.value; });
  }

  // 소리 토글
  document.getElementById('btn-sound').onclick = async () => {
    const next = !(store.getState().classInfo.soundEnabled !== false);
    await store.update((s) => { s.classInfo.soundEnabled = next; });
    if (next) playSound('confirm');
    showToast({ title: next ? '🔊 효과음을 켰습니다.' : '🔇 효과음을 껐습니다.' });
  };

  // 화면 가리기 커튼
  const curtain = document.getElementById('screen-curtain');
  const curtainBtn = document.getElementById('btn-curtain');
  const toggleCurtain = (show) => {
    curtain.hidden = !show;
    curtainBtn.setAttribute('aria-pressed', String(show));
  };
  curtainBtn.onclick = () => toggleCurtain(curtain.hidden);
  document.getElementById('btn-curtain-off').onclick = () => toggleCurtain(false);

  // 백업 / 복원
  const fileInput = document.getElementById('restore-file-input');
  document.getElementById('btn-backup').onclick = triggerBackupDownload;
  document.getElementById('btn-settings-backup').onclick = triggerBackupDownload;
  document.getElementById('btn-restore').onclick = () => fileInput.click();
  document.getElementById('btn-settings-restore').onclick = () => fileInput.click();

  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      await store.importBackupJson(text);
      playSound('successSmall');
      showToast({ title: '백업 파일 복원이 완료되었습니다!', tone: 'plus' });
      closeSettingsDialog();
    } catch (err) {
      showToast({ title: '복원 실패', detail: err.message, tone: 'minus' });
    }
  };

  // 샘플 데이터 초기화
  document.getElementById('btn-reset-demo').onclick = async () => {
    if (!confirm('현재 데이터를 모두 지우고 기본 샘플 학급 데이터로 되돌릴까요?')) return;
    await store.resetToDemo();
    playSound('confirm');
    showToast({ title: '기본 샘플 데이터로 초기화했습니다.' });
    closeSettingsDialog();
  };

  // 설정 저장
  const settingsDialog = document.getElementById('settings-dialog');
  settingsDialog.onclick = (e) => { if (e.target === settingsDialog) closeSettingsDialog(); };
  settingsDialog.querySelectorAll('[data-close-dialog]').forEach((b) => {
    b.onclick = closeSettingsDialog;
  });
  document.getElementById('settings-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await store.update((s) => {
      s.classInfo.name = String(fd.get('className') || '우리 반').trim();
      s.classInfo.motto = String(fd.get('motto') || '').trim();
      s.classInfo.starsPerEgg = Math.max(5, Math.min(30, Number(fd.get('starsPerEgg')) || 10));
      s.classInfo.soundEnabled = fd.get('soundEnabled') === 'true';
    });
    playSound('confirm');
    closeSettingsDialog();
    showToast({ title: '학급 설정을 저장했습니다.', tone: 'plus' });
  };

  renderChrome();
  switchMode('students');
}

bootstrap();
