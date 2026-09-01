import webpush from 'web-push'
import { getFirestore } from './firebaseAdmin.js'

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
)

export async function sendPushToUser(uid, payload) {
  if (!uid || !payload?.title) {
    return { sent: 0, removed: 0 }
  }

  const db = getFirestore()
  const snap = await db.collection(`users/${uid}/pushSubscriptions`).get()

  if (snap.empty) {
    return { sent: 0, removed: 0 }
  }

  const body = JSON.stringify(payload)
  let sent = 0
  let removed = 0

  await Promise.all(snap.docs.map(async (docSnap) => {
    const sub = docSnap.data()

    if (!sub?.endpoint || !sub?.keys) {
      await docSnap.ref.delete().catch(() => {})
      removed += 1
      return
    }

    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        body,
        { urgency: 'high' }
      )
      sent += 1
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await docSnap.ref.delete().catch(() => {})
        removed += 1
      } else {
        console.error(`Push failed for ${uid}/${docSnap.id}:`, err.message)
      }
    }
  }))

  return { sent, removed }
}

export async function sendBroadcast(payload) {
  if (!payload?.title) {
    return { usersTargeted: 0, sent: 0, removed: 0 }
  }

  const db = getFirestore()
  const subsSnap = await db.collectionGroup('pushSubscriptions').get()

  if (subsSnap.empty) {
    return { usersTargeted: 0, sent: 0, removed: 0 }
  }

  const uids = new Set()
  subsSnap.docs.forEach(d => {
    const uid = d.ref.parent.parent?.id
    if (uid) uids.add(uid)
  })

  let totalSent = 0
  let totalRemoved = 0

  for (const uid of uids) {
    const result = await sendPushToUser(uid, payload)
    totalSent += result.sent
    totalRemoved += result.removed
  }

  return { usersTargeted: uids.size, sent: totalSent, removed: totalRemoved }
}
