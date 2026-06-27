import formidable from 'formidable'
import fs from 'fs'
import FormData from 'form-data'

export const config = {
  api: { bodyParser: false },
}

const ALLOWED_ORIGINS = [
  'https://tailorpady.web.app',
  'http://localhost:5173',
]

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

  const form = formidable({ maxFileSize: 10 * 1024 * 1024 })

  form.parse(req, async (err, _fields, files) => {
    if (err) {
      return res.status(400).json({ error: 'Failed to parse file' })
    }

    const file = Array.isArray(files.image) ? files.image[0] : files.image
    if (!file) {
      return res.status(400).json({ error: 'No image provided' })
    }

    try {
      const fileBuffer = fs.readFileSync(file.filepath)

      const formData = new FormData()
      formData.append('image_file', fileBuffer, {
        filename: file.originalFilename || 'signature.jpg',
        contentType: file.mimetype || 'image/jpeg',
      })
      formData.append('size', 'auto')

      const multipartBody = formData.getBuffer()
      const headers = formData.getHeaders()

      const response = await fetch('https://api.remove.bg/v1.0/removebg', {
        method: 'POST',
        headers: {
          'X-Api-Key': process.env.REMOVE_BG_API_KEY,
          ...headers,
        },
        body: multipartBody,
      })

      if (!response.ok) {
        const errorText = await response.text()
        return res.status(response.status).json({ error: errorText })
      }

      const arrayBuffer = await response.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      const base64 = buffer.toString('base64')

      return res.status(200).json({ image: `data:image/png;base64,${base64}` })
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' })
    }
  })
}