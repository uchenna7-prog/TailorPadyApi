import { getFirestore } from '../lib/firebaseAdmin.js'
import { getSubscriptionPurchase, acknowledgeSubscriptionPurchase } from '../lib/googlePlayClient.js'

const ALLOWED_ORIGINS = [
  'https://tailorpady.web.app',
  'http://localhost:5173',
]

const PLANS = {
  monthly: { basePlanId: 'monthly', label: 'Pro Monthly' },
  annual: { basePlanId: 'annual', label: 'Pro Annual' },
}

const ACTIVE_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
])

async function handleVerify(req, res) {
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

  const { purchaseToken, uid, billingCycle } = req.body
  if (!purchaseToken || !uid || !billingCycle) {
    return res.status(400).json({ error: 'Missing purchaseToken, uid or billingCycle' })
  }

  const plan = PLANS[billingCycle]
  if (!plan) {
    return res.status(400).json({ error: 'Invalid billingCycle' })
  }

  try {
    const purchase = await getSubscriptionPurchase(purchaseToken)

    if (purchase.subscriptionState !== 'SUBSCRIPTION_STATE_ACTIVE') {
      return res.status(400).json({ error: 'Subscription is not active' })
    }

    const lineItem = purchase.lineItems?.[0]
    const basePlanId = lineItem?.offerDetails?.basePlanId
    if (basePlanId !== plan.basePlanId) {
      return res.status(400).json({ error: 'Base plan mismatch' })
    }

    if (purchase.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
      await acknowledgeSubscriptionPurchase(purchaseToken)
    }

    const paidAt = new Date().toISOString()
    const nextRenewal = lineItem?.expiryTime || null

    const db = getFirestore()
    await db.doc(`users/${uid}/settings/premium`).set({
      isPremium: true,
      plan: plan.label,
      billingCycle,
      purchaseToken,
      paymentFailed: false,
      nextRenewal,
      updatedAt: paidAt,
      billingProvider: 'play',
    }, { merge: true })

    await db.doc(`users/${uid}/subscriptionPayments/${purchaseToken}`).set({
      purchaseToken,
      plan: plan.label,
      billingCycle,
      status: 'paid',
      paidAt,
      billingProvider: 'play',
    })

    await db.doc(`playPurchaseTokens/${purchaseToken}`).set({ uid }, { merge: true })

    return res.status(200).json({
      success: true,
      plan: plan.label,
      billingCycle,
      nextRenewal,
    })
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' })
  }
}

async function handleWebhook(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const messageData = req.body?.message?.data
    if (!messageData) {
      return res.status(200).json({ ignored: true })
    }

    const decoded = Buffer.from(messageData, 'base64').toString('utf8')
    const notification = JSON.parse(decoded)
    const purchaseToken = notification.subscriptionNotification?.purchaseToken

    if (!purchaseToken) {
      return res.status(200).json({ ignored: true })
    }

    const db = getFirestore()
    const tokenSnap = await db.doc(`playPurchaseTokens/${purchaseToken}`).get()
    if (!tokenSnap.exists) {
      return res.status(200).json({ ignored: true })
    }

    const { uid } = tokenSnap.data()
    const purchase = await getSubscriptionPurchase(purchaseToken)

    const isActive = ACTIVE_STATES.has(purchase.subscriptionState)
    const isOnHold = purchase.subscriptionState === 'SUBSCRIPTION_STATE_ON_HOLD'
    const lineItem = purchase.lineItems?.[0]

    await db.doc(`users/${uid}/settings/premium`).set({
      isPremium: isActive,
      paymentFailed: isOnHold,
      nextRenewal: lineItem?.expiryTime || null,
      updatedAt: new Date().toISOString(),
      billingProvider: 'play',
    }, { merge: true })

    return res.status(200).json({ success: true })
  } catch (error) {
    return res.status(200).json({ error: 'Failed to process notification' })
  }
}

export default async function handler(req, res) {
  const action = req.query.action

  if (action === 'webhook') {
    return handleWebhook(req, res)
  }
  if (action === 'verify') {
    return handleVerify(req, res)
  }
  return res.status(400).json({ error: 'Unknown action' })
}
