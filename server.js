const express = require('express');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const { execSync } = require('child_process');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const YTDlpWrap = require('yt-dlp-wrap').default;

// Detect ffmpeg path: prefer system binary, fall back to ffmpeg-static
let ffmpegPath;
try {
  ffmpegPath = execSync('which ffmpeg').toString().trim();
  console.log('System ffmpeg found at:', ffmpegPath);
} catch(e) {
  console.warn('System ffmpeg not found, falling back to ffmpeg-static');
  ffmpegPath = require('ffmpeg-static');
  console.log('ffmpeg-static path:', ffmpegPath);
}
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const YTDLP_PATH = path.join(os.tmpdir(), 'yt-dlp');
let ytDlp;

const FPS = 8;
const BANNER_W = 744;
const BANNER_H = 400;
const PANEL_W = 248;
const PANEL_H = 400;
const BATCH_SIZE = 5;

// Cloudinary config
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'root';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '534429829986323';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'Ers1ctVM1qLhXFbB9sxeza1WQmw';

async function uploadToCloudinary(filePath) {
  console.log('Uploading to Cloudinary...');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHash('sha1')
    .update(`timestamp=${timestamp}${CLOUDINARY_API_SECRET}`)
    .digest('hex');

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('timestamp', timestamp.toString());
  form.append('signature', signature);
  form.append('resource_type', 'image');

  const response = await axios.post(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    form,
    { headers: form.getHeaders() }
  );

  console.log('Cloudinary upload complete:', response.data.secure_url);
  return response.data.secure_url;
}

function unwrap(val) {
  if (Array.isArray(val)) return val[0];
  return val;
}

function uid() {
  return crypto.randomBytes(8).toString('hex');
}

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
  const tmpFile = path.join(os.tmpdir(), `clip_${uid()}.mp4`);
  console.log('Starting download:', url);
  await ytDlp.execPromise([
    url,
    '-f', 'best',
    '--no-playlist',
    '--socket-timeout', '30',
    '--retries', '2',
    '-o', tmpFile
  ]);
  if (!fs.existsSync(tmpFile)) throw new Error('Downloaded file not found after yt-dlp');
  console.log('Download complete, size:', fs.statSync(tmpFile).size, 'bytes');
  return tmpFile;
}

function getVideoDuration(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return resolve(30);
      resolve(metadata.format.duration || 30);
    });
  });
}

function extractFramesToDisk(filePath, startTime, duration, fps) {
  return new Promise(async (resolve, reject) => {
    const videoDuration = await getVideoDuration(filePath);
    const safeStart = Math.min(parseFloat(startTime || 0), videoDuration - 0.5);
    const safeDuration = Math.min(parseFloat(duration || 5), videoDuration - safeStart);
    const framesDir = path.join(os.tmpdir(), `frames_${uid()}`);
    fs.mkdirSync(framesDir, { recursive: true });
    console.log(`Extracting frames: start=${safeStart}s duration=${safeDuration}s fps=${fps}`);

    ffmpeg(filePath)
      .seekInput(safeStart)
      .duration(safeDuration)
      .fps(fps)
      .output(path.join(framesDir, 'frame_%04d.png'))
      .on('end', () => {
        const files = fs.readdirSync(framesDir)
          .filter(f => f.endsWith('.png'))
          .sort()
          .map(f => path.join(framesDir, f));
        console.log(`Extracted ${files.length} frames`);
        resolve({ files, dir: framesDir });
      })
      .on('error', (err) => {
        console.error('ffmpeg frames error:', err.message);
        try { fs.rmSync(framesDir, { recursive: true }); } catch(e) {}
        reject(err);
      })
      .run();
  });
}

function extractGifFromFile(filePath, startTime, duration) {
  return new Promise(async (resolve, reject) => {
    const videoDuration = await getVideoDuration(filePath);
    const safeStart = Math.min(parseFloat(startTime || 0), videoDuration - 1);
    const safeDuration = Math.min(parseFloat(duration || 5), videoDuration - safeStart);
    console.log(`Extracting GIF: start=${safeStart}s duration=${safeDuration}s`);

    const tmpGif = path.join(os.tmpdir(), `preview_${uid()}.gif`);
    ffmpeg(filePath)
      .seekInput(safeStart)
      .duration(safeDuration)
      .output(tmpGif)
      .outputOptions([
        '-vf', 'fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse'
      ])
      .on('end', () => {
        if (!fs.existsSync(tmpGif)) {
          try { fs.unlinkSync(filePath); } catch(e) {}
          return reject(new Error('ffmpeg did not produce output GIF'));
        }
        const buf = fs.readFileSync(tmpGif);
        fs.unlinkSync(tmpGif);
        try { fs.unlinkSync(filePath); } catch(e) {}
        console.log('GIF size:', buf.length, 'bytes');
        resolve(buf);
      })
      .on('error', (err) => {
        console.error('ffmpeg error:', err.message);
        try { fs.unlinkSync(filePath); } catch(e) {}
        reject(err);
      })
      .run();
  });
}

async function buildAnimatedBanner(frameSets) {
  const minFrames = Math.min(...frameSets.map(s => s.files.length));
  console.log(`Building banner: ${minFrames} frames at ${FPS}fps`);

  const bannerDir = path.join(os.tmpdir(), `banner_${uid()}`);
  fs.mkdirSync(bannerDir, { recursive: true });

  for (let i = 0; i < minFrames; i += BATCH_SIZE) {
    const batchEnd = Math.min(i + BATCH_SIZE, minFrames);
    for (let j = i; j < batchEnd; j++) {
      const panels = await Promise.all(
        frameSets.map(set =>
          sharp(set.files[j])
            .resize(PANEL_W, PANEL_H, { fit: 'cover', position: 'centre' })
            .png()
            .toBuffer()
        )
      );
      const composite = await sharp({
        create: { width: BANNER_W, height: BANNER_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } }
      })
        .composite([
          { input: panels[0], left: 0, top: 0 },
          { input: panels[1], left: PANEL_W, top: 0 },
          { input: panels[2], left: PANEL_W * 2, top: 0 }
        ])
        .png()
        .toBuffer();
      fs.writeFileSync(path.join(bannerDir, `frame_${String(j).padStart(4, '0')}.png`), composite);
    }
    console.log(`Composited frames ${i} to ${batchEnd - 1}`);
  }

  frameSets.forEach(set => {
    try { fs.rmSync(set.dir, { recursive: true }); } catch(e) {}
  });

  console.log('Generating final GIF...');
  const outputGif = path.join(os.tmpdir(), `banner_${uid()}.gif`);
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(bannerDir, 'frame_%04d.png'))
      .inputOptions([`-framerate ${FPS}`])
      .output(outputGif)
      .outputOptions([
        '-vf', `fps=${FPS},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
        '-loop', '0'
      ])
      .on('end', resolve)
      .on('error', (err) => {
        console.error('Banner GIF error:', err.message);
        reject(err);
      })
      .run();
  });

  try { fs.rmSync(bannerDir, { recursive: true }); } catch(e) {}
  return outputGif;
}

app.post('/preview-clip', async (req, res) => {
  try {
    console.log('Preview body:', JSON.stringify(req.body));
    const url = unwrap(req.body.url);
    const start = unwrap(req.body.start);
    const duration = unwrap(req.body.duration);
    if (!url) return res.status(400).json({ error: 'URL is required' });
    const clipFile = await downloadClip(url);
    const gifBuf = await extractGifFromFile(clipFile, start, duration);
    res.json({ previewUrl: `data:image/gif;base64,${gifBuf.toString('base64')}` });
  } catch (err) {
    console.error('Preview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate-banner', async (req, res) => {
  try {
    console.log('Generate banner body:', JSON.stringify(req.body));
    const { clips } = req.body;
    if (!clips || clips.length !== 3) return res.status(400).json({ error: 'Exactly 3 clips required' });

    const normalizedClips = clips.map((clip, i) => {
      const url = unwrap(clip.url);
      if (!url) throw new Error(`Clip ${i + 1} has no URL`);
      return { url, start: unwrap(clip.start), duration: unwrap(clip.duration) };
    });

    console.log('Processing clips sequentially...');
    const frameSets = [];

    for (const [i, clip] of normalizedClips.entries()) {
      console.log(`Clip ${i + 1}: downloading...`);
      const clipFile = await downloadClip(clip.url);
      console.log(`Clip ${i + 1}: extracting frames...`);
      const frameSet = await extractFramesToDisk(clipFile, clip.start, clip.duration, FPS);
      try { fs.unlinkSync(clipFile); } catch(e) {}
      frameSets.push(frameSet);
      console.log(`Clip ${i + 1}: done`);
    }

    const gifPath = await buildAnimatedBanner(frameSets);

    // Upload to Cloudinary and return public URL
    const publicUrl = await uploadToCloudinary(gifPath);
    try { fs.unlinkSync(gifPath); } catch(e) {}

    console.log('Sending banner URL:', publicUrl);
    res.json({ bannerUrl: publicUrl });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

initYtDlp().then(() => {
  app.listen(PORT, () => console.log(`gif-banner-api running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init yt-dlp:', err);
  process.exit(1);
});
