import admin from 'firebase-admin'
import { getFirebaseAdmin, getFirestore } from '../lib/firebaseAdmin.js'

const GRACE_PERIOD_DAYS = 30

export default async function handler(req, res) {
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end()
  }

  const app = getFirebaseAdmin()
  const db = getFirestore()

  const cutoff = admin.firestore.Timestamp.fromMillis(
    Date.now() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000
  )

  const snap = await db.collection('users')
    .where('pendingDeletion', '==', true)
    .where('deletionRequestedAt', '<=', cutoff)
    .get()

  if (snap.empty) return res.status(200).json({ purged: 0 })

  const results = []

  for (const userDoc of snap.docs) {
    const uid = userDoc.id
    try {
      // Free up any portfolio slug reserved by this account
      const slugSnap = await db.collection('slugs').where('uid', '==', uid).get()
      if (!slugSnap.empty) {
        const slugBatch = db.batch()
        slugSnap.docs.forEach(d => slugBatch.delete(d.ref))
        await slugBatch.commit()
      }

      // Wipes users/{uid} AND every subcollection beneath it —
      // customers, orders, invoices, payments, measurements, appointments,
      // gallery, inventory, agent data, usage, portfolioSettings, everything.
      await db.recursiveDelete(db.doc(`users/${uid}`))

      await app.auth().deleteUser(uid)
      results.push({ uid, status: 'purged' })
    } catch (err) {
      console.error(`Failed to purge user ${uid}:`, err)
      results.push({ uid, status: 'error', message: err.message })
    }
  }

  return res.status(200).json({
    purged: results.filter(r => r.status === 'purged').length,
    results,
  })
}
