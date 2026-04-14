const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const YTDlpWrap = require('yt-dlp-wrap').default;
process.env.PATH = `/nix/var/nix/profiles/default/bin:${process.env.PATH}`;

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const YTDLP_PATH = path.join(os.tmpdir(), 'yt-dlp');
let ytDlp;

async function initYtDlp() {
  console.log('Downloading yt-dlp binary...');
  await YTDlpWrap.downloadFromGithub(YTDLP_PATH);
  ytDlp = new YTDlpWrap(YTDLP_PATH);
  console.log('yt-dlp ready');
  exec('/tmp/yt-dlp --version', (e, out) => console.log('yt-dlp version:', out, e?.message));
}

app.get('/', (req, res) => res.json({ status: 'ok', service: 'gif-banner-api' }));

async function getDirectVideoUrl(url) {
  const output = await ytDlp.execPromise([url, '-f', 'best[height<=720]', '--get-url', '--no-playlist']);
  return output.trim().split('\n')[0];
}

function extractFrame(videoUrl, startTime) {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `frame_${Date.now()}.png`);
    ffmpeg(videoUrl)
      .seekInput(startTime)
      .frames(1)
      .output(tmpFile)
      .on('end', () => { const buf = fs.readFileSync(tmpFile); fs.unlinkSync(tmpFile); resolve(buf); })
      .on('error', reject)
      .run();
  });
}

app.post('/preview-clip', async (req, res) => {
  try {
    const { url, start, duration } = req.body;
    const directUrl = await getDirectVideoUrl(url);
    const midTime = parseFloat(start || 0) + parseFloat(duration || 5) / 2;
    const frameBuf = await extractFrame(directUrl, midTime);
    res.json({ previewUrl: `data:image/png;base64,${frameBuf.toString('base64')}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate-banner', async (req, res) => {
  try {
    const { clips } = req.body;
    if (!clips || clips.length !== 3) return res.status(400).json({ error: 'Exactly 3 clips required' });
    const frameBuffers = [];
    for (const clip of clips) {
      const directUrl = await getDirectVideoUrl(clip.url);
      const midTime = parseFloat(clip.start || 0) + parseFloat(clip.duration || 5) / 2;
      frameBuffers.push(await extractFrame(directUrl, midTime));
    }
    const meta = await sharp(frameBuffers[0]).metadata();
    const targetW = meta.width, targetH = meta.height;
    const resized = await Promise.all(frameBuffers.map(buf => sharp(buf).resize(targetW, targetH, { fit: 'cover' }).png().toBuffer()));
    const banner = await sharp({ create: { width: targetW * 3, height: targetH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
      .composite([{ input: resized[0], left: 0, top: 0 }, { input: resized[1], left: targetW, top: 0 }, { input: resized[2], left: targetW * 2, top: 0 }])
      .png().toBuffer();
    res.json({ bannerUrl: `data:image/png;base64,${banner.toString('base64')}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

initYtDlp().then(() => {
  app.listen(PORT, () => console.log(`gif-banner-api running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init yt-dlp:', err);
  process.exit(1);
});
