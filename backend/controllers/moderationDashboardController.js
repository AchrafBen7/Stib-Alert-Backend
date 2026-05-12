function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

exports.renderDashboard = (req, res) => {
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.send(`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>StibAlert — Modération</title>
<style>
  :root {
    --paper: #F5F2EC; --paper2: #ECE7DC; --ink: #1A1817; --inkMute: #6B645C;
    --primary: #E94E1B; --high: #DC2626; --med: #F59E0B; --low: #6B7280;
  }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif; background: var(--paper); color: var(--ink); margin: 0; padding: 24px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.5px; }
  .sub { color: var(--inkMute); font-size: 13px; margin-bottom: 24px; }
  .stats { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat { background: var(--paper2); border: 1px solid rgba(0,0,0,0.08); padding: 12px 18px; border-radius: 12px; min-width: 120px; }
  .stat-value { font-size: 24px; font-weight: 700; }
  .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--inkMute); }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 14px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  th, td { padding: 12px 14px; text-align: left; font-size: 13px; vertical-align: top; }
  th { background: var(--paper2); font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--inkMute); font-weight: 600; }
  tr { border-bottom: 1px solid rgba(0,0,0,0.06); }
  tr:last-child { border-bottom: none; }
  .badge { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; }
  .badge.high { background: rgba(220,38,38,0.12); color: var(--high); }
  .badge.normal { background: rgba(245,158,11,0.12); color: var(--med); }
  .badge.low { background: rgba(107,114,128,0.12); color: var(--low); }
  .reason { font-family: 'SF Mono', Menlo, monospace; font-size: 11px; background: var(--paper2); padding: 1px 5px; border-radius: 4px; margin-right: 4px; }
  button { font-family: inherit; border: 1px solid rgba(0,0,0,0.12); background: white; padding: 6px 12px; border-radius: 8px; font-size: 12px; cursor: pointer; font-weight: 600; }
  button:hover { background: var(--paper2); }
  button.primary { background: #10B981; color: white; border-color: #10B981; }
  button.danger { background: var(--high); color: white; border-color: var(--high); }
  button.warning { background: var(--med); color: white; border-color: var(--med); }
  .actions { display: flex; gap: 4px; flex-wrap: wrap; }
  .description { max-width: 320px; word-break: break-word; line-height: 1.4; }
  .empty { padding: 60px 20px; text-align: center; color: var(--inkMute); }
  .filters { display: flex; gap: 10px; margin-bottom: 16px; }
  .filter { background: var(--paper2); padding: 8px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--inkMute); text-decoration: none; }
  .filter.active { background: var(--ink); color: var(--paper); }
  .filter-link { color: inherit; text-decoration: none; }
  .token-bar { background: var(--paper2); padding: 12px; border-radius: 10px; margin-bottom: 20px; }
  .token-bar input { font-family: 'SF Mono', Menlo, monospace; flex: 1; padding: 8px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.1); font-size: 12px; }
  .token-bar { display: flex; gap: 8px; align-items: center; }
</style>
</head>
<body>

<h1>🚨 Modération communauté</h1>
<p class="sub">Queue de signalements signalés pour validation manuelle.</p>

<div class="token-bar">
  <strong style="font-size:12px;color:var(--inkMute);">Admin Token:</strong>
  <input id="adminToken" type="password" placeholder="Coller le JWT admin ici…" />
  <button onclick="saveToken()">Enregistrer</button>
</div>

<div id="stats" class="stats"></div>

<div class="filters">
  <a href="?priority=" class="filter">Tous</a>
  <a href="?priority=high" class="filter">🔴 Haute</a>
  <a href="?priority=normal" class="filter">🟡 Normale</a>
  <a href="?priority=low" class="filter">⚪ Basse</a>
</div>

<table>
  <thead>
    <tr>
      <th style="width:100px">Priorité</th>
      <th style="width:90px">Ligne</th>
      <th>Description</th>
      <th style="width:80px">Score</th>
      <th>Motifs</th>
      <th style="width:240px">Actions</th>
    </tr>
  </thead>
  <tbody id="queue-body">
    <tr><td colspan="6" class="empty">Chargement…</td></tr>
  </tbody>
</table>

<script>
const TOKEN_KEY = 'stibalert_admin_token';
let queue = [];

function saveToken() {
  const t = document.getElementById('adminToken').value.trim();
  if (t) {
    localStorage.setItem(TOKEN_KEY, t);
    location.reload();
  }
}

function loadToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

function applyTokenInput() {
  const t = loadToken();
  if (t) document.getElementById('adminToken').value = t;
}

async function api(path, options = {}) {
  const token = loadToken();
  if (!token) {
    alert('Colle ton admin token en haut de la page pour continuer.');
    throw new Error('no_token');
  }
  const res = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
  });
  if (res.status === 401) {
    alert('Token invalide ou expiré.');
    throw new Error('unauthorized');
  }
  return res.json();
}

function priorityBadge(tier) {
  const className = tier === 'high' ? 'high' : tier === 'normal' ? 'normal' : 'low';
  const label = tier === 'high' ? 'HAUTE' : tier === 'normal' ? 'NORMALE' : 'BASSE';
  return '<span class="badge ' + className + '">' + label + '</span>';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderQueue() {
  const tbody = document.getElementById('queue-body');
  if (queue.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">✅ Aucun signalement en attente.</td></tr>';
    return;
  }
  tbody.innerHTML = queue.map(item => {
    const snap = item.signalementSnapshot || {};
    const reasons = (item.spamReasons || []).map(r => '<span class="reason">' + escapeHtml(r) + '</span>').join('');
    return '<tr>' +
      '<td>' + priorityBadge(item.priorityTier) + '<br><small style="color:var(--inkMute)">' + item.priority + '/100</small></td>' +
      '<td><strong>' + escapeHtml(snap.ligne || '?') + '</strong><br><small>' + escapeHtml(snap.typeProbleme || '') + '</small></td>' +
      '<td class="description">' + escapeHtml(snap.description || '(vide)') + '<br><small style="color:var(--inkMute)">' + escapeHtml(snap.authorType || '') + ' • ' + new Date(item.flaggedAt).toLocaleString('fr-BE') + '</small></td>' +
      '<td><strong>' + item.spamScore + '</strong></td>' +
      '<td>' + (reasons || '<small style="color:var(--inkMute)">—</small>') + '<br><small style="color:var(--inkMute)">' + escapeHtml(item.flagReason) + '</small></td>' +
      '<td><div class="actions">' +
        '<button class="primary" onclick="act(\\'' + item._id + '\\',\\'approve\\')">✓ Approuver</button>' +
        '<button onclick="act(\\'' + item._id + '\\',\\'reject\\')">✗ Rejeter</button>' +
        '<button class="danger" onclick="act(\\'' + item._id + '\\',\\'remove\\')">🗑 Spam</button>' +
        '<button class="warning" onclick="act(\\'' + item._id + '\\',\\'escalate\\')">⚠ Escalader</button>' +
      '</div></td>' +
    '</tr>';
  }).join('');
}

async function loadQueue() {
  const params = new URLSearchParams(location.search);
  const priority = params.get('priority') || '';
  const qs = priority ? '?priority=' + priority : '';
  try {
    const res = await api('/admin/moderation/queue' + qs);
    queue = res.items || [];
    renderQueue();
  } catch (e) {
    if (e.message !== 'no_token' && e.message !== 'unauthorized') {
      document.getElementById('queue-body').innerHTML = '<tr><td colspan="6" class="empty">Erreur de chargement : ' + escapeHtml(e.message) + '</td></tr>';
    }
  }
}

async function loadStats() {
  try {
    const res = await api('/admin/moderation/summary');
    const html =
      '<div class="stat"><div class="stat-value">' + (res.pending || 0) + '</div><div class="stat-label">Pending</div></div>' +
      '<div class="stat"><div class="stat-value">' + (res.breakdown?.high || 0) + '</div><div class="stat-label">🔴 Haute</div></div>' +
      '<div class="stat"><div class="stat-value">' + (res.breakdown?.normal || 0) + '</div><div class="stat-label">🟡 Normale</div></div>' +
      '<div class="stat"><div class="stat-value">' + (res.breakdown?.low || 0) + '</div><div class="stat-label">⚪ Basse</div></div>';
    document.getElementById('stats').innerHTML = html;
  } catch (e) {
    // silent
  }
}

async function act(flagId, action) {
  const reason = (action === 'remove' || action === 'reject')
    ? prompt('Motif (optionnel) :')
    : null;
  try {
    await api('/admin/moderation/' + flagId + '/action', {
      method: 'POST',
      body: JSON.stringify({ action, reason }),
    });
    await loadQueue();
    await loadStats();
  } catch (e) {
    alert('Erreur: ' + e.message);
  }
}

function highlightActiveFilter() {
  const params = new URLSearchParams(location.search);
  const current = params.get('priority') || '';
  document.querySelectorAll('.filter').forEach(el => {
    const href = el.getAttribute('href');
    if (href === '?priority=' + current) el.classList.add('active');
  });
}

applyTokenInput();
highlightActiveFilter();
loadStats();
loadQueue();
setInterval(() => { loadStats(); loadQueue(); }, 30000);
</script>

</body>
</html>`);
};
