import webpush from 'web-push'
import { getFirestore } from './firebaseAdmin.js'

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
)

export async function sendPushToUser(uid, payload) {
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

    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        body
      )
      sent += 1
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await docSnap.ref.delete()
        removed += 1
      } else {
        console.error(`Push failed for ${uid}/${docSnap.id}:`, err.message)
      }
    }
  }))

  return { sent, removed }
}
