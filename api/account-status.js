import { getFirebaseAdmin, getFirestore } from '../lib/firebaseAdmin.js'
import { enforceRateLimit, RateLimitError } from '../lib/rateLimit.js'

const ALLOWED_ORIGINS = [
  'https://tailorpady.web.app',
  'http://localhost:5173',
]

const RATE_LIMIT_KEY = 'account-status'
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000

export default async function handler(req, res) {
  const origin = req.headers.origin
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : ''
  if (!email) {
    return res.status(400).json({ error: 'Missing email' })
  }

  const forwarded = req.headers['x-forwarded-for']
  const ip = Array.isArray(forwarded)
    ? forwarded[0]
    : (forwarded ? forwarded.split(',')[0].trim() : (req.socket?.remoteAddress || 'unknown'))
  const rateLimitKey = `${ip}:${email}`

  try {
    const app = getFirebaseAdmin()
    const db = getFirestore()

    await enforceRateLimit(db, rateLimitKey, RATE_LIMIT_KEY, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)

    let userRecord
    try {
      userRecord = await app.auth().getUserByEmail(email)
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        return res.status(200).json({ status: 'not_found' })
      }
      throw err
    }

    const pendingDeletion = !!userRecord.customClaims?.pendingDeletion
    return res.status(200).json({ status: pendingDeletion ? 'pending_deletion' : 'active' })
  } catch (error) {
    if (error instanceof RateLimitError) {
      return res.status(429).json({ error: error.message })
    }
    console.error('account-status error:', error)
    return res.status(500).json({ error: 'Could not check account status' })
  }
}
