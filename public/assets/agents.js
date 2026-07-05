/* Agents page logic */

async function loadAgents() {
  try {
    const [agents, workload, leaderboard] = await Promise.all([
      getJSON(`${API}/agents`),
      getJSON(`${API}/agents/workload`),
      getJSON(`${API}/agents/leaderboard`),
    ]);

    renderAgents(agents);
    renderWorkload(workload);
    renderLeaderboard(leaderboard);
  } catch (err) {
    toast('Failed to load agents: ' + err.message, 'error');
  }
}

function renderAgents(agents) {
  const tbody = document.querySelector('#agents-table tbody');
  if (!agents.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">No agents yet. Create one above.</td></tr>';
    return;
  }
  tbody.innerHTML = agents.map((a) => `
    <tr>
      <td><strong>${esc(a.name)}</strong>${a.id === 'agt-system' ? ' <span class="muted">(system)</span>' : ''}</td>
      <td>${esc(a.email)}</td>
      <td>${esc(a.team)}</td>
      <td>${badge('status-Open', a.role)}</td>
      <td>${(a.skills || []).map((s) => `<span class="tag">${esc(s)}</span>`).join(' ') || '—'}</td>
      <td id="open-${a.id}">—</td>
      <td id="total-${a.id}">—</td>
      <td id="res-${a.id}">—</td>
      <td><button class="btn btn-ghost btn-sm" onclick="showApiKeys('${a.id}', '${esc(a.name)}')">View</button></td>
      <td>${a.id !== 'agt-system' ? `<button class="btn btn-ghost btn-sm" onclick="deleteAgent('${a.id}')">Delete</button>` : ''}</td>
    </tr>
  `).join('');
}

function renderWorkload(workload) {
  const el = document.getElementById('workload');
  if (!workload.length) { el.innerHTML = '<p class="muted">No agents.</p>'; return; }
  el.innerHTML = workload.map((w) => {
    const utilColor = w.utilisation >= 90 ? '#dc2626' : w.utilisation >= 70 ? '#f59e0b' : '#10b981';
    return `
      <div class="bar-row" style="margin-bottom:8px">
        <span class="bar-label" style="width:160px">${esc(w.name)}</span>
        <span class="bar-track" style="height:22px"><span class="bar-fill" style="width:${Math.min(100, w.utilisation)}%; background:${utilColor}"></span></span>
        <span class="bar-value">${w.open_count}/${w.max_concurrent}</span>
      </div>
    `;
  }).join('');
  // also fill agent table open/total/resolved
  for (const w of workload) {
    const o = document.getElementById(`open-${w.id}`); if (o) o.textContent = w.open_count;
    const t = document.getElementById(`total-${w.id}`); if (t) t.textContent = w.total_assigned;
    const r = document.getElementById(`res-${w.id}`); if (r) r.textContent = w.resolved_count;
  }
}

function renderLeaderboard(rows) {
  const tbody = document.querySelector('#leaderboard-table tbody');
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">No data yet.</td></tr>'; return; }
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td><strong>${esc(r.name)}</strong></td>
      <td>${esc(r.team)}</td>
      <td>${r.total_assigned}</td>
      <td>${r.resolved_count}</td>
      <td>${r.open_count}</td>
      <td>${confBar(r.resolution_rate)}</td>
      <td>${r.avg_first_response_min != null ? r.avg_first_response_min + 'm' : '—'}</td>
      <td>${r.avg_resolution_min != null ? r.avg_resolution_min + 'm' : '—'}</td>
    </tr>
  `).join('');
}

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const skills = (fd.get('skills') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const payload = {
    name: fd.get('name'), email: fd.get('email'), team: fd.get('team'),
    role: fd.get('role'), maxConcurrent: Number(fd.get('maxConcurrent')) || 25, skills,
  };
  const status = document.getElementById('add-status');
  status.textContent = 'creating…';
  try {
    await postJSON(`${API}/agents`, payload);
    status.textContent = '✓ created';
    toast('Agent created', 'success');
    e.target.reset();
    loadAgents();
  } catch (err) {
    status.textContent = '';
    toast('Create failed: ' + err.message, 'error');
  }
});

document.getElementById('refresh').addEventListener('click', loadAgents);

async function deleteAgent(id) {
  if (!confirm('Delete this agent?')) return;
  try {
    await fetch(`${API}/agents/${id}`, { method: 'DELETE' });
    toast('Agent deleted', 'success');
    loadAgents();
  } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
}

async function showApiKeys(agentId, agentName) {
  const keys = await getJSON(`${API}/agents/${agentId}/api-keys`);
  const html = `
    <div class="card">
      <h3>API Keys for ${esc(agentName)}</h3>
      <div class="row">
        <button class="btn btn-sm" onclick="createApiKey('${agentId}')">+ Generate New Key</button>
        <span class="muted" id="new-key-status"></span>
      </div>
      <div id="new-key-out" style="display:none;margin-top:10px">
        <div class="muted" style="font-size:12px">Copy this key now — it will not be shown again.</div>
        <pre class="code" id="new-key-text" style="margin-top:6px"></pre>
      </div>
      <table class="table" style="margin-top:14px">
        <thead><tr><th>Prefix</th><th>Name</th><th>Last used</th><th>Expires</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>
          ${keys.map((k) => `<tr>
            <td><code>${esc(k.key_prefix)}…</code></td>
            <td>${esc(k.name)}</td>
            <td>${k.last_used_at ? fmtDate(k.last_used_at) : 'never'}</td>
            <td>${k.expires_at ? fmtDate(k.expires_at) : 'never'}</td>
            <td>${k.is_active ? '✓' : '✗'}</td>
            <td>${k.is_active ? `<button class="btn btn-ghost btn-sm" onclick="revokeKey('${agentId}','${k.id}')">Revoke</button>` : ''}</td>
          </tr>`).join('') || '<tr><td colspan="6" class="muted">No keys yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  `;
  // Open in a modal-like overlay
  let m = document.getElementById('modal');
  if (!m) { m = document.createElement('div'); m.id = 'modal'; m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);padding:40px;z-index:50;overflow:auto'; document.body.appendChild(m); }
  m.innerHTML = `<div style="max-width:800px;margin:auto">${html}<div style="text-align:right;margin-top:14px"><button class="btn btn-ghost" onclick="document.getElementById('modal').remove()">Close</button></div></div>`;
  m.style.display = 'block';
}

async function createApiKey(agentId) {
  const name = prompt('Key name (e.g. "postman", "ci-bot"):');
  if (!name) return;
  try {
    const r = await postJSON(`${API}/agents/${agentId}/api-keys`, { name });
    document.getElementById('new-key-out').style.display = '';
    document.getElementById('new-key-text').textContent = r.plaintext;
    toast('API key created — copy it now', 'success');
    // Refresh list
    setTimeout(() => showApiKeys(agentId, ''), 500);
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function revokeKey(agentId, keyId) {
  if (!confirm('Revoke this API key?')) return;
  try {
    await fetch(`${API}/agents/${agentId}/api-keys/${keyId}`, { method: 'DELETE' });
    toast('Key revoked', 'success');
    showApiKeys(agentId, '');
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

window.deleteAgent = deleteAgent;
window.showApiKeys = showApiKeys;
window.createApiKey = createApiKey;
window.revokeKey = revokeKey;

loadAgents();
