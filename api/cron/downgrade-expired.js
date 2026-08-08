import { getFirestore } from '../lib/firebaseAdmin.js'

export default async function handler(req, res) {
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end()
  }

  const db = getFirestore()
  const now = new Date().toISOString()

  const snap = await db.collectionGroup('settings')
    .where('cancelAtPeriodEnd', '==', true)
    .where('nextRenewal', '<=', now)
    .get()

  if (snap.empty) {
    return res.status(200).json({ downgraded: 0 })
  }

  const batch = db.batch()
  snap.docs.forEach(doc => {
    batch.set(doc.ref, {
      isPremium: false,
      cancelAtPeriodEnd: false,
      updatedAt: now,
    }, { merge: true })
  })
  await batch.commit()

  return res.status(200).json({ downgraded: snap.docs.length })
}
