export default function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body;
  const correct = process.env.EDIT_PASSWORD;

  if (!correct) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  if (password === correct) {
    return res.status(200).json({ ok: true });
  } else {
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  }
}
