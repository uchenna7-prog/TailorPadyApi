import admin from 'firebase-admin'
import { getFirebaseAdmin, getFirestore } from './lib/firebaseAdmin.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const authHeader = req.headers.authorization
  const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (!idToken) return res.status(401).json({ error: 'Missing auth token' })

  const app = getFirebaseAdmin()
  let decoded
  try {
    decoded = await app.auth().verifyIdToken(idToken)
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }

  const uid = decoded.uid
  const db = getFirestore()

  try {
    await db.doc(`users/${uid}`).set({
      pendingDeletion: true,
      deletionRequestedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true })

    // Invalidates their current session so a stale ID token can't keep working
    await app.auth().revokeRefreshTokens(uid)

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('delete-account error:', err)
    return res.status(500).json({ error: 'Could not process account deletion' })
  }
}
