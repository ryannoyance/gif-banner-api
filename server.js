const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const YTDlpWrap = require('yt-dlp-wrap').default;

// Use system ffmpeg installed via nixpacks
ffmpeg.setFfmpegPath('ffmpeg');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const YTDLP_PATH = path.join(os.tmpdir(), 'yt-dlp');
let ytDlp;

async function initYtDlp() {
  console.log('Downloading yt-dlp standalone binary...');
  const response = await axios.get(
    'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
    { responseType: 'arraybuffer', maxRedirects: 10 }
  );
  fs.writeFileSync(YTDLP_PATH, response.data);
  fs.chmodSync(YTDLP_PATH, '755');
  const size = fs.statSync(YTDLP_PATH).size;
  console.log(`yt-dlp downloaded, size: ${size} bytes`);
  ytDlp = new YTDlpWrap(YTDLP_PATH);
  console.log('yt-dlp ready');
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'gif-banner-api' }));

async function downloadClip(url) {
  const tmpFile = path.join(os.tmpdir(), `clip_${Date.now()}.mp4`);
  await ytDlp.execPromise([
    url,
    '-f', 'best',
    '--no-playlist',
    '-o', tmpFile
  ]);
  return tmpFile;
}

function extractFrameFromFile(filePath, startTime) {
  return new Promise((resolve, reject) => {
    const tmpPng = path.join(os.tmpdir(), `frame_${Date.now()}.png`);
    ffmpeg(filePath)
      .seekInput(startTime)
      .frames(1)
      .output(tmpPng)
      .on('end', () => {
        if (!fs.existsSync(tmpPng)) {
          try { fs.unlinkSync(filePath); } catch(e) {}
          return reject(new Error('ffmpeg did not produce output frame — check ffmpeg is installed'));
        }
        const buf = fs.readFileSync(tmpPng);
        fs.unlinkSync(tmpPng);
        try { fs.unlinkSync(filePath); } catch(e) {}
        resolve(buf);
      })
      .on('error', (err) => {
        try { fs.unlinkSync(filePath); } catch(e) {}
        reject(err);
      })
      .run();
  });
}

app.post('/preview-clip', async (req, res) => {
  try {
    console.log('Body received:', JSON.stringify(req.body));
    const { url, start, duration } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const midTime = parseFloat(start || 0) + parseFloat(duration || 5) / 2;
    const clipFile = await downloadClip(url);
    const frameBuf = await extractFrameFromFile(clipFile, midTime);
    res.json({ previewUrl: `data:image/png;base64,${frameBuf.toString('base64')}` });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate-banner', async (req, res) => {
  try {
    console.log('Generate banner body:', JSON.stringify(req.body));
    const { clips } = req.body;
    if (!clips || clips.length !== 3) return res.status(400).json({ error: 'Exactly 3 clips required' });
    const frameBuffers = [];
    for (const clip of clips) {
      if (!clip.url) return res.status(400).json({ error: 'Each clip must have a URL' });
      const midTime = parseFloat(clip.start || 0) + parseFloat(clip.duration || 5) / 2;
      const clipFile = await downloadClip(clip.url);
      const frameBuf = await extractFrameFromFile(clipFile, midTime);
      frameBuffers.push(frameBuf);
    }
    const meta = await sharp(frameBuffers[0]).metadata();
    const targetW = meta.width, targetH = meta.height;
    const resized = await Promise.all(
      frameBuffers.map(buf => sharp(buf).resize(targetW, targetH, { fit: 'cover' }).png().toBuffer())
    );
    const banner = await sharp({
      create: { width: targetW * 3, height: targetH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
    })
      .composite([
        { input: resized[0], left: 0, top: 0 },
        { input: resized[1], left: targetW, top: 0 },
        { input: resized[2], left: targetW * 2, top: 0 }
      ])
      .png().toBuffer();
    res.json({ bannerUrl: `data:image/png;base64,${banner.toString('base64')}` });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

initYtDlp().then(() => {
  app.listen(PORT, () => console.log(`gif-banner-api running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init yt-dlp:', err);
  process.exit(1);
});
