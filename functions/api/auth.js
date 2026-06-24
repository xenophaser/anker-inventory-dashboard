export async function onRequestPost(context) {
  const { request, env } = context;

  const SB_URL = "https://sxwtqrxpqonyqkalcyuj.supabase.co";
const SB_KEY = env.SUPABASE_KEY;
if (!SB_KEY) return Response.json({ error: 'Server misconfigured' }, { status: 500 });  const SB_HEADERS = {
    'Content-Type': 'application/json',
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`
  };

  let body;
  try { body = await request.json(); }
  catch (e) { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { action, password, message, history, username, pin, userId } = body;

  // ── Login ──────────────────────────────────────────────────
  if (action === 'login') {
    if (!username || !pin) return Response.json({ ok: false, error: 'Missing credentials' }, { status: 400 });
    const r = await fetch(`${SB_URL}/rest/v1/users?username=eq.${encodeURIComponent(username.toLowerCase())}&active=eq.true&select=id,username,display_name,role,pin`, { headers: SB_HEADERS });
    const users = await r.json();
    if (!users.length) return Response.json({ ok: false, error: 'User not found' }, { status: 401 });
    const user = users[0];
    if (user.pin !== pin) return Response.json({ ok: false, error: 'Wrong PIN' }, { status: 401 });
    return Response.json({ ok: true, user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role } });
  }

  // ── Change PIN ─────────────────────────────────────────────
  if (action === 'change_pin') {
    const { userId, currentPin, newPin } = body;
    if (!userId || !currentPin || !newPin) return Response.json({ ok: false, error: 'Missing fields' }, { status: 400 });
    if (newPin.length < 4) return Response.json({ ok: false, error: 'PIN must be at least 4 digits' }, { status: 400 });
    const r = await fetch(`${SB_URL}/rest/v1/users?id=eq.${userId}&select=pin`, { headers: SB_HEADERS });
    const users = await r.json();
    if (!users.length || users[0].pin !== currentPin) return Response.json({ ok: false, error: 'Current PIN incorrect' }, { status: 401 });
    await fetch(`${SB_URL}/rest/v1/users?id=eq.${userId}`, { method: 'PATCH', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' }, body: JSON.stringify({ pin: newPin }) });
    return Response.json({ ok: true });
  }

  // ── Admin: reset another user's PIN ───────────────────────
  if (action === 'admin_reset_pin') {
    const { adminId, adminPin, targetUserId, newPin } = body;
    if (!adminId || !adminPin || !targetUserId || !newPin) return Response.json({ ok: false, error: 'Missing fields' }, { status: 400 });
    const r = await fetch(`${SB_URL}/rest/v1/users?id=eq.${adminId}&select=pin,role`, { headers: SB_HEADERS });
    const admins = await r.json();
    if (!admins.length || admins[0].pin !== adminPin || admins[0].role !== 'admin') return Response.json({ ok: false, error: 'Admin auth failed' }, { status: 401 });
    await fetch(`${SB_URL}/rest/v1/users?id=eq.${targetUserId}`, { method: 'PATCH', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' }, body: JSON.stringify({ pin: newPin }) });
    return Response.json({ ok: true });
  }

  // ── Get users list ─────────────────────────────────────────
  if (action === 'get_users') {
    const r = await fetch(`${SB_URL}/rest/v1/users?select=id,username,display_name,role,active&order=id.asc`, { headers: SB_HEADERS });
    const users = await r.json();
    return Response.json({ users });
  }

  // ── Get driver dispatches ──────────────────────────────────
  if (action === 'get_driver_dispatches') {
    const { driverId } = body;
    if (!driverId) return Response.json({ error: 'Missing driverId' }, { status: 400 });
    const today = new Date().toISOString().slice(0, 10);
    const r = await fetch(`${SB_URL}/rest/v1/dispatches?assigned_to=eq.${driverId}&created_at=gte.${today}T00:00:00Z&order=created_at.desc&select=*`, { headers: SB_HEADERS });
    const dispatches = await r.json();
    return Response.json({ dispatches });
  }

  // ── Save dispatch record ───────────────────────────────────
  if (action === 'save_dispatch') {
    const { caseRef, dispatchType, ticketNum, serials, assignedTo, dispatchedBy } = body;
    const r = await fetch(`${SB_URL}/rest/v1/dispatches`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Prefer': 'return=representation' },
      body: JSON.stringify({
        case_ref: caseRef,
        dispatch_type: dispatchType,
        ticket_num: ticketNum || null,
        serials: JSON.stringify(serials),
        assigned_to: assignedTo || null,
        dispatched_by: dispatchedBy,
        status: assignedTo ? 'pending' : 'delivered'
      })
    });
    const data = await r.json();
    return Response.json({ ok: true, dispatch: data[0] });
  }

  // ── Update dispatch status (driver signs) ─────────────────
  if (action === 'sign_dispatch') {
    const { dispatchId, pdfUrl } = body;
    await fetch(`${SB_URL}/rest/v1/dispatches?id=eq.${dispatchId}`, {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status: 'signed', pdf_url: pdfUrl, signed_at: new Date().toISOString() })
    });
    return Response.json({ ok: true });
  }

  // ── Upload PDF to storage & get signed URL ─────────────────
  if (action === 'upload_receipt') {
    const { fileName, pdfBase64 } = body;
    if (!fileName || !pdfBase64) return Response.json({ error: 'Missing fields' }, { status: 400 });
    const pdfBuffer = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
    const uploadRes = await fetch(`${SB_URL}/storage/v1/object/almacen-recibos/${fileName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` },
      body: pdfBuffer
    });
    if (!uploadRes.ok) return Response.json({ error: 'Upload failed' }, { status: 500 });
    const signRes = await fetch(`${SB_URL}/storage/v1/object/sign/almacen-recibos/${fileName}`, {
      method: 'POST',
      headers: { ...SB_HEADERS },
      body: JSON.stringify({ expiresIn: 604800 })
    });
    const signData = await signRes.json();
    const signedUrl = `${SB_URL}/storage/v1${signData.signedURL}`;
    return Response.json({ ok: true, url: signedUrl });
  }

  // ── Legacy auth (backward compat) ─────────────────────────
  if (action === 'auth') {
    const correct = env.EDIT_PASSWORD;
    if (!correct) return Response.json({ error: 'Server not configured' }, { status: 500 });
    return password === correct
      ? Response.json({ ok: true })
      : Response.json({ ok: false, error: 'Wrong password' }, { status: 401 });
  }

  // ── Chat (AI) ──────────────────────────────────────────────
  if (action === 'chat') {
    const correct = env.EDIT_PASSWORD;
    const validLegacy = correct && password === correct;
    const validUser = body.userId && ['admin', 'dispatcher'].includes(body.userRole);
    if (!validLegacy && !validUser) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) return Response.json({ error: 'AI not configured' }, { status: 500 });

    async function tool_get_inventory({ sku_code, sku_name, status, location }) {
      const baseParams = new URLSearchParams();
      baseParams.append('select', 'serial,sku,sku_code,status,location');
      if (sku_code) baseParams.append('sku_code', `eq.${sku_code}`);
      if (sku_name) baseParams.append('sku', `ilike.*${sku_name}*`);
      if (status)   baseParams.append('status', `eq.${status}`);
      if (location) baseParams.append('location', `eq.${location}`);
      let allRows = [], offset = 0;
      while (true) {
        const p = new URLSearchParams(baseParams);
        p.append('limit', '1000'); p.append('offset', String(offset));
        const r = await fetch(`${SB_URL}/rest/v1/inventory?${p}`, { headers: SB_HEADERS });
        const rows = await r.json();
        allRows = allRows.concat(rows);
        if (rows.length < 1000) break;
        offset += 1000;
        if (offset > 10000) break;
      }
      if (allRows.length > 50) {
        const byStatus = {}, byLocation = {};
        for (const row of allRows) {
          byStatus[row.status] = (byStatus[row.status] || 0) + 1;
          if (row.location) byLocation[row.location] = (byLocation[row.location] || 0) + 1;
        }
        return { exact_total_in_database: allRows.length, by_status: byStatus, by_location: byLocation };
      }
      return allRows;
    }

    async function tool_get_serial({ serial }) {
      const clean = serial.trim().toUpperCase();
      const r = await fetch(`${SB_URL}/rest/v1/inventory?serial=ilike.${encodeURIComponent(clean)}&select=serial,sku,sku_code,status,location,ref,notes,updated_at`, { headers: SB_HEADERS });
      const rows = await r.json();
      return rows[0] || null;
    }

    async function tool_dispatch_unit({ serial, ref }) {
      const clean = serial.trim().toUpperCase();
      const now = new Date().toISOString();
      const item = await tool_get_serial({ serial: clean });
      if (!item) return { ok: false, error: `Serial ${clean} not found` };
      if (item.status !== 'in-stock') return { ok: false, error: `Serial ${clean} is ${item.status}, not in-stock` };
      await fetch(`${SB_URL}/rest/v1/inventory?serial=ilike.${encodeURIComponent(clean)}`, { method: 'PATCH', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' }, body: JSON.stringify({ status: 'dispatched', ref: ref || '', location: null, updated_at: now }) });
      await fetch(`${SB_URL}/rest/v1/activity_log`, { method: 'POST', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' }, body: JSON.stringify({ msg: `Dispatched via AI: ${clean}${ref ? ' [' + ref + ']' : ''}`, type: 'dispatch', serial: clean, ts: now }) });
      return { ok: true, serial: clean, model: item.sku };
    }

    async function tool_log_return({ serial, reason, notes }) {
      const now = new Date().toISOString();
      const RESTOCK = ["No cambio", "Re coordinado", "Cancelado", "Back to stock"];
      const newStatus = RESTOCK.includes(reason) ? 'in-stock' : 'rma';
      const item = await tool_get_serial({ serial });
      if (!item) return { ok: false, error: `Serial ${serial} not found` };
      await fetch(`${SB_URL}/rest/v1/inventory?serial=eq.${encodeURIComponent(serial)}`, { method: 'PATCH', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' }, body: JSON.stringify({ status: newStatus, updated_at: now }) });
      await fetch(`${SB_URL}/rest/v1/activity_log`, { method: 'POST', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' }, body: JSON.stringify({ msg: `${newStatus === 'in-stock' ? 'Returned to stock' : 'RMA'} via AI: ${serial} — ${reason}${notes ? ' (' + notes + ')' : ''}`, type: 'rma', serial, reason, notes: notes || '', ts: now }) });
      return { ok: true, serial, new_status: newStatus };
    }

    async function tool_update_location({ serial, location }) {
      const item = await tool_get_serial({ serial });
      if (!item) return { ok: false, error: `Serial ${serial} not found` };
      await fetch(`${SB_URL}/rest/v1/inventory?serial=eq.${encodeURIComponent(serial)}`, { method: 'PATCH', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' }, body: JSON.stringify({ location: location || null }) });
      return { ok: true, serial, location: location || null };
    }

    async function tool_get_activity_log({ limit = 20, type, date_from }) {
      const params = new URLSearchParams();
      params.append('select', 'msg,type,serial,reason,notes,ts');
      params.append('order', 'ts.desc');
      params.append('limit', String(Math.min(limit, 100)));
      if (type) params.append('type', `eq.${type}`);
      if (date_from) params.append('ts', `gte.${date_from}`);
      const r = await fetch(`${SB_URL}/rest/v1/activity_log?${params}`, { headers: SB_HEADERS });
      return await r.json();
    }

    async function tool_get_inventory_summary() {
      const r = await fetch(`${SB_URL}/rest/v1/inventory?select=sku,sku_code,status&limit=5000`, { headers: SB_HEADERS });
      const rows = await r.json();
      const models = {};
      for (const row of rows) {
        if (!models[row.sku]) models[row.sku] = { sku_code: row.sku_code || '', in_stock: 0, dispatched: 0, rma: 0 };
        if (row.status === 'in-stock') models[row.sku].in_stock++;
        else if (row.status === 'dispatched') models[row.sku].dispatched++;
        else if (row.status === 'rma') models[row.sku].rma++;
      }
      return Object.entries(models).map(([sku, d]) => ({ model: sku, sku_code: d.sku_code, ...d }));
    }

    const TOOLS = [
      { name: "get_inventory_summary", description: "Get a summary of all inventory models with counts.", input_schema: { type: "object", properties: {}, required: [] } },
      { name: "get_inventory", description: "Get inventory units filtered by model name (sku_name partial), SKU code, status, or location.", input_schema: { type: "object", properties: { sku_name: { type: "string" }, sku_code: { type: "string" }, status: { type: "string", enum: ["in-stock","dispatched","rma"] }, location: { type: "string" } }, required: [] } },
      { name: "get_serial", description: "Look up a specific unit by serial number.", input_schema: { type: "object", properties: { serial: { type: "string" } }, required: ["serial"] } },
      { name: "dispatch_unit", description: "Dispatch a unit. Only works for in-stock units.", input_schema: { type: "object", properties: { serial: { type: "string" }, ref: { type: "string" } }, required: ["serial"] } },
      { name: "log_return", description: "Log a return or RMA.", input_schema: { type: "object", properties: { serial: { type: "string" }, reason: { type: "string", enum: ["No cambio","Re coordinado","Cancelado","Back to stock","Damaged","Other"] }, notes: { type: "string" } }, required: ["serial","reason"] } },
      { name: "update_location", description: "Update warehouse location for a unit.", input_schema: { type: "object", properties: { serial: { type: "string" }, location: { type: "string" } }, required: ["serial"] } },
      { name: "get_activity_log", description: "Get activity log entries.", input_schema: { type: "object", properties: { limit: { type: "integer" }, type: { type: "string", enum: ["dispatch","rma","add"] }, date_from: { type: "string" } }, required: [] } }
    ];

    const SYSTEM = `You are an inventory assistant for Windmar's Anker warehouse in Puerto Rico.
Model shortcuts: C300X=A1723111, F2600=A1781111, F3800=F3800Plus, 400W=solar panel, 200W, BP2600, BP3800, ATS=Home Power Panel, GIA=Generator Input Adapter, EverFrost.
Location codes: NDC3-NDC8, NDB3-NDB8, NCA1-NCA7, NAA1, NAB1-NAB2, NAC1, NAC3.
Use sku_name with short names — never ask for full model names.
Always use exact_total_in_database for counts. Respond in the user's language (Spanish or English).`;

    const cleanHistory = (history || []).slice(-10).filter(m => typeof m.content === 'string');
    let messages = [...cleanHistory, { role: 'user', content: message }];
    let finalReply = '', commandCount = 0;

    for (let i = 0; i < 5; i++) {
      const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: SYSTEM, tools: TOOLS, messages })
      });
      const aiData = await aiRes.json();
      messages.push({ role: 'assistant', content: aiData.content });
      if (aiData.stop_reason === 'end_turn') {
        finalReply = aiData.content.find(b => b.type === 'text')?.text || 'Done.';
        break;
      }
      if (aiData.stop_reason === 'tool_use') {
        const toolResults = [];
        for (const block of aiData.content) {
          if (block.type !== 'tool_use') continue;
          commandCount++;
          let result;
          try {
            switch (block.name) {
              case 'get_inventory_summary': result = await tool_get_inventory_summary(); break;
              case 'get_inventory':         result = await tool_get_inventory(block.input); break;
              case 'get_serial':            result = await tool_get_serial(block.input); break;
              case 'dispatch_unit':         result = await tool_dispatch_unit(block.input); break;
              case 'log_return':            result = await tool_log_return(block.input); break;
              case 'update_location':       result = await tool_update_location(block.input); break;
              case 'get_activity_log':      result = await tool_get_activity_log(block.input); break;
              default: result = { error: `Unknown tool: ${block.name}` };
            }
          } catch (e) { result = { error: e.message }; }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }
      finalReply = 'Unexpected response.';
      break;
    }
    return Response.json({ reply: finalReply || 'Done.', commandCount });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400 });
}
