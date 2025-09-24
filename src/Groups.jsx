import { useEffect, useState, useRef } from 'react';
import { supabase } from './supabaseClient';

const POINT_COLORS = [
  "#FF7C63", "#FFB266", "#FFD966", "#A8E063", "#63E6A0",
  "#63E3FF", "#63A4FF", "#6B63FF", "#C463FF", "#FF63EA",
  "#FF6394", "#F57842", "#8BD356", "#2ACC82", "#27B6E2",
  "#539CF5", "#7C7DFF", "#B263FF", "#EF63C7", "#E666B7"
];

const colors = {
  accent: "#e74c3c",
  cardBg: "#fff",
  shadow: "rgba(0,0,0,0.10)",
  border: "#bbb",
  selectedBg: "#eafaf1",
};

const CARD_WIDTH = 200;
const CARD_HEIGHT = 120;

const scoreboardStyle = {
  margin: "48px auto 0 auto",
  display: "grid",
  gridTemplateColumns: `repeat(auto-fit, minmax(${CARD_WIDTH}px, 1fr))`,
  gap: "20px",
  width: "100%",
  maxWidth: "100vw",
  padding: "0 12px",
  boxSizing: "border-box",
  justifyItems: "center"
};

const cardCommon = {
  width: `${CARD_WIDTH}px`,
  height: `${CARD_HEIGHT}px`,
  borderRadius: "18px",
  boxShadow: `0 4px 15px ${colors.shadow}`,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  position: "relative",
  margin: "0",
  cursor: "pointer",
  transition: "background 0.27s, transform 0.18s, box-shadow 0.23s"
};

const teamCardStyle = (selected, pointColor) => ({
  ...cardCommon,
  borderTop: `5px solid ${pointColor}`,
  background: selected ? colors.selectedBg : colors.cardBg,
  boxShadow: selected ? "0 10px 30px rgba(80,180,250,0.13)" : cardCommon.boxShadow,
  transform: selected ? "scale(1.045)" : "scale(1)"
});

const addBtnStyle = {
  ...cardCommon,
  border: "2px dashed #bbb",
  borderTop: "4px dashed #bbb",
  color: "#90a7e6",
};

const teamNumberStyle = {
  fontSize: "44px",
  fontWeight: 700, color: "#293a4b",
  display: "flex", alignItems: "center", justifyContent: "center", flex: 1,
  margin: 0,
  transition: "color 0.18s, font-weight 0.22s"
};
const teamNameStyle = {
  fontSize: "19px",
  fontWeight: 500,
  color: "#255", cursor: "pointer", display: "block",
  padding: "2px 8px", borderRadius: "6px",
  whiteSpace: "nowrap", textAlign: "center"
};
const removeBtnStyle = {
  position: "absolute", top: 0, right: 0, zIndex: 2,
  width: "34px", height: "34px",
  background: "rgba(231,76,60,0.13)", color: "#e74c3c", border: "none",
  borderRadius: "0 18px 0 8px", fontWeight: "bold", fontSize: "20px", display: "flex",
  alignItems: "center", justifyContent: "center", boxShadow: "0 1px 4px rgba(0,0,0,0.05)",
  cursor: "pointer", transition: "background 0.18s"
};
const controlsStyle = {
  display: "flex", justifyContent: "center", alignItems: "center", width: "100%",
  marginTop: "10px",
  gap: "11px",
  flexWrap: 'wrap'
};
const selectAllBtnStyle = {
  borderRadius: "8px", fontWeight: 500, fontSize: "18px",
  background: "#e7f1fa", color: "#2980b9", border: "1.5px solid #bbb",
  padding: "4px 12px", cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
  transition: "background 0.17s, color 0.17s"
};

export default function Groups() {
  const [groups, setGroups] = useState([]);
  const [groupScores, setGroupScores] = useState({});
  const [selected, setSelected] = useState([]);
  const [input, setInput] = useState("");
  const [working, setWorking] = useState(false);
  const prevScoresRef = useRef({});
  const [scoreAnim, setScoreAnim] = useState({});

  useEffect(() => {
    fetchGroups();
    const subscription = supabase
      .channel('group_scores-change')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'group_scores' },
        () => { fetchGroups(); }
      )
      .subscribe();
    return () => { subscription.unsubscribe(); };
  }, []);

  async function fetchGroups() {
    const { data: gs } = await supabase.from('groups').select('*').order('created_at');
    setGroups(gs || []);
    if (!gs || gs.length === 0) return setGroupScores({});
    let obj = {};
    for (let g of gs) {
      const { data } = await supabase
        .from('group_scores').select('value').eq('group_id', g.id).eq('is_current', true).single();
      // 점수 없으면 0으로 셋팅
      obj[g.id] = typeof data === "undefined" || data === null ? 0 : (data.value ?? 0);
    }
    setGroupScores(obj);
  }

  useEffect(() => {
    let scoreChanged = false;
    let firstDelta = null;
    for (let groupId in groupScores) {
      const prev = prevScoresRef.current[groupId];
      const next = groupScores[groupId];
      if (typeof prev !== 'undefined' && prev !== next) {
        scoreChanged = true;
        if (firstDelta === null) firstDelta = next - prev;
        setScoreAnim(prevAnim => ({ ...prevAnim, [groupId]: true }));
        setTimeout(() =>
          setScoreAnim(prevAnim => ({ ...prevAnim, [groupId]: false }))
        , 500);
      }
    }
    prevScoresRef.current = { ...groupScores };
    if (scoreChanged) {
      if (firstDelta > 0) new Audio('/Sound/Plus2.MP3').play();
      else if (firstDelta < 0) new Audio('/Sound/Minus2.MP3').play();
    }
  }, [groupScores]);

  async function handleAddGroup() {
    const countRaw = prompt("몇 개의 모둠을 만들까요?");
    const count = Math.max(1, Math.min(20, Number(countRaw) || 0));
    if (!count) return;
    setWorking(true);
    let usedColors = groups.map(g => g.pointColor).filter(Boolean);
    let candidates = POINT_COLORS.filter(c => !usedColors.includes(c));
    const pool = candidates.length >= count ? candidates : POINT_COLORS;
    const groupsToAdd = [];
    for (let i = 0; i < count; i++) {
      let pointColor = pool[Math.floor(Math.random() * pool.length)];
      let name = `${groups.length + i + 1}모둠`;
      groupsToAdd.push({ name, pointColor });
      pool.length > 1 && (pool.splice(pool.indexOf(pointColor), 1));
    }
    for (const groupObj of groupsToAdd) {
      const { data: g } = await supabase.from('groups').insert(groupObj).select().single();
      // group_scores에 is_current: true row 생성
      if (g) await supabase.from('group_scores').insert({ group_id: g.id, value: 0, is_current: true });
    }
    await fetchGroups();
    setWorking(false);
  }

async function handleDeleteGroup(groupId) {
  if (!window.confirm('정말 모둠을 삭제할까요?')) return;
  setWorking(true);
  // [추가] group_scores 모든 기록 먼저 삭제!
  await supabase.from('group_scores').delete().eq('group_id', groupId);
  // 기존: groups 테이블에서 그룹 row 삭제
  await supabase.from('groups').delete().eq('id', groupId);
  await fetchGroups();
  setSelected(sel => sel.filter(id => id !== groupId));
  setWorking(false);
}


  function handleSelect(groupId) {
    setSelected(sel =>
      sel.includes(groupId) ? sel.filter(id => id !== groupId) : [...sel, groupId]
    );
  }
  function handleSelectAll() { setSelected(groups.map(g => g.id)); }
  function handleUnselectAll() { setSelected([]); }
  function onAdd() { setInput(val => String((parseInt(val) || 0) + 1)); }
  function onSub() { setInput(val => String((parseInt(val) || 0) - 1)); }

  async function handleBatchChange() {
    if (selected.length === 0 || !/^[-]?\d+$/.test(input)) return;
    setWorking(true);
    const diff = Number(input);


    for (let groupId of selected) {
      await supabase.from('group_scores').update({ is_current: false }).eq('group_id', groupId).eq('is_current', true);
      await supabase.from('group_scores').insert({
        group_id: groupId,
        value: (groupScores[groupId] || 0) + diff,
        is_current: true // 반드시 TRUE로!
      });
      const { data: rows } = await supabase.from('group_scores').select('id').eq('group_id', groupId).order('inserted_at', { ascending: false });
      if (rows && rows.length > 100) {
        const idsToDelete = rows.slice(100).map(r => r.id);
        await supabase.from('group_scores').delete().in('id', idsToDelete);
      }
    }
    setWorking(false);
    setInput("");
  }

  return (
    <div>
      <div style={scoreboardStyle}>
        {groups.map(gr => {
          const selectedCard = selected.includes(gr.id);
          const pointColor = gr.pointColor || "#ccc";
          return (
            <div key={gr.id} style={{ position: "relative", margin: 0 }}>
              <div
                style={teamCardStyle(selectedCard, pointColor)}
                onClick={() => handleSelect(gr.id)}
              >
                <button style={removeBtnStyle} title="모둠 삭제"
                  onClick={e => { e.stopPropagation(); handleDeleteGroup(gr.id); }}>×</button>
                <div style={teamNameStyle}>{gr.name}</div>
                {/* 점수 없을 때 0으로 표시! */}
                <div
                  style={{
                    ...teamNumberStyle,
                    color: scoreAnim[gr.id] ? "#e74c3c" : teamNumberStyle.color,
                    fontWeight: scoreAnim[gr.id] ? 800 : teamNumberStyle.fontWeight,
                    transform: scoreAnim[gr.id] ? "scale(1.15)" : "scale(1)",
                    background: scoreAnim[gr.id] ? "#fff2e6" : "none",
                    transition: "all 0.27s"
                  }}>
                  {typeof groupScores[gr.id] === "undefined" ? 0 : groupScores[gr.id]}
                </div>
              </div>
            </div>
          );
        })}
        <div
          style={addBtnStyle}
          onClick={handleAddGroup}
        >
          <span style={{
            textAlign: "center",
            fontSize: "23px",
            lineHeight: 1.4,
            fontWeight: 600
          }}>
            +<br />모둠<br />추가
          </span>
        </div>
      </div>
      <div style={controlsStyle}>
        {selected.length === 0 ?
          <button style={selectAllBtnStyle} onClick={handleSelectAll} disabled={groups.length === 0}>전체 선택</button>
          :
          <button style={{ ...selectAllBtnStyle, background: '#fff', color: '#e74c3c', border: '1.5px solid #e74c3c' }}
            onClick={handleUnselectAll}>선택 취소</button>
        }
        <button onClick={onAdd} disabled={working || groups.length === 0}>+</button>
        <button onClick={onSub} disabled={working || groups.length === 0}>−</button>
        <input
          type="text"
          inputMode="numeric"
          value={input}
          onChange={e => setInput(e.target.value)}
          disabled={working || selected.length === 0}
          maxLength={4}
          style={{
            fontSize: "18px",
            textAlign: "center",
            borderRadius: "8px",
            border: "1.5px solid #bbb",
            width: "60px",
            height: "39px"
          }}
        />
        <button
          onClick={handleBatchChange}
          disabled={working || selected.length === 0 || !/^[-]?\d+$/.test(input)}
          style={{
            borderRadius: 8,
            padding: "0 16px",
            height: "39px",
            fontSize: "18px"
          }}>
          확인
        </button>
        {selected.length > 0 &&
          <span style={{ marginLeft: "8px", fontSize: "13px", color: "#369" }}>
            {selected.length}개 선택됨
          </span>}
      </div>
    </div>
  );
}
