export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { title, description, section, severity, screenshotUrl, userEmail } = req.body

  const text =
    `🐛 *New Bug Report*\n\n` +
    `*Title:* ${title}\n` +
    `*Severity:* ${severity}\n` +
    `*Section:* ${section}\n` +
    `*From:* ${userEmail || 'unknown'}\n\n` +
    `${description}` +
    (screenshotUrl ? `\n\n[Screenshot](${screenshotUrl})` : '')

  try {
    const tgRes = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: 'Markdown',
        }),
      }
    )

    if (!tgRes.ok) {
      const err = await tgRes.text()
      return res.status(502).json({ error: 'Telegram send failed', details: err })
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: 'Internal error' })
  }
}
