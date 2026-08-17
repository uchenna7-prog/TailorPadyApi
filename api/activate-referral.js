import { getFirebaseAdmin, getFirestore } from './lib/firebaseAdmin.js'
import { enforceRateLimit, RateLimitError } from './lib/rateLimit.js'

const ALLOWED_ORIGINS = [
  'https://tailorpady.web.app',
  'http://localhost:5173',
]

const REWARD_DAYS = 30
const REFERRALS_PER_REWARD = 5
const MAX_REWARDS_PER_REFERRER = 3

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

    const activatedAt = new Date().toISOString()

    const markResult = await db.runTransaction(async (tx) => {
      const freshReferralSnap = await tx.get(referralRef)
      if (!freshReferralSnap.exists || freshReferralSnap.data().status === 'activated') {
        return { alreadyActivated: true }
      }

      tx.set(referralRef, {
        status: 'activated',
        activatedAt,
        rewardGranted: false,
      }, { merge: true })

      return { alreadyActivated: false }
    })

    if (markResult.alreadyActivated) {
      return res.status(200).json({ activated: true, reason: 'already_activated' })
    }

    const referrerUid = referral.referrerUid

    const activatedForReferrerSnap = await db.collection('referrals')
      .where('referrerUid', '==', referrerUid)
      .where('status', '==', 'activated')
      .get()

    const totalActivated = activatedForReferrerSnap.size
    const rewardDue = totalActivated % REFERRALS_PER_REWARD === 0

    if (!rewardDue) {
      return res.status(200).json({ activated: true, reason: 'newly_activated', rewardGranted: false })
    }

    const rewardedForReferrerSnap = await db.collection('referrals')
      .where('referrerUid', '==', referrerUid)
      .where('rewardGranted', '==', true)
      .get()

    if (rewardedForReferrerSnap.size >= MAX_REWARDS_PER_REFERRER) {
      return res.status(200).json({ activated: true, reason: 'reward_cap_reached', rewardGranted: false })
    }

    try {
      await enforceRateLimit(db, referrerUid, REFERRER_PAYOUT_KEY, REFERRER_PAYOUT_MAX, REFERRER_PAYOUT_WINDOW_MS)
    } catch (limitError) {
      if (limitError instanceof RateLimitError) {
        return res.status(200).json({ activated: true, reason: 'referrer_payout_limit', rewardGranted: false })
      }
      throw limitError
    }

    const contributingNames = activatedForReferrerSnap.docs
      .map(d => d.data())
      .sort((a, b) => (a.activatedAt || '').localeCompare(b.activatedAt || ''))
      .slice(-REFERRALS_PER_REWARD)
      .map(r => r.referredDisplayName)
      .filter(Boolean)

    const referrerRef = db.doc(`users/${referrerUid}/settings/premium`)
    const referralsCollectionRef = db.collection('referrals')

    const rewardResult = await db.runTransaction(async (tx) => {
      const freshReferralSnap = await tx.get(referralRef)
      if (!freshReferralSnap.exists || freshReferralSnap.data().rewardGranted === true) {
        return { rewardGranted: true, reason: 'already_rewarded' }
      }

      const rewardedRecheckSnap = await tx.get(
        referralsCollectionRef
          .where('referrerUid', '==', referrerUid)
          .where('rewardGranted', '==', true)
      )
      if (rewardedRecheckSnap.size >= MAX_REWARDS_PER_REFERRER) {
        return { rewardGranted: false, reason: 'reward_cap_reached' }
      }

      const referrerSnap = await tx.get(referrerRef)
      const current = referrerSnap.exists ? referrerSnap.data() : {}
      const baseDate = current.nextRenewal && new Date(current.nextRenewal) > new Date()
        ? new Date(current.nextRenewal)
        : new Date()
      const extendedRenewal = new Date(baseDate.getTime() + REWARD_DAYS * 24 * 60 * 60 * 1000).toISOString()
      const hasActiveSubscription = !!current.subscriptionCode

      const premiumUpdate = {
        isPremium: true,
        nextRenewal: extendedRenewal,
        updatedAt: activatedAt,
      }
      if (!hasActiveSubscription) {
        premiumUpdate.cancelAtPeriodEnd = true
      }

      tx.set(referrerRef, premiumUpdate, { merge: true })

      tx.set(referralRef, {
        rewardGranted: true,
        rewardDays: REWARD_DAYS,
        rewardBatchCount: totalActivated,
        contributingNames,
        referrerAcked: false,
      }, { merge: true })

      return { rewardGranted: true, reason: 'newly_rewarded' }
    })

    return res.status(200).json({ activated: true, ...rewardResult })
  } catch (error) {
    if (error instanceof RateLimitError) {
      return res.status(429).json({ error: error.message })
    }
    return res.status(500).json({ error: 'Internal server error' })
  }
}
