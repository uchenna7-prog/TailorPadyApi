import admin from 'firebase-admin'
import { getFirebaseAdmin, getFirestore } from '../../lib/firebaseAdmin.js'
import { destroyCloudinaryImage, extractPublicIdFromUrl } from '../../lib/cloudinary.js'
import { sendPushToUser, sendBroadcast } from '../../lib/webpush.js'

const GRACE_PERIOD_DAYS = 30
const RATE_LIMIT_CLEANUP_BATCH_SIZE = 400

function daysUntil(dateStr) {
  if (!dateStr) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(dateStr + 'T00:00:00')
  return Math.round((target - today) / (1000 * 60 * 60 * 24))
}

function isInvoiceOverdue(inv) {
  if (inv.status === 'paid') return false
  if (!inv.due) return false
  return new Date(inv.due + 'T23:59:59') < new Date()
}

function birthdayDaysUntil(birthdayStr) {
  if (!birthdayStr) return null
  const [month, day] = birthdayStr.split('-').map(Number)
  if (!month || !day) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const thisYear = new Date(today.getFullYear(), month - 1, day)
  if (thisYear < today) thisYear.setFullYear(today.getFullYear() + 1)
  return Math.round((thisYear - today) / (1000 * 60 * 60 * 24))
}

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

async function runDowngradeExpired(db) {
  const now = new Date().toISOString()
  const snap = await db.collectionGroup('settings')
    .where('cancelAtPeriodEnd', '==', true)
    .where('nextRenewal', '<=', now)
    .get()

  if (snap.empty) {
    return { downgraded: 0 }
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

  return { downgraded: snap.docs.length }
}

async function runPurgeDeletedAccounts(app, db) {
  const cutoff = admin.firestore.Timestamp.fromMillis(
    Date.now() - GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000
  )
  const snap = await db.collection('users')
    .where('pendingDeletion', '==', true)
    .where('deletionRequestedAt', '<=', cutoff)
    .get()

  if (snap.empty) {
    return { purged: 0, results: [] }
  }

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

  return {
    purged: results.filter(r => r.status === 'purged').length,
    results,
  }
}

async function buildDigestForUser(db, uid) {
  const [ordersSnap, invoicesSnap, tasksSnap, apptsSnap, customersSnap] = await Promise.all([
    db.collection(`users/${uid}/orders`).get(),
    db.collection(`users/${uid}/invoices`).get(),
    db.collection(`users/${uid}/tasks`).where('done', '==', false).get(),
    db.collection(`users/${uid}/appointments`).get(),
    db.collection(`users/${uid}/customers`).get(),
  ])

  const items = []

  ordersSnap.docs.forEach(d => {
    const o = d.data()
    if (['completed', 'delivered', 'cancelled'].includes(o.status)) return
    const diff = daysUntil(o.dueDate)
    if (diff === null) return
    if (diff < 0) items.push(`Order overdue: ${o.desc || 'Order'}`)
    else if (diff === 0) items.push(`Order due today: ${o.desc || 'Order'}`)
  })

  invoicesSnap.docs.forEach(d => {
    const inv = d.data()
    if (isInvoiceOverdue(inv)) items.push(`Invoice overdue: ${inv.number || 'Invoice'}`)
  })

  tasksSnap.docs.forEach(d => {
    const t = d.data()
    if (!t.dueDate) return
    const diff = daysUntil(t.dueDate)
    if (diff === null) return
    if (diff < 0) items.push(`Task overdue: ${t.desc}`)
    else if (diff === 0) items.push(`Task due today: ${t.desc}`)
  })

  apptsSnap.docs.forEach(d => {
    const a = d.data()
    const diff = daysUntil(a.date)
    if (diff === 0) items.push(`Appointment today: ${a.title || a.type || 'Appointment'}`)
  })

  customersSnap.docs.forEach(d => {
    const c = d.data()
    if (!c.birthday) return
    const diff = birthdayDaysUntil(c.birthday)
    if (diff === 0) items.push(`Today is ${c.name}'s birthday`)
  })

  return items
}

async function runDailyDigest(db) {
  const subsSnap = await db.collectionGroup('pushSubscriptions').get()

  if (subsSnap.empty) {
    return { processed: 0, sent: 0, results: [] }
  }

  const uids = new Set()
  subsSnap.docs.forEach(d => {
    const uid = d.ref.parent.parent?.id
    if (uid) uids.add(uid)
  })

  const results = []
  for (const uid of uids) {
    try {
      const items = await buildDigestForUser(db, uid)
      if (items.length === 0) {
        results.push({ uid, status: 'skipped' })
        continue
      }

      const body = items.length === 1
        ? items[0]
        : `${items[0]} +${items.length - 1} more`

      await sendPushToUser(uid, {
        title: 'Your TailorPady summary',
        body,
      })
      results.push({ uid, status: 'sent', count: items.length })
    } catch (err) {
      console.error(`Digest failed for ${uid}:`, err.message)
      results.push({ uid, status: 'error', message: err.message })
    }
  }

  return {
    processed: results.length,
    sent: results.filter(r => r.status === 'sent').length,
    results,
  }
}

async function runCleanupRateLimits(db) {
  const now = admin.firestore.Timestamp.now()

  let deletedTotal = 0
  let keepGoing = true

  while (keepGoing) {
    const snap = await db
      .collection('rateLimits')
      .where('expiresAt', '<=', now)
      .limit(RATE_LIMIT_CLEANUP_BATCH_SIZE)
      .get()

    if (snap.empty) {
      keepGoing = false
      break
    }

    const batch = db.batch()
    snap.docs.forEach(doc => batch.delete(doc.ref))
    await batch.commit()

    deletedTotal += snap.size
    keepGoing = snap.size === RATE_LIMIT_CLEANUP_BATCH_SIZE
  }

  return { deleted: deletedTotal }
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end()
  }

  const job = req.query.job

  try {
    if (job === 'downgrade-expired') {
      const db = getFirestore()
      return res.status(200).json(await runDowngradeExpired(db))
    }

    if (job === 'purge-deleted-accounts') {
      const app = getFirebaseAdmin()
      const db = getFirestore()
      return res.status(200).json(await runPurgeDeletedAccounts(app, db))
    }

    if (job === 'daily-digest') {
      const db = getFirestore()
      return res.status(200).json(await runDailyDigest(db))
    }

    if (job === 'cleanup-rate-limits') {
      const db = getFirestore()
      return res.status(200).json(await runCleanupRateLimits(db))
    }

    if (job === 'broadcast') {
      const { title, body } = req.body || {}
      if (!title || !body) {
        return res.status(400).json({ error: 'Missing title or body' })
      }
      return res.status(200).json(await sendBroadcast({ title, body }))
    }

    return res.status(400).json({ error: 'Unknown or missing job' })
  } catch (err) {
    console.error(`Cron job "${job}" failed:`, err)
    return res.status(500).json({ error: err.message })
  }
}

export const config = {
  maxDuration: 300,
}
