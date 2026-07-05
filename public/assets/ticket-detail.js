/* Ticket detail page logic */

const id = new URLSearchParams(location.search).get('id');
if (!id) {
  document.getElementById('ticket-root').innerHTML = '<div class="card"><p class="muted">No ticket ID provided. <a href="/tickets.html">← Back to all tickets</a></p></div>';
}

const STATUSES = ['Open', 'In Progress', 'Waiting for Customer', 'Resolved', 'Closed', 'Rejected'];
const PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];
const CATEGORIES = ['Technical Support', 'Billing', 'Sales Inquiry', 'Feature Request', 'Bug Report', 'Account Access', 'Refund Request', 'General Inquiry'];
const SENTIMENTS = ['Positive', 'Neutral', 'Negative'];
const TEAMS = ['Technical Support', 'Finance', 'Sales', 'Customer Success', 'Product Team'];

async function load() {
  if (!id) return;
  try {
    const data = await getJSON(`${API}/tickets/${encodeURIComponent(id)}`);
    render(data);
  } catch (err) {
    document.getElementById('ticket-root').innerHTML =
      `<div class="card"><p class="muted">Ticket not found. <a href="/tickets.html">← Back</a></p></div>`;
  }
}

function render({ ticket: t, audit, notes, attachments }) {
  document.getElementById('ticket-id-sub').textContent = t.id;
  document.title = `${t.id} — ${t.email_subject || 'Ticket'}`;

  const slaClass = t.sla_due_at && new Date(t.sla_due_at) < new Date() &&
    !['Resolved', 'Closed', 'Rejected'].includes(t.status) ? 'kpi-warn' : '';

  document.getElementById('ticket-root').innerHTML = `
    <div class="card">
      <div class="card-head">
        <h3>${esc(t.email_subject || '(no subject)')}</h3>
        <div>
          ${badge('prio-' + t.priority, t.priority)}
          ${badge('status-' + t.status.replace(/\s/g, ' '), t.status)}
          ${badge('sentiment-' + t.sentiment, t.sentiment)}
          ${t.is_spam ? badge('status-Rejected', 'SPAM') : ''}
          ${t.escalated ? badge('prio-Critical', 'ESCALATED L' + t.escalation_level) : ''}
          ${t.duplicate_of ? badge('status-Waiting\\ for\\ Customer', 'DUPLICATE') : ''}
        </div>
      </div>
      <div class="field-grid">
        <div class="field"><label>Customer</label><div class="value">${esc(t.customer_name || '—')}</div></div>
        <div class="field"><label>Sender email</label><div class="value">${esc(t.sender_email)}</div></div>
        <div class="field"><label>Company</label><div class="value">${esc(t.company || '—')}</div></div>
        <div class="field"><label>Product / Service</label><div class="value">${esc(t.product_service || '—')}</div></div>
        <div class="field"><label>Category</label><div class="value">${esc(t.category)}</div></div>
        <div class="field"><label>Assigned Team</label><div class="value">${esc(t.assigned_team || '—')}</div></div>
        <div class="field"><label>Language</label><div class="value">${esc(t.language || 'en')}</div></div>
        <div class="field"><label>AI Confidence</label><div class="value">${confBar(t.confidence_score)}</div></div>
        <div class="field"><label>Spam Score</label><div class="value">${confBar(t.spam_score || 0)}</div></div>
        <div class="field"><label>Received</label><div class="value">${fmtDate(t.received_at)}</div></div>
        <div class="field"><label>SLA Due</label><div class="value ${slaClass}">${fmtDate(t.sla_due_at)}</div></div>
        <div class="field"><label>Acknowledged</label><div class="value">${t.acknowledged ? '✓ ' + fmtDate(t.acknowledged_at) : '—'}</div></div>
        <div class="field"><label>First Response</label><div class="value">${t.first_response_at ? fmtDate(t.first_response_at) : '—'}</div></div>
        <div class="field"><label>Resolved</label><div class="value">${t.resolved_at ? fmtDate(t.resolved_at) : '—'}</div></div>
        <div class="field"><label>Last updated</label><div class="value">${fmtDate(t.last_updated)}</div></div>
        <div class="field"><label>Duplicate of</label><div class="value">${t.duplicate_of ? `<a href="/ticket.html?id=${esc(t.duplicate_of)}">${esc(t.duplicate_of)}</a>` : '—'}</div></div>
      </div>

      <div class="field" style="margin-top:14px"><label>AI Issue Summary</label><div>${esc(t.issue_summary || '—')}</div></div>
      <div class="field"><label>AI Detailed Description</label><div>${esc(t.detailed_description || '—')}</div></div>
      <div class="field">
        <label>AI Suggested Tags</label>
        <div class="tags">${(t.suggested_tags || []).map((tg) => `<span class="tag">${esc(tg)}</span>`).join('') || '—'}</div>
      </div>
    </div>

    <div class="detail-grid">
      <!-- Left: original email + manual review -->
      <div>
        <div class="card">
          <h3>Original Email</h3>
          <div class="field"><label>From</label><div class="value">${esc(t.sender_name || '')} ${t.sender_name ? '&lt;' : ''}${esc(t.sender_email)}${t.sender_name ? '&gt;' : ''}</div></div>
          <div class="field"><label>Subject</label><div class="value">${esc(t.email_subject)}</div></div>
          <div class="field"><label>Body</label><pre class="code" style="max-height:300px">${esc(t.email_body || '(empty)')}</pre></div>
          ${t.pii_redacted_body && t.pii_redacted_body !== t.email_body ? `
            <div class="field"><label>PII-Redacted Body (safe to share externally)</label><pre class="code" style="max-height:200px;background:#064e3b;color:#d1fae5">${esc(t.pii_redacted_body)}</pre></div>` : ''}
          ${attachments && attachments.length ? `
            <div class="field"><label>Attachments (${attachments.length})</label>
              <div>${attachments.map((a) => `<a class="btn btn-ghost btn-sm" href="/api/tickets/${encodeURIComponent(t.id)}/attachments/${encodeURIComponent(a.id)}" target="_blank">📎 ${esc(a.filename)} (${Math.round((a.size_bytes||0)/1024)}KB)</a>`).join(' ')}</div>
            </div>` : ''}
        </div>

        <div class="card">
          <h3>AI Insights</h3>
          <div class="row">
            <button class="btn btn-sm" id="suggest-resolution-btn">Generate Resolution Plan</button>
            <button class="btn btn-ghost btn-sm" id="suggest-reply-btn">Draft Customer Reply</button>
          </div>
          <pre class="code" id="suggest-resolution-out" style="display:none;margin-top:10px;max-height:300px"></pre>
          <pre class="code" id="suggest-reply-out" style="display:none;margin-top:10px;max-height:300px"></pre>
        </div>

        <div class="card">
          <h3>Manual Review — Edit Ticket</h3>
          <form id="edit-form">
            <div class="field-grid">
              <div class="field"><label>Subject</label><input type="text" name="email_subject" value="${esc(t.email_subject || '')}" /></div>
              <div class="field"><label>Customer Name</label><input type="text" name="customer_name" value="${esc(t.customer_name || '')}" /></div>
              <div class="field">
                <label>Category</label>
                <select name="category">${CATEGORIES.map((c) => `<option ${c === t.category ? 'selected' : ''}>${c}</option>`).join('')}</select>
              </div>
              <div class="field">
                <label>Priority</label>
                <select name="priority">${PRIORITIES.map((p) => `<option ${p === t.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>
              </div>
              <div class="field">
                <label>Status</label>
                <select name="status">${STATUSES.map((s) => `<option ${s === t.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
              </div>
              <div class="field">
                <label>Assigned Team</label>
                <select name="assigned_team">${TEAMS.map((tm) => `<option ${tm === t.assigned_team ? 'selected' : ''}>${tm}</option>`).join('')}</select>
              </div>
              <div class="field">
                <label>Sentiment</label>
                <select name="sentiment">${SENTIMENTS.map((s) => `<option ${s === t.sentiment ? 'selected' : ''}>${s}</option>`).join('')}</select>
              </div>
              <div class="field">
                <label>Product / Service</label>
                <input type="text" name="product_service" value="${esc(t.product_service || '')}" />
              </div>
            </div>
            <div class="field"><label>Issue Summary</label><input type="text" name="issue_summary" value="${esc(t.issue_summary || '')}" /></div>
            <div class="field"><label>Detailed Description</label><textarea name="detailed_description" rows="3">${esc(t.detailed_description || '')}</textarea></div>
            <div class="row">
              <button type="submit" class="btn">Save Changes</button>
              <button type="button" class="btn btn-ghost" id="assign-best-btn">Auto-assign Best Agent</button>
              <button type="button" class="btn btn-ghost" id="escalate-btn">Escalate</button>
              <span id="edit-status" class="muted"></span>
            </div>
          </form>

          <hr class="divider" />

          <h3>Internal Notes</h3>
          <div id="notes-list">${notes.length ? notes.map((n) => `
            <div style="margin-bottom:6px;padding:8px;background:#fafbfc;border-radius:6px;font-size:13px">
              <div class="muted" style="font-size:11px">${fmtDate(n.created_at)} · ${esc(n.author)}</div>
              <div>${esc(n.note)}</div>
            </div>`).join('') : '<p class="muted">No notes yet.</p>'}</div>
          <form id="note-form" style="margin-top:8px">
            <textarea name="note" rows="2" placeholder="Add an internal note…"></textarea>
            <div class="row"><button type="submit" class="btn btn-sm">Add Note</button></div>
          </form>
        </div>
      </div>

      <!-- Right: audit timeline + escalations -->
      <div>
        <div class="card">
          <h3>Audit Trail (${audit.length})</h3>
          <ul class="timeline">
            ${audit.slice().reverse().map((a) => `
              <li>
                <div class="when">${fmtDate(a.created_at)} · ${esc(a.actor)}</div>
                <div class="what">${esc(a.action)}${a.field ? ' / ' + esc(a.field) : ''}</div>
                ${a.old_value != null || a.new_value != null ? `<div class="muted" style="font-size:11px">${esc(a.old_value ?? '')} → ${esc(a.new_value ?? '')}</div>` : ''}
                ${a.metadata ? `<div class="muted" style="font-size:11px">${esc(a.metadata)}</div>` : ''}
              </li>`).join('') || '<li class="muted">No audit events.</li>'}
          </ul>
        </div>

        ${escalations && escalations.length ? `
          <div class="card">
            <h3 style="color:#dc2626">Escalation History</h3>
            <ul class="timeline">
              ${escalations.map((e) => `
                <li>
                  <div class="when">${fmtDate(e.created_at)}${e.resolved_at ? ' → resolved ' + fmtDate(e.resolved_at) : ''}</div>
                  <div class="what">Level ${e.escalation_level || e.level}</div>
                  <div class="muted" style="font-size:11px">${esc(e.reason)}</div>
                </li>`).join('')}
            </ul>
          </div>` : ''}

        <div class="card">
          <h3>Raw AI Response</h3>
          <pre class="code" style="max-height:300px;font-size:11px">${esc(t.raw_ai_response || '—')}</pre>
        </div>
      </div>
    </div>
  `;

  // Wire up edit form
  document.getElementById('edit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const patch = Object.fromEntries(fd.entries());
    document.getElementById('edit-status').textContent = 'saving…';
    try {
      await postJSON(`${API}/tickets/${encodeURIComponent(t.id)}`, patch, 'PATCH');
      document.getElementById('edit-status').textContent = '✓ saved';
      toast('Ticket updated', 'success');
      load();
    } catch (err) {
      document.getElementById('edit-status').textContent = '';
      toast('Save failed: ' + err.message, 'error');
    }
  });

  // Wire up note form
  document.getElementById('note-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const note = e.target.elements.note.value.trim();
    if (!note) return;
    try {
      await postJSON(`${API}/tickets/${encodeURIComponent(t.id)}/notes`, { note });
      e.target.reset();
      toast('Note added', 'success');
      load();
    } catch (err) {
      toast('Note failed: ' + err.message, 'error');
    }
  });

  // AI reply suggestion
  document.getElementById('suggest-reply-btn').addEventListener('click', async () => {
    const out = document.getElementById('suggest-reply-out');
    out.style.display = '';
    out.textContent = 'Generating…';
    try {
      const r = await postJSON(`${API}/tickets/${encodeURIComponent(t.id)}/suggest-reply`);
      out.textContent = r.text + (r.usedMock ? '\n\n— (mock)' : '');
    } catch (err) { out.textContent = 'Error: ' + err.message; }
  });

  // AI resolution suggestion
  document.getElementById('suggest-resolution-btn').addEventListener('click', async () => {
    const out = document.getElementById('suggest-resolution-out');
    out.style.display = '';
    out.textContent = 'Generating resolution plan…';
    try {
      const r = await postJSON(`${API}/tickets/${encodeURIComponent(t.id)}/suggest-resolution`);
      out.textContent =
        `Diagnosis: ${r.diagnosis}\n\n` +
        `Steps:\n${r.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n\n` +
        `Effort: ${r.estimated_effort}\n` +
        `Needs engineering: ${r.needs_engineering ? 'yes' : 'no'}\n` +
        `Confidence: ${r.confidence}%` +
        (r.usedMock ? '\n\n— (mock)' : '');
    } catch (err) { out.textContent = 'Error: ' + err.message; }
  });

  // Auto-assign best agent
  document.getElementById('assign-best-btn')?.addEventListener('click', async () => {
    try {
      const r = await postJSON(`${API}/tickets/${encodeURIComponent(t.id)}/assign-best`, {});
      toast(`Assigned to ${r.agent.name}`, 'success');
      load();
    } catch (err) { toast('Assign failed: ' + err.message, 'error'); }
  });

  // Manual escalate
  document.getElementById('escalate-btn')?.addEventListener('click', async () => {
    try {
      const r = await postJSON(`${API}/tickets/${encodeURIComponent(t.id)}/escalate`, {});
      toast(`Escalated to level ${r.level}`, 'success');
      load();
    } catch (err) { toast('Escalate failed: ' + err.message, 'error'); }
  });
}

load();
