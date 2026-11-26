// 효과음 재생기 — 원본 9개 MP3 + 무료 효과음(선택 라운드 select_tick.mp3 / 선택 확정 select_win.mp3) + WebAudio 보조음

const SOUND_FILES = {
  plus: 'assets/audio/Plus.MP3',
  plusBig: 'assets/audio/Plus2.MP3',
  minus: 'assets/audio/Minus.MP3',
  minusBig: 'assets/audio/Minus2.MP3',
  eggUp: 'assets/audio/Egg up.MP3',
  eggDown: 'assets/audio/Egg down.MP3',
  confirm: 'assets/audio/Confirm.MP3',
  successSmall: 'assets/audio/Success small.MP3',
  successBig: 'assets/audio/Success orinal.MP3',
  tick: 'assets/audio/select_tick.mp3',
  fanfare: 'assets/audio/select_win.mp3',
  timerAlarm: 'assets/audio/timer_alarm.mp3',
  restoreDone: 'assets/audio/restore_done.mp3',
  pickResult: 'assets/audio/pick_result.mp3',
  cardFlip: 'assets/audio/card_flip.mp3',
  slotDone: 'assets/audio/slot_done.mp3',
  rouletteWin: 'assets/audio/roulette_win.mp3',
  ladderReveal: 'assets/audio/ladder_reveal.mp3',
  ladderTurn: 'assets/audio/select_tick.mp3',
  ladderArrive: 'assets/audio/ladder_reveal.mp3',
};

let soundEnabled = true;
let audioCtx = null;
const preloadedAudios = new Map();

/** 빠른 연속 재생(선택 라운드 틱 등) 시 지연이 없도록 오디오 프리로드 */
function getClonedAudio(src) {
  let base = preloadedAudios.get(src);
  if (!base) {
    base = new Audio(src);
    base.preload = 'auto';
    preloadedAudios.set(src, base);
  }
  const clone = base.cloneNode(true);
  return clone;
}

export function setSoundEnabled(enabled) {
  soundEnabled = Boolean(enabled);
}

export function isSoundEnabled() {
  return soundEnabled;
}

/** MP3 효과음 재생 */
export function playSound(key) {
  if (!soundEnabled) return;
  const src = SOUND_FILES[key];
  if (!src) return;
  try {
    const audio = getClonedAudio(src);
    audio.volume = (key === 'tick' || key === 'ladderTurn') ? 0.78 : 0.88;
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } catch {
    // 브라우저 자동재생 정책 무시
  }
}

function getAudioContext() {
  if (!audioCtx && typeof AudioContext !== 'undefined') {
    audioCtx = new AudioContext();
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/** 룰렛/사다리/선택 라운드 짧은 틱 사운드 */
export function playTick() {
  playSound('tick');
}

/** 타이머 종료 알림음 */
export function playTimerAlarm() {
  if (!soundEnabled) return;
  playSound('timerAlarm');
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    [0, 0.22, 0.44].forEach((offset) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime + offset);
      gain.gain.setValueAtTime(0.18, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.18);
    });
  } catch {
    // 무시
  }
}
