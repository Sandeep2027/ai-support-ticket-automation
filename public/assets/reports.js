/* Reports page logic */

async function loadReports() {
  try {
    const r = await getJSON(`${API}/reports/full`);

    // KPIs
    document.getElementById('kpi-sla').innerHTML = `${r.sla.compliance_rate}<span style="font-size:14px;color:var(--muted)">%</span>`;
    document.getElementById('kpi-fr').textContent = r.responseTimes.avg_first_response_min != null ? r.responseTimes.avg_first_response_min + 'm' : '—';
    document.getElementById('kpi-res').textContent = r.responseTimes.avg_resolution_min != null ? r.responseTimes.avg_resolution_min + 'm' : '—';
    document.getElementById('kpi-spam').textContent = r.spam.spam_rate + '%';

    // Timeseries chart (CSS-only line chart)
    renderTsChart(r.timeseries.created, r.timeseries.resolved);

    // Teams
    document.querySelector('#teams-table tbody').innerHTML = r.teams.length
      ? r.teams.map((t) => `<tr>
          <td><strong>${esc(t.team)}</strong></td>
          <td>${t.total}</td>
          <td>${t.open}</td>
          <td>${t.resolved}</td>
          <td>${t.critical_open}</td>
          <td>${t.escalated}</td>
        </tr>`).join('')
      : '<tr><td colspan="6" class="empty">No data.</td></tr>';

    // SLA
    document.querySelector('#sla-table tbody').innerHTML = r.sla.byPriority.length
      ? r.sla.byPriority.map((p) => `<tr>
          <td>${badge('prio-' + p.priority, p.priority)}</td>
          <td>${p.total}</td>
          <td>${p.breached}</td>
          <td>${confBar(p.compliance_rate)}</td>
        </tr>`).join('')
      : '<tr><td colspan="4" class="empty">No data.</td></tr>';

    // Agents
    document.querySelector('#agents-table tbody').innerHTML = r.agents.length
      ? r.agents.map((a) => `<tr>
          <td><strong>${esc(a.name)}</strong></td>
          <td>${esc(a.team)}</td>
          <td>${a.total_assigned}</td>
          <td>${a.resolved_count}</td>
          <td>${a.open_count}</td>
          <td>${confBar(a.resolution_rate)}</td>
          <td>${a.avg_first_response_min != null ? a.avg_first_response_min + 'm' : '—'}</td>
          <td>${a.avg_resolution_min != null ? a.avg_resolution_min + 'm' : '—'}</td>
        </tr>`).join('')
      : '<tr><td colspan="8" class="empty">No agents yet.</td></tr>';

    // Spam
    document.getElementById('spam-stats').innerHTML = `
      <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="kpi"><div class="kpi-label">Total Tickets</div><div class="kpi-value">${r.spam.total}</div></div>
        <div class="kpi"><div class="kpi-label">Spam Detected</div><div class="kpi-value">${r.spam.spam_detected}</div></div>
        <div class="kpi"><div class="kpi-label">Auto-Rejected</div><div class="kpi-value">${r.spam.auto_rejected}</div></div>
      </div>
    `;

  } catch (err) { toast('Failed to load reports: ' + err.message, 'error'); }
}

function renderTsChart(created, resolved) {
  const el = document.getElementById('ts-chart');
  if (!created.length) { el.innerHTML = '<p class="muted">No data.</p>'; return; }
  const all = [...created, ...resolved];
  const max = Math.max(...all.map((d) => d.count), 1);
  // Build two SVG polylines
  const w = 800, h = 180, pad = 30;
  const xStep = (w - pad * 2) / Math.max(created.length - 1, 1);
  const yScale = (v) => h - pad - (v / max) * (h - pad * 2);
  const line = (data, color) => {
    const points = data.map((d, i) => `${pad + i * xStep},${yScale(d.count)}`).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" />`;
  };
  const xLabels = created.filter((_, i) => i % 5 === 0)
    .map((d) => `<text x="${pad + created.indexOf(d) * xStep}" y="${h - 8}" fill="#6b7280" font-size="10" text-anchor="middle">${d.day.slice(5)}</text>`).join('');
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:100%">
      ${line(created, '#4f46e5')}
      ${line(resolved, '#10b981')}
      ${xLabels}
      <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="#e5e7eb" />
      <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="#e5e7eb" />
    </svg>
    <div style="text-align:center;margin-top:6px">
      <span style="display:inline-block;width:12px;height:12px;background:#4f46e5;margin-right:4px"></span>Created
      <span style="display:inline-block;width:12px;height:12px;background:#10b981;margin:0 4px 0 12px"></span>Resolved
    </div>
  `;
}

loadReports();
