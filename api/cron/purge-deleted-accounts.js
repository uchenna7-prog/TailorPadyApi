import admin from 'firebase-admin'
import { getFirebaseAdmin, getFirestore } from '../../lib/firebaseAdmin.js'
import { destroyCloudinaryImage, extractPublicIdFromUrl } from '../../lib/cloudinary.js'

const GRACE_PERIOD_DAYS = 30

function scanEntryForPublicIds(key, value, publicIds) {
  if (value == null) return

  if (typeof value === 'string') {
    if (/publicid/i.test(key)) {
      publicIds.add(value)
      return
    }
    if (value.includes('cloudinary.com')) {
      const extracted = extractPublicIdFromUrl(value)
      if (extracted) publicIds.add(extracted)
    }
    return
  }

  if (Array.isArray(value)) {
    if (/publicid/i.test(key)) {
      value.forEach(v => { if (typeof v === 'string') publicIds.add(v) })
      return
    }
    value.forEach(v => scanEntryForPublicIds(key, v, publicIds))
    return
  }

  if (typeof value === 'object' && typeof value.toDate !== 'function') {
    Object.entries(value).forEach(([k, v]) => scanEntryForPublicIds(k, v, publicIds))
  }
}

async function scanDocRecursive(docSnap, publicIds) {
  if (docSnap.exists) {
    Object.entries(docSnap.data()).forEach(([k, v]) => scanEntryForPublicIds(k, v, publicIds))
  }
  const subcollections = await docSnap.ref.listCollections()
  for (const col of subcollections) {
    const colSnap = await col.get()
    for (const d of colSnap.docs) {
      await scanDocRecursive(d, publicIds)
    }
  }
}

async function collectCloudinaryPublicIds(db, uid) {
  const publicIds = new Set()
  const userDocSnap = await db.doc(`users/${uid}`).get()
  await scanDocRecursive(userDocSnap, publicIds)
  return [...publicIds]
}

async function deleteAuthUserIfExists(app, uid) {
  try {
    await app.auth().deleteUser(uid)
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err
  }
}

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
      const publicIds = await collectCloudinaryPublicIds(db, uid)
      await Promise.all(
        publicIds.map(publicId => destroyCloudinaryImage(publicId).catch(() => {}))
      )

      await deleteAuthUserIfExists(app, uid)

      const slugSnap = await db.collection('slugs').where('uid', '==', uid).get()
      if (!slugSnap.empty) {
        const slugBatch = db.batch()
        slugSnap.docs.forEach(d => slugBatch.delete(d.ref))
        await slugBatch.commit()
      }

      await db.recursiveDelete(db.doc(`users/${uid}`))

      results.push({ uid, status: 'purged', imagesDeleted: publicIds.length })
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

export const config = {
  maxDuration: 300,
}
