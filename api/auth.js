export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, password, message, history } = req.body;

  // ── Password check ────────────────────────────────────────
  if (action === 'auth') {
    const correct = process.env.EDIT_PASSWORD;
    if (!correct) return res.status(500).json({ error: 'Server not configured' });
    return password === correct
      ? res.status(200).json({ ok: true })
      : res.status(401).json({ ok: false, error: 'Wrong password' });
  }

  // ── Claude AI chat ────────────────────────────────────────
  if (action === 'chat') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'AI not configured' });

    const SB_URL = "https://sxwtqrxpqonyqkalcyuj.supabase.co";
    const SB_KEY = "sb_publishable_GcNpfiTWoNgkRmAbXM_X2w_RDcGM18R";

    const SYSTEM = `You are an inventory assistant for Windmar's Anker warehouse in Puerto Rico. You help manage inventory by generating JSON commands executed against a Supabase database.

The inventory table has: serial (PK), sku (model name), sku_code, status ("in-stock"/"dispatched"/"rma"), ref, notes, updated_at.
The activity_log table has: msg, type ("dispatch"/"rma"/""), serial, reason, notes, ts.

When the user asks you to make a change, respond ONLY with a JSON object:
{
  "reply": "Human readable confirmation",
  "commands": [
    { "type": "insert"|"update"|"delete"|"select", "table": "inventory"|"activity_log", "data": {}, "match": "column=eq.value" }
  ]
}

For read-only questions respond with: { "reply": "answer", "commands": [] }

Rules:
- Always log to activity_log when making changes
- Dispatching: set status to "dispatched"
- Adding without serials: use serial "NO-SN-MODELNAME-<timestamp>"
- Always include updated_at as current ISO timestamp for inventory changes
- Be conversational and concise`;

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
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: SYSTEM,
          messages
        })
      });

      const data = await response.json();
      const text = data.content?.[0]?.text || '{}';

      let parsed;
      try {
        const clean = text.replace(/```json|```/g, '').trim();
        parsed = JSON.parse(clean);
      } catch {
        return res.status(200).json({ reply: text, commands: [] });
      }

      // Execute commands against Supabase
      const results = [];
      for (const cmd of (parsed.commands || [])) {
        const url = `${SB_URL}/rest/v1/${cmd.table}${cmd.match ? '?' + cmd.match : ''}`;
        const method = cmd.type === 'insert' ? 'POST'
          : cmd.type === 'update' ? 'PATCH'
          : cmd.type === 'delete' ? 'DELETE'
          : 'GET';

        const sbRes = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'apikey': SB_KEY,
            'Authorization': `Bearer ${SB_KEY}`,
            'Prefer': cmd.type === 'select' ? 'return=representation' : 'return=minimal'
          },
          body: cmd.data ? JSON.stringify(cmd.data) : undefined
        });

        if (cmd.type === 'select') {
          const rows = await sbRes.json();
          results.push(rows);
        }
      }

      return res.status(200).json({
        reply: parsed.reply,
        results,
        commandCount: (parsed.commands || []).length
      });

    } catch (e) {
      return res.status(500).json({ error: 'AI request failed: ' + e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action' });
}
