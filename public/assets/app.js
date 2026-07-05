/* ============================================================
   Shared frontend helpers + dashboard logic.
   ============================================================ */

const API = '/api';

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
async function postJSON(url, body, method = 'POST') {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Actor': 'agent:web' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) throw new Error((data && data.error) || `${r.status} ${r.statusText}`);
  return data;
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtAgo(s) {
  if (!s) return '—';
  const d = new Date(s); const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function badge(cls, text) {
  // cls like "prio-Critical" or "status-Open"
  return `<span class="badge ${cls.replace(/\s+/g, '\\ ')}">${esc(text)}</span>`;
}
function confBar(score) {
  const cls = score < 60 ? 'low' : '';
  return `<span class="confidence ${cls}"><span style="width:${Math.max(0, Math.min(100, score))}%"></span></span>${Math.round(score)}%`;
}

function toast(msg, type = '') {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = 'toast'; }, 3500);
}

// ---- AI status pill ----
async function refreshAiStatus() {
  const el = document.getElementById('ai-status');
  if (!el) return;
  try {
    const h = await getJSON(`${API}/health`);
    if (h.ai.useMock) {
      el.textContent = 'AI: MOCK (offline)';
      el.className = 'ai-status mock';
      el.title = 'No AI_API_KEY set — running with built-in rule-based mock. Set AI_API_KEY in .env to use a real LLM.';
    } else {
      el.textContent = `AI: ${h.ai.model}`;
      el.className = 'ai-status live';
      el.title = `Live LLM: ${h.ai.model} @ ${h.ai.baseUrl}`;
    }
  } catch {
    el.textContent = 'AI: ?';
    el.title = 'Server unreachable';
  }
}
refreshAiStatus();
setInterval(refreshAiStatus, 30000);

// ============================================================
// Dashboard
// ============================================================
async function loadDashboard() {
  if (!document.getElementById('kpi-total')) return;

  try {
    const [stats, samples, recent] = await Promise.all([
      getJSON(`${API}/stats`),
      getJSON(`${API}/samples`),
      getJSON(`${API}/tickets?limit=10`),
    ]);

    // KPIs
    document.getElementById('kpi-total').textContent = stats.total;
    document.getElementById('kpi-recent').textContent = stats.recent_24h;
    const open = (stats.byStatus.Open || 0);
    const crit = (stats.byPriority.Critical || 0);
    document.getElementById('kpi-open-crit').innerHTML = `${open} <span class="muted" style="font-size:14px">/ ${crit}</span>`;
    document.getElementById('kpi-sla').textContent = stats.slaBreached.length;
    document.getElementById('kpi-esc').textContent = stats.escalated_open || 0;
    document.getElementById('kpi-spam').textContent = stats.spam_detected || 0;
    document.getElementById('kpi-conf').textContent = stats.avgConfidence ? stats.avgConfidence + '%' : '—';

    // Charts
    renderBar('chart-status', stats.byStatus, 'status');
    renderBar('chart-category', stats.byCategory, 'cat');
    renderBar('chart-priority', stats.byPriority, 'prio');
    renderBar('chart-team', stats.byTeam, 'team');
    renderBar('chart-sentiment', stats.bySentiment, 'sentiment');
    renderBar('chart-language', stats.byLanguage, 'lang');

    // SLA breaches
    if (stats.slaBreached.length) {
      const card = document.getElementById('sla-card');
      card.style.display = '';
      document.getElementById('sla-list').innerHTML =
        `<div class="table-wrap"><table class="table"><thead><tr>
          <th>ID</th><th>Subject</th><th>Priority</th><th>SLA Due</th><th>Team</th>
        </tr></thead><tbody>` +
        stats.slaBreached.map((b) =>
          `<tr><td><a href="/ticket.html?id=${encodeURIComponent(b.id)}">${esc(b.id)}</a></td>
               <td>${esc(b.email_subject)}</td>
               <td>${badge('prio-' + b.priority, b.priority)}</td>
               <td>${fmtDate(b.sla_due_at)}</td>
               <td>${esc(b.assigned_team || '—')}</td></tr>`
        ).join('') +
        `</tbody></table></div>`;
    }

    // Samples
    renderSamples(samples);

    // Recent tickets
    renderTicketRows(document.querySelector('#recent-table tbody'), recent);

  } catch (err) {
    toast('Failed to load dashboard: ' + err.message, 'error');
  }
}

function renderBar(elId, obj, kind) {
  const el = document.getElementById(elId);
  if (!el) return;
  const entries = Object.entries(obj || {});
  if (!entries.length) { el.innerHTML = '<p class="muted">No data yet.</p>'; return; }
  const max = Math.max(...entries.map(([, v]) => v), 1);
  el.innerHTML = entries
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => {
      const cls = kind === 'prio' ? `prio-${k}` : kind === 'status' ? `status-${k}` : '';
      const label = kind === 'prio' ? badge(cls, k) : kind === 'status' ? badge(cls, k) : esc(k);
      return `<div class="bar-row">
        <span class="bar-label">${label}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(v / max * 100).toFixed(1)}%"></span></span>
        <span class="bar-value">${v}</span>
      </div>`;
    }).join('');
}

function renderSamples(samples) {
  const el = document.getElementById('sample-grid');
  if (!el) return;
  if (!samples.length) { el.innerHTML = '<p class="muted">No samples found.</p>'; return; }
  el.innerHTML = samples.map((s) => `
    <div class="sample-card">
      <h4>${esc(s.title)}</h4>
      <p>${esc(s.description)}</p>
      <div>
        ${s.category_hint ? badge('status-Open', s.category_hint) : ''}
        ${s.expected_priority ? badge('prio-' + s.expected_priority, s.expected_priority) : ''}
      </div>
      <div class="row">
        <button class="btn btn-sm" onclick="ingestSample('${esc(s.filename)}')">Ingest →</button>
        <span class="muted sample-status" data-file="${esc(s.filename)}"></span>
      </div>
    </div>
  `).join('');
}

async function ingestSample(filename) {
  const status = document.querySelector(`.sample-status[data-file="${CSS.escape(filename)}"]`);
  if (status) status.textContent = 'running…';
  try {
    const result = await postJSON(`${API}/samples/${encodeURIComponent(filename)}/ingest`);
    if (status) {
      status.innerHTML = result.matched
        ? `✓ <a href="/ticket.html?id=${encodeURIComponent(result.ticket_id)}">${result.ticket_id}</a> (matched)`
        : `~ <a href="/ticket.html?id=${encodeURIComponent(result.ticket_id)}">${result.ticket_id}</a> (off)`;
    }
    toast(`Ticket ${result.ticket_id} created — ${result.category} / ${result.priority}`, 'success');
    setTimeout(loadDashboard, 600);
  } catch (err) {
    if (status) status.textContent = 'failed';
    toast('Ingest failed: ' + err.message, 'error');
  }
}

function renderTicketRows(tbody, tickets) {
  if (!tbody) return;
  if (!tickets.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty">No tickets yet. Ingest a sample email to get started.</td></tr>';
    return;
  }
  tbody.innerHTML = tickets.map((t) => `
    <tr onclick="location.href='/ticket.html?id=${encodeURIComponent(t.id)}'">
      <td><a href="/ticket.html?id=${encodeURIComponent(t.id)}" onclick="event.stopPropagation()">${esc(t.id)}</a></td>
      <td>${esc((t.email_subject || '').slice(0, 70))}</td>
      <td>${esc(t.sender_email)}</td>
      <td>${esc(t.category)}</td>
      <td>${badge('prio-' + t.priority, t.priority)}</td>
      <td>${badge('status-' + t.status.replace(/\s/g, ' '), t.status)}</td>
      <td>${esc(t.assigned_team || '—')}</td>
      <td>${confBar(t.confidence_score)}</td>
      <td title="${esc(t.received_at)}">${fmtAgo(t.received_at)}</td>
    </tr>
  `).join('');
}

// Expose for inline handlers
window.ingestSample = ingestSample;

// Auto-load dashboard on home page
if (location.pathname === '/' || location.pathname === '/index.html') {
  loadDashboard();
  setInterval(loadDashboard, 15000);
}
