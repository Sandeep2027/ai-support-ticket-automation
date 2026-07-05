/* Knowledge Base page logic */

async function loadAll() {
  try {
    const [articles, stats] = await Promise.all([
      getJSON(`${API}/kb?limit=100`),
      getJSON(`${API}/kb/stats`),
    ]);
    renderArticles(articles);
    renderStats(stats);
  } catch (err) { toast('Failed to load KB: ' + err.message, 'error'); }
}

function renderStats(stats) {
  const el = document.getElementById('kb-stats');
  if (!stats || !stats.total) { el.innerHTML = '<p class="muted">No articles yet.</p>'; return; }
  el.innerHTML = `
    <div class="kpi-grid" style="grid-template-columns:1fr 1fr">
      <div class="kpi"><div class="kpi-label">Articles</div><div class="kpi-value">${stats.total}</div></div>
      <div class="kpi"><div class="kpi-label">Categories</div><div class="kpi-value">${Object.keys(stats.byCategory).length}</div></div>
    </div>
    <div style="margin-top:14px">
      ${Object.entries(stats.byCategory).map(([cat, n]) => `
        <div class="bar-row" style="margin-bottom:6px">
          <span class="bar-label">${esc(cat)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${Math.min(100, n * 10)}%"></span></span>
          <span class="bar-value">${n}</span>
        </div>`).join('')}
    </div>
  `;
}

function renderArticles(articles) {
  const el = document.getElementById('kb-list');
  if (!articles.length) { el.innerHTML = '<p class="empty">No articles yet. Create one above.</p>'; return; }
  el.innerHTML = articles.map((a) => `
    <div class="card" style="margin-bottom:10px">
      <div class="card-head">
        <h3 style="margin:0">${esc(a.title)} ${a.category ? badge('status-Open', a.category) : ''}</h3>
        <div>
          <span class="muted" style="font-size:12px">${a.view_count} views · ${a.helpful_count} helpful</span>
          <button class="btn btn-ghost btn-sm" onclick="deleteArticle('${a.id}')">Delete</button>
        </div>
      </div>
      <div class="muted" style="margin-bottom:8px">${esc(a.summary || '')}</div>
      <div class="tags" style="margin-bottom:8px">${(a.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>
      <details><summary class="muted" style="cursor:pointer">Show content</summary><pre class="code" style="margin-top:8px">${esc(a.content)}</pre></details>
    </div>
  `).join('');
}

document.getElementById('kb-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const tags = (fd.get('tags') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const payload = {
    title: fd.get('title'), summary: fd.get('summary'), category: fd.get('category'),
    tags, content: fd.get('content'),
  };
  const status = document.getElementById('kb-status');
  status.textContent = 'publishing…';
  try {
    await postJSON(`${API}/kb`, payload);
    status.textContent = '✓ published';
    toast('Article published', 'success');
    e.target.reset();
    loadAll();
  } catch (err) { status.textContent = ''; toast('Publish failed: ' + err.message, 'error'); }
});

document.getElementById('refresh').addEventListener('click', loadAll);

async function deleteArticle(id) {
  if (!confirm('Delete this article?')) return;
  try {
    await fetch(`${API}/kb/${id}`, { method: 'DELETE' });
    toast('Article deleted', 'success');
    loadAll();
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

// Live search
let searchTimer;
document.getElementById('kb-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  const out = document.getElementById('kb-search-results');
  if (!q) { out.innerHTML = ''; return; }
  searchTimer = setTimeout(async () => {
    try {
      const results = await getJSON(`${API}/kb/search?q=${encodeURIComponent(q)}&limit=5`);
      out.innerHTML = results.length
        ? results.map((r) => `<div style="padding:6px 0;border-bottom:1px solid var(--border)"><strong>${esc(r.title)}</strong><div class="muted" style="font-size:12px">${esc(r.summary || '')}</div></div>`).join('')
        : '<p class="muted">No matches.</p>';
    } catch { out.innerHTML = '<p class="muted">Search error.</p>'; }
  }, 250);
});

window.deleteArticle = deleteArticle;
loadAll();
