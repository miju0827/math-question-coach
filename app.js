import { db, uid, dayOf } from './db.js';
import { loadSettings, saveSettings, transcribe, analyze, dailyReport, explainError } from './api.js';

const view = document.getElementById('view');
const titleEl = document.getElementById('title');
const backBtn = document.getElementById('nav-back');
const settingsBtn = document.getElementById('nav-settings');

const GRADES = ['초5', '초6', '중1', '중2', '중3', '고1', '고2', '고3'];
const running = new Set(); // 분석 중인 기록 id

// ---------- 공통 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function timeOf(ts) { const d = new Date(ts); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }
function mmss(sec) { sec = Math.round(sec); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
function setHeader(title, back) {
  titleEl.textContent = title;
  backBtn.hidden = !back;
  backBtn.onclick = back ? () => { location.hash = back; } : null;
}
function go(hash) { location.hash = hash; }
settingsBtn.onclick = () => go('#settings');

async function students() {
  const list = await db.all('students');
  return list.sort((a, b) => GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade) || a.name.localeCompare(b.name, 'ko'));
}
async function nextStudentCode() {
  const list = await db.all('students');
  const n = list.reduce((m, s) => Math.max(m, Number(String(s.code).replace(/\D/g, '')) || 0), 0) + 1;
  return 'S' + String(n).padStart(3, '0');
}

// ---------- 라우터 ----------
let cleanup = null;
async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  const [name, arg] = (location.hash.slice(1) || 'home').split('/');
  window.scrollTo(0, 0);
  try {
    if (name === 'student') await showStudent(arg);
    else if (name === 'record') await showRecord(arg);
    else if (name === 'session') await showSession(arg);
    else if (name === 'settings') showSettings();
    else if (name === 'add') showAddStudent(arg);
    else if (name === 'import') showImport();
    else if (name === 'report') await showReport(arg || dayOf(Date.now()));
    else await showHome();
  } catch (e) {
    console.error(e);
    view.innerHTML = `<div class="err">${esc(explainError(e))}</div>`;
  }
}
window.addEventListener('hashchange', route);

// ---------- 홈 ----------
async function showHome() {
  setHeader('질문 코치');
  const s = loadSettings();
  const list = await students();
  const today = dayOf(Date.now());
  const todays = (await db.byIndex('sessions', 'day', today)).sort((a, b) => b.createdAt - a.createdAt);
  const byId = Object.fromEntries(list.map(x => [x.id, x]));

  view.innerHTML = `
    ${!s.openaiKey || !s.anthropicKey ? `<div class="warn">처음 쓰시나요? <a href="#settings">설정</a>에서 API 키 두 개를 먼저 입력해 주세요.</div>` : ''}
    <h2>누가 질문하러 왔나요?</h2>
    ${list.length ? `<div class="grid">${list.map(st => `
      <button class="student" data-id="${st.id}">${esc(st.name)}<small>${esc(st.grade)}${st.level ? ' · ' + esc(st.level) : ''}</small></button>`).join('')}</div>`
      : `<p class="muted">아직 등록한 학생이 없어요.</p>`}
    <div class="row" style="margin-top:12px"><a class="btn" href="#add">+ 학생 추가</a><a class="btn" href="#import">명단 한꺼번에 넣기</a></div>
    <h2>오늘 기록 <span class="muted">${todays.length}건</span></h2>
    <a class="btn primary block" href="#report/${today}" style="margin-bottom:12px">하루 마감 · 오늘 리포트</a>
    <div class="card">${todays.length ? todays.map(se => `
      <button class="list-item" data-session="${se.id}">
        <strong>${esc(byId[se.studentId]?.name || '삭제된 학생')}</strong> <span class="muted">${timeOf(se.createdAt)} · ${statusText(se)}</span><br>
        <span class="muted">${esc(se.analysis?.summary || '')}</span>
      </button>`).join('') : '<p class="muted">오늘 저장된 질문이 아직 없어요.</p>'}</div>`;

  view.querySelectorAll('[data-id]').forEach(b => b.onclick = () => go('#record/' + b.dataset.id));
  view.querySelectorAll('[data-session]').forEach(b => b.onclick = () => go('#session/' + b.dataset.session));
}
function statusText(se) {
  if (running.has(se.id)) return '분석 중';
  if (se.analysis) return '분석 완료';
  if (se.error) return '오류, 다시 시도 필요';
  return '분석 전';
}

// ---------- 학생 추가/수정 ----------
async function showAddStudent(editId) {
  const editing = editId ? await db.get('students', editId) : null;
  setHeader(editing ? '학생 정보 수정' : '학생 추가', editing ? '#student/' + editId : '#home');
  view.innerHTML = `
    <div class="card">
      <label for="nm">이름</label><input id="nm" autocomplete="off" value="${esc(editing?.name || '')}">
      <label for="gr">학년</label>
      <select id="gr">${GRADES.map(g => `<option ${(editing?.grade || '중1') === g ? 'selected' : ''}>${g}</option>`).join('')}</select>
      <label for="lv">현재 진도 (선택, 예: 중3-1)</label><input id="lv" autocomplete="off" value="${esc(editing?.level || '')}">
      <p class="muted">이름은 이 휴대폰에만 저장되고, 분석할 때는 학생 번호만 보내요.</p>
      <button class="btn primary block" id="save">저장</button>
    </div>`;
  view.querySelector('#nm').focus();
  view.querySelector('#save').onclick = async () => {
    const name = view.querySelector('#nm').value.trim();
    const grade = view.querySelector('#gr').value;
    const level = view.querySelector('#lv').value.trim();
    if (!name) { toast('이름을 입력해 주세요'); return; }
    if (editing) {
      await db.put('students', { ...editing, name, grade, level });
      go('#student/' + editing.id);
    } else {
      await db.put('students', { id: uid('st'), code: await nextStudentCode(), name, grade, level, createdAt: Date.now() });
      toast(name + ' 학생을 추가했어요');
      go('#home');
    }
  };
}

// ---------- 명단 한꺼번에 넣기 ----------
function normGrade(g) {
  g = String(g || '').replace(/\s/g, '');
  let m = g.match(/^(초|중|고)(?:등학교)?(\d)/);
  if (m) return m[1] + m[2];
  return '';
}
function parseRoster(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => {
    const [name, grade, level] = l.split(/[,\t]/).map(x => (x || '').trim());
    return { name, grade: normGrade(grade), level: level || '' };
  }).filter(r => r.name);
}
async function showImport() {
  setHeader('명단 한꺼번에 넣기', '#home');
  view.innerHTML = `
    <div class="card">
      <p style="margin-top:0">한 줄에 한 명씩 <strong>이름, 학년, 진도</strong> 순서로 붙여넣어 주세요. 진도는 비워도 돼요.</p>
      <p class="muted">예: 김민수, 중학교 2학년, 중2-1</p>
      <textarea id="roster" style="min-height:220px" placeholder="김민수, 중2, 중2-1"></textarea>
      <div class="muted" id="preview" style="margin:8px 0"></div>
      <button class="btn primary block" id="go" disabled>가져오기</button>
    </div>`;
  const ta = view.querySelector('#roster'), pv = view.querySelector('#preview'), goBtn = view.querySelector('#go');
  const existing = new Set((await db.all('students')).map(s => s.name));
  const update = () => {
    const rows = parseRoster(ta.value);
    const fresh = rows.filter(r => !existing.has(r.name));
    const bad = fresh.filter(r => !r.grade);
    pv.textContent = rows.length ? `${rows.length}명 중 새로 넣을 학생 ${fresh.length}명` + (rows.length - fresh.length ? `, 이미 있는 이름 ${rows.length - fresh.length}명은 건너뜀` : '') + (bad.length ? `, 학년을 못 읽은 ${bad.length}명은 중1로 넣음` : '') : '';
    goBtn.disabled = !fresh.length;
  };
  ta.addEventListener('input', update);
  goBtn.onclick = async () => {
    goBtn.disabled = true;
    const rows = parseRoster(ta.value).filter(r => !existing.has(r.name));
    for (const r of rows) {
      await db.put('students', { id: uid('st'), code: await nextStudentCode(), name: r.name, grade: r.grade || '중1', level: r.level, createdAt: Date.now() });
      existing.add(r.name);
    }
    toast(`${rows.length}명을 넣었어요`); go('#home');
  };
}

// ---------- 학생 화면 ----------
async function showStudent(id) {
  const st = await db.get('students', id);
  if (!st) { go('#home'); return; }
  setHeader(st.name, '#home');
  const sessions = (await db.byIndex('sessions', 'studentId', id)).sort((a, b) => b.createdAt - a.createdAt);
  const tagCount = {};
  sessions.forEach(se => (se.analysis?.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; }));
  const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]);
  view.innerHTML = `
    <div class="card">
      <div class="row" style="justify-content:space-between"><div><strong>${esc(st.name)}</strong> <span class="muted">${esc(st.grade)}${st.level ? ' · 진도 ' + esc(st.level) : ''} · ${esc(st.code)}</span></div>
      <a class="btn" href="#add/${st.id}">수정</a></div>
      ${tags.length ? `<div style="margin-top:8px">${tags.map(([t, n]) => `<span class="tag">${esc(t)} ${n}</span>`).join('')}</div>` : ''}
    </div>
    <a class="btn primary block" href="#record/${st.id}">질문 녹음하기</a>
    <h2>지난 기록 <span class="muted">${sessions.length}건</span></h2>
    <div class="card">${sessions.length ? sessions.map(se => `
      <button class="list-item" data-session="${se.id}">
        <strong>${se.day}</strong> <span class="muted">${timeOf(se.createdAt)} · ${statusText(se)}</span><br>
        <span class="muted">${esc(se.analysis?.summary || '')}</span>
      </button>`).join('') : '<p class="muted">아직 기록이 없어요.</p>'}</div>
    <button class="btn danger" id="del" style="margin-top:20px">학생 삭제</button>`;
  view.querySelectorAll('[data-session]').forEach(b => b.onclick = () => go('#session/' + b.dataset.session));
  view.querySelector('#del').onclick = async () => {
    const btn = view.querySelector('#del');
    if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = `한 번 더 누르면 ${st.name} 학생과 기록 ${sessions.length}건이 지워져요`; return; }
    for (const se of sessions) { await db.del('sessions', se.id); await db.del('audio', se.id); }
    await db.del('students', id);
    toast('삭제했어요'); go('#home');
  };
}

// ---------- 녹음 ----------
async function showRecord(studentId) {
  const st = await db.get('students', studentId);
  if (!st) { go('#home'); return; }
  setHeader(st.name + ' 질문 녹음', '#home');
  view.innerHTML = `
    <div class="card rec">
      <div class="muted">${esc(st.grade)} · 휴대폰을 학생 쪽에 가깝게 두세요</div>
      <div class="timer" id="timer">0:00</div>
      <div class="meter"><i id="lvl"></i></div>
      <button class="rec-btn" id="rec">녹음 시작</button>
      <div class="muted" id="hint">누르면 녹음이 시작돼요</div>
    </div>
    <div class="card">
      <div class="muted">다른 앱으로 녹음한 파일이 있으면 바로 올릴 수도 있어요.</div>
      <label class="btn" style="margin-top:8px">녹음 파일 올리기<input type="file" accept="audio/*" id="file" hidden></label>
      <a class="btn" href="#student/${st.id}" style="margin-top:8px">지난 기록 보기</a>
    </div>`;

  const recBtn = view.querySelector('#rec');
  const timerEl = view.querySelector('#timer');
  const lvl = view.querySelector('#lvl');
  const hint = view.querySelector('#hint');
  let stream, recorder, chunks = [], startAt = 0, tick, raf, audioCtx, wakeLock;

  const stopAll = () => {
    clearInterval(tick); cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach(t => t.stop());
    if (audioCtx) audioCtx.close().catch(() => {});
    if (wakeLock) wakeLock.release().catch(() => {});
  };
  cleanup = () => { if (recorder && recorder.state === 'recording') { recorder.onstop = null; recorder.stop(); } stopAll(); };

  view.querySelector('#file').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const dur = await audioDuration(f);
    await saveRecording(st, f, dur);
  };

  recBtn.onclick = async () => {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      hint.innerHTML = '<span style="color:var(--danger)">마이크를 쓸 수 없어요. 브라우저의 마이크 권한을 허용해 주세요.</span>';
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : undefined);
    chunks = [];
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      const dur = (Date.now() - startAt) / 1000;
      stopAll();
      const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
      if (dur < 2) { toast('너무 짧아요. 다시 녹음해 주세요'); recBtn.textContent = '녹음 시작'; recBtn.classList.remove('on'); return; }
      await saveRecording(st, blob, dur);
    };
    recorder.start(1000);
    startAt = Date.now();
    recBtn.textContent = '녹음 끝내기'; recBtn.classList.add('on');
    hint.textContent = '대화가 끝나면 다시 눌러 주세요';
    tick = setInterval(() => {
      const sec = (Date.now() - startAt) / 1000;
      timerEl.textContent = mmss(sec);
      if (sec > 20 * 60) recorder.stop(); // 20분 넘으면 자동 종료
    }, 250);
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
    try {
      audioCtx = new AudioContext();
      const an = audioCtx.createAnalyser(); an.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        lvl.style.width = Math.min(100, peak / 128 * 180) + '%';
        raf = requestAnimationFrame(loop);
      };
      loop();
    } catch {}
  };
}

function audioDuration(file) {
  return new Promise(res => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.onloadedmetadata = () => { res(isFinite(a.duration) ? a.duration : 0); URL.revokeObjectURL(a.src); };
    a.onerror = () => res(0);
    a.src = URL.createObjectURL(file);
  });
}

async function saveRecording(st, blob, durationSec) {
  const now = Date.now();
  const se = { id: uid('se'), studentId: st.id, createdAt: now, day: dayOf(now), durationSec, transcript: '', analysis: null, memo: '' };
  await db.put('sessions', se);
  await db.put('audio', { sessionId: se.id, blob });
  go('#session/' + se.id);
  runPipeline(se.id);
}

// ---------- 받아쓰기 + 분석 ----------
async function runPipeline(id, { force } = {}) {
  if (running.has(id)) return;
  running.add(id); refreshIfShowing(id);
  const settings = loadSettings();
  try {
    let se = await db.get('sessions', id);
    const st = await db.get('students', se.studentId);
    if (!se.transcript) {
      const audio = await db.get('audio', id);
      if (!audio) throw new Error('녹음 파일이 없어 받아쓸 수 없어요.');
      se.stage = 'transcribing'; await db.put('sessions', se); refreshIfShowing(id);
      const t0 = Date.now();
      se.transcript = await transcribe(audio.blob, settings);
      se.timing = { ...(se.timing || {}), stt: Date.now() - t0 };
      await db.put('sessions', se);
    }
    if (!se.analysis || force) {
      se.stage = 'analyzing'; se.error = null; await db.put('sessions', se); refreshIfShowing(id);
      const past = (await db.byIndex('sessions', 'studentId', se.studentId))
        .filter(x => x.id !== id && x.analysis).sort((a, b) => b.createdAt - a.createdAt).slice(0, 6)
        .map(x => ({ date: x.day, unit: x.analysis.unit, points: (x.analysis.weaknesses || []).map(w => w.point) }));
      const t1 = Date.now();
      se.analysis = await analyze({ transcript: se.transcript, studentCode: st?.code || '학생', grade: st?.grade || '', level: st?.level || '', history: past }, settings);
      se.analyzedAt = Date.now();
      se.timing = { ...(se.timing || {}), analysis: se.analyzedAt - t1, model: settings.claudeModel, effort: settings.effort };
    }
    se.stage = null; se.error = null;
    await db.put('sessions', se);
    if (!settings.keepAudio) await db.del('audio', id);
  } catch (e) {
    console.error(e);
    const se = await db.get('sessions', id);
    if (se) { se.stage = null; se.error = explainError(e); await db.put('sessions', se); }
  } finally {
    running.delete(id); refreshIfShowing(id);
  }
}
function refreshIfShowing(id) { if (location.hash === '#session/' + id) route(); }

// ---------- 기록 화면 ----------
async function showSession(id) {
  const se = await db.get('sessions', id);
  if (!se) { go('#home'); return; }
  const st = await db.get('students', se.studentId);
  setHeader((st?.name || '학생') + ' · ' + timeOf(se.createdAt), st ? '#student/' + st.id : '#home');
  const a = se.analysis;
  const hasAudio = !!(await db.get('audio', id));
  const busy = running.has(id);

  let body = '';
  if (busy) {
    body = `<div class="card status"><div class="spinner"></div><div>${se.stage === 'analyzing' ? '약점을 분석하고 있어요. 30초~1분 정도 걸려요.' : '녹음을 글로 옮기고 있어요.'}</div></div>`;
  } else if (se.error) {
    body = `<div class="err">${esc(se.error)}</div>
      <div class="row" style="margin:10px 0"><button class="btn primary" id="retry">다시 시도</button></div>`;
  }
  if (a) body += renderAnalysis(a);

  view.innerHTML = `
    <div class="muted">${se.day} ${timeOf(se.createdAt)} · 녹음 ${mmss(se.durationSec || 0)} · ${esc(st?.grade || '')}</div>
    ${body}
    ${a ? `<div class="card">
      <label for="unit">단원 (고칠 수 있어요)</label><input id="unit" value="${esc(se.unitOverride ?? a.unit)}">
      <label for="memo">선생님 메모 · 분석이 틀렸다면 여기에 적어 주세요</label><textarea id="memo">${esc(se.memo || '')}</textarea>
    </div>` : ''}
    ${se.transcript ? `<details class="card"><summary>받아쓴 대화 보기 · 고치기</summary>
      <textarea id="tr" style="min-height:180px;margin-top:8px">${esc(se.transcript)}</textarea>
      <div class="row" style="margin-top:8px"><button class="btn" id="reanalyze" ${busy ? 'disabled' : ''}>고친 내용으로 다시 분석</button></div>
    </details>` : ''}
    ${hasAudio ? `<div class="card"><audio controls style="width:100%" id="player"></audio></div>` : ''}
    <div class="row" style="margin-top:16px">
      ${st ? `<a class="btn primary" href="#record/${st.id}">같은 학생 다음 질문</a>` : ''}
      <a class="btn" href="#home">처음으로</a>
      <button class="btn danger" id="del">이 기록 삭제</button>
    </div>`;

  if (hasAudio) {
    const audio = await db.get('audio', id);
    const url = URL.createObjectURL(audio.blob);
    view.querySelector('#player').src = url;
    const prev = cleanup; cleanup = () => { URL.revokeObjectURL(url); prev && prev(); };
  }
  view.querySelector('#retry')?.addEventListener('click', () => runPipeline(id));
  view.querySelector('#reanalyze')?.addEventListener('click', async () => {
    const cur = await db.get('sessions', id);
    cur.transcript = view.querySelector('#tr').value.trim();
    await db.put('sessions', cur);
    runPipeline(id, { force: true });
  });
  const saveField = (sel, key) => {
    const el = view.querySelector(sel);
    if (!el) return;
    el.addEventListener('change', async () => {
      const cur = await db.get('sessions', id);
      cur[key] = el.value; await db.put('sessions', cur); toast('저장했어요');
    });
  };
  saveField('#memo', 'memo');
  saveField('#unit', 'unitOverride');
  view.querySelector('#del').onclick = async () => {
    const btn = view.querySelector('#del');
    if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = '한 번 더 누르면 지워져요'; return; }
    await db.del('sessions', id); await db.del('audio', id);
    toast('삭제했어요'); go(st ? '#student/' + st.id : '#home');
  };
}

function renderAnalysis(a) {
  const list = (arr, fn) => (arr && arr.length ? arr.map(fn).join('') : '');
  return `
    <div class="card">
      <h3 style="margin-top:0">무엇을 물었나</h3>
      <p style="margin:0">${esc(a.summary)}</p>
      <div style="margin-top:6px">${(a.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        <span class="muted">분석 확신도: ${esc(a.confidence)}${se.timing ? ' · 걸린 시간 ' + [se.timing.stt != null ? '받아쓰기 ' + Math.round(se.timing.stt / 1000) + '초' : '', se.timing.analysis != null ? '분석 ' + Math.round(se.timing.analysis / 1000) + '초' : ''].filter(Boolean).join(', ') : ''}</span></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0">약점</h3>
      ${list(a.weaknesses, w => `<div style="margin-bottom:12px"><strong>${esc(w.point)}</strong>
        ${w.evidence ? `<div class="quote">"${esc(w.evidence.replace(/^["“]|["”]$/g, ''))}"</div>` : ''}
        <div class="muted">${esc(w.explanation)}</div></div>`) || '<p class="muted">뚜렷한 약점을 찾지 못했어요.</p>'}
      ${a.teacher_supplied?.length ? `<h3>선생님이 대신 말해 준 것</h3><ul class="clean">${list(a.teacher_supplied, x => `<li>${esc(x)}</li>`)}</ul>` : ''}
      ${a.attitude ? `<h3>말하는 태도</h3><p style="margin:0">${esc(a.attitude)}</p>` : ''}
    </div>
    <div class="card">
      <h3 style="margin-top:0">추천 티칭 방식</h3>
      ${list(a.teaching, t => `<div style="margin-bottom:10px"><strong>${esc(t.method)}</strong><div>${esc(t.how)}</div></div>`)}
      ${a.practice_steps?.length ? `<h3>단계별 연습</h3><ol>${list(a.practice_steps, x => `<li>${esc(x)}</li>`)}</ol>` : ''}
    </div>
    ${a.unclear ? `<div class="warn">알아듣기 어려웠던 부분: ${esc(a.unclear)}</div>` : ''}`;
}

// ---------- 하루 리포트 ----------
let reportRunning = null;
async function showReport(day) {
  setHeader('하루 리포트', '#home');
  const list = await students();
  const byId = Object.fromEntries(list.map(x => [x.id, x]));
  const byCode = Object.fromEntries(list.map(x => [x.code, x]));
  const sessions = (await db.byIndex('sessions', 'day', day)).filter(se => se.analysis).sort((a, b) => a.createdAt - b.createdAt);
  const pending = (await db.byIndex('sessions', 'day', day)).filter(se => !se.analysis).length;
  const saved = await db.get('reports', day);
  const reports = (await db.all('reports')).map(r => r.day).sort().reverse();
  const nameOf = code => byCode[code] ? `${byCode[code].name} (${byCode[code].grade})` : code;
  const withNames = text => String(text ?? '').replace(/S\d{3}/g, c => byCode[c]?.name || c);

  let body = '';
  if (reportRunning === day) {
    body = `<div class="card status"><div class="spinner"></div><div>리포트를 쓰고 있어요. 1~2분 정도 걸려요.</div></div>`;
  } else if (saved?.error) {
    body = `<div class="err">${esc(saved.error)}</div>`;
  }
  const r = saved?.report;
  if (r) {
    body += `<div class="card">
      <h3 style="margin-top:0">오늘 요약</h3>
      <p style="margin:0">질문한 학생 ${saved.studentCount}명, 질문 ${saved.questionCount}건</p>
      ${r.overview.common_patterns.length ? `<ul class="clean">${r.overview.common_patterns.map(x => `<li>${esc(withNames(x))}</li>`).join('')}</ul>` : ''}
      ${r.overview.watch_list.length ? `<h3>눈여겨볼 학생</h3><ul class="clean">${r.overview.watch_list.map(w => `<li><strong>${esc(nameOf(w.student))}</strong>: ${esc(withNames(w.reason))}</li>`).join('')}</ul>` : ''}
      ${r.overview.teacher_note ? `<p class="muted">${esc(withNames(r.overview.teacher_note))}</p>` : ''}
    </div>` + r.students.map(s => `<div class="card">
      <h3 style="margin-top:0">${esc(nameOf(s.student))}</h3>
      <div class="muted">오늘 질문</div><ul class="clean">${s.today_questions.map(x => `<li>${esc(withNames(x))}</li>`).join('')}</ul>
      ${s.repeated_weaknesses.length ? `<div class="muted">반복되는 약점</div><ul class="clean">${s.repeated_weaknesses.map(x => `<li>${esc(withNames(x))}</li>`).join('')}</ul>` : ''}
      <div class="muted">막히는 방식</div><p style="margin:4px 0 8px">${esc(withNames(s.how_stuck))}</p>
      <div class="muted">다음 수업 지도 방향</div><ol>${s.next_class.map(x => `<li>${esc(withNames(x))}</li>`).join('')}</ol>
      ${s.compared_to_before ? `<div class="muted">지난 기록과 비교</div><p style="margin:4px 0 0">${esc(withNames(s.compared_to_before))}</p>` : ''}
    </div>`).join('');
  }

  view.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <input type="date" id="day" value="${day}" style="width:auto">
      <span class="muted">분석된 질문 ${sessions.length}건${pending ? `, 분석 전 ${pending}건` : ''}</span>
    </div>
    <div class="row" style="margin:12px 0">
      <button class="btn primary" id="make" ${reportRunning || !sessions.length ? 'disabled' : ''}>${r ? '리포트 다시 만들기' : '리포트 만들기'}</button>
      ${r ? '<button class="btn" id="copy">글로 복사</button>' : ''}
    </div>
    ${!sessions.length ? '<p class="muted">이 날짜에 분석된 질문이 없어요.</p>' : ''}
    ${body}
    ${reports.length ? `<h2>지난 리포트</h2><div class="card">${reports.map(d => `<a class="list-item" href="#report/${d}">${d}</a>`).join('')}</div>` : ''}`;

  view.querySelector('#day').onchange = e => go('#report/' + e.target.value);
  view.querySelector('#copy')?.addEventListener('click', async () => {
    const text = view.querySelectorAll('.card').length ? [...view.querySelectorAll('.card')].filter(c => !c.querySelector('.list-item')).map(c => c.innerText).join('\n\n') : '';
    try { await navigator.clipboard.writeText(`${day} 하루 리포트\n\n` + text); toast('복사했어요'); } catch { toast('복사하지 못했어요'); }
  });
  view.querySelector('#make')?.addEventListener('click', async () => {
    reportRunning = day; route();
    const settings = loadSettings();
    const since = dayOf(new Date(day).getTime() - 14 * 864e5);
    const all = await db.all('sessions');
    const groups = {};
    sessions.forEach(se => { (groups[se.studentId] ||= []).push(se); });
    const items = Object.entries(groups).map(([sid, list]) => ({
      student: byId[sid]?.code || '학생', grade: byId[sid]?.grade || '', level: byId[sid]?.level || '',
      today: list.map(se => ({ time: timeOf(se.createdAt), unit: se.unitOverride ?? se.analysis.unit, summary: se.analysis.summary,
        weaknesses: se.analysis.weaknesses, teacher_supplied: se.analysis.teacher_supplied, attitude: se.analysis.attitude,
        teaching: se.analysis.teaching.map(t => t.method), teacher_memo: se.memo || '' })),
      last_two_weeks: all.filter(x => x.studentId === sid && x.analysis && x.day < day && x.day >= since).sort((a, b) => a.createdAt - b.createdAt)
        .map(x => ({ date: x.day, unit: x.unitOverride ?? x.analysis.unit, points: x.analysis.weaknesses.map(w => w.point), teacher_memo: x.memo || '' })),
    }));
    try {
      const report = await dailyReport({ day, items }, settings);
      await db.put('reports', { day, report, createdAt: Date.now(), studentCount: items.length, questionCount: sessions.length });
    } catch (e) {
      console.error(e);
      await db.put('reports', { ...(saved || { day }), error: explainError(e) });
    } finally {
      reportRunning = null;
      if (location.hash === '#report/' + day) route();
    }
  });
}

// ---------- 설정 ----------
function showSettings() {
  setHeader('설정', '#home');
  const s = loadSettings();
  view.innerHTML = `
    <div class="card">
      <h3 style="margin-top:0">API 키</h3>
      <p class="muted">키는 이 휴대폰에만 저장돼요. 다른 사람에게 보여주지 마세요.</p>
      <label for="ok">OpenAI API 키 (받아쓰기)</label><input id="ok" type="password" autocomplete="off" value="${esc(s.openaiKey)}" placeholder="sk-...">
      <label for="ak">Anthropic API 키 (분석)</label><input id="ak" type="password" autocomplete="off" value="${esc(s.anthropicKey)}" placeholder="sk-ant-...">
    </div>
    <div class="card">
      <h3 style="margin-top:0">분석 설정</h3>
      <label for="cm">분석 모델</label>
      <select id="cm">
        <option value="claude-opus-5-5">Claude Opus 5.5 (가장 정확, 기본)</option>
        <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (더 빠르고 약 절반 비용)</option>
      </select>
      <label for="ef">분석 깊이</label>
      <select id="ef"><option value="low">빠르게</option><option value="medium">보통 (기본)</option><option value="high">꼼꼼하게</option></select>
      <label for="sm">받아쓰기 모델</label><input id="sm" value="${esc(s.sttModel)}">
      <label for="vc">자주 쓰는 수학 용어 (받아쓰기 정확도용, 쉼표로 구분)</label><textarea id="vc">${esc(s.vocab)}</textarea>
      <label style="display:flex;gap:8px;align-items:center;color:var(--ink)"><input type="checkbox" id="ka" style="width:auto" ${s.keepAudio ? 'checked' : ''}> 분석 후에도 녹음 파일 보관하기</label>
      <p class="muted">끄면 분석이 끝난 녹음 파일은 바로 지워져요.</p>
    </div>
    <button class="btn primary block" id="save">저장</button>
    <div class="card" style="margin-top:16px">
      <h3 style="margin-top:0">백업</h3>
      <p class="muted">기록은 이 휴대폰 브라우저에만 있어요. 가끔 백업 파일을 받아 두세요.</p>
      <button class="btn" id="export">전체 기록 백업 받기</button>
    </div>`;
  view.querySelector('#cm').value = s.claudeModel;
  view.querySelector('#ef').value = s.effort;
  view.querySelector('#save').onclick = () => {
    saveSettings({
      ...s,
      openaiKey: view.querySelector('#ok').value.trim(),
      anthropicKey: view.querySelector('#ak').value.trim(),
      claudeModel: view.querySelector('#cm').value,
      effort: view.querySelector('#ef').value,
      sttModel: view.querySelector('#sm').value.trim() || 'gpt-transcribe',
      vocab: view.querySelector('#vc').value.trim(),
      keepAudio: view.querySelector('#ka').checked,
    });
    toast('저장했어요'); go('#home');
  };
  view.querySelector('#export').onclick = async () => {
    const data = { exportedAt: new Date().toISOString(), students: await db.all('students'), sessions: await db.all('sessions'), reports: await db.all('reports') };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `질문코치-백업-${dayOf(Date.now())}.json`;
    document.body.appendChild(a); a.click(); a.remove();
  };
}

// 저장 공간이 자동으로 지워지지 않도록 요청
navigator.storage?.persist?.().catch(() => {});
route();
