// 워크시트(배경지 + 경량 학생 답변 벡터/텍스트) 실시간 합성 · 문항별 영역 크롭 렌더러 · 도구 제한 지원 학생 에디터

export const WORKSHEET_W = 1200;
export const WORKSHEET_H = 850;

export const BUILTIN_BACKGROUNDS = [
  { id: 'blank', label: '백지' },
  { id: 'lined', label: '줄노트' },
  { id: 'grid', label: '모눈종이' },
  { id: 'manuscript', label: '원고지' },
];

export const DEFAULT_ALLOWED_TOOLS = {
  pen: true,
  highlighter: true,
  text: true,
  eraser: true,
  photo: false,
};

const imageCache = new Map();

/** 이미지 로드 + 캐시 (구글 드라이브 링크 및 DataURL 지원) */
export function loadBgImage(url) {
  if (!url) return Promise.resolve(null);
  if (imageCache.has(url)) return imageCache.get(url);
  const promise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  imageCache.set(url, promise);
  return promise;
}

/** 내장 기본 배경지 그리기 */
export function drawBuiltinBackground(ctx, presetId, w = WORKSHEET_W, h = WORKSHEET_H) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  if (presetId === 'lined') {
    ctx.strokeStyle = '#cfe0f5';
    ctx.lineWidth = 1.5;
    for (let y = 80; y < h - 30; y += 44) {
      ctx.beginPath();
      ctx.moveTo(40, y);
      ctx.lineTo(w - 40, y);
      ctx.stroke();
    }
    ctx.strokeStyle = '#f2b8b8';
    ctx.beginPath();
    ctx.moveTo(100, 30);
    ctx.lineTo(100, h - 30);
    ctx.stroke();
  } else if (presetId === 'grid') {
    ctx.strokeStyle = '#e1ebf5';
    ctx.lineWidth = 1;
    for (let x = 40; x <= w - 40; x += 36) {
      ctx.beginPath();
      ctx.moveTo(x, 40);
      ctx.lineTo(x, h - 40);
      ctx.stroke();
    }
    for (let y = 40; y <= h - 40; y += 36) {
      ctx.beginPath();
      ctx.moveTo(40, y);
      ctx.lineTo(w - 40, y);
      ctx.stroke();
    }
  } else if (presetId === 'manuscript') {
    const cols = 20;
    const rows = 10;
    const marginX = 56;
    const marginY = 58;
    const cellW = (w - marginX * 2) / cols;
    const cellH = (h - marginY * 2) / rows;
    ctx.strokeStyle = '#6db889';
    ctx.lineWidth = 1.2;
    for (let r = 0; r < rows; r++) {
      const y = marginY + r * cellH;
      const boxH = cellH * 0.76;
      for (let c = 0; c < cols; c++) {
        ctx.strokeRect(marginX + c * cellW, y, cellW, boxH);
      }
    }
  }
  ctx.restore();
}

/** 학생 답변 레이어(벡터 스트로크 + 텍스트 상자) 그리기 */
export function drawAnswerLayer(ctx, answerLayer, w = WORKSHEET_W, h = WORKSHEET_H) {
  if (!answerLayer) return;
  const strokes = Array.isArray(answerLayer.strokes) ? answerLayer.strokes : [];
  const texts = Array.isArray(answerLayer.texts) ? answerLayer.texts : [];

  ctx.save();
  for (const s of strokes) {
    const pts = Array.isArray(s.points) ? s.points : [];
    if (pts.length === 0) continue;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = s.color || '#1f2937';
    ctx.lineWidth = Number(s.size) || 4;
    ctx.globalAlpha = s.tool === 'highlighter' ? 0.36 : 1;
    ctx.beginPath();
    ctx.moveTo(pts[0][0] * w, pts[0][1] * h);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0] * w, pts[i][1] * h);
    }
    if (pts.length === 1) {
      ctx.lineTo(pts[0][0] * w + 0.5, pts[0][1] * h + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  for (const t of texts) {
    const content = String(t.text || '');
    if (!content) continue;
    ctx.save();
    const fontSize = Math.max(14, Math.min(72, Number(t.size) || 26));
    ctx.font = `700 ${fontSize}px "Malgun Gothic", "Noto Sans KR", sans-serif`;
    ctx.fillStyle = t.color || '#111827';
    ctx.textBaseline = 'top';
    const x = (Number(t.x) || 0) * w;
    const y = (Number(t.y) || 0) * h;
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      ctx.fillText(line, x, y + idx * (fontSize * 1.28));
    });
    ctx.restore();
  }
  ctx.restore();
}

/** 배경지 + 학생 답변 레이어 실시간 전체 합성 렌더링 */
export async function renderWorksheetComposite(canvas, template, answerLayer) {
  if (!canvas) return;
  const w = Number(template?.width) || WORKSHEET_W;
  const h = Number(template?.height) || WORKSHEET_H;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  if (template?.imageUrl) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    const img = await loadBgImage(template.imageUrl);
    if (img) {
      // 비율 유지하며 캔버스에 맞춤
      const ratio = Math.min(w / img.width, h / img.height);
      const dw = img.width * ratio;
      const dh = img.height * ratio;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    } else {
      drawBuiltinBackground(ctx, template.preset || 'blank', w, h);
    }
  } else {
    drawBuiltinBackground(ctx, template?.preset || 'blank', w, h);
  }

  drawAnswerLayer(ctx, answerLayer, w, h);
}

/**
 * 문항별 영역 크롭 렌더링:
 * 배경지 + 학생 답변을 합성한 뒤 지정된 정규화 영역(box: { x, y, w, h })만 잘라 targetCanvas에 표시
 */
export async function renderCroppedRegion(targetCanvas, template, answerLayer, box) {
  if (!targetCanvas || !box) return;
  const full = document.createElement('canvas');
  await renderWorksheetComposite(full, template, answerLayer);

  const sx = Math.max(0, Math.round(box.x * full.width));
  const sy = Math.max(0, Math.round(box.y * full.height));
  const sw = Math.max(20, Math.round(box.w * full.width));
  const sh = Math.max(20, Math.round(box.h * full.height));

  const maxOutW = 460;
  const scale = Math.min(1, maxOutW / sw);
  targetCanvas.width = Math.max(60, Math.round(sw * scale));
  targetCanvas.height = Math.max(40, Math.round(sh * scale));

  const ctx = targetCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  ctx.drawImage(full, sx, sy, sw, sh, 0, 0, targetCanvas.width, targetCanvas.height);
}

/**
 * 도구 제한 지원 인터랙티브 워크시트 에디터 마운트 (학생용 제출 화면)
 * 배경지는 잠금 고정, 허용된 도구만 툴바 노출, 배경지 없이 답변 JSON만 반환
 */
export function mountWorksheetEditor(hostEl, { template, allowedTools = DEFAULT_ALLOWED_TOOLS, initialAnswer = null, readOnly = false, onChange = null } = {}) {
  const tools = { ...DEFAULT_ALLOWED_TOOLS, ...(allowedTools || {}) };
  const answer = {
    strokes: Array.isArray(initialAnswer?.strokes) ? structuredClone(initialAnswer.strokes) : [],
    texts: Array.isArray(initialAnswer?.texts) ? structuredClone(initialAnswer.texts) : [],
  };
  const undoStack = [];
  const redoStack = [];

  const availableTools = [];
  if (tools.pen) availableTools.push({ id: 'pen', label: '✏️ 펜' });
  if (tools.highlighter) availableTools.push({ id: 'highlighter', label: '🖍️ 형광펜' });
  if (tools.text) availableTools.push({ id: 'text', label: '🔤 텍스트' });
  if (tools.eraser) availableTools.push({ id: 'eraser', label: '🧽 지우개' });

  let activeTool = availableTools[0]?.id || null;
  let activeColor = '#1f2937';
  let activeSize = 4;
  let drawing = false;
  let activeStroke = null;

  const colors = ['#1f2937', '#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#9333ea'];

  hostEl.innerHTML = `
    <div class="ws-editor">
      ${!readOnly ? `
        <div class="ws-toolbar">
          <div class="ws-tool-group">
            ${availableTools.length === 0
              ? `<span class="ws-no-tool">허용된 필기 도구가 없습니다</span>`
              : availableTools.map((t) => `
                  <button type="button" class="ws-tool-btn ${activeTool === t.id ? 'is-active' : ''}" data-ws-tool="${t.id}">${t.label}</button>
                `).join('')}
          </div>
          ${availableTools.length > 0 ? `
            <div class="ws-color-group">
              ${colors.map((c) => `
                <button type="button" class="ws-color-dot ${activeColor === c ? 'is-active' : ''}" data-ws-color="${c}" style="background:${c};" aria-label="색상 ${c}"></button>
              `).join('')}
            </div>
            <label class="ws-size-wrap">
              <span>크기</span>
              <input type="range" id="ws-size-range" min="2" max="24" value="${activeSize}">
            </label>
            <div class="ws-action-group">
              <button type="button" class="ws-act-btn" id="ws-undo" title="실행 취소">↶ 취소</button>
              <button type="button" class="ws-act-btn" id="ws-redo" title="다시 실행">↷ 다시</button>
              <button type="button" class="ws-act-btn is-danger" id="ws-clear" title="내 답변 지우기">초기화</button>
            </div>
          ` : ''}
        </div>
      ` : ''}
      <div class="ws-canvas-wrap">
        <canvas class="ws-canvas" id="ws-canvas"></canvas>
      </div>
    </div>
  `;

  const canvas = hostEl.querySelector('#ws-canvas');

  const pushUndo = () => {
    undoStack.push(structuredClone(answer));
    if (undoStack.length > 40) undoStack.shift();
    redoStack.length = 0;
  };

  const redraw = async () => {
    await renderWorksheetComposite(canvas, template, answer);
    if (typeof onChange === 'function') onChange(structuredClone(answer));
  };

  redraw();

  if (!readOnly && availableTools.length > 0) {
    hostEl.querySelectorAll('[data-ws-tool]').forEach((btn) => {
      btn.onclick = () => {
        activeTool = btn.dataset.wsTool;
        if (activeTool === 'highlighter' && activeSize < 14) {
          activeSize = 18;
          const rng = hostEl.querySelector('#ws-size-range');
          if (rng) rng.value = '18';
        } else if (activeTool === 'pen' && activeSize > 12) {
          activeSize = 4;
          const rng = hostEl.querySelector('#ws-size-range');
          if (rng) rng.value = '4';
        }
        hostEl.querySelectorAll('[data-ws-tool]').forEach((b) => b.classList.toggle('is-active', b.dataset.wsTool === activeTool));
      };
    });

    hostEl.querySelectorAll('[data-ws-color]').forEach((btn) => {
      btn.onclick = () => {
        activeColor = btn.dataset.wsColor;
        hostEl.querySelectorAll('[data-ws-color]').forEach((b) => b.classList.toggle('is-active', b.dataset.wsColor === activeColor));
      };
    });

    const sizeRange = hostEl.querySelector('#ws-size-range');
    if (sizeRange) {
      sizeRange.oninput = () => { activeSize = Number(sizeRange.value) || 4; };
    }

    hostEl.querySelector('#ws-undo').onclick = () => {
      if (undoStack.length === 0) return;
      redoStack.push(structuredClone(answer));
      const prev = undoStack.pop();
      answer.strokes = prev.strokes;
      answer.texts = prev.texts;
      redraw();
    };
    hostEl.querySelector('#ws-redo').onclick = () => {
      if (redoStack.length === 0) return;
      undoStack.push(structuredClone(answer));
      const next = redoStack.pop();
      answer.strokes = next.strokes;
      answer.texts = next.texts;
      redraw();
    };
    hostEl.querySelector('#ws-clear').onclick = () => {
      if (!confirm('내가 작성한 필기와 텍스트를 모두 지울까요? (배경지는 유지됩니다)')) return;
      pushUndo();
      answer.strokes = [];
      answer.texts = [];
      redraw();
    };

    const getNormPos = (ev) => {
      const rect = canvas.getBoundingClientRect();
      return [
        Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)),
        Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height)),
      ];
    };

    const eraseAt = (nx, ny) => {
      const radius = 0.028;
      let changed = false;
      const beforeS = answer.strokes.length;
      answer.strokes = answer.strokes.filter((st) =>
        !(st.points || []).some(([px, py]) => Math.hypot(px - nx, py - ny) < radius)
      );
      if (answer.strokes.length !== beforeS) changed = true;

      const beforeT = answer.texts.length;
      answer.texts = answer.texts.filter((t) => Math.hypot((t.x || 0) - nx, (t.y || 0) - ny) > 0.045);
      if (answer.texts.length !== beforeT) changed = true;
      return changed;
    };

    canvas.addEventListener('pointerdown', (ev) => {
      if (!activeTool) return;
      const [nx, ny] = getNormPos(ev);

      if (activeTool === 'text') {
        const val = prompt('입력할 텍스트를 작성하세요:');
        if (val && val.trim()) {
          pushUndo();
          answer.texts.push({
            x: nx,
            y: ny,
            text: val.trim(),
            color: activeColor,
            size: Math.max(18, Math.min(48, activeSize * 4 + 12)),
          });
          redraw();
        }
        return;
      }

      if (activeTool === 'eraser') {
        pushUndo();
        drawing = true;
        canvas.setPointerCapture(ev.pointerId);
        if (eraseAt(nx, ny)) redraw();
        return;
      }

      if (activeTool === 'pen' || activeTool === 'highlighter') {
        pushUndo();
        drawing = true;
        canvas.setPointerCapture(ev.pointerId);
        activeStroke = {
          tool: activeTool,
          color: activeColor,
          size: activeTool === 'highlighter' ? Math.max(16, activeSize) : activeSize,
          points: [[Number(nx.toFixed(4)), Number(ny.toFixed(4))]],
        };
        answer.strokes.push(activeStroke);
        redraw();
      }
    });

    canvas.addEventListener('pointermove', (ev) => {
      if (!drawing) return;
      const [nx, ny] = getNormPos(ev);
      if (activeTool === 'eraser') {
        if (eraseAt(nx, ny)) redraw();
        return;
      }
      if (activeStroke) {
        const last = activeStroke.points[activeStroke.points.length - 1];
        if (!last || Math.hypot(last[0] - nx, last[1] - ny) > 0.0025) {
          activeStroke.points.push([Number(nx.toFixed(4)), Number(ny.toFixed(4))]);
          redraw();
        }
      }
    });

    const stopDraw = () => {
      drawing = false;
      activeStroke = null;
    };
    canvas.addEventListener('pointerup', stopDraw);
    canvas.addEventListener('pointercancel', stopDraw);
  }

  return {
    getAnswer: () => structuredClone(answer),
    redraw,
  };
}
