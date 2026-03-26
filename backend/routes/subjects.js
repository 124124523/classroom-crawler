/* =====================================================
   student.html 수정 패치 — 아래 3곳을 찾아서 교체하세요
   ===================================================== */


/* ── 패치 1: saveEvent() ── 1250번째 줄 근처
   event_date → due_date, memo → description, event_time 제거
   ---------------------------------------------------------- */

// ❌ 기존
body: JSON.stringify({ title, event_date: date, event_time: time || null, memo, images: imageUrls })

// ✅ 교체
body: JSON.stringify({ title, due_date: date, description: memo || null, images: imageUrls })


/* ── 패치 2: renderEvents() ── 1178번째 줄 근처
   ev.event_date → ev.due_date, ev.memo → ev.description
   ---------------------------------------------------------- */

// ❌ 기존 (1185번째 줄)
const d = new Date(ev.event_date || ev.date);

// ✅ 교체
const d = new Date(ev.due_date || ev.created_at);

// ❌ 기존 (1194번째 줄)
<div class="event-time">${ev.event_time || ''} ${ev.memo ? '· ' + escHtml(ev.memo) : ''}</div>

// ✅ 교체
<div class="event-time">${ev.description ? escHtml(ev.description) : ''}</div>


/* ── 패치 3: renderTimetable() ── 1301번째 줄 근처
   /api/timetable는 수강과목 목록 반환 (period/day_of_week 없음)
   timetables 테이블은 이미지 업로드 전용
   → 수강과목 목록 카드로 표시하도록 변경
   ---------------------------------------------------------- */

// ❌ 기존 renderTimetable 함수 전체 (1301~1324번째 줄)
function renderTimetable(tt) {
  const grid = document.getElementById('timetableGrid');
  const days = ['월','화','수','목','금'];
  const todayIdx = new Date().getDay() - 1;

  let html = `<div class="tt-cell header"></div>`;
  days.forEach((d,i) => {
    html += `<div class="tt-cell header ${i === todayIdx ? 'today' : ''}">${d}</div>`;
  });

  const maxPeriod = tt.length ? Math.max(...tt.map(t => t.period || 0), 7) : 7;
  for (let p = 1; p <= maxPeriod; p++) {
    html += `<div class="tt-cell period">${p}</div>`;
    for (let d = 1; d <= 5; d++) {
      const cell = tt.find(t => t.period === p && t.day_of_week === d);
      const isToday = (d - 1) === todayIdx;
      html += cell
        ? `<div class="tt-cell subject ${isToday ? 'today' : ''}">${escHtml(cell.subject_name || '')}</div>`
        : `<div class="tt-cell empty ${isToday ? 'today' : ''}">—</div>`;
    }
  }

  grid.innerHTML = html;
}

// ✅ 교체 — 수강 중인 과목 카드 목록으로 표시
function renderTimetable(tt) {
  const grid = document.getElementById('timetableGrid');

  if (!tt.length) {
    grid.innerHTML = '<div class="empty-state"><p>수강 중인 과목이 없습니다.</p></div>';
    return;
  }

  // 일반/진로 두 그룹으로 나눠서 표시
  const 일반 = tt.filter(t => (t.category || '일반') === '일반');
  const 진로 = tt.filter(t => t.category === '진로');

  const makeCard = (t) => `
    <div style="
      background: var(--surface2);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    ">
      <div>
        <div style="font-size:0.88rem;font-weight:600;color:var(--text)">${escHtml(t.subject_name)}</div>
        <div style="font-size:0.75rem;color:var(--text3);margin-top:2px">${escHtml(t.class_code)}반 · ${escHtml(t.teacher || '')}</div>
      </div>
      <span class="badge ${t.category === '진로' ? 'badge-blue' : 'badge-green'}">${t.category || '일반'}</span>
    </div>
  `;

  grid.style.display = 'flex';
  grid.style.flexDirection = 'column';
  grid.style.gap = '20px';

  grid.innerHTML = `
    ${일반.length ? `
      <div>
        <div style="font-size:0.78rem;font-weight:600;color:var(--text3);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:10px">일반 과목</div>
        <div style="display:flex;flex-direction:column;gap:6px">${일반.map(makeCard).join('')}</div>
      </div>
    ` : ''}
    ${진로.length ? `
      <div>
        <div style="font-size:0.78rem;font-weight:600;color:var(--text3);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:10px">진로 과목</div>
        <div style="display:flex;flex-direction:column;gap:6px">${진로.map(makeCard).join('')}</div>
      </div>
    ` : ''}
  `;
}