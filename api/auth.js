export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, password, message, history } = req.body;

  if (action === 'auth') {
    const correct = process.env.EDIT_PASSWORD;
    if (!correct) return res.status(500).json({ error: 'Server not configured' });
    return password === correct
      ? res.status(200).json({ ok: true })
      : res.status(401).json({ ok: false, error: 'Wrong password' });
  }

  if (action === 'chat') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI not configured' });

    const SB_URL = "https://sxwtqrxpqonyqkalcyuj.supabase.co";
    const SB_KEY = process.env.SUPABASE_KEY || "sb_publishable_GcNpfiTWoNgkRmAbXM_X2w_RDcGM18R";
    const SB_HEADERS = {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`
    };

    async function runCommand(cmd) {
      try {
        let url = `${SB_URL}/rest/v1/${cmd.table}`;
        if (cmd.match) {
          const eqIdx = cmd.match.indexOf('=eq.');
          if (eqIdx !== -1) {
            const col = cmd.match.slice(0, eqIdx);
            const val = cmd.match.slice(eqIdx + 4);
            url += `?${col}=eq.${encodeURIComponent(val)}`;
          } else {
            url += `?${cmd.match}`;
          }
        }

        const method = cmd.type === 'insert' ? 'POST'
          : cmd.type === 'update' ? 'PATCH'
          : cmd.type === 'delete' ? 'DELETE'
          : 'GET';

        const sbRes = await fetch(url, {
          method,
          headers: {
            ...SB_HEADERS,
            'Prefer': cmd.type === 'select' ? 'return=representation' : 'resolution=ignore-duplicates,return=minimal'
          },
          body: cmd.data ? JSON.stringify(cmd.data) : undefined
        });

        if (!sbRes.ok) {
          let errBody = '';
          try { errBody = await sbRes.text(); } catch(_) {}
          return { ok: false, status: sbRes.status, error: errBody || `HTTP ${sbRes.status}`, cmd };
        }

        if (cmd.type === 'select') {
          const rows = await sbRes.json();
          return { ok: true, rows, cmd };
        }

        return { ok: true, cmd };
      } catch (e) {
        return { ok: false, error: e.message, cmd };
      }
    }

    let inventoryContext = '';
    try {
      const [stockRes, dispRes, rmaRes] = await Promise.all([
        fetch(`${SB_URL}/rest/v1/inventory?status=eq.in-stock&select=serial,sku,sku_code&limit=1000`, { headers: SB_HEADERS }),
        fetch(`${SB_URL}/rest/v1/inventory?status=eq.dispatched&select=count`, { headers: { ...SB_HEADERS, 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } }),
        fetch(`${SB_URL}/rest/v1/inventory?status=eq.rma&select=count`, { headers: { ...SB_HEADERS, 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' } })
      ]);

      const stockItems = stockRes.ok ? await stockRes.json() : [];
      const dispCount = dispRes.headers.get('content-range')?.split('/')?.[1] || '?';
      const rmaCount = rmaRes.headers.get('content-range')?.split('/')?.[1] || '?';

      const modelMap = {};
      for (const item of stockItems) {
        if (!modelMap[item.sku]) modelMap[item.sku] = { skuCode: item.sku_code || '', count: 0 };
        modelMap[item.sku].count++;
      }
      const modelLines = Object.entries(modelMap)
        .map(([sku, d]) => `  - ${sku}${d.skuCode ? ' [' + d.skuCode + ']' : ''}: ${d.count} in stock`)
        .join('\n');

      inventoryContext = `\nCURRENT INVENTORY SNAPSHOT (live from database):
In stock: ${stockItems.length} units across these models:
${modelLines || '  (none)'}
Dispatched: ${dispCount} units total
RMA: ${rmaCount} units total\n`;
    } catch (_) {
      inventoryContext = '\n(Could not load inventory snapshot)\n';
    }

    const SYSTEM = `You are an inventory assistant for Windmar's Anker warehouse in Puerto Rico. You help manage inventory by generating JSON commands executed against a Supabase database.

The inventory table has: serial (PK), sku (model name), sku_code, status ("in-stock"/"dispatched"/"rma"), ref, notes, updated_at.
The activity_log table has: msg, type ("dispatch"/"rma"/"add"/""), serial, reason, notes, ts.
${inventoryContext}
When the user asks you to make a change, respond ONLY with a JSON object (no markdown, no extra text):
{
  "reply": "Human readable confirmation of exactly what was done",
  "commands": [
    { "type": "insert"|"update"|"delete"|"select", "table": "inventory"|"activity_log", "data": {}, "match": "column=eq.value" }
  ]
}

For read-only questions respond with: { "reply": "your answer", "commands": [] }

Rules:
- Always log to activity_log when making changes (include msg, type, serial if applicable, ts as ISO string)
- Dispatching serials: PATCH inventory set status="dispatched". Always verify the serial exists in-stock first with a select.
- If asked to dispatch a serial not in the snapshot above, do a select first to check before updating.
- When adding units WITH serials: use the exact serial strings provided. Each serial = one insert command.
- When adding WITHOUT serials: use serial "NO-SN-<SKUCODE>-<timestamp_ms>" where timestamp_ms is a 13-digit number. Never reuse the same timestamp for multiple placeholder serials — increment by 1 for each.
- Always include updated_at as current ISO timestamp for inventory changes
- For bulk operations (multiple serials), emit one insert command per serial
- IMPORTANT: Do NOT optimistically claim success in the reply — the reply should describe the intended action. Actual success/failure will be appended automatically.
- Be conversational and concise
- NEVER make up serials or data — only act on what the user provides or what the database confirms`;

    const messages = [
      ...(history || []),
      { role: 'user', content: message }
    ];

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          system: SYSTEM,
          messages
        })
      });

      const data = await response.json();
      const text = data.content?.[0]?.text || '';

      if (!text) {
        return res.status(200).json({ reply: 'No response from AI — try again.', results: [], commandCount: 0 });
      }

      let parsed;
      try {
        const clean = text.replace(/```json\n?|```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch(e) {
        parsed = { reply: text, commands: [] };
      }

      const results = [];
      const errors = [];
      let successCount = 0;

      for (const cmd of (parsed.commands || [])) {
        const result = await runCommand(cmd);
        if (result.ok) {
          if (result.rows) results.push(result.rows);
          if (cmd.type !== 'select') successCount++;
        } else {
          errors.push(`[${cmd.type} ${cmd.table}${cmd.match ? ' where ' + cmd.match : ''}] ${result.error}`);
          console.error('Supabase command failed:', result);
        }
      }

      // Build a clear final reply that reflects actual outcome
      let finalReply = parsed.reply || text;
      const totalCmds = (parsed.commands || []).filter(c => c.type !== 'select').length;

      if (errors.length > 0 && successCount === 0) {
        // Everything failed
        finalReply = `❌ Failed — nothing was saved. ${errors.length} error(s):\n` + errors.map(e => `• ${e}`).join('\n');
      } else if (errors.length > 0) {
        // Partial success
        finalReply += `\n\n⚠️ Partial: ${successCount}/${totalCmds} succeeded. ${errors.length} failed:\n` + errors.map(e => `• ${e}`).join('\n');
      } else if (totalCmds > 0) {
        // Full success — append a confirmation tick
        finalReply += ` ✓ (${successCount} change${successCount !== 1 ? 's' : ''} saved)`;
      }

      return res.status(200).json({
        reply: finalReply,
        results,
        commandCount: totalCmds,
        errors
      });

    } catch(e) {
      console.error('AI handler error:', e);
      return res.status(500).json({ error: 'AI request failed: ' + e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
