import { getFirestore } from '../../lib/firebaseAdmin.js'
import { sendPushToUser } from '../../lib/webpush.js'

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

export default async function handler(req, res) {
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end()
  }

  const db = getFirestore()
  const subsSnap = await db.collectionGroup('pushSubscriptions').get()

  if (subsSnap.empty) {
    return res.status(200).json({ processed: 0 })
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

  return res.status(200).json({
    processed: results.length,
    sent: results.filter(r => r.status === 'sent').length,
    results,
  })
}

export const config = {
  maxDuration: 300,
}
