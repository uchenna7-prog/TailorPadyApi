import { getFirebaseAdmin, getFirestore } from './lib/firebaseAdmin.js'
import { enforceRateLimit, RateLimitError } from './lib/rateLimit.js'

const ALLOWED_ORIGINS = [
  'https://tailorpady.web.app',
  'http://localhost:5173',
]

const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 6
const MAX_ATTEMPTS = 5

const RATE_LIMIT_KEY = 'create-user-profile'
const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

function generateCode() {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  }
  return code
}

async function generateUniqueCode(db) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateCode()
    const snap = await db.doc(`referralCodes/${code}`).get()
    if (!snap.exists) return code
  }
  throw new Error('Could not generate a unique referral code')
}

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

    const userRef = db.doc(`users/${uid}`)
    const userSnap = await userRef.get()

    if (userSnap.exists) {
      return res.status(200).json({ created: false, ...userSnap.data() })
    }

    const { referredByCode } = req.body || {}

    let referrerUid = null
    let normalizedCode = null
    if (referredByCode && typeof referredByCode === 'string') {
      normalizedCode = referredByCode.trim().toUpperCase()
      const codeSnap = await db.doc(`referralCodes/${normalizedCode}`).get()
      if (codeSnap.exists && codeSnap.data().uid !== uid) {
        referrerUid = codeSnap.data().uid
      }
    }

    let referredDisplayName = null
    if (referrerUid) {
      try {
        const authUser = await admin.auth().getUser(uid)
        referredDisplayName = authUser.displayName || null
      } catch {
        referredDisplayName = null
      }
    }

    const code = await generateUniqueCode(db)
    const createdAt = new Date().toISOString()

    const result = await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(userRef)
      if (freshSnap.exists) {
        return { created: false, ...freshSnap.data() }
      }

      tx.set(userRef, { referralCode: code, referredBy: referrerUid, createdAt })
      tx.set(db.doc(`referralCodes/${code}`), { uid })

      if (referrerUid) {
        tx.set(db.doc(`referrals/${uid}`), {
          referrerUid,
          referredUid: uid,
          referralCode: normalizedCode,
          referredDisplayName,
          status: 'pending',
          referrerAcked: false,
          createdAt,
          activatedAt: null,
        })
      }

      return { created: true, referralCode: code, referredBy: referrerUid, createdAt }
    })

    return res.status(200).json(result)
  } catch (error) {
    if (error instanceof RateLimitError) {
      return res.status(429).json({ error: error.message })
    }
    return res.status(500).json({ error: 'Internal server error' })
  }
}
