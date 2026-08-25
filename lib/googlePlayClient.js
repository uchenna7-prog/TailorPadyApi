import { google } from 'googleapis'

const PACKAGE_NAME = 'com.tailorpady.app'

function getAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  })
}

export async function getAndroidPublisher() {
  const auth = getAuth()
  return google.androidpublisher({ version: 'v3', auth })
}

export async function getSubscriptionPurchase(purchaseToken) {
  const publisher = await getAndroidPublisher()
  const response = await publisher.purchases.subscriptionsv2.get({
    packageName: PACKAGE_NAME,
    token: purchaseToken,
  })
  return response.data
}

export async function acknowledgeSubscriptionPurchase(purchaseToken, productId) {
  const publisher = await getAndroidPublisher()
  await publisher.purchases.subscriptions.acknowledge({
    packageName: PACKAGE_NAME,
    subscriptionId: productId,
    token: purchaseToken,
    requestBody: {},
  })
}

export { PACKAGE_NAME }
