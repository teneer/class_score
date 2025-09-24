import { useEffect, useState, useRef } from 'react';
import { supabase } from './supabaseClient';
import './App.css';
import Groups from './Groups';

// 점수 표시
function ScoreDisplay({ score, highlight, shakeKey }) {
  const str = String(score);
  let tenIdx = (str[0] === "-" ? str.length - 2 : str.length - 2);
  return (
    <div className="score-head-wrap" style={{ position: 'relative', width: "fit-content", margin: '0 auto' }}>
      <h1 className="score-head">
        {[...str].map((ch, i) =>
          <span
            key={i}
            className={i === tenIdx && highlight === "critical" ? "score-critical shake" : ""}
            data-key={i === tenIdx && highlight === "critical" ? shakeKey : undefined}
            style={{ position: 'relative', zIndex: 1 }}
          >{ch}</span>
        )}
      </h1>
    </div>
  );
}

// 점수 조작 컨트롤
function ScoreControls({ input, onAdd, onSub, onChange, onConfirm, working, validInput }) {
  return (
    <div className="ctrls">
      <div className="num-btn-wrap">
        <button className="square-btn plus" onClick={onAdd} disabled={working}><span className="btn-icon">+</span></button>
        <button className="square-btn minus" onClick={onSub} disabled={working}><span className="btn-icon">−</span></button>
      </div>
      <input
        type="text" inputMode="numeric"
        value={input}
        onChange={onChange}
        className="number-input"
        disabled={working}
        maxLength={4}
      />
      <button
        className="confirm-btn"
        onClick={onConfirm}
        disabled={working || !validInput}
      >확인</button>
    </div>
  );
}

// 메뉴 모달(음소거포함)
function MenuModal({ open, onClose, onResetScore, onStop, onUndo, onRedo, muted, onToggleMute }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div style={{ marginBottom: '1em' }}>점수판 옵션</div>
        <button className="modal-btn" onClick={() => { onResetScore(); onClose(); }}>점수 초기화</button>
        <button className="modal-btn" onClick={() => { onStop(); onClose(); }}>실행 중지</button>
        <button className="modal-btn" onClick={() => { onUndo(); onClose(); }}>되돌리기</button>
        <button className="modal-btn" onClick={() => { onRedo(); onClose(); }}>다시 실행</button>
        <button
          className="modal-btn"
          onClick={onToggleMute}
          style={{ color: muted ? '#e1c448' : '#b6bce2' }}
        >{muted ? "🔇 음소거 해제" : "🔊 음소거"}</button>
        <button className="modal-btn cancel" onClick={onClose}>닫기</button>
      </div>
    </div>
  );
}
export default function App() {
  const [score, setScore] = useState(0);
  const [input, setInput] = useState("0");
  const [working, setWorking] = useState(false);
  const [highlight, setHighlight] = useState("");
  const [shakeKey, setShakeKey] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  const lastScore = useRef(0);
  const stepTimeoutRef = useRef(null);
  const stopFlag = useRef(false);

  const CLAMP_MIN = -100, CLAMP_MAX = 100;

  // 현재점수 조회 및 실시간 구독
  useEffect(() => {
    const fetchCurrentScore = async () => {
      const { data } = await supabase
        .from('scores')
        .select('value')
        .eq('is_current', true)
        .single();
      if (data) {
        setScore(data.value);
        lastScore.current = data.value;
      }
    };
    fetchCurrentScore();

    // 점수 변경 구독(Postgres Pub/Sub)
    const subscription = supabase
      .channel('scores-change')
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'scores' },
        async () => {
          const { data } = await supabase
            .from('scores')
            .select('value')
            .eq('is_current', true)
            .single();
          if (data) stepAnimate(lastScore.current, data.value);
        }
      ).subscribe();

    // stop 이벤트 구독
    const stopSub = supabase
      .channel('stop-channel')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'stop_events' },
        async () => {
          stopFlag.current = true;
          if (stepTimeoutRef.current) clearTimeout(stepTimeoutRef.current);
          setWorking(false);
          const { data } = await supabase
            .from('scores').select('value').eq('is_current', true).single();
          if (data) {
            setScore(data.value);
            lastScore.current = data.value;
            setHighlight("");
            setInput("");
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
      supabase.removeChannel(stopSub);
    };
  }, []);
  useEffect(() => { lastScore.current = score; }, [score]);

  function playSound(step) {
    if (mutedRef.current) return;
    try {
      if (step > 0) new Audio('/Sound/Egg up.Mp3').play();
      else if (step < 0) new Audio('/Sound/Egg down.Mp3').play();
    } catch {}
  }

  function stepAnimate(from, to) {
    if (stopFlag.current) {
      stopFlag.current = false;
      setScore(to); setWorking(false); setHighlight(""); setInput("");
      return;
    }
    setWorking(true);
    setHighlight("");
    stopFlag.current = false;

    let diff = to - from;
    let dirn = diff > 0 ? 1 : -1;
    let left = Math.abs(diff);
    let steps = [];
    if (left >= 10) {
      while (left >= 10) { steps.push(10 * dirn); left -= 10; }
      while (left > 0) { steps.push(dirn); left -= 1; }
    } else { while (left > 0) { steps.push(dirn); left -= 1; } }
    let curr = from, idx = 0;
    function next() {
      if (stopFlag.current) { setWorking(false); return; }
      if (idx >= steps.length) {
        setWorking(false); setScore(to); lastScore.current = to; setHighlight("");
        setInput(""); return;
      }
      curr += steps[idx];
      setScore(curr); lastScore.current = curr; playSound(steps[idx]);
      if (Math.abs(steps[idx]) === 10) {
        setHighlight("critical"); setShakeKey(k => k + 1);
        setTimeout(() => setHighlight(""), 220);
      } else { setHighlight(""); }
      idx++;
      stepTimeoutRef.current = setTimeout(next, 500);
    }
    if (steps.length > 0) next();
    else { setWorking(false); }
  }

  // 점수 추가(변경) 시: 모든 row is_current false, 새 row true로 만들기 및 100행 한정 삭제
  async function addNewScoreWithLimit(value) {
    await supabase.from('scores').update({ is_current: false }).eq('is_current', true);
    await supabase.from('scores').insert({ value, is_current: true });
    const { data: rows } = await supabase
      .from('scores')
      .select('id')
      .order('inserted_at', { ascending: false });
    if (rows.length > 100) {
      const idsToDelete = rows.slice(100).map(r => r.id);
      await supabase.from('scores').delete().in('id', idsToDelete);
    }
  }

  async function updateScore() {
    if (working) return;
    let n = parseInt(input, 10);
    if (!input || isNaN(n) || n === 0) return;
    const clamped = Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, n));
    if (n !== clamped) { setInput(String(clamped)); n = clamped; }
    if (n === 0) return;
    setWorking(true);

    // 현재 DB 최신값 기준으로 연산
    const { data: latest } = await supabase
      .from('scores')
      .select('value')
      .eq('is_current', true)
      .single();
    const base = latest?.value ?? 0;
    const value = base + n;
    await addNewScoreWithLimit(value);

    setWorking(false);
  }

  function addInput() {
    if (working) return;
    setInput(i => {
      let next = (parseInt(i, 10) || 0) + 1;
      return String(Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, next)));
    });
  }
  function subInput() {
    if (working) return;
    setInput(i => {
      let next = (parseInt(i, 10) || 0) - 1;
      return String(Math.max(CLAMP_MIN, Math.min(CLAMP_MAX, next)));
    });
  }
  function onInputChange(e) {
    let val = e.target.value;
    if (/^-?\d*$/.test(val)) { setInput(val); }
  }

  // 점수 초기화(글로벌 stop도 함께)
  async function resetScore() {
    setWorking(false);
    await addNewScoreWithLimit(0);
    setScore(0);
    lastScore.current = 0;
    setHighlight("");
    setInput("0");
    await supabase.from('stop_events').insert({ timestamp: Date.now() });
  }

  // 실행 중지(글로벌 stop)
  async function handleStop() {
    setWorking(false);
    if (stepTimeoutRef.current) clearTimeout(stepTimeoutRef.current);
    // 현재 보여지는 점수로 DB에 반영
    await addNewScoreWithLimit(score);
    lastScore.current = score;
    await supabase.from('stop_events').insert({ timestamp: Date.now() });
    setHighlight("");
  }

  // Undo
  async function handleUndo() {
    const { data: curr } = await supabase.from('scores').select('id, inserted_at').eq('is_current', true).single();
    if (!curr) return;
    const { data: prevs } = await supabase
      .from('scores')
      .select('id')
      .lt('inserted_at', curr.inserted_at)
      .order('inserted_at', { ascending: false })
      .limit(1);
    if (!prevs || prevs.length === 0) return;
    await supabase.from('scores').update({ is_current: false }).eq('is_current', true);
    await supabase.from('scores').update({ is_current: true }).eq('id', prevs[0].id);
    const { data } = await supabase.from('scores').select('value').eq('is_current', true).single();
    if (data) { setScore(data.value); }
  }
  // Redo
  async function handleRedo() {
    const { data: curr } = await supabase.from('scores').select('id, inserted_at').eq('is_current', true).single();
    if (!curr) return;
    const { data: nexts } = await supabase
      .from('scores')
      .select('id')
      .gt('inserted_at', curr.inserted_at)
      .order('inserted_at', { ascending: true })
      .limit(1);
    if (!nexts || nexts.length === 0) return;
    await supabase.from('scores').update({ is_current: false }).eq('is_current', true);
    await supabase.from('scores').update({ is_current: true }).eq('id', nexts[0].id);
    const { data } = await supabase.from('scores').select('value').eq('is_current', true).single();
    if (data) { setScore(data.value); }
  }

  const validInput = input && /^-?\d+$/.test(input) && parseInt(input, 10) !== 0;

  return (
    <div className="score-bg" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div className="score-card-area" style={{ marginBottom: '40px' }}>
        <div className="score-card">
          <div style={{ position: 'relative', width: '100%' }}>
            <button className="menu-btn"
              style={{
                position: 'absolute', top: 0, right: 0, padding: '0.23em 0.33em',
                background: 'none', border: 'none', cursor: 'pointer',
                fontSize: '2.1em', color: '#b6bce2'
              }}
              onClick={() => setMenuOpen(true)}>
              <span style={{ letterSpacing: '0.1em' }}>⋮</span>
            </button>
            <ScoreDisplay score={score} highlight={highlight} shakeKey={shakeKey} />
          </div>
          <ScoreControls
            input={input}
            onAdd={addInput} onSub={subInput}
            onChange={onInputChange}
            onConfirm={updateScore}
            working={working} validInput={validInput}
          />
          <MenuModal
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            onResetScore={resetScore}
            onStop={handleStop}
            onUndo={handleUndo}
            onRedo={handleRedo}
            muted={muted}
            onToggleMute={() => setMuted(m => !m)}
          />
        </div>
      </div>

      <div style={{
        width: "100%",
        display: "flex",
        justifyContent: "flex-start",
        marginTop: "0px"
      }}>
        <Groups />
      </div>
    </div>
  );
}
