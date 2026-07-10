import { getFirestore } from './lib/firebaseAdmin.js'

const ALLOWED_ORIGINS = [
  'https://tailorpady.web.app',
  'http://localhost:5173',
]

const PLANS = {
  monthly: { amount: 120000, label: 'Pro Monthly' },
  annual:  { amount: 999900, label: 'Pro Annual' },
}

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

  const { reference, uid, billingCycle } = req.body

  if (!reference || !uid || !billingCycle) {
    return res.status(400).json({ error: 'Missing reference, uid or billingCycle' })
  }

  const plan = PLANS[billingCycle]
  if (!plan) {
    return res.status(400).json({ error: 'Invalid billingCycle' })
  }

  try {
    const verifyResponse = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
    })
    const verifyData = await verifyResponse.json()

    if (!verifyData.status || verifyData.data.status !== 'success') {
      return res.status(400).json({ error: 'Transaction not successful' })
    }

    if (verifyData.data.amount !== plan.amount) {
      return res.status(400).json({ error: 'Amount mismatch' })
    }

    if (verifyData.data.metadata?.uid !== uid) {
      return res.status(400).json({ error: 'UID mismatch' })
    }

    const customerCode = verifyData.data.customer?.customer_code
    const nextRenewal = new Date(
      Date.now() + (billingCycle === 'monthly' ? 30 : 365) * 24 * 60 * 60 * 1000
    )

    const db = getFirestore()

    await db.doc(`users/${uid}/settings/premium`).set({
      isPremium: true,
      plan: plan.label,
      billingCycle,
      customerCode: customerCode ?? null,
      paymentFailed: false,
      nextRenewal: nextRenewal.toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true })

    if (customerCode) {
      await db.doc(`paystackCustomers/${customerCode}`).set({ uid }, { merge: true })
    }

    return res.status(200).json({ success: true })
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' })
  }
}
