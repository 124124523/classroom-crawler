function showSection(name, el) {
  document.querySelectorAll('.section-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
  // el이 직접 전달되거나, 이벤트 currentTarget으로 찾기
  const navEl = el || (typeof event !== 'undefined' && event.currentTarget);
  if (navEl) navEl.classList.add('active');

  const titles = { assignments:'수행평가', notices:'공지사항', timetable:'시간표', calendar:'캘린더', meals:'오늘의 학식', profile:'프로필' };
  document.getElementById('pageTitle').textContent = titles[name] || name;}
