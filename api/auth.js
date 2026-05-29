export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, password, message, history } = req.body;

  // ── Auth ──────────────────────────────────────────────────
  if (action === 'auth') {
    const correct = process.env.EDIT_PASSWORD;
    if (!correct) return res.status(500).json({ error: 'Server not configured' });
    return password === correct
      ? res.status(200).json({ ok: true })
      : res.status(401).json({ ok: false, error: 'Wrong password' });
  }

  // ── Chat ──────────────────────────────────────────────────
  if (action === 'chat') {
    const correct = process.env.EDIT_PASSWORD;
    if (!correct) return res.status(500).json({ error: 'Server not configured' });
    if (password !== correct) {
      return res.status(401).json({ error: 'Unauthorized — unlock editor first' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI not configured' });

    const SB_URL = "https://sxwtqrxpqonyqkalcyuj.supabase.co";
    const SB_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN4d3RxcnhwcW9ueXFrYWxjeXVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NTQxMzQsImV4cCI6MjA5MzIzMDEzNH0.PXiX55-3lhwAf5rSoUPl3A2b5PgThjRw5oNBd50IC9E";
    const SB_HEADERS = {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`
    };

    // ── Tool implementations ───────────────────────────────
    async function tool_get_inventory({ sku_code, sku_name, status, location, limit = 100 }) {
      const baseParams = new URLSearchParams();
      baseParams.append('select', 'serial,sku,sku_code,status,location');
      if (sku_code) baseParams.append('sku_code', `eq.${sku_code}`);
      if (sku_name) baseParams.append('sku', `ilike.*${sku_name}*`);
      if (status)   baseParams.append('status', `eq.${status}`);
      if (location) baseParams.append('location', `eq.${location}`);

      // Paginate to get ALL matching rows
      let allRows = [];
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const p = new URLSearchParams(baseParams);
        p.append('limit', String(pageSize));
        p.append('offset', String(offset));
        const r = await fetch(`${SB_URL}/rest/v1/inventory?${p}`, { headers: SB_HEADERS });
        if (!r.ok) throw new Error(`Supabase error: ${await r.text()}`);
        const rows = await r.json();
        allRows = allRows.concat(rows);
        if (rows.length < pageSize) break;
        offset += pageSize;
        if (offset > 10000) break;
      }

      if (allRows.length > 50) {
        const byStatus = {};
        const byLocation = {};
        for (const row of allRows) {
          byStatus[row.status] = (byStatus[row.status] || 0) + 1;
          if (row.location) byLocation[row.location] = (byLocation[row.location] || 0) + 1;
        }
        return { exact_total_in_database: allRows.length, by_status: byStatus, by_location: byLocation };
      }
      return allRows;
    }

    async function tool_get_serial({ serial }) {
      const r = await fetch(`${SB_URL}/rest/v1/inventory?serial=eq.${encodeURIComponent(serial)}&select=serial,sku,sku_code,status,location,ref,notes,updated_at`, { headers: SB_HEADERS });
      if (!r.ok) throw new Error(`Supabase error: ${await r.text()}`);
      const rows = await r.json();
      return rows[0] || null;
    }

    async function tool_dispatch_unit({ serial, ref }) {
      const now = new Date().toISOString();
      // Verify exists and is in-stock
      const item = await tool_get_serial({ serial });
      if (!item) return { ok: false, error: `Serial ${serial} not found` };
      if (item.status !== 'in-stock') return { ok: false, error: `Serial ${serial} is ${item.status}, not in-stock` };
      // Update inventory
      await fetch(`${SB_URL}/rest/v1/inventory?serial=eq.${encodeURIComponent(serial)}`, {
        method: 'PATCH', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: 'dispatched', ref: ref || '', location: null, updated_at: now })
      });
      // Log
      await fetch(`${SB_URL}/rest/v1/activity_log`, {
        method: 'POST', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ msg: `Dispatched via AI: ${serial}${ref ? ' [' + ref + ']' : ''}`, type: 'dispatch', serial, ts: now })
      });
      return { ok: true, serial, model: item.sku };
    }

    async function tool_log_return({ serial, reason, notes }) {
      const now = new Date().toISOString();
      const RESTOCK = ["No cambio", "Re coordinado", "Cancelado", "Back to stock"];
      const newStatus = RESTOCK.includes(reason) ? 'in-stock' : 'rma';
      const item = await tool_get_serial({ serial });
      if (!item) return { ok: false, error: `Serial ${serial} not found` };
      await fetch(`${SB_URL}/rest/v1/inventory?serial=eq.${encodeURIComponent(serial)}`, {
        method: 'PATCH', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ status: newStatus, updated_at: now })
      });
      const logMsg = newStatus === 'in-stock'
        ? `Returned to stock via AI: ${serial} — ${reason}${notes ? ' (' + notes + ')' : ''}`
        : `RMA via AI: ${serial} — ${reason}${notes ? ' (' + notes + ')' : ''}`;
      await fetch(`${SB_URL}/rest/v1/activity_log`, {
        method: 'POST', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ msg: logMsg, type: 'rma', serial, reason, notes: notes || '', ts: now })
      });
      return { ok: true, serial, new_status: newStatus, model: item.sku };
    }

    async function tool_update_location({ serial, location }) {
      const item = await tool_get_serial({ serial });
      if (!item) return { ok: false, error: `Serial ${serial} not found` };
      await fetch(`${SB_URL}/rest/v1/inventory?serial=eq.${encodeURIComponent(serial)}`, {
        method: 'PATCH', headers: { ...SB_HEADERS, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ location: location || null })
      });
      return { ok: true, serial, location: location || null };
    }

    async function tool_get_activity_log({ limit = 20, type, date_from, date_after }) {
      const params = new URLSearchParams();
      params.append('select', 'msg,type,serial,reason,notes,ts');
      params.append('order', 'ts.desc');
      params.append('limit', String(Math.min(limit, 100)));
      if (type)       params.append('type', `eq.${type}`);
      if (date_from)  params.append('ts', `gte.${date_from}`);
      if (date_after) params.append('ts', `gte.${date_after}`);
      const r = await fetch(`${SB_URL}/rest/v1/activity_log?${params}`, { headers: SB_HEADERS });
      if (!r.ok) throw new Error(`Supabase error: ${await r.text()}`);
      return await r.json();
    }

    async function tool_get_inventory_summary() {
      const params = new URLSearchParams();
      params.append('select', 'sku,sku_code,status');
      params.append('limit', '5000');
      const r = await fetch(`${SB_URL}/rest/v1/inventory?${params}`, { headers: SB_HEADERS });
      if (!r.ok) throw new Error(`Supabase error: ${await r.text()}`);
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

    // ── Tool definitions for Claude ────────────────────────
    const TOOLS = [
      {
        name: "get_inventory_summary",
        description: "Get a summary of all inventory models with in-stock, dispatched, and RMA counts. Use this for general inventory questions.",
        input_schema: { type: "object", properties: {}, required: [] }
      },
      {
        name: "get_inventory",
        description: "Get a list of inventory units, optionally filtered by model name (partial), SKU code, status, or location. Use sku_name for partial model name search (e.g. 'C300X', 'F2600', '400W').",
        input_schema: {
          type: "object",
          properties: {
            sku_name: { type: "string", description: "Partial model name to search, e.g. 'C300X', 'F2600', '400W', 'BP2600'" },
            sku_code: { type: "string", description: "Filter by exact SKU code, e.g. 'A1723111'" },
            status: { type: "string", enum: ["in-stock", "dispatched", "rma"], description: "Filter by status" },
            location: { type: "string", description: "Filter by warehouse location, e.g. 'NDC3'" },
            limit: { type: "integer", description: "Max results (default 1000, max 2000)" }
          },
          required: []
        }
      },
      {
        name: "get_serial",
        description: "Look up a specific unit by serial number.",
        input_schema: {
          type: "object",
          properties: {
            serial: { type: "string", description: "The serial number to look up" }
          },
          required: ["serial"]
        }
      },
      {
        name: "dispatch_unit",
        description: "Dispatch a unit — marks it as dispatched, clears its location, and logs the activity. Only works for in-stock units.",
        input_schema: {
          type: "object",
          properties: {
            serial: { type: "string", description: "Serial number to dispatch" },
            ref: { type: "string", description: "Order or reference number (optional)" }
          },
          required: ["serial"]
        }
      },
      {
        name: "log_return",
        description: "Log a unit return or RMA. Reasons that return to stock: 'No cambio', 'Re coordinado', 'Cancelado', 'Back to stock'. Reasons that flag as RMA: 'Damaged', 'Other'.",
        input_schema: {
          type: "object",
          properties: {
            serial: { type: "string", description: "Serial number being returned" },
            reason: { type: "string", enum: ["No cambio", "Re coordinado", "Cancelado", "Back to stock", "Damaged", "Other"], description: "Return reason" },
            notes: { type: "string", description: "Optional notes" }
          },
          required: ["serial", "reason"]
        }
      },
      {
        name: "update_location",
        description: "Update the warehouse location for a specific unit.",
        input_schema: {
          type: "object",
          properties: {
            serial: { type: "string", description: "Serial number" },
            location: { type: "string", description: "New location code, e.g. 'NDC3'. Leave empty to clear." }
          },
          required: ["serial"]
        }
      },
      {
        name: "get_activity_log",
        description: "Get recent activity log entries, optionally filtered by type or date.",
        input_schema: {
          type: "object",
          properties: {
            limit: { type: "integer", description: "Number of entries to return (default 20, max 100)" },
            type: { type: "string", enum: ["dispatch", "rma", "add"], description: "Filter by activity type" },
            date_from: { type: "string", description: "ISO date string to filter from, e.g. '2026-05-01T00:00:00Z'" }
          },
          required: []
        }
      }
    ];

    const SYSTEM = `You are an inventory assistant for Windmar's Anker warehouse in Puerto Rico.

You have access to tools that let you query and update the warehouse inventory in real time.

The warehouse uses location codes like NDC3, NDB4, NDC5, etc. (N=Norte, D=rack D, C/B=floor, number=section).

Model shortcuts (use sku_name with these):
- "C300X" or "c300x" → Anker SOLIX C300X (sku_code: A1723111)
- "F2600" → Anker SOLIX F2600 (sku_code: A1781111)
- "F3800" or "F3800Plus" → Anker SOLIX F3800 Plus
- "400W" or "400w" → Anker SOLIX 400W Portable Solar Panel
- "200W" → Anker SOLIX 200W Portable Solar Panel
- "BP2600" → Anker SOLIX BP2600 Expansion Battery
- "BP3800" → Anker SOLIX BP3800 Expansion Battery
- "ATS" → Anker SOLIX Home Power Panel
- "GIA" → Anker SOLIX Generator Input Adapter
- "EverFrost" → Anker SOLIX EverFrost 40L

When the user mentions a model by short name, use sku_name with the short name — do NOT ask them to spell out the full name.

Guidelines:
- Always verify a serial exists before taking action on it
- For dispatch: confirm the unit is in-stock first
- Be concise and clear in your responses — warehouse staff are busy
- When showing inventory lists, format them clearly
- IMPORTANT: When get_inventory returns a summary object, always use 'exact_total_in_database' as the true count — never sum up by_status or by_location values as they may be incomplete
- For bulk operations, warn the user and confirm before proceeding
- Respond in the same language the user writes in (Spanish or English)`;

    // ── Agentic tool-use loop ──────────────────────────────
    const cleanHistory = (history || []).slice(-10).filter(m => typeof m.content === 'string');
    let messages = [...cleanHistory, { role: 'user', content: message }];

    let finalReply = '';
    let commandCount = 0;
    const MAX_ITERATIONS = 5;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      let aiData;
      try {
        const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            system: SYSTEM,
            tools: TOOLS,
            messages
          })
        });
        aiData = await aiRes.json();
      } catch (e) {
        return res.status(200).json({ reply: `Connection error: ${e.message}`, commandCount: 0 });
      }

      // Add assistant response to messages
      messages.push({ role: 'assistant', content: aiData.content });

      // Check stop reason
      if (aiData.stop_reason === 'end_turn') {
        // Extract text reply
        const textBlock = aiData.content.find(b => b.type === 'text');
        finalReply = textBlock?.text || 'Done.';
        break;
      }

      if (aiData.stop_reason === 'tool_use') {
        // Execute all tool calls
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
          } catch (e) {
            result = { error: e.message };
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result)
          });
        }
        // Feed results back
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop
      finalReply = 'Unexpected response from AI.';
      break;
    }

    return res.status(200).json({ reply: finalReply || 'Done.', commandCount });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
