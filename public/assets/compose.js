/* ============================================================
   Compose / Ingest page logic
   - Manual compose → POST /api/ingest
   - .eml upload    → POST /api/ingest/eml
   ============================================================ */

// ---- Manual compose ----
document.getElementById('compose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const payload = {
    from: fd.get('from'),
    subject: fd.get('subject'),
    body: fd.get('body'),
    receivedAt: new Date().toISOString(),
  };
  const status = document.getElementById('compose-status');
  status.textContent = 'running AI pipeline…';
  try {
    const result = await postJSON(`${API}/ingest`, payload);
    showResult(result);
    status.textContent = '';
    e.target.reset();
  } catch (err) {
    status.textContent = '';
    toast('Ingest failed: ' + err.message, 'error');
  }
});

// ---- .eml upload ----
document.getElementById('eml-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fileInput = document.getElementById('eml-file');
  const file = fileInput.files[0];
  if (!file) { toast('Choose an .eml file first', 'error'); return; }
  const status = document.getElementById('eml-status');
  status.textContent = 'parsing & running pipeline…';
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${API}/ingest/eml`, { method: 'POST', body: fd });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || r.statusText);
    showResult(data);
    status.textContent = '';
    fileInput.value = '';
  } catch (err) {
    status.textContent = '';
    toast('EML ingest failed: ' + err.message, 'error');
  }
});

function showResult(r) {
  const card = document.getElementById('result-card');
  const pre = document.getElementById('result-json');
  const link = document.getElementById('result-link');
  card.style.display = '';
  pre.textContent = JSON.stringify(r, null, 2);
  if (r.ticket_id) {
    link.href = `/ticket.html?id=${encodeURIComponent(r.ticket_id)}`;
    link.textContent = `Open ticket ${r.ticket_id} →`;
  }
  toast(`Ticket created: ${r.ticket_id} (${r.category} / ${r.priority})`, 'success');
}
