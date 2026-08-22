import admin from 'firebase-admin'
import { getFirebaseAdmin, getFirestore } from '../lib/firebaseAdmin.js'

async function startDeletion(app, db, uid, extra = {}) {
  await app.auth().setCustomUserClaims(uid, { pendingDeletion: true })
  await db.doc(`users/${uid}`).set({
    pendingDeletion: true,
    deletionRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
    ...extra,
  }, { merge: true })
  await app.auth().revokeRefreshTokens(uid)
}

async function cancelDeletion(app, db, uid) {
  const userSnap = await db.doc(`users/${uid}`).get()
  if (!userSnap.exists || userSnap.data().pendingDeletion !== true) {
    return { cancelled: false, reason: 'not_pending' }
  }

  await app.auth().setCustomUserClaims(uid, { pendingDeletion: false })
  await db.doc(`users/${uid}`).set({
    pendingDeletion: false,
    deletionRequestedAt: null,
    deletionCancelledAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true })

  return { cancelled: true }
}

async function handleAdminRequest(req, res, app, db) {
  const { action, email, uid: uidFromBody } = req.body || {}
  if (!['start', 'cancel'].includes(action)) {
    return res.status(400).json({ error: 'action must be "start" or "cancel"' })
  }
  if (!email && !uidFromBody) {
    return res.status(400).json({ error: 'Provide an email or uid' })
  }

  try {
    let uid = uidFromBody
    if (!uid) {
      const userRecord = await app.auth().getUserByEmail(email)
      uid = userRecord.uid
    }

    if (action === 'start') {
      await startDeletion(app, db, uid, { requestedVia: 'email', verifiedByAdmin: true })
      return res.status(200).json({ success: true, uid, action: 'started' })
    }

    const result = await cancelDeletion(app, db, uid)
    return res.status(200).json({ success: true, uid, ...result })
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      return res.status(404).json({ error: 'No account found for that email' })
    }
    console.error('admin delete-account error:', err)
    return res.status(500).json({ error: 'Could not process request' })
  }
}

async function handleSelfServiceRequest(req, res, app, db) {
  const authHeader = req.headers.authorization
  const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!idToken) return res.status(401).json({ error: 'Missing auth token' })

  let decoded
  try {
    decoded = await app.auth().verifyIdToken(idToken)
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  try {
    await startDeletion(app, db, decoded.uid, { requestedVia: 'app' })
    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('delete-account error:', err)
    return res.status(500).json({ error: 'Could not process account deletion' })
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const app = getFirebaseAdmin()
  const db = getFirestore()

  const authHeader = req.headers.authorization
  if (process.env.ADMIN_SECRET && authHeader === `Bearer ${process.env.ADMIN_SECRET}`) {
    return handleAdminRequest(req, res, app, db)
  }

  return handleSelfServiceRequest(req, res, app, db)
}
