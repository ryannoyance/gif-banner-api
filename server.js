const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'gif-banner-api' }));

// Helper: run yt-dlp to get direct video URL
const YTDlpWrap = require('yt-dlp-wrap').default;

async function getDirectVideoUrl(url) {
  const ytDlp = new YTDlpWrap();
  await YTDlpWrap.downloadFromGithub();
  const info = await ytDlp.execPromise([
    url,
    '-f', 'best[height<=720]',
    '--get-url',
    '--no-playlist'
  ]);
  return info.trim().split('\n')[0];
}

// Helper: extract a single frame as PNG buffer at a given time
function extractFrame(videoUrl, startTime) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `frame_${Date.now()}.png`);
    ffmpeg(videoUrl)
      .seekInput(startTime)
      .frames(1)
      .output(tmpFile)
      .on('end', () => {
        const buf = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        resolve(buf);
      })
      .on('error', reject)
      .run();
  });
}

// POST /generate-banner
// Body: { clips: [ { url, start, duration }, { url, start, duration }, { url, start, duration } ] }
// Returns: { bannerUrl: "data:image/png;base64,..." }
app.post('/generate-banner', async (req, res) => {
  try {
    const { clips } = req.body;
    if (!clips || clips.length !== 3) {
      return res.status(400).json({ error: 'Exactly 3 clips required' });
    }

    const frameBuffers = [];

    for (const clip of clips) {
      const directUrl = await getDirectVideoUrl(clip.url);
      const midTime = parseFloat(clip.start || 0) + parseFloat(clip.duration || 5) / 2;
      const frameBuf = await extractFrame(directUrl, midTime);
      frameBuffers.push(frameBuf);
    }

    // Get metadata of first frame to determine target dimensions
    const meta = await sharp(frameBuffers[0]).metadata();
    const targetW = meta.width;
    const targetH = meta.height;

    // Resize all to same dimensions
    const resized = await Promise.all(
      frameBuffers.map(buf =>
        sharp(buf).resize(targetW, targetH, { fit: 'cover' }).png().toBuffer()
      )
    );

    // Stitch horizontally: 3 x 1 grid
    const banner = await sharp({
      create: {
        width: targetW * 3,
        height: targetH,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    })
      .composite([
        { input: resized[0], left: 0, top: 0 },
        { input: resized[1], left: targetW, top: 0 },
        { input: resized[2], left: targetW * 2, top: 0 }
      ])
      .png()
      .toBuffer();

    const base64 = banner.toString('base64');
    res.json({ bannerUrl: `data:image/png;base64,${base64}` });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /preview-clip
// Body: { url, start, duration }
// Returns: { previewUrl: "data:image/png;base64,..." }
app.post('/preview-clip', async (req, res) => {
  try {
    const { url, start, duration } = req.body;
    const directUrl = await getDirectVideoUrl(url);
    const midTime = parseFloat(start || 0) + parseFloat(duration || 5) / 2;
    const frameBuf = await extractFrame(directUrl, midTime);
    const base64 = frameBuf.toString('base64');
    res.json({ previewUrl: `data:image/png;base64,${base64}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`gif-banner-api running on port ${PORT}`));
