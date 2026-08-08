import { getFirestore } from './lib/firebaseAdmin.js'

const ALLOWED_ORIGINS = [
  'https://tailorpady.web.app',
  'http://localhost:5173',
]

export default async function handler(req, res) {
  const origin = req.headers.origin
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { uid } = req.body
  if (!uid) {
    return res.status(400).json({ error: 'Missing uid' })
  }

  try {
    const db = getFirestore()
    const ref = db.doc(`users/${uid}/settings/premium`)
    const snap = await ref.get()

    if (!snap.exists) {
      return res.status(404).json({ error: 'No subscription found for user' })
    }

    const { subscriptionCode, emailToken } = snap.data()
    if (!subscriptionCode || !emailToken) {
      return res.status(400).json({ error: 'Subscription is missing required cancellation data' })
    }

    const disableResponse = await fetch('https://api.paystack.co/subscription/disable', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code: subscriptionCode, token: emailToken }),
    })

    const disableData = await disableResponse.json()
    if (!disableData.status) {
      return res.status(400).json({ error: disableData.message || 'Could not cancel subscription' })
    }

    await ref.set({
      cancelledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true })

    return res.status(200).json({ success: true })
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' })
  }
}
