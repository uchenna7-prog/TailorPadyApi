import { getFirebaseAdmin, getFirestore } from './lib/firebaseAdmin.js'
import { enforceRateLimit, RateLimitError } from './lib/rateLimit.js'

const ALLOWED_ORIGINS = [
  'https://tailorpady.web.app',
  'http://localhost:5173',
]

const REWARD_DAYS = 30

const RATE_LIMIT_KEY = 'activate-referral'
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

const REFERRER_PAYOUT_KEY = 'referrer-payout'
const REFERRER_PAYOUT_MAX = 5
const REFERRER_PAYOUT_WINDOW_MS = 24 * 60 * 60 * 1000

export default async function handler(req, res) {
  const origin = req.headers.origin
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const authHeader = req.headers.authorization || ''
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!idToken) {
    return res.status(401).json({ error: 'Missing authorization token' })
  }

  try {
    const admin = getFirebaseAdmin()
    const decoded = await admin.auth().verifyIdToken(idToken)
    const uid = decoded.uid
    const db = getFirestore()

    await enforceRateLimit(db, uid, RATE_LIMIT_KEY, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)

    const referralRef = db.doc(`referrals/${uid}`)
    const referralSnap = await referralRef.get()

    if (!referralSnap.exists) {
      return res.status(200).json({ activated: false, reason: 'no_referral' })
    }

    const referral = referralSnap.data()
    if (referral.status === 'activated') {
      return res.status(200).json({ activated: true, reason: 'already_activated' })
    }

    const [customersSnap, invoicesSnap] = await Promise.all([
      db.collection(`users/${uid}/customers`).limit(1).get(),
      db.collection(`users/${uid}/invoices`).limit(1).get(),
    ])

    const hasActivity = !customersSnap.empty || !invoicesSnap.empty
    if (!hasActivity) {
      return res.status(200).json({ activated: false, reason: 'not_active_yet' })
    }

    try {
      await enforceRateLimit(db, referral.referrerUid, REFERRER_PAYOUT_KEY, REFERRER_PAYOUT_MAX, REFERRER_PAYOUT_WINDOW_MS)
    } catch (limitError) {
      if (limitError instanceof RateLimitError) {
        return res.status(200).json({ activated: false, reason: 'referrer_payout_limit' })
      }
      throw limitError
    }

    const activatedAt = new Date().toISOString()
    const referrerRef = db.doc(`users/${referral.referrerUid}/settings/premium`)

    const result = await db.runTransaction(async (tx) => {
      const freshReferralSnap = await tx.get(referralRef)
      if (!freshReferralSnap.exists || freshReferralSnap.data().status === 'activated') {
        return { activated: true, reason: 'already_activated' }
      }

      const referrerSnap = await tx.get(referrerRef)
      const current = referrerSnap.exists ? referrerSnap.data() : {}
      const baseDate = current.nextRenewal && new Date(current.nextRenewal) > new Date()
        ? new Date(current.nextRenewal)
        : new Date()
      const extendedRenewal = new Date(baseDate.getTime() + REWARD_DAYS * 24 * 60 * 60 * 1000).toISOString()

      tx.set(referrerRef, {
        isPremium: true,
        nextRenewal: extendedRenewal,
        updatedAt: activatedAt,
      }, { merge: true })

      tx.set(referralRef, {
        status: 'activated',
        activatedAt,
      }, { merge: true })

      return { activated: true, reason: 'newly_activated' }
    })

    return res.status(200).json(result)
  } catch (error) {
    if (error instanceof RateLimitError) {
      return res.status(429).json({ error: error.message })
    }
    return res.status(500).json({ error: 'Internal server error' })
  }
}