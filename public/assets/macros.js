/* Macros page logic */

let allMacros = [];

async function loadMacros() {
  try {
    allMacros = await getJSON(`${API}/v3/macros?limit=200`);
    renderMacros(allMacros);
  } catch (err) { toast('Failed to load macros: ' + err.message, 'error'); }
}

function renderMacros(macros) {
  const el = document.getElementById('macro-list');
  if (!macros.length) { el.innerHTML = '<p class="empty">No macros yet. Create one on the left.</p>'; return; }
  el.innerHTML = macros.map((m) => `
    <div class="card" style="margin-bottom:10px">
      <div class="card-head">
        <h3 style="margin:0">${esc(m.name)} ${m.category ? badge('status-Open', m.category) : ''} ${m.team ? badge('prio-Medium', m.team) : ''}</h3>
        <div>
          <span class="muted" style="font-size:12px">used ${m.usage_count}×</span>
          <button class="btn btn-ghost btn-sm" onclick="deleteMacro('${m.id}')">Delete</button>
        </div>
      </div>
      ${m.description ? `<div class="muted" style="margin-bottom:8px">${esc(m.description)}</div>` : ''}
      ${m.variables_used && m.variables_used.length ? `<div class="tags" style="margin-bottom:8px">${m.variables_used.map((v) => `<span class="tag" style="background:#fef3c7;color:#92400e">${esc(v)}</span>`).join('')}</div>` : ''}
      <details><summary class="muted" style="cursor:pointer;font-size:12px">Show template</summary>
        ${m.subject_template ? `<div class="muted" style="font-size:11px;margin-top:6px">Subject: <code>${esc(m.subject_template)}</code></div>` : ''}
        <pre class="code" style="margin-top:6px;max-height:200px;font-size:11px">${esc(m.body_template)}</pre>
      </details>
    </div>
  `).join('');
}

document.getElementById('macro-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const tags = (fd.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const payload = {
    name: fd.get('name'), description: fd.get('description'),
    subjectTemplate: fd.get('subjectTemplate') || null,
    bodyTemplate: fd.get('bodyTemplate'),
    category: fd.get('category') || null, team: fd.get('team') || null,
    tags,
  };
  const status = document.getElementById('macro-status');
  status.textContent = 'creating…';
  try {
    await postJSON(`${API}/v3/macros`, payload);
    status.textContent = '✓ created';
    toast('Macro created', 'success');
    e.target.reset();
    loadMacros();
  } catch (err) { status.textContent = ''; toast('Create failed: ' + err.message, 'error'); }
});

async function deleteMacro(id) {
  if (!confirm('Delete this macro?')) return;
  try {
    await fetch(`${API}/v3/macros/${id}`, { method: 'DELETE' });
    toast('Macro deleted', 'success');
    loadMacros();
  } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
}

let searchTimer;
document.getElementById('macro-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.toLowerCase().trim();
  searchTimer = setTimeout(() => {
    const filtered = !q ? allMacros : allMacros.filter((m) =>
      m.name.toLowerCase().includes(q) ||
      (m.description || '').toLowerCase().includes(q) ||
      (m.body_template || '').toLowerCase().includes(q)
    );
    renderMacros(filtered);
  }, 200);
});

window.deleteMacro = deleteMacro;
loadMacros();
