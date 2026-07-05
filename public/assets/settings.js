/* Settings page logic */

async function loadHealth() {
  try {
    const h = await getJSON(`${API}/v3/health/deep`);
    const el = document.getElementById('health-list');
    if (h.status === 'ok') {
      el.innerHTML = `<div class="badge status-Resolved">ALL SYSTEMS OK</div>`;
    } else {
      el.innerHTML = `<div class="badge status-Rejected">DEGRADED</div>`;
    }
    el.innerHTML += h.checks.map((c) => {
      const color = c.status === 'ok' ? '#10b981' : c.status === 'degraded' ? '#f59e0b' : '#dc2626';
      const details = c.details ? `<div class="muted" style="font-size:11px;margin-top:2px">${esc(JSON.stringify(c.details).slice(0, 200))}</div>` : '';
      const error = c.error ? `<div style="color:#dc2626;font-size:11px;margin-top:2px">${esc(c.error)}</div>` : '';
      return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>
        <div style="flex:1">
          <strong>${esc(c.name)}</strong> <span class="muted" style="font-size:11px">(${c.status}${c.durationMs != null ? `, ${c.durationMs}ms` : ''})</span>
          ${details}${error}
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    document.getElementById('health-list').innerHTML = '<p class="muted">Failed to load health.</p>';
  }
}

async function loadDbStats() {
  try {
    const s = await getJSON(`${API}/v3/backup/stats`);
    const el = document.getElementById('db-stats');
    el.innerHTML = `
      <div class="kpi-grid" style="grid-template-columns:1fr 1fr">
        <div class="kpi"><div class="kpi-label">File size</div><div class="kpi-value" style="font-size:18px">${s.fileSizeMb} MB</div></div>
        <div class="kpi"><div class="kpi-label">Tables</div><div class="kpi-value" style="font-size:18px">${Object.keys(s.tableCounts).length}</div></div>
      </div>
      <div style="margin-top:12px;font-size:12px">
        ${Object.entries(s.tableCounts).slice(0, 10).map(([t, n]) => `<div class="bar-row" style="margin-bottom:3px">
          <span class="bar-label" style="width:140px">${esc(t)}</span>
          <span class="bar-value" style="width:auto;flex:1;text-align:left">${n}</span>
        </div>`).join('')}
        ${Object.keys(s.tableCounts).length > 10 ? `<div class="muted" style="margin-top:4px">+ ${Object.keys(s.tableCounts).length - 10} more tables</div>` : ''}
      </div>
    `;
  } catch (err) {
    document.getElementById('db-stats').innerHTML = '<p class="muted">Failed to load DB stats.</p>';
  }
}

async function loadBackups() {
  try {
    const list = await getJSON(`${API}/v3/backup`);
    const el = document.getElementById('backups-list');
    if (!list.length) { el.innerHTML = '<p class="muted">No backups yet.</p>'; return; }
    el.innerHTML = list.slice(0, 10).map((b) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px">
        <div>
          <div>${esc(b.filename)}</div>
          <div class="muted">${b.sizeMb} MB · ${fmtDate(b.createdAt)}</div>
        </div>
        <div>
          <button class="btn btn-ghost btn-sm" onclick="restoreBackup('${esc(b.filename)}')">Restore</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteBackup('${esc(b.filename)}')">Delete</button>
        </div>
      </div>
    `).join('');
  } catch { document.getElementById('backups-list').innerHTML = '<p class="muted">Failed to load backups.</p>'; }
}

async function vacuum() {
  if (!confirm('Run VACUUM? This locks the DB briefly.')) return;
  document.getElementById('db-action-status').textContent = 'vacuuming…';
  try {
    const r = await postJSON(`${API}/v3/backup/vacuum`, {});
    document.getElementById('db-action-status').textContent = `✓ reclaimed ${r.reclaimedMb} MB`;
    toast(`VACUUM done — reclaimed ${r.reclaimedMb} MB`, 'success');
    loadDbStats();
  } catch (err) { toast('VACUUM failed: ' + err.message, 'error'); document.getElementById('db-action-status').textContent = ''; }
}

async function createBackup() {
  document.getElementById('db-action-status').textContent = 'backing up…';
  try {
    await postJSON(`${API}/v3/backup`, {});
    document.getElementById('db-action-status').textContent = '✓ backup created';
    toast('Backup created', 'success');
    loadBackups();
  } catch (err) { toast('Backup failed: ' + err.message, 'error'); document.getElementById('db-action-status').textContent = ''; }
}

async function restoreBackup(filename) {
  if (!confirm(`Restore from ${filename}? This REPLACES the current database. Stop the server first.`)) return;
  try {
    const r = await postJSON(`${API}/v3/backup/restore/${encodeURIComponent(filename)}`, {});
    toast(r.message, 'success');
  } catch (err) { toast('Restore failed: ' + err.message, 'error'); }
}

async function deleteBackup(filename) {
  if (!confirm(`Delete backup ${filename}?`)) return;
  try {
    await fetch(`${API}/v3/backup/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    toast('Backup deleted', 'success');
    loadBackups();
  } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
}

// ---------------------------------------------------------------
// Settings
// ---------------------------------------------------------------

async function loadSettings() {
  try {
    const cat = document.getElementById('settings-category').value;
    const [settings, categories] = await Promise.all([
      getJSON(`${API}/v3/settings${cat ? '?category=' + cat : ''}`),
      getJSON(`${API}/v3/settings/categories`),
    ]);
    // Populate category dropdown
    const sel = document.getElementById('settings-category');
    const current = sel.value;
    sel.innerHTML = '<option value="">All Categories</option>' + categories.categories.map((c) => `<option ${c === current ? 'selected' : ''}>${esc(c)}</option>`).join('');
    sel.value = current;

    const tbody = document.querySelector('#settings-table tbody');
    if (!settings.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No settings.</td></tr>'; return; }
    tbody.innerHTML = settings.map((s) => `
      <tr>
        <td><code>${esc(s.key)}</code></td>
        <td>${s.is_sensitive ? '<span class="muted">***</span>' : `<input type="text" value="${esc(s.value)}" style="padding:2px 6px;font-size:12px" id="set-${esc(s.key)}" />`}</td>
        <td class="muted" style="font-size:12px">${esc(s.description || '')}</td>
        <td>${badge('status-Open', s.category)}</td>
        <td class="muted" style="font-size:11px">${fmtDate(s.updated_at)}</td>
        <td>${!s.is_sensitive ? `<button class="btn btn-ghost btn-sm" onclick="saveSetting('${esc(s.key)}')">Save</button>` : ''}</td>
      </tr>
    `).join('');
  } catch (err) { toast('Failed to load settings: ' + err.message, 'error'); }
}

async function saveSetting(key) {
  const input = document.getElementById('set-' + key);
  if (!input) return;
  try {
    await fetch(`${API}/v3/settings/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Actor': 'agent:web' },
      body: JSON.stringify({ value: input.value }),
    });
    toast(`Setting "${key}" saved`, 'success');
  } catch (err) { toast('Save failed: ' + err.message, 'error'); }
}

// ---------------------------------------------------------------
// Audit search
// ---------------------------------------------------------------

async function searchAudit() {
  const params = new URLSearchParams();
  const tid = document.getElementById('audit-ticket').value.trim();
  const act = document.getElementById('audit-action').value.trim();
  const actor = document.getElementById('audit-actor').value.trim();
  const val = document.getElementById('audit-value').value.trim();
  if (tid) params.set('ticketId', tid);
  if (act) params.set('action', act);
  if (actor) params.set('actor', actor);
  if (val) params.set('valueContains', val);
  params.set('limit', '100');

  document.getElementById('audit-export').href = `${API}/v3/audit/export.csv?${params}`;

  try {
    const rows = await getJSON(`${API}/v3/audit/search?${params}`);
    const tbody = document.querySelector('#audit-table tbody');
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty">No results.</td></tr>'; return; }
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td class="muted" style="font-size:11px">${fmtDate(r.created_at)}</td>
        <td><a href="/ticket.html?id=${esc(r.ticket_id)}">${esc(r.ticket_id)}</a></td>
        <td><strong>${esc(r.action)}</strong></td>
        <td>${esc(r.field || '—')}</td>
        <td class="muted" style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis">${esc(r.old_value || '')} → ${esc(r.new_value || '')}</td>
        <td>${esc(r.actor)}</td>
      </tr>
    `).join('');
  } catch (err) { toast('Audit search failed: ' + err.message, 'error'); }
}

// Init
document.getElementById('refresh-health').addEventListener('click', loadHealth);
loadHealth();
loadDbStats();
loadBackups();
loadSettings();
