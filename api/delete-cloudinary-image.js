import crypto from 'crypto'

const ALLOWED_ORIGINS = [
  'https://tailorpady.web.app',
  'http://localhost:5173',
]

const CLOUDINARY_CLOUD_NAME = 'dzqrelgbd'

export default async function handler(req, res) {
  const origin = req.headers.origin
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { publicId } = req.body

  if (!publicId) {
    return res.status(400).json({ error: 'No publicId provided' })
  }

  try {
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

    const data = await response.json()

    if (data.result !== 'ok' && data.result !== 'not found') {
      return res.status(400).json({ error: 'Failed to delete image', details: data })
    }

    return res.status(200).json({ result: data.result })
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' })
  }
}
