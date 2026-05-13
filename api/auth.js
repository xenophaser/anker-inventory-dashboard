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
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI not configured' });

    const SB_URL = "https://sxwtqrxpqonyqkalcyuj.supabase.co";
    const SB_KEY = process.env.SUPABASE_KEY || "sb_publishable_GcNpfiTWoNgkRmAbXM_X2w_RDcGM18R";
    const SB_HEADERS = {
      'Content-Type': 'application/json',
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`
    };

    // Wrap any promise with a timeout so one slow step can't hang the whole function
    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout: ${label} took >${ms}ms`)), ms)
        )
      ]);
    }

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
            'Prefer': cmd.type === 'select'
              ? 'return=representation'
              : 'resolution=ignore-duplicates,return=minimal'
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

    // ── Inventory snapshot (3s timeout, non-fatal) ─────────
    let inventoryContext = '';
    try {
      const [stockRes, dispRes, rmaRes] = await withTimeout(
        Promise.all([
          fetch(`${SB_URL}/rest/v1/inventory?status=eq.in-stock&select=serial,sku,sku_code&limit=1000`, { headers: SB_HEADERS }),
          fetch(`${SB_URL}/rest/v1/inventory?status=eq.dispatched&select=count`, {
            headers: { ...SB_HEADERS, 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' }
          }),
          fetch(`${SB_URL}/rest/v1/inventory?status=eq.rma&select=count`, {
            headers: { ...SB_HEADERS, 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0' }
          })
        ]),
        3000,
        'inventory snapshot'
      );

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
    } catch (e) {
      inventoryContext = `\n(Inventory snapshot unavailable: ${e.message})\n`;
    }

    const SYSTEM = `You are an inventory assistant for Windmar's Anker warehouse in Puerto Rico. You help manage inventory by generating JSON commands executed against a Supabase database.

The inventory table has: serial (PK), sku (model name), sku_code, status ("in-stock"/"dispatched"/"rma"), ref, notes, updated_at.
The activity_log table has: msg, type ("dispatch"/"rma"/"add"/""), serial, reason, notes, ts.
${inventoryContext}
When the user asks you to make a change, respond ONLY with a valid JSON object (no markdown, no extra text, no explanation outside the JSON):
{
  "reply": "Human readable description of the intended action",
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
- Always include updated_at as current ISO timestamp for inventory changes.
- For bulk operations (multiple serials), emit one insert command per serial — but cap at 50 commands per response. If more are needed, tell the user to split into batches.
- IMPORTANT: Do NOT optimistically claim success in the reply — describe the intended action only. Actual success/failure will be appended automatically.
- Be conversational and concise.
- NEVER make up serials or data — only act on what the user provides or what the database confirms.`;

    const messages = [
      ...(history || []).slice(-10), // limit history to last 10 turns to reduce token count
      { role: 'user', content: message }
    ];

    // ── Call AI (6s timeout) ───────────────────────────────
    let text = '';
    try {
      const aiResponse = await withTimeout(
        fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001', // faster model = less timeout risk
            max_tokens: 1024,
            system: SYSTEM,
            messages
          })
        }).then(r => r.json()),
        6000,
        'AI response'
      );

      text = aiResponse.content?.[0]?.text || '';
    } catch (e) {
      return res.status(200).json({
        reply: `⏱ The request timed out (${e.message}). Try a simpler request or split bulk operations into smaller batches.`,
        results: [],
        commandCount: 0,
        errors: [e.message]
      });
    }

    if (!text) {
      return res.status(200).json({
        reply: 'No response from AI — try again.',
        results: [],
        commandCount: 0
      });
    }

    // ── Parse AI response ──────────────────────────────────
    let parsed;
    try {
      const clean = text.replace(/```json\n?|```/g, '').trim();
      parsed = JSON.parse(clean);
    } catch(e) {
      // If the AI returned plain text instead of JSON, just show it
      return res.status(200).json({
        reply: text,
        results: [],
        commandCount: 0
      });
    }

    const commands = (parsed.commands || []).slice(0, 50); // hard cap

    // ── Run commands in parallel batches of 5 ─────────────
    const results = [];
    const errors = [];
    let successCount = 0;

    // Split into batches to avoid hammering Supabase but still be faster than serial
    const BATCH_SIZE = 5;
    for (let i = 0; i < commands.length; i += BATCH_SIZE) {
      const batch = commands.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(cmd => runCommand(cmd)));
      for (const result of batchResults) {
        if (result.ok) {
          if (result.rows) results.push(result.rows);
          if (result.cmd.type !== 'select') successCount++;
        } else {
          errors.push(`[${result.cmd.type} ${result.cmd.table}${result.cmd.match ? ' where ' + result.cmd.match : ''}] ${result.error}`);
          console.error('Supabase command failed:', result);
        }
      }
    }

    // ── Build final reply ──────────────────────────────────
    let finalReply = parsed.reply || text;
    const totalCmds = commands.filter(c => c.type !== 'select').length;

    if (errors.length > 0 && successCount === 0) {
      finalReply = `❌ Failed — nothing was saved.\n` + errors.map(e => `• ${e}`).join('\n');
    } else if (errors.length > 0) {
      finalReply += `\n\n⚠️ Partial: ${successCount}/${totalCmds} succeeded.\n` + errors.map(e => `• ${e}`).join('\n');
    } else if (totalCmds > 0) {
      finalReply += ` ✓ (${successCount} change${successCount !== 1 ? 's' : ''} saved)`;
    }

    return res.status(200).json({
      reply: finalReply,
      results,
      commandCount: totalCmds,
      errors
    });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
