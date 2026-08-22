import crypto from 'crypto'

const CLOUDINARY_CLOUD_NAME = 'dzqrelgbd'

export function extractPublicIdFromUrl(url) {
  if (typeof url !== 'string') return null
  const match = url.match(/\/upload\/(?:[^/]+\/)*?(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+(?:\?.*)?$/)
  return match ? match[1] : null
}

export async function destroyCloudinaryImage(publicId) {
  if (!publicId) return { result: 'skipped' }

  const timestamp = Math.floor(Date.now() / 1000)
  const signatureString = `public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`
  const signature = crypto.createHash('sha1').update(signatureString).digest('hex')

  const formData = new URLSearchParams()
  formData.append('public_id', publicId)
  formData.append('timestamp', timestamp)
  formData.append('api_key', process.env.CLOUDINARY_API_KEY)
  formData.append('signature', signature)

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/destroy`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData,
    }
  )

  return response.json()
}
