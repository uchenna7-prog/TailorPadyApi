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

function isValidSignature(rawBody, signature) {
  if (!signature) return false
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex')
  const expectedBuffer = Buffer.from(expected, 'hex')
  const signatureBuffer = Buffer.from(signature, 'hex')
  if (expectedBuffer.length !== signatureBuffer.length) return false
  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
}

async function findUidByCustomerCode(db, customerCode) {
  if (!customerCode) return null
  const snap = await db.doc(`paystackCustomers/${customerCode}`).get()
  return snap.exists ? snap.data().uid : null
}

async function resolveUid(db, event) {
  const metadataUid = event.data?.metadata?.uid
  if (metadataUid) return metadataUid
  const customerCode = event.data?.customer?.customer_code
  return findUidByCustomerCode(db, customerCode)
}

async function linkCustomerToUid(db, customerCode, uid) {
  if (!customerCode || !uid) return
  await db.doc(`paystackCustomers/${customerCode}`).set({ uid }, { merge: true })
}

async function handleChargeSuccess(db, ref, event, uid) {
  const interval = event.data.plan?.interval
  if (!interval) return
  const isAnnual = interval === 'annually'
  const paidAt = new Date().toISOString()
  const nextRenewal = new Date(Date.now() + (isAnnual ? 365 : 30) * 24 * 60 * 60 * 1000).toISOString()
  const planLabel = isAnnual ? 'Pro Annual' : 'Pro Monthly'
  const billingCycle = isAnnual ? 'annual' : 'monthly'
  const reference = event.data.reference
  const customerCode = event.data.customer?.customer_code

  await ref.set({
    isPremium: true,
    plan: planLabel,
    billingCycle,
    paymentFailed: false,
    nextRenewal,
    updatedAt: paidAt,
  }, { merge: true })

  await linkCustomerToUid(db, customerCode, uid)

  if (reference) {
    await db.doc(`users/${uid}/subscriptionPayments/${reference}`).set({
      reference,
      amount: event.data.amount,
      plan: planLabel,
      billingCycle,
      status: 'paid',
      paidAt,
    })
  }
}

async function handleSubscriptionCreate(ref, event) {
  await ref.set({
    subscriptionCode: event.data.subscription_code ?? null,
    emailToken: event.data.email_token ?? null,
    updatedAt: new Date().toISOString(),
  }, { merge: true })
}

async function handleSubscriptionDisable(ref) {
  await ref.set({
    isPremium: false,
    updatedAt: new Date().toISOString(),
  }, { merge: true })
}

async function handlePaymentFailed(db, ref, event, uid) {
  const failedAt = new Date().toISOString()
  const reference = event.data.invoice_code ?? event.data.reference ?? `failed-${Date.now()}`

  await ref.set({
    paymentFailed: true,
    updatedAt: failedAt,
  }, { merge: true })

  await db.doc(`users/${uid}/subscriptionPayments/${reference}`).set({
    reference,
    amount: event.data.amount ?? null,
    plan: null,
    billingCycle: null,
    status: 'failed',
    paidAt: failedAt,
  })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end()
  }

  const rawBody = await getRawBody(req)
  const signature = req.headers['x-paystack-signature']

  if (!isValidSignature(rawBody, signature)) {
    return res.status(401).end()
  }

  const event = JSON.parse(rawBody.toString())
  const db = getFirestore()
  const uid = await resolveUid(db, event)

  if (!uid) {
    return res.status(200).end()
  }

  const ref = db.doc(`users/${uid}/settings/premium`)

  if (event.event === 'charge.success') {
    await handleChargeSuccess(db, ref, event, uid)
  }

  if (event.event === 'subscription.create') {
    await handleSubscriptionCreate(ref, event)
  }

  if (event.event === 'subscription.disable' || event.event === 'subscription.not_renew') {
    await handleSubscriptionDisable(ref)
  }

  if (event.event === 'invoice.payment_failed') {
    await handlePaymentFailed(db, ref, event, uid)
  }

  return res.status(200).end()
}
