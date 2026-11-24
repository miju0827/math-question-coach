// 외부 서비스 호출: 받아쓰기(OpenAI)와 분석(Claude).
// API 키는 이 기기의 localStorage에만 저장되며, 학생 실명은 보내지 않고 학생 번호만 보냅니다.

export const THINKING_TAGS = [
  '개념 이해', '문제 해석', '식 세우기', '전략 선택', '계산과 절차',
  '추론과 증명', '도형과 공간 감각', '그래프와 표 해석', '학습 태도와 메타인지',
];

const DEFAULT_SETTINGS = {
  openaiKey: '',
  anthropicKey: '',
  sttModel: 'gpt-transcribe',
  claudeModel: 'claude-opus-5-5',
  effort: 'medium',
  vocab: '원뿔대, 원기둥, 부채꼴, 이차함수, 일차함수, 기울기, 절편, 꼭짓점, 판별식, 근의 공식, 인수분해, 연립방정식, 부등식, 피타고라스, 삼각비, 사인, 코사인, 탄젠트, 수열, 등차수열, 등비수열, 시그마, 극한, 미분, 적분, 도함수, 로그, 지수, 확률, 경우의 수, 순열, 조합, 벡터, 집합, 명제',
  keepAudio: false,
};

export function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('qc-settings') || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
export function saveSettings(s) { localStorage.setItem('qc-settings', JSON.stringify(s)); }

function extFor(type) {
  if (!type) return 'webm';
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  return 'webm';
}

// ---------- 받아쓰기 ----------
export async function transcribe(blob, settings) {
  if (!settings.openaiKey) throw new Error('설정에서 OpenAI API 키를 먼저 입력해 주세요.');
  const send = async (withPrompt) => {
    const fd = new FormData();
    fd.append('file', blob, 'question.' + extFor(blob.type));
    fd.append('model', settings.sttModel);
    fd.append('language', 'ko');
    fd.append('response_format', 'json');
    if (withPrompt && settings.vocab) {
      fd.append('prompt', '학원에서 선생님과 학생이 수학 문제에 대해 나누는 대화입니다. 자주 나오는 용어: ' + settings.vocab);
    }
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.openaiKey },
      body: fd,
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = null; }
    if (!res.ok) {
      const msg = data?.error?.message || text || res.statusText;
      const err = new Error(`받아쓰기 실패 (${res.status}): ${msg}`);
      err.status = res.status; err.apiMessage = msg;
      throw err;
    }
    return (data?.text ?? '').trim();
  };
  try {
    return await send(true);
  } catch (e) {
    // 모델이 prompt를 지원하지 않으면 용어 힌트 없이 한 번 더 시도
    if (e.status === 400 && /prompt/i.test(e.apiMessage || '')) return await send(false);
    throw e;
  }
}

// ---------- 분석 ----------
const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'unit', 'weaknesses', 'teacher_supplied', 'attitude', 'teaching', 'practice_steps', 'tags', 'unclear', 'confidence'],
  properties: {
    summary: { type: 'string', description: '학생이 무엇을 질문했고 어디서 막혔는지 한두 문장' },
    unit: { type: 'string', description: '추정 단원. 예: 중2 일차함수의 그래프' },
    weaknesses: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['point', 'evidence', 'explanation'],
        properties: {
          point: { type: 'string', description: '약점 한 문장' },
          evidence: { type: 'string', description: '근거가 되는 학생의 실제 말 그대로 인용' },
          explanation: { type: 'string', description: '그 말에서 왜 이 약점이 드러나는지' },
        },
      },
    },
    teacher_supplied: { type: 'array', items: { type: 'string' }, description: '학생이 스스로 하지 못하고 선생님이 대신 말해 준 것' },
    attitude: { type: 'string', description: '말하는 태도와 참여 방식. 짧은 대답, 머뭇거림, 말 비중 등' },
    teaching: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['method', 'how'],
        properties: {
          method: { type: 'string', description: '티칭 방식 이름 한 줄' },
          how: { type: 'string', description: '선생님이 그대로 쓸 수 있는 발문, 활동, 자료' },
        },
      },
    },
    practice_steps: { type: 'array', items: { type: 'string' }, description: '쉬운 것부터 단계별 연습 문제 유형' },
    tags: { type: 'array', items: { type: 'string', enum: THINKING_TAGS } },
    unclear: { type: 'string', description: '녹음에서 알아듣기 어려웠던 부분. 없으면 빈 문자열' },
    confidence: { type: 'string', enum: ['높음', '보통', '낮음'] },
  },
};

const SYSTEM_PROMPT = `당신은 초5~고3 수학 개별 교습 학원의 선생님을 돕는 학습 코치입니다.
학생이 선생님에게 질문하러 와서 나눈 대화를 받아쓴 글을 읽고, 학생의 약점과 선생님이 쓸 티칭 방식을 정리합니다.

원칙:
1. 카테고리에 끼워 맞추지 말고, 학생이 실제로 한 말과 단어를 근거로 약점을 짚으세요. 약점마다 학생의 말을 그대로 인용하세요.
2. 받아쓰기에는 화자 구분이 없습니다. 내용으로 선생님 말과 학생 말을 구분하세요. 확실하지 않으면 그렇다고 쓰세요.
3. 학생이 스스로 한 것과 선생님이 대신 말해 준 것을 구분하세요. 선생님이 알려 준 부분은 학생이 혼자 할 수 있는지 아직 확인되지 않은 것입니다.
4. 말하는 태도도 보세요: 머뭇거림, 짧은 대답, "네/오케이요"로 끝내기, 선생님과 학생의 말 비중.
5. 티칭 방식은 선생님이 다음 수업에서 그대로 던질 수 있는 구체적인 질문 문장, 실물이나 그림 같은 활동, 질문 후 기다리기 같은 방법으로 제안하세요. 2~4개.
6. 단계별 연습은 쉬운 것부터 3~4단계로, 같은 아이디어가 다른 문제로 이어지도록 짜세요.
7. tags는 보조 분류입니다. 정말 해당하는 것만 0~2개 고르세요.
8. 받아쓰기가 짧거나 알아듣기 어려우면 들은 부분만으로 판단하고, unclear에 적고, confidence를 낮추세요. 지어내지 마세요.
9. 이전 기록이 주어지면 반복되는 약점인지 짚어 주세요.
10. 모든 내용은 한국어로, 선생님에게 말하듯 짧고 분명한 문장으로 쓰세요.`;

let sdkPromise;
function loadSdk() {
  if (!sdkPromise) sdkPromise = import('./vendor/anthropic-sdk.js');
  return sdkPromise;
}

export async function analyze({ transcript, studentCode, grade, level, history }, settings) {
  if (!settings.anthropicKey) throw new Error('설정에서 Anthropic(Claude) API 키를 먼저 입력해 주세요.');
  if (!transcript || transcript.length < 5) throw new Error('받아쓴 내용이 너무 짧아서 분석할 수 없어요.');
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true });

  const historyText = history && history.length
    ? history.map(h => `- ${h.date} ${h.unit || ''}: ${h.points.join(' / ')}`).join('\n')
    : '(이전 기록 없음)';
  const userText = `학생: ${studentCode} (${grade}${level ? ', 현재 진도 ' + level : ''})

이 학생의 최근 기록:
${historyText}

오늘 대화 받아쓰기:
"""
${transcript}
"""`;

  const response = await client.beta.messages.stream({
    model: settings.claudeModel,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    output_config: {
      effort: settings.effort,
      format: { type: 'json_schema', schema: ANALYSIS_SCHEMA },
    },
    messages: [{ role: 'user', content: userText }],
  }).finalMessage();

  if (response.stop_reason === 'refusal') throw new Error('분석 요청이 거절되었어요. 받아쓴 내용을 확인해 주세요.');
  if (response.stop_reason === 'max_tokens') throw new Error('분석 결과가 너무 길어 중간에 끊겼어요. 다시 시도해 주세요.');
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(text); }
  catch { throw new Error('분석 결과를 읽지 못했어요. 다시 시도해 주세요.'); }
}

export function explainError(e) {
  const m = String(e?.message || e);
  if (/Invalid bearer token|OAuth/i.test(m)) return m + '\n→ 설정의 Anthropic 키가 API 키가 아니에요. sk-ant-api03- 으로 시작하는 키를 console.anthropic.com에서 새로 만들어 넣어 주세요.';
  if (/401|authentication|invalid.*key|Incorrect API key/i.test(m)) return m + '\n→ API 키가 맞는지 설정에서 확인해 주세요.';
  if (/429|rate|quota|insufficient|credit/i.test(m)) return m + '\n→ 사용 한도나 충전 잔액을 확인해 주세요.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return m + '\n→ 인터넷 연결을 확인해 주세요.';
  return m;
}

// ---------- 하루 리포트 ----------
const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'students'],
  properties: {
    overview: {
      type: 'object', additionalProperties: false,
      required: ['common_patterns', 'watch_list', 'teacher_note'],
      properties: {
        common_patterns: { type: 'array', items: { type: 'string' }, description: '오늘 여러 학생에게서 공통으로 보인 약점이나 질문 경향' },
        watch_list: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['student', 'reason'],
            properties: { student: { type: 'string', description: '학생 번호' }, reason: { type: 'string' } } },
          description: '눈여겨볼 학생과 이유. 같은 약점이 반복되거나 상태가 나빠진 경우',
        },
        teacher_note: { type: 'string', description: '선생님에게 오늘 전체를 두고 하는 한두 문장 조언' },
      },
    },
    students: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['student', 'today_questions', 'repeated_weaknesses', 'how_stuck', 'next_class', 'compared_to_before'],
        properties: {
          student: { type: 'string', description: '학생 번호' },
          today_questions: { type: 'array', items: { type: 'string' } },
          repeated_weaknesses: { type: 'array', items: { type: 'string' }, description: '근거가 된 학생 말 인용을 포함' },
          how_stuck: { type: 'string', description: '이 학생이 막히는 방식 한두 문장' },
          next_class: { type: 'array', items: { type: 'string' }, description: '다음 수업에서 선생님이 할 구체적 지도 2~3개' },
          compared_to_before: { type: 'string', description: '이전 기록과 비교한 변화. 이전 기록이 없으면 빈 문자열' },
        },
      },
    },
  },
};

const REPORT_PROMPT = `당신은 초5~고3 수학 개별 교습 학원의 선생님을 돕는 학습 코치입니다.
하루 동안 학생들이 질문하러 와서 나눈 대화의 분석 기록을 모아 선생님용 하루 리포트를 씁니다.

원칙:
1. 학생마다 오늘 질문, 반복되는 약점, 막히는 방식, 다음 수업 지도 방향을 정리하세요.
2. 약점은 분석 기록에 있는 학생의 실제 말 인용을 근거로 짧게 붙이세요. 새로운 인용을 지어내지 마세요.
3. 이전 2주 기록이 있으면 같은 약점이 반복되는지, 나아졌는지 비교하세요.
4. 다음 수업 지도는 선생님이 그대로 쓸 수 있는 발문, 활동, 연습 순서로 2~3개.
5. 학생은 학생 번호로만 부르세요. 선생님 메모가 있으면 분석보다 메모를 우선하세요.
6. 한국어로, 짧고 분명한 문장으로 쓰세요.`;

export async function dailyReport({ day, items }, settings) {
  if (!settings.anthropicKey) throw new Error('설정에서 Anthropic(Claude) API 키를 먼저 입력해 주세요.');
  const { default: Anthropic } = await loadSdk();
  const client = new Anthropic({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true });
  const userText = `날짜: ${day}

학생별 기록 (JSON):
${JSON.stringify(items, null, 1)}`;
  const response = await client.beta.messages.stream({
    model: settings.claudeModel,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: REPORT_PROMPT,
    output_config: { effort: settings.effort, format: { type: 'json_schema', schema: REPORT_SCHEMA } },
    messages: [{ role: 'user', content: userText }],
  }).finalMessage();
  if (response.stop_reason === 'refusal') throw new Error('리포트 요청이 거절되었어요.');
  if (response.stop_reason === 'max_tokens') throw new Error('리포트가 너무 길어 중간에 끊겼어요. 다시 시도해 주세요.');
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  try { return JSON.parse(text); }
  catch { throw new Error('리포트 결과를 읽지 못했어요. 다시 시도해 주세요.'); }
}
