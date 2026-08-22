import { getFirebaseAdmin, getFirestore } from '../lib/firebaseAdmin.js'
import { enforceRateLimit, RateLimitError } from '../lib/rateLimit.js'

const ALLOWED_ORIGINS = [
  'https://tailorpady.web.app',
  'http://localhost:5173',
]

const RATE_LIMIT_KEY = 'acknowledge-referral'
const RATE_LIMIT_MAX = 30
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

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

    const { referralId } = req.body || {}
    if (!referralId || typeof referralId !== 'string') {
      return res.status(400).json({ error: 'Missing referralId' })
    }

    const referralRef = db.doc(`referrals/${referralId}`)
    const referralSnap = await referralRef.get()

    if (!referralSnap.exists) {
      return res.status(200).json({ acknowledged: false, reason: 'not_found' })
    }

    const referral = referralSnap.data()
    if (referral.referrerUid !== uid) {
      return res.status(403).json({ error: 'Not authorized to acknowledge this referral' })
    }

    if (referral.rewardGranted !== true) {
      return res.status(200).json({ acknowledged: false, reason: 'no_reward_to_acknowledge' })
    }

    if (referral.referrerAcked === true) {
      return res.status(200).json({ acknowledged: true, reason: 'already_acknowledged' })
    }

    await referralRef.set({
      referrerAcked: true,
      referrerAckedAt: new Date().toISOString(),
    }, { merge: true })

    return res.status(200).json({ acknowledged: true, reason: 'newly_acknowledged' })
  } catch (error) {
    if (error instanceof RateLimitError) {
      return res.status(429).json({ error: error.message })
    }
    return res.status(500).json({ error: 'Internal server error' })
  }
}
