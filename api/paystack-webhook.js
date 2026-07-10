import crypto from 'crypto'
import { getFirestore } from './lib/firebaseAdmin.js'

export const config = {
  api: { bodyParser: false },
}

async function getRawBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function findUidByCustomerCode(db, customerCode) {
  const snap = await db.doc(`paystackCustomers/${customerCode}`).get()
  return snap.exists ? snap.data().uid : null
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end()
  }

  const rawBody = await getRawBody(req)
  const signature = req.headers['x-paystack-signature']
  const expectedSignature = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex')

  if (signature !== expectedSignature) {
    return res.status(401).end()
  }

  const event = JSON.parse(rawBody.toString())
  const customerCode = event.data?.customer?.customer_code

  if (!customerCode) {
    return res.status(200).end()
  }

  const db = getFirestore()
  const uid = await findUidByCustomerCode(db, customerCode)

  if (!uid) {
    return res.status(200).end()
  }

  const ref = db.doc(`users/${uid}/settings/premium`)

  if (event.event === 'charge.success' && event.data.plan?.interval) {
    const isAnnual = event.data.plan.interval === 'annually'
    const nextRenewal = new Date(Date.now() + (isAnnual ? 365 : 30) * 24 * 60 * 60 * 1000)
    await ref.set({
      isPremium: true,
      plan: isAnnual ? 'Pro Annual' : 'Pro Monthly',
      billingCycle: isAnnual ? 'annual' : 'monthly',
      subscriptionCode: event.data.subscription?.subscription_code ?? null,
      paymentFailed: false,
      nextRenewal: nextRenewal.toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true })
  }

  if (event.event === 'subscription.disable' || event.event === 'subscription.not_renew') {
    await ref.set({
      isPremium: false,
      updatedAt: new Date().toISOString(),
    }, { merge: true })
  }

  if (event.event === 'invoice.payment_failed') {
    await ref.set({
      paymentFailed: true,
      updatedAt: new Date().toISOString(),
    }, { merge: true })
  }

  return res.status(200).end()
}
