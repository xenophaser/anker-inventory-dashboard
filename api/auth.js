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
    // Require the edit password to use the AI
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
        const params = new URLSearchParams();

        if (cmd.match) {
          const filters = cmd.match.split(',').map(f => f.trim());
          for (const f of filters) {
            const eqIdx = f.indexOf('=eq.');
            if (eqIdx !== -1) {
              params.append(f.slice(0, eqIdx), `eq.${f.slice(eqIdx + 4)}`);
            } else {
              const sep = f.indexOf('=');
              if (sep !== -1) params.append(f.slice(0, sep), f.slice(sep + 1));
            }
          }
        }

        if (cmd.select) params.append('select', cmd.select);
        if (cmd.order)  params.append('order',  cmd.order);
        if (cmd.limit)  params.append('limit',  String(cmd.limit));

        const qs = params.toString();
        if (qs) url += '?' + qs;

        const method = cmd.type === 'insert' ? 'POST'
          : cmd.type === 'update' ? 'PATCH'
          : cmd.type === 'delete' ? 'DELETE'
          : 'GET';

        const isRead = method === 'GET' || method === 'DELETE';
        const sbRes = await fetch(url, {
          method,
          headers: {
            ...SB_HEADERS,
            'Prefer': cmd.type === 'select'
              ? 'return=representation'
              : 'resolution=ignore-duplicates,return=minimal'
          },
          body: (!isRead && cmd.data) ? JSON.stringify(cmd.data) : undefined
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

    const SYSTEM = `You are an inventory assistant for Windmar's Anker warehouse in Puerto Rico.

The inventory table has: serial (PK), sku (model name), sku_code, status ("in-stock"/"dispatched"/"rma"), ref, notes, updated_at.
The activity_log table has: msg, type ("dispatch"/"rma"/"add"/""), serial, reason, notes, ts.
${inventoryContext}
CRITICAL OUTPUT FORMAT: Respond with ONLY a single valid JSON object — no markdown, no backticks.

{ "reply": "Plain English description", "commands": [] }

The "reply" field must ALWAYS be plain English — never JSON or code.
For read-only questions, leave "commands" as [].

Example correct: {"reply":"There are 142 dispatched units.","commands":[]}

Rules:
- Always log to activity_log when making changes
- Dispatching: PATCH inventory set status="dispatched". Verify serial exists first.
- To query dispatch history: SELECT from activity_log, match "type=eq.dispatch", order "ts.desc", limit 20
- To count dispatched: SELECT from inventory, match "status=eq.dispatched"
- Commands support: "select" (columns), "order" (e.g. "ts.desc"), "limit" (number)
- Adding WITH serials: one insert per serial. WITHOUT serials: serial = "NO-SN-<SKUCODE>-<timestamp_ms>"
- Always include updated_at as ISO timestamp for inventory changes
- Cap bulk operations at 50 commands — tell user to split if more needed
- Do NOT claim success in reply — describe intended action only
- NEVER make up serials or data`;

    const cleanHistory = (history || []).slice(-10).map(m => {
      if (m.role === 'assistant') {
        const t = (m.content || '').trim();
        if (t.startsWith('{') || t.startsWith('[')) {
          return { role: 'assistant', content: '(previous action completed)' };
        }
      }
      return m;
    });

    const messages = [...cleanHistory, { role: 'user', content: message }];

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
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            system: SYSTEM,
            messages
          })
        }).then(r => r.json()),
        6000, 'AI response'
      );
      text = aiResponse.content?.[0]?.text || '';
    } catch (e) {
      return res.status(200).json({
        reply: `⏱ Timed out (${e.message}). Try a simpler request or split bulk operations.`,
        results: [], commandCount: 0, errors: [e.message]
      });
    }

    if (!text) {
      return res.status(200).json({ reply: 'No response from AI — try again.', results: [], commandCount: 0 });
    }

    // ── Parse AI response ──────────────────────────────────
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json\n?|```/g, '').trim());
    } catch(e) {
      return res.status(200).json({ reply: text, results: [], commandCount: 0 });
    }

    const commands = (parsed.commands || []).slice(0, 50);

    // ── Run commands in parallel batches of 5 ─────────────
    const results = [], errors = [];
    let successCount = 0;
    for (let i = 0; i < commands.length; i += 5) {
      const batch = commands.slice(i, i + 5);
      const batchResults = await Promise.all(batch.map(cmd => runCommand(cmd)));
      for (const result of batchResults) {
        if (result.ok) {
          if (result.rows) results.push(result.rows);
          if (result.cmd.type !== 'select') successCount++;
        } else {
          errors.push(`[${result.cmd.type} ${result.cmd.table}${result.cmd.match ? ' where ' + result.cmd.match : ''}] ${result.error}`);
        }
      }
    }

    // ── Build final reply ──────────────────────────────────
    let rawReply = parsed.reply || '';
    if (!rawReply || rawReply.trim().startsWith('{') || rawReply.trim().startsWith('[')) {
      rawReply = commands.length > 0 ? 'Processing your request…' : 'Done.';
    }
    let finalReply = rawReply;
    const totalCmds = commands.filter(c => c.type !== 'select').length;

    if (errors.length > 0 && successCount === 0) {
      finalReply = '❌ Failed — nothing was saved.\n' + errors.map(e => `• ${e}`).join('\n');
    } else if (errors.length > 0) {
      finalReply += `\n\n⚠️ Partial: ${successCount}/${totalCmds} succeeded.\n` + errors.map(e => `• ${e}`).join('\n');
    } else if (totalCmds > 0) {
      finalReply += ` ✓ (${successCount} change${successCount !== 1 ? 's' : ''} saved)`;
    }

    return res.status(200).json({ reply: finalReply, results, commandCount: totalCmds, errors });
  }

  return res.status(400).json({ error: 'Unknown action' });
}
