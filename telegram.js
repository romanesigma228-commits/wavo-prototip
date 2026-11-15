// Телеграм-бот: заявки на регистрацию (одобряет админ) и подтверждение входа.
// Работает через long polling внутри этого же сервера, внешние библиотеки не нужны.
import db from './db.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN = String(process.env.ADMIN_TELEGRAM_ID || '').trim();
const DAY = 864e5;
const LOGIN_TTL = 5 * 60e3;
const CODE = /^[a-f0-9]{32}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let botUsername = '';

export const botLink = (payload) => (botUsername ? `https://t.me/${botUsername}?start=${payload}` : null);

async function api(method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
  return j.result;
}
const send = (chat, text, extra = {}) =>
  api('sendMessage', { chat_id: chat, text, ...extra }).catch((e) => console.error('Telegram send:', e.message));
const edit = (chat, mid, text) => api('editMessageText', { chat_id: chat, message_id: mid, text }).catch(() => {});

// ---------- сообщения ----------
async function onMessage(m) {
  if (m.chat?.type !== 'private' || !m.from) return;
  const chat = m.chat.id;
  const from = String(m.from.id);
  const text = (m.text || '').trim();

  if (text === '/myid') return send(chat, `Ваш Telegram ID: ${from}`);

  if (text.startsWith('/start')) {
    const arg = text.split(/\s+/)[1] || '';
    if (arg.startsWith('reg_') && CODE.test(arg.slice(4))) return onRegStart(m, arg.slice(4));
    if (arg.startsWith('login_') && CODE.test(arg.slice(6))) return onLoginStart(m, arg.slice(6));
    return send(chat, 'Привет! Это бот Wavo. Регистрация и вход делаются на сайте: там будет кнопка, которая приведёт сюда.');
  }

  // команда админа: /remove юзернейм — удалить аккаунт
  if (from === ADMIN && text.startsWith('/remove')) {
    const name = (text.split(/\s+/)[1] || '').replace(/^@/, '').toLowerCase();
    const u = name && db.prepare('SELECT id FROM users WHERE username = ?').get(name);
    if (!u) return send(chat, 'Использование: /remove юзернейм (такого аккаунта нет или он не указан)');
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    return send(chat, `Аккаунт @${name} удалён вместе со всеми данными.`);
  }
}

async function onRegStart(m, code) {
  const chat = m.chat.id;
  const from = String(m.from.id);
  const reg = db.prepare('SELECT * FROM registrations WHERE code = ? AND created_at > ?').get(code, Date.now() - DAY);
  if (!reg) return send(chat, 'Ссылка устарела. Начните регистрацию на сайте заново.');
  if (reg.status === 'approved') return send(chat, 'Эта заявка уже одобрена. Возвращайтесь на сайт.');
  if (reg.status === 'rejected') return send(chat, 'Эта заявка была отклонена.');
  if (reg.status === 'sent') return send(chat, 'Заявка уже отправлена. Дождитесь решения.');
  const existing = db.prepare('SELECT username FROM users WHERE telegram_id = ?').get(from);
  if (existing) return send(chat, `У вас уже есть аккаунт @${existing.username}. Для входа используйте сайт.`);

  const tgName = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') + (m.from.username ? ` (@${m.from.username})` : '');
  const changed = db
    .prepare("UPDATE registrations SET status = 'sent', telegram_id = ?, telegram_name = ? WHERE id = ? AND status = 'new'")
    .run(from, tgName, reg.id).changes;
  if (!changed) return;
  await send(chat, 'Заявка отправлена. Как только её рассмотрят, вы получите сообщение здесь, а сайт сам войдёт в аккаунт.');
  if (!ADMIN) return console.warn('ADMIN_TELEGRAM_ID не задан: некому одобрять заявки');
  await send(ADMIN, `Новая заявка на регистрацию\nЮзернейм: @${reg.username}\nИмя: ${reg.display_name || '—'}\nTelegram: ${tgName} (id ${from})`, {
    reply_markup: { inline_keyboard: [[{ text: '✅ Принять', callback_data: `ok:${reg.id}` }, { text: '❌ Отклонить', callback_data: `no:${reg.id}` }]] },
  });
}

async function onLoginStart(m, code) {
  const chat = m.chat.id;
  const lr = db
    .prepare(
      `SELECT l.id, u.username, u.telegram_id FROM login_requests l JOIN users u ON u.id = l.user_id
       WHERE l.code = ? AND l.status = 'pending' AND l.created_at > ?`
    )
    .get(code, Date.now() - LOGIN_TTL);
  if (!lr) return send(chat, 'Ссылка для входа устарела. Нажмите «Войти» на сайте ещё раз.');
  if (lr.telegram_id !== String(m.from.id)) return send(chat, 'Этот вход запрошен для другого аккаунта.');
  await send(chat, `Подтвердить вход на сайт в аккаунт @${lr.username}?\nЕсли это были не вы, нажмите «Нет».`, {
    reply_markup: { inline_keyboard: [[{ text: '✅ Да, это я', callback_data: `lok:${lr.id}` }, { text: '🚫 Нет', callback_data: `lno:${lr.id}` }]] },
  });
}

// ---------- нажатия на кнопки ----------
async function onCallback(q) {
  api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
  const from = String(q.from.id);
  const chat = q.message?.chat?.id;
  const mid = q.message?.message_id;
  const [act, idStr] = String(q.data || '').split(':');
  const id = Number(idStr);
  if (!chat || !Number.isInteger(id)) return;

  if (act === 'lok' || act === 'lno') {
    const lr = db
      .prepare(
        `SELECT l.id, u.username, u.telegram_id FROM login_requests l JOIN users u ON u.id = l.user_id
         WHERE l.id = ? AND l.status = 'pending' AND l.created_at > ?`
      )
      .get(id, Date.now() - LOGIN_TTL);
    if (!lr || lr.telegram_id !== from) return edit(chat, mid, 'Запрос на вход устарел.');
    db.prepare('UPDATE login_requests SET status = ? WHERE id = ?').run(act === 'lok' ? 'confirmed' : 'denied', lr.id);
    return edit(chat, mid, act === 'lok' ? `✅ Вход в @${lr.username} подтверждён. Вернитесь на сайт.` : '🚫 Вход отклонён.');
  }

  if (from !== ADMIN || (act !== 'ok' && act !== 'no')) return; // решения принимает только админ
  const reg = db.prepare('SELECT * FROM registrations WHERE id = ?').get(id);
  if (!reg || reg.status !== 'sent') return edit(chat, mid, 'Заявка уже обработана или устарела.');

  if (act === 'ok') {
    try {
      db.transaction(() => {
        db.prepare('INSERT INTO users(username, display_name, telegram_id, created_at) VALUES (?,?,?,?)').run(
          reg.username, reg.display_name, reg.telegram_id, Date.now()
        );
        db.prepare("UPDATE registrations SET status = 'approved' WHERE id = ?").run(reg.id);
      })();
    } catch (e) {
      const why = String(e.code).startsWith('SQLITE_CONSTRAINT') ? 'юзернейм или Telegram уже заняты' : e.message;
      return edit(chat, mid, `Не удалось создать аккаунт @${reg.username}: ${why}`);
    }
    await edit(chat, mid, `✅ Принято: @${reg.username}`);
    await send(reg.telegram_id, `Ваш аккаунт @${reg.username} одобрен! Вернитесь на сайт, вход произойдёт автоматически.`);
  } else {
    db.prepare("UPDATE registrations SET status = 'rejected' WHERE id = ?").run(reg.id);
    await edit(chat, mid, `❌ Отклонено: @${reg.username}`);
    await send(reg.telegram_id, 'К сожалению, заявка на регистрацию отклонена.');
  }
}

// ---------- запуск ----------
async function startBot() {
  if (!TOKEN) return console.warn('TELEGRAM_BOT_TOKEN не задан: бот не запущен');
  for (;;) {
    try {
      botUsername = (await api('getMe')).username;
      await api('deleteWebhook');
      break;
    } catch (e) {
      console.error('Telegram: не удалось подключиться (проверьте TELEGRAM_BOT_TOKEN):', e.message);
      await sleep(10_000);
    }
  }
  console.log(`Telegram-бот запущен: @${botUsername}`);
  if (!ADMIN) console.warn('ADMIN_TELEGRAM_ID не задан: отправьте боту /myid и добавьте число в переменные');

  setInterval(() => {
    const now = Date.now();
    db.prepare('DELETE FROM registrations WHERE created_at < ?').run(now - 2 * DAY);
    db.prepare('DELETE FROM login_requests WHERE created_at < ?').run(now - 3600e3);
  }, 3600e3).unref();

  let offset = 0;
  for (;;) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        try {
          if (u.message) await onMessage(u.message);
          else if (u.callback_query) await onCallback(u.callback_query);
        } catch (e) {
          console.error('Telegram handler:', e.message);
        }
      }
    } catch (e) {
      console.error('Telegram polling:', e.message);
      await sleep(5000);
    }
  }
}

startBot(); // запускается при подключении модуля
