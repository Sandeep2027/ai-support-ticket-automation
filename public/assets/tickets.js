/* Tickets list page logic */

const params = new URLSearchParams(location.search);
let currentLimit = 100;

async function loadTickets() {
  const f = {
    status: document.getElementById('f-status').value,
    priority: document.getElementById('f-priority').value,
    category: document.getElementById('f-category').value,
    team: document.getElementById('f-team').value,
    q: document.getElementById('f-q').value.trim(),
  };
  // Reflect on URL
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
  history.replaceState(null, '', '/tickets.html' + (q.toString() ? '?' + q : ''));

  const qs = new URLSearchParams({ limit: currentLimit, ...f });
  Object.keys(f).forEach((k) => { if (!f[k]) qs.delete(k); });

  try {
    const rows = await getJSON(`${API}/tickets?${qs}`);
    renderTicketRows(document.querySelector('#tickets-table tbody'), rows);
    document.getElementById('count-label').textContent = `(${rows.length})`;
  } catch (err) {
    toast('Failed to load tickets: ' + err.message, 'error');
  }
}

document.getElementById('f-apply').addEventListener('click', loadTickets);
document.getElementById('f-clear').addEventListener('click', () => {
  ['f-q', 'f-status', 'f-priority', 'f-category', 'f-team'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  loadTickets();
});
document.getElementById('refresh').addEventListener('click', loadTickets);
document.getElementById('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadTickets(); });

// Pre-fill from URL
for (const k of ['status', 'priority', 'category', 'team']) {
  const v = params.get(k);
  if (v) document.getElementById('f-' + k).value = v;
}
const qv = params.get('q');
if (qv) document.getElementById('f-q').value = qv;

loadTickets();
