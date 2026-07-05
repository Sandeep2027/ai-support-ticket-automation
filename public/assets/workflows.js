/* Workflows page logic */

const TRIGGER_EVENTS = [
  'ticket_created', 'ticket_updated', 'status_changed', 'priority_changed',
  'category_changed', 'sla_breach', 'note_added', 'spam_detected',
  'ticket_assigned', 'ticket_resolved',
];

async function init() {
  // Populate trigger dropdown
  document.getElementById('wf-trigger').innerHTML = TRIGGER_EVENTS.map((e) => `<option value="${e}">${e}</option>`).join('');
  await loadRules();
}

async function loadRules() {
  try {
    const rules = await getJSON(`${API}/v3/workflows?limit=200`);
    const tbody = document.querySelector('#rules-table tbody');
    if (!rules.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty">No rules yet. Create one on the left.</td></tr>'; return; }
    tbody.innerHTML = rules.map((r) => `
      <tr>
        <td><strong>${esc(r.name)}</strong>${r.description ? `<div class="muted" style="font-size:11px">${esc(r.description)}</div>` : ''}</td>
        <td><code>${esc(r.trigger_event)}</code></td>
        <td style="font-size:11px">${r.conditions_parsed.length ? r.conditions_parsed.length + ' condition(s)' : '<span class="muted">always</span>'}</td>
        <td style="font-size:11px">${r.actions_parsed.length} action(s)</td>
        <td>${r.priority}</td>
        <td>${r.execution_count}</td>
        <td class="muted" style="font-size:11px">${r.last_executed_at ? fmtDate(r.last_executed_at) : 'never'}</td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="toggleRule('${r.id}', ${!r.is_active})">${r.is_active ? 'Disable' : 'Enable'}</button>
          <button class="btn btn-ghost btn-sm" onclick="viewExecutions('${r.id}', '${esc(r.name)}')">Log</button>
          <button class="btn btn-ghost btn-sm" onclick="deleteRule('${r.id}')">Delete</button>
        </td>
      </tr>
    `).join('');
  } catch (err) { toast('Failed to load rules: ' + err.message, 'error'); }
}

document.getElementById('wf-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  let conditions, actions;
  try {
    conditions = JSON.parse(fd.get('conditions') || '[]');
    actions = JSON.parse(fd.get('actions') || '[]');
  } catch (err) {
    toast('Invalid JSON in conditions or actions: ' + err.message, 'error');
    return;
  }
  const payload = {
    name: fd.get('name'), description: fd.get('description'),
    triggerEvent: fd.get('triggerEvent'),
    priority: Number(fd.get('priority')) || 100,
    conditions, actions,
  };
  const status = document.getElementById('wf-status');
  status.textContent = 'creating…';
  try {
    await postJSON(`${API}/v3/workflows`, payload);
    status.textContent = '✓ created';
    toast('Workflow rule created', 'success');
    e.target.reset();
    document.querySelector('[name=priority]').value = 100;
    loadRules();
  } catch (err) { status.textContent = ''; toast('Create failed: ' + err.message, 'error'); }
});

document.getElementById('refresh').addEventListener('click', loadRules);

async function toggleRule(id, enable) {
  try {
    await fetch(`${API}/v3/workflows/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: enable }),
    });
    toast(`Rule ${enable ? 'enabled' : 'disabled'}`, 'success');
    loadRules();
  } catch (err) { toast('Toggle failed: ' + err.message, 'error'); }
}

async function deleteRule(id) {
  if (!confirm('Delete this rule?')) return;
  try {
    await fetch(`${API}/v3/workflows/${id}`, { method: 'DELETE' });
    toast('Rule deleted', 'success');
    loadRules();
  } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
}

async function viewExecutions(id, name) {
  try {
    const execs = await getJSON(`${API}/v3/workflows/${id}/executions?limit=20`);
    const html = `
      <div class="card">
        <h3>Execution log for "${esc(name)}"</h3>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>When</th><th>Ticket</th><th>Status</th><th>Actions</th><th>Error</th></tr></thead>
            <tbody>
              ${execs.length ? execs.map((e) => `
                <tr>
                  <td class="muted" style="font-size:11px">${fmtDate(e.created_at)}</td>
                  <td><a href="/ticket.html?id=${esc(e.ticket_id)}">${esc(e.ticket_id)}</a></td>
                  <td>${badge('status-' + (e.status === 'success' ? 'Resolved' : e.status === 'skipped' ? 'Waiting\\ for\\ Customer' : 'Rejected'), e.status)}</td>
                  <td style="font-size:11px">${esc(e.actions_taken || '[]').slice(0, 200)}</td>
                  <td style="font-size:11px;color:#dc2626">${esc(e.error || '')}</td>
                </tr>`).join('') : '<tr><td colspan="5" class="empty">No executions yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
    let m = document.getElementById('modal');
    if (!m) { m = document.createElement('div'); m.id = 'modal'; m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);padding:40px;z-index:50;overflow:auto'; document.body.appendChild(m); }
    m.innerHTML = `<div style="max-width:900px;margin:auto">${html}<div style="text-align:right;margin-top:14px"><button class="btn btn-ghost" onclick="document.getElementById('modal').remove()">Close</button></div></div>`;
    m.style.display = 'block';
  } catch (err) { toast('Failed to load executions: ' + err.message, 'error'); }
}

window.toggleRule = toggleRule;
window.deleteRule = deleteRule;
window.viewExecutions = viewExecutions;
init();
