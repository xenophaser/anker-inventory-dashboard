// Cron endpoint — checks low stock and emails alert via Resend
// Triggered by Vercel Cron every 12 hours (see vercel.json)

export default async function handler(req, res) {
  const SB_URL = "https://sxwtqrxpqonyqkalcyuj.supabase.co";
  const SB_KEY = process.env.SUPABASE_KEY;
  const RESEND_KEY = process.env.RESEND_API_KEY;

  if (!SB_KEY || !RESEND_KEY) {
    return res.status(500).json({ error: 'Server misconfigured — missing keys' });
  }

  const SB_HEADERS = {
    'Content-Type': 'application/json',
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`
  };

  try {
    // Fetch full inventory (paginated, in case >3000 rows)
    let allRows = [], offset = 0;
    while (true) {
      const r = await fetch(`${SB_URL}/rest/v1/inventory?select=sku,sku_code,status&limit=3000&offset=${offset}`, { headers: SB_HEADERS });
      const rows = await r.json();
      allRows = allRows.concat(rows);
      if (rows.length < 3000) break;
      offset += 3000;
    }

    // Group by model
    const models = {};
    for (const row of allRows) {
      if (!models[row.sku]) models[row.sku] = { skuCode: row.sku_code || '', total: 0, inStock: 0 };
      models[row.sku].total++;
      if (row.status === 'in-stock') models[row.sku].inStock++;
    }

    // Apply rule: Total >= 25 AND inStock <= 20
    const lowStock = Object.entries(models)
      .filter(([sku, d]) => d.total >= 25 && d.inStock <= 20)
      .map(([sku, d]) => ({ sku, skuCode: d.skuCode, total: d.total, inStock: d.inStock }));

    if (lowStock.length === 0) {
      return res.status(200).json({ ok: true, message: 'No low stock alerts', checked: Object.keys(models).length });
    }

    // Build email
    const rowsHtml = lowStock.map(m => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e0e0e0;">${m.sku}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e0e0e0;font-family:monospace;color:#666;">${m.skuCode}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e0e0e0;text-align:center;">${m.total}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e0e0e0;text-align:center;color:#d9534f;font-weight:bold;">${m.inStock}</td>
      </tr>`).join('');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
        <h2 style="color:#1a1a1a;">⚠️ Alerta de Stock Bajo — Anker Warehouse</h2>
        <p style="color:#555;">Los siguientes modelos están en o por debajo del umbral de stock (20 unidades in-stock, con historial de 25+ unidades):</p>
        <table style="width:100%;border-collapse:collapse;margin-top:12px;">
          <thead>
            <tr style="background:#1a1a1a;color:#fff;">
              <th style="padding:8px 12px;text-align:left;">Modelo</th>
              <th style="padding:8px 12px;text-align:left;">SKU</th>
              <th style="padding:8px 12px;text-align:center;">Total</th>
              <th style="padding:8px 12px;text-align:center;">In Stock</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <p style="color:#999;font-size:12px;margin-top:16px;">Anker Inventory App — Chequeo automático cada 12 horas</p>
      </div>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_KEY}`
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: 'sergio.romero@windmarhome.com',
        subject: `⚠️ Stock bajo — ${lowStock.length} modelo(s) requieren atención`,
        html
      })
    });

    const emailData = await emailRes.json();

    return res.status(200).json({ ok: true, alerted: lowStock, emailResult: emailData });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
