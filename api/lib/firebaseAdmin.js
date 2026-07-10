import admin from 'firebase-admin'

let app

export function getFirebaseAdmin() {
  if (!app) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
  }
  return app
}

export function getFirestore() {
  return getFirebaseAdmin().firestore()
}
