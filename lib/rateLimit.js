import { Timestamp } from 'firebase-admin/firestore'

export class RateLimitError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RateLimitError'
  }
}

export async function enforceRateLimit(db, uid, key, maxRequests, windowMs) {
  const ref = db.doc(`rateLimits/${uid}_${key}`)
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const now = Date.now()
    if (!snap.exists) {
      tx.set(ref, {
        windowStart: now,
        count: 1,
        expiresAt: Timestamp.fromMillis(now + windowMs),
      })
      return
    }
    const data = snap.data()
    const withinWindow = now - data.windowStart < windowMs
    if (!withinWindow) {
      tx.set(ref, {
        windowStart: now,
        count: 1,
        expiresAt: Timestamp.fromMillis(now + windowMs),
      })
      return
    }
    if (data.count >= maxRequests) {
      throw new RateLimitError('Too many requests, please try again later')
    }
    tx.set(ref, {
      windowStart: data.windowStart,
      count: data.count + 1,
      expiresAt: Timestamp.fromMillis(data.windowStart + windowMs),
    })
  })
}
