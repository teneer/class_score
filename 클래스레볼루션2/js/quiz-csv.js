// 외부 AI 연동 퀴즈 양식 CSV 생성·다운로드 + 작업 지침 프롬프트 + CSV 파서 + 자동 채점 엔진

/** 외부 AI(ChatGPT, Gemini 등)에 참고자료·양식 CSV와 함께 전달할 기본 작업 지침 프롬프트 */
export const AI_QUIZ_PROMPT = `당신은 초·중등 교실 수업용 평가 문항 출제 전문가입니다.
첨부한 참고자료와 CSV 양식을 바탕으로, 학생용 상호작용 퀴즈를 표준 CSV 형식으로 작성해 주세요.

[출력 규칙]
1. 반드시 아래 11개 열 헤더를 첫 줄에 그대로 유지하세요:
   문항번호,유형,문제내용,보기1,보기2,보기3,보기4,보기5,정답,배점,해설
2. '유형' 열에는 반드시 다음 셋 중 하나만 입력하세요: 객관식 / OX / 단답형
   - 객관식: 보기1~보기4(최대 보기5)에 선택지를 적고, '정답'에는 정답 보기 번호(1~5)만 숫자로 적으세요.
   - OX: 보기1~보기5는 비워 두고, '정답'에는 O 또는 X만 적으세요.
   - 단답형: 보기1~보기5는 비워 두고, '정답'에는 핵심 정답 단어를 적으세요. 유사 정답이 여러 개면 | 로 구분하세요(예: 광합성|식물의 광합성).
3. 문제내용·보기·해설 안에 쉼표(,)가 들어가면 반드시 큰따옴표("...")로 감싸세요.
4. '배점'은 정수(예: 10)로 적고, '해설'은 학생 눈높이에 맞춰 1~2문장으로 친절하게 작성하세요.
5. 추가 설명 없이 바로 CSV 코드 블록만 출력해 주세요.`;

/** 외부 AI 전달용 양식 CSV 문자열 생성 (UTF-8 BOM 포함, 기본 지침 주석 + 3가지 유형 샘플 포함) */
export function buildQuizTemplateCsv() {
  const lines = [
    '# [클래스레볼루션2 AI 퀴즈 양식 CSV]',
    '# 사용법: 이 CSV 파일과 수업 참고자료를 외부 AI(ChatGPT/Gemini 등)에 함께 올리고 아래 지침대로 문항 생성을 요청하세요.',
    '# 지침: 유형은 객관식/OX/단답형 중 선택. 객관식 정답은 번호(1~5), OX 정답은 O/X, 단답형 복수정답은 | 로 구분. 쉼표 포함 문장은 큰따옴표로 감싸기.',
    '문항번호,유형,문제내용,보기1,보기2,보기3,보기4,보기5,정답,배점,해설',
    '1,객관식,"식물이 빛에너지를 이용해 양분을 만드는 과정을 무엇이라고 하나요?",호흡,광합성,증산작용,소화,,2,10,"식물의 잎에 있는 엽록체에서 빛, 물, 이산화탄소를 이용해 양분을 만드는 과정은 광합성입니다."',
    '2,OX,"지구는 하루에 한 바퀴씩 자전한다.",,,,,,O,10,"지구는 자전축을 중심으로 서쪽에서 동쪽으로 하루에 한 바퀴 자전하며 낮과 밤이 생깁니다."',
    '3,단답형,"우리나라에서 한글을 창제하신 조선의 제4대 임금님은 누구인가요?",,,,,,세종대왕|세종|이도,10,"훈민정음(한글)은 조선 제4대 임금인 세종대왕이 백성을 위해 창제하셨습니다."',
  ];
  return '\uFEFF' + lines.join('\r\n');
}

/** 양식 CSV 파일 다운로드 */
export function downloadQuizTemplateCsv() {
  const csv = buildQuizTemplateCsv();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '클래스레볼루션2_AI퀴즈_양식.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/** RFC 4180 호환 CSV 텍스트 파싱 (따옴표 내 쉼표·줄바꿈 처리) */
function parseCsvRows(rawText) {
  const text = String(rawText || '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && next === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** 유형 문자열 정규화 */
function normalizeQuizType(rawType, choices) {
  const t = String(rawType || '').trim().toLowerCase();
  if (t.includes('ox') || t === 'o/x' || t.includes('진위') || t.includes('참거짓')) return 'ox';
  if (t.includes('단답') || t.includes('주관') || t.includes('short')) return 'short';
  if (t.includes('객관') || t.includes('선택') || t.includes('choice') || t.includes('mcq')) return 'choice';
  return choices.length >= 2 ? 'choice' : 'short';
}

/**
 * CSV 텍스트를 표준 퀴즈 문항 배열로 파싱
 * 반환: { questions: QuizQuestion[], errors: string[] }
 */
export function parseQuizCsv(rawText) {
  // 마크다운 코드블록(```csv ... ```)으로 붙여넣은 경우 자동 제거
  const cleaned = String(rawText || '')
    .replace(/```(?:csv)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();

  const rows = parseCsvRows(cleaned).filter((r) => {
    const first = String(r[0] || '').trim();
    if (!first && r.every((c) => !String(c || '').trim())) return false;
    if (first.startsWith('#')) return false;
    return true;
  });

  if (rows.length === 0) {
    return { questions: [], errors: ['CSV 내용이 비어 있습니다.'] };
  }

  // 헤더 행 자동 감지
  let startIdx = 0;
  const headJoined = rows[0].join(',').replace(/\s+/g, '');
  if (headJoined.includes('문제내용') || headJoined.includes('문항번호') || headJoined.includes('정답')) {
    startIdx = 1;
  }

  const questions = [];
  const errors = [];

  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i].map((c) => String(c || '').trim());
    const num = Number(r[0]) || questions.length + 1;
    const rawType = r[1] || '';
    const prompt = r[2] || '';
    const choices = [r[3], r[4], r[5], r[6], r[7]].filter(Boolean);
    const rawAnswer = r[8] || '';
    const points = Math.max(1, Math.min(100, Math.trunc(Number(r[9]) || 10)));
    const explanation = r[10] || '';

    if (!prompt) {
      errors.push(`${i + 1}행: 문제내용이 비어 있어 건너뛰었습니다.`);
      continue;
    }

    const type = normalizeQuizType(rawType, choices);
    let answer = rawAnswer;

    if (type === 'ox') {
      const upper = rawAnswer.toUpperCase();
      answer = upper === 'X' || upper === 'FALSE' || upper === '아니오' || upper === '2' ? 'X' : 'O';
    } else if (type === 'choice') {
      if (choices.length < 2) {
        errors.push(`${num}번 문항: 객관식 보기가 2개 미만입니다.`);
        continue;
      }
      // 정답이 보기 텍스트로 적힌 경우 번호(1~5)로 자동 매핑
      const asNum = Number(rawAnswer);
      if (Number.isInteger(asNum) && asNum >= 1 && asNum <= choices.length) {
        answer = String(asNum);
      } else {
        const matchIdx = choices.findIndex((c) => c === rawAnswer);
        answer = matchIdx >= 0 ? String(matchIdx + 1) : '1';
      }
    }

    questions.push({
      id: `q-${questions.length + 1}`,
      number: questions.length + 1,
      type, // 'choice' | 'ox' | 'short'
      prompt,
      choices: type === 'choice' ? choices : (type === 'ox' ? ['O', 'X'] : []),
      answer,
      points,
      explanation,
    });
  }

  if (questions.length === 0 && errors.length === 0) {
    errors.push('유효한 문항을 찾지 못했습니다. 양식 CSV 형식을 확인해 주세요.');
  }
  return { questions, errors };
}

/** 단답형 비교 정규화 (공백·대소문자·문장부호 완화) */
function normShort(str) {
  return String(str || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

/** 단일 퀴즈 문항 자동 채점 */
export function gradeQuizQuestion(question, studentAnswer) {
  const ans = String(studentAnswer ?? '').trim();
  if (!ans) return { status: 'wrong', score: 0 };

  if (question.type === 'choice') {
    const ok = ans === String(question.answer).trim();
    return { status: ok ? 'correct' : 'wrong', score: ok ? question.points : 0 };
  }
  if (question.type === 'ox') {
    const ok = ans.toUpperCase() === String(question.answer).toUpperCase();
    return { status: ok ? 'correct' : 'wrong', score: ok ? question.points : 0 };
  }
  // 단답형: | 로 구분된 복수 정답 허용
  const accepted = String(question.answer || '')
    .split('|')
    .map(normShort)
    .filter(Boolean);
  const ok = accepted.includes(normShort(ans));
  return { status: ok ? 'correct' : 'wrong', score: ok ? question.points : 0 };
}

/** 전체 퀴즈 자동 채점 */
export function gradeQuizSubmission(questions, answersMap = {}) {
  const questionGrades = {};
  let totalScore = 0;
  let maxScore = 0;
  let correctCount = 0;

  for (const q of questions || []) {
    maxScore += Number(q.points) || 0;
    const res = gradeQuizQuestion(q, answersMap[q.id]);
    questionGrades[q.id] = {
      status: res.status,
      score: res.score,
      maxScore: Number(q.points) || 0,
      feedback: '',
    };
    totalScore += res.score;
    if (res.status === 'correct') correctCount++;
  }

  return { questionGrades, totalScore, maxScore, correctCount };
}
