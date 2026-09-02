export async function sendPushToUser(app, db, uid, payload) {
  if (!uid || !payload?.title) {
    return { sent: 0, removed: 0 }
  }
  const snap = await db.collection(`users/${uid}/pushSubscriptions`).get()
  if (snap.empty) {
    return { sent: 0, removed: 0 }
  }
  let sent = 0
  let removed = 0
  await Promise.all(snap.docs.map(async (docSnap) => {
    const sub = docSnap.data()
    if (!sub?.token) {
      await docSnap.ref.delete().catch(() => {})
      removed += 1
      return
    }
    try {
      await app.messaging().send({
        token: sub.token,
        notification: {
          title: payload.title,
          body: payload.body,
        },
      })
      sent += 1
    } catch (err) {
      if (err.code === 'messaging/registration-token-not-registered' || err.code === 'messaging/invalid-registration-token') {
        await docSnap.ref.delete().catch(() => {})
        removed += 1
      } else {
        console.error(`Push failed for ${uid}/${docSnap.id}:`, err.message)
      }
    }
  }))
  return { sent, removed }
}

export async function sendBroadcast(app, db, payload) {
  if (!payload?.title) {
    return { usersTargeted: 0, sent: 0, removed: 0 }
  }
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
    const result = await sendPushToUser(app, db, uid, payload)
    totalSent += result.sent
    totalRemoved += result.removed
  }
  return { usersTargeted: uids.size, sent: totalSent, removed: totalRemoved }
}
