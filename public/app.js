// Минимальный клиент для проверки API. Весь текст из сервера вставляется через textContent (без XSS).
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag); Object.assign(e, props); e.append(...kids); return e; };

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api' + path, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status });
  return j;
}

const ERR = {
  username_taken: 'Этот юзернейм занят',
  user_not_found: 'Такого юзернейма нет',
  validation: 'Юзернейм: 3–20 символов, латиница, цифры и _',
  bot_unavailable: 'Бот пока не запущен, попробуйте через минуту',
};
const TEXT = {
  register: {
    new: 'Откройте бота по кнопке выше и нажмите «Запустить» (Start).',
    sent: 'Заявка отправлена. Ждём решения администратора…',
    rejected: 'Заявка отклонена.',
    none: 'Время заявки истекло, начните заново.',
  },
  login: { pending: 'Откройте бота и подтвердите вход.', denied: 'Вход отклонён.', expired: 'Время вышло, нажмите «Войти» ещё раз.' },
};

const show = (id) => ['auth', 'app'].forEach((x) => ($('#' + x).hidden = x !== id));
const hm = (s) => `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`;
let timer, poll;

function stopPoll() { clearInterval(poll); }

// Раз в 3 секунды спрашиваем сервер, что с заявкой или входом
function watch(kind) {
  stopPoll();
  const path = kind === 'register' ? '/auth/register/status' : '/auth/login/status';
  const tick = async () => {
    try {
      const { status } = await api(path, { method: 'POST' });
      if (status === 'approved' || status === 'confirmed') { stopPoll(); return boot(); }
      $('#state').textContent = TEXT[kind][status] || '';
      if (['rejected', 'denied', 'expired', 'none'].includes(status)) stopPoll();
    } catch {}
  };
  tick();
  poll = setInterval(tick, 3000);
}

function showBot(link, kind) {
  $('#botbox').hidden = false;
  const a = $('#botlink');
  if (link && link.startsWith('https://t.me/')) { a.href = link; a.hidden = false; } else a.hidden = true;
  watch(kind);
}

function tab(t) {
  stopPoll();
  $('#botbox').hidden = true;
  $('#err').textContent = '';
  $('#regForm').hidden = t !== 'reg';
  $('#loginForm').hidden = t !== 'login';
}
$('#tabReg').addEventListener('click', () => tab('reg'));
$('#tabLogin').addEventListener('click', () => tab('login'));

$('#regForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#err').textContent = '';
  try {
    const { botLink } = await api('/auth/register', { method: 'POST', body: { username: $('#ru').value, displayName: $('#rd').value || undefined } });
    showBot(botLink, 'register');
  } catch (err) { $('#err').textContent = ERR[err.message] || err.message; }
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#err').textContent = '';
  try {
    const { botLink } = await api('/auth/login/start', { method: 'POST', body: { username: $('#lu').value } });
    showBot(botLink, 'login');
  } catch (err) { $('#err').textContent = ERR[err.message] || err.message; }
});

async function boot() {
  let me;
  try { me = (await api('/me')).user; }
  catch {
    show('auth');
    // если страницу перезагрузили, пока заявка рассматривается или уже одобрена
    const s = await api('/auth/register/status', { method: 'POST' }).catch(() => ({}));
    if (s.status === 'approved') return boot();
    if (s.status === 'sent') showBot(null, 'register');
    return;
  }
  show('app');
  $('#who').textContent = '@' + me.username;
  refresh();
  clearInterval(timer);
  timer = setInterval(refresh, 15000);
}

async function refresh() {
  const [{ friends }, { incoming }] = await Promise.all([api('/friends'), api('/friends/requests')]);
  $('#friends').replaceChildren(...friends.map((f) => {
    const np = f.nowPlaying ? `▶ ${f.nowPlaying.artist} — ${f.nowPlaying.title} (${f.nowPlaying.platform})` : 'не слушает';
    const t = f.todaySeconds == null ? '' : ` · сегодня ${hm(f.todaySeconds)}`;
    return el('li', {}, '@' + f.username, el('div', { className: 'mu', textContent: np + t }),
      el('button', { textContent: 'Удалить', onclick: async () => { await api('/friends/' + f.username, { method: 'DELETE' }); refresh(); } }));
  }));
  $('#reqs').replaceChildren(...incoming.map((u) =>
    el('li', {}, '@' + u.username + ' ',
      el('button', { textContent: 'Принять', onclick: async () => { await api('/friends/accept', { method: 'POST', body: { username: u.username } }); refresh(); } }))));
}

let st;
$('#q').addEventListener('input', () => {
  clearTimeout(st);
  st = setTimeout(async () => {
    const q = $('#q').value.trim();
    if (q.length < 2) return $('#results').replaceChildren();
    try {
      const { users } = await api('/friends/search?q=' + encodeURIComponent(q));
      $('#results').replaceChildren(...users.map((u) => {
        const label = { none: 'Добавить', outgoing: 'Заявка отправлена', incoming: 'Принять', friend: 'Уже друзья' }[u.relation];
        return el('li', {}, '@' + u.username + ' ', el('button', {
          textContent: label, disabled: u.relation === 'friend' || u.relation === 'outgoing',
          onclick: async () => { await api('/friends/request', { method: 'POST', body: { username: u.username } }); refresh(); $('#q').value = ''; $('#results').replaceChildren(); },
        }));
      }));
    } catch {}
  }, 300);
});

$('#logout').addEventListener('click', async () => { await api('/auth/logout', { method: 'POST' }); clearInterval(timer); show('auth'); tab('login'); });

tab('reg');
boot();
