import formidable from 'formidable'
import fs from 'fs'
import FormData from 'form-data'
import fetch from 'node-fetch'

export const config = {
  api: { bodyParser: false },
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
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
      const formData = new FormData()
      formData.append('image_file', fs.createReadStream(file.filepath), {
        filename: file.originalFilename || 'signature.jpg',
        contentType: file.mimetype || 'image/jpeg',
      })
      formData.append('size', 'auto')

      const response = await fetch('https://api.remove.bg/v1.0/removebg', {
        method: 'POST',
        headers: {
          'X-Api-Key': process.env.REMOVE_BG_API_KEY,
          ...formData.getHeaders(),
        },
        body: formData,
      })

      if (!response.ok) {
        const errorText = await response.text()
        return res.status(response.status).json({ error: errorText })
      }

      const buffer = await response.buffer()
      const base64 = buffer.toString('base64')

      return res.status(200).json({ image: `data:image/png;base64,${base64}` })
    } catch (error) {
      return res.status(500).json({ error: 'Internal server error' })
    }
  })
}