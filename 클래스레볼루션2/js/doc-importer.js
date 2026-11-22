// 과제 배경지 다중 형식(이미지 · PDF · HWPX 한글문서) 및 다중 페이지(여러 쪽) 변환기

import { uploadFileToDrive, compressImageToDataUrl } from './cloud-sync.js';

const PDFJS_URL = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';
let pdfjsPromise = null;

async function getPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_URL).then((mod) => {
      if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return mod;
    });
  }
  return pdfjsPromise;
}

/** 캔버스를 구글 드라이브(연결 시) 또는 경량 DataURL로 저장 */
async function saveCanvasPage(canvas, { driveBridgeUrl, driveFolderName, assignmentTitle, pageIdx }) {
  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  if (driveBridgeUrl) {
    try {
      const resp = await fetch(dataUrl);
      const blob = await resp.blob();
      const file = new File([blob], `bg_page_${pageIdx + 1}.jpg`, { type: 'image/jpeg' });
      const up = await uploadFileToDrive({
        bridgeUrl: driveBridgeUrl,
        folderName: driveFolderName || '클래스레볼루션2',
        assignmentTitle: assignmentTitle || '배경지_템플릿',
        studentLabel: `TEMPLATE_P${pageIdx + 1}`,
        file,
      });
      return {
        pageIndex: pageIdx,
        imageUrl: up.thumbnailUrl || up.viewUrl,
        width: canvas.width,
        height: canvas.height,
      };
    } catch {
      // 드라이브 실패 시 인라인 DataURL 폴백
    }
  }
  return {
    pageIndex: pageIdx,
    imageUrl: dataUrl,
    width: canvas.width,
    height: canvas.height,
  };
}

/** PDF 파일의 모든 쪽(최대 15쪽)을 고해상도 이미지 페이지 배열로 변환 */
async function convertPdfToPages(file, opts) {
  const pdfjs = await getPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const maxPages = Math.min(15, pdf.numPages);
  const pages = [];

  for (let p = 1; p <= maxPages; p++) {
    const page = await pdf.getPage(p);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.0, 1240 / vp0.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    pages.push(await saveCanvasPage(canvas, { ...opts, pageIdx: p - 1 }));
  }
  return pages;
}

/** 순수 브라우저 내장 ZIP 해제기 (HWPX 읽기용, stored=0 및 deflate=8 지원) */
async function unzipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);
  const entries = new Map();

  // End of Central Directory 탐색
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('올바른 HWPX(ZIP) 파일이 아닙니다.');

  const cdOffset = view.getUint32(eocd + 16, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  let ptr = cdOffset;
  const decoder = new TextDecoder('utf-8');

  for (let n = 0; n < totalEntries; n++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compBytes = bytes.subarray(dataStart, dataStart + compSize);

    let outBytes = null;
    if (method === 0) {
      outBytes = compBytes;
    } else if (method === 8 && typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(compBytes);
      writer.close();
      const buf = await new Response(ds.readable).arrayBuffer();
      outBytes = new Uint8Array(buf);
    }
    if (outBytes) entries.set(name, outBytes);
  }
  return entries;
}

/** HWPX(한글) 문서를 본문 문단·이미지 기반으로 다중 A4 페이지 캔버스 배경지로 변환 */
async function convertHwpxToPages(file, opts) {
  const buf = await file.arrayBuffer();
  const entries = await unzipEntries(buf);
  const decoder = new TextDecoder('utf-8');

  const sectionKeys = Array.from(entries.keys())
    .filter((k) => /^Contents\/section\d+\.xml$/i.test(k))
    .sort();
  if (sectionKeys.length === 0) {
    throw new Error('HWPX 본문(Contents/section0.xml)을 찾을 수 없습니다.');
  }

  const paragraphs = [];
  const parser = new DOMParser();
  for (const key of sectionKeys) {
    const xmlStr = decoder.decode(entries.get(key));
    const doc = parser.parseFromString(xmlStr, 'application/xml');
    const pNodes = doc.getElementsByTagName('*');
    for (let i = 0; i < pNodes.length; i++) {
      const el = pNodes[i];
      if (el.localName === 'p') {
        let line = '';
        const tNodes = el.getElementsByTagName('*');
        for (let j = 0; j < tNodes.length; j++) {
          if (tNodes[j].localName === 't') line += tNodes[j].textContent || '';
        }
        paragraphs.push(line.trim());
      }
    }
  }

  // A4 세로 비율(1200 x 1600) 캔버스에 자동 줄바꿈 + 다중 페이지 분할 렌더링
  const W = 1200;
  const H = 1600;
  const padX = 84;
  const padY = 92;
  const maxW = W - padX * 2;
  const lineH = 42;
  const pages = [];

  const createPageCanvas = () => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 2;
    ctx.strokeRect(32, 32, W - 64, H - 64);
    ctx.fillStyle = '#1f2937';
    ctx.font = '600 24px "Malgun Gothic", "Noto Sans KR", sans-serif';
    ctx.textBaseline = 'top';
    return { canvas: c, ctx };
  };

  let cur = createPageCanvas();
  let y = padY;
  const flushPage = async () => {
    pages.push(await saveCanvasPage(cur.canvas, { ...opts, pageIdx: pages.length }));
    cur = createPageCanvas();
    y = padY;
  };

  const safeParas = paragraphs.length > 0 ? paragraphs : ['(HWPX 문서에서 텍스트를 추출하지 못했습니다. PDF로 저장해 올려 주세요.)'];
  for (const para of safeParas) {
    if (!para) {
      y += Math.round(lineH * 0.6);
      if (y > H - padY - lineH) await flushPage();
      continue;
    }
    let line = '';
    for (const ch of para) {
      const test = line + ch;
      if (cur.ctx.measureText(test).width > maxW && line.length > 0) {
        cur.ctx.fillText(line, padX, y);
        y += lineH;
        line = ch;
        if (y > H - padY - lineH) await flushPage();
      } else {
        line = test;
      }
    }
    if (line) {
      cur.ctx.fillText(line, padX, y);
      y += lineH + 8;
      if (y > H - padY - lineH) await flushPage();
    }
  }

  // 마지막 페이지 저장
  if (y > padY || pages.length === 0) {
    pages.push(await saveCanvasPage(cur.canvas, { ...opts, pageIdx: pages.length }));
  }

  // BinData 내부 이미지가 있으면 추가 페이지로 첨부 (최대 5장)
  const imgKeys = Array.from(entries.keys()).filter((k) => /^BinData\/.+\.(png|jpe?g|gif|webp)$/i.test(k)).slice(0, 5);
  for (const ik of imgKeys) {
    const ext = ik.split('.').pop().toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const blob = new Blob([entries.get(ik)], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, H);
      const r = Math.min((W - 80) / img.width, (H - 80) / img.height);
      const dw = img.width * r;
      const dh = img.height * r;
      ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      pages.push(await saveCanvasPage(c, { ...opts, pageIdx: pages.length }));
    } catch {}
    URL.revokeObjectURL(url);
  }

  return pages;
}

/**
 * 선택한 파일들(이미지 복수 · PDF · HWPX)을 워크시트 다중 페이지 배경지 배열로 변환
 * 반환: [{ pageIndex, imageUrl, width, height }]
 */
export async function importTemplateFiles(fileList, opts = {}) {
  const files = Array.from(fileList || []);
  const allPages = [];

  for (const file of files) {
    const lower = (file.name || '').toLowerCase();
    if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
      const pdfPages = await convertPdfToPages(file, opts);
      for (const p of pdfPages) {
        allPages.push({ ...p, pageIndex: allPages.length });
      }
    } else if (lower.endsWith('.hwpx')) {
      const hwpxPages = await convertHwpxToPages(file, opts);
      for (const p of hwpxPages) {
        allPages.push({ ...p, pageIndex: allPages.length });
      }
    } else if (file.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(lower)) {
      let imageUrl = '';
      if (opts.driveBridgeUrl) {
        const up = await uploadFileToDrive({
          bridgeUrl: opts.driveBridgeUrl,
          folderName: opts.driveFolderName || '클래스레볼루션2',
          assignmentTitle: opts.assignmentTitle || '배경지_템플릿',
          studentLabel: `TEMPLATE_P${allPages.length + 1}`,
          file,
        });
        imageUrl = up.thumbnailUrl || up.viewUrl;
      } else {
        imageUrl = await compressImageToDataUrl(file, 1400, 0.82);
      }
      allPages.push({
        pageIndex: allPages.length,
        imageUrl,
        width: 1200,
        height: 850,
      });
    }
  }

  return allPages;
}
